'use strict';

// The Ink front end of the setup and configure questions, driven with key
// presses through ink-testing-library: the arrow keys and Enter for a choice,
// Space for a part of a row, and Ctrl+C. Each run is checked against the
// readline wizard given the same choices as typed answers, so both front ends
// give the code that writes the settings the same answers. Then the choice of
// front end: Ink on a terminal, the readline wizard otherwise, and the
// readline wizard again when Ink cannot be loaded, as in the plugin's checkout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { runWizard, openIo, confirm, EndOfAnswers, Interrupted } = require('../dist/wizard.js');
const { inkIoWith } = require('../dist/ink-io.js');
const { PARTS } = require('../dist/statusline.js');
const { PARTS: TOKEN_PARTS } = require('../dist/tokenline.js');
const { plain, tempDir, configFolder, runCli, ok } = require('./helpers');

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', space: ' ', ctrlC: '\x03' };

const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An io that answers each question with the next scripted answer, as the
// readline wizard reads them.
function scripted(answers) {
  const left = [...answers];
  return { ask: async () => (left.length ? left.shift() : undefined), write: () => {} };
}

// A preview that shows the switches it was given.
const preview = (switches) => `<${switches.join(' ')}>`;

// The Ink io on ink-testing-library: each question mounts on a test terminal
// of its own. `next` waits for the next question to read keys, and returns
// it; `press` sends keys to it, one at a time; `written` is
// what the io wrote outside the questions.
async function driver() {
  const ink = await import('ink');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const mounted = [];
  let ready = 0;
  let seen = 0;
  const out = { text: '' };
  const deps = { ink, React, mount: (tree) => (mounted.push(render(tree)), mounted.at(-1)), ready: () => ready++ };
  const io = inkIoWith(deps, { write: (t) => (out.text += t) }, false);
  const next = async () => {
    for (let waited = 0; ready <= seen; waited++) {
      if (waited > 10000) throw new Error(`no question ${seen + 1}`);
      await delay(1);
    }
    return mounted[seen++];
  };
  const press = async (question, ...keys) => {
    for (const key of keys) {
      question.stdin.write(key);
      await tick();
    }
  };
  // Answers the next question with `keys`, and returns its last frame before
  // the answer, as plain text.
  const answer = async (...keys) => {
    const question = await next();
    await press(question, ...keys.slice(0, -1));
    const frame = plain(question.lastFrame());
    await press(question, ...keys.slice(-1));
    return frame;
  };
  return { io, next, press, answer, out };
}

// The keys that tick and untick `names` in `list`, from the top, each with
// Space, then Enter.
function toggle(list, ...names) {
  const keys = [];
  let at = 0;
  for (const name of names) {
    const to = list.indexOf(name);
    assert.ok(to >= 0, name);
    while (at < to) keys.push(KEY.down), at++;
    while (at > to) keys.push(KEY.up), at--;
    keys.push(KEY.space);
  }
  return [...keys, KEY.enter];
}

test('setup: the customise path by key presses gives the answers that the same typed answers give', async () => {
  const typed = await runWizard(scripted(['n', '3', 'ctx,7d', 'model', 'time, cost', '10', 'pastel', 'n', 'n', 'y']), { preview });
  const { io, answer } = await driver();
  const run = runWizard(io, { preview });
  await answer(KEY.down, KEY.enter); // the defaults: No
  await answer(KEY.down, KEY.enter); // rows: from 2 to 3
  await answer(...toggle(PARTS, '5h')); // row 1: ctx,5h,7d without 5h
  await answer(...toggle(PARTS, 'time', 'duration', 'repo', 'branch', 'effort')); // row 2: model alone
  await answer(...toggle(PARTS, 'time', 'cost')); // row 3: time, then cost
  await answer(KEY.down, KEY.enter); // 10 cells
  await answer(KEY.down, KEY.down, KEY.down, KEY.enter); // pastel
  await answer(KEY.down, KEY.enter); // labels: No
  await answer(KEY.down, KEY.enter); // token line: No
  await answer(KEY.enter); // write: Yes
  assert.deepEqual(await run, typed);
  assert.deepEqual(typed.tokenLine, null);
});

test('setup: Enter at the first question takes the defaults, as a typed yes does', async () => {
  const { io, answer } = await driver();
  const run = runWizard(io, { preview });
  const frame = await answer(KEY.enter);
  assert.match(frame, /The status line with the defaults/);
  assert.match(frame, /CONFIRM\nUse the defaults/);
  assert.match(frame, /❯ Yes/);
  assert.deepEqual(await run, await runWizard(scripted(['y']), { preview }));
});

