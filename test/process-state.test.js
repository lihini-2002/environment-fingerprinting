import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createProcessStateProbes } from '../src/index.js';

const names = {
  depth: 'PID namespace nesting depth when exposed', init: 'PID 1 executable basename', count: 'Visible process count',
  parent: 'Parent process executable basename', ancestors: 'Bounded ancestor-process executable basename sequence',
  matches: 'Process executable allowlist matches for analysis tooling', tracer: 'Own process tracer status', seccomp: 'Own process seccomp mode',
  noNewPrivs: 'Own process NoNewPrivs status', capabilities: 'Own process effective capability mask',
};
const absent = () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
const entry = (name, isDirectory = true) => ({ name, isDirectory: () => isDirectory });
function directory(entries, onClose = () => {}) {
  let i = 0;
  return { read: async () => entries[i++] ?? null, close: async () => onClose() };
}
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createProcessStateProbes({ platform: 'linux', readFile: async () => absent(), readLink: async () => absent(),
    openDirectory: async () => directory([]), ...options }), timeoutMs,
})).properties;

test('status fields are sampled once and parsed independently without exposing PIDs', async () => {
  let reads = 0;
  const p = await collect({ readFile: async (file) => {
    assert.equal(file, '/proc/self/status'); reads++;
    return 'PPid:\t0\nNSpid:\t400 20 1\nTracerPid:\t44\nSeccomp:\t2\nCapEff:\tprivate\n';
  } });
  assert.equal(reads, 1);
  assert.equal(p[names.depth].value, 2);
  assert.equal(p[names.tracer].value, true);
  assert.equal(p[names.seccomp].value, 2);
  assert.deepEqual(p[names.ancestors].value, []);
  assert.ok(!JSON.stringify(p).includes('400'));
  for (const mode of [0, 1, 2]) {
    const q = await collect({ readFile: async () => `NSpid: 1\nTracerPid: 0\nSeccomp: ${mode}\n` });
    assert.equal(q[names.depth].value, 0);
    assert.equal(q[names.tracer].value, false);
    assert.equal(q[names.seccomp].value, mode);
  }
  const bad = await collect({ readFile: async () => 'NSpid: 0\nTracerPid: nope\nSeccomp: 2\n' });
  assert.equal(bad[names.depth].status, 'error');
  assert.equal(bad[names.tracer].status, 'error');
  assert.equal(bad[names.seccomp].value, 2);
});

test('basenames, parent order, deleted executables and fixed allowlist matching', async () => {
  const reads = [];
  const links = [];
  const status = { self: 20, 20: 1, 1: 0 };
  const p = await collect({ readFile: async (file) => {
    reads.push(file);
    const pid = file.split('/')[2];
    assert.ok(file.endsWith('/status'));
    return `PPid: ${status[pid]}\n`;
  }, readLink: async (file) => {
    links.push(file);
    return ({ '/proc/1/exe': '/private/init (deleted)', '/proc/20/exe': '/private/bash', '/proc/30/exe': '/private/strace', '/proc/40/exe': '/private/strace-wrapper' })[file] ?? absent();
  }, openDirectory: async () => directory([entry('self', false), entry('1'), entry('20'), entry('30'), entry('40'), entry('99', false)]) });
  assert.equal(p[names.init].value, 'init');
  assert.equal(p[names.parent].value, 'bash');
  assert.deepEqual(p[names.ancestors].value, ['bash', 'init']);
  assert.deepEqual(p[names.matches].value, ['strace']);
  assert.equal(p[names.count].value, 4);
  assert.equal(links.filter((file) => file === '/proc/20/exe').length, 1);
  assert.ok(!JSON.stringify(p).includes('/private'));
  assert.ok(!JSON.stringify(p).includes('strace-wrapper'));
});

test('comm fallback is bounded and potentially truncated names are marked', async () => {
  for (const [comm, expected, status] of [['init\n', 'init', 'ok'], ['123456789012345\n', '123456789012345', 'truncated']]) {
    const p = await collect({ readFile: async (file, options) => {
      if (file === '/proc/1/comm') { assert.equal(options.limit, 256); return comm; }
      return absent();
    } });
    assert.deepEqual(p[names.init], { value: expected, status });
  }
  const oversized = await collect({ readLink: async () => '/' + 'x'.repeat(4096) });
  assert.equal(oversized[names.init].status, 'truncated');
});

