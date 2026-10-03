import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectEnvironment, createEnvironmentProbes } from '../src/index.js';
import { PATH_ENTRY_LIMIT, PATH_LENGTH_LIMIT } from '../src/probes/tools.js';

const indicators = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL',
  'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID', 'BITBUCKET_BUILD_NUMBER', 'AWS_EXECUTION_ENV',
  'KUBERNETES_SERVICE_HOST', 'SSH_AUTH_SOCK',
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
];

test('developer and credential indicators inspect names only, including empty and inherited values', async () => {
  const variables = ['VIRTUAL_ENV', 'CONDA_PREFIX', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN'];
  const property = (name) => `${name} variable presence${variables.indexOf(name) >= 2 ? ' without reading value' : ''}`;
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const lowercase of [false, true]) {
      const env = {};
      for (const name of variables) Object.defineProperty(env, lowercase ? name.toLowerCase() : name, {
        enumerable: true, get() { assert.fail('must not read credential or tooling values'); },
      });
      const p = await collect(env, { platform });
      for (const name of variables) assert.deepEqual(p[property(name)], { value: !lowercase || platform === 'win32', status: 'ok' });
    }
  }
  for (const inherited of [false, true]) {
    const values = Object.fromEntries(variables.map((name) => [name, '']));
    const p = await collect(inherited ? Object.create(values) : values);
    for (const name of variables) assert.deepEqual(p[property(name)], { value: !inherited, status: 'ok' });
  }
});

const categories = 'PATH normalized directory categories';
const missing = 'PATH nonexistent-entry count';
const count = 'PATH entry count';
const directory = { isDirectory: () => true };
const collect = async (env = {}, options = {}, timeoutMs = 1500) => (await collectEnvironment({
  probes: createEnvironmentProbes({ runtime: { env, cwd: () => '/project' }, platform: 'linux', statFile: async () => directory, ...options }), timeoutMs,
})).properties;

test('environment count and CI presence never read CI or unrelated values', async () => {
  const env = { PATH: '/bin', CI: '', GITHUB_ACTIONS: 'false', GITLAB_CI: '0', JENKINS_URL: 'private' };
  Object.defineProperty(env, 'SECRET', { enumerable: true, get() { assert.fail('secret read'); } });
  for (const name of indicators) Object.defineProperty(env, name, { enumerable: true, get() { assert.fail('indicator value read'); } });
  const p = await collect(env);
  assert.equal(p['Environment-variable count'].value, indicators.length + 2);
  for (const name of indicators) assert.deepEqual(p[`${name} variable presence`], { value: true, status: 'ok' });
  const absent = await collect(Object.create(Object.fromEntries(indicators.map((name) => [name, 'inherited']))));
  assert.equal(absent['Environment-variable count'].value, 0);
  for (const name of indicators) assert.deepEqual(absent[`${name} variable presence`], { value: false, status: 'ok' });
  assert.equal(absent[count].status, 'absent');
});

test('PATH categories preserve order and duplicates without retaining private names', async () => {
  const p = await collect({ PATH: ':/usr/bin:/usr/local/sbin:relative:/home/private/bin:/secret/node_modules/.bin:/opt/private:/usr/bin' });
  assert.equal(p[count].value, 8);
  assert.deepEqual(p[categories].value, ['current_directory', 'system_bin', 'system_bin', 'relative', 'user_directory', 'node_modules_bin', 'other_absolute', 'system_bin']);
  assert.ok(!JSON.stringify(p).includes('private'));
  const empty = await collect({ PATH: '' });
  assert.equal(empty[count].value, 1);
  assert.deepEqual(empty[categories].value, ['current_directory']);
  assert.equal(empty[missing].value, 0);
});

test('real directory checks count missing duplicates and non-directories', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'file'), 'not read');
  await symlink(path.join(root, 'bin'), path.join(root, 'link'));
  await symlink(path.join(root, 'absent'), path.join(root, 'broken'));
  const p = (await collectEnvironment({ probes: createEnvironmentProbes({ runtime: { env: { PATH: ':bin:link:absent:absent:file:broken' }, cwd: () => root } }) })).properties;
  assert.equal(p[count].value, 7);
  assert.deepEqual(p[missing], { value: 4, status: 'ok' });
});

