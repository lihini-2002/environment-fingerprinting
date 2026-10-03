import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { collectEnvironment, createNetworkProbes } from '../src/index.js';

const names = ['Network-interface count', 'Non-loopback network-interface count', 'IPv4 interface availability',
  'IPv6 interface availability', 'Loopback-only interface configuration', 'Default IPv4 route presence', 'Default IPv6 route presence'];
const [count, nonLoopback, ipv4, ipv6, loopback, route4, route6] = names;
const header = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n';
const row4 = (destination = '00000000', mask = '00000000', flags = '0003') => `private0 ${destination} 0100000A ${flags} 0 0 100 ${mask} 0 0 0\n`;
const row6 = (destination = '0'.repeat(32), prefix = '00', flags = '00000003', sourcePrefix = '00') =>
  `${destination} ${prefix} ${'0'.repeat(32)} ${sourcePrefix} ${'0'.repeat(32)} 00000064 00000000 00000000 ${flags} private0\n`;
const record = (family = 'IPv4', internal = false) => ({ family, internal });
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createNetworkProbes({ platform: 'linux', system: { networkInterfaces: () => ({}) },
    readFile: async (file) => file.endsWith('/route') ? header : '', ...options }).filter((probe) => names.includes(probe.name)), timeoutMs,
})).properties;

test('one interface snapshot derives counts and families without accessing addresses or names', async () => {
  let calls = 0;
  const privateRecord = record();
  for (const field of ['address', 'mac', 'netmask', 'cidr', 'scopeid']) Object.defineProperty(privateRecord, field, { get: () => assert.fail(`read ${field}`) });
  const probes = createNetworkProbes({ platform: 'darwin', system: { networkInterfaces: () => {
    calls++;
    return { private0: [privateRecord, record('IPv6'), record()], internal0: [record('IPv4', true)], empty: [], gone: undefined };
  } } });
  const cache = new Map();
  const values = [];
  for (const probe of probes.slice(0, 5)) values.push((await probe.run({ cache })).value);
  assert.deepEqual(values, [2, 1, true, true, false]);
  assert.equal(calls, 1);
  for (const observations of cache.values()) for (const pending of observations.values()) {
    assert.deepEqual(await pending, { count: 2, nonLoopback: 1, ipv4: true, ipv6: true, loopbackOnly: false });
  }
  await collectEnvironment({ probes });
  assert.equal(calls, 2);
});

test('empty, loopback-only, IPv6-only and numeric family snapshots have precise semantics', async () => {
  for (const [snapshot, expected] of [
    [{}, [0, 0, false, false, false]],
    [{ lo: [record(4, true), record(6, true)] }, [1, 0, true, true, true]],
    [{ eth: [record('IPv6')] }, [1, 1, false, true, false]],
    [{ mixed: [record('IPv4', true), record('IPv4', false)] }, [1, 1, true, false, false]],
  ]) {
    const p = await collect({ system: { networkInterfaces: () => snapshot } });
    assert.deepEqual(names.slice(0, 5).map((name) => p[name].value), expected);
  }
});

test('unavailable, malformed, denied and oversized snapshots do not affect routes', async () => {
  for (const snapshot of [null, [], { eth: null }, { eth: [record('unknown')] }, { eth: [{ family: 'IPv4' }] }]) {
    const p = await collect({ system: { networkInterfaces: () => snapshot } });
    for (const name of names.slice(0, 5)) assert.equal(p[name].status, 'error');
    assert.equal(p[route4].value, false);
  }
  assert.equal((await collect({ system: {} }))[count].status, 'unsupported');
  assert.equal((await collect({ system: { networkInterfaces: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } } }))[count].status, 'permission_denied');
  for (const snapshot of [Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [i, []])), { eth: Array(4097).fill(record()) }]) {
    assert.equal((await collect({ system: { networkInterfaces: () => snapshot } }))[count].status, 'truncated');
  }
});

