import os from 'node:os';
import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import process from 'node:process';
import { readBoundedFile } from './os-release.js';
import { result } from '../result.js';

const ROUTE_BYTE_LIMIT = 1024 * 1024;
const ROUTE_ROW_LIMIT = 4096;
const truncated = () => { throw Object.assign(new Error('Network metadata exceeds limit'), { code: 'EPROBETRUNCATED' }); };
const invalid = () => { throw new Error('Invalid network metadata'); };
const hex = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
const active = (flags) => (flags & 1) !== 0 && (flags & 0x200) === 0; // RTF_UP, RTF_REJECT

const RESOLVER_BYTE_LIMIT = 64 * 1024;
const addressRanges = [
  ['unspecified', [['0.0.0.0', 32], ['::', 128]]],
  ['loopback', [['127.0.0.0', 8], ['::1', 128]]],
  ['private', [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['fc00::', 7]]],
  ['link_local', [['169.254.0.0', 16], ['fe80::', 10]]],
  ['shared', [['100.64.0.0', 10]]],
  ['multicast', [['224.0.0.0', 4], ['ff00::', 8]]],
].map(([name, ranges]) => {
  const block = new BlockList();
  for (const [address, prefix] of ranges) block.addSubnet(address, prefix, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return [name, block];
});

function resolverClass(raw) {
  if (typeof raw !== 'string') invalid();
  if (raw.length > 1024) truncated();
  let address = raw;
  if (!isIP(address)) {
    const match = /^(?:\[([^\]]+)\]|(\d+\.\d+\.\d+\.\d+)):(\d{1,5})$/.exec(raw);
    if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) invalid();
    address = match[1] ?? match[2];
    if (isIP(address) !== (match[1] ? 6 : 4)) invalid();
  }
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  // Scope IDs are not part of the address class, and never leave this function.
  address = address.split('%')[0];
  return addressRanges.find(([, block]) => block.check(address, family))?.[0] ?? 'other';
}

