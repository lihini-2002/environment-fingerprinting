import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBoundedFile } from './os-release.js';
import { result } from '../result.js';

const exec = promisify(execFile);
export const CPUINFO_LIMIT = 1024 * 1024;
const missing = () => result(null, 'absent');
const unsupported = () => result(null, 'unsupported');
const unique = (values) => [...new Set(values)].sort();
const normalize = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

export function parseCPUInfo(text) {
  return text.split(/\r?\n\s*\r?\n/).map((block) => {
    const fields = Object.create(null);
    for (const line of block.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon !== -1) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return fields;
  }).filter((fields) => /^\d+$/.test(fields.processor ?? ''));
}

export function vendorFromModel(model) {
  for (const vendor of ['Intel', 'AMD', 'Apple', 'Qualcomm', 'IBM', 'NVIDIA']) {
    if (new RegExp(`\\b${vendor}\\b`, 'i').test(model)) return vendor;
  }
  return null;
}

export async function macPhysicalCores({ signal, runCommand = exec } = {}) {
  let stdout;
  try {
    ({ stdout } = await runCommand('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu'], {
      encoding: 'utf8', signal, timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096,
      env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    // sysctl can start successfully but fail its kernel query with exit code 1.
    if (typeof error.code === 'number' && /Operation not permitted|Permission denied/.test(error.stderr ?? '')) {
      throw Object.assign(new Error('Physical core query denied'), { code: 'EPERM' });
    }
    if (typeof error.code === 'number' && /unknown oid|No such file or directory/.test(error.stderr ?? '')) {
      throw Object.assign(new Error('Physical core count unavailable'), { code: 'ENOENT' });
    }
    throw error;
  }
  const raw = stdout.trim();
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('Invalid physical core count');
  }
  return count;
}

export function createCPUProbes({
  system = os, platform = process.platform, readFile = readBoundedFile,
  physicalCores = macPhysicalCores,
} = {}) {
  // Symbols prevent collisions between independently configured probe sets.
  const cpusKey = Symbol('cpus');
  const infoKey = Symbol('cpuinfo');
  const cached = (context, key, operation) => {
    if (!context.cache) return operation();
    if (!context.cache.has(key)) context.cache.set(key, Promise.resolve().then(operation));
    return context.cache.get(key);
  };
  const cpus = (context) => cached(context, cpusKey, () => {
    if (typeof system.cpus !== 'function') throw Object.assign(new Error(), { code: 'ENOSYS' });
    const data = system.cpus();
    if (!Array.isArray(data)) throw new Error('Invalid CPU metadata');
    return data;
  });
  const info = (context) => cached(context, infoKey, async () => parseCPUInfo(
    await readFile('/proc/cpuinfo', { signal: context.signal, limit: CPUINFO_LIMIT }),
  ));
  const modelValues = async (context) => (await cpus(context)).map((cpu) => normalize(cpu.model));
  const linuxOnly = (run) => (context) => platform === 'linux' ? run(context) : unsupported();
  async function flagSets(context) {
    const records = await info(context);
    if (!records.length) return null;
    const sets = records.map((record) => record.flags ?? record.features);
    // An omitted or empty flags field must not be treated as negative evidence.
    if (sets.some((flags) => !flags?.trim())) return null;
    return sets.map((flags) => new Set(flags.toLowerCase().split(/\s+/)));
  }
  return [
    { name: 'CPU vendor', async run(context) {
      const vendors = (await modelValues(context)).map(vendorFromModel);
      return !vendors.length || vendors.some((v) => !v) ? missing() : result(unique(vendors));
    } },
    { name: 'CPU model', async run(context) {
      const models = await modelValues(context);
      return !models.length || models.some((v) => !v) ? missing() : result(unique(models));
    } },
    { name: 'Reported logical CPU count', async run(context) {
      const count = (await cpus(context)).length;
      return count ? result(count) : missing();
    } },
    { name: 'Physical CPU core count when exposed', async run(context) {
      if (platform === 'darwin') return result(await physicalCores(context));
      if (platform !== 'linux') return unsupported();
      const records = await info(context);
      if (!records.length || records.some((r) =>
        !/^\d+$/.test(r['physical id'] ?? '') || !/^\d+$/.test(r['core id'] ?? ''))) return missing();
      return result(new Set(records.map((r) => `${r['physical id']}:${r['core id']}`)).size);
    } },
    { name: 'Process-available parallelism', run() {
      if (typeof system.availableParallelism !== 'function') return unsupported();
      const count = system.availableParallelism();
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid parallelism');
      return result(count);
    } },
    { name: 'CPU affinity mask', run: linuxOnly(async (context) => {
      const text = await readFile('/proc/self/status', { signal: context.signal, limit: 64 * 1024 });
      const raw = /^Cpus_allowed_list:[ \t]*(.*)$/m.exec(text)?.[1].trim();
      if (!raw) return missing();
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) throw new Error('Invalid CPU list');
      let previous = -1;
      for (const part of raw.split(',')) {
        const [start, end = start] = part.split('-').map(Number);
        if (!Number.isSafeInteger(end) || start <= previous || end < start) throw new Error('Invalid CPU range');
        previous = end;
      }
      return result(raw);
    }) },
    { name: 'CPU nominal clock speed', async run(context) {
      const speeds = (await cpus(context)).map((cpu) => cpu.speed);
      return !speeds.length || speeds.some((speed) => !Number.isFinite(speed) || speed <= 0)
        ? missing() : result([...new Set(speeds)].sort((a, b) => a - b));
    } },
    { name: 'CPU hypervisor flag presence', run: linuxOnly(async (context) => {
      const records = await info(context);
      // The hypervisor bit is an x86 flags convention; ARM Features cannot establish false.
      if (!records.length || records.some((r) => !r.flags?.trim())) return missing();
      return result(records.some((r) => r.flags.split(/\s+/).includes('hypervisor')));
    }) },
    { name: 'CPU instruction-set flags', run: linuxOnly(async (context) => {
      const sets = await flagSets(context);
      if (!sets) return missing();
      return result([...sets[0]].filter((flag) => sets.every((set) => set.has(flag))).sort());
    }) },
  ];
}