test('Linux default routes require a zero destination/prefix, UP and no REJECT flag', async () => {
  for (const [v4, v6, expected4, expected6] of [
    [header + row4(), row6(), true, true],
    [header + row4('00000000', '00FFFFFF'), row6('0'.repeat(32), '80'), false, false],
    [header + row4('0000000A'), row6('1'.repeat(32)), false, false],
    [header + row4('00000000', '00000000', '0000'), row6('0'.repeat(32), '00', '00000000'), false, false],
    [header + row4('00000000', '00000000', '0201'), row6('0'.repeat(32), '00', '00200201'), false, false],
    [header + row4('00000000', '00000000', '0001'), row6('0'.repeat(32), '00', '00000001', '40'), true, true],
    [header, '', false, false],
    [header, row6('0'.repeat(32), '00', '00200201').replace('private0', ''), false, false],
  ]) {
    const reads = [];
    const p = await collect({ readFile: async (file, options) => {
      reads.push(file); assert.equal(options.limit, 1024 * 1024); assert.ok(options.signal);
      return file.endsWith('/route') ? v4 : v6;
    } });
    assert.equal(p[route4].value, expected4); assert.equal(p[route6].value, expected6);
    assert.deepEqual(reads, ['/proc/net/route', '/proc/net/ipv6_route']);
    assert.ok(!JSON.stringify(p).includes('private0'));
  }
});

test('route parsing validates complete input and enforces byte and row limits', async () => {
  for (const [v4, v6, status] of [
    ['bad header', 'bad row', 'error'],
    [header + row4() + 'malformed', row6() + 'malformed', 'error'],
    [header + row4('00000000', '00000000', 'xyz'), row6('0'.repeat(32), '81'), 'error'],
    [header + row4().repeat(4097), row6().repeat(4097), 'truncated'],
    ['x'.repeat(1024 * 1024 + 1), 'x'.repeat(1024 * 1024 + 1), 'truncated'],
  ]) {
    const p = await collect({ readFile: async (file) => file.endsWith('/route') ? v4 : v6 });
    assert.equal(p[route4].status, status); assert.equal(p[route6].status, status);
  }
  assert.equal((await collect({ readFile: async () => '' }))[route4].status, 'absent');
});

test('route source failures, platforms and timeouts stay independent', async () => {
  for (const [code, status] of [['ENOENT', 'absent'], ['EACCES', 'permission_denied']]) {
    const p = await collect({ readFile: async (file) => { if (file.endsWith('/route')) throw Object.assign(new Error(), { code }); return row6(); } });
    assert.equal(p[route4].status, status); assert.equal(p[route6].value, true); assert.equal(p[count].value, 0);
  }
  for (const platform of ['darwin', 'win32', 'freebsd']) {
    const p = await collect({ platform, readFile: async () => assert.fail('no procfs on this platform') });
    assert.equal(p[route4].status, 'unsupported'); assert.equal(p[route6].status, 'unsupported');
  }
  const signals = [];
  const timed = await collect({ readFile: async (_, { signal }) => { signals.push(signal); return new Promise(() => {}); } }, 5);
  assert.equal(timed[route4].status, 'timeout'); assert.equal(timed[route6].status, 'timeout');
  assert.ok(signals.every((signal) => signal.aborted));
});

test('native interface API smoke test reports aggregate observations', async () => {
  const p = (await collectEnvironment({ probes: createNetworkProbes({ system: os }) })).properties;
  for (const name of names.slice(0, 5)) assert.equal(p[name].status, 'ok');
  assert.ok(p[count].value >= p[nonLoopback].value);
  assert.equal(typeof p[ipv4].value, 'boolean'); assert.equal(typeof p[ipv6].value, 'boolean');
});

const dnsCount = 'Configured DNS resolver count';
const dnsClass = 'Configured DNS resolver address class';
const searchCount = 'DNS search-domain count without domain values';
const configCollect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createNetworkProbes({ platform: 'linux', resolver: { getServers: () => [] }, env: {},
    readFile: async () => '', ...options }).slice(7), timeoutMs,
})).properties;

