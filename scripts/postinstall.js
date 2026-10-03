import process from 'node:process';
import { writeSync } from 'node:fs';

function log(message) {
  try { writeSync(2, `[npm-probing-package] ${message}\n`); } catch { /* Closed stderr. */ }
}

// Direct execution outside the lifecycle does not collect installation evidence.
if (process.env.npm_lifecycle_event !== 'postinstall') process.exit(0);

const watchdog = setTimeout(() => {
  log('Installation collection exceeded 30 seconds; a report may not have been saved.');
  process.exit(0);
}, 30000);

try {
  const { collectEnvironment } = await import('../src/collect.js');
  const { writeReport } = await import('../src/report.js');
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const report = await collectEnvironment();
  report.phase = 'postinstall';
  report.package = { name: pkg.name, version: pkg.version };
  const target = await writeReport(report, [
    process.env.NPM_PROBE_OUTPUT_DIR ? resolve(process.env.NPM_PROBE_OUTPUT_DIR) : null,
    fileURLToPath(new URL('../results/', import.meta.url)),
    join(tmpdir(), 'npm-probing-package-results'),
  ]);
  log(`Installation report: ${target}`);
} catch (error) {
  log(`Could not save installation report (${error.code ?? error.message}).`);
} finally {
  clearTimeout(watchdog);
  // A timed-out I/O request must not keep the standalone install process alive.
  process.exit(0);
}
