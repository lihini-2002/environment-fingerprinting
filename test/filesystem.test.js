import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { statfs, mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { collectEnvironment, createFilesystemProbes } from '../src/index.js';

const total = 'Working-filesystem total bytes';
const available = 'Working-filesystem available bytes';
const inodes = 'Working-filesystem inode capacity';
const type = 'Working-filesystem type';
const fixture = { type: 0xef53n, bsize: 4096n, blocks: 100n, bavail: 30n, bfree: 40n, files: 200n, ffree: 75n };
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createFilesystemProbes({ platform: 'linux', runtime: { cwd: () => '/private/work' },
    system: { homedir: () => '/private/home', tmpdir: () => '/private/tmp' },
    statFilesystem: async () => fixture, approvedTempDirectory: null, readFile: async () => mountTable, ...options }), timeoutMs,
})).properties;

test('filesystem types and capacities sample each location once without exposing paths', async () => {
  const calls = [];
  const p = await collect({ statFilesystem: async (name, options) => {
    calls.push(name); assert.deepEqual(options, { bigint: true });
    return { ...fixture, type: name.endsWith('/home') ? 0x9123683en : name.endsWith('/tmp') ? 0x01021994n : fixture.type };
  } });
  assert.deepEqual(calls, ['/private/work', '/private/home', '/private/tmp']);
  assert.equal(p[type].value, 'ext');
  assert.equal(p['Home-filesystem type'].value, 'btrfs');
  assert.equal(p['Temporary-filesystem type'].value, 'tmpfs');
  assert.equal(p[total].value, 409600);
  assert.equal(p[available].value, 122880);
  assert.equal(p[inodes].value, 200);
  assert.ok(!JSON.stringify(p).includes('/private'));
});

test('large capacities are exact decimal strings and zero remains valid', async () => {
  const p = await collect({ statFilesystem: async () => ({ ...fixture, blocks: 9007199254740993n, files: 9007199254740993n, bavail: 0n }) });
  assert.equal(p[total].value, (9007199254740993n * 4096n).toString());
  assert.equal(p[inodes].value, '9007199254740993');
  assert.equal(p[available].value, 0);
  const zero = await collect({ statFilesystem: async () => ({ ...fixture, files: 0n, blocks: 0n }) });
  assert.equal(zero[inodes].value, 0);
  assert.equal(zero[total].value, 0);
});

test('platform identifiers and unsupported placeholders do not invent filesystem names', async () => {
  for (const [platform, id, expected] of [['linux', 0x1234n, 'linux:0x1234'], ['darwin', 26n, 'darwin:0x1a'], ['linux', -1859950530n, 'btrfs']]) {
    const p = await collect({ platform, statFilesystem: async () => ({ ...fixture, type: id }) });
    assert.equal(p[type].value, expected);
  }
  const win = await collect({ platform: 'win32', runtime: { cwd: () => 'C:\\private' }, statFilesystem: async () => ({ ...fixture, type: 0n, files: 0n }) });
  assert.equal(win[type].status, 'unsupported');
  assert.equal(win[inodes].status, 'unsupported');
  assert.equal(win[total].value, 409600);
  const zero = await collect({ statFilesystem: async () => ({ ...fixture, type: 0n }) });
  assert.equal(zero[type].status, 'unsupported');
  for (const files of [-1n, 0xffffffffffffffffn]) {
    const p = await collect({ statFilesystem: async () => ({ ...fixture, files }) });
    assert.equal(p[inodes].status, 'unsupported');
  }
});

test('invalid fields and inaccessible paths remain independent', async () => {
  const p = await collect({ statFilesystem: async (name) => {
    if (name.endsWith('/home')) throw Object.assign(new Error('private'), { code: 'EACCES' });
    return { ...fixture, blocks: Number.MAX_SAFE_INTEGER + 1, files: -2n };
  } });
  assert.equal(p[type].value, 'ext');
  assert.equal(p[total].status, 'error');
  assert.equal(p[inodes].status, 'error');
  assert.equal(p[available].value, 122880);
  assert.equal(p['Home-filesystem type'].status, 'permission_denied');
  const invalid = await collect({ runtime: { cwd: () => 'relative' } });
  assert.equal(invalid[total].status, 'error');
  assert.equal(invalid['Home-filesystem type'].value, 'ext');
  const huge = await collect({ runtime: { cwd: () => '/' + 'a'.repeat(65536) } });
  assert.equal(huge[type].status, 'truncated');
});

