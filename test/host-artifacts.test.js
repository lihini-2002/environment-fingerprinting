import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEnvironment, createHostArtifactProbes } from '../src/index.js';

const names = ['Own package-directory read access', 'Home-directory bounded top-level file count',
  'Home-directory bounded top-level subdirectory count', 'User configuration-directory presence',
  'User configuration-directory bounded entry count', 'User cache-directory bounded entry count',
  'Shell-history file presence without reading contents'];
const [access, files, directories, config, configCount, cacheCount, history] = names;
const file = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const link = { isFile: () => false, isDirectory: () => false };
const fail = (code) => { throw Object.assign(new Error('private detail'), { code }); };

test('model and developer directory probes use only fixed home metadata on all platforms', async () => {
  const groups = [
    ['Hugging Face model-cache directory presence', ['.cache/huggingface/hub', '.cache/huggingface/transformers']],
    ['Ollama model-directory presence', ['.ollama/models']],
    ['Jupyter configuration-directory presence', ['.jupyter']],
    ['Conda installation-directory presence', ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', 'Miniconda3', 'Anaconda3', 'Miniforge3', 'Mambaforge']],
  ];
  for (const platform of ['linux', 'darwin', 'win32']) {
    const home = platform === 'win32' ? 'C:\\Users\\private' : '/home/private';
    const sep = platform === 'win32' ? '\\' : '/';
    for (const [name, suffixes] of groups) {
      const candidates = suffixes.map((suffix) => [home, ...suffix.split('/')].join(sep));
      for (const match of [null, ...candidates]) {
        const seen = [];
        const probe = createHostArtifactProbes({ platform, homeDirectory: () => home,
          openDirectory: () => assert.fail('must not enumerate'),
          statFile: async (p) => { seen.push(p); return p === match ? directory : file; },
        }).find((p) => p.name === name);
        assert.deepEqual(await probe.run({}), { value: match !== null, status: 'ok' });
        assert.deepEqual(seen, match === null ? candidates : candidates.slice(0, candidates.indexOf(match) + 1));
      }
      for (const [code, status] of [['ENOENT', 'ok'], ['ENOTDIR', 'ok'], ['EACCES', 'permission_denied'], ['EIO', 'error']]) {
        const probe = createHostArtifactProbes({ platform, homeDirectory: () => home,
          statFile: async () => fail(code),
        }).find((p) => p.name === name);
        assert.deepEqual(await probe.run({}), { value: status === 'ok' ? false : null, status });
      }
      if (candidates.length > 1) {
        const probe = createHostArtifactProbes({ platform, homeDirectory: () => home,
          statFile: async (p) => p === candidates.at(-1) ? directory : fail('EACCES'),
        }).find((p) => p.name === name);
        assert.deepEqual(await probe.run({}), { value: true, status: 'ok' });
      }
    }
  }
});
const defaults = { platform: 'linux', homeDirectory: () => '/private/home', packageRoot: '/own/package',
  accessFile: async () => {}, statFile: async () => null,
  openDirectory: async () => ({ read: async () => null, close: async () => {} }),
};
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createHostArtifactProbes({ ...defaults, ...options }), timeoutMs,
})).properties;

test('real fixture counts direct entries, excludes symlinks from home types, never exposes names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['.config/nested', '.cache', 'private-folder']) await mkdir(path.join(root, name), { recursive: true });
  for (const name of ['private-file', '.bash_history', '.config/secret', '.config/nested/ignored', '.cache/entry']) await writeFile(path.join(root, name), 'never read');
  await symlink(path.join(root, 'private-file'), path.join(root, 'file-link'));
  await symlink(path.join(root, 'private-folder'), path.join(root, 'directory-link'));
  const p = (await collectEnvironment({ probes: createHostArtifactProbes({ platform: 'linux', homeDirectory: () => root }) })).properties;
  for (const name of [access, config, history]) assert.deepEqual(p[name], { value: true, status: 'ok' });
  assert.equal(p[files].value, 2);
  assert.equal(p[directories].value, 3);
  assert.equal(p[configCount].value, 2);
  assert.equal(p[cacheCount].value, 1);
  assert.ok(!JSON.stringify(p).includes(root));
  assert.ok(!JSON.stringify(p).includes('private-'));
});

