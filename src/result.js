export const statuses = Object.freeze([
  'ok', 'absent', 'unsupported', 'permission_denied',
  'timeout', 'error', 'truncated', 'disabled',
]);

export const result = (value = null, status = 'ok') => ({ value, status });
export const observed = (value) => value === undefined || value === null || value === ''
  ? result(null, 'absent') : result(value);

export function statusFromError(error) {
  const code = error?.info?.code ?? error?.code;
  if (['EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(code)) return 'permission_denied';
  if (['ENOENT', 'ENOTDIR'].includes(code)) return 'absent';
  if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) return 'unsupported';
  if (['ETIMEDOUT', 'ABORT_ERR'].includes(code) || error?.name === 'AbortError') return 'timeout';
  if (['EPROBETRUNCATED', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(code)) return 'truncated';
  if (error?.killed && error?.signal === 'SIGKILL') return 'timeout';
  return 'error';
}

export async function withTimeout(operation, timeoutMs, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('Probe timed out'), { code: 'ETIMEDOUT' }));
          onTimeout();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
