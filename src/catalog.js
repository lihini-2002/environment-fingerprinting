import { readFileSync } from 'node:fs';

// Supports the supplied single-column CSV; catalog contents are data only.
export function parseCatalog(csv) {
  const rows = csv.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (rows.shift() !== '"property"') throw new Error('Invalid catalog header');
  const names = rows.map((row) => {
    if (!/^"(?:[^"]|"")+"$/.test(row)) throw new Error('Invalid catalog row');
    return row.slice(1, -1).replace(/""/g, '"');
  });
  if (new Set(names).size !== names.length) throw new Error('Duplicate catalog property');
  return names;
}

export const propertyNames = Object.freeze(parseCatalog(readFileSync(
  new URL('../catalog/npm-install-environment-properties.csv', import.meta.url), 'utf8',
)));