test('home scan is shared, bounded by all entry types, closed, and refreshed per collection', async () => {
  let opens = 0;
  let reads = 0;
  let closes = 0;
  const probes = createHostArtifactProbes({ ...defaults, entryLimit: 3, openDirectory: async (_, options) => {
    opens++; assert.equal(options.bufferSize, 1);
    const entries = [file, directory, link];
    return { read: async () => { reads++; return entries.shift() ?? null; }, close: async () => { closes++; } };
  } });
  for (let i = 0; i < 2; i++) {
    const p = (await collectEnvironment({ probes })).properties;
    for (const name of [files, directories]) assert.deepEqual(p[name], { value: null, status: 'truncated' });
  }
  assert.equal(opens, 2); assert.equal(reads, 6); assert.equal(closes, 2);
  const p = await collect();
  assert.equal(p[files].value, 0); assert.equal(p[directories].value, 0);
  for (const entryLimit of [0, -1, 1.5, 1025]) assert.throws(() => createHostArtifactProbes({ entryLimit }), TypeError);
});

test('missing, wrong type, denied and empty configuration/cache directories are distinct', async () => {
  const missing = await collect({ statFile: async () => fail('ENOENT') });
  assert.equal(missing[config].value, false);
  assert.equal(missing[history].value, false);
  assert.equal(missing[configCount].status, 'absent');
  const wrong = await collect({ statFile: async () => file });
  assert.equal(wrong[config].value, false);
  assert.equal(wrong[cacheCount].status, 'absent');
  let stats = 0;
  const empty = await collect({ statFile: async (name) => { if (name.endsWith('/.config')) stats++; return directory; } });
  assert.equal(empty[config].value, true);
  assert.equal(empty[configCount].value, 0);
  assert.equal(empty[cacheCount].value, 0);
  assert.equal(stats, 1);
  const denied = await collect({ statFile: async () => fail('EACCES') });
  for (const name of [config, configCount, cacheCount, history]) assert.equal(denied[name].status, 'permission_denied');
});

test('platform conventions are fixed and unknown platforms still support home and package checks', async () => {
  for (const [platform, home, expectedConfig, expectedCache, historyEnd] of [
    ['linux', '/home/private', '/home/private/.config', '/home/private/.cache', '/.local/share/fish/fish_history'],
    ['darwin', '/Users/private', '/Users/private/Library/Application Support', '/Users/private/Library/Caches', '/.local/share/fish/fish_history'],
    ['win32', 'C:\\Users\\private', 'C:\\Users\\private\\AppData\\Roaming', 'C:\\Users\\private\\AppData\\Local', '\\PSReadLine\\ConsoleHost_history.txt'],
  ]) {
    const inspected = [];
    const p = await collect({ platform, homeDirectory: () => home,
      statFile: async (name) => { inspected.push(name); return name.endsWith(historyEnd) ? file : directory; } });
    assert.equal(inspected[0], expectedConfig);
    assert.equal(inspected[1], expectedCache);
    assert.equal(p[history].value, true);
  }
  const p = await collect({ platform: 'freebsd', statFile: async () => assert.fail('no known locations') });
  assert.equal(p[files].value, 0); assert.equal(p[access].value, true);
  for (const name of [config, configCount, cacheCount, history]) assert.equal(p[name].status, 'unsupported');
});

test('history checks regular files only and a later positive match resolves an earlier denial', async () => {
  const seen = [];
  const p = await collect({ statFile: async (name) => {
    seen.push(name);
    if (name.endsWith('.bash_history')) fail('EACCES');
    if (name.endsWith('.zsh_history')) return directory;
    if (name.endsWith('.sh_history')) return file;
    return null;
  } });
  assert.equal(p[history].value, true);
  assert.ok(!seen.some((name) => name.endsWith('/.history')));
  const wrong = await collect({ statFile: async () => directory });
  assert.equal(wrong[history].value, false);
});

