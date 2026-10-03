import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { result, observed } from '../result.js';

const unsupported = () => result(null, 'unsupported');
const absent = () => result(null, 'absent');
const genericAccount = /^(?:root|admin|administrator|user|guest|nobody|node|runner|ubuntu|debian|vagrant|docker|jenkins|buildkite|circleci|gitlab-runner|ci|build|builder|test|sandbox|ec2-user)$/i;

export function hostnameClass(hostname) {
  if (/[^\x00-\x7f]/.test(hostname)) return 'non_ascii';
  if (/^[0-9]+$/.test(hostname)) return 'numeric';
  if (/^[a-f0-9]+$/i.test(hostname)) return 'hexadecimal';
  if (/^[a-z]+$/i.test(hostname)) return 'alphabetic';
  if (/^[a-z0-9]+$/i.test(hostname)) return 'alphanumeric';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(hostname)) return 'hyphenated';
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?$/i.test(hostname)) return 'dotted';
  return 'mixed';
}

// Preserve only a fixed vocabulary of structural directories. All other names,
// drive letters, UNC hosts/shares, usernames and package names are discarded.
export function normalizePathTemplate(raw, platform = process.platform) {
  if (typeof raw !== 'string' || !raw) return absent();
  if (raw.includes('\0')) throw new Error('Invalid path');
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(raw)) throw new Error('Expected an absolute path');
  const normalized = api.normalize(raw);
  const root = api.parse(normalized).root;
  const segments = normalized.slice(root.length).split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
  const vocabulary = new Map(['home', 'Users', 'root', 'tmp', 'temp', 'var', 'private', 'folders',
    'AppData', 'Local', 'Roaming', 'node_modules', 'workspace', 'workspaces', 'opt', 'usr', 'local']
    .reverse().map((name) => [platform === 'win32' ? name.toLowerCase() : name, name]));
  let packageNext = false;
  let userNext = false;
  const safe = segments.map((segment) => {
    if (userNext) { userNext = false; return '<user>'; }
    if (packageNext) {
      if (segment.startsWith('@')) return '<scope>';
      packageNext = false;
      return '<package>';
    }
    const known = vocabulary.get(platform === 'win32' ? segment.toLowerCase() : segment);
    if (known === 'home' || known === 'Users') userNext = true;
    if (known === 'node_modules') packageNext = true;
    return known ?? '<dir>';
  });
  const prefix = platform !== 'win32' ? '<posix-root>'
    : /^\\\\[?.]\\/.test(root) ? '<device-root>'
      : /^\\\\/.test(root) ? '<unc-root>' : /^[a-z]:/i.test(root) ? '<drive>' : '<windows-root>';
  const value = [prefix, ...safe].join('/');
  return value.length > 4096 ? result(value.slice(0, 4096), 'truncated') : result(value);
}

export function createSessionProbes({
  system = os, runtime = process, platform = process.platform, elevationQuery,
} = {}) {
  const keys = new Map();
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!keys.has(name)) keys.set(name, Symbol(name));
    const key = keys.get(name);
    if (!ctx.cache.has(key)) ctx.cache.set(key, Promise.resolve().then(operation));
    return ctx.cache.get(key);
  }
  const call = (target, method) => {
    if (typeof target[method] !== 'function') throw Object.assign(new Error('API unavailable'), { code: 'ENOSYS' });
    return target[method]();
  };
  const identity = (ctx, kind) => cached(ctx, kind, () => {
    const raw = kind === 'user' ? call(system, 'userInfo')?.username : call(system, 'hostname');
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw new Error('Invalid identity metadata');
    // Only derived fields enter the collection cache or report.
    return kind === 'user'
      ? { length: [...raw].length, generic: genericAccount.test(raw) }
      : { length: [...raw].length, characterClass: hostnameClass(raw),
        containerLike: /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/i.test(raw)
          || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{8,10}-[a-z0-9]{5}$/.test(raw) };
  });
  const derived = (kind, field) => async (ctx) => {
    const data = await identity(ctx, kind);
    return data ? result(data[field]) : absent();
  };
  const id = (ctx, method) => cached(ctx, method, () => {
    const value = call(runtime, method);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid effective ID');
    return value;
  });
  const tty = (stream) => () => {
    const value = runtime[stream];
    if (!value) return unsupported();
    if (value.isTTY !== undefined && typeof value.isTTY !== 'boolean') throw new Error('Invalid terminal metadata');
    return result(value.isTTY === true);
  };
  return [
    { name: 'Username length', run: derived('user', 'length') },
    { name: 'Username generic-account pattern', run: derived('user', 'generic') },
    { name: 'Hostname length', run: derived('host', 'length') },
    { name: 'Hostname character-pattern class', run: derived('host', 'characterClass') },
    { name: 'Hostname container-like pattern', run: derived('host', 'containerLike') },
    { name: 'Effective user ID', run: async (ctx) => result(await id(ctx, 'geteuid')) },
    { name: 'Effective group ID', run: async (ctx) => result(await id(ctx, 'getegid')) },
    { name: 'Supplementary group count', run() {
      const groups = call(runtime, 'getgroups');
      if (!Array.isArray(groups) || groups.some((g) => !Number.isSafeInteger(g) || g < 0)) throw new Error('Invalid group metadata');
      return result(new Set(groups).size);
    } },
    { name: 'Effective root status', run: async (ctx) => result((await id(ctx, 'geteuid')) === 0) },
    { name: 'Windows process elevation status', async run(ctx) {
      if (platform !== 'win32' || typeof elevationQuery !== 'function') return unsupported();
      const elevated = await elevationQuery({ signal: ctx.signal });
      if (typeof elevated !== 'boolean') throw new Error('Invalid elevation result');
      return result(elevated);
    } },
    { name: 'Process umask', run() {
      const mask = call(runtime, 'umask'); // Getter only: never change the mask.
      if (!Number.isInteger(mask) || mask < 0 || mask > 0o777) throw new Error('Invalid umask');
      return result(mask.toString(8).padStart(4, '0'));
    } },
    { name: 'Login-shell executable basename', run() {
      const raw = platform === 'win32' ? (runtime.env?.ComSpec ?? runtime.env?.COMSPEC) : runtime.env?.SHELL;
      if (!raw) return absent();
      if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('Invalid shell path');
      const api = platform === 'win32' ? path.win32 : path.posix;
      return observed(api.basename(raw));
    } },
    { name: 'Home-directory normalized path template', run: () => normalizePathTemplate(call(system, 'homedir'), platform) },
    { name: 'Working-directory normalized path template', run: () => normalizePathTemplate(call(runtime, 'cwd'), platform) },
    { name: 'Temporary-directory normalized path template', run: () => normalizePathTemplate(call(system, 'tmpdir'), platform) },
    { name: 'Standard input terminal status', run: tty('stdin') },
    { name: 'Standard output terminal status', run: tty('stdout') },
    { name: 'Standard error terminal status', run: tty('stderr') },
  ];
}
