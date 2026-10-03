import process from 'node:process';
import { posix as path } from 'node:path';
import { opendir, readlink } from 'node:fs/promises';
import { readBoundedFile } from './os-release.js';
import { result, statusFromError } from '../result.js';

export const PROCESS_ENTRY_LIMIT = 1024;
export const PROCESS_ANCESTOR_LIMIT = 16;
export const ANALYSIS_EXECUTABLES = Object.freeze(['bpftrace', 'gdb', 'lldb', 'ltrace', 'perf', 'rr', 'strace', 'sysdig', 'tcpdump', 'tshark', 'valgrind']);
const tooLarge = () => { throw Object.assign(new Error('Process source exceeds limit'), { code: 'EPROBETRUNCATED' }); };
const missing = () => result(null, 'absent');
function pidValue(raw) {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) throw new Error('Invalid PID');
  return Number(raw);
}

export function createProcessStateProbes({ platform = process.platform, readFile = readBoundedFile,
  readLink = readlink, openDirectory = opendir,
  entryLimit = PROCESS_ENTRY_LIMIT, ancestorLimit = PROCESS_ANCESTOR_LIMIT } = {}) {
  if (!Number.isInteger(entryLimit) || entryLimit < 1 || entryLimit > PROCESS_ENTRY_LIMIT ||
      !Number.isInteger(ancestorLimit) || ancestorLimit < 1 || ancestorLimit > PROCESS_ANCESTOR_LIMIT) throw new TypeError('Invalid process bounds');
  const key = Symbol('process-state');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  const linux = (run) => (ctx) => platform === 'linux' ? run(ctx) : result(null, 'unsupported');
  const read = async (file, ctx, limit) => {
    ctx.signal?.throwIfAborted();
    const text = await readFile(file, { signal: ctx.signal, limit });
    ctx.signal?.throwIfAborted();
    if (Buffer.byteLength(text) > limit) tooLarge();
    return text;
  };
  const status = (pid, ctx) => cached(ctx, `status:${pid}`, async () => {
    const text = await read(`/proc/${pid}/status`, ctx, 64 * 1024);
    const fields = new Map();
    for (const line of text.split('\n')) {
      const match = /^(PPid|NSpid|TracerPid|Seccomp|NoNewPrivs|CapEff):\s*(.*?)\s*$/.exec(line);
      if (match) fields.set(match[1], fields.has(match[1]) ? null : match[2]);
    }
    return fields;
  });
  const field = async (pid, name, ctx) => {
    const fields = await status(pid, ctx);
    if (!fields.has(name)) return undefined;
    const value = fields.get(name);
    if (value === null || value === '') throw new Error('Invalid process status field');
    return value;
  };
  const parent = async (pid, ctx) => {
    const raw = await field(pid, 'PPid', ctx);
    if (raw === undefined) throw Object.assign(new Error('Parent unavailable'), { code: 'ENOENT' });
    return pidValue(raw);
  };
  const basename = (pid, ctx) => cached(ctx, `basename:${pid}`, async () => {
    ctx.signal?.throwIfAborted();
    let target;
    try { target = await readLink(`/proc/${pid}/exe`); } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      const comm = (await read(`/proc/${pid}/comm`, ctx, 256)).replace(/\n$/, '');
      if (!comm) return missing();
      if (comm.includes('\0') || comm.includes('\n') || comm.includes('/')) throw new Error('Invalid comm basename');
      // comm is mutable and kernel-truncated to 15 bytes; do not claim a full name at that boundary.
      return result(comm, Buffer.byteLength(comm) >= 15 ? 'truncated' : 'ok');
    }
    ctx.signal?.throwIfAborted();
    if (typeof target !== 'string' || !target.startsWith('/') || target.includes('\0')) throw new Error('Invalid executable link');
    if (Buffer.byteLength(target) > 4096) tooLarge();
    const name = path.basename(target.replace(/ \(deleted\)$/, ''));
    return name ? result(name) : missing();
  });
  const processes = (ctx) => cached(ctx, 'processes', async () => {
    ctx.signal?.throwIfAborted();
    const handle = await openDirectory('/proc', { bufferSize: 1 });
    const pids = [];
    try {
      for (let scanned = 0; scanned < entryLimit; scanned++) {
        ctx.signal?.throwIfAborted();
        const entry = await handle.read();
        ctx.signal?.throwIfAborted();
        if (!entry) return { pids, complete: true };
        if (/^[1-9]\d*$/.test(entry.name) && entry.isDirectory()) pids.push(pidValue(entry.name));
      }
      return { pids, complete: false };
    } finally { await handle.close(); }
  });
  return [
    { name: 'PID namespace nesting depth when exposed', run: linux(async (ctx) => {
      const raw = await field('self', 'NSpid', ctx);
      if (raw === undefined) return missing();
      const pids = raw.split(/\s+/);
      if (pids.length > 32) tooLarge();
      if (pids.some((pid) => pidValue(pid) === 0)) throw new Error('Invalid namespace PID');
      return result(pids.length - 1);
    }) },
    { name: 'PID 1 executable basename', run: linux((ctx) => basename(1, ctx)) },
    { name: 'Visible process count', run: linux(async (ctx) => {
      const data = await processes(ctx);
      return data.complete ? result(data.pids.length) : result(null, 'truncated');
    }) },
    { name: 'Parent process executable basename', run: linux(async (ctx) => {
      const pid = await parent('self', ctx);
      return pid ? basename(pid, ctx) : missing();
    }) },
    { name: 'Bounded ancestor-process executable basename sequence', run: linux(async (ctx) => {
      const sequence = [];
      const seen = new Set();
      try {
        let pid = await parent('self', ctx);
        while (pid) {
          ctx.signal?.throwIfAborted();
          if (seen.has(pid)) return result(sequence, 'error');
          if (sequence.length === ancestorLimit) return result(sequence, 'truncated');
          seen.add(pid);
          const name = await basename(pid, ctx);
          if (name.value !== null) sequence.push(name.value);
          if (name.status !== 'ok') return result(sequence, name.status);
          pid = await parent(pid, ctx);
        }
        return result(sequence);
      } catch (error) { return result(sequence.length ? sequence : null, statusFromError(error)); }
    }) },
    { name: 'Process executable allowlist matches for analysis tooling', run: linux(async (ctx) => {
      const data = await processes(ctx);
      const matches = new Set();
      let failure = data.complete ? null : 'truncated';
      for (const pid of data.pids) {
        ctx.signal?.throwIfAborted();
        try {
          const name = await basename(pid, ctx);
          if (name.status !== 'ok') failure ??= name.status;
          else if (ANALYSIS_EXECUTABLES.includes(name.value)) matches.add(name.value);
        } catch (error) {
          ctx.signal?.throwIfAborted();
          failure ??= statusFromError(error);
        }
      }
      return result([...matches].sort(), failure ?? 'ok');
    }) },
    { name: 'Own process tracer status', run: linux(async (ctx) => {
      const raw = await field('self', 'TracerPid', ctx);
      return raw === undefined ? missing() : result(pidValue(raw) !== 0);
    }) },
    { name: 'Own process NoNewPrivs status', run: linux(async (ctx) => {
      const raw = await field('self', 'NoNewPrivs', ctx);
      if (raw === undefined) return missing();
      if (!/^[01]$/.test(raw)) throw new Error('Invalid NoNewPrivs status');
      return result(raw === '1');
    }) },
    { name: 'Own process effective capability mask', run: linux(async (ctx) => {
      const raw = await field('self', 'CapEff', ctx);
      if (raw === undefined) return missing();
      if (!/^[0-9a-fA-F]{1,16}$/.test(raw)) throw new Error('Invalid effective capability mask');
      // Preserve all 64 bits without JavaScript number precision loss.
      return result(raw.toLowerCase().padStart(16, '0'));
    }) },
    { name: 'Own process seccomp mode', run: linux(async (ctx) => {
      const raw = await field('self', 'Seccomp', ctx);
      if (raw === undefined) return missing();
      if (!/^[012]$/.test(raw)) throw new Error('Invalid seccomp mode');
      return result(Number(raw));
    }) },
  ];
}
