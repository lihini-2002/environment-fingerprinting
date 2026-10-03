import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createCPUProbes } from '../src/index.js';
import { CPUINFO_LIMIT, macPhysicalCores } from '../src/probes/cpu.js';

const cpuinfo = [
  'processor: 0\nphysical id: 0\ncore id: 0\nflags: fpu sse hypervisor',
  'processor: 1\nphysical id: 0\ncore id: 0\nflags: sse fpu',
  'processor: 2\nphysical id: 1\ncore id: 0\nflags: fpu sse avx',
].join('\n\n');
const system = {
  cpus: () => [{ model: ' Intel(R)  CPU ', speed: 3200 }, { model: 'Intel(R) CPU', speed: 2400 }],
  availableParallelism: () => 1,
};
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createCPUProbes({ platform: 'linux', system,
    readFile: async (path) => path === '/proc/cpuinfo' ? cpuinfo : 'Cpus_allowed_list:\t0-2,5\n',
    ...options }), timeoutMs,
})).properties;

test('macOS command output handles counts, denied kernel queries, and missing keys', async () => {
  assert.equal(await macPhysicalCores({ runCommand: async () => ({ stdout: '8\n' }) }), 8);
  await assert.rejects(macPhysicalCores({ runCommand: async () => ({ stdout: 'invalid' }) }), /Invalid/);
  for (const [stderr, code] of [['Operation not permitted', 'EPERM'], ['unknown oid', 'ENOENT']]) {
    await assert.rejects(macPhysicalCores({ runCommand: async () => {
      throw Object.assign(new Error(), { code: 1, stderr });
    } }), { code });
  }
});

test('CPU metadata is normalized, sampled once, and distinct from available parallelism', async () => {
  let calls = 0;
  const probes = createCPUProbes({ platform: 'win32', system: { ...system, cpus() { calls++; return system.cpus(); } } });
  const { properties: p } = await collectEnvironment({ probes });
  assert.deepEqual(p['CPU vendor'], { value: ['Intel'], status: 'ok' });
  assert.deepEqual(p['CPU model'].value, ['Intel(R) CPU']);
  assert.deepEqual(p['CPU nominal clock speed'].value, [2400, 3200]);
  assert.equal(p['Reported logical CPU count'].value, 2);
  assert.equal(p['Process-available parallelism'].value, 1);
  assert.equal(calls, 1);
  await collectEnvironment({ probes });
  assert.equal(calls, 2); // No stale metadata across collection invocations.
});

test('Linux counts socket/core pairs, preserves CPU lists, and intersects flags', async () => {
  let reads = 0;
  const p = await collect({ readFile: async (path, options) => {
    if (path === '/proc/cpuinfo') {
      reads++;
      assert.equal(options.limit, CPUINFO_LIMIT);
      return cpuinfo;
    }
    return 'Cpus_allowed_list:\t0-2,5\n';
  } });
  assert.equal(p['Physical CPU core count when exposed'].value, 2);
  assert.equal(p['CPU affinity mask'].value, '0-2,5');
  assert.equal(p['CPU hypervisor flag presence'].value, true);
  assert.deepEqual(p['CPU instruction-set flags'].value, ['fpu', 'sse']);
  assert.equal(reads, 1);
});

test('mixed vendors are retained; unknown vendor and zero speeds are absent', async () => {
  const p = await collect({ system: { ...system, cpus: () => [
    { model: 'AMD Ryzen', speed: 2000 }, { model: 'Intel Core', speed: 3000 },
  ] } });
  assert.deepEqual(p['CPU vendor'].value, ['AMD', 'Intel']);
  const unknown = await collect({ system: { ...system, cpus: () => [{ model: 'ARMv8 Processor', speed: 0 }] } });
  assert.equal(unknown['CPU vendor'].status, 'absent');
  assert.equal(unknown['CPU nominal clock speed'].status, 'absent');
});

test('empty CPU metadata does not claim zero CPUs or prevent parallelism probing', async () => {
  const p = await collect({ system: { ...system, cpus: () => [] } });
  for (const name of ['CPU vendor', 'CPU model', 'Reported logical CPU count', 'CPU nominal clock speed']) {
    assert.deepEqual(p[name], { value: null, status: 'absent' });
  }
  assert.equal(p['Process-available parallelism'].value, 1);
});

test('ARM features are supported without inventing topology or a hypervisor bit', async () => {
  const p = await collect({ readFile: async () => 'processor: 0\nFeatures: fp asimd aes\n' });
  assert.deepEqual(p['CPU instruction-set flags'].value, ['aes', 'asimd', 'fp']);
  assert.equal(p['CPU hypervisor flag presence'].status, 'absent');
  assert.equal(p['Physical CPU core count when exposed'].status, 'absent');
  const negative = await collect({ readFile: async () => 'processor: 0\nflags: fpu sse\n' });
  assert.deepEqual(negative['CPU hypervisor flag presence'], { value: false, status: 'ok' });
  const incomplete = await collect({ readFile: async () => 'processor: 0\nflags: fpu\n\nprocessor: 1\n' });
  assert.equal(incomplete['CPU instruction-set flags'].status, 'absent');
  assert.equal(incomplete['CPU hypervisor flag presence'].status, 'absent');
});

test('macOS topology is independent of Linux-only features; Windows topology is unsupported', async () => {
  const p = await collect({ platform: 'darwin', physicalCores: async () => 8,
    readFile: async () => { throw new Error('Must not read Linux paths'); } });
  assert.equal(p['Physical CPU core count when exposed'].value, 8);
  for (const name of ['CPU affinity mask', 'CPU instruction-set flags', 'CPU hypervisor flag presence']) {
    assert.equal(p[name].status, 'unsupported');
  }
  const win = await collect({ platform: 'win32' });
  assert.equal(win['Physical CPU core count when exposed'].status, 'unsupported');
});

test('restricted, missing, and oversized Linux sources propagate statuses independently', async () => {
  for (const [code, status] of [['EACCES', 'permission_denied'], ['ENOENT', 'absent'], ['EPROBETRUNCATED', 'truncated']]) {
    const p = await collect({ readFile: async () => { throw Object.assign(new Error(), { code }); } });
    for (const name of ['CPU affinity mask', 'CPU instruction-set flags', 'CPU hypervisor flag presence', 'Physical CPU core count when exposed']) {
      assert.deepEqual(p[name], { value: null, status });
    }
    assert.equal(p['CPU model'].status, 'ok');
  }
});

test('Linux source timeouts abort and leave native metadata available', async () => {
  let aborted = false;
  const p = await collect({ readFile: (path, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) }, 10);
  assert.equal(aborted, true);
  assert.equal(p['Physical CPU core count when exposed'].status, 'timeout');
  assert.equal(p['CPU affinity mask'].status, 'timeout');
  assert.equal(p['CPU model'].status, 'ok');
});

test('malformed affinity ranges fail without expansion or guessed values', async () => {
  for (const list of ['5-2', '0-3,2', '0-999999999999999999999', 'not-a-mask']) {
    const p = await collect({ readFile: async () => `Cpus_allowed_list:\t${list}\n` });
    assert.equal(p['CPU affinity mask'].status, 'error');
  }
});
