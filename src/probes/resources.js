import os from 'node:os';
import { posix as path } from 'node:path';
import { readBoundedFile } from './os-release.js';
import { result } from '../result.js';

const absent = () => result(null, 'absent');
const fail = (message) => { throw new Error(message); };

// Keep large kernel counters exact rather than rounding them in JSON.
export function integerValue(raw, multiplier = 1n) {
  if (!/^\d+$/.test(raw)) return fail('Invalid unsigned integer');
  const value = BigInt(raw) * multiplier;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function absolute(raw) {
  if (!raw.startsWith('/') || raw.includes('\0') || raw.split('/').some((p) => p === '..' || p === '.')) {
    return fail('Invalid cgroup path');
  }
  return path.normalize(raw);
}
const unescapeMount = (value) => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function resolveCgroup(membershipText, mountText, controller) {
  const memberships = membershipText.split('\n').filter(Boolean).map((line) => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    if (!match) return fail('Invalid cgroup membership');
    return { version: match[1] === '0' && !match[2] ? 2 : 1,
      controllers: match[2].split(','), location: absolute(match[3]) };
  });
  // A controller bound to v1 is not managed by v2 in a hybrid hierarchy.
  const membership = memberships.find((m) => m.version === 1 && m.controllers.includes(controller))
    ?? memberships.find((m) => m.version === 2);
  if (!membership) return null;
  const mounts = [];
  for (const line of mountText.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = right.split(' ');
    if (fields[0] !== (membership.version === 2 ? 'cgroup2' : 'cgroup')) continue;
    if (membership.version === 1 && !fields[2]?.split(',').includes(controller)) continue;
    const parts = left.split(' ');
    if (parts.length < 6) return fail('Invalid cgroup mount');
    const root = absolute(unescapeMount(parts[3]));
    const mount = absolute(unescapeMount(parts[4]));
    if (root !== '/' && membership.location !== root && !membership.location.startsWith(`${root}/`)) continue;
    mounts.push({ root, mount });
  }
  // Prefer the most specific exposed bind mount; never assume the host root.
  mounts.sort((a, b) => b.root.length - a.root.length);
  if (!mounts.length) return null;
  const { root, mount } = mounts[0];
  return { version: membership.version, directory: path.join(mount, path.relative(root, membership.location)) };
}

export function parseLimit(text, name, side, units) {
  const line = text.split('\n').find((row) => row.startsWith(`${name} `));
  if (!line) return absent();
  const fields = line.slice(name.length).trim().split(/\s+/);
  if (fields.length !== 3 || fields[2] !== units) return fail('Invalid process limit row');
  const values = fields.slice(0, 2).map((v) => v === 'unlimited' ? 'unlimited' : integerValue(v));
  return result(values[side]);
}

function cpuList(raw) {
  // An exposed empty effective set is valid, unlike a missing file.
  if (raw === '') return raw;
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) return fail('Invalid effective CPU list');
  let previous = -1;
  for (const item of raw.split(',')) {
    const [start, end = start] = item.split('-').map(Number);
    if (!Number.isSafeInteger(end) || start <= previous || end < start) return fail('Invalid effective CPU range');
    previous = end;
  }
  return raw;
}

export function createResourceProbes({ system = os, platform = process.platform, readFile = readBoundedFile } = {}) {
  const key = Symbol('resource-files');
  function read(file, context, limit = 64 * 1024) {
    if (!context.cache) return readFile(file, { signal: context.signal, limit });
    if (!context.cache.has(key)) context.cache.set(key, new Map());
    const files = context.cache.get(key);
    if (!files.has(file)) files.set(file, Promise.resolve().then(() => readFile(file, { signal: context.signal, limit })));
    return files.get(file);
  }
  const linux = (run) => (ctx) => platform === 'linux' ? run(ctx) : result(null, 'unsupported');
  const memory = (method) => () => {
    if (typeof system[method] !== 'function') return result(null, 'unsupported');
    const value = system[method]();
    if (!Number.isSafeInteger(value) || value < 0) return fail('Invalid memory byte count');
    return result(value);
  };
  const swap = (field) => linux(async (ctx) => {
    const text = await read('/proc/meminfo', ctx);
    const line = text.split('\n').find((row) => row.startsWith(`${field}:`));
    if (!line) return absent();
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB\\s*$`).exec(line);
    if (!match) return fail('Invalid swap field');
    return result(integerValue(match[1], 1024n));
  });
  const limit = (name, side, units) => linux(async (ctx) => parseLimit(await read('/proc/self/limits', ctx), name, side, units));
  function cgroup(controller, v2, v1, parse) {
    return linux(async (ctx) => {
      const membership = await read('/proc/self/cgroup', ctx);
      const mounts = await read('/proc/self/mountinfo', ctx, 1024 * 1024);
      const group = resolveCgroup(membership, mounts, controller);
      if (!group) return absent();
      const raw = (await read(path.join(group.directory, group.version === 2 ? v2 : v1), ctx)).trim();
      return result(parse(raw, group.version));
    });
  }
  const quota = (side) => (raw, version) => {
    if (version === 1) {
      const value = side === 0 && raw === '-1' ? 'unlimited' : integerValue(raw);
      if (value === 0) return fail('Invalid quota or period');
      return value;
    }
    const fields = raw.split(/\s+/);
    if (fields.length !== 2) return fail('Invalid cpu.max');
    const values = [fields[0] === 'max' ? 'unlimited' : integerValue(fields[0]), integerValue(fields[1])];
    if (values[0] === 0 || values[1] === 0) return fail('Invalid quota or period');
    return values[side];
  };
  const maximum = (raw) => raw === 'max' ? 'unlimited' : integerValue(raw);
  return [
    { name: 'Total host-visible memory bytes', run: memory('totalmem') },
    { name: 'Available host-visible memory bytes', run: memory('freemem') },
    { name: 'Total swap bytes', run: swap('SwapTotal') },
    { name: 'Available swap bytes', run: swap('SwapFree') },
    { name: 'Cgroup CPU quota', run: cgroup('cpu', 'cpu.max', 'cpu.cfs_quota_us', quota(0)) },
    { name: 'Cgroup CPU quota period', run: cgroup('cpu', 'cpu.max', 'cpu.cfs_period_us', quota(1)) },
    { name: 'Cgroup effective CPU set', run: cgroup('cpuset', 'cpuset.cpus.effective', 'cpuset.effective_cpus', cpuList) },
    { name: 'Cgroup memory limit bytes', run: cgroup('memory', 'memory.max', 'memory.limit_in_bytes', maximum) },
    { name: 'Cgroup current memory usage bytes', run: cgroup('memory', 'memory.current', 'memory.usage_in_bytes', (raw) => integerValue(raw)) },
    { name: 'Cgroup process-count limit', run: cgroup('pids', 'pids.max', 'pids.max', maximum) },
    { name: 'Cgroup current process count', run: cgroup('pids', 'pids.current', 'pids.current', (raw) => integerValue(raw)) },
    { name: 'Process open-file soft limit', run: limit('Max open files', 0, 'files') },
    { name: 'Process open-file hard limit', run: limit('Max open files', 1, 'files') },
    { name: 'Process address-space limit', run: limit('Max address space', 0, 'bytes') },
    { name: 'Process stack-size limit', run: limit('Max stack size', 0, 'bytes') },
  ];
}
