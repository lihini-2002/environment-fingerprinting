import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createResourceProbes } from '../src/index.js';
import { resolveCgroup } from '../src/probes/resources.js';

const mount = (type, root = '/', point = '/sys/fs/cgroup', controllers = 'rw') =>
  `30 20 0:25 ${root} ${point} rw,nosuid - ${type} cgroup ${controllers}\n`;
const base = {
  '/proc/meminfo': 'SwapTotal: 2048 kB\nSwapFree: 0 kB\n',
  '/proc/self/limits': 'Limit                     Soft Limit           Hard Limit           Units\nMax open files            1024                 4096                 files\nMax address space         unlimited            unlimited            bytes\nMax stack size            8388608              unlimited            bytes\n',
  '/proc/self/cgroup': '0::/jobs/install\n',
  '/proc/self/mountinfo': mount('cgroup2'),
  '/sys/fs/cgroup/jobs/install/cpu.max': '200000 100000\n',
  '/sys/fs/cgroup/jobs/install/cpuset.cpus.effective': '0-3,8\n',
  '/sys/fs/cgroup/jobs/install/memory.max': 'max\n',
  '/sys/fs/cgroup/jobs/install/memory.current': '1048576\n',
  '/sys/fs/cgroup/jobs/install/pids.max': '256\n',
  '/sys/fs/cgroup/jobs/install/pids.current': '0\n',
};
const source = (files) => async (file) => {
  if (!(file in files)) throw Object.assign(new Error(), { code: 'ENOENT' });
  return files[file];
};
async function collect(files = base, options = {}, timeoutMs = 1500) {
  return (await collectEnvironment({ probes: createResourceProbes({
    system: { totalmem: () => 16000, freemem: () => 0 }, platform: 'linux',
    readFile: source(files), ...options,
  }), timeoutMs })).properties;
}

test('memory, swap units, zero counters, limits and current cgroup v2 values', async () => {
  const p = await collect();
  const expected = {
    'Total host-visible memory bytes': 16000, 'Available host-visible memory bytes': 0,
    'Total swap bytes': 2097152, 'Available swap bytes': 0,
    'Cgroup CPU quota': 200000, 'Cgroup CPU quota period': 100000,
    'Cgroup effective CPU set': '0-3,8', 'Cgroup memory limit bytes': 'unlimited',
    'Cgroup current memory usage bytes': 1048576, 'Cgroup process-count limit': 256,
    'Cgroup current process count': 0, 'Process open-file soft limit': 1024,
    'Process open-file hard limit': 4096, 'Process address-space limit': 'unlimited',
    'Process stack-size limit': 8388608,
  };
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(p[name], { value, status: 'ok' }, name);
});

test('v1 resolves separate and combined controllers and preserves large limits exactly', async () => {
  const files = { ...base,
    '/proc/self/cgroup': '2:cpu,cpuacct:/tenant/run\n3:memory:/tenant/run\n4:cpuset:/tenant/run\n5:pids:/tenant/run\n',
    '/proc/self/mountinfo': ['cpu,cpuacct', 'memory', 'cpuset', 'pids'].map((c) => mount('cgroup', '/tenant', `/sys/fs/cgroup/${c}`, `rw,${c}`)).join(''),
    '/sys/fs/cgroup/cpu,cpuacct/run/cpu.cfs_quota_us': '-1',
    '/sys/fs/cgroup/cpu,cpuacct/run/cpu.cfs_period_us': '100000',
    '/sys/fs/cgroup/memory/run/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/memory/run/memory.usage_in_bytes': '300',
    '/sys/fs/cgroup/cpuset/run/cpuset.effective_cpus': '1-2',
    '/sys/fs/cgroup/pids/run/pids.max': 'max',
    '/sys/fs/cgroup/pids/run/pids.current': '12',
  };
  const p = await collect(files);
  assert.equal(p['Cgroup CPU quota'].value, 'unlimited');
  assert.equal(p['Cgroup CPU quota period'].value, 100000);
  assert.equal(p['Cgroup memory limit bytes'].value, '9223372036854771712');
  assert.equal(p['Cgroup current memory usage bytes'].value, 300);
  assert.equal(p['Cgroup effective CPU set'].value, '1-2');
  assert.equal(p['Cgroup process-count limit'].value, 'unlimited');
  assert.equal(p['Cgroup current process count'].value, 12);
});