test('each answered question ends its line, and a question after the wizard shows no preview', async () => {
  const { io, answer, out } = await driver();
  const run = runWizard(io, { preview });
  await answer(KEY.enter);
  await run;
  assert.equal(out.text, '\n', 'Ink leaves the cursor at the end of its last line');
  const star = confirm(io, 'Star it?', true);
  const frame = await answer(KEY.down, KEY.enter);
  assert.equal(await star, false);
  assert.doesNotMatch(frame, /</, 'no preview');
  assert.match(frame, /^\nCONFIRM\nStar it\?\n  Yes\n❯ No\n/);
});

test('configure: Enter at every question keeps what is set up, as typed Enters do', async () => {
  const installed = {
    statusLine: ['--text', 'a b', '--show', 'ctx,bogus,5h', '--segments=10', '--frobnicate', '--theme', 'mono', '--no-labels', '--right', 'ctx'],
    tokenLine: ['--window', '1m', '--show', 'req,ctx'],
  };
  const typed = await runWizard(scripted(['n', '', '', '', '', '', '', '', '', 'y']), { preview, installed });
  const { io, answer } = await driver();
  const run = runWizard(io, { preview, installed });
  await answer(KEY.down, KEY.enter); // keep the bars: No
  for (let i = 0; i < 8; i++) await answer(KEY.enter);
  await answer(KEY.enter); // write: Yes
  assert.deepEqual(await run, typed);
});

test('configure: a changed token line by key presses gives the answers that the same typed answers give', async () => {
  const installed = { statusLine: ['--segments', '10'], tokenLine: ['--window', '1m', '--show', 'req,ctx'] };
  const typed = await runWizard(scripted(['n', '', '', '', '', '', '', '', 'req,ctx,out', '200k', 'y']), { preview, installed });
  const { io, answer, out } = await driver();
  const run = runWizard(io, { preview, installed });
  await answer(KEY.down, KEY.enter); // keep the bars: No
  for (let i = 0; i < 7; i++) await answer(KEY.enter); // rows, two rows, cells, theme, labels, token line
  await answer(...toggle(TOKEN_PARTS, 'out')); // req,ctx then out
  const window = await answer(KEY.up, KEY.enter); // from 1m up to 200k
  assert.match(window, /❯ 200k/);
  await answer(KEY.enter);
  assert.deepEqual(await run, typed);
  assert.deepEqual(typed.tokenLine, ['--show', 'req,ctx,out']);
  assert.match(out.text, /assumes 200k/, 'the note before the window question is written as it is');
});

test('the preview redraws as the selection moves, before the answer is accepted', async () => {
  const { io, next, press, answer } = await driver();
  const run = runWizard(io, { preview });
  await answer(KEY.down, KEY.enter); // customise
  for (let i = 0; i < 4; i++) await answer(KEY.enter); // rows, two rows, cells
  const theme = await next();
  assert.match(plain(theme.lastFrame()), /<>\n[\s\S]*❯ default/);
  await press(theme, KEY.down);
  assert.match(plain(theme.lastFrame()), /<--theme mono>\n[\s\S]*❯ mono/, 'the preview shows the theme the selection is on');
  await press(theme, KEY.down, KEY.down, KEY.enter);
  const labels = await next();
  assert.match(plain(labels.lastFrame()), /<--theme pastel>/, 'the answer stays in the preview');
  await press(labels, KEY.down);
  assert.match(plain(labels.lastFrame()), /<--theme pastel --no-labels>/);
  await press(labels, KEY.up, KEY.enter);
  await answer(KEY.enter); // token line
  await answer(KEY.enter); // token line parts
  await answer(KEY.enter); // window
  await answer(KEY.enter); // write
  assert.deepEqual(await run, { statusLine: ['--theme', 'pastel'], tokenLine: [] });
});

test('a row with no part ticked is not accepted, and says why', async () => {
  const { io, next, press, answer } = await driver();
  const run = runWizard(io, { preview });
  await answer(KEY.down, KEY.enter);
  await answer(KEY.up, KEY.enter); // one row
  const row = await next();
  await press(row, KEY.space, KEY.down, KEY.space, KEY.down, KEY.space, KEY.enter); // untick ctx, 5h, 7d
  assert.match(plain(row.lastFrame()), /Tick at least one part/);
  await press(row, KEY.space, KEY.enter); // tick 7d
  for (let i = 0; i < 7; i++) await answer(KEY.enter);
  assert.deepEqual(await run, { statusLine: ['--show', '7d'], tokenLine: [] });
});

