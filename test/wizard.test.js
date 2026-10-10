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

const { plain } = require('./helpers');

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

// A preview that shows the switches it was given, and keeps each call, its
// words joined with spaces.
function fakePreview() {
  const calls = [];
  const preview = (switches) => {
    calls.push(switches.join(' '));
    return `<${switches.join(' ')}>`;
  };
  return { preview, calls };
}

test('the defaults path completes in one confirmation, after a preview of the default bars', async () => {
  for (const yes of ['y', '', 'Yes', ' Y ']) {
    const io = scripted([yes]);
    const { preview, calls } = fakePreview();
    assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: [] }, JSON.stringify(yes));
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
    statusLine: ['--show', 'ctx,7d', '--show', 'model', '--show', 'time,cost', '--segments', '10', '--theme', 'pastel', '--no-labels'],
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
  const io = scripted(['n', '', '', '', '', '', '', '', '', '', '']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: [] });
  assert.equal(io.questions.length, 11, 'two default rows: one question for each');
});

test('an answer the wizard cannot use is asked again, with the reason', async () => {
  const io = scripted(['maybe', 'n', '9', '1', 'ctx,bogus', ',', 'ctx', '7', '10', 'neon', 'mono', 'perhaps', 'y', 'y', '', '', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: ['--show', 'ctx', '--segments', '10', '--theme', 'mono'], tokenLine: [] });
  assert.match(io.output, /Answer y or n/);
  assert.match(io.output, /a number from 1 to 3/);
  assert.match(io.output, /Unknown part: bogus/);
  assert.match(io.output, /Name at least one part/);
  assert.match(io.output, /5 or 10/);
  assert.match(io.output, /Unknown theme: neon/);
});

// The status line questions on the customise path, each answered with Enter.
const enterAtStatusLine = ['n', '', '', '', '', '', ''];

test('a yes to the token line asks for its parts: Enter writes no --show, and any other answer writes it', async () => {
  const { preview } = fakePreview();
  const enter = scripted([...enterAtStatusLine, 'y', '', '', 'y']);
  assert.deepEqual(await runWizard(enter, { preview }), { statusLine: [], tokenLine: [] });
  const asked = enter.questions.at(-3);
  assert.match(asked, /Token line parts/);
  assert.match(asked, /req,out,ctx/, 'the shorter list is offered');
  assert.match(asked, /\[time,req,out,cache,ctx\] $/, 'all five parts in brackets');

  const fewer = scripted([...enterAtStatusLine, 'y', 'req,out,ctx', '', 'y']);
  assert.deepEqual(await runWizard(fewer, { preview }), { statusLine: [], tokenLine: ['--show', 'req,out,ctx'] });
  const spaced = scripted([...enterAtStatusLine, 'y', 'ctx, time ctx', '', 'y']);
  assert.deepEqual(await runWizard(spaced, { preview }), { statusLine: [], tokenLine: ['--show', 'ctx,time'] });
  const reordered = scripted([...enterAtStatusLine, 'y', 'ctx,time,req,out,cache', '', 'y']);
  assert.deepEqual(await runWizard(reordered, { preview }), { statusLine: [], tokenLine: ['--show', 'ctx,time,req,out,cache'] });
});

test('an unknown token line part is asked again, and the message names it', async () => {
  const io = scripted([...enterAtStatusLine, 'y', 'req,bogus', ',', 'out', '', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: ['--show', 'out'] });
  assert.match(io.output, /Unknown part: bogus\. The token line parts are time, req, out, cache, ctx\./);
  assert.match(io.output, /Name at least one part/);
  assert.equal(io.questions.filter((q) => /Token line parts/.test(q)).length, 3);
});

test('a no to the token line asks nothing about its parts', async () => {
  const io = scripted([...enterAtStatusLine, 'n', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: null });
  assert.ok(!io.questions.some((q) => /Token line parts/.test(q)));
  assert.ok(!io.questions.some((q) => /Context window/.test(q)));
});

