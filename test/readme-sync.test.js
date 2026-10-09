'use strict';

// The README's status line tables name every part, switch and theme in the
// registry, and nothing else, so none can ship undocumented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PARTS, DEFAULT_ROWS, SWITCHES, THEMES } = require('../dist/statusline.js');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

// The names in the first column of the first table under a heading:
// `--segments <5\|10>` gives --segments, `ctx` gives ctx.
function tableNames(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const names = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cell = line.split('|')[1].trim();
    const name = /^`([^`\s]+)/.exec(cell);
    if (name) names.push(name[1]);
  }
  return names;
}

// Every difference between the README's tables and a registry, as one line
// each. Empty when they agree.
function drift(text, { parts, defaultRows, switches, themes }) {
  // One table's differences. The README says the default parts table is in
  // row order, so for that table a reorder alone is a difference too.
  const compare = (heading, expected, { ordered = false } = {}) => {
    const documented = tableNames(text, heading);
    if (!documented) return [`README has no "${heading}" heading`];
    const problems = [
      ...expected.filter((n) => !documented.includes(n)).map((n) => `${n} has no row under "${heading}"`),
      ...documented.filter((n) => !expected.includes(n)).map((n) => `"${heading}" documents ${n}, which the registry lacks`),
    ];
    const same = documented.length === expected.length && documented.every((n, i) => n === expected[i]);
    if (ordered && !problems.length && !same) {
      problems.push(`"${heading}" lists ${documented.join(',')}; the default rows are ${expected.join(',')}`);
    }
    return problems;
  };
  const defaults = defaultRows.flat();
  return [
    ...compare('### Status line', defaults, { ordered: true }),
    ...compare('### More status line parts', parts.filter((p) => !defaults.includes(p))),
    ...compare('### Status line options', switches),
    ...compare('#### Themes', themes),
  ];
}

const registry = { parts: [...PARTS], defaultRows: DEFAULT_ROWS, switches: SWITCHES.map((s) => s.name), themes: THEMES };

test('the README documents every status line part, switch and theme in the registry, and no others', () => {
  assert.deepEqual(drift(readme, registry), []);
});

test('a part added to the registry without a README row fails the sync', () => {
  const withWeather = { ...registry, parts: [...registry.parts, 'weather'] };
  assert.deepEqual(drift(readme, withWeather), ['weather has no row under "### More status line parts"']);
});

test('a part added to a default row without a README row fails the sync', () => {
  const withWeather = {
    ...registry,
    parts: [...registry.parts, 'weather'],
    defaultRows: [[...registry.defaultRows[0], 'weather'], ...registry.defaultRows.slice(1)],
  };
  assert.deepEqual(drift(readme, withWeather), ['weather has no row under "### Status line"']);
});

test('a switch added to the registry without a README row fails the sync', () => {
  const withFlag = { ...registry, switches: [...registry.switches, '--weather'] };
  assert.deepEqual(drift(readme, withFlag), ['--weather has no row under "### Status line options"']);
});

test('a theme added to the registry without a README row fails the sync', () => {
  const withNeon = { ...registry, themes: [...registry.themes, 'neon'] };
  assert.deepEqual(drift(readme, withNeon), ['neon has no row under "#### Themes"']);
});

test('a README row for a part the registry lacks fails the sync', () => {
  const withoutVersion = { ...registry, parts: registry.parts.filter((p) => p !== 'version') };
  assert.deepEqual(drift(readme, withoutVersion), ['"### More status line parts" documents version, which the registry lacks']);
});

test('the default parts table follows the order of the default rows', () => {
  const swapped = { ...registry, defaultRows: [['5h', 'ctx', '7d'], ...registry.defaultRows.slice(1)] };
  assert.equal(drift(readme, swapped).length, 1);
  assert.match(drift(readme, swapped)[0], /^"### Status line" lists ctx,5h,7d,/);
});