test('Ctrl+C stops the questions, as the end of the answers does, and writes nothing', async () => {
  const { io, answer } = await driver();
  const stopped = assert.rejects(runWizard(io, { preview }), (err) => err instanceof Interrupted && err instanceof EndOfAnswers);
  await answer(KEY.down, KEY.enter);
  await answer(KEY.ctrlC);
  await stopped;
});

// The choice of front end.
// A stream that says it is a terminal, or not.
const terminal = (isTTY = true) => Object.assign(new PassThrough(), { isTTY });

test('the questions use Ink when stdin and stdout are both a terminal and Ink loads', async () => {
  const ink = { choices: {}, close: () => {} };
  const calls = [];
  const load = async (...args) => (calls.push(args), ink);
  assert.equal(await openIo(terminal(), terminal(), load), ink);
  assert.equal(calls.length, 1);
  for (const [input, output] of [
    [terminal(false), terminal()],
    [terminal(), terminal(false)],
  ]) {
    const io = await openIo(input, output, load);
    assert.equal(io.choices, undefined, 'the readline wizard');
    io.close();
  }
  assert.equal(calls.length, 1, 'Ink is not loaded without a terminal at both ends');
});

test('the readline wizard runs, with no warning, when Ink cannot be loaded', async () => {
  const written = [];
  const output = terminal();
  output.on('data', (t) => written.push(String(t)));
  const io = await openIo(terminal(), output, async () => {
    throw new Error("Cannot find package 'ink'");
  });
  assert.equal(io.choices, undefined);
  io.close();
  assert.deepEqual(written, []);
});

test('a copy of dist/ with no node_modules, as the plugin checkout runs it, falls back to the readline wizard', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const copy = tempDir('claude-gauge-no-ink-');
  for (const name of fs.readdirSync(dist).filter((n) => n.endsWith('.js'))) fs.copyFileSync(path.join(dist, name), path.join(copy, name));
  const { openIo: copied } = require(path.join(copy, 'wizard.js'));
  const { loadInkIo } = require(path.join(copy, 'ink-io.js'));
  await assert.rejects(loadInkIo(terminal(), terminal(), false), /ink/i, 'Ink cannot be resolved from the copy');
  const io = await copied(terminal(), terminal());
  assert.equal(io.choices, undefined);
  io.close();
});

test('dist/cli.js from a copy with no node_modules runs the readline wizard, with no warning', () => {
  const dist = path.join(__dirname, '..', 'dist');
  // A checkout as the plugin has one: package.json and dist/, with no node_modules.
  const checkout = tempDir('claude-gauge-no-ink-cli-');
  const copy = path.join(checkout, 'dist');
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(checkout, 'package.json'));
  for (const name of fs.readdirSync(dist).filter((n) => n.endsWith('.js'))) fs.copyFileSync(path.join(dist, name), path.join(copy, name));
  const dir = configFolder();
  const bin = tempDir('claude-gauge-bin-');
  const r = runCli(dir, ['setup'], { cli: path.join(copy, 'cli.js'), input: 'y\n', env: { NO_COLOR: '1', PATH: bin, Path: bin } });
  ok(r);
  assert.match(r.stdout, /Use the defaults: both bars, with the parts above\? \[Y\/n\] y\n/, 'the typed question');
  assert.equal(r.stderr, '');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('the build loads Ink with a real import(), not a require()', () => {
  const dist = path.join(__dirname, '..', 'dist');
  const wizard = fs.readFileSync(path.join(dist, 'wizard.js'), 'utf8');
  const inkIo = fs.readFileSync(path.join(dist, 'ink-io.js'), 'utf8');
  assert.match(wizard, /\bimport\('\.\/ink-io\.js'\)/);
  assert.match(inkIo, /\bimport\('ink'\)/);
  assert.match(inkIo, /\bimport\('react'\)/);
  for (const [name, text] of [['wizard.js', wizard], ['ink-io.js', inkIo], ['cli.js', fs.readFileSync(path.join(dist, 'cli.js'), 'utf8')]]) {
    assert.doesNotMatch(text, /require\("(?:ink|react)"\)/, name);
    assert.doesNotMatch(text, /require\("\.\/ink-io(?:\.js)?"\)/, name);
  }
});
