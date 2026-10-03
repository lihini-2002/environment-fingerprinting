import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEnvironment, createOSProbes, propertyNames } from '../src/index.js';
import { parseOSRelease, readOSRelease, readBoundedFile, OS_RELEASE_LIMIT } from '../src/probes/os-release.js';

const system = {
  type: () => 'Linux', release: () => '6.8.0', version: () => '#1 SMP',
  machine: () => 'x86_64', endianness: () => 'LE', uptime: () => 0,
};
const collect = (options) => collectEnvironment({ probes: createOSProbes({ system, ...options }) });

test('Linux distinguishes machine/process architecture and preserves zero uptime', async () => {
  const report = await collect({ platform: 'linux', processArch: 'ia32',
    linuxRelease: async () => ({ ID: 'ubuntu', VERSION_ID: '24.04', ID_LIKE: 'debian' }) });
  assert.deepEqual(propertyNames.slice(0, 10).map((name) => report.properties[name].value),
    ['Linux', 'ubuntu', '24.04', 'debian', '6.8.0', '#1 SMP', 'x86_64', 'ia32', 'LE', 0]);
});

test('rolling/minimal Linux distributions do not invent absent fields', async () => {
  const report = await collect({ platform: 'linux', linuxRelease: async () => ({ ID: 'arch' }) });
  assert.equal(report.properties[propertyNames[2]].status, 'absent');
  assert.equal(report.properties[propertyNames[3]].status, 'absent');
});

test('macOS, Windows, and unsupported distro platforms', async () => {
  const mac = await collect({ platform: 'darwin', macVersion: async () => '15.2' });
  assert.deepEqual(propertyNames.slice(1, 4).map((n) => mac.properties[n].value), ['macos', '15.2', 'darwin']);
  const win = await collect({ platform: 'win32', system: { ...system, release: () => '10.0.26100' } });
  assert.deepEqual(propertyNames.slice(1, 4).map((n) => win.properties[n].value), ['windows', '10.0.26100', 'windows']);
  const other = await collect({ platform: 'freebsd', system: { ...system, machine: undefined } });
  assert.equal(other.properties[propertyNames[1]].status, 'unsupported');
  assert.equal(other.properties[propertyNames[6]].status, 'unsupported');
});

test('restricted Linux metadata does not prevent native OS probes', async () => {
  for (const [code, status] of [['ENOENT', 'absent'], ['EACCES', 'permission_denied'], ['EPROBETRUNCATED', 'truncated']]) {
    const report = await collect({ platform: 'linux', linuxRelease: async () => { throw Object.assign(new Error(), { code }); } });
    for (const name of propertyNames.slice(1, 4)) assert.equal(report.properties[name].status, status);
    assert.equal(report.properties['Kernel release'].status, 'ok');
  }
});

test('os-release quoting, comments and shell-like text are parsed as data', () => {
  const parsed = parseOSRelease('# comment\nID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=\'debian linux\'\nNAME="$(echo nope)"');
  assert.equal(parsed.ID, 'ubuntu');
  assert.equal(parsed.VERSION_ID, '24.04');
  assert.equal(parsed.ID_LIKE, 'debian linux');
  assert.equal(parsed.NAME, '$(echo nope)');
  assert.throws(() => parseOSRelease('ID="unterminated'), SyntaxError);
});

test('os-release fallback is only used when /etc entry is missing', async () => {
  const visited = [];
  const parsed = await readOSRelease({ readFile: async (path) => {
    visited.push(path);
    if (path === '/etc/os-release') throw Object.assign(new Error(), { code: 'ENOENT' });
    return 'ID=alpine';
  } });
  assert.equal(parsed.ID, 'alpine');
  assert.deepEqual(visited, ['/etc/os-release', '/usr/lib/os-release']);
  let calls = 0;
  await assert.rejects(readOSRelease({ readFile: async () => {
    calls++;
    throw Object.assign(new Error(), { code: 'EACCES' });
  } }), { code: 'EACCES' });
  assert.equal(calls, 1);
  const primary = await readOSRelease({ readFile: async (path) => {
    assert.equal(path, '/etc/os-release');
    return 'ID=arch';
  } });
  assert.equal(primary.VERSION_ID, undefined);
});

test('file reads are bounded and reject non-regular input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'probe-file-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'os-release');
  await writeFile(file, 'ID=alpine\n');
  assert.equal(await readBoundedFile(file), 'ID=alpine\n');
  await writeFile(file, 'x'.repeat(OS_RELEASE_LIMIT + 1));
  await assert.rejects(readBoundedFile(file), { code: 'EPROBETRUNCATED' });
  await assert.rejects(readBoundedFile(directory));
});
