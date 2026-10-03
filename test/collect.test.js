import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnvironment, propertyNames, statuses } from '../src/index.js';
import { statusFromError } from '../src/result.js';

test('all 200 properties have exactly value/status and are registered', async () => {
  const report = await collectEnvironment();
  assert.equal(report.schemaVersion, 2);
  assert.equal(propertyNames.length, 200);
  assert.deepEqual(Object.keys(report.properties), propertyNames);
  for (const entry of Object.values(report.properties)) {
    assert.deepEqual(Object.keys(entry), ['value', 'status']);
    assert.ok(statuses.includes(entry.status));
  }
  assert.equal(Object.values(report.properties).filter((p) => p.status === 'disabled').length, 0);
  assert.deepEqual(report.properties['Node.js process architecture'], { value: process.arch, status: 'ok' });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('all error statuses are distinguished', () => {
  assert.equal(statusFromError({ code: 'ERR_SYSTEM_ERROR', info: { code: 'EACCES' } }), 'permission_denied');
  for (const [code, expected] of Object.entries({
    EACCES: 'permission_denied', EPERM: 'permission_denied', ERR_ACCESS_DENIED: 'permission_denied',
    ENOENT: 'absent', ENOTDIR: 'absent', ENOSYS: 'unsupported', ENOTSUP: 'unsupported',
    ETIMEDOUT: 'timeout', ABORT_ERR: 'timeout', EIO: 'error', EPROBETRUNCATED: 'truncated',
    ERR_CHILD_PROCESS_STDIO_MAXBUFFER: 'truncated',
  })) assert.equal(statusFromError({ code }), expected);
});

test('a rejected or timed-out probe does not stop subsequent probes', async () => {
  let aborted = false;
  const report = await collectEnvironment({ timeoutMs: 20, probes: [
    { name: propertyNames[0], run() { throw Object.assign(new Error(), { code: 'EPERM' }); } },
    { name: propertyNames[1], run({ signal }) {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    } },
    { name: propertyNames[2], async run() { return { value: '42', status: 'ok' }; } },
  ] });
  assert.equal(aborted, true);
  assert.equal(report.properties[propertyNames[0]].status, 'permission_denied');
  assert.equal(report.properties[propertyNames[1]].status, 'timeout');
  assert.deepEqual(report.properties[propertyNames[2]], { value: '42', status: 'ok' });
});

test('invalid results are isolated and oversized strings are truncated', async () => {
  const report = await collectEnvironment({ probes: [
    { name: propertyNames[0], run: () => ({ value: 1, status: 'made_up' }) },
    { name: propertyNames[1], run: () => ({ value: 1n, status: 'ok' }) },
    { name: propertyNames[2], run: () => ({ value: 'x'.repeat(5000), status: 'ok' }) },
  ] });
  assert.equal(report.properties[propertyNames[0]].status, 'error');
  assert.equal(report.properties[propertyNames[1]].status, 'error');
  assert.equal(report.properties[propertyNames[2]].status, 'truncated');
  assert.equal(report.properties[propertyNames[2]].value.length, 4096);
});

test('validates probe definitions before executing anything', async () => {
  let executed = false;
  const probe = { name: propertyNames[0], run() { executed = true; } };
  await assert.rejects(collectEnvironment({ probes: [probe, probe] }), /Duplicate/);
  assert.equal(executed, false);
  await assert.rejects(collectEnvironment({ probes: [{}] }), /catalog name/);
  await assert.rejects(collectEnvironment({ probes: null }), /array/);
  await assert.rejects(collectEnvironment({ timeoutMs: 0 }), /timeoutMs/);
  const empty = await collectEnvironment({ probes: [] });
  assert.ok(Object.values(empty.properties).every((p) => p.status === 'disabled'));
});
