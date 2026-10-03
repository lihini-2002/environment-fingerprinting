import process from 'node:process';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readBoundedFile } from './os-release.js';
import { createUserPackageProbes } from './user-package.js';
import { result } from '../result.js';

export const ANCESTOR_LIMIT = 16;
export const PACKAGE_JSON_LIMIT = 256 * 1024;

export function ancestorDirectories(cwd, platform = process.platform, maxDepth = ANCESTOR_LIMIT) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof cwd !== 'string' || cwd.includes('\0') || !api.isAbsolute(cwd)) throw new Error('Invalid package working directory');
  if (cwd.length > 65536) throw Object.assign(new Error('Path exceeds limit'), { code: 'EPROBETRUNCATED' });
  const directories = [];
  let current = api.normalize(cwd);
  for (let depth = 0; depth < maxDepth; depth++) {
    const parts = current.split(platform === 'win32' ? /[\\/]+/ : /\/+/);
    // Exclude dependency package manifests, scopes, pnpm stores and node_modules itself.
    const insideDependencies = parts.some((p) => (platform === 'win32' ? p.toLowerCase() : p) === 'node_modules');
    if (!insideDependencies) directories.push(current);
    const parent = api.dirname(current);
    if (parent === current) return { directories, complete: true };
    current = parent;
  }
  return { directories, complete: false };
}

export function createProjectProbes({ runtime = process, platform = process.platform,
  statFile = stat, readFile = readBoundedFile, maxDepth = ANCESTOR_LIMIT,
  ...userOptions
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > ANCESTOR_LIMIT) throw new TypeError('Invalid ancestor depth');
  const api = platform === 'win32' ? path.win32 : path.posix;
  const key = Symbol('project-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  const ancestors = (ctx) => cached(ctx, 'ancestors', () => ancestorDirectories(runtime.cwd(), platform, maxDepth));
  const inspect = (file, ctx) => cached(ctx, `stat:${file}`, async () => {
    ctx.signal?.throwIfAborted();
    try { return await statFile(file); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  });
  async function find(name, type, ctx) {
    const { directories, complete } = await ancestors(ctx);
    for (const directory of directories) {
      ctx.signal?.throwIfAborted();
      const file = api.join(directory, name);
      const info = await inspect(file, ctx);
      if (info && (type === 'directory' ? info.isDirectory() : info.isFile())) return file;
    }
    if (!complete) throw Object.assign(new Error('Ancestor scan depth exceeded'), { code: 'EPROBETRUNCATED' });
    return null;
  }
  const presence = (name, type = 'file') => async (ctx) => result(Boolean(await find(name, type, ctx)));
  const readManifest = (file, ctx) => cached(ctx, `manifest:${file}`, async () => {
    const text = await readFile(file, { signal: ctx.signal, limit: PACKAGE_JSON_LIMIT });
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid project manifest');
    // Discard names, scripts, URLs and all other manifest data after deriving counts.
    const counts = {};
    for (const field of ['dependencies', 'devDependencies']) {
      if (!Object.hasOwn(data, field)) counts[field] = result(0);
      else if (!data[field] || typeof data[field] !== 'object' || Array.isArray(data[field]) ||
        Object.values(data[field]).some((value) => typeof value !== 'string')) counts[field] = result(null, 'error');
      else counts[field] = result(Object.keys(data[field]).length);
    }
    const workspaces = data.workspaces;
    counts.workspace = Array.isArray(workspaces)
      ? workspaces.every((item) => typeof item === 'string')
      : Boolean(workspaces && typeof workspaces === 'object' &&
        Array.isArray(workspaces.packages) && workspaces.packages.every((item) => typeof item === 'string'));
    return counts;
  });
  const manifest = async (ctx) => {
    const file = await find('package.json', 'file', ctx);
    return file ? readManifest(file, ctx) : null;
  };
  const workspace = async (ctx) => {
    const { directories, complete } = await ancestors(ctx);
    for (const directory of directories) {
      ctx.signal?.throwIfAborted();
      if ((await inspect(api.join(directory, 'pnpm-workspace.yaml'), ctx))?.isFile()) return result(true);
      const file = api.join(directory, 'package.json');
      if ((await inspect(file, ctx))?.isFile() && (await readManifest(file, ctx)).workspace) return result(true);
    }
    if (!complete) throw Object.assign(new Error('Ancestor scan depth exceeded'), { code: 'EPROBETRUNCATED' });
    return result(false);
  };
  const count = (field) => async (ctx) => (await manifest(ctx))?.[field] ?? result(null, 'absent');
  return [
    { name: 'Ancestor project workspace configuration presence', run: workspace },
    { name: 'Ancestor project .npmrc file presence', run: presence('.npmrc') },
    ...createUserPackageProbes({ platform, statFile, ...userOptions }),
    { name: 'Ancestor project package-lock.json presence', run: presence('package-lock.json') },
    { name: 'Ancestor project npm-shrinkwrap.json presence', run: presence('npm-shrinkwrap.json') },
    { name: 'Ancestor project yarn.lock presence', run: presence('yarn.lock') },
    { name: 'Ancestor project pnpm-lock.yaml presence', run: presence('pnpm-lock.yaml') },
    { name: 'Ancestor project package.json presence', run: presence('package.json') },
    { name: 'Ancestor project .git directory presence', run: presence('.git', 'directory') },
    { name: 'Ancestor project node_modules directory presence', run: presence('node_modules', 'directory') },
    { name: 'Ancestor project direct dependency count from package.json', run: count('dependencies') },
    { name: 'Ancestor project development dependency count from package.json', run: count('devDependencies') },
  ];
}
