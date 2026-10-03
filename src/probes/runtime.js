import process from 'node:process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizePathTemplate } from './session.js';
import { result, observed } from '../result.js';

const installationRequire = createRequire(new URL('../../scripts/postinstall.js', import.meta.url));
const truncated = () => { throw Object.assign(new Error('Runtime metadata exceeds limit'), { code: 'EPROBETRUNCATED' }); };
const INPUT_LIMIT = 64 * 1024;

// NODE_OPTIONS uses space separators, double quotes and escapes within quotes,
// not a shell parser. Never evaluate or load any tokens encountered here.
export function tokenizeNodeOptions(raw) {
  if (typeof raw !== 'string') throw new TypeError('Invalid NODE_OPTIONS');
  if (raw.length > INPUT_LIMIT) truncated();
  if (raw.includes('\0')) throw new Error('Invalid NODE_OPTIONS');
  const tokens = [];
  let token = '', quoted = false, started = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\' && quoted) {
      if (++i === raw.length) throw new Error('Incomplete NODE_OPTIONS escape');
      token += raw[i];
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ' ' && !quoted) {
      if (started) tokens.push(token);
      token = ''; started = false;
    } else {
      token += char; started = true;
    }
  }
  if (quoted) throw new Error('Unterminated NODE_OPTIONS quote');
  if (started) tokens.push(token);
  return tokens;
}

export function inspectStartupTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) throw new TypeError('Invalid startup arguments');
  if (tokens.length > 4096 || tokens.reduce((sum, token) => sum + token.length, 0) > INPUT_LIMIT) truncated();
  const takesValue = new Set(['--require', '-r', '--eval', '-e', '--print', '-p',
    '--import', '--loader', '--experimental-loader', '--title', '--conditions', '-C',
    '--inspect-port', '--debug-port', '--inspect-publish-uid', '--input-type',
    '--icu-data-dir', '--openssl-config', '--redirect-warnings', '--diagnostic-dir',
    '--report-dir', '--report-directory', '--report-filename', '--env-file', '--env-file-if-exists']);
  let inspector = false, requirePreload = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') break;
    const name = token.split('=', 1)[0].replace(/_/g, '-');
    if (['--inspect', '--inspect-brk', '--inspect-wait'].includes(name)) inspector = true;
    if (name === '--require' || token === '-r' || (token.startsWith('-r') && !token.startsWith('--'))) requirePreload = true;
    // Value tokens (notably eval code and preload paths) are not flag tokens.
    if (!token.includes('=') && takesValue.has(name)) i++;
  }
  return { inspector, requirePreload };
}

export function createRuntimeProbes({
  runtime = process, platform = process.platform,
  searchPaths = () => installationRequire.resolve.paths('npm-probing-resolution-placeholder'),
} = {}) {
  const flagKey = Symbol('startup-flag-presence');
  const presence = (name) => () => result(Object.hasOwn(runtime.env ?? {}, name));
  const flags = (field) => async (ctx) => {
    const run = () => {
      if (!Array.isArray(runtime.execArgv)) throw Object.assign(new Error('Startup arguments unavailable'), { code: 'ENOSYS' });
      const cli = inspectStartupTokens(runtime.execArgv);
      const env = inspectStartupTokens(tokenizeNodeOptions(runtime.env?.NODE_OPTIONS ?? ''));
      return { inspector: cli.inspector || env.inspector, requirePreload: cli.requirePreload || env.requirePreload };
    };
    if (!ctx.cache) return result(run()[field]);
    if (!ctx.cache.has(flagKey)) ctx.cache.set(flagKey, Promise.resolve().then(run));
    return result((await ctx.cache.get(flagKey))[field]);
  };
  const version = (name) => () => {
    const value = runtime.versions?.[name] ?? (name === 'node' ? runtime.version?.replace(/^v/, '') : undefined);
    if (value !== undefined && typeof value !== 'string') throw new TypeError('Invalid version metadata');
    return observed(value);
  };
  return [
    ...[
      ['Node.js version', 'node'], ['V8 engine version', 'v8'], ['Node.js module ABI version', 'modules'],
      ['Node.js N-API version', 'napi'], ['Node.js libuv version', 'uv'],
      ['Node.js OpenSSL version', 'openssl'], ['Node.js ICU version', 'icu'],
    ].map(([name, key]) => ({ name, run: version(key) })),
    { name: 'Node.js executable normalized path template', run: () => normalizePathTemplate(runtime.execPath, platform) },
    { name: 'Node.js inspector activation flag presence', run: flags('inspector') },
    { name: 'Node.js require-preload flag presence', run: flags('requirePreload') },
    { name: 'NODE_OPTIONS variable presence', run: presence('NODE_OPTIONS') },
    { name: 'NODE_ENV value', run() {
      if (!Object.hasOwn(runtime.env ?? {}, 'NODE_ENV')) return result(null, 'absent');
      if (typeof runtime.env.NODE_ENV !== 'string') throw new TypeError('Invalid NODE_ENV');
      return result(runtime.env.NODE_ENV);
    } },
    { name: 'NODE_PATH variable presence', run: presence('NODE_PATH') },
    { name: 'Node.js module-search-path normalized templates', async run() {
      const paths = await searchPaths();
      if (paths === null || paths === undefined) return result(null, 'absent');
      if (!Array.isArray(paths)) throw new TypeError('Invalid module search paths');
      const api = platform === 'win32' ? path.win32 : path.posix;
      let status = paths.length > 128 ? 'truncated' : 'ok';
      const templates = paths.slice(0, 128).map((raw) => {
        if (typeof raw !== 'string' || !raw) throw new Error('Invalid module search path');
        if (raw.length > INPUT_LIMIT) truncated();
        let resolved = raw;
        if (!api.isAbsolute(raw)) {
          const cwd = runtime.cwd();
          if (!api.isAbsolute(cwd)) throw new Error('Invalid working directory');
          resolved = api.resolve(cwd, raw);
        }
        const entry = normalizePathTemplate(resolved, platform);
        if (entry.status === 'truncated') status = 'truncated';
        return entry.value;
      });
      return result(templates, status);
    } },
  ];
}
