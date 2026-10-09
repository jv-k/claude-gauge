'use strict';

// The setup wizard's questions, driven by scripted answers: the accept-
// defaults path, the customise path, answers it asks again for, and the star
// offer. The CLI suite drives the same wizard through a real process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWizard, offerStar, EndOfAnswers, loadPayload, samplePayload, previewer } = require('../dist/wizard.js');
const { DEFAULT_ROWS } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

// An io that answers each question with the next scripted answer, then with
// the end of input, and keeps the questions and everything written.
function scripted(answers) {
  const left = [...answers];
  const io = {
    questions: [],
    output: '',
    ask: async (question) => {
      io.questions.push(question);
      io.output += question;
      return left.length ? left.shift() : undefined;
    },
    write: (text) => {
      io.output += text;
    },
  };
  return io;
}

// A preview that shows the switches it was given, and keeps each call.
function fakePreview() {
  const calls = [];
  const preview = (switches) => {
    calls.push(switches);
    return `<${switches}>`;
  };
  return { preview, calls };
}

test('the defaults path completes in one confirmation, after a preview of the default bars', async () => {
  for (const yes of ['y', '', 'Yes', ' Y ']) {
    const io = scripted([yes]);
    const { preview, calls } = fakePreview();
    assert.deepEqual(await runWizard(io, { preview }), { statusLine: '', tokenLine: '' }, JSON.stringify(yes));
    assert.equal(io.questions.length, 1);
    assert.deepEqual(calls, ['']);
    assert.ok(io.output.indexOf('<>') < io.output.indexOf(io.questions[0]), 'the preview comes before the question');
    assert.match(io.output, /Token line: on/);
  }
});

test('the customise path covers rows, parts, segments, theme, labels and the token line, and previews after each answer', async () => {
  const io = scripted(['n', '3', 'ctx,7d', 'model', 'time, cost', '10', 'pastel', 'n', 'n', 'y']);
  const { preview, calls } = fakePreview();
  const result = await runWizard(io, { preview });
  assert.deepEqual(result, {
    statusLine: '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel --no-labels',
    tokenLine: null,
  });
  const defaultRows = DEFAULT_ROWS.map((r) => r.join(','));
  assert.deepEqual(calls, [
    '',
    // three rows, the third empty until it is chosen, so still the default
    '',
    `--show ctx,7d --show ${defaultRows[1]}`,
    '--show ctx,7d --show model',
    '--show ctx,7d --show model --show time,cost',
    '--show ctx,7d --show model --show time,cost --segments 10',
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel',
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel --no-labels',
    // the token line answer redraws too, with the token line now off
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel --no-labels',
  ]);
  assert.match(io.output, /Token line: off/);
  // Each question comes after the preview of the answer before it.
  assert.equal(io.questions.length, 10);
  assert.match(io.questions.at(-1), /Write these choices/);
});

test('customising with Enter at every question keeps the defaults, which need no switches', async () => {
  const io = scripted(['n', '', '', '', '', '', '', '', '']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: '', tokenLine: '' });
  assert.equal(io.questions.length, 9, 'two default rows: one question for each');
});

test('an answer the wizard cannot use is asked again, with the reason', async () => {
  const io = scripted(['maybe', 'n', '9', '1', 'ctx,bogus', ',', 'ctx', '7', '10', 'neon', 'mono', 'perhaps', 'y', 'y', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: '--show ctx --segments 10 --theme mono', tokenLine: '' });
  assert.match(io.output, /Answer y or n/);
  assert.match(io.output, /1, 2 or 3/);
  assert.match(io.output, /Unknown part: bogus/);
  assert.match(io.output, /Name at least one part/);
  assert.match(io.output, /5 or 10/);
  assert.match(io.output, /Unknown theme: neon/);
});

test('a no at the last question changes nothing, and the end of the answers stops the wizard', async () => {
  const { preview } = fakePreview();
  assert.equal(await runWizard(scripted(['n', '', '', '', '', '', '', '', 'n']), { preview }), null);
  await assert.rejects(runWizard(scripted([]), { preview }), EndOfAnswers);
  await assert.rejects(runWizard(scripted(['n', '2', 'ctx']), { preview }), EndOfAnswers);
});

test('the star offer runs the star only on a yes, and is skipped without gh', async () => {
  const offer = async (hasGh, answers) => {
    const io = scripted(answers);
    let starred = 0;
    await offerStar(io, { hasGh: () => hasGh, star: () => { starred++; return true; } });
    return { io, starred };
  };
  const noGh = await offer(false, ['y']);
  assert.equal(noGh.starred, 0);
  assert.deepEqual(noGh.io.questions, [], 'not even asked');
  assert.equal(noGh.io.output, '');

  for (const no of ['n', '', 'no']) assert.equal((await offer(true, [no])).starred, 0, JSON.stringify(no));
  assert.equal((await offer(true, [])).starred, 0, 'the end of the answers is a no');
  const yes = await offer(true, ['y']);
  assert.equal(yes.starred, 1);
  assert.match(yes.io.questions[0], /Star jv-k\/claude-gauge/);
  assert.match(yes.io.output, /Thank you/);

  const io = scripted(['y']);
  await offerStar(io, { hasGh: () => true, star: () => false });
  assert.match(io.output, /could not star/);
});

test('the preview uses the payload the status line saved, else a sample', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-wizard-'));
  try {
    const file = path.join(dir, 'last-payload.json');
    const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
    assert.deepEqual(loadPayload(file, now), samplePayload(now), 'no file');
    fs.writeFileSync(file, '{"model":');
    assert.deepEqual(loadPayload(file, now), samplePayload(now), 'half a file');
    fs.writeFileSync(file, '[1]');
    assert.deepEqual(loadPayload(file, now), samplePayload(now), 'not an object');
    const saved = { model: { display_name: 'Saved Model' }, context_window: { used_percentage: 12 } };
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.deepEqual(loadPayload(file, now), saved);

    const preview = previewer(loadPayload(file, now), { nowMs: now, env: {} });
    assert.equal(plain(preview('--show model,ctx --no-bars')), 'Saved Model │ ctx 12%');
    const sample = previewer(samplePayload(now), { nowMs: now, env: {} });
    assert.match(plain(sample('--show ctx,5h,7d')), /^ctx \d+% .+ │ 5h \d+% .+ │ 7d \d+% /);
    assert.match(plain(sample('--show ctx --segments 10')), /^ctx \d+% [▓░]{10} /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
