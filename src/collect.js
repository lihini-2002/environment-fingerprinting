import { randomUUID } from 'node:crypto';
import { propertyNames } from './catalog.js';
import { defaultProbes } from './probes/index.js';
import { result, statuses, statusFromError, withTimeout } from './result.js';

export async function collectEnvironment({ probes = defaultProbes, timeoutMs = 1500 } = {}) {
  if (!Array.isArray(probes)) throw new TypeError('probes must be an array');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 60000');
  }

  const names = new Set();
  for (const probe of probes) {
    if (!probe || !propertyNames.includes(probe.name) || typeof probe.run !== 'function') {
      throw new TypeError('Each probe must have a catalog name and a run function');
    }
    if (names.has(probe.name)) {
      throw new TypeError(`Duplicate probe name: ${probe.name}`);
    }
    names.add(probe.name);
  }

  const report = {
    schemaVersion: 2,
    runId: randomUUID(),
    collectedAt: new Date().toISOString(),
    properties: Object.fromEntries(propertyNames.map((name) => [name, result(null, 'disabled')])),
  };

  const cache = new Map();
  for (const probe of probes) {
    const controller = new AbortController();
    try {
      const entry = await withTimeout(
        () => probe.run({ signal: controller.signal, cache }), timeoutMs, () => controller.abort(),
      );
      if (!entry || !statuses.includes(entry.status) || entry.value === undefined) {
        throw new TypeError('Invalid probe result');
      }
      // Invalid custom results cannot prevent the remaining report being serialized.
      const value = JSON.parse(JSON.stringify(entry.value));
      report.properties[probe.name] = typeof value === 'string' && value.length > 4096
        ? result(value.slice(0, 4096), 'truncated') : result(value, entry.status);
    } catch (error) {
      report.properties[probe.name] = result(null, statusFromError(error));
    }
  }

  return report;
}