test('hybrid cgroups prefer the controller-specific v1 membership', () => {
  assert.deepEqual(resolveCgroup('0::/v2\n2:cpu,cpuacct:/v1\n',
    mount('cgroup2') + mount('cgroup', '/', '/cpu', 'rw,cpu,cpuacct'), 'cpu'),
  { version: 1, directory: '/cpu/v1' });
});

test('mount roots, escaped mount paths, namespace roots, and specific bind mounts', () => {
  assert.equal(resolveCgroup('0::/tenant/job\n', mount('cgroup2', '/tenant', '/sys/fs/cgroup\\040space'), 'cpu').directory,
    '/sys/fs/cgroup space/job');
  assert.equal(resolveCgroup('0::/\n', mount('cgroup2'), 'cpu').directory, '/sys/fs/cgroup');
  assert.equal(resolveCgroup('0::/tenant/job\n', mount('cgroup2') + mount('cgroup2', '/tenant', '/visible'), 'cpu').directory, '/visible/job');
  assert.equal(resolveCgroup('0::/outside\n', mount('cgroup2', '/tenant'), 'cpu'), null);
  assert.equal(resolveCgroup('0::/tenant2\n', mount('cgroup2', '/tenant'), 'cpu'), null);
  assert.throws(() => resolveCgroup('0::/../../escape\n', mount('cgroup2'), 'cpu'), /path/);
});

test('shared files are sampled once per collection and refreshed on the next', async () => {
  const counts = new Map();
  const probes = createResourceProbes({ platform: 'linux', readFile: async (file) => {
    counts.set(file, (counts.get(file) ?? 0) + 1);
    return source(base)(file);
  } });
  await collectEnvironment({ probes });
  assert.ok([...counts.values()].every((n) => n === 1));
  await collectEnvironment({ probes });
  assert.ok([...counts.values()].every((n) => n === 2));
});

test('unlimited v2 quota, empty effective set, and absent controllers', async () => {
  const p = await collect({ ...base, '/sys/fs/cgroup/jobs/install/cpu.max': 'max 100000',
    '/sys/fs/cgroup/jobs/install/cpuset.cpus.effective': '' });
  assert.equal(p['Cgroup CPU quota'].value, 'unlimited');
  assert.deepEqual(p['Cgroup effective CPU set'], { value: '', status: 'ok' });
  const absent = await collect({ ...base, '/proc/self/cgroup': '' });
  assert.equal(absent['Cgroup CPU quota'].status, 'absent');
  const missing = { ...base };
  delete missing['/sys/fs/cgroup/jobs/install/memory.max'];
  const q = await collect(missing);
  assert.equal(q['Cgroup memory limit bytes'].status, 'absent');
  assert.equal(q['Cgroup current memory usage bytes'].status, 'ok');
});

test('non-Linux systems probe native memory without reading Linux files', async () => {
  const p = await collect({}, { platform: 'darwin', readFile: () => assert.fail('Unexpected Linux read') });
  assert.equal(p['Total host-visible memory bytes'].status, 'ok');
  assert.equal(p['Total swap bytes'].status, 'unsupported');
  assert.equal(p['Cgroup CPU quota'].status, 'unsupported');
  assert.equal(p['Process stack-size limit'].status, 'unsupported');
});

test('denied, truncated, malformed and timed-out sources do not stop native probes', async () => {
  for (const [code, status] of [['EACCES', 'permission_denied'], ['EPROBETRUNCATED', 'truncated']]) {
    const p = await collect({}, { readFile: async () => { throw Object.assign(new Error(), { code }); } });
    assert.equal(p['Total swap bytes'].status, status);
    assert.equal(p['Cgroup CPU quota'].status, status);
    assert.equal(p['Process stack-size limit'].status, status);
    assert.equal(p['Total host-visible memory bytes'].status, 'ok');
  }
  const malformed = await collect({ ...base, '/sys/fs/cgroup/jobs/install/cpu.max': 'max nope',
    '/proc/meminfo': 'SwapTotal: NaN kB', '/proc/self/limits': 'Max open files 1 2 bytes' });
  assert.equal(malformed['Cgroup CPU quota'].status, 'error');
  assert.equal(malformed['Total swap bytes'].status, 'error');
  assert.equal(malformed['Process open-file soft limit'].status, 'error');
  const timeout = await collect({}, { readFile: (file, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }, 5);
  assert.equal(timeout['Cgroup CPU quota'].status, 'timeout');
  assert.equal(timeout['Total host-visible memory bytes'].status, 'ok');
});
