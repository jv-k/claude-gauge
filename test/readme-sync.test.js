'use strict';

// docs/reference.md's status line tables name every part, switch and theme in the
// registry, and nothing else, so none can ship undocumented. Its claude-gauge
// switch table names every switch in the CLI's USAGE text, and nothing else,
// and the claude-gauge column of its claude-hud table names only parts and
// switches that the registry has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PARTS, DEFAULT_ROWS, SWITCHES, THEMES } = require('../dist/statusline.js');
const { cliSource, switchAt, usageSwitches } = require('./helpers');

const reference = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reference.md'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

// The body rows of the first table under a heading, each as its list of
// cells. With `header`, the first table whose first header cell is that text,
// for a section with more than one table. A `\|` stays inside its cell.
function tableRows(text, heading, header) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  let table = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (line.startsWith('|')) {
      table.push(line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()));
      continue;
    }
    if (!table.length) continue;
    if (header === undefined || table[0][0] === header) break;
    table = [];
  }
  if (header !== undefined && table[0]?.[0] !== header) return null;
  return table.slice(2);
}

// The names in the first column of a table: `--segments <5\|10>` gives
// --segments, `ctx` gives ctx.
function tableNames(text, heading, header) {
  const rows = tableRows(text, heading, header);
  if (!rows) return null;
  return rows.map((row) => /^`([^`\s]+)/.exec(row[0])?.[1]).filter(Boolean);
}

