import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { stat, opendir } from 'node:fs/promises';
import { result } from '../result.js';

export const DIRECTORY_ENTRY_LIMIT = 1024;

// Fixed conventional locations, not effective package-manager configuration.
export function userPackagePaths(home, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof home !== 'string' || home.includes('\0') || !api.isAbsolute(home)) throw new Error('Invalid home directory');
  if (home.length > 65536) throw Object.assign(new Error('Path exceeds limit'), { code: 'EPROBETRUNCATED' });
  const join = (...parts) => api.join(home, ...parts);
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw Object.assign(new Error('Unsupported platform'), { code: 'ENOTSUP' });
  return {
    npmrc: [join('.npmrc')],
    npm: platform === 'win32' ? [join('AppData', 'Local', 'npm-cache'), join('.npm')] : [join('.npm')],
    yarn: platform === 'win32' ? [join('AppData', 'Local', 'Yarn', 'Cache')]
      : platform === 'darwin' ? [join('Library', 'Caches', 'Yarn'), join('.cache', 'yarn')] : [join('.cache', 'yarn')],
    pnpm: [platform === 'win32' ? join('AppData', 'Local', 'pnpm', 'store')
      : platform === 'darwin' ? join('Library', 'pnpm', 'store') : join('.local', 'share', 'pnpm', 'store'), join('.pnpm-store')],
  };
}

export function createUserPackageProbes({ platform = process.platform, homeDirectory = os.homedir,
  statFile = stat, openDirectory = opendir, entryLimit = DIRECTORY_ENTRY_LIMIT } = {}) {
  if (!Number.isInteger(entryLimit) || entryLimit < 1 || entryLimit > DIRECTORY_ENTRY_LIMIT) throw new TypeError('Invalid directory entry limit');
  const api = platform === 'win32' ? path.win32 : path.posix;
  const key = Symbol('user-package-observations');
  const cached = (ctx, name, operation) => {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  };
  const paths = (ctx) => cached(ctx, 'paths', () => userPackagePaths(homeDirectory(), platform));
  const inspect = (file, ctx) => cached(ctx, `stat:${file}`, async () => {
    ctx.signal?.throwIfAborted();
    try { return await statFile(file); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  });
  const locate = (kind, ctx) => cached(ctx, kind, async () => {
    for (const file of (await paths(ctx))[kind]) {
      const info = await inspect(file, ctx);
      if (kind === 'npmrc' ? info?.isFile() : info?.isDirectory()) return file;
    }
    return null;
  });
  const presence = (kind) => async (ctx) => result(Boolean(await locate(kind, ctx)));
  const count = (logs) => async (ctx) => {
    let directory = await locate('npm', ctx);
    if (!directory) return result(null, 'absent');
    if (logs) {
      directory = api.join(directory, '_logs');
      if (!(await inspect(directory, ctx))?.isDirectory()) return result(null, 'absent');
    }
    ctx.signal?.throwIfAborted();
    const handle = await openDirectory(directory, { bufferSize: 1 });
    try {
      let total = 0;
      for (let scanned = 0; scanned < entryLimit; scanned++) {
        ctx.signal?.throwIfAborted();
        const entry = await handle.read();
        if (!entry) return result(total);
        if (!logs || entry.isFile()) total++;
      }
      // No extra read to determine completeness: exactly reaching the bound is truncated.
      return result(null, 'truncated');
    } finally {
      await handle.close();
    }
  };
  return [
    { name: 'User .npmrc file presence', run: presence('npmrc') },
    { name: 'User npm cache directory presence', run: presence('npm') },
    { name: 'User npm cache bounded entry count', run: count(false) },
    { name: 'User npm log directory bounded file count', run: count(true) },
    { name: 'User yarn cache directory presence', run: presence('yarn') },
    { name: 'User pnpm store directory presence', run: presence('pnpm') },
  ];
}
