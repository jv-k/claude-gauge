'use strict';

// The cost ledger: the today and week parts, the ledger file the status line
// keeps in the state folder, and what happens when several sessions write it
// at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { render, parseArgs, recordCost } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A fixed local noon on Wednesday 7 October 2026, so the week began on
// Monday the 5th.
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const run = (data, args, ledger) =>
  plain(render(data, { nowMs: NOW, branchOf: () => 'main', config: parseArgs(args), ledger }));

const ledgerOf = (days, sessions = {}) => ({ days, sessions });

test('today and week show the spend the ledger holds for today and since Monday', () => {
  const ledger = ledgerOf({ '2026-10-07': 2.5, '2026-10-06': 1, '2026-10-05': 0.25, '2026-10-04': 9, '2026-09-30': 9 });
  assert.equal(run({}, ['--show', 'today,week'], ledger), 'today $2.50 │ week $3.75');
});

test("today and week add the session's cost the ledger has not recorded yet", () => {
  const ledger = ledgerOf({ '2026-10-07': 2.5, '2026-10-06': 1 }, { abc: { usd: 1.5, at: NOW - 60_000 } });
  // abc has spent $0.50 since the ledger last recorded it.
  assert.equal(run({ session_id: 'abc', cost: { total_cost_usd: 2 } }, ['--show', 'today,week'], ledger), 'today $3.00 │ week $4.00');
  // A session the ledger has never seen adds all its cost.
  assert.equal(run({ session_id: 'new', cost: { total_cost_usd: 2 } }, ['--show', 'today,week'], ledger), 'today $4.50 │ week $5.50');
  // A cost that fell since it was recorded started again from zero.
  assert.equal(run({ session_id: 'abc', cost: { total_cost_usd: 0.25 } }, ['--show', 'today'], ledger), 'today $2.75');
});

test('today and week show the session alone without a ledger, and drop out with no cost at all', () => {
  assert.equal(run({ cost: { total_cost_usd: 1.234 } }, ['--show', 'today,week']), 'today $1.23 │ week $1.23');
  assert.equal(run({}, ['--show', 'today,week,model']), '');
  assert.equal(run({}, ['--show', 'today,week'], ledgerOf({ '2026-09-30': 9 })), '');
});

test('today and week take the usual label switches', () => {
  const data = { cost: { total_cost_usd: 1 } };
  assert.equal(run(data, ['--show', 'today,week', '--no-labels']), '$1.00 │ $1.00');
  assert.equal(run(data, ['--show', 'today,week', '--compact']), 'tdy $1.00│wk $1.00');
});

test('a ledger with values that are not numbers adds nothing for them', () => {
  const ledger = ledgerOf({ '2026-10-07': '\x1b[2J5', '2026-10-06': 1 }, { abc: { usd: 'x', at: 0 } });
  assert.equal(run({ session_id: 'abc', cost: { total_cost_usd: 2 } }, ['--show', 'today,week'], ledger), 'today $2.00 │ week $3.00');
});

// A ledger file in a folder of its own.
const tempLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-ledger-')), 'ledger.json');
const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const session = (id, usd) => ({ session_id: id, cost: { total_cost_usd: usd } });

test("a render records the session's new spend against today", () => {
  const file = tempLedger();
  recordCost(session('a', 1.5), { file, nowMs: NOW });
  recordCost(session('b', 0.5), { file, nowMs: NOW + 1000 });
  recordCost(session('a', 2), { file, nowMs: NOW + 60_000 });
  const ledger = readFile(file);
  assert.deepEqual(ledger.days, { '2026-10-07': 2.5 });
  assert.deepEqual(ledger.sessions, { a: { usd: 2, at: NOW + 60_000 }, b: { usd: 0.5, at: NOW + 1000 } });
});

test('a session that runs past midnight puts its spend on the day it was spent', () => {
  const file = tempLedger();
  const late = new Date(2026, 9, 6, 23, 59).getTime();
  recordCost(session('a', 1), { file, nowMs: late });
  recordCost(session('a', 3), { file, nowMs: late + 2 * 60_000 });
  assert.deepEqual(readFile(file).days, { '2026-10-06': 1, '2026-10-07': 2 });
});

test('a cost that falls counts again from zero', () => {
  const file = tempLedger();
  recordCost(session('a', 3), { file, nowMs: NOW });
  recordCost(session('a', 0.5), { file, nowMs: NOW + 60_000 });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 3.5 });
});

test('writes are throttled to one every 10 seconds per session, and the parts still show the latest cost', () => {
  const file = tempLedger();
  recordCost(session('a', 1), { file, nowMs: NOW });
  const ledger = recordCost(session('a', 1.25), { file, nowMs: NOW + 9_999 });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 1 });
  assert.equal(run(session('a', 1.25), ['--show', 'today'], ledger), 'today $1.25');
  // Another session is not held back by the first.
  recordCost(session('b', 2), { file, nowMs: NOW + 9_999 });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 3 });
  // Once 10 seconds have passed, the first session's spend since its last
  // write is recorded.
  recordCost(session('a', 1.25), { file, nowMs: NOW + 10_000 });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 3.25 });
});

test('a render writes nothing when the cost has not changed, or there is no session or cost to record', () => {
  const file = tempLedger();
  recordCost(session('a', 1), { file, nowMs: NOW });
  recordCost(session('a', 1), { file, nowMs: NOW + 60_000 });
  assert.equal(readFile(file).sessions.a.at, NOW);
  const none = tempLedger();
  recordCost({ cost: { total_cost_usd: 1 } }, { file: none, nowMs: NOW });
  recordCost({ session_id: 'a' }, { file: none, nowMs: NOW });
  recordCost(session('a', '1'), { file: none, nowMs: NOW });
  assert.equal(fs.existsSync(none), false);
});