function searchDomainCount(text) {
  if (typeof text !== 'string' || text.includes('\0')) invalid();
  if (Buffer.byteLength(text) > RESOLVER_BYTE_LIMIT) truncated();
  const lines = text.split('\n');
  if (lines.length > 4096) truncated();
  let count = 0;
  for (const line of lines) {
    const [directive, ...domains] = line.split(/[;#]/, 1)[0].trim().split(/\s+/);
    if (directive !== 'search' && directive !== 'domain') continue;
    if (directive === 'domain' && domains.length !== 1) invalid();
    // The last search/domain directive wins; never cache domain strings.
    count = domains.length;
  }
  return count;
}

function defaultRoute(text, version) {
  if (typeof text !== 'string') invalid();
  if (Buffer.byteLength(text) > ROUTE_BYTE_LIMIT) truncated();
  if (text.includes('\0')) invalid();
  const rows = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (version === 4) {
    if (!rows.length) return result(null, 'absent');
    const header = rows.shift().split(/\s+/);
    if (header.join(' ') !== 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT') invalid();
  }
  if (rows.length > ROUTE_ROW_LIMIT) truncated();
  let found = false;
  for (const row of rows) {
    const fields = row.split(/\s+/);
    if (version === 4) {
      if (fields.length !== 11 || !hex(fields[1], 8) || !hex(fields[2], 8) ||
          !/^[a-f0-9]{1,8}$/i.test(fields[3]) || !hex(fields[7], 8) ||
          ![4, 5, 6, 8, 9, 10].every((index) => /^\d+$/.test(fields[index]))) invalid();
      if (/^0{8}$/.test(fields[1]) && /^0{8}$/.test(fields[7]) && active(Number.parseInt(fields[3], 16))) found = true;
    } else {
      // The kernel emits an empty device column when a route has no device.
      if (![9, 10].includes(fields.length) || ![0, 2, 4].every((index) => hex(fields[index], 32)) ||
          ![1, 3].every((index) => hex(fields[index], 2) && Number.parseInt(fields[index], 16) <= 128) ||
          ![5, 6, 7, 8].every((index) => hex(fields[index], 8))) invalid();
      if (/^0{32}$/.test(fields[0]) && fields[1] === '00' && active(Number.parseInt(fields[8], 16))) found = true;
    }
  }
  // Validate the complete bounded table, even after a positive match.
  return result(found);
}

export function createNetworkProbes({
  system = os, resolver = dns, env = process.env, platform = process.platform, readFile = readBoundedFile,
} = {}) {
  const key = Symbol('network-observations');
  function cached(ctx, name, operation) {
    if (!ctx.cache) return operation();
    if (!ctx.cache.has(key)) ctx.cache.set(key, new Map());
    const cache = ctx.cache.get(key);
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(operation));
    return cache.get(name);
  }
  const interfaces = (ctx) => cached(ctx, 'interfaces', () => {
    ctx.signal?.throwIfAborted();
    if (typeof system.networkInterfaces !== 'function') throw Object.assign(new Error('Network interface API unavailable'), { code: 'ENOSYS' });
    const snapshot = system.networkInterfaces();
    ctx.signal?.throwIfAborted();
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) invalid();
    const entries = Object.values(snapshot);
    if (entries.length > 1024) truncated();
    let count = 0;
    let nonLoopback = 0;
    let addresses = 0;
    let ipv4 = false;
    let ipv6 = false;
    for (const records of entries) {
      if (records === undefined) continue;
      if (!Array.isArray(records)) invalid();
      addresses += records.length;
      if (addresses > 4096) truncated();
      if (!records.length) continue;
      count++;
      let external = false;
      for (const record of records) {
        if (!record || typeof record.internal !== 'boolean') invalid();
        const family = record.family;
        if (!['IPv4', 'IPv6', 4, 6].includes(family)) invalid();
        ipv4 ||= family === 'IPv4' || family === 4;
        ipv6 ||= family === 'IPv6' || family === 6;
        external ||= !record.internal;
      }
      if (external) nonLoopback++;
    }
    // Only derived values enter the cache; addresses, names and MACs are discarded.
    return { count, nonLoopback, ipv4, ipv6, loopbackOnly: count > 0 && nonLoopback === 0 };
  });
  const field = (name) => async (ctx) => result((await interfaces(ctx))[name]);
  const resolvers = (ctx) => cached(ctx, 'resolvers', () => {
    ctx.signal?.throwIfAborted();
    if (typeof resolver.getServers !== 'function') throw Object.assign(new Error('DNS API unavailable'), { code: 'ENOSYS' });
    const servers = resolver.getServers();
    ctx.signal?.throwIfAborted();
    if (!Array.isArray(servers)) invalid();
    if (servers.length > 1024) truncated();
    const classes = new Set();
    for (const server of servers) classes.add(resolverClass(server));
    return { count: servers.length, classes: [...classes].sort() };
  });
  const route = (version) => async (ctx) => {
    if (platform !== 'linux') return result(null, 'unsupported');
    return cached(ctx, `route:${version}`, async () => {
      ctx.signal?.throwIfAborted();
      const text = await readFile(version === 4 ? '/proc/net/route' : '/proc/net/ipv6_route', { signal: ctx.signal, limit: ROUTE_BYTE_LIMIT });
      ctx.signal?.throwIfAborted();
      return defaultRoute(text, version);
    });
  };
  return [
    { name: 'Network-interface count', run: field('count') },
    { name: 'Non-loopback network-interface count', run: field('nonLoopback') },
    { name: 'IPv4 interface availability', run: field('ipv4') },
    { name: 'IPv6 interface availability', run: field('ipv6') },
    { name: 'Loopback-only interface configuration', run: field('loopbackOnly') },
    { name: 'Default IPv4 route presence', run: route(4) },
    { name: 'Default IPv6 route presence', run: route(6) },
    { name: 'Configured DNS resolver count', run: async (ctx) => result((await resolvers(ctx)).count) },
    { name: 'Configured DNS resolver address class', run: async (ctx) => result((await resolvers(ctx)).classes) },
    { name: 'DNS search-domain count without domain values', async run(ctx) {
      if (!['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix'].includes(platform)) return result(null, 'unsupported');
      ctx.signal?.throwIfAborted();
      const text = await readFile('/etc/resolv.conf', { signal: ctx.signal, limit: RESOLVER_BYTE_LIMIT });
      ctx.signal?.throwIfAborted();
      return result(searchDomainCount(text));
    } },
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].map((name) => ({
      name: `${name} variable presence`,
      run: () => result(Object.hasOwn(env, name) || Object.hasOwn(env, name.toLowerCase())),
    })),
  ];
}
