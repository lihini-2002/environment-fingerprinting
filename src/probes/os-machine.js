import os from 'node:os';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { observed, result } from '../result.js';
import { readOSRelease } from './os-release.js';

const execFileAsync = promisify(execFile);

export async function macOSVersion({ signal } = {}) {
  const { stdout } = await execFileAsync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8', signal, timeout: 1000, killSignal: 'SIGKILL',
    maxBuffer: 4096, windowsHide: true,
  });
  return stdout.trim();
}

// Injectable dependencies allow restricted and non-native platforms to be tested.
export function createOSProbes({
  system = os, platform = process.platform, processArch = process.arch,
  linuxRelease = readOSRelease, macVersion = macOSVersion,
} = {}) {
  async function distribution(field, context) {
    if (platform === 'linux') return observed((await linuxRelease(context))[field]);
    if (platform === 'darwin') {
      if (field === 'ID') return observed('macos');
      if (field === 'ID_LIKE') return observed('darwin');
      return observed(await macVersion(context));
    }
    if (platform === 'win32') {
      // Numeric OS release/build, not a guessed marketing version.
      return observed(field === 'VERSION_ID' ? system.release() : 'windows');
    }
    return result(null, 'unsupported');
  }

  const native = (method) => () => typeof system[method] === 'function'
    ? observed(system[method]()) : result(null, 'unsupported');
  return [
    { name: 'Operating system family', run: native('type') },
    { name: 'Operating system distribution identifier', run: (ctx) => distribution('ID', ctx) },
    { name: 'Operating system distribution version', run: (ctx) => distribution('VERSION_ID', ctx) },
    { name: 'Operating system distribution family', run: (ctx) => distribution('ID_LIKE', ctx) },
    { name: 'Kernel release', run: native('release') },
    { name: 'Kernel version string', run: native('version') },
    { name: 'Machine architecture', run: native('machine') },
    { name: 'Node.js process architecture', run: () => observed(processArch) },
    { name: 'System byte order', run: native('endianness') },
    { name: 'Operating system uptime in seconds', run: native('uptime') },
  ];
}