test('package access uses its module location, R_OK and normal error statuses independently of home', async () => {
  const expected = fileURLToPath(new URL('../', import.meta.url));
  const probes = createHostArtifactProbes({ homeDirectory: () => { throw new Error(); }, accessFile: async (root, mode) => {
    assert.equal(root, expected); assert.equal(mode, constants.R_OK);
  } });
  const p = (await collectEnvironment({ probes })).properties;
  assert.equal(p[access].value, true);
  assert.equal(p[files].status, 'error');
  for (const [code, status] of [['EACCES', 'permission_denied'], ['ENOENT', 'absent'], ['ENOSYS', 'unsupported']]) {
    assert.equal((await collect({ accessFile: async () => fail(code) }))[access].status, status);
  }
  for (const [home, status] of [['relative', 'error'], ['/a\0b', 'error'], ['/' + 'a'.repeat(65536), 'truncated']]) {
    assert.equal((await collect({ homeDirectory: () => home }))[files].status, status);
  }
});

test('read failures and cancelled delayed opens release directory handles', async () => {
  let closed = 0;
  const p = await collect({ openDirectory: async () => ({ read: async () => fail('EIO'), close: async () => { closed++; } }) });
  assert.equal(p[files].status, 'error'); assert.equal(p[directories].status, 'error'); assert.equal(closed, 1);
  let resolveOpen;
  let reads = 0;
  const probes = createHostArtifactProbes({ ...defaults, openDirectory: () => new Promise((resolve) => { resolveOpen = resolve; }) });
  const controller = new AbortController();
  const pending = probes.find((probe) => probe.name === files).run({ signal: controller.signal, cache: new Map() });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveOpen({ read: async () => { reads++; return null; }, close: async () => { closed++; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(reads, 0); assert.equal(closed, 2);
  const timed = await collect({ openDirectory: async () => new Promise(() => {}) }, 5);
  assert.equal(timed[files].status, 'timeout'); assert.equal(timed[directories].status, 'timeout');
});

const toolingNames = [
  'User SSH directory presence without reading contents',
  'User AWS configuration-directory presence without reading contents',
  'User Azure configuration-directory presence without reading contents',
  'User Google Cloud configuration-directory presence without reading contents',
  'User Git configuration-file presence without reading contents',
];
const toolingProbes = (options = {}) => createHostArtifactProbes({ ...defaults,
  openDirectory: () => assert.fail('presence must not enumerate directories'),
  accessFile: () => assert.fail('presence must use metadata only'), ...options,
}).filter((probe) => toolingNames.includes(probe.name));
const collectTooling = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: toolingProbes(options), timeoutMs,
})).properties;

test('tooling presence checks only fixed home candidates on each supported platform', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const api = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? 'C:\\Users\\private' : '/home/private';
    const candidates = ['.ssh', '.aws', '.azure',
      platform === 'win32' ? 'AppData/Roaming/gcloud' : '.config/gcloud', '.gitconfig', '.config/git/config']
      .map((name) => [home, ...name.split('/')].join(api.sep));
    const seen = [];
    const p = await collectTooling({ platform, homeDirectory: () => home, statFile: async (name) => {
      seen.push(name);
      if (name === candidates[4]) fail('ENOENT');
      return name === candidates[5] ? file : directory;
    } });
    assert.deepEqual(seen, candidates);
    for (const name of toolingNames) assert.deepEqual(p[name], { value: true, status: 'ok' });
    assert.ok(!JSON.stringify(p).includes(home));
  }
});

