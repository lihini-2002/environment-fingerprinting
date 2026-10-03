import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export const OS_RELEASE_LIMIT = 64 * 1024;

export async function readBoundedFile(path, { signal, limit = OS_RELEASE_LIMIT } = {}) {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    signal?.throwIfAborted();
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'ENOTSUP' });
    if (info.size > limit) {
      throw Object.assign(new Error('OS release file exceeds limit'), { code: 'EPROBETRUNCATED' });
    }
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) {
      throw Object.assign(new Error('OS release file exceeds limit'), { code: 'EPROBETRUNCATED' });
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    await file.close();
  }
}

// Never source this file or expand shell expressions.
export function parseOSRelease(text) {
  const fields = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new SyntaxError('Invalid os-release assignment');
    const [, key, raw] = match;
    let value;
    if (raw.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new SyntaxError('Invalid double-quoted value');
      value = raw.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    } else if (raw.startsWith("'")) {
      if (!/^'[^']*'$/.test(raw)) throw new SyntaxError('Invalid single-quoted value');
      value = raw.slice(1, -1);
    } else {
      if (!/^(?:[^\s'"\\]|\\.)*$/.test(raw)) throw new SyntaxError('Invalid unquoted value');
      value = raw.replace(/\\(.)/g, '$1');
    }
    fields[key] = value;
  }
  return fields;
}

export async function readOSRelease({ signal, readFile = readBoundedFile } = {}) {
  try {
    return parseOSRelease(await readFile('/etc/os-release', { signal }));
  } catch (error) {
    // /etc overrides /usr/lib; do not merge fields or mask permission errors.
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  return parseOSRelease(await readFile('/usr/lib/os-release', { signal }));
}