// Every difference between the reference's tables and a registry, as one line
// each. Empty when they agree.
function drift(text, { parts, defaultRows, switches, themes, usage }) {
  // One table's differences. The reference says the default parts table is in
  // row order, so for that table a reorder alone is a difference too.
  const compare = (heading, expected, { ordered = false, header, table = `"${heading}"`, source = 'the registry' } = {}) => {
    const documented = tableNames(text, heading, header);
    if (!documented) return [header ? `docs/reference.md has no ${header} table under "${heading}"` : `docs/reference.md has no "${heading}" heading`];
    const problems = [
      ...expected.filter((n) => !documented.includes(n)).map((n) => `${n} has no row ${header ? 'in' : 'under'} ${table}`),
      ...documented.filter((n) => !expected.includes(n)).map((n) => `${table} documents ${n}, which ${source} lacks`),
    ];
    const same = documented.length === expected.length && documented.every((n, i) => n === expected[i]);
    if (ordered && !problems.length && !same) {
      problems.push(`"${heading}" lists ${documented.join(',')}; the default rows are ${expected.join(',')}`);
    }
    return problems;
  };
  // The claude-gauge column of the claude-hud table names parts and switches
  // in code spans, such as `ctx` and `--right <parts>`. A span of one word is
  // a part. Its other spans, such as `┃` and `!2 +1 ✘1 ?3`, show what a bar
  // prints and name nothing.
  const migration = () => {
    const heading = '## Upgrading from claude-hud';
    const column = `the claude-gauge column under "${heading}"`;
    const rows = tableRows(text, heading, 'claude-hud option');
    if (!rows) return [`docs/reference.md has no claude-hud option table under "${heading}"`];
    const problems = [];
    for (const row of rows) {
      for (const [, span] of (row[1] ?? '').matchAll(/`([^`]+)`/g)) {
        const flag = switchAt(span);
        if (flag && !switches.includes(flag)) problems.push(`${column} names the switch ${flag}, which the registry lacks`);
        if (!flag && /^[\w-]+$/.test(span) && !parts.includes(span)) problems.push(`${column} names the part ${span}, which the registry lacks`);
      }
    }
    return problems;
  };
  const defaults = defaultRows.flat();
  return [
    ...compare('### Status line', defaults, { ordered: true }),
    ...compare('### More status line parts', parts.filter((p) => !defaults.includes(p))),
    ...compare('### Status line options', switches),
    ...compare('#### Themes', themes),
    ...compare('### From npm', usage, {
      header: 'Switch',
      table: 'the switch table under "### From npm"',
      source: "the CLI's USAGE text",
    }),
    ...migration(),
  ];
}

const cli = cliSource();

const registry = {
  parts: [...PARTS],
  defaultRows: DEFAULT_ROWS,
  switches: SWITCHES.map((s) => s.name),
  themes: THEMES,
  usage: usageSwitches(cli),
};

test('the reference documents every status line part, switch and theme in the registry, and every switch in the USAGE text, and no others', () => {
  assert.deepEqual(drift(reference, registry), []);
});

test('a part added to the registry without a reference row fails the sync', () => {
  const withWeather = { ...registry, parts: [...registry.parts, 'weather'] };
  assert.deepEqual(drift(reference, withWeather), ['weather has no row under "### More status line parts"']);
});

test('a part added to a default row without a reference row fails the sync', () => {
  const withWeather = {
    ...registry,
    parts: [...registry.parts, 'weather'],
    defaultRows: [[...registry.defaultRows[0], 'weather'], ...registry.defaultRows.slice(1)],
  };
  assert.deepEqual(drift(reference, withWeather), ['weather has no row under "### Status line"']);
});

test('a switch added to the registry without a reference row fails the sync', () => {
  const withFlag = { ...registry, switches: [...registry.switches, '--weather'] };
  assert.deepEqual(drift(reference, withFlag), ['--weather has no row under "### Status line options"']);
});

test('a theme added to the registry without a reference row fails the sync', () => {
  const withNeon = { ...registry, themes: [...registry.themes, 'neon'] };
  assert.deepEqual(drift(reference, withNeon), ['neon has no row under "#### Themes"']);
});

test('a reference row for a part the registry lacks fails the sync', () => {
  const withoutVersion = { ...registry, parts: registry.parts.filter((p) => p !== 'version') };
  assert.deepEqual(drift(reference, withoutVersion), [
    '"### More status line parts" documents version, which the registry lacks',
    'the claude-gauge column under "## Upgrading from claude-hud" names the part version, which the registry lacks',
  ]);
});

test('the default parts table follows the order of the default rows', () => {
  const swapped = { ...registry, defaultRows: [['5h', 'ctx', '7d'], ...registry.defaultRows.slice(1)] };
  assert.equal(drift(reference, swapped).length, 1);
  assert.match(drift(reference, swapped)[0], /^"### Status line" lists ctx,5h,7d,/);
});

test('a switch added to the USAGE text without a reference row fails the sync', () => {
  const withFlag = { ...registry, usage: [...registry.usage, '--dry-run'] };
  assert.deepEqual(drift(reference, withFlag), ['--dry-run has no row in the switch table under "### From npm"']);
});

test('a reference switch row for a switch the USAGE text lacks fails the sync', () => {
  const withoutReplace = { ...registry, usage: registry.usage.filter((s) => s !== '--replace') };
  assert.deepEqual(drift(reference, withoutReplace), [
    'the switch table under "### From npm" documents --replace, which the CLI\'s USAGE text lacks',
  ]);
});

test('an unknown part in the claude-gauge column of the migration table fails the sync', () => {
  const stale = reference.replace('| `display.showMemoryUsage` | `ram` |', '| `display.showMemoryUsage` | `memory` |');
  assert.notEqual(stale, reference);
  assert.deepEqual(drift(stale, registry), [
    'the claude-gauge column under "## Upgrading from claude-hud" names the part memory, which the registry lacks',
  ]);
});

test('an unknown switch in the claude-gauge column of the migration table fails the sync', () => {
  const stale = reference.replace('| `--12h` for the 12-hour clock.', '| `--hour-12` for the 12-hour clock.');
  assert.notEqual(stale, reference);
  assert.deepEqual(drift(stale, registry), [
    'the claude-gauge column under "## Upgrading from claude-hud" names the switch --hour-12, which the registry lacks',
  ]);
});

test('a switch line taken out of the USAGE text in the CLI source fails the sync', () => {
  const line = '  --replace                  replace a status line that is not claude-gauge\'s\n';
  assert.ok(cli.includes(line));
  const usage = usageSwitches(cli.replace(line, ''));
  assert.deepEqual(drift(reference, { ...registry, usage }), [
    'the switch table under "### From npm" documents --replace, which the CLI\'s USAGE text lacks',
  ]);
});

test('a switch line added to the USAGE text in the CLI source fails the sync, with or without a short name first', () => {
  const after = '  --replace                  replace a status line that is not claude-gauge\'s\n';
  const usage = usageSwitches(cli.replace(after, after + '  -n, --dry-run              show the settings, and write nothing\n'));
  assert.deepEqual(drift(reference, { ...registry, usage }), ['--dry-run has no row in the switch table under "### From npm"']);
});

test('a part name with a hyphen, a capital or an underscore in the migration column fails the sync', () => {
  for (const name of ['memory-usage', 'memUsage', 'ram_usage']) {
    const stale = reference.replace('| `display.showMemoryUsage` | `ram` |', `| \`display.showMemoryUsage\` | \`${name}\` |`);
    assert.deepEqual(drift(stale, registry), [
      `the claude-gauge column under "## Upgrading from claude-hud" names the part ${name}, which the registry lacks`,
    ]);
  }
});

// The README's short table of the default parts lists the default rows' parts,
// in row order, as the reference's "### Status line" table does.
test("the README's default parts table lists the default rows in order", () => {
  assert.deepEqual(tableNames(readme, '## What the bars show'), DEFAULT_ROWS.flat());
});