test('a yes to the token line asks for its context window: Enter and 200k write no --window, and 1m writes it', async () => {
  const { preview } = fakePreview();
  const enter = scripted([...enterAtStatusLine, 'y', '', '', 'y']);
  assert.deepEqual(await runWizard(enter, { preview }), { statusLine: [], tokenLine: [] });
  const asked = enter.questions.at(-2);
  assert.match(asked, /^Context window/);
  assert.match(asked, /200k or 1m/, 'the two sizes are offered');
  assert.match(asked, /\[200k\] $/, 'the window the token line assumes without a switch');
  assert.ok(enter.questions.indexOf(asked) > enter.questions.findIndex((q) => /Token line parts/.test(q)), 'asked after the parts');
  for (const answer of ['200k', '200K', '200000']) {
    assert.deepEqual(await runWizard(scripted([...enterAtStatusLine, 'y', '', answer, 'y']), { preview }), { statusLine: [], tokenLine: [] }, answer);
  }
  for (const answer of ['1m', '1M', ' 1m ', '1000000']) {
    const expected = ['--window', answer.trim().toLowerCase()];
    assert.deepEqual(await runWizard(scripted([...enterAtStatusLine, 'y', '', answer, 'y']), { preview }), { statusLine: [], tokenLine: expected }, JSON.stringify(answer));
  }
  const both = scripted([...enterAtStatusLine, 'y', 'req,out,ctx', '1m', 'y']);
  assert.deepEqual(await runWizard(both, { preview }), { statusLine: [], tokenLine: ['--show', 'req,out,ctx', '--window', '1m'] });
  const other = scripted([...enterAtStatusLine, 'y', '', '500k', 'y']);
  assert.deepEqual(await runWizard(other, { preview }), { statusLine: [], tokenLine: ['--window', '500k'] }, 'any size the token line reads');
});

test('a context window the token line cannot read is asked again', async () => {
  const io = scripted([...enterAtStatusLine, 'y', '', 'huge', '0', '1m', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: ['--window', '1m'] });
  assert.match(io.output, /Answer a size such as 200k or 1m\./);
  assert.equal(io.questions.filter((q) => /^Context window/.test(q)).length, 3);
});

test('configure: the context window starts from the installed --window, Enter keeps the switches, and a change replaces only --window', async () => {
  const { preview } = fakePreview();
  const tokenLine = ['--window', '1m', '--show', 'req,ctx', '--segments=10'];
  const installed = { statusLine: [], tokenLine };
  const kept = scripted([...enterAtStatusLine, '', '', '', 'y']);
  assert.deepEqual(await runWizard(kept, { preview, installed }), { statusLine: [], tokenLine });
  assert.match(kept.questions.at(-2), /\[1m\] $/, 'the window set up');
  const same = scripted([...enterAtStatusLine, '', '', '1M', 'y']);
  assert.deepEqual(await runWizard(same, { preview, installed }), { statusLine: [], tokenLine }, 'the same size keeps the switches as they are');
  const back = scripted([...enterAtStatusLine, '', '', '200k', 'y']);
  assert.deepEqual(await runWizard(back, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'req,ctx', '--segments=10'] }, '200k needs no --window');
  const other = scripted([...enterAtStatusLine, '', '', '500k', 'y']);
  assert.deepEqual(await runWizard(other, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'req,ctx', '--segments=10', '--window', '500k'] });
  // Parts and window both changed: the new --show goes first, and the --window is dropped.
  const both = scripted([...enterAtStatusLine, '', 'out', '200k', 'y']);
  assert.deepEqual(await runWizard(both, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'out', '--segments=10'] });

  // The last --window, as the token line reads it, in the form it was written.
  const last = { tokenLine: ['--window=200K', '--window', '1M'] };
  const written = scripted([...enterAtStatusLine, '', '', '', 'y']);
  assert.deepEqual(await runWizard(written, { preview, installed: last }), { statusLine: [], tokenLine: last.tokenLine });
  assert.match(written.questions.at(-2), /\[1M\] $/);
  assert.deepEqual(await runWizard(scripted([...enterAtStatusLine, '', '', '200k', 'y']), { preview, installed: last }), { statusLine: [], tokenLine: [] }, 'every --window goes');
  // A --window the token line cannot read gives the window it assumes, 200k: Enter keeps the switch, and 200k drops it.
  const unread = { tokenLine: ['--window', 'huge'] };
  const kept2 = scripted([...enterAtStatusLine, '', '', '', 'y']);
  assert.deepEqual(await runWizard(kept2, { preview, installed: unread }), { statusLine: [], tokenLine: ['--window', 'huge'] });
  assert.match(kept2.questions.at(-2), /\[200k\] $/);
  assert.deepEqual(await runWizard(scripted([...enterAtStatusLine, '', '', '200k', 'y']), { preview, installed: unread }), { statusLine: [], tokenLine: [] });
});