test('tooling missing, wrong-type and failed metadata have distinct results', async () => {
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const p = await collectTooling({ statFile: async () => fail(code) });
    for (const name of toolingNames) assert.deepEqual(p[name], { value: false, status: 'ok' });
  }
  const wrong = await collectTooling({ statFile: async (name) => name.endsWith('.gitconfig') || name.endsWith('/git/config') ? directory : file });
  for (const name of toolingNames) assert.equal(wrong[name].value, false);
  for (const [code, status] of [['EACCES', 'permission_denied'], ['EIO', 'error'], ['ENOSYS', 'unsupported']]) {
    const p = await collectTooling({ statFile: async () => fail(code) });
    for (const name of toolingNames) assert.deepEqual(p[name], { value: null, status });
  }
  const git = toolingNames[4];
  const fallback = await collectTooling({ statFile: async (name) => {
    if (name.endsWith('.gitconfig')) fail('EACCES');
    return name.endsWith('/git/config') ? file : null;
  } });
  assert.equal(fallback[git].value, true);
  const denied = await collectTooling({ statFile: async (name) => {
    if (name.endsWith('.gitconfig')) fail('EACCES');
    return null;
  } });
  assert.equal(denied[git].status, 'permission_denied');
});

test('tooling presence follows symlinks to the required type and never reads contents', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tooling-presence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'target'));
  await symlink(path.join(root, 'target'), path.join(root, '.ssh'));
  await mkdir(path.join(root, '.aws'));
  await writeFile(path.join(root, '.aws', 'credentials'), 'fixture-content-never-read');
  await writeFile(path.join(root, '.azure'), 'wrong type');
  await mkdir(path.join(root, '.config'));
  await symlink(path.join(root, 'missing'), path.join(root, '.config', 'gcloud'));
  await writeFile(path.join(root, 'git-target'), 'fixture-content-never-read');
  await symlink(path.join(root, 'git-target'), path.join(root, '.gitconfig'));
  const { stat } = await import('node:fs/promises');
  const p = await collectTooling({ homeDirectory: () => root, statFile: stat });
  assert.deepEqual(toolingNames.map((name) => p[name].value), [true, true, false, false, true]);
  assert.ok(!JSON.stringify(p).includes('fixture-content'));
  assert.ok(!JSON.stringify(p).includes(root));
});

test('tooling checks bound paths, refresh observations and stop after cancellation', async () => {
  const unsupported = await collectTooling({ platform: 'freebsd', statFile: () => assert.fail('unsupported platform') });
  for (const name of toolingNames) assert.equal(unsupported[name].status, 'unsupported');
  for (const [home, status] of [['relative', 'error'], ['/a\0b', 'error'], ['/' + 'x'.repeat(65536), 'truncated']]) {
    const p = await collectTooling({ homeDirectory: () => home, statFile: () => assert.fail('invalid path') });
    for (const name of toolingNames) assert.equal(p[name].status, status);
  }
  let homes = 0;
  let stats = 0;
  const probes = toolingProbes({ homeDirectory: () => { homes++; return '/home/private'; },
    statFile: async () => { stats++; return null; } });
  for (let i = 0; i < 2; i++) await collectEnvironment({ probes });
  assert.equal(homes, 2); assert.equal(stats, 12);
  let release;
  let calls = 0;
  const gitProbe = toolingProbes({ statFile: () => { calls++; return new Promise((resolve) => { release = resolve; }); } }).at(-1);
  const controller = new AbortController();
  const pending = gitProbe.run({ signal: controller.signal, cache: new Map() });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release(file);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  const timed = await collectTooling({ statFile: () => new Promise(() => {}) }, 5);
  for (const name of toolingNames) assert.equal(timed[name].status, 'timeout');
});

const editorNames = ['VS Code', 'JetBrains', 'Cursor', 'Claude', 'GitHub Copilot', 'Gemini']
  .map((name) => `${name} configuration-directory presence`);
const editorProbes = (options = {}) => createHostArtifactProbes({ ...defaults,
  openDirectory: () => assert.fail('must not enumerate editor directories'),
  accessFile: () => assert.fail('must only inspect metadata'), ...options,
}).filter((probe) => editorNames.includes(probe.name));
const collectEditors = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: editorProbes(options), timeoutMs,
})).properties;