test('the ledger forgets days and sessions older than 31 days', () => {
  const file = tempLedger();
  recordCost(session('old', 1), { file, nowMs: NOW - 32 * DAY });
  recordCost(session('kept', 1), { file, nowMs: NOW - 30 * DAY });
  recordCost(session('a', 1), { file, nowMs: NOW });
  const ledger = readFile(file);
  assert.deepEqual(Object.keys(ledger.days).sort(), ['2026-09-07', '2026-10-07']);
  assert.deepEqual(Object.keys(ledger.sessions).sort(), ['a', 'kept']);
});

test('a ledger file that is not a ledger is started again, and an unwritable one is left alone', () => {
  const file = tempLedger();
  fs.writeFileSync(file, '{"days": [1, 2');
  recordCost(session('a', 1), { file, nowMs: NOW });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 1 });
  const blocked = path.join(file, 'ledger.json');
  assert.doesNotThrow(() => recordCost(session('a', 1), { file: blocked, nowMs: NOW }));
});

test('a session id is a key like any other', () => {
  const file = tempLedger();
  recordCost(session('__proto__', 1), { file, nowMs: NOW });
  recordCost(session('__proto__', 3), { file, nowMs: NOW + 60_000 });
  const ledger = readFile(file);
  assert.deepEqual(ledger.days, { '2026-10-07': 3 });
  assert.deepEqual(Object.keys(ledger.sessions), ['__proto__']);
  assert.equal(Object.prototype.usd, undefined);
});

test('a lock a stopped render left behind is broken, and a lock another render holds is left alone', () => {
  const file = tempLedger();
  const lock = `${file}.lock`;
  // Held now by another render: this render records nothing, and leaves the
  // lock as it found it.
  fs.writeFileSync(lock, 'other');
  recordCost(session('a', 1), { file, nowMs: NOW });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
  // Left by a render that stopped a minute ago: the lock is broken, the
  // spend held back before is recorded too, and no lock is left.
  const minuteAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, minuteAgo, minuteAgo);
  recordCost(session('a', 2), { file, nowMs: NOW + 60_000 });
  assert.deepEqual(readFile(file).days, { '2026-10-07': 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ledger.json']);
});

// Runs a script in a Node process of its own, with the built status line at
// hand as gauge, and resolves with what it printed.
const { spawn } = require('node:child_process');
const inNodeProcess = (script, ...args) =>
  new Promise((resolve, reject) => {
    const gauge = path.join(__dirname, '..', 'dist', 'statusline.js');
    const child = spawn(process.execPath, ['-e', `const gauge = require(${JSON.stringify(gauge)}); ${script}`, ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });

test('two sessions rendering at once keep the ledger whole, and lose none of its history', async () => {
  const file = tempLedger();
  fs.writeFileSync(file, JSON.stringify({ days: { '2026-10-06': 5, '2026-10-05': 7 }, sessions: {} }));
  const renders = 400;
  // Each session renders over and over, 10 seconds apart on its clock so that
  // every render writes, and spends a cent each time.
  const keepRendering = (id) =>
    inNodeProcess(
      `const [file, id, n, now] = process.argv.slice(1);
       for (let i = 1; i <= +n; i++) gauge.recordCost({ session_id: id, cost: { total_cost_usd: i / 100 } }, { file, nowMs: +now + i * 10000 });`,
      file, id, String(renders), String(NOW),
    );
  // A third process reads the file all the while, and counts the reads that
  // were not a whole ledger.
  const reader = inNodeProcess(
    `const fs = require('node:fs');
     const [file, stop] = process.argv.slice(1);
     let torn = 0;
     while (!fs.existsSync(stop)) {
       try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') torn++; }
     }
     process.stdout.write(String(torn));`,
    file, `${file}.stop`,
  );
  await Promise.all([keepRendering('a'), keepRendering('b')]);
  fs.writeFileSync(`${file}.stop`, '');
  assert.equal(await reader, '0');

  // A render each afterwards records anything a busy lock held back.
  const after = NOW + (renders + 1) * 10_000;
  recordCost({ session_id: 'a', cost: { total_cost_usd: renders / 100 + 0.01 } }, { file, nowMs: after });
  recordCost({ session_id: 'b', cost: { total_cost_usd: renders / 100 + 0.01 } }, { file, nowMs: after });

  const ledger = readFile(file);
  assert.deepEqual(Object.keys(ledger.days).sort(), ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(ledger.days['2026-10-05'], 7);
  assert.equal(ledger.days['2026-10-06'], 5);
  assert.equal(ledger.days['2026-10-07'].toFixed(2), (2 * (renders / 100 + 0.01)).toFixed(2));
  assert.deepEqual(Object.keys(ledger.sessions).sort(), ['a', 'b']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['ledger.json', 'ledger.json.stop']);
});

test('the status line program records each session in the state folder, and --latest shows the totals', () => {
  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'dist', 'statusline.js');
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  delete env.CLAUDE_CODE_SESSION_ID;
  const statusLine = (data, args = ['--show', 'today,week']) =>
    plain(execFileSync(process.execPath, [script, ...args], { env, input: JSON.stringify(data), encoding: 'utf8', cwd: config }));
  assert.equal(statusLine(session('a', 1)), 'today $1.00 │ week $1.00\n');
  assert.equal(statusLine(session('b', 2)), 'today $3.00 │ week $3.00\n');
  const ledger = readFile(path.join(config, 'claude-gauge', '.state', 'ledger.json'));
  assert.deepEqual(Object.keys(ledger.sessions).sort(), ['a', 'b']);
  assert.equal(statusLine({}, ['--latest', '--show', 'today,week']), 'today $3.00 │ week $3.00\n');
});
