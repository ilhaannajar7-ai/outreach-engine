/**
 * Audit raw-SQL enum literals against the schema.
 *
 * TypeScript cannot check string literals written inside a `sql` template, so a
 * value from the wrong enum compiles cleanly and only fails at runtime with a
 * Postgres `enum_in` error. This resolves each `${table.column} IN (...)` to the
 * column's actual enum and verifies every literal against it.
 *
 * Columns that are not enum-typed are skipped — a varchar can hold anything.
 *
 *   node scripts/check-enums.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync('src/db/schema.ts', 'utf8');

// 1. enum variable name → { pgName, values }
//    e.g. leadStatusEnum → { pgName: 'lead_status', values: [...] }
const enumsByVar = {};
for (const m of schema.matchAll(
  /export const (\w+) = pgEnum\(\s*'([a-z_]+)'\s*,\s*\[([^\]]+)\]/g,
)) {
  enumsByVar[m[1]] = {
    pgName: m[2],
    values: [...m[3].matchAll(/'([^']+)'/g)].map((v) => v[1]),
  };
}

// 2. table variable + column name → enum
//    Walks each `export const X = pgTable(` block and records enum-typed columns.
const columnEnums = {};
for (const tableMatch of schema.matchAll(/export const (\w+) = pgTable\(/g)) {
  const tableVar = tableMatch[1];
  const start = tableMatch.index;

  // Block ends at the next top-level `export const`, which is close enough
  // for a definition file written one table at a time.
  const next = schema.indexOf('\nexport const ', start + 1);
  const block = schema.slice(start, next === -1 ? schema.length : next);

  for (const col of block.matchAll(/(\w+):\s*(\w+Enum)\(/g)) {
    const [, columnVar, enumVar] = col;
    if (enumsByVar[enumVar]) {
      columnEnums[`${tableVar}.${columnVar}`] = enumsByVar[enumVar];
    }
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const IN_LIST = /\$\{(\w+)\.(\w+)\}\s+IN\s+\(([^)]+)\)/g;
const EQ_LIT = /\$\{(\w+)\.(\w+)\}\s*=\s*'([^']+)'/g;

let issues = 0;
let checked = 0;

function report(file, lineNo, key, invalid, allowed) {
  console.log(`INVALID  ${file}:${lineNo}`);
  console.log(`         ${key} has no: ${invalid.join(', ')}`);
  console.log(`         allowed: ${allowed.join(', ')}\n`);
  issues++;
}

for (const file of walk('src')) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const [pattern, extract] of [
        [IN_LIST, (m) => [...m[3].matchAll(/'([^']+)'/g)].map((v) => v[1])],
        [EQ_LIT, (m) => [m[3]]],
      ]) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line)) !== null) {
          const key = `${m[1]}.${m[2]}`;
          const def = columnEnums[key];
          if (!def) continue; // not an enum column — nothing to verify

          checked++;
          const values = extract(m);
          const invalid = values.filter((v) => !def.values.includes(v));
          if (invalid.length > 0) {
            report(file, index + 1, `${key} (${def.pgName})`, invalid, def.values);
          }
        }
      }
    });
}

console.log(
  issues === 0
    ? `✓ ${checked} raw-SQL enum comparison(s) checked, all valid ` +
        `(${Object.keys(enumsByVar).length} enums, ${Object.keys(columnEnums).length} enum columns).`
    : `✘ ${issues} invalid enum literal${issues === 1 ? '' : 's'} found.`,
);

process.exit(issues === 0 ? 0 : 1);