test('missing APIs, files and timeouts retain statuses', async () => {
  const unavailable = await collect({ statFilesystem: null });
  assert.equal(unavailable[total].status, 'unsupported');
  const missing = await collect({ statFilesystem: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  assert.equal(missing[type].status, 'absent');
  const timed = await collect({ statFilesystem: async () => new Promise(() => {}) }, 5);
  assert.equal(timed[type].status, 'timeout');
  assert.equal(timed[total].status, 'timeout');
});

test('same path shares a sample and fresh collections refresh it', async () => {
  let calls = 0;
  const probes = createFilesystemProbes({ platform: 'linux', runtime: { cwd: () => '/same' }, system: { homedir: () => '/same', tmpdir: () => '/same' },
    statFilesystem: async () => { calls++; return { ...fixture, blocks: BigInt(calls) }; },
  });
  const first = await collectEnvironment({ probes });
  const second = await collectEnvironment({ probes });
  assert.equal(calls, 2);
  assert.equal(first.properties[total].value, 4096);
  assert.equal(second.properties[total].value, 8192);
});

test('native statfs smoke test reports the real temporary filesystem', async () => {
  const root = os.tmpdir();
  const native = await statfs(root, { bigint: true });
  const p = (await collectEnvironment({ probes: createFilesystemProbes({ runtime: { cwd: () => root } }) })).properties;
  const expected = native.blocks * native.bsize;
  assert.deepEqual(p[total], { value: expected <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expected) : expected.toString(), status: 'ok' });
});

const freeInodes = 'Working-filesystem available inode count';
const rootReadOnly = 'Root filesystem read-only mount status';
const overlay = 'Overlay filesystem mount presence';
const tmpfs = 'Tmpfs mount count';
const mountCount = 'Visible mount count';
const creation = 'Approved temporary-directory file-creation success';
const deletion = 'Approved temporary-directory file-deletion success';
const mountTable = '1 0 8:1 / / rw,relatime shared:1 - ext4 /dev/root rw\n' +
  '2 1 0:2 / /tmp rw - tmpfs tmpfs rw\n' +
  '3 1 0:3 / /private\\040path ro - overlay overlay rw,lowerdir=/private/lower\n';

test('available inode counts preserve exact values, sentinels and invalid statuses', async () => {
  for (const [ffree, expected] of [[75n, 75], [0n, 0], [9007199254740993n, '9007199254740993']]) {
    assert.deepEqual((await collect({ statFilesystem: async () => ({ ...fixture, ffree }) }))[freeInodes], { value: expected, status: 'ok' });
  }
  for (const ffree of [undefined, null, -1n, 0xffffffffffffffffn]) {
    assert.equal((await collect({ statFilesystem: async () => ({ ...fixture, ffree }) }))[freeInodes].status, 'unsupported');
  }
  assert.equal((await collect({ statFilesystem: async () => ({ ...fixture, ffree: -2n }) }))[freeInodes].status, 'error');
  assert.equal((await collect({ platform: 'win32' }))[freeInodes].status, 'unsupported');
});

test('mount observations share a bounded read and expose only counts and booleans', async () => {
  let reads = 0;
  const p = await collect({ readFile: async (file, options) => {
    reads++;
    assert.equal(file, '/proc/self/mountinfo');
    assert.equal(options.limit, 1024 * 1024);
    return mountTable;
  } });
  assert.equal(reads, 1);
  assert.equal(p[rootReadOnly].value, false);
  assert.equal(p[overlay].value, true);
  assert.equal(p[tmpfs].value, 1);
  assert.equal(p[mountCount].value, 3);
  assert.ok(!JSON.stringify(p).includes('/private'));
  const ro = await collect({ readFile: async () => '1 0 8:1 / / rw - ext4 /dev/root ro\n' });
  assert.equal(ro[rootReadOnly].value, true);
  assert.equal(ro[overlay].value, false);
  assert.equal(ro[tmpfs].value, 0);
});

test('mount failures, limits, missing roots and unsupported platforms stay explicit', async () => {
  for (const [text, status] of [['', 'absent'], ['invalid', 'error'], ['x'.repeat(1024 * 1024 + 1), 'truncated'], [mountTable.repeat(1366), 'truncated']]) {
    const p = await collect({ readFile: async () => text });
    for (const name of [rootReadOnly, overlay, tmpfs, mountCount]) assert.equal(p[name].status, status);
  }
  for (const [code, status] of [['ENOENT', 'absent'], ['EACCES', 'permission_denied']]) {
    assert.equal((await collect({ readFile: async () => { throw Object.assign(new Error(), { code }); } }))[mountCount].status, status);
  }
  assert.equal((await collect({ readFile: async () => '1 0 8:1 / /other rw - ext4 root rw\n' }))[rootReadOnly].status, 'absent');
  assert.equal((await collect({ readFile: async () => mountTable + '4 1 0:4 / / ro - overlay overlay rw\n' }))[rootReadOnly].value, true);
  assert.equal((await collect({ readFile: async () => mountTable + mountTable }))[mountCount].status, 'error');
  const p = await collect({ platform: 'darwin', readFile: async () => assert.fail('must not read proc') });
  assert.equal(p[mountCount].status, 'unsupported');
});

test('temporary check creates exclusively, closes and deletes exactly once per collection', async () => {
  const calls = [];
  const options = { approvedTempDirectory: '/approved', openFile: async (file, flags, mode) => {
    calls.push(['open', file]); assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
    assert.match(file, /^\/approved\/npm-probe-[a-f0-9-]+\.tmp$/);
    return { close: async () => { calls.push(['close']); } };
  }, deleteFile: async (file) => { calls.push(['delete', file]); } };
  const p = await collect(options);
  assert.deepEqual(p[creation], { value: true, status: 'ok' });
  assert.deepEqual(p[deletion], { value: true, status: 'ok' });
  assert.deepEqual(calls.map(([op]) => op), ['open', 'close', 'delete']);
  assert.equal(calls[0][1], calls[2][1]);
  await collect(options);
  assert.notEqual(calls[0][1], calls[3][1]);
});

test('temporary failures never delete unowned files and cleanup survives close failure', async () => {
  const p = await collect({ approvedTempDirectory: '/approved', openFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); }, deleteFile: async () => assert.fail('unowned file') });
  assert.equal(p[creation].status, 'permission_denied');
  assert.equal(p[deletion].status, 'absent');
  const failedDelete = await collect({ approvedTempDirectory: '/approved', openFile: async () => ({ close: async () => {} }), deleteFile: async () => { throw Object.assign(new Error(), { code: 'EPERM' }); } });
  assert.equal(failedDelete[creation].value, true);
  assert.equal(failedDelete[deletion].status, 'permission_denied');
  let removed = false;
  await collect({ approvedTempDirectory: '/approved', openFile: async () => ({ close: async () => { throw new Error(); } }), deleteFile: async () => { removed = true; } });
  assert.equal(removed, true);
  const disabled = await collect({ openFile: async () => assert.fail('disabled') });
  assert.equal(disabled[creation].status, 'disabled');
  assert.equal((await collect({ approvedTempDirectory: 'relative' }))[creation].status, 'error');
});

test('late temporary open still closes and deletes after cancellation', async () => {
  let finishOpen;
  let closed = false;
  let deleted = false;
  const probes = createFilesystemProbes({ approvedTempDirectory: '/approved', openFile: () => new Promise((resolve) => { finishOpen = resolve; }), deleteFile: async () => { deleted = true; } });
  const probe = probes.find((item) => item.name === creation);
  const controller = new AbortController();
  const pending = probe.run({ signal: controller.signal, cache: new Map() });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finishOpen({ close: async () => { closed = true; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closed, true);
  assert.equal(deleted, true);
});

test('native temporary create/delete leaves the approved directory empty', async () => {
  const directory = await mkdtemp(os.tmpdir() + '/npm-probe-test-');
  try {
    const p = await collect({ approvedTempDirectory: directory });
    assert.equal(p[creation].value, true);
    assert.equal(p[deletion].value, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rmdir(directory); }
});
