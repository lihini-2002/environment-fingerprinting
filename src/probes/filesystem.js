import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { statfs, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readBoundedFile } from './os-release.js';
import { result, statusFromError } from '../result.js';

const MOUNT_LIMIT = 1024 * 1024;
function parseMounts(text) {
  if (Buffer.byteLength(text) > MOUNT_LIMIT) throw Object.assign(new Error('Mount table exceeds limit'), { code: 'EPROBETRUNCATED' });
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > 4096) throw Object.assign(new Error('Too many mounts'), { code: 'EPROBETRUNCATED' });
  const ids = new Set();
  return lines.map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length !== separator + 4 || fields.some((field) => !field || field.includes('\0')) ||
        !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+:\d+$/.test(fields[2]) ||
        !fields[3].startsWith('/') || !fields[4].startsWith('/')) throw new Error('Invalid mountinfo');
    if (ids.has(fields[0])) throw new Error('Duplicate mount ID');
    ids.add(fields[0]);
    const options = fields[5].split(',');
    const superOptions = fields[separator + 3].split(',');
    for (const list of [options, superOptions]) {
      if (list.includes('ro') === list.includes('rw')) throw new Error('Invalid mount access options');
    }
    // Retain only aggregates' inputs; mount sources and private paths are discarded.
    return { id: fields[0], parent: fields[1], root: fields[4] === '/', readOnly: options.includes('ro') || superOptions.includes('ro'), type: fields[separator + 1] };
  });
}

// Linux statfs magic values. ext2, ext3 and ext4 intentionally share one label.
const LINUX_TYPES = new Map([
  [0xef53n, 'ext'], [0x9123683en, 'btrfs'], [0x58465342n, 'xfs'],
  [0x01021994n, 'tmpfs'], [0x794c7630n, 'overlay'], [0x6969n, 'nfs'],
  [0x65735546n, 'fuse'], [0xff534d42n, 'cifs'], [0xfe534d42n, 'smb2'],
  [0x9fa0n, 'proc'], [0x62656572n, 'sysfs'], [0x858458f6n, 'ramfs'],
  [0x73717368n, 'squashfs'], [0x4d44n, 'fat'], [0x5346544en, 'ntfs'],
]);
const unsupported = () => result(null, 'unsupported');
function integer(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error('Invalid filesystem statistic');
}
function unsigned(value) {
  const number = integer(value);
  if (number < 0n || number > 0xffffffffffffffffn) throw new Error('Invalid unsigned filesystem statistic');
  return number;
}
const exact = (number) => result(number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number.toString());

