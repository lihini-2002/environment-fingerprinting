import process from 'node:process';
import path from 'node:path';
import { isIP } from 'node:net';
import { result } from '../result.js';
import { normalizePathTemplate } from './session.js';

const absent = () => result(null, 'absent');
const managers = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function registryClass(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid registry URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid registry protocol');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'registry.npmjs.org') return 'npm_public';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  const ip = isIP(host.replace(/^\[|\]$/g, ''));
  if (ip === 4) return 'ipv4';
  if (ip === 6) return 'ipv6';
  return host.includes('.') ? 'dns_name' : 'single_label';
}

export function normalizedUserAgent(raw) {
  const products = [];
  let platform = null, architecture = null;
  const platforms = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos', 'android']);
  const architectures = new Set(['x64', 'ia32', 'arm', 'arm64', 'ppc64', 's390x', 'riscv64', 'loong64', 'mips', 'mipsel']);
  for (const token of raw.trim().split(/\s+/)) {
    const match = /^(npm|pnpm|yarn|bun|node)\/v?(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(token);
    if (match && match[2].length <= 64 && !products.some((p) => p.name === match[1])) products.push({ name: match[1], version: match[2] });
    if (!platform && platforms.has(token)) platform = token;
    if (!architecture && architectures.has(token)) architecture = token;
  }
  return products.length || platform || architecture ? { products, platform, architecture } : null;
}

function absolutePath(raw, platform) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new Error('Invalid installation directory');
  if (raw.length > 65536) throw Object.assign(new Error('Directory exceeds limit'), { code: 'EPROBETRUNCATED' });
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(raw)) throw new Error('Expected absolute installation directory');
  return api.normalize(raw);
}

export function directoryRelation(cwd, initial, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  cwd = absolutePath(cwd, platform);
  initial = absolutePath(initial, platform);
  const inside = (relative) => relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
  const forward = api.relative(initial, cwd);
  if (!forward) return 'same';
  if (inside(forward)) return 'descendant';
  if (inside(api.relative(cwd, initial))) return 'ancestor';
  return 'unrelated';
}

export function createInstallationProbes({ runtime = process, platform = process.platform } = {}) {
  // Read only explicitly selected keys. Never enumerate or retain npm_config_*.
  function env(name) {
    const values = runtime.env ?? {};
    const value = Object.hasOwn(values, name) ? values[name] : values[name.toUpperCase()];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid installation metadata');
    if (value.length > 65536) throw Object.assign(new Error('Installation metadata exceeds limit'), { code: 'EPROBETRUNCATED' });
    return value;
  }
  const managerKey = Symbol('package-manager');
  function manager(ctx) {
    const read = () => {
      const agent = env('npm_config_user_agent')?.trim();
      // The leading product identifies the invoking manager, not Node or a
      // later compatibility token. Store only known identities and version syntax.
      const token = agent?.split(/\s+/, 1)[0];
      const match = /^(npm|pnpm|yarn|bun)\/([^/]+)$/.exec(token ?? '');
      if (match) return { identity: match[1], version: match[2].length <= 128 && versionPattern.test(match[2]) ? match[2] : null };
      const executable = env('npm_execpath');
      if (!executable) return { identity: null, version: null };
      const base = (platform === 'win32' ? path.win32 : path.posix).basename(executable).toLowerCase();
      let identity = base.replace(/\.(?:c?js|mjs|exe|cmd)$/, '').replace(/-cli$/, '');
      if (/^yarn-\d+\.\d+\.\d+\.cjs$/.test(base)) identity = 'yarn';
      if (!managers.has(identity)) identity = null;
      return { identity, version: null };
    };
    if (!ctx.cache) return read();
    if (!ctx.cache.has(managerKey)) ctx.cache.set(managerKey, Promise.resolve().then(read));
    return ctx.cache.get(managerKey);
  }
  const identifier = (key) => () => {
    const value = env(key)?.trim();
    if (!value) return absent();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)) throw new Error('Invalid lifecycle identifier');
    return result(value);
  };
  const template = (key, shell = false) => () => {
    const value = env(key);
    if (value === undefined || value === '') return absent();
    const api = platform === 'win32' ? path.win32 : path.posix;
    if (api.isAbsolute(value)) return normalizePathTemplate(value, platform);
    if (shell && !/[\\/]/.test(value) && /^[\w.-]+$/.test(value)) return result('<command>');
    // Config paths may be relative to the caller rather than the lifecycle cwd.
    // Preserve a relative template without guessing the caller's directory.
    const normalized = api.normalize(value);
    const parts = normalized.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
    if (platform === 'win32' && /^[a-z]:/i.test(normalized)) return result(null, 'unsupported');
    return result(['<relative>', ...parts.map((part) => part === '..' || part === '.' ? part : '<dir>')].join('/'));
  };
  return [
    { name: 'Package-manager identity', async run(ctx) {
      const value = (await manager(ctx)).identity;
      return value ? result(value) : absent();
    } },
    { name: 'Package-manager version', async run(ctx) {
      const value = (await manager(ctx)).version;
      return value ? result(value) : absent();
    } },
    { name: 'npm lifecycle event name', run: identifier('npm_lifecycle_event') },
    { name: 'npm command name when exposed', run: identifier('npm_command') },
    { name: 'npm global-install configuration', run() {
      const value = env('npm_config_global')?.trim().toLowerCase();
      if (!value) return absent();
      if (value === 'true' || value === '1') return result(true);
      if (value === 'false' || value === '0') return result(false);
      throw new Error('Invalid global-install boolean');
    } },
    { name: 'npm omit configuration', run() {
      const value = env('npm_config_omit');
      if (value === undefined) return absent();
      const values = value.trim().split(/[\s,]+/).filter(Boolean);
      if (values.some((v) => !['dev', 'optional', 'peer'].includes(v))) throw new Error('Invalid omit category');
      return result([...new Set(values)].sort());
    } },
    { name: 'npm script-shell normalized path template', run: template('npm_config_script_shell', true) },
    { name: 'npm cache normalized path template', run: template('npm_config_cache') },
    { name: 'npm prefix normalized path template', run: template('npm_config_prefix') },
    { name: 'npm user-config normalized path template', run: template('npm_config_userconfig') },
    { name: 'npm registry hostname class with user information removed', run() {
      const raw = env('npm_config_registry');
      return raw?.trim() ? result(registryClass(raw)) : absent();
    } },
    { name: 'npm user-agent normalized runtime components', run() {
      const raw = env('npm_config_user_agent');
      if (!raw?.trim()) return absent();
      const value = normalizedUserAgent(raw);
      return value ? result(value) : absent();
    } },
    { name: 'INIT_CWD normalized path template', run() {
      const raw = env('INIT_CWD');
      return raw ? normalizePathTemplate(absolutePath(raw, platform), platform) : absent();
    } },
    { name: 'Lifecycle working-directory relation to INIT_CWD', run() {
      const initial = env('INIT_CWD');
      if (!initial) return absent();
      return result(directoryRelation(runtime.cwd(), initial, platform));
    } },
    { name: 'Package installation depth beneath node_modules', run() {
      const cwd = absolutePath(runtime.cwd(), platform);
      const segments = cwd.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
      return result(segments.filter((segment, i) => i < segments.length - 1 &&
        (platform === 'win32' ? segment.toLowerCase() : segment) === 'node_modules').length);
    } },
  ];
}