test('configure: the token line parts start from the installed --show, Enter keeps the switches, and a change keeps the others', async () => {
  const { preview } = fakePreview();
  const tokenLine = ['--window', '1m', '--show', 'req,bogus,ctx', '--segments=10'];
  const installed = { statusLine: [], tokenLine };
  const kept = scripted([...enterAtStatusLine, '', '', '', 'y']);
  assert.deepEqual(await runWizard(kept, { preview, installed }), { statusLine: [], tokenLine });
  assert.match(kept.questions.at(-3), /\[req,ctx\] $/, 'the parts the token line shows now');

  const changed = scripted([...enterAtStatusLine, '', 'out', '', 'y']);
  assert.deepEqual(await runWizard(changed, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'out', '--window', '1m', '--segments=10'] });

  const all = scripted([...enterAtStatusLine, '', 'time,req,out,cache,ctx', '', 'y']);
  assert.deepEqual(await runWizard(all, { preview, installed }), { statusLine: [], tokenLine: ['--window', '1m', '--segments=10'] }, 'all five need no --show');
  for (const word of ['all', 'All']) {
    const named = scripted([...enterAtStatusLine, '', word, '', 'y']);
    assert.deepEqual(await runWizard(named, { preview, installed }), { statusLine: [], tokenLine: ['--window', '1m', '--segments=10'] }, `${word} answers all five`);
  }

  // A --show with no part the token line knows shows all five.
  const unknown = scripted([...enterAtStatusLine, '', '', '', 'y']);
  await runWizard(unknown, { preview, installed: { tokenLine: ['--show=bogus', '--window', '1m'] } });
  assert.match(unknown.questions.at(-3), /\[time,req,out,cache,ctx\] $/);
});

// configure: the wizard starts from the switches set up now.
test('configure offers to keep the bars set up now, and a yes leaves both as they are', async () => {
  const io = scripted(['y']);
  const { preview, calls } = fakePreview();
  const installed = { statusLine: ['--theme', 'mono', '--segments', '10'] };
  assert.deepEqual(await runWizard(io, { preview, installed }), {});
  assert.equal(io.questions.length, 1);
  assert.match(io.questions[0], /Keep the current bars/);
  assert.match(io.output, /as set up now/);
  assert.deepEqual(calls, ['--segments 10 --theme mono'], 'the preview starts from the installed layout');
  assert.match(io.output, /Token line: off/);

  const both = { statusLine: ['--text', 'a b', '--frobnicate'], tokenLine: ['--window', '1m'] };
  assert.deepEqual(await runWizard(scripted(['']), { preview, installed: both }), {});
  // A token line alone: the preview says the status line is not set up.
  const tokenOnly = scripted(['y']);
  assert.deepEqual(await runWizard(tokenOnly, { preview, installed: { tokenLine: [] } }), {});
  assert.match(tokenOnly.output, /status line is not set up/);
  assert.doesNotMatch(tokenOnly.output, /as set up now/);
});

