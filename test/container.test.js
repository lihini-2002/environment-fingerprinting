import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createContainerProbes } from '../src/index.js';
import { parseCgroupMembership } from '../src/probes/container.js';

const file = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const link = { isSymbolicLink: () => true };
const missing = () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createContainerProbes({ platform: 'linux', runtime: { env: {} }, statFile: async () => null, lstatFile: async () => null, readFile: async () => missing(), ...options }), timeoutMs,
})).properties;

test('markers check fixed regular files and environment indicators never read values', async () => {
  const calls = [];
  const env = {};
  Object.defineProperty(env, 'container', { enumerable: true, get() { assert.fail('value read'); } });
  const p = await collect({ runtime: { env }, statFile: async (name) => { calls.push(name); return name === '/.dockerenv' ? file : directory; } });
  assert.equal(p['Docker marker-file presence'].value, true);
  assert.equal(p['Podman container marker-file presence'].value, false);
  assert.equal(p['Container environment-variable presence'].value, true);
  assert.deepEqual(calls, ['/.dockerenv', '/run/.containerenv', '/proc/self/ns']);
  for (const name of ['container', 'CONTAINER', 'KUBERNETES_SERVICE_HOST']) {
    const q = await collect({ runtime: { env: { [name]: '' } }, statFile: async () => file });
    assert.equal(q['Container environment-variable presence'].value, true);
    assert.equal(q['Podman container marker-file presence'].value, true);
  }
  const absent = await collect({ runtime: { env: Object.create({ container: 'inherited' }) } });
  assert.equal(absent['Container environment-variable presence'].value, false);
});

test('v1 returns sorted controller names and redacts private cgroup components', async () => {
  let reads = 0;
  const p = await collect({ readFile: async (name, options) => {
    assert.equal(name, '/proc/self/cgroup');
    assert.equal(options.limit, 65536);
    reads++;
    return '4:cpu,cpuacct:/docker/private-id\n3:memory:/docker/private-id\n2:name=private-hierarchy:/user.slice/user-1000.slice/private.service\n';
  } });
  assert.equal(reads, 1);
  assert.deepEqual(p['Cgroup version'], { value: 'v1', status: 'ok' });
  assert.deepEqual(p['Cgroup controller list'].value, ['cpu', 'cpuacct', 'memory']);
  assert.deepEqual(p['Cgroup path normalized template'].value, ['/docker/<group>', '/user.slice/<group>/<group>']);
  assert.ok(!JSON.stringify(p).includes('private'));
  assert.ok(!JSON.stringify(p).includes('1000'));
});

test('v2 and hybrid resolve visible mount roots before reading controllers', async () => {
  for (const hybrid of [false, true]) {
    const reads = [];
    const sources = {
      '/proc/self/cgroup': `${hybrid ? '3:cpu:/legacy/private\n' : ''}0::/tenant/private\n`,
      '/proc/self/mountinfo': '10 1 0:1 /tenant /sys/fs/cgroup/unified rw - cgroup2 cgroup rw\n',
      '/sys/fs/cgroup/unified/private/cgroup.controllers': 'memory pids io memory future_controller\n',
    };
    const p = await collect({ readFile: async (name) => { reads.push(name); return sources[name] ?? missing(); } });
    assert.equal(p['Cgroup version'].value, hybrid ? 'hybrid' : 'v2');
    assert.deepEqual(p['Cgroup controller list'].value, hybrid ? ['cpu', 'io', 'memory', 'pids'] : ['io', 'memory', 'pids']);
    assert.equal(reads.filter((name) => name === '/proc/self/cgroup').length, 1);
    assert.ok(reads.includes('/sys/fs/cgroup/unified/private/cgroup.controllers'));
  }
});

test('namespace types come only from fixed link metadata with child aliases deduplicated', async () => {
  const calls = [];
  const p = await collect({ statFile: async (name) => name === '/proc/self/ns' ? directory : null,
    lstatFile: async (name) => { calls.push(name); return ['/proc/self/ns/pid', '/proc/self/ns/pid_for_children', '/proc/self/ns/user', '/proc/self/ns/time_for_children'].includes(name) ? link : null; },
  });
  assert.deepEqual(p['Visible namespace type list'].value, ['pid', 'time', 'user']);
  assert.equal(calls.length, 10);
});

test('empty, malformed, oversized and traversal memberships retain distinct statuses', async () => {
  for (const [text, status] of [['', 'absent'], ['not a cgroup', 'error'], ['0::/../private', 'error'], ['0:cpu:/', 'error'], ['1::/', 'error'], ['0::/' + 'a'.repeat(65536), 'truncated'], [Array(129).fill('0::/').join('\n'), 'truncated']]) {
    const p = await collect({ readFile: async () => text });
    for (const name of ['Cgroup version', 'Cgroup controller list', 'Cgroup path normalized template']) assert.equal(p[name].status, status);
  }
  assert.equal(parseCgroupMembership('0::/\n')[0].template, '/');
});

test('controller source failure does not erase version or normalized membership', async () => {
  const p = await collect({ readFile: async (name) => {
    if (name === '/proc/self/cgroup') return '0::/\n';
    throw Object.assign(new Error('private'), { code: 'EACCES' });
  } });
  assert.equal(p['Cgroup version'].value, 'v2');
  assert.equal(p['Cgroup controller list'].status, 'permission_denied');
  assert.deepEqual(p['Cgroup path normalized template'].value, ['/']);
});

test('non-Linux skips filesystem reads but supports environment presence', async () => {
  const p = await collect({ platform: 'win32', runtime: { env: { kubernetes_service_host: '' } },
    statFile: async () => assert.fail('stat'), readFile: async () => assert.fail('read'),
  });
  for (const name of ['Docker marker-file presence', 'Podman container marker-file presence', 'Cgroup version', 'Cgroup controller list', 'Cgroup path normalized template', 'Visible namespace type list']) assert.equal(p[name].status, 'unsupported');
  assert.equal(p['Container environment-variable presence'].value, true);
});

test('permission and timeout failures are not absence and cancellation stops namespace checks', async () => {
  const p = await collect({ statFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } });
  assert.equal(p['Docker marker-file presence'].status, 'permission_denied');
  assert.equal(p['Visible namespace type list'].status, 'permission_denied');
  let calls = 0;
  const timed = await collect({ statFile: async (name) => name === '/proc/self/ns' ? directory : null,
    lstatFile: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return link; },
  }, 5);
  assert.equal(timed['Visible namespace type list'].status, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});
