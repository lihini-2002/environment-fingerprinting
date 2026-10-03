import process from 'node:process';
import path from 'node:path';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { result, statusFromError } from '../result.js';

export const PATH_LENGTH_LIMIT = 64 * 1024;
export const PATH_ENTRY_LIMIT = 128;
const TOOL_NAMES = [
  ['Git', ['git']],
  ['Python', ['python3', 'python']],
  ['Compiler', ['cc', 'gcc', 'clang', 'c++', 'g++', 'clang++', 'cl']],
  ['Make', ['make', 'gmake', 'nmake', 'mingw32-make']],
  ['Docker', ['docker']],
];

export function createToolProbes({ runtime = process, platform = process.platform,
  statFile = stat, accessFile = access } = {}) {
  const windows = platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  const key = Symbol('tool-search-path');
  function searchPath(ctx) {
    if (ctx.cache?.has(key)) return ctx.cache.get(key);
    const env = runtime.env ?? {};
    // Windows environment keys are case-insensitive; prefer the exact PATH key.
    const value = env.PATH ?? (windows ? env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH')] : undefined);
    let observation;
    if (value === undefined) observation = { status: 'absent' };
    else if (typeof value !== 'string' || value.includes('\0')) observation = { status: 'error' };
    else if (value.length > PATH_LENGTH_LIMIT) observation = { status: 'truncated' };
    else {
      const entries = value.split(windows ? ';' : ':');
      observation = { entries: entries.slice(0, PATH_ENTRY_LIMIT), complete: entries.length <= PATH_ENTRY_LIMIT };
    }
    ctx.cache?.set(key, observation);
    return observation;
  }
  return TOOL_NAMES.map(([label, names]) => ({
    name: `${label} executable availability`,
    async run(ctx) {
      const search = searchPath(ctx);
      if (search.status) return result(null, search.status);
      let failure;
      const directories = new Set();
      for (let directory of search.entries) {
        ctx.signal?.throwIfAborted();
        if (windows && directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
        // Do not guess a drive-specific working directory for Windows C:relative paths.
        if (windows && /^[a-z]:(?:[^\\/]|$)/i.test(directory)) {
          failure ??= 'unsupported';
          continue;
        }
        if (!api.isAbsolute(directory) || windows && /^[\\/](?![\\/])/.test(directory)) {
          const cwd = runtime.cwd();
          if (typeof cwd !== 'string' || !api.isAbsolute(cwd) || cwd.includes('\0')) return result(null, 'error');
          if (cwd.length > PATH_LENGTH_LIMIT) return result(null, 'truncated');
          directory = api.resolve(cwd, directory);
        }
        directory = api.normalize(directory);
        const identity = windows ? directory.toLowerCase() : directory;
        if (directories.has(identity)) continue;
        directories.add(identity);
        for (const name of names) {
          // Fixed Windows launchable suffixes; no PATHEXT-driven arbitrary file checks.
          for (const suffix of windows ? ['.exe', '.com', '.cmd', '.bat'] : ['']) {
            ctx.signal?.throwIfAborted();
            const candidate = api.join(directory, name + suffix);
            try {
              const info = await statFile(candidate);
              if (!info?.isFile()) continue;
              if (!windows) {
                if ((info.mode & 0o111) === 0) continue;
                ctx.signal?.throwIfAborted();
                await accessFile(candidate, constants.X_OK);
              }
              ctx.signal?.throwIfAborted();
              return result(true);
            } catch (error) {
              if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
              ctx.signal?.throwIfAborted();
              failure ??= statusFromError(error);
            }
          }
        }
      }
      return failure ? result(null, failure) : search.complete ? result(false) : result(null, 'truncated');
    },
  }));
}
