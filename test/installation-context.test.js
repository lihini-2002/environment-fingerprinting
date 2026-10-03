import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, createInstallationProbes } from '../src/index.js';
import { registryClass, directoryRelation } from '../src/probes/installation.js';

async function collect(env = {}, platform = 'linux') {
  return (await collectEnvironment({ probes: createInstallationProbes({ runtime: { env }, platform }) })).properties;
}

test('installation metadata is typed and private path names are removed', async () => {
  const p = await collect({ npm_config_user_agent: 'npm/11.6.0 node/v24.10.0 linux x64 private-marker',
    npm_lifecycle_event: 'postinstall', npm_command: 'install', npm_config_global: 'false',
    npm_config_omit: 'optional\ndev\ndev', npm_config_script_shell: '/home/private-person/bin/bash',
    npm_config_cache: '/home/private-person/.npm', npm_config_prefix: '/private/project',
    npm_config_registry: 'https://private-user:private-token@private-host/',
  });
  const expected = {
    'Package-manager identity': 'npm', 'Package-manager version': '11.6.0',
    'npm lifecycle event name': 'postinstall', 'npm command name when exposed': 'install',
    'npm global-install configuration': false, 'npm omit configuration': ['dev', 'optional'],
    'npm script-shell normalized path template': '<posix-root>/home/<user>/<dir>/<dir>',
    'npm cache normalized path template': '<posix-root>/home/<user>/<dir>',
    'npm prefix normalized path template': '<posix-root>/private/<dir>',
  };
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(p[name], { value, status: 'ok' }, name);
  for (const value of ['private-person', 'private-marker', 'private-token', 'private-host', 'project']) {
    assert.ok(!JSON.stringify(Object.values(p)).includes(value), value);
  }
});

test('known user-agent managers preserve only their own versions', async () => {
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    const p = await collect({ npm_config_user_agent: `${name}/1.2.3-beta.1 node/v22.0.0 npm/9.0.0` });
    assert.equal(p['Package-manager identity'].value, name);
    assert.equal(p['Package-manager version'].value, '1.2.3-beta.1');
  }
  const p = await collect({ npm_config_user_agent: 'unknown/private npm/9.0.0', npm_execpath: '/private/pnpm.cjs' });
  assert.equal(p['Package-manager identity'].value, 'pnpm');
  assert.equal(p['Package-manager version'].status, 'absent');
});

test('executable fallback recognizes launchers without exposing their paths', async () => {
  for (const [file, identity] of [['npm-cli.js', 'npm'], ['pnpm.cjs', 'pnpm'], ['yarn-4.1.0.cjs', 'yarn'], ['bun.exe', 'bun']]) {
    const p = await collect({ npm_execpath: `C:\\Users\\private\\${file}` }, 'win32');
    assert.equal(p['Package-manager identity'].value, identity);
    assert.equal(p['Package-manager version'].status, 'absent');
  }
  assert.equal((await collect({ npm_execpath: '/private/wrapper.js' }))['Package-manager identity'].status, 'absent');
});

test('missing defaults remain absent, while explicit empty omit is an empty list', async () => {
  const p = await collect();
  for (const name of ['Package-manager identity', 'Package-manager version', 'npm global-install configuration',
    'npm omit configuration', 'npm script-shell normalized path template', 'npm cache normalized path template', 'npm prefix normalized path template']) {
    assert.deepEqual(p[name], { value: null, status: 'absent' });
  }
  assert.deepEqual((await collect({ npm_config_omit: '' }))['npm omit configuration'], { value: [], status: 'ok' });
  for (const [value, expected] of [['true', true], ['1', true], ['false', false], ['0', false]]) {
    assert.equal((await collect({ npm_config_global: value }))['npm global-install configuration'].value, expected);
  }
});

test('uppercase fallback and lowercase precedence are deterministic', async () => {
  const p = await collect({ NPM_CONFIG_GLOBAL: 'true', npm_config_global: 'false',
    NPM_COMMAND: 'ci', NPM_CONFIG_OMIT: 'peer,dev' });
  assert.equal(p['npm global-install configuration'].value, false);
  assert.equal(p['npm command name when exposed'].value, 'ci');
  assert.deepEqual(p['npm omit configuration'].value, ['dev', 'peer']);
});

test('relative config paths and bare shell commands are not resolved against a guessed cwd', async () => {
  const p = await collect({ npm_config_cache: '../private-cache', npm_config_prefix: './private-prefix', npm_config_script_shell: 'bash' });
  assert.equal(p['npm cache normalized path template'].value, '<relative>/../<dir>');
  assert.equal(p['npm prefix normalized path template'].value, '<relative>/<dir>');
  assert.equal(p['npm script-shell normalized path template'].value, '<command>');
  const win = await collect({ npm_config_cache: 'C:\\Users\\private\\cache', npm_config_prefix: 'C:private' }, 'win32');
  assert.equal(win['npm cache normalized path template'].value, '<drive>/Users/<user>/<dir>');
  assert.equal(win['npm prefix normalized path template'].status, 'unsupported');
});

test('invalid and oversized values fail independently without retaining input', async () => {
  const p = await collect({ npm_config_global: 'private-secret', npm_config_omit: 'dev private-secret',
    npm_lifecycle_event: 'https://private-secret/', npm_config_cache: 'x'.repeat(65537),
    npm_command: 'install', npm_config_user_agent: 'npm/private-secret' });
  assert.equal(p['npm global-install configuration'].status, 'error');
  assert.equal(p['npm omit configuration'].status, 'error');
  assert.equal(p['npm lifecycle event name'].status, 'error');
  assert.equal(p['npm cache normalized path template'].status, 'truncated');
  assert.equal(p['Package-manager identity'].value, 'npm');
  assert.equal(p['Package-manager version'].status, 'absent');
  assert.equal(p['npm command name when exposed'].value, 'install');
  assert.ok(!JSON.stringify(p).includes('private-secret'));
});