export function createFilesystemProbes({ runtime = process, system = os, platform = process.platform, statFilesystem = statfs,
  readFile = readBoundedFile, openFile = open, deleteFile = unlink, approvedTempDirectory,
} = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const key = Symbol('filesystem-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  const location = (kind, ctx) => cached(ctx, `location:${kind}`, () => {
    const target = kind === 'working' ? runtime : system;
    const method = { working: 'cwd', home: 'homedir', temporary: 'tmpdir' }[kind];
    if (typeof target[method] !== 'function') throw Object.assign(new Error('Path API unavailable'), { code: 'ENOSYS' });
    const raw = target[method]();
    if (typeof raw !== 'string' || !api.isAbsolute(raw) || raw.includes('\0')) throw new Error('Invalid filesystem path');
    if (raw.length > 65536) throw Object.assign(new Error('Path exceeds limit'), { code: 'EPROBETRUNCATED' });
    // Keep the original path: lexical removal of '..' can change symlink semantics.
    return raw;
  });
  const sample = async (kind, ctx) => {
    const directory = await location(kind, ctx);
    return cached(ctx, `statfs:${directory}`, async () => {
      ctx.signal?.throwIfAborted();
      if (typeof statFilesystem !== 'function') throw Object.assign(new Error('statfs unavailable'), { code: 'ENOSYS' });
      const info = await statFilesystem(directory, { bigint: true });
      ctx.signal?.throwIfAborted();
      return info;
    });
  };
  const type = (kind) => async (ctx) => {
    // libuv returns placeholder zero for Windows filesystem type.
    if (platform === 'win32') return unsupported();
    const info = await sample(kind, ctx);
    if (info.type === undefined || info.type === null) return unsupported();
    let id = integer(info.type);
    // Linux magic may be sign-extended by a 32-bit signed native field.
    if (platform === 'linux' && id < 0n && id >= -0x80000000n) id = BigInt.asUintN(32, id);
    if (id < 0n || id > 0xffffffffffffffffn) throw new Error('Invalid filesystem type');
    if (id === 0n) return unsupported();
    return result((platform === 'linux' ? LINUX_TYPES.get(id) : undefined) ?? `${platform}:0x${id.toString(16)}`);
  };
  const bytes = (field) => async (ctx) => {
    const info = await sample('working', ctx);
    if (info[field] === undefined || info.bsize === undefined) return unsupported();
    const blocks = unsigned(info[field]);
    const size = unsigned(info.bsize);
    if (size === 0n) throw new Error('Invalid filesystem block size');
    return exact(blocks * size);
  };
  const inodeCount = (field) => async (ctx) => {
    if (platform === 'win32') return unsupported();
    const info = await sample('working', ctx);
    if (info[field] === undefined || info[field] === null) return unsupported();
    const count = integer(info[field]);
    if (count === -1n || count === 0xffffffffffffffffn) return unsupported();
    return exact(unsigned(count));
  };
  const mounts = (observe) => async (ctx) => {
    if (platform !== 'linux') return unsupported();
    const rows = await cached(ctx, 'mounts', async () => {
      ctx.signal?.throwIfAborted();
      const text = await readFile('/proc/self/mountinfo', { signal: ctx.signal, limit: MOUNT_LIMIT });
      ctx.signal?.throwIfAborted();
      return parseMounts(text);
    });
    return rows.length ? observe(rows) : result(null, 'absent');
  };
  const temporaryCheck = (ctx) => cached(ctx, 'temporary-check', async () => {
    if (approvedTempDirectory === null) return { creation: result(null, 'disabled'), deletion: result(null, 'disabled') };
    const directory = approvedTempDirectory === undefined ? await location('temporary', ctx) : approvedTempDirectory;
    if (typeof directory !== 'string' || !api.isAbsolute(directory) || directory.includes('\0')) throw new Error('Invalid approved temporary directory');
    if (directory.length > 65536) throw Object.assign(new Error('Path exceeds limit'), { code: 'EPROBETRUNCATED' });
    // Concatenation preserves symlink/.. resolution in the approved directory.
    const file = directory + api.sep + `npm-probe-${randomUUID()}.tmp`;
    let handle;
    let creation;
    let deletion = result(null, 'absent');
    try {
      ctx.signal?.throwIfAborted();
      handle = await openFile(file, 'wx', 0o600);
      creation = result(true);
    } catch (error) {
      creation = result(null, statusFromError(error));
    } finally {
      if (handle) {
        // Cleanup must still run when an in-flight open completes after timeout.
        try { await handle.close(); } catch (error) { creation = result(null, statusFromError(error)); }
        try { await deleteFile(file); deletion = result(true); }
        catch (error) { deletion = result(null, statusFromError(error)); }
      }
    }
    ctx.signal?.throwIfAborted();
    return { creation, deletion };
  });
  return [
    { name: 'Working-filesystem type', run: type('working') },
    { name: 'Home-filesystem type', run: type('home') },
    { name: 'Temporary-filesystem type', run: type('temporary') },
    { name: 'Working-filesystem total bytes', run: bytes('blocks') },
    { name: 'Working-filesystem available bytes', run: bytes('bavail') },
    { name: 'Working-filesystem inode capacity', run: inodeCount('files') },
    { name: 'Working-filesystem available inode count', run: inodeCount('ffree') },
    { name: 'Root filesystem read-only mount status', run: mounts((rows) => {
      const roots = rows.filter((row) => row.root);
      // A stacked mount names the mount beneath it as its parent.
      const covered = new Set(roots.filter((row) => row.parent !== row.id).map((row) => row.parent));
      const top = roots.filter((row) => !covered.has(row.id));
      return top.length === 1 ? result(top[0].readOnly) : result(null, roots.length ? 'unsupported' : 'absent');
    }) },
    { name: 'Overlay filesystem mount presence', run: mounts((rows) => result(rows.some((row) => row.type === 'overlay'))) },
    { name: 'Tmpfs mount count', run: mounts((rows) => result(rows.filter((row) => row.type === 'tmpfs').length)) },
    { name: 'Visible mount count', run: mounts((rows) => result(rows.length)) },
    { name: 'Approved temporary-directory file-creation success', run: async (ctx) => (await temporaryCheck(ctx)).creation },
    { name: 'Approved temporary-directory file-deletion success', run: async (ctx) => (await temporaryCheck(ctx)).deletion },
  ];
}
