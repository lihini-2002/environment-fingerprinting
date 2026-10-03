import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectEnvironment, createProjectProbes } from '../src/index.js';
import { ancestorDirectories, PACKAGE_JSON_LIMIT } from '../src/probes/project.js';

const file = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const countName = 'Ancestor project direct dependency count from package.json';
const devName = 'Ancestor project development dependency count from package.json';
async function collect(options = {}, timeoutMs = 1500) {
  return (await collectEnvironment({ probes: createProjectProbes({
    runtime: { cwd: () => '/project/node_modules/@scope/probe' }, platform: 'linux',
    statFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, ...options,
  }), timeoutMs })).properties;
}

test('real project fixture exposes markers and nearest project counts, not package counts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'node_modules', '@private', 'probe');
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(root, '.git'));
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) await writeFile(path.join(root, name), 'contents must not be read');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { privateA: '1', privateB: '2' }, devDependencies: { privateC: '3' }, scripts: { install: 'not executed' } }));
  await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"wrong":"1"}}');
  const { properties: p } = await collectEnvironment({ probes: createProjectProbes({ runtime: { cwd: () => cwd } }) });
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'package.json']) {
    assert.deepEqual(p[`Ancestor project ${name} presence`], { value: true, status: 'ok' });
  }
  assert.equal(p['Ancestor project .git directory presence'].value, true);
  assert.equal(p['Ancestor project node_modules directory presence'].value, true);
  assert.deepEqual(p[countName], { value: 2, status: 'ok' });
  assert.deepEqual(p[devName], { value: 1, status: 'ok' });
  assert.ok(!JSON.stringify(p).includes(root));
  assert.ok(!JSON.stringify(p).includes('privateA'));
});

test('walk handles dependency nesting, pnpm, scopes and Windows component casing', () => {
  assert.deepEqual(ancestorDirectories('/project/node_modules/a/node_modules/@scope/b').directories, ['/project', '/']);
  assert.deepEqual(ancestorDirectories('/project/node_modules/.pnpm/probe/node_modules/probe').directories, ['/project', '/']);
  assert.deepEqual(ancestorDirectories('C:\\project\\NODE_MODULES\\probe', 'win32').directories, ['C:\\project', 'C:\\']);
  assert.deepEqual(ancestorDirectories('/project'), { directories: ['/project', '/'], complete: true });
});

test('complete negative presence is false/ok; absent project manifest has no counts', async () => {
  const p = await collect();
  assert.deepEqual(p['Ancestor project package.json presence'], { value: false, status: 'ok' });
  assert.deepEqual(p[countName], { value: null, status: 'absent' });
  assert.deepEqual(p[devName], { value: null, status: 'absent' });
});

test('depth limits include skipped directories and do not report false negatives', async () => {
  const p = await collect({ maxDepth: 2 });
  assert.equal(p['Ancestor project package.json presence'].status, 'truncated');
  assert.equal(p[countName].status, 'truncated');
  const q = await collect({ runtime: { cwd: () => '/project' }, maxDepth: 1,
    statFile: async (name) => name === '/project/yarn.lock' ? file : null });
  assert.deepEqual(q['Ancestor project yarn.lock presence'], { value: true, status: 'ok' });
  assert.equal(q['Ancestor project package.json presence'].status, 'truncated');
});

test('nearest manifest is shared and missing maps count as zero', async () => {
  let reads = 0;
  const stats = new Map();
  const p = await collect({ runtime: { cwd: () => '/project/workspace' },
    statFile: async (name) => { stats.set(name, (stats.get(name) ?? 0) + 1); return name.endsWith('/package.json') ? file : null; },
    readFile: async (name, options) => {
      assert.equal(name, '/project/workspace/package.json');
      assert.equal(options.limit, PACKAGE_JSON_LIMIT);
      reads++; return '\uFEFF{"dependencies": {"private":"workspace:*"}}';
    },
  });
  assert.equal(reads, 1);
  assert.ok([...stats.values()].every((count) => count === 1));
  assert.equal(p[countName].value, 1);
  assert.equal(p[devName].value, 0);
});

test('wrong file types and .git worktree files do not match directory markers', async () => {
  const p = await collect({ statFile: async (name) => name.endsWith('/.git') || name.endsWith('/node_modules') ? file : directory });
  assert.equal(p['Ancestor project .git directory presence'].value, false);
  assert.equal(p['Ancestor project node_modules directory presence'].value, false);
  assert.equal(p['Ancestor project package-lock.json presence'].value, false);
});

test('malformed manifests, invalid maps and size failures do not erase presence', async () => {
  for (const text of ['not JSON', '[]', 'null']) {
    const p = await collect({ statFile: async () => file, readFile: async () => text });
    assert.equal(p['Ancestor project package.json presence'].value, true);
    assert.equal(p[countName].status, 'error');
  }
  const p = await collect({ statFile: async () => file, readFile: async () => '{"dependencies":[],"devDependencies":{"a":"1"}}' });
  assert.equal(p[countName].status, 'error');
  assert.equal(p[devName].value, 1);
  const large = await collect({ statFile: async () => file, readFile: async () => { throw Object.assign(new Error(), { code: 'EPROBETRUNCATED' }); } });
  assert.equal(large[countName].status, 'truncated');
});

test('permission denial and timeout are distinguished from absence', async () => {
  const p = await collect({ statFile: async () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); } });
  assert.equal(p['Ancestor project package.json presence'].status, 'permission_denied');
  assert.equal(p[countName].status, 'permission_denied');
  const timed = await collect({ statFile: () => new Promise(() => {}) }, 5);
  assert.equal(timed['Ancestor project package.json presence'].status, 'timeout');
  assert.equal(timed[countName].status, 'timeout');
});

test('workspace scan reaches parent manifests and shares parsed observations', async () => {
  const reads = [];
  const p = await collect({ runtime: { cwd: () => '/project/child' },
    statFile: async (name) => name.endsWith('/package.json') || name === '/project/.npmrc' ? file : null,
    readFile: async (name) => {
      reads.push(name);
      return name === '/project/package.json' ? '{"workspaces":{"packages":["packages/*"]}}' : '{}';
    },
  });
  assert.equal(p['Ancestor project workspace configuration presence'].value, true);
  assert.equal(p['Ancestor project .npmrc file presence'].value, true);
  assert.deepEqual(reads, ['/project/child/package.json', '/project/package.json']);
});

test('workspace markers and array declarations need no configuration file reads', async () => {
  for (const pnpm of [false, true]) {
    const p = await collect({ runtime: { cwd: () => '/project' },
      statFile: async (name) => name === `/project/${pnpm ? 'pnpm-workspace.yaml' : 'package.json'}` ? file : null,
      readFile: async (name) => { assert.ok(name.endsWith('/package.json')); return '{"workspaces":[]}'; },
    });
    assert.deepEqual(p['Ancestor project workspace configuration presence'], { value: true, status: 'ok' });
  }
});