test('process entry bound counts all entries and closes the directory', async () => {
  let closed = 0;
  let scans = 0;
  const p = await collect({ entryLimit: 2, openDirectory: async () => {
    scans++;
    return directory([entry('net'), entry('1'), entry('2')], () => closed++);
  }, readLink: async () => '/usr/bin/gdb' });
  assert.deepEqual(p[names.count], { value: null, status: 'truncated' });
  assert.deepEqual(p[names.matches], { value: ['gdb'], status: 'truncated' });
  assert.equal(scans, 1);
  assert.equal(closed, 1);
});

test('ancestor depth, cycles and inaccessible parents preserve partial sequence', async () => {
  for (const [limit, parents, expected] of [[1, { self: 2, 2: 1 }, 'truncated'], [16, { self: 2, 2: 2 }, 'error'], [16, { self: 2 }, 'permission_denied']]) {
    const p = await collect({ ancestorLimit: limit, readLink: async () => '/bin/bash', readFile: async (file) => {
      const pid = file.split('/')[2];
      if (parents[pid] === undefined) throw Object.assign(new Error(), { code: 'EACCES' });
      return `PPid: ${parents[pid]}\n`;
    } });
    assert.deepEqual(p[names.ancestors], { value: ['bash'], status: expected });
  }
});

test('missing and malformed fields, permission failures and non-Linux are isolated', async () => {
  const empty = await collect({ readFile: async () => '' });
  for (const name of ['depth', 'tracer', 'seccomp', 'noNewPrivs', 'capabilities']) assert.equal(empty[names[name]].status, 'absent');
  const malformed = await collect({ readFile: async () => 'Seccomp: 3\nTracerPid: 0\nTracerPid: 1\n' });
  assert.equal(malformed[names.seccomp].status, 'error');
  assert.equal(malformed[names.tracer].status, 'error');
  const denied = await collect({ readFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } });
  assert.equal(denied[names.tracer].status, 'permission_denied');
  const other = await collect({ platform: 'darwin', readFile: async () => assert.fail('read'), readLink: async () => assert.fail('readlink'), openDirectory: async () => assert.fail('opendir') });
  for (const name of Object.values(names)) assert.equal(other[name].status, 'unsupported');
});

test('cancellation closes pending enumeration without further reads', async () => {
  let reads = 0;
  let closes = 0;
  const p = await collect({ openDirectory: async () => ({
    read: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 25)); return entry('1'); },
    close: async () => { closes++; },
  }) }, 5);
  assert.equal(p[names.count].status, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reads, 1);
  assert.equal(closes, 1);
});


test('NoNewPrivs is boolean and capability masks retain all 64 bits', async () => {
  for (const [flag, mask, expected] of [['0', '0', '0000000000000000'], ['1', 'FFFFFFFFFFFFFFFF', 'ffffffffffffffff'], ['1', '0020000000000001', '0020000000000001']]) {
    let reads = 0;
    const p = await collect({ readFile: async (file, options) => {
      if (file !== '/proc/self/status') return absent();
      reads++;
      assert.equal(options.limit, 64 * 1024);
      return `PPid: 0\nNoNewPrivs: ${flag}\nCapEff: ${mask}\n`;
    } });
    assert.equal(reads, 1);
    assert.deepEqual(p[names.noNewPrivs], { value: flag === '1', status: 'ok' });
    assert.deepEqual(p[names.capabilities], { value: expected, status: 'ok' });
  }
});

test('invalid security fields are isolated and denied or oversized sources retain status', async () => {
  for (const raw of ['', '2', 'true', '-1']) {
    const p = await collect({ readFile: async () => `NoNewPrivs: ${raw}\nCapEff: 1\n` });
    assert.equal(p[names.noNewPrivs].status, 'error');
    assert.equal(p[names.capabilities].value, '0000000000000001');
  }
  for (const raw of ['', '0x01', 'xyz', '-1', '1'.repeat(17)]) {
    const p = await collect({ readFile: async () => `NoNewPrivs: 1\nCapEff: ${raw}\n` });
    assert.equal(p[names.capabilities].status, 'error');
    assert.equal(p[names.noNewPrivs].value, true);
  }
  const duplicate = await collect({ readFile: async () => 'NoNewPrivs: 1\nNoNewPrivs: 0\nCapEff: 0\nCapEff: 1\n' });
  for (const name of ['noNewPrivs', 'capabilities']) assert.equal(duplicate[names[name]].status, 'error');
  for (const [code, expected] of [['EACCES', 'permission_denied'], ['EPROBETRUNCATED', 'truncated'], ['ETIMEDOUT', 'timeout']]) {
    const p = await collect({ readFile: async () => { throw Object.assign(new Error(), { code }); } });
    for (const name of ['noNewPrivs', 'capabilities']) assert.equal(p[names[name]].status, expected);
  }
});
