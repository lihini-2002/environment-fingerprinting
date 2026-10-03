import process from 'node:process';
import { posix as path } from 'node:path';
import { stat, lstat } from 'node:fs/promises';
import { readBoundedFile } from './os-release.js';
import { resolveCgroup } from './resources.js';
import { result } from '../result.js';

const CONTROLLERS = new Set(['blkio', 'cpu', 'cpuacct', 'cpuset', 'devices', 'freezer', 'hugetlb', 'io', 'memory', 'misc', 'net_cls', 'net_prio', 'perf_event', 'pids', 'rdma', 'dmem']);
const GROUP_NAMES = new Set(['system.slice', 'user.slice', 'machine.slice', 'docker', 'kubepods', 'kubepods.slice', 'burstable', 'besteffort', 'init.scope']);
const NAMESPACES = ['cgroup', 'ipc', 'mnt', 'net', 'pid', 'pid_for_children', 'time', 'time_for_children', 'user', 'uts'];
const truncated = () => { throw Object.assign(new Error('Cgroup metadata exceeds limit'), { code: 'EPROBETRUNCATED' }); };

export function parseCgroupMembership(text) {
  if (Buffer.byteLength(text) > 64 * 1024) truncated();
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > 128) truncated();
  return lines.map((line) => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    if (!match || match[3].includes('\0') || match[3].split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid cgroup membership');
    const unified = match[1] === '0';
    if (unified ? match[2] !== '' : !/^(?:[a-z][a-z0-9_]*|name=[a-zA-Z0-9_.-]+)(?:,(?:[a-z][a-z0-9_]*|name=[a-zA-Z0-9_.-]+))*$/.test(match[2])) throw new Error('Invalid cgroup controllers');
    const parts = match[3].split('/').filter(Boolean);
    if (parts.length > 128) truncated();
    return { version: unified ? 'v2' : 'v1',
      controllers: match[2].split(',').filter((name) => CONTROLLERS.has(name)),
      template: '/' + parts.map((part) => GROUP_NAMES.has(part) ? part : '<group>').join('/') };
  });
}

export function createContainerProbes({ runtime = process, platform = process.platform,
  statFile = stat, lstatFile = lstat, readFile = readBoundedFile } = {}) {
  const key = Symbol('container-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  const linux = (run) => (ctx) => platform === 'linux' ? run(ctx) : result(null, 'unsupported');
  const read = (file, ctx, limit = 64 * 1024) => cached(ctx, `read:${file}`, async () => {
    ctx.signal?.throwIfAborted();
    return readFile(file, { signal: ctx.signal, limit });
  });
  const memberships = (ctx) => cached(ctx, 'memberships', async () => parseCgroupMembership(await read('/proc/self/cgroup', ctx)));
  const inspect = async (file, ctx, method = statFile) => {
    ctx.signal?.throwIfAborted();
    try { return await method(file); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  };
  const marker = (file) => linux(async (ctx) => result(Boolean((await inspect(file, ctx))?.isFile())));
  return [
    { name: 'Docker marker-file presence', run: marker('/.dockerenv') },
    { name: 'Podman container marker-file presence', run: marker('/run/.containerenv') },
    { name: 'Container environment-variable presence', run: () => {
      const keys = Object.keys(runtime.env ?? {});
      const names = platform === 'win32' ? keys.map((name) => name.toUpperCase()) : keys;
      return result(['container', 'CONTAINER', 'KUBERNETES_SERVICE_HOST'].some((name) => names.includes(platform === 'win32' ? name.toUpperCase() : name)));
    } },
    { name: 'Cgroup version', run: linux(async (ctx) => {
      const versions = new Set((await memberships(ctx)).map((row) => row.version));
      return versions.size ? result(versions.size === 2 ? 'hybrid' : [...versions][0]) : result(null, 'absent');
    }) },
    { name: 'Cgroup controller list', run: linux(async (ctx) => {
      const rows = await memberships(ctx);
      if (!rows.length) return result(null, 'absent');
      const controllers = new Set(rows.flatMap((row) => row.controllers));
      if (rows.some((row) => row.version === 'v2')) {
        // Reuse mount-aware resolution, including hybrid and cgroup namespace roots.
        const location = resolveCgroup(await read('/proc/self/cgroup', ctx), await read('/proc/self/mountinfo', ctx, 1024 * 1024), '');
        if (!location) return result(null, 'absent');
        const text = await read(path.join(location.directory, 'cgroup.controllers'), ctx);
        for (const name of text.trim().split(/\s+/).filter(Boolean)) {
          if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid controller name');
          if (CONTROLLERS.has(name)) controllers.add(name);
        }
      }
      return result([...controllers].sort());
    }) },
    { name: 'Cgroup path normalized template', run: linux(async (ctx) => {
      const rows = await memberships(ctx);
      return rows.length ? result([...new Set(rows.map((row) => row.template))]) : result(null, 'absent');
    }) },
    { name: 'Visible namespace type list', run: linux(async (ctx) => {
      if (!(await inspect('/proc/self/ns', ctx))?.isDirectory()) return result(null, 'absent');
      const types = new Set();
      for (const name of NAMESPACES) {
        // Only lstat metadata, never readlink targets or namespace inode identifiers.
        if ((await inspect(`/proc/self/ns/${name}`, ctx, lstatFile))?.isSymbolicLink()) types.add(name.replace(/_for_children$/, ''));
      }
      return result([...types].sort());
    }) },
  ];
}