test('DNS derives only counts and sorted unique classes from one fresh snapshot per collection', async () => {
  let calls = 0;
  const probes = createNetworkProbes({ resolver: { getServers() {
    calls++;
    return ['127.0.0.53', '10.2.3.4:5353', '[fc00::1]:5353', '::ffff:192.168.1.1',
      'fe80::1%eth0', '169.254.1.1', '100.64.0.1', '224.0.0.1', 'ff02::1', '0.0.0.0', '::',
      '8.8.8.8', '2001:4860:4860::8888', '::1'];
  } } }).slice(7, 9);
  const cache = new Map();
  assert.equal((await probes[0].run({ cache })).value, 14);
  const expected = { count: 14, classes: ['link_local', 'loopback', 'multicast', 'other', 'private', 'shared', 'unspecified'] };
  assert.deepEqual((await probes[1].run({ cache })).value, expected.classes);
  assert.equal(calls, 1);
  for (const observations of cache.values()) for (const pending of observations.values()) assert.deepEqual(await pending, expected);
  await collectEnvironment({ probes });
  assert.equal(calls, 2);
  const empty = await configCollect();
  assert.deepEqual(empty[dnsCount], { value: 0, status: 'ok' });
  assert.deepEqual(empty[dnsClass], { value: [], status: 'ok' });
});

test('resolver errors and malformed or oversized lists retain statuses without leaking raw data', async () => {
  for (const [servers, status] of [[null, 'error'], [['secret.example'], 'error'], [['1.2.3.4:99999'], 'error'],
    [['[::1]:0'], 'error'], [[42], 'error'], [Array(1025).fill('::1'), 'truncated'], [['x'.repeat(1025)], 'truncated']]) {
    const p = await configCollect({ resolver: { getServers: () => servers } });
    for (const name of [dnsCount, dnsClass]) assert.deepEqual(p[name], { value: null, status });
    assert.equal(p[searchCount].value, 0);
    assert.ok(!JSON.stringify(p).includes('secret.example'));
  }
  assert.equal((await configCollect({ resolver: {} }))[dnsCount].status, 'unsupported');
  assert.equal((await configCollect({ resolver: { getServers() { throw Object.assign(new Error('secret'), { code: 'EACCES' }); } } }))[dnsCount].status, 'permission_denied');
});

test('resolver configuration counts only the final search/domain directive and discards values', async () => {
  for (const [text, expected] of [
    ['', 0], ['nameserver 10.1.2.3\n# search hidden.example', 0],
    ['search private.example internal.example # comment\noptions ndots:5', 2],
    ['search first.example second.example\ndomain last.example', 1],
    ['domain first.example\n search last.example other.example ; comment', 2],
    ['search first.example\nsearch', 0],
  ]) {
    const p = await configCollect({ readFile: async (file, { signal, limit }) => {
      assert.equal(file, '/etc/resolv.conf'); assert.ok(signal); assert.equal(limit, 64 * 1024); return text;
    } });
    assert.deepEqual(p[searchCount], { value: expected, status: 'ok' });
    assert.ok(!JSON.stringify(p).includes('.example'));
  }
});

test('search count handles bounds, missing/denied sources, unsupported platforms and cancellation', async () => {
  for (const [text, status] of [['domain', 'error'], ['domain one two', 'error'], ['search x\0y', 'error'],
    ['x'.repeat(65537), 'truncated'], ['\n'.repeat(4096), 'truncated']]) {
    assert.equal((await configCollect({ readFile: async () => text }))[searchCount].status, status);
  }
  for (const [code, status] of [['ENOENT', 'absent'], ['EACCES', 'permission_denied']]) {
    assert.equal((await configCollect({ readFile: async () => { throw Object.assign(new Error(), { code }); } }))[searchCount].status, status);
  }
  assert.equal((await configCollect({ platform: 'win32', readFile: () => assert.fail('no Unix read') }))[searchCount].status, 'unsupported');
  let signal;
  const p = await configCollect({ readFile: (_, options) => { signal = options.signal; return new Promise(() => {}); } }, 5);
  assert.equal(p[searchCount].status, 'timeout'); assert.ok(signal.aborted);
  assert.equal(p['HTTP_PROXY variable presence'].value, false);
});

test('proxy presence checks both spellings, including empty values, without reading values', async () => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    for (const spelling of [name, name.toLowerCase()]) {
      const env = {};
      Object.defineProperty(env, spelling, { get() { assert.fail('must not read proxy value'); } });
      const p = await configCollect({ env });
      assert.deepEqual(p[`${name} variable presence`], { value: true, status: 'ok' });
    }
    assert.equal((await configCollect({ env: { [name]: '' } }))[`${name} variable presence`].value, true);
    assert.equal((await configCollect({ env: Object.create({ [name]: 'inherited' }) }))[`${name} variable presence`].value, false);
  }
});
