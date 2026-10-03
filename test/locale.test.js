import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectEnvironment, createLocaleProbes } from '../src/index.js';

const zone = 'Resolved runtime timezone identifier';
const locale = 'Resolved runtime locale identifier';
const offset = 'Current timezone UTC offset in minutes';
const intlWith = (options) => ({ DateTimeFormat: class { resolvedOptions() { return options; } } });
const collect = async (options = {}) => (await collectEnvironment({ probes: createLocaleProbes({
  env: {}, intl: intlWith({ timeZone: 'Asia/Colombo', locale: 'en-LK' }),
  now: () => ({ getTimezoneOffset: () => -330 }), ...options,
}) })).properties;

test('environment values preserve empty and literal strings and ignore unrelated variables', async () => {
  const env = { TZ: '', LANG: 'en_US.UTF-8', LC_ALL: ' C ' };
  Object.defineProperty(env, 'SECRET', { get: () => assert.fail('unrelated environment read') });
  const p = await collect({ env });
  for (const name of ['TZ', 'LANG', 'LC_ALL']) assert.deepEqual(p[`${name} variable value`], { value: env[name], status: 'ok' });
  const missing = await collect({ env: Object.create({ TZ: 'inherited' }) });
  for (const name of ['TZ', 'LANG', 'LC_ALL']) assert.deepEqual(missing[`${name} variable value`], { value: null, status: 'absent' });
  assert.equal(p[zone].value, 'Asia/Colombo');
  assert.equal(p[locale].value, 'en-LK');
  assert.equal(p[offset].value, -330);
});

test('environment values are bounded and invalid types fail independently', async () => {
  const p = await collect({ env: { TZ: 42, LANG: 'x'.repeat(4097), LC_ALL: 'POSIX' } });
  assert.deepEqual(p['TZ variable value'], { value: null, status: 'error' });
  assert.deepEqual(p['LANG variable value'], { value: 'x'.repeat(4096), status: 'truncated' });
  assert.equal(p['LC_ALL variable value'].value, 'POSIX');
  assert.equal(p[zone].status, 'ok');
});

test('resolved options are sampled once per collection and refreshed on subsequent collections', async () => {
  let calls = 0;
  const intl = { DateTimeFormat: class { resolvedOptions() {
    calls++;
    return { timeZone: calls === 1 ? 'UTC' : 'Asia/Colombo', locale: 'en-US', unused: 'not cached' };
  } } };
  const probes = createLocaleProbes({ env: {}, intl });
  const cache = new Map();
  assert.equal((await probes.find((p) => p.name === zone).run({ cache })).value, 'UTC');
  assert.equal((await probes.find((p) => p.name === locale).run({ cache })).value, 'en-US');
  assert.equal(calls, 1);
  for (const entry of cache.values()) assert.deepEqual(await entry, { timeZone: 'UTC', locale: 'en-US' });
  const next = (await collectEnvironment({ probes })).properties;
  assert.equal(next[zone].value, 'Asia/Colombo');
  assert.equal(calls, 2);
});

test('missing or invalid Intl results do not affect environment values or offset', async () => {
  for (const intl of [null, {}, { DateTimeFormat: class {} }]) {
    const p = await collect({ intl, env: { TZ: 'UTC' } });
    assert.equal(p[zone].status, 'unsupported');
    assert.equal(p[locale].status, 'unsupported');
    assert.equal(p[offset].value, -330);
    assert.equal(p['TZ variable value'].value, 'UTC');
  }
  for (const options of [null, []]) assert.equal((await collect({ intl: intlWith(options) }))[zone].status, 'error');
  const partial = await collect({ intl: intlWith({ timeZone: 1, locale: 'en-US' }) });
  assert.equal(partial[zone].status, 'error');
  assert.equal(partial[locale].value, 'en-US');
  const missing = await collect({ intl: intlWith({}) });
  assert.equal(missing[zone].status, 'absent');
  assert.equal(missing[locale].status, 'absent');
  const denied = await collect({ intl: { DateTimeFormat: class { constructor() {
    throw Object.assign(new Error('unreported'), { code: 'EACCES' });
  } } } });
  assert.equal(denied[zone].status, 'permission_denied');
  assert.equal(denied[locale].status, 'permission_denied');
});

test('offsets preserve Date sign and minute precision and reject invalid dates', async () => {
  for (const value of [-345, -330, 0, 300, 240]) {
    assert.deepEqual((await collect({ now: () => ({ getTimezoneOffset: () => value }) }))[offset], { value, status: 'ok' });
  }
  for (const value of [NaN, Infinity, 1.5, '0']) {
    const p = await collect({ now: () => ({ getTimezoneOffset: () => value }) });
    assert.equal(p[offset].status, 'error');
    assert.equal(p[zone].status, 'ok');
  }
  assert.equal((await collect({ now: () => new Date(NaN) }))[offset].status, 'error');
  assert.equal((await collect({ now: () => ({}) }))[offset].status, 'unsupported');
});

test('real runtime observes timezone configuration and seasonal offsets without changing parent settings', async () => {
  const api = new URL('../src/index.js', import.meta.url).href;
  const code = `import { collectEnvironment, createLocaleProbes } from ${JSON.stringify(api)};
    const reports = [];
    for (const instant of ['2024-01-15T12:00:00Z', '2024-07-15T12:00:00Z']) {
      reports.push((await collectEnvironment({ probes: createLocaleProbes({ now: () => new Date(instant) }) })).properties);
    }
    console.log(JSON.stringify({ reports, resolved: new Intl.DateTimeFormat().resolvedOptions() }));`;
  for (const [tz, offsets] of [['UTC', [0, 0]], ['Asia/Colombo', [-330, -330]], ['America/New_York', [300, 240]]]) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', code], {
      env: { ...process.env, TZ: tz }, timeout: 5000,
    });
    const { reports, resolved } = JSON.parse(stdout);
    for (const [i, p] of reports.entries()) {
      assert.equal(p['TZ variable value'].value, tz);
      assert.equal(p[offset].value, offsets[i]);
      assert.equal(p[zone].value, resolved.timeZone);
      assert.equal(p[locale].value, resolved.locale);
    }
  }
});
