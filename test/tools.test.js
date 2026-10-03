import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, chmod, symlink, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEnvironment, createToolProbes } from '../src/index.js';
import { PATH_ENTRY_LIMIT, PATH_LENGTH_LIMIT } from '../src/probes/tools.js';

const executable = { isFile: () => true, mode: 0o755 };
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createToolProbes({ runtime: { env: { PATH: '/bin' }, cwd: () => '/project' }, platform: 'linux',
    statFile: async () => null, accessFile: async () => {}, ...options }), timeoutMs,
})).properties;
const property = (name) => `${name} executable availability`;

test('all five groups find supported basenames without returning paths', async () => {
  const p = await collect({ statFile: async (candidate) =>
    ['/bin/git', '/bin/python3', '/bin/clang++', '/bin/gmake', '/bin/docker'].includes(candidate) ? executable : null });
  for (const name of ['Git', 'Python', 'Compiler', 'Make', 'Docker']) assert.deepEqual(p[property(name)], { value: true, status: 'ok' });
  assert.ok(!JSON.stringify(p).includes('/bin'));
});

test('real POSIX files are checked without execution; symlinks follow their targets', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tool-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'executed');
  await writeFile(path.join(root, 'git'), `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(path.join(root, 'git'), 0o755);
  await writeFile(path.join(root, 'python'), 'not executable');
  await chmod(path.join(root, 'python'), 0o644);
  await mkdir(path.join(root, 'gcc'));
  await symlink(path.join(root, 'git'), path.join(root, 'make'));
  await symlink(path.join(root, 'missing'), path.join(root, 'docker'));
  const p = (await collectEnvironment({ probes: createToolProbes({ runtime: { env: { PATH: root }, cwd: () => root } }) })).properties;
  assert.equal(p[property('Git')].value, true);
  assert.equal(p[property('Make')].value, true);
  for (const name of ['Python', 'Compiler', 'Docker']) assert.deepEqual(p[property(name)], { value: false, status: 'ok' });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('PATH absence, empty entries, relative entries and duplicates are explicit', async () => {
  const absent = await collect({ runtime: { env: {}, cwd: () => '/project' } });
  assert.equal(absent[property('Git')].status, 'absent');
  const calls = [];
  const p = await collect({ runtime: { env: { PATH: ':bin:/project/bin' }, cwd: () => '/project' },
    statFile: async (candidate) => { calls.push(candidate); return null; },
  });
  assert.deepEqual(calls.filter((candidate) => candidate.endsWith('/git')), ['/project/git', '/project/bin/git']);
  assert.deepEqual(p[property('Git')], { value: false, status: 'ok' });
});

test('Windows uses case-insensitive PATH key, quoted directories and fixed suffixes', async () => {
  const calls = [];
  const p = await collect({ platform: 'win32', runtime: { env: { Path: '"C:\\Tools";C:\\TOOLS;relative' }, cwd: () => 'C:\\project' },
    statFile: async (candidate) => { calls.push(candidate); return candidate === 'C:\\Tools\\git.cmd' || candidate === 'C:\\project\\relative\\cl.exe' ? executable : null; },
    accessFile: async () => { assert.fail('Windows must not use POSIX execute checks'); },
  });
  assert.equal(p[property('Git')].value, true);
  assert.equal(p[property('Compiler')].value, true);
  assert.ok(calls.includes('C:\\Tools\\git.exe'));
  assert.ok(!calls.some((candidate) => candidate.startsWith('C:\\TOOLS')));
  const relative = await collect({ platform: 'win32', runtime: { env: { PATH: 'C:tools' }, cwd: () => 'D:\\project' } });
  assert.equal(relative[property('Git')].status, 'unsupported');
});

test('bounds prevent false negatives but allow an early positive result', async () => {
  const env = { PATH: Array.from({ length: PATH_ENTRY_LIMIT + 1 }, (_, i) => `/dir${i}`).join(':') };
  const calls = [];
  const p = await collect({ runtime: { env, cwd: () => '/' }, statFile: async (candidate) => { calls.push(candidate); return null; } });
  assert.equal(p[property('Git')].status, 'truncated');
  assert.equal(calls.filter((candidate) => candidate.endsWith('/git')).length, PATH_ENTRY_LIMIT);
  assert.ok(!calls.some((candidate) => candidate.startsWith(`/dir${PATH_ENTRY_LIMIT}/`)));
  const found = await collect({ runtime: { env, cwd: () => '/' }, statFile: async () => executable });
  assert.equal(found[property('Git')].value, true);
  for (const [PATH, expected] of [['x'.repeat(PATH_LENGTH_LIMIT + 1), 'truncated'], ['/bin\0bad', 'error']]) {
    const invalid = await collect({ runtime: { env: { PATH }, cwd: () => '/' }, statFile: async () => assert.fail('invalid PATH must not be searched') });
    assert.equal(invalid[property('Git')].status, expected);
  }
});

test('permission failures do not hide later matches or become false absence', async () => {
  const options = { runtime: { env: { PATH: '/denied:/found' }, cwd: () => '/' },
    statFile: async (candidate) => {
      if (candidate.startsWith('/denied')) throw Object.assign(new Error('private path'), { code: 'EACCES' });
      return candidate === '/found/git' ? executable : null;
    },
  };
  const p = await collect(options);
  assert.deepEqual(p[property('Git')], { value: true, status: 'ok' });
  assert.equal(p[property('Docker')].status, 'permission_denied');
  const denied = await collect({ statFile: async () => executable,
    accessFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); },
  });
  assert.equal(denied[property('Git')].status, 'permission_denied');
});

test('timeouts abort further searches and one failed group does not stop others', async () => {
  let slowCalls = 0;
  const p = await collect({ statFile: async (candidate) => {
    if (candidate === '/bin/git') {
      slowCalls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return executable;
    }
    return executable;
  } }, 5);
  assert.equal(p[property('Git')].status, 'timeout');
  assert.equal(p[property('Python')].value, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(slowCalls, 1);
});
