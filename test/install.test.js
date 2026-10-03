import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEnvironment } from '../src/index.js';
import { writeReport } from '../src/report.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('report writer falls back when the first directory cannot be used', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-writer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocked = join(dir, 'file');
  await writeFile(blocked, 'not a directory');
  const report = await collectEnvironment({ probes: [] });
  const target = await writeReport(report, [join(blocked, 'reports'), join(dir, 'fallback')]);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), report);
  await assert.rejects(writeReport(report, [join(blocked, 'reports')]), AggregateError);
});

test('packed npm installation creates reports and honors disabled lifecycle scripts', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, npm_config_cache: join(dir, 'cache') };
  delete env.NPM_PROBE_OUTPUT_DIR;
  // npm test supplies its CLI path; use it to avoid shell/platform quoting issues.
  const npm = (args, cwd) => process.env.npm_execpath
    ? exec(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, timeout: 25000 })
    : exec('npm', args, { cwd, env, timeout: 25000 });
  const { stdout } = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir], root);
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.some((file) => file.path === 'catalog/npm-install-environment-properties.csv'));
  assert.ok(packed.files.some((file) => file.path === 'scripts/postinstall.js'));
  assert.ok(!packed.files.some((file) => file.path.startsWith('results/')));
  const fixture = join(dir, 'consumer');
  await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'probe-consumer', version: '1.0.0', private: true }));
  const tarball = join(dir, packed.filename);
  await npm(['install', tarball, '--offline', '--no-audit', '--no-fund', '--ignore-scripts=false'], fixture);
  const installed = join(fixture, 'node_modules', 'npm-probing-package');
  const reports = join(installed, 'results');
  let files = await readdir(reports);
  assert.equal(files.length, 1);
  const report = JSON.parse(await readFile(join(reports, files[0]), 'utf8'));
  assert.equal(report.phase, 'postinstall');
  assert.deepEqual(report.properties['npm lifecycle event name'], { value: 'postinstall', status: 'ok' });
  assert.deepEqual(report.properties['npm command name when exposed'], { value: 'install', status: 'ok' });
  assert.deepEqual(report.properties['Package-manager identity'], { value: 'npm', status: 'ok' });
  assert.equal(report.properties['Package-manager version'].status, 'ok');
  assert.equal(report.properties['npm cache normalized path template'].status, 'ok');
  assert.equal(report.properties['INIT_CWD normalized path template'].status, 'ok');
  assert.deepEqual(report.properties['Lifecycle working-directory relation to INIT_CWD'], { value: 'descendant', status: 'ok' });
  assert.deepEqual(report.properties['Package installation depth beneath node_modules'], { value: 1, status: 'ok' });
  assert.equal(report.properties['npm user-agent normalized runtime components'].status, 'ok');
  assert.deepEqual(report.properties['Ancestor project package.json presence'], { value: true, status: 'ok' });
  assert.deepEqual(report.properties['Ancestor project node_modules directory presence'], { value: true, status: 'ok' });
  assert.equal(report.properties['Ancestor project direct dependency count from package.json'].status, 'ok');
  assert.equal(report.properties['Ancestor project development dependency count from package.json'].value, 0);
  assert.equal(report.package.name, 'npm-probing-package');
  assert.equal(Object.keys(report.properties).length, 200);
  assert.equal(Object.values(report.properties).filter((p) => p.status === 'disabled').length, 0);
  await npm(['rebuild', 'npm-probing-package', '--offline', '--ignore-scripts=false'], fixture);
  files = await readdir(reports);
  assert.equal(files.length, 2);
  const directEnv = { ...env };
  delete directEnv.npm_lifecycle_event;
  await exec(process.execPath, [join(installed, 'scripts', 'postinstall.js')], { env: directEnv });
  assert.equal((await readdir(reports)).length, 2);
  await rm(join(fixture, 'node_modules'), { recursive: true, force: true });
  await npm(['ci', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], fixture);
  await assert.rejects(readdir(reports), { code: 'ENOENT' });
});
