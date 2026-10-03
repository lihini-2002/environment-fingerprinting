import process from 'node:process';
import { result, observed } from '../result.js';

const unavailable = () => { throw Object.assign(new Error('Locale API unavailable'), { code: 'ENOSYS' }); };
const stringResult = (value) => {
  if (typeof value !== 'string') throw new TypeError('Invalid locale metadata');
  return value.length > 4096 ? result(value.slice(0, 4096), 'truncated') : result(value);
};

export function createLocaleProbes({ env = process.env, intl = globalThis.Intl, now = () => new Date() } = {}) {
  const key = Symbol('resolved-locale-options');
  const options = (ctx) => {
    const read = () => {
      ctx.signal?.throwIfAborted();
      if (typeof intl?.DateTimeFormat !== 'function') unavailable();
      const formatter = new intl.DateTimeFormat();
      if (typeof formatter.resolvedOptions !== 'function') unavailable();
      const resolved = formatter.resolvedOptions();
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw new TypeError('Invalid locale options');
      return { timeZone: resolved.timeZone, locale: resolved.locale };
    };
    if (!ctx.cache) return read();
    if (!ctx.cache.has(key)) ctx.cache.set(key, Promise.resolve().then(read));
    return ctx.cache.get(key);
  };
  const identifier = (field) => async (ctx) => {
    const value = (await options(ctx))[field];
    return value === undefined || value === null || value === '' ? observed(value) : stringResult(value);
  };
  return [
    ...['TZ', 'LANG', 'LC_ALL'].map((name) => ({
      name: `${name} variable value`,
      run() {
        if (!Object.hasOwn(env, name)) return result(null, 'absent');
        return stringResult(env[name]);
      },
    })),
    { name: 'Resolved runtime timezone identifier', run: identifier('timeZone') },
    { name: 'Current timezone UTC offset in minutes', run(ctx) {
      ctx.signal?.throwIfAborted();
      const date = now();
      if (typeof date?.getTimezoneOffset !== 'function') unavailable();
      const offset = date.getTimezoneOffset();
      if (!Number.isSafeInteger(offset)) throw new TypeError('Invalid timezone offset');
      return result(offset === 0 ? 0 : offset);
    } },
    { name: 'Resolved runtime locale identifier', run: identifier('locale') },
  ];
}
