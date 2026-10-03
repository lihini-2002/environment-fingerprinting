import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectEnvironment } from '../src/index.js';
import { createUserPackageProbes, userPackagePaths } from '../src/probes/user-package.js';

const file = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const cacheCount = 'User npm cache bounded entry count';
const logCount = 'User npm log directory bounded file count';
const collect = async (options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createUserPackageProbes({ platform: 'linux', homeDirectory: () => '/home/private', ...options }), timeoutMs,
})).properties;

test('real user fixture reports immediate counts and does not retain names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'user-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['.npm/_logs/nested', '.cache/yarn', '.local/share/pnpm/store']) await mkdir(path.join(root, name), { recursive: true });
  for (const name of ['.npmrc', '.npm/private-entry', '.npm/_logs/private-log']) await writeFile(path.join(root, name), 'never read');
  const p = await collect({ homeDirectory: () => root });
  for (const name of ['User .npmrc file presence', 'User npm cache directory presence', 'User yarn cache directory presence', 'User pnpm store directory presence']) assert.equal(p[name].value, true);
  assert.deepEqual(p[cacheCount], { value: 2, status: 'ok' });
  assert.deepEqual(p[logCount], { value: 1, status: 'ok' });
  assert.ok(!JSON.stringify(p).includes('private-'));
  assert.ok(!JSON.stringify(p).includes(root));
  let closed = 0;
  const bounded = await collect({ homeDirectory: () => root, entryLimit: 1,
    openDirectory: async (...args) => {
      const handle = await opendir(...args);
      return { read: () => handle.read(), close: async () => { closed++; await handle.close(); } };
    },
  });
  assert.equal(bounded[cacheCount].status, 'truncated');
  assert.equal(bounded[logCount].status, 'truncated');
  assert.equal(closed, 2);
});

test('missing paths, empty directories, wrong types and permissions stay distinct', async () => {
  const missing = await collect({ statFile: async () => null });
  assert.equal(missing['User npm cache directory presence'].value, false);
  assert.equal(missing[cacheCount].status, 'absent');
  const wrong = await collect({ statFile: async () => file });
  assert.equal(wrong['User npm cache directory presence'].value, false);
  let closed = 0;
  const empty = await collect({ statFile: async () => directory,
    openDirectory: async () => ({ read: async () => null, close: async () => { closed++; } }),
  });
  assert.deepEqual(empty[cacheCount], { value: 0, status: 'ok' });
  assert.equal(closed, 2);
  const denied = await collect({ statFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } });
  assert.equal(denied[cacheCount].status, 'permission_denied');
});

test('directory handles close on failures and timeout cancellation', async () => {
  let closed = 0;
  const p = await collect({ statFile: async () => directory,
    openDirectory: async () => ({ read: async () => { throw new Error('failure'); }, close: async () => { closed++; } }),
  });
  assert.equal(p[cacheCount].status, 'error');
  assert.equal(closed, 2);
  closed = 0;
  const timed = await collect({ statFile: async () => directory,
    openDirectory: async () => ({ read: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return file; }, close: async () => { closed++; } }),
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timed[cacheCount].status, 'timeout');
  assert.equal(closed, 2);
});

test('platform paths and legacy fallbacks use fixed bounded candidate sets', async () => {
  assert.equal(userPackagePaths('C:\\Users\\private', 'win32').npm[0], 'C:\\Users\\private\\AppData\\Local\\npm-cache');
  assert.equal(userPackagePaths('/Users/private', 'darwin').pnpm[0], '/Users/private/Library/pnpm/store');
  const p = await collect({ platform: 'win32', homeDirectory: () => 'C:\\Users\\private',
    statFile: async (name) => name.endsWith('\\.npm') ? directory : null,
    openDirectory: async () => ({ read: async () => null, close: async () => {} }),
  });
  assert.equal(p['User npm cache directory presence'].value, true);
  const unsupported = await collect({ platform: 'unknown' });
  assert.equal(unsupported[cacheCount].status, 'unsupported');
});