test('configure: each question defaults to the installed value, and the switches it does not ask about stay', async () => {
  const io = scripted(['n', '', '', '', '', '', '', '', '', 'y']);
  const { preview, calls } = fakePreview();
  const installed = {
    statusLine: ['--text', 'a b', '--show', 'ctx,bogus,5h', '--segments=10', '--frobnicate', '--theme', 'mono', '--no-labels', '--right', 'ctx'],
    tokenLine: ['--window', '1m', '--show', 'req,ctx'],
  };
  const result = await runWizard(io, { preview, installed });
  assert.deepEqual(result, {
    statusLine: ['--show', 'ctx,5h', '--segments', '10', '--theme', 'mono', '--no-labels', '--text', 'a b', '--frobnicate', '--right', 'ctx'],
    tokenLine: ['--window', '1m', '--show', 'req,ctx'],
  });
  assert.equal(calls[0], '--show ctx,5h --segments 10 --theme mono --no-labels --text a b --frobnicate --right ctx');
  assert.match(io.questions[1], /\[1\] $/, 'one row set up');
  assert.match(io.questions[2], /\[ctx,5h\] $/);
  assert.match(io.questions[3], /\[10\] $/);
  assert.match(io.questions[4], /\[mono\] $/);
  assert.match(io.questions[5], /\[y\/N\] $/, 'labels are off');
  assert.match(io.questions[6], /token line.*\[Y\/n\] $/, 'a token line is set up');
});

test('configure: the token line defaults to no when none is set up, and answers change only what they name', async () => {
  const { preview } = fakePreview();
  const installed = { statusLine: ['--text', 'a b', '--segments', '10'] };
  // No --show: the two default rows, one question each.
  const io = scripted(['n', '', '', '', '5', 'pastel', '', '', 'y']);
  assert.deepEqual(await runWizard(io, { preview, installed }), { statusLine: ['--theme', 'pastel', '--text', 'a b'], tokenLine: null });
  assert.match(io.questions[7], /token line.*\[y\/N\] $/);
  assert.deepEqual(await runWizard(scripted(['n', '', '', '', '', '', '', 'y', '', '', 'y']), { preview, installed }), { statusLine: ['--segments', '10', '--text', 'a b'], tokenLine: [] });
  // Two rows asked for where one is set up: the second offers the default row.
  const rows = scripted(['n', '2', '', '', '', '', '', '', 'y']);
  await runWizard(rows, { preview, installed: { statusLine: ['--show', 'ctx'] } });
  assert.match(rows.questions[3], new RegExp(`\\[${DEFAULT_ROWS[1].join(',')}\\] $`));
  // More rows set up than the wizard offers: Enter keeps them all.
  const four = ['--show', 'ctx', '--show', '5h', '--show', '7d', '--show', 'model'];
  const many = scripted(['n', '', '', '', '', '', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(many, { preview, installed: { statusLine: four } }), { statusLine: four, tokenLine: null });
  assert.match(many.questions[1], /1 to 4\? \[4\] $/);
});

test('setup, or configure with no bar set up, starts from the factory defaults', async () => {
  for (const installed of [undefined, {}]) {
    const io = scripted(['y']);
    const { preview } = fakePreview();
    assert.deepEqual(await runWizard(io, { preview, installed }), { statusLine: [], tokenLine: [] });
    assert.match(io.questions[0], /Use the defaults/);
  }
});

test('a no at the last question changes nothing, and the end of the answers stops the wizard', async () => {
  const { preview } = fakePreview();
  assert.equal(await runWizard(scripted(['n', '', '', '', '', '', '', '', '', '', 'n']), { preview }), null);
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
    fs.writeFileSync(file, '{}');
    assert.deepEqual(loadPayload(file, now), samplePayload(now), 'an empty object');
    const saved = { model: { display_name: 'Saved Model' }, context_window: { used_percentage: 12 } };
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.deepEqual(loadPayload(file, now), saved);

    const preview = previewer(loadPayload(file, now), { nowMs: now, env: {} });
    assert.equal(plain(preview(['--show', 'model,ctx', '--no-bars'])), 'Saved Model │ ctx 12%');
    assert.equal(plain(preview(['--show', 'text', '--text', 'a label'])), 'a label', 'a value with a space stays one word');
    const sample = previewer(samplePayload(now), { nowMs: now, env: {} });
    assert.match(plain(sample(['--show', 'ctx,5h,7d'])), /^ctx \d+% .+ │ 5h \d+% .+ │ 7d \d+% /);
    assert.match(plain(sample(['--show', 'ctx', '--segments', '10'])), /^ctx \d+% [▓░]{10} /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
