import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createSessionProbes } from '../src/index.js';
import { hostnameClass, normalizePathTemplate } from '../src/probes/session.js';

const system = {
  userInfo: () => ({ username: 'private-person-729', homedir: '/home/private-person-729' }),
  hostname: () => 'private-host-816',
  homedir: () => '/home/private-person-729',
  tmpdir: () => '/tmp/private-person-729/session-unique',
};
const runtime = {
  geteuid: () => 1000, getegid: () => 100, getgroups: () => [100, 200, 200],
  umask: (...args) => { assert.equal(args.length, 0); return 0o022; },
  cwd: () => '/home/private-person-729/secret-project/node_modules/@private-org/secret-package',
  env: { SHELL: '/home/private-person-729/bin/zsh' },
  stdin: {}, stdout: { isTTY: true }, stderr: { isTTY: false },
};
async function collect(options = {}, timeoutMs = 1500) {
  return (await collectEnvironment({
    probes: createSessionProbes({ system, runtime, platform: 'linux', ...options }), timeoutMs,
  })).properties;
}

test('user, host, session values retain only requested derived data', async () => {
  const p = await collect();
  const expected = {
    'Username length': 18, 'Username generic-account pattern': false,
    'Hostname length': 16, 'Hostname character-pattern class': 'hyphenated',
    'Hostname container-like pattern': false, 'Effective user ID': 1000,
    'Effective group ID': 100, 'Supplementary group count': 2, 'Effective root status': false,
    'Process umask': '0022', 'Login-shell executable basename': 'zsh',
    'Home-directory normalized path template': '<posix-root>/home/<user>',
    'Working-directory normalized path template': '<posix-root>/home/<user>/<dir>/node_modules/<scope>/<package>',
    'Temporary-directory normalized path template': '<posix-root>/tmp/<dir>/<dir>',
    'Standard input terminal status': false, 'Standard output terminal status': true,
    'Standard error terminal status': false,
  };
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(p[name], { value, status: 'ok' }, name);
  for (const secret of ['private-person-729', 'private-host-816', 'secret-project', 'private-org', 'secret-package', 'session-unique']) {
    assert.ok(!JSON.stringify(p).includes(secret), secret);
  }
  assert.equal(p['Windows process elevation status'].status, 'unsupported');
});

test('generic accounts, root, empty groups and container-like hostnames', async () => {
  const p = await collect({ system: { ...system, userInfo: () => ({ username: 'RUNNER' }), hostname: () => 'a1b2c3d4e5f6' },
    runtime: { ...runtime, geteuid: () => 0, getgroups: () => [] } });
  assert.equal(p['Username generic-account pattern'].value, true);
  assert.equal(p['Hostname character-pattern class'].value, 'hexadecimal');
  assert.equal(p['Hostname container-like pattern'].value, true);
  assert.equal(p['Effective root status'].value, true);
  assert.equal(p['Supplementary group count'].value, 0);
});

test('hostname classes have deterministic precedence and Unicode lengths use code points', async () => {
  for (const [name, expected] of [['123', 'numeric'], ['abcdef', 'hexadecimal'], ['host', 'alphabetic'],
    ['host2', 'alphanumeric'], ['my-host', 'hyphenated'], ['host.example', 'dotted'], ['host_name', 'mixed'], ['höst', 'non_ascii']]) {
    assert.equal(hostnameClass(name), expected);
  }
  const p = await collect({ system: { ...system, userInfo: () => ({ username: 'a😀' }), hostname: () => 'pod-abcdefghij-12345' } });
  assert.equal(p['Username length'].value, 2);
  assert.equal(p['Hostname container-like pattern'].value, true);
});

test('path templates mask POSIX, Windows drive, UNC and device identifiers', () => {
  const cases = [
    ['/Users/Alice/Project', 'darwin', '<posix-root>/Users/<user>/<dir>'],
    ['/var/folders/ab/secret/T', 'darwin', '<posix-root>/var/folders/<dir>/<dir>/<dir>'],
    ['C:\\Users\\Alice\\AppData\\Local\\Temp', 'win32', '<drive>/Users/<user>/AppData/Local/temp'],
    ['\\\\private-server\\private-share\\secret', 'win32', '<unc-root>/<dir>'],
    ['\\\\?\\C:\\Users\\Alice', 'win32', '<device-root>/Users/<user>'],
    ['/', 'linux', '<posix-root>'],
    ['/home/Alice/../Bob/project', 'linux', '<posix-root>/home/<user>/<dir>'],
  ];
  for (const [raw, platform, expected] of cases) assert.equal(normalizePathTemplate(raw, platform).value, expected);
  assert.equal(normalizePathTemplate('').status, 'absent');
  assert.throws(() => normalizePathTemplate('relative/private'), /absolute/);
});

test('Windows uses ComSpec basename, unsupported POSIX IDs, and optional elevation helper', async () => {
  const win = { ...runtime, geteuid: undefined, getegid: undefined, getgroups: undefined,
    cwd: () => 'C:\\workspaces\\private', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } };
  const options = { platform: 'win32', runtime: win, system: { ...system, homedir: () => 'C:\\Users\\Alice', tmpdir: () => 'C:\\Temp' } };
  const p = await collect(options);
  for (const name of ['Effective user ID', 'Effective group ID', 'Effective root status', 'Supplementary group count', 'Windows process elevation status']) {
    assert.equal(p[name].status, 'unsupported');
  }
  assert.equal(p['Login-shell executable basename'].value, 'cmd.exe');
  for (const value of [true, false]) {
    const elevated = await collect({ ...options, elevationQuery: async () => value });
    assert.deepEqual(elevated['Windows process elevation status'], { value, status: 'ok' });
  }
  const timeout = await collect({ ...options, elevationQuery: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }, 5);
  assert.equal(timeout['Windows process elevation status'].status, 'timeout');
});

test('missing, denied and malformed sources are isolated without retaining raw errors', async () => {
  const p = await collect({ system: { ...system, userInfo() { throw Object.assign(new Error('private-person-729'), { code: 'EACCES' }); }, hostname: () => '' },
    runtime: { ...runtime, env: {}, stdin: undefined, geteuid: () => -1 } });
  assert.equal(p['Username length'].status, 'permission_denied');
  assert.equal(p['Username generic-account pattern'].status, 'permission_denied');
  assert.equal(p['Hostname length'].status, 'absent');
  assert.equal(p['Login-shell executable basename'].status, 'absent');
  assert.equal(p['Standard input terminal status'].status, 'unsupported');
  assert.equal(p['Effective root status'].status, 'error');
  assert.equal(p['Process umask'].status, 'ok');
  assert.ok(!JSON.stringify(p).includes('private-person-729'));
});

test('identity cache contains only derived data and is refreshed per collection', async () => {
  let calls = 0;
  const probes = createSessionProbes({ system: { ...system, userInfo: () => { calls++; return { username: 'private-person-729' }; } }, runtime });
  const cache = new Map();
  for (const probe of probes.slice(0, 5)) await probe.run({ cache });
  assert.equal(calls, 1);
  const cached = await Promise.all([...cache.values()]);
  assert.ok(!JSON.stringify(cached).includes('private-person-729'));
  assert.ok(!JSON.stringify(cached).includes('private-host-816'));
  await collectEnvironment({ probes });
  assert.equal(calls, 2);
});