test('probes never enumerate environment configuration or inspect unrelated secrets', async () => {
  const env = new Proxy({ npm_lifecycle_event: 'postinstall' }, {
    ownKeys() { assert.fail('Environment enumeration'); },
    get(target, key) {
      if (/token|auth/i.test(String(key))) assert.fail('Unrelated config accessed');
      return target[key];
    },
  });
  assert.equal((await collect(env))['npm lifecycle event name'].value, 'postinstall');
});

test('registry classification strips credentials, ports, paths and private hostnames', () => {
  for (const [url, expected] of [
    ['https://user:secret@registry.npmjs.org/private?token=secret', 'npm_public'],
    ['https://REGISTRY.NPMJS.ORG.:443/', 'npm_public'],
    ['https://registry.npmjs.org.private.example/', 'dns_name'],
    ['http://secret:password@localhost:4873/', 'localhost'],
    ['http://registry.localhost/', 'localhost'], ['http://127.0.0.1/', 'ipv4'],
    ['https://[::1]:4873/', 'ipv6'], ['https://private-registry/', 'single_label'],
    ['https://private.example/', 'dns_name'],
  ]) assert.equal(registryClass(url), expected);
  assert.throws(() => registryClass('file:///private/path'), /protocol/);
  assert.throws(() => registryClass('not a url'), /URL/);
});

test('user-agent normalization retains only allowlisted runtime components', async () => {
  const p = await collect({ npm_config_user_agent:
    'pnpm/9.1.2-private.build npm/10.0.0 node/v22.4.0 linux x64 workspaces/true ci/private-company private-host node/v99.0.0' });
  assert.deepEqual(p['npm user-agent normalized runtime components'].value, {
    products: [{ name: 'pnpm', version: '9.1.2' }, { name: 'npm', version: '10.0.0' }, { name: 'node', version: '22.4.0' }],
    platform: 'linux', architecture: 'x64',
  });
  assert.ok(!JSON.stringify(p['npm user-agent normalized runtime components']).includes('private'));
  assert.equal((await collect({ npm_config_user_agent: 'private-only' }))['npm user-agent normalized runtime components'].status, 'absent');
});

test('directory relationships use real lexical paths, not redacted templates', () => {
  for (const [cwd, initial, expected] of [
    ['/work/app/', '/work/./app', 'same'], ['/work/app/node_modules/pkg', '/work/app', 'descendant'],
    ['/work', '/work/app', 'ancestor'], ['/work/apple', '/work/app', 'unrelated'],
    ['/work/private-a', '/work/private-b', 'unrelated'],
  ]) assert.equal(directoryRelation(cwd, initial, 'linux'), expected);
  assert.equal(directoryRelation('C:\\WORK\\app', 'c:\\work\\app\\', 'win32'), 'same');
  assert.equal(directoryRelation('D:\\work', 'C:\\work', 'win32'), 'unrelated');
  assert.equal(directoryRelation('\\\\server\\share\\app', '\\\\server\\share\\', 'win32'), 'descendant');
  assert.throws(() => directoryRelation('/work', './relative', 'linux'), /absolute/);
});

test('new installation properties sanitize paths and count node_modules nesting', async () => {
  const probes = createInstallationProbes({ platform: 'linux', runtime: {
    cwd: () => '/home/private-user/project/node_modules/@secret/a/node_modules/b',
    env: { INIT_CWD: '/home/private-user/project', npm_config_userconfig: '/home/private-user/.npmrc',
      npm_config_registry: 'https://private-user:password@private-registry.example/path' },
  } });
  const { properties: p } = await collectEnvironment({ probes });
  assert.equal(p['npm user-config normalized path template'].value, '<posix-root>/home/<user>/<dir>');
  assert.equal(p['INIT_CWD normalized path template'].value, '<posix-root>/home/<user>/<dir>');
  assert.equal(p['Lifecycle working-directory relation to INIT_CWD'].value, 'descendant');
  assert.equal(p['Package installation depth beneath node_modules'].value, 2);
  for (const secret of ['private-user', 'password', 'private-registry', '@secret']) assert.ok(!JSON.stringify(p).includes(secret));
});

test('installation depth is syntactic and independent of absent INIT_CWD', async () => {
  for (const [cwd, expected] of [['/work', 0], ['/work/node_modules', 0],
    ['/work/node_modules/@scope/pkg', 1], ['/work/node_modules/.pnpm/pkg/node_modules/pkg', 2]]) {
    const { properties: p } = await collectEnvironment({ probes: createInstallationProbes({
      platform: 'linux', runtime: { env: {}, cwd: () => cwd },
    }) });
    assert.deepEqual(p['Package installation depth beneath node_modules'], { value: expected, status: 'ok' });
    assert.equal(p['Lifecycle working-directory relation to INIT_CWD'].status, 'absent');
  }
});

test('new sources respect input bounds and isolate cwd access failures', async () => {
  const { properties: p } = await collectEnvironment({ probes: createInstallationProbes({ platform: 'linux', runtime: {
    env: { INIT_CWD: '/work', npm_config_registry: 'x'.repeat(65537), npm_config_user_agent: 'npm/11.0.0' },
    cwd() { throw Object.assign(new Error('private-path'), { code: 'EACCES' }); },
  } }) });
  assert.equal(p['npm registry hostname class with user information removed'].status, 'truncated');
  assert.equal(p['Lifecycle working-directory relation to INIT_CWD'].status, 'permission_denied');
  assert.equal(p['Package installation depth beneath node_modules'].status, 'permission_denied');
  assert.equal(p['npm user-agent normalized runtime components'].status, 'ok');
});
