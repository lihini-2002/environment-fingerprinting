import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectEnvironment, createRuntimeProbes } from '../src/index.js';
import { inspectStartupTokens, tokenizeNodeOptions } from '../src/probes/runtime.js';

const runtime = {
  versions: { node: '22.10.0', v8: '12.4', modules: '127', napi: '9', uv: '1.48', openssl: '3.0', icu: '75.1' },
  version: 'v22.10.0', execPath: '/home/private-user/private-runtime/bin/node',
  execArgv: [], env: {}, cwd: () => '/home/private-user/project',
};
async function collect(overrides = {}, options = {}) {
  return (await collectEnvironment({ probes: createRuntimeProbes({
    runtime: { ...runtime, ...overrides }, platform: 'linux',
    searchPaths: () => ['/home/private-user/project/node_modules', '/home/private-user/.node_modules'],
    ...options,
  }) })).properties;
}

test('runtime versions and environment values preserve requested types', async () => {
  const p = await collect({ env: { NODE_ENV: 'production', NODE_OPTIONS: '', NODE_PATH: '' } });
  for (const [label, key] of [['Node.js version', 'node'], ['V8 engine version', 'v8'],
    ['Node.js module ABI version', 'modules'], ['Node.js N-API version', 'napi'],
    ['Node.js libuv version', 'uv'], ['Node.js OpenSSL version', 'openssl'], ['Node.js ICU version', 'icu']]) {
    assert.deepEqual(p[label], { value: runtime.versions[key], status: 'ok' });
  }
  assert.equal(p['NODE_ENV value'].value, 'production');
  assert.equal(p['NODE_OPTIONS variable presence'].value, true);
  assert.equal(p['NODE_PATH variable presence'].value, true);
  assert.equal(p['Node.js inspector activation flag presence'].value, false);
  const absent = await collect({ versions: {}, env: {} });
  assert.equal(absent['Node.js version'].value, '22.10.0');
  assert.equal(absent['Node.js ICU version'].status, 'absent');
  assert.equal(absent['NODE_ENV value'].status, 'absent');
  assert.equal(absent['NODE_PATH variable presence'].value, false);
  assert.deepEqual((await collect({ env: { NODE_ENV: '' } }))['NODE_ENV value'], { value: '', status: 'ok' });
});

test('activation and require flags are recognized across spellings and assignments', () => {
  for (const flag of ['--inspect', '--inspect=127.0.0.1:0', '--inspect-brk', '--inspect-wait=0', '--inspect_brk=0']) {
    assert.equal(inspectStartupTokens([flag]).inspector, true, flag);
  }
  for (const tokens of [['--require', 'node:fs'], ['--require=node:fs'], ['-r', 'node:path'], ['-rnode:path'], ['-r=node:path']]) {
    assert.equal(inspectStartupTokens(tokens).requirePreload, true);
  }
  assert.deepEqual(inspectStartupTokens(['--inspect-port=9229', '--inspect-publish-uid=http', '--no-inspect', '--require-module', '--import=node:fs']),
    { inspector: false, requirePreload: false });
});

test('NODE_OPTIONS tokenization preserves quoted values without shell interpretation', async () => {
  assert.deepEqual(tokenizeNodeOptions('--title "" --inspect'), ['--title', '--inspect']);
  assert.deepEqual(tokenizeNodeOptions('--require "C:\\path with spaces\\file.js" --inspect'),
    ['--require', 'C:path with spacesfile.js', '--inspect']);
  assert.deepEqual(tokenizeNodeOptions('--title="--inspect --require=private"'), ['--title=--inspect --require=private']);
  const p = await collect({ env: { NODE_OPTIONS: '--require "/private/preload module.cjs" --inspect=0' } });
  assert.equal(p['Node.js require-preload flag presence'].value, true);
  assert.equal(p['Node.js inspector activation flag presence'].value, true);
  assert.ok(!JSON.stringify(p).includes('preload module'));
  assert.throws(() => tokenizeNodeOptions('--title="bad'), /quote/);
});

test('option values, eval source, negations and arguments after -- do not cause false positives', async () => {
  const p = await collect({
    execArgv: ['--title', '--inspect', '--eval', '--require=private', '--inspect-port=1', '--', '--inspect'],
    env: { NODE_OPTIONS: '--title="--inspect --require=private" --no-inspect' },
  });
  assert.equal(p['Node.js inspector activation flag presence'].value, false);
  assert.equal(p['Node.js require-preload flag presence'].value, false);
  const positive = await collect({ execArgv: ['--inspect', '--no-inspect'] });
  assert.equal(positive['Node.js inspector activation flag presence'].value, true); // Presence, not effective state.
});

test('executable and module paths are redacted in order, including relative and Windows paths', async () => {
  const p = await collect({}, { searchPaths: () => ['node_modules', '/opt/secret-a', '/opt/secret-b'] });
  assert.deepEqual(p['Node.js module-search-path normalized templates'].value,
    ['<posix-root>/home/<user>/<dir>/node_modules', '<posix-root>/opt/<dir>', '<posix-root>/opt/<dir>']);
  assert.ok(!JSON.stringify(p).includes('private-user'));
  assert.ok(!JSON.stringify(p).includes('private-runtime'));
  const win = await collect({ execPath: 'C:\\Users\\private-user\\node.exe' }, {
    platform: 'win32', searchPaths: () => ['\\\\secret-server\\secret-share\\node_modules'],
  });
  assert.equal(win['Node.js executable normalized path template'].value, '<drive>/Users/<user>/<dir>');
  assert.deepEqual(win['Node.js module-search-path normalized templates'].value, ['<unc-root>/node_modules']);
});

test('bounds, malformed options and denied resolution use explicit statuses', async () => {
  for (const [raw, status] of [['--require="unterminated', 'error'], ['x'.repeat(65537), 'truncated']]) {
    const p = await collect({ env: { NODE_OPTIONS: raw } });
    assert.equal(p['Node.js inspector activation flag presence'].status, status);
    assert.equal(p['Node.js require-preload flag presence'].status, status);
    assert.equal(p['NODE_OPTIONS variable presence'].value, true);
    assert.equal(p['Node.js version'].status, 'ok');
  }
  const many = await collect({}, { searchPaths: () => Array(129).fill('/private/path') });
  assert.equal(many['Node.js module-search-path normalized templates'].status, 'truncated');
  assert.equal(many['Node.js module-search-path normalized templates'].value.length, 128);
  const denied = await collect({}, { searchPaths: () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); } });
  assert.equal(denied['Node.js module-search-path normalized templates'].status, 'permission_denied');
});

test('a real Node subprocess observes preloads without mistaking eval text for flags', async () => {
  const api = new URL('../src/index.js', import.meta.url).href;
  const code = `import { collectEnvironment, createRuntimeProbes } from ${JSON.stringify(api)}; const report = await collectEnvironment({ probes: createRuntimeProbes() }); console.log(JSON.stringify(report.properties));`;
  const env = { ...process.env, NODE_OPTIONS: '--require "node:path"', NODE_ENV: 'test' };
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', code], { env, timeout: 5000 });
  const p = JSON.parse(stdout);
  assert.equal(p['Node.js require-preload flag presence'].value, true);
  assert.equal(p['Node.js inspector activation flag presence'].value, false);
  assert.equal(p['Node.js version'].value, process.versions.node);
  assert.equal(p['Node.js module-search-path normalized templates'].status, 'ok');
});