test('duplicate directories are checked once but counted per PATH entry', async () => {
  const calls = [];
  const p = await collect({ PATH: '/absent:/absent:bin:./bin' }, { statFile: async (entry) => {
    calls.push(entry);
    if (entry === '/absent') throw Object.assign(new Error(), { code: 'ENOENT' });
    return directory;
  } });
  assert.equal(p[missing].value, 2);
  assert.deepEqual(calls, ['/absent', '/project/bin']);
});

test('Windows handles case-insensitive keys, quotes, separators and relative entries', async () => {
  const calls = [];
  const p = await collect({}, { platform: 'win32', runtime: { env: { Path: '"C:\\Windows\\System32";C:\\Users\\private\\bin;C:\\proj\\node_modules\\.bin;;relative', ci: 'false' }, cwd: () => 'C:\\project' },
    statFile: async (entry) => { calls.push(entry); return directory; },
  });
  assert.equal(p['CI variable presence'].value, true);
  assert.equal(p[count].value, 5);
  assert.deepEqual(p[categories].value, ['windows_system', 'user_directory', 'node_modules_bin', 'current_directory', 'relative']);
  assert.deepEqual(calls.slice(-2), ['C:\\project', 'C:\\project\\relative']);
  const unsupported = await collect({}, { platform: 'win32', runtime: { env: { PATH: 'C:relative' }, cwd: () => 'D:\\project' } });
  assert.equal(unsupported[missing].status, 'unsupported');
  assert.equal(unsupported[count].value, 1);
});

test('PATH bounds and malformed input do not affect CI metadata', async () => {
  const p = await collect({ CI: '', PATH: Array(PATH_ENTRY_LIMIT + 1).fill('/bin').join(':') }, { statFile: async () => assert.fail('over-limit scan') });
  assert.equal(p[count].value, PATH_ENTRY_LIMIT + 1);
  assert.equal(p[categories].status, 'truncated');
  assert.equal(p[categories].value.length, PATH_ENTRY_LIMIT);
  assert.equal(p[missing].status, 'truncated');
  for (const [PATH, status] of [['a'.repeat(PATH_LENGTH_LIMIT + 1), 'truncated'], ['/bad\0path', 'error'], [42, 'error']]) {
    const q = await collect({ CI: 'false', PATH });
    for (const name of [count, categories, missing]) assert.equal(q[name].status, status);
    assert.equal(q['CI variable presence'].value, true);
  }
});

test('permissions and timeouts are not counted as missing', async () => {
  const denied = await collect({ PATH: '/denied' }, { statFile: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } });
  assert.equal(denied[missing].status, 'permission_denied');
  assert.equal(denied[count].value, 1);
  assert.equal(denied[categories].status, 'ok');
  let calls = 0;
  const timed = await collect({ PATH: '/slow:/later', CI: '' }, { statFile: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return directory;
  } }, 5);
  assert.equal(timed[missing].status, 'timeout');
  assert.equal(timed['CI variable presence'].value, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('collection caches are refreshed on the next collection', async () => {
  const env = { PATH: '/bin' };
  const probes = createEnvironmentProbes({ runtime: { env, cwd: () => '/' }, statFile: async () => directory });
  const first = await collectEnvironment({ probes });
  env.CI = '';
  env.PATH = '/bin:/usr/bin';
  const second = await collectEnvironment({ probes });
  assert.equal(first.properties[count].value, 1);
  assert.equal(second.properties[count].value, 2);
  assert.equal(second.properties['CI variable presence'].value, true);
});


test('indicator presence handles empty values and platform casing without inspecting values', async () => {
  for (const value of ['', 'false', '0']) {
    const env = Object.fromEntries(indicators.map((name) => [name, value]));
    const p = await collect(env);
    for (const name of indicators) assert.deepEqual(p[`${name} variable presence`], { value: true, status: 'ok' });
  }
  const env = Object.fromEntries(indicators.map((name) => [name.toLowerCase(), 'private-value']));
  for (const platform of ['linux', 'win32']) {
    const p = await collect(env, { platform });
    for (const name of indicators) assert.deepEqual(p[`${name} variable presence`], { value: platform === 'win32', status: 'ok' });
    assert.ok(!JSON.stringify(p).includes('private-value'));
  }
});
