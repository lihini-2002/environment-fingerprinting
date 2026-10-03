import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeReport(report, directories) {
  const filename = `install-${report.runId}.json`;
  const failures = [];
  for (const directory of [...new Set(directories.filter(Boolean))]) {
    const target = join(directory, filename);
    const temporary = `${target}.tmp`;
    let created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
      await rename(temporary, target);
      return target;
    } catch (error) {
      failures.push(error);
      if (created) await unlink(temporary).catch(() => {});
    }
  }
  throw new AggregateError(failures, 'No writable report directory');
}