test('editor probes inspect only the documented fixed paths on Linux, macOS and Windows', async () => {
  for (const [platform, home, base, copilot] of [
    ['linux', '/home/private', '.config', '.config/github-copilot'],
    ['darwin', '/Users/private', 'Library/Application Support', '.config/github-copilot'],
    ['win32', 'C:\\Users\\private', 'AppData/Roaming', 'AppData/Local/github-copilot'],
  ]) {
    const sep = platform === 'win32' ? '\\' : '/';
    const candidates = [[`${base}/Code`, `${base}/Code - Insiders`], [`${base}/JetBrains`],
      [`${base}/Cursor`, '.cursor'], ['.claude'], ['.copilot', copilot], ['.gemini']]
      .map((group) => group.map((p) => [home, ...p.split('/')].join(sep)));
    const seen = [];
    const options = { platform, homeDirectory: () => home, statFile: async (p) => { seen.push(p); fail('ENOENT'); } };
    const missing = await collectEditors(options);
    assert.deepEqual(seen, candidates.flat());
    for (const name of editorNames) assert.deepEqual(missing[name], { value: false, status: 'ok' });
    // Exercise each candidate as the only positive match, including fallbacks.
    for (const [index, group] of candidates.entries()) for (const candidate of group) {
      const p = await collectEditors({ ...options, statFile: async (name) => name === candidate ? directory : null });
      assert.deepEqual(editorNames.map((name) => p[name].value), editorNames.map((_, i) => i === index));
      assert.ok(!JSON.stringify(p).includes(home));
    }
  }
});

test('editor directory checks distinguish files and errors and allow a positive fallback', async () => {
  const wrongType = await collectEditors({ statFile: async () => file });
  for (const name of editorNames) assert.equal(wrongType[name].value, false);
  for (const [code, status] of [['ENOTDIR', 'ok'], ['EACCES', 'permission_denied'], ['EIO', 'error']]) {
    const p = await collectEditors({ statFile: async () => fail(code) });
    for (const name of editorNames) assert.deepEqual(p[name], { value: status === 'ok' ? false : null, status });
  }
  const seen = [];
  const p = await collectEditors({ statFile: async (name) => {
    seen.push(name);
    if (name.endsWith('/Code') || name.endsWith('/Cursor') || name.endsWith('/.copilot')) fail('EACCES');
    return directory;
  } });
  for (const name of editorNames) assert.equal(p[name].value, true);
  assert.equal(seen.length, 9);
  const unsupported = await collectEditors({ platform: 'freebsd', statFile: () => assert.fail('unsupported paths') });
  for (const name of editorNames) assert.equal(unsupported[name].status, 'unsupported');
  const invalidHome = await collectEditors({ homeDirectory: () => 'relative', statFile: () => assert.fail('invalid home') });
  for (const name of editorNames) assert.equal(invalidHome[name].status, 'error');
  const timed = await collectEditors({ statFile: () => new Promise(() => {}) }, 5);
  for (const name of editorNames) assert.equal(timed[name].status, 'timeout');
});

test('real editor fixture follows directory symlinks, excludes dangling links, and refreshes presence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-presence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.config', 'Code'), { recursive: true });
  await mkdir(path.join(root, '.config', 'JetBrains'));
  await symlink(path.join(root, '.config', 'Code'), path.join(root, '.cursor'));
  await writeFile(path.join(root, '.claude'), 'wrong type, never read');
  await symlink(path.join(root, 'missing'), path.join(root, '.copilot'));
  await mkdir(path.join(root, '.gemini'));
  const { stat } = await import('node:fs/promises');
  const probes = editorProbes({ homeDirectory: () => root, statFile: stat });
  const first = (await collectEnvironment({ probes })).properties;
  assert.deepEqual(editorNames.map((name) => first[name].value), [true, true, true, false, false, true]);
  assert.ok(!JSON.stringify(first).includes(root));
  await rm(path.join(root, '.gemini'), { recursive: true });
  const second = (await collectEnvironment({ probes })).properties;
  assert.equal(second[editorNames[5]].value, false);
});
