import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { access, stat, opendir } from 'node:fs/promises';
import { DIRECTORY_ENTRY_LIMIT } from './user-package.js';
import { result, statusFromError } from '../result.js';

const ownPackageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function createHostArtifactProbes({ platform = process.platform, homeDirectory = os.homedir,
  packageRoot = ownPackageRoot, accessFile = access, statFile = stat, openDirectory = opendir,
  entryLimit = DIRECTORY_ENTRY_LIMIT,
} = {}) {
  if (!Number.isInteger(entryLimit) || entryLimit < 1 || entryLimit > DIRECTORY_ENTRY_LIMIT) throw new TypeError('Invalid directory entry limit');
  const api = platform === 'win32' ? path.win32 : path.posix;
  const key = Symbol('host-artifact-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  function validate(raw) {
    if (typeof raw !== 'string' || !api.isAbsolute(raw) || raw.includes('\0')) throw new Error('Invalid artifact directory');
    if (raw.length > 65536) throw Object.assign(new Error('Path exceeds limit'), { code: 'EPROBETRUNCATED' });
    return raw;
  }
  const home = (ctx) => cached(ctx, 'home', () => validate(homeDirectory()));
  const locations = (ctx) => cached(ctx, 'locations', async () => {
    if (!['linux', 'darwin', 'win32'].includes(platform)) throw Object.assign(new Error('Unsupported artifact locations'), { code: 'ENOTSUP' });
    const root = await home(ctx);
    // Append fixed components without normalizing away symlink/.. semantics.
    const child = (...parts) => validate([root, ...parts].join(api.sep));
    const appConfig = (name) => platform === 'win32' ? child('AppData', 'Roaming', name)
      : platform === 'darwin' ? child('Library', 'Application Support', name) : child('.config', name);
    return {
      vscode: [appConfig('Code'), appConfig('Code - Insiders')],
      jetbrains: [appConfig('JetBrains')],
      cursor: [appConfig('Cursor'), child('.cursor')],
      claude: [child('.claude')],
      copilot: [child('.copilot'), platform === 'win32'
        ? child('AppData', 'Local', 'github-copilot') : child('.config', 'github-copilot')],
      gemini: [child('.gemini')],
      huggingface: [child('.cache', 'huggingface', 'hub'), child('.cache', 'huggingface', 'transformers')],
      ollama: [child('.ollama', 'models')],
      jupyter: [child('.jupyter')],
      conda: ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge',
        'Miniconda3', 'Anaconda3', 'Miniforge3', 'Mambaforge'].map((name) => child(name)),
      ssh: [child('.ssh')],
      aws: [child('.aws')],
      azure: [child('.azure')],
      gcloud: [platform === 'win32' ? child('AppData', 'Roaming', 'gcloud') : child('.config', 'gcloud')],
      git: [child('.gitconfig'), child('.config', 'git', 'config')],
      config: platform === 'win32' ? child('AppData', 'Roaming')
        : platform === 'darwin' ? child('Library', 'Application Support') : child('.config'),
      cache: platform === 'win32' ? child('AppData', 'Local')
        : platform === 'darwin' ? child('Library', 'Caches') : child('.cache'),
      history: platform === 'win32'
        ? [child('AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
          child('AppData', 'Roaming', 'Microsoft', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')]
        : [child('.bash_history'), child('.zsh_history'), child('.sh_history'), child('.history'),
          child('.local', 'share', 'fish', 'fish_history')],
    };
  });
  const inspect = (file, ctx) => cached(ctx, `stat:${file}`, async () => {
    ctx.signal?.throwIfAborted();
    try {
      const info = await statFile(file);
      ctx.signal?.throwIfAborted();
      return info;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  });
  const scan = (directory, ctx) => cached(ctx, `scan:${directory}`, async () => {
    ctx.signal?.throwIfAborted();
    const handle = await openDirectory(directory, { bufferSize: 1 });
    try {
      let files = 0;
      let directories = 0;
      for (let entries = 0; entries < entryLimit; entries++) {
        ctx.signal?.throwIfAborted();
        const entry = await handle.read();
        ctx.signal?.throwIfAborted();
        if (!entry) return { files: result(files), directories: result(directories), entries: result(entries) };
        // Classify direct entries only: no symlink traversal or recursive reads.
        if (entry.isFile()) files++;
        if (entry.isDirectory()) directories++;
      }
      return Object.fromEntries(['files', 'directories', 'entries'].map((field) => [field, result(null, 'truncated')]));
    } finally {
      await handle.close();
    }
  });
  const homeCount = (field) => async (ctx) => (await scan(await home(ctx), ctx))[field];
  const directoryCount = (kind) => async (ctx) => {
    const directory = (await locations(ctx))[kind];
    if (!(await inspect(directory, ctx))?.isDirectory()) return result(null, 'absent');
    return (await scan(directory, ctx)).entries;
  };
  const presence = (kind, method) => async (ctx) => {
    let failure;
    for (const file of (await locations(ctx))[kind]) {
      ctx.signal?.throwIfAborted();
      try { if ((await inspect(file, ctx))?.[method]()) return result(true); }
      catch (error) {
        ctx.signal?.throwIfAborted();
        failure ??= error;
      }
    }
    // A positive match is conclusive; incomplete negative checks retain failure.
    return failure ? result(null, statusFromError(failure)) : result(false);
  };
  return [
    { name: 'Own package-directory read access', run: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await accessFile(validate(packageRoot), constants.R_OK);
      ctx.signal?.throwIfAborted();
      return result(true);
    } },
    { name: 'Home-directory bounded top-level file count', run: homeCount('files') },
    { name: 'Home-directory bounded top-level subdirectory count', run: homeCount('directories') },
    { name: 'User configuration-directory presence', run: async (ctx) => result(Boolean(
      (await inspect((await locations(ctx)).config, ctx))?.isDirectory(),
    )) },
    { name: 'User configuration-directory bounded entry count', run: directoryCount('config') },
    { name: 'User cache-directory bounded entry count', run: directoryCount('cache') },
    { name: 'Shell-history file presence without reading contents', run: presence('history', 'isFile') },
    { name: 'User SSH directory presence without reading contents', run: presence('ssh', 'isDirectory') },
    { name: 'User AWS configuration-directory presence without reading contents', run: presence('aws', 'isDirectory') },
    { name: 'User Azure configuration-directory presence without reading contents', run: presence('azure', 'isDirectory') },
    { name: 'User Google Cloud configuration-directory presence without reading contents', run: presence('gcloud', 'isDirectory') },
    { name: 'User Git configuration-file presence without reading contents', run: presence('git', 'isFile') },
    ...[
      ['VS Code', 'vscode'], ['JetBrains', 'jetbrains'], ['Cursor', 'cursor'],
      ['Claude', 'claude'], ['GitHub Copilot', 'copilot'], ['Gemini', 'gemini'],
    ].map(([name, kind]) => ({ name: `${name} configuration-directory presence`, run: presence(kind, 'isDirectory') })),
    ...[
      ['Hugging Face model-cache directory presence', 'huggingface'],
      ['Ollama model-directory presence', 'ollama'],
      ['Jupyter configuration-directory presence', 'jupyter'],
      ['Conda installation-directory presence', 'conda'],
    ].map(([name, kind]) => ({ name, run: presence(kind, 'isDirectory') })),
  ];
}
