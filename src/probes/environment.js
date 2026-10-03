import process from 'node:process';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { result } from '../result.js';
import { PATH_LENGTH_LIMIT, PATH_ENTRY_LIMIT } from './tools.js';

const PRESENCE_VARIABLES = Object.freeze([
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL',
  'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID', 'BITBUCKET_BUILD_NUMBER', 'AWS_EXECUTION_ENV',
  'KUBERNETES_SERVICE_HOST', 'SSH_AUTH_SOCK',
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN',
]);
const CREDENTIAL_VARIABLES = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN']);

function directoryCategory(entry, platform) {
  const windows = platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  if (!entry || entry === '.') return 'current_directory';
  if (!api.isAbsolute(entry)) return 'relative';
  const normalized = (windows ? api.normalize(entry).replace(/\\/g, '/') : api.normalize(entry)).replace(/\/$/, '');
  const value = windows ? normalized.toLowerCase() : normalized;
  if (/(?:^|\/)node_modules\/\.bin$/.test(value)) return 'node_modules_bin';
  if (windows && /^[a-z]:\/windows(?:\/(?:system32|syswow64)(?:\/.*)?)?$/.test(value)) return 'windows_system';
  if (!windows && /^\/(?:usr\/(?:local\/)?)?s?bin$/.test(value)) return 'system_bin';
  if (windows ? /^[a-z]:\/users(?:\/|$)/.test(value) : /^\/(?:home|Users|root)(?:\/|$)/.test(value)) return 'user_directory';
  return 'other_absolute';
}

export function createEnvironmentProbes({ runtime = process, platform = process.platform, statFile = stat } = {}) {
  const windows = platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  const key = Symbol('environment-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  // Enumerate names only: indicator values and unrelated environment values are never read.
  const metadata = (ctx) => cached(ctx, 'metadata', () => {
    const keys = Object.keys(runtime.env ?? {});
    const names = new Set(windows ? keys.map((name) => name.toUpperCase()) : keys);
    return { count: keys.length, presence: Object.fromEntries(PRESENCE_VARIABLES.map((name) => [name, names.has(name)])) };
  });
  const parsePath = (ctx) => cached(ctx, 'path', () => {
    const env = runtime.env ?? {};
    const name = Object.hasOwn(env, 'PATH') ? 'PATH' : windows ? Object.keys(env).find((item) => item.toUpperCase() === 'PATH') : undefined;
    const raw = name === undefined ? undefined : env[name];
    if (raw === undefined) return { status: 'absent' };
    if (typeof raw !== 'string' || raw.includes('\0')) return { status: 'error' };
    if (raw.length > PATH_LENGTH_LIMIT) return { status: 'truncated' };
    const entries = raw.split(api.delimiter);
    return { count: entries.length, complete: entries.length <= PATH_ENTRY_LIMIT,
      entries: entries.slice(0, PATH_ENTRY_LIMIT).map((entry) => windows && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry) };
  });
  return [
    { name: 'Environment-variable count', run: async (ctx) => result((await metadata(ctx)).count) },
    { name: 'PATH entry count', run: async (ctx) => {
      const data = await parsePath(ctx);
      return data.status ? result(null, data.status) : result(data.count);
    } },
    { name: 'PATH normalized directory categories', run: async (ctx) => {
      const data = await parsePath(ctx);
      return data.status ? result(null, data.status) : result(data.entries.map((entry) => directoryCategory(entry, platform)), data.complete ? 'ok' : 'truncated');
    } },
    { name: 'PATH nonexistent-entry count', run: async (ctx) => {
      const data = await parsePath(ctx);
      if (data.status) return result(null, data.status);
      if (!data.complete) return result(null, 'truncated');
      let count = 0;
      let cwd;
      const checked = new Map();
      for (let entry of data.entries) {
        ctx.signal?.throwIfAborted();
        if (windows && /^[a-z]:(?:[^\\/]|$)/i.test(entry)) return result(null, 'unsupported');
        if (!api.isAbsolute(entry) || windows && /^[\\/](?![\\/])/.test(entry)) {
          cwd ??= runtime.cwd();
          if (typeof cwd !== 'string' || !api.isAbsolute(cwd) || cwd.includes('\0')) return result(null, 'error');
          if (cwd.length > PATH_LENGTH_LIMIT) return result(null, 'truncated');
          entry = api.resolve(cwd, entry);
        }
        entry = api.normalize(entry);
        const identity = windows ? entry.toLowerCase() : entry;
        if (!checked.has(identity)) {
          let missing;
          try {
            const info = await statFile(entry);
            ctx.signal?.throwIfAborted();
            missing = !info?.isDirectory();
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
            missing = true;
          }
          checked.set(identity, missing);
        }
        if (checked.get(identity)) count++;
      }
      return result(count);
    } },
    ...PRESENCE_VARIABLES.map((name) => ({
      name: `${name} variable presence${CREDENTIAL_VARIABLES.has(name) ? ' without reading value' : ''}`,
      run: async (ctx) => result((await metadata(ctx)).presence[name]),
    })),
  ];
}
