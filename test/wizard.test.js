'use strict';

// The setup wizard's questions, driven by scripted answers: the accept-
// defaults path, the customise path, answers it asks again for, and the star
// offer. The CLI suite drives the same wizard through a real process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { runWizard, offerStar, streamIo, EndOfAnswers, Interrupted, loadPayload, samplePayload, previewer, tokenPreviewer } = require('../dist/wizard.js');
const { DEFAULT_ROWS, PARTS } = require('../dist/statusline.js');

const { plain, tempDir } = require('./helpers');

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
    assert.deepEqual(await runWizard(io, { preview }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] }, JSON.stringify(yes));
    assert.equal(io.questions.length, 1);
    assert.deepEqual(calls, ['--bar-style dots'], 'the defaults draw the bars in dots');
    assert.ok(io.output.indexOf('<>') < io.output.indexOf(io.questions[0]), 'the preview comes before the question');
    assert.match(io.output, /Token line, when each turn ends/);
  }
});

test('the customise path covers rows, parts, bar style, segments, theme, labels and the token line, and previews after each answer', async () => {
  const io = scripted(['n', '3', 'ctx,7d', 'model', 'time, cost', 'classic', '10', 'pastel', 'n', 'n', 'y']);
  const { preview, calls } = fakePreview();
  const result = await runWizard(io, { preview });
  assert.deepEqual(result, {
    statusLine: ['--show', 'ctx,7d', '--show', 'model', '--show', 'time,cost', '--segments', '10', '--theme', 'pastel', '--no-labels'],
    tokenLine: null,
  });
  const defaultRows = DEFAULT_ROWS.map((r) => r.join(','));
  assert.deepEqual(calls, [
    // the defaults, in the dots bar style
    '--bar-style dots',
    // three rows, the third with a set of parts no row before it shows
    `--show ${defaultRows[0]} --show ${defaultRows[1]} --show cost,lines,git,todos --bar-style dots`,
    `--show ctx,7d --show ${defaultRows[1]} --show cost,lines,git,todos --bar-style dots`,
    '--show ctx,7d --show model --show cost,lines,git,todos --bar-style dots',
    '--show ctx,7d --show model --show time,cost --bar-style dots',
    // the bar style, answered classic
    '--show ctx,7d --show model --show time,cost',
    '--show ctx,7d --show model --show time,cost --segments 10',
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel',
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel --no-labels',
    // the token line answer redraws too, with the token line now off
    '--show ctx,7d --show model --show time,cost --segments 10 --theme pastel --no-labels',
  ]);
  assert.match(io.output, /Token line: off/);
  // Each question comes after the preview of the answer before it.
  assert.equal(io.questions.length, 11);
  assert.match(io.questions.at(-1), /Write these choices/);
});

test('the token line shows under the status line, and redraws with the parts answered', async () => {
  const io = scripted(['n', '1', 'ctx', 'classic', '', '', 'y', 'y', 'req,ctx', 'y']);
  const { preview } = fakePreview();
  const tokenCalls = [];
  const tokenPreview = (switches) => {
    tokenCalls.push(switches.join(' '));
    return `[${switches.join(' ')}]`;
  };
  const result = await runWizard(io, { preview, tokenPreview });
  assert.deepEqual(result.tokenLine, ['--show', 'req,ctx']);
  assert.match(io.output, /Token line, when each turn ends\n\n {2}\[\]\n/, 'the line with the switches set up');
  assert.match(io.output, /Token line, when each turn ends\n\n {2}\[--show req,ctx\]\n/, 'the line with the parts answered');
  assert.equal(tokenCalls.at(-1), '--show req,ctx');
});

test("the token line's sample run shows each part, and follows its switches", () => {
  const preview = tokenPreviewer(new Date(2026, 10, 1, 12, 10).getTime());
  assert.equal(preview([]), '12:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r324k │ ctx 43% ▓▓░░░ 86.0k');
  assert.equal(preview(['--show', 'req,ctx', '--segments', '10']), '4 req │ ctx 43% ▓▓▓▓░░░░░░ 86.0k');
  assert.equal(preview(['--show', 'ctx', '--window', '1m']), 'ctx 9% ░░░░░ 86.0k');
});

test('customising with Enter at every question keeps the defaults: the dots bar style, and so no cells question', async () => {
  const io = scripted(['n', '', '', '', '', '', '', '', '', '']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] });
  assert.equal(io.questions.length, 10, 'two default rows: one question for each');
  assert.ok(!io.questions.some((q) => /Cells per classic bar/.test(q)), 'no classic bar, so no cells question');
});

test('an answer the wizard cannot use is asked again, with the reason', async () => {
  const io = scripted(['maybe', 'n', '9', '1', 'ctx,bogus', ',', 'ctx', 'wavy', 'classic', '7', '10', 'vapor', 'mono', 'perhaps', 'y', 'y', '', 'y']);
  const { preview } = fakePreview();
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: ['--show', 'ctx', '--segments', '10', '--theme', 'mono'], tokenLine: [] });
  assert.match(io.output, /Answer y or n/);
  assert.match(io.output, /a number from 1 to 3/);
  assert.match(io.output, /Unknown part: bogus/);
  assert.match(io.output, /Name at least one part/);
  assert.match(io.output, /Unknown bar style: wavy\. Answer one of classic, steps, rising, hairline, dots, spark, underline, or a list such as steps,ctx=rising\./);
  assert.match(io.output, /5 or 10/);
  assert.match(io.output, /Unknown theme: vapor/);
});

// The status line questions on the customise path, each answered with Enter.
const enterAtStatusLine = ['n', '', '', '', 'classic', '', '', ''];
// The same, with lines set up: change them, from where they are.
const enterAtStatusLineSetUp = ['change', ...enterAtStatusLine.slice(1)];

test('a yes to the token line asks for its parts: Enter writes no --show, and any other answer writes it', async () => {
  const { preview } = fakePreview();
  const enter = scripted([...enterAtStatusLine, 'y', '', 'y']);
  assert.deepEqual(await runWizard(enter, { preview }), { statusLine: [], tokenLine: [] });
  const asked = enter.questions.at(-2);
  assert.match(asked, /Token line parts/);
  assert.match(asked, /req,out,ctx/, 'the shorter list is offered');
  assert.match(asked, /\[time,req,out,cache,ctx\] $/, 'all five parts in brackets');

  const fewer = scripted([...enterAtStatusLine, 'y', 'req,out,ctx', 'y']);
  assert.deepEqual(await runWizard(fewer, { preview }), { statusLine: [], tokenLine: ['--show', 'req,out,ctx'] });
  const spaced = scripted([...enterAtStatusLine, 'y', 'ctx, time ctx', 'y']);
  assert.deepEqual(await runWizard(spaced, { preview }), { statusLine: [], tokenLine: ['--show', 'ctx,time'] });
  const reordered = scripted([...enterAtStatusLine, 'y', 'ctx,time,req,out,cache', 'y']);
  assert.deepEqual(await runWizard(reordered, { preview }), { statusLine: [], tokenLine: ['--show', 'ctx,time,req,out,cache'] });
});

test('an unknown token line part is asked again, and the message names it', async () => {
  const io = scripted([...enterAtStatusLine, 'y', 'req,bogus', ',', 'out', 'y']);
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

test('a yes to the token line asks no context window question, and writes no --window', async () => {
  const { preview } = fakePreview();
  const io = scripted([...enterAtStatusLine, 'y', '', 'y']);
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: [] });
  assert.ok(!io.questions.some((q) => /Context window/i.test(q)));
  assert.doesNotMatch(io.output, /context window/i, 'nor the note that came before it');
  assert.match(io.questions.at(-1), /Write these choices/, 'the parts are the last token line question');
});

test('configure: a --window set up stays exactly as it is written, with the parts kept or changed', async () => {
  const { preview } = fakePreview();
  for (const tokenLine of [['--window', '1m', '--show', 'req,ctx', '--segments=10'], ['--window=200K', '--window', '1M'], ['--window', 'huge'], ['--window', '200k']]) {
    const installed = { statusLine: [], tokenLine };
    const kept = scripted([...enterAtStatusLineSetUp, '', '', 'y']);
    assert.deepEqual(await runWizard(kept, { preview, installed }), { statusLine: [], tokenLine }, tokenLine.join(' '));
    assert.ok(!kept.questions.some((q) => /Context window/i.test(q)));
    const changed = scripted([...enterAtStatusLineSetUp, '', 'out', 'y']);
    const others = tokenLine.filter((w, i) => w !== '--show' && tokenLine[i - 1] !== '--show');
    assert.deepEqual(await runWizard(changed, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'out', ...others] }, tokenLine.join(' '));
  }
});

test('configure: the token line parts start from the installed --show, Enter keeps the switches, and a change keeps the others', async () => {
  const { preview } = fakePreview();
  const tokenLine = ['--window', '1m', '--show', 'req,bogus,ctx', '--segments=10'];
  const installed = { statusLine: [], tokenLine };
  const kept = scripted([...enterAtStatusLineSetUp, '', '', 'y']);
  assert.deepEqual(await runWizard(kept, { preview, installed }), { statusLine: [], tokenLine });
  assert.match(kept.questions.at(-2), /\[req,ctx\] $/, 'the parts the token line shows now');

  const changed = scripted([...enterAtStatusLineSetUp, '', 'out', 'y']);
  assert.deepEqual(await runWizard(changed, { preview, installed }), { statusLine: [], tokenLine: ['--show', 'out', '--window', '1m', '--segments=10'] });

  const all = scripted([...enterAtStatusLineSetUp, '', 'time,req,out,cache,ctx', 'y']);
  assert.deepEqual(await runWizard(all, { preview, installed }), { statusLine: [], tokenLine: ['--window', '1m', '--segments=10'] }, 'all five need no --show');
  for (const word of ['all', 'All']) {
    const named = scripted([...enterAtStatusLineSetUp, '', word, 'y']);
    assert.deepEqual(await runWizard(named, { preview, installed }), { statusLine: [], tokenLine: ['--window', '1m', '--segments=10'] }, `${word} answers all five`);
  }

  // A --show with no part the token line knows shows all five.
  const unknown = scripted([...enterAtStatusLineSetUp, '', '', 'y']);
  await runWizard(unknown, { preview, installed: { tokenLine: ['--show=bogus', '--window', '1m'] } });
  assert.match(unknown.questions.at(-2), /\[time,req,out,cache,ctx\] $/);
});

// An io with choices, as the Ink front end has, that answers each question
// with the next scripted answer: a function of the question that gives its
// answer. It keeps each question.
function choosing(answers) {
  const left = [...answers];
  const questions = [];
  const next = async (question) => {
    questions.push(question);
    if (!left.length) throw new EndOfAnswers();
    return left.shift()(question);
  };
  return { questions, ask: async () => undefined, write: () => {}, choices: { one: next, many: next, each: next, preview: () => {} } };
}

// Enter at a choice: the option it starts on, or the parts ticked first.
const enter = (q) => (q.targets ? { all: q.initial.all, each: [...q.initial.each] } : Array.isArray(q.initial) ? [...q.initial] : q.options[q.initial].value);
// The option with `label`.
const pick = (label) => (q) => {
  const option = q.options.find((o) => o.label === label);
  assert.ok(option, `${label} in ${q.options.map((o) => o.label).join(', ')}`);
  return option.value;
};

// The status line questions on the customise path, each answered with Enter.
// The bar style answered classic, as the status line draws with no switch,
// so the cells question follows.
const classicStyle = (q) => ({ all: 'classic', each: q.targets.map(() => 'classic') });
const enterAtStatusLineChoices = [pick('No'), enter, enter, enter, classicStyle, enter, enter, enter];

test('as a choice, the token line asks no context window question, and configure keeps a --window set up', async () => {
  const { preview } = fakePreview();
  const io = choosing([...enterAtStatusLineChoices, enter, enter, enter]);
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: [] });
  assert.ok(!io.questions.some((q) => /Context window/i.test(q.message)));
  const installed = { statusLine: [], tokenLine: ['--window', 'huge', '--show', 'req,ctx'] };
  const kept = choosing([pick('Change them'), ...enterAtStatusLineChoices.slice(1), enter, enter, enter]);
  assert.deepEqual(await runWizard(kept, { preview, installed }), { statusLine: [], tokenLine: installed.tokenLine });
});

// configure: the wizard starts from the switches set up now.
test('configure offers to keep the lines set up now, and a yes leaves both as they are', async () => {
  const io = scripted(['keep']);
  const { preview, calls } = fakePreview();
  const installed = { statusLine: ['--theme', 'mono', '--segments', '10'] };
  assert.deepEqual(await runWizard(io, { preview, installed }), {});
  assert.equal(io.questions.length, 1);
  assert.match(io.questions[0], /Keep the current lines/);
  assert.match(io.output, /as set up now/);
  assert.deepEqual(calls, ['--segments 10 --theme mono'], 'the preview starts from the installed layout');
  assert.match(io.output, /Token line: off/);

  const both = { statusLine: ['--text', 'a b', '--frobnicate'], tokenLine: ['--window', '1m'] };
  assert.deepEqual(await runWizard(scripted(['']), { preview, installed: both }), {});
  // A token line alone: the preview says the status line is not set up.
  const tokenOnly = scripted(['k']);
  assert.deepEqual(await runWizard(tokenOnly, { preview, installed: { tokenLine: [] } }), {});
  assert.match(tokenOnly.output, /Status line: not set up/);
  assert.doesNotMatch(tokenOnly.output, /as set up now/);
});

test('with lines set up, start over asks as a first setup does, from the defaults, and change asks again for a wrong answer', async () => {
  const installed = { statusLine: ['--theme', 'mono', '--segments', '10'], tokenLine: ['--show', 'out'] };
  const { preview, calls } = fakePreview();
  const over = scripted(['over', 'y']);
  assert.deepEqual(await runWizard(over, { preview, installed }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] });
  assert.match(over.questions[0], /keep, change or over/);
  assert.match(over.questions[1], /Use the defaults/);
  assert.equal(calls.at(-1), '--bar-style dots', 'the last preview is the defaults');
  // No to the defaults: each question then offers the default, not the value set up.
  const fresh = scripted(['o', 'n', '', '', '', '', '', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(fresh, { preview, installed }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] });
  assert.ok(fresh.questions.some((q) => /Bar style: .*\[dots\] $/.test(q)), 'the bar style question offers dots');
  assert.ok(fresh.questions.some((q) => /Theme: .*\[default\] $/.test(q)), 'the theme question offers the default');

  const wrong = scripted(['maybe', 'k']);
  assert.deepEqual(await runWizard(wrong, { preview, installed }), {});
  assert.match(wrong.output, /Answer keep, change or over\./);
});

test('as a choice with lines set up, the start over option previews the defaults, and only the bar style preview moves', async () => {
  const installed = { statusLine: ['--theme', 'mono'] };
  const moving = [];
  const preview = (switches, _plain, move) => (move && moving.push(switches.join(' ')), `<${switches.join(' ')}>`);
  let first;
  const look = (q) => ((first = q), 'keep');
  assert.deepEqual(await runWizard(choosing([look]), { preview, installed }), {});
  assert.deepEqual(first.options.map((o) => o.label), ['Keep them as they are', 'Change them', 'Start over from the defaults']);
  assert.match(first.preview('keep'), /<--theme mono>/);
  assert.match(first.preview('over'), /<--bar-style dots>/);
  assert.match(first.preview('over'), /with the defaults/);

  const asked = [];
  const record = (answer) => (q) => (asked.push(q), answer(q));
  const io = choosing([pick('Start over from the defaults'), pick('No'), ...Array.from({ length: 10 }, () => record(enter))]);
  assert.deepEqual(await runWizard(io, { preview, installed }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] });
  const style = asked.find((q) => q.message === 'Bar style?');
  assert.deepEqual(
    asked.filter((q) => q.moving).map((q) => q.message),
    ['Bar style?'],
  );
  assert.equal(moving.length, 0, 'no moving preview before the bar style question shows one');
  style.preview('steps', ['steps', 'rising', 'steps', 'steps']);
  assert.deepEqual(moving, ['--bar-style steps,5h=rising']);
});

test('typed, the bar style and the cells take a per-bar list, ask again for a wrong one, and the token line takes the ctx style', async () => {
  const { preview } = fakePreview();
  const mixed = scripted(['n', '', '', '', 'steps,ctx=rising', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(mixed, { preview }), { statusLine: ['--bar-style', 'steps,ctx=rising'], tokenLine: ['--bar-style', 'rising'] });
  assert.ok(!mixed.questions.some((q) => /Cells/.test(q)), 'no classic bar, so no cells question');

  const cells = scripted(['n', '', '', '', 'ctx=wavy', 'cpu=steps', 'classic,ctx=steps', '10,5h=5', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(cells, { preview }), {
    statusLine: ['--bar-style', 'classic,ctx=steps', '--segments', '10,5h=5'],
    tokenLine: ['--bar-style', 'steps'],
  });
  assert.match(cells.output, /Unknown bar style: ctx=wavy\./);
  assert.match(cells.output, /Unknown bar style: cpu=steps\./);

  // configure: a list with no bare value changes only the bars it names.
  const installed = { statusLine: ['--bar-style', 'steps,ctx=rising,7d=bogus'] };
  const change = scripted(['change', '', '', '', 'ctx=dots', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(change, { preview, installed }), { statusLine: ['--bar-style', 'steps,ctx=dots,7d=classic'], tokenLine: null });
  assert.ok(change.questions.some((q) => /Bar style: .*\[steps,ctx=rising,7d=classic\] $/.test(q)), 'the hint reads an unknown style as classic');
  assert.ok(change.questions.some((q) => /Cells per classic bar/.test(q)), '7d reads as classic, so the cells question comes');
});

test('as a choice, the bar style has a place for each bar, and the cells question one for each classic bar', async () => {
  const { preview } = fakePreview();
  const asked = [];
  // ctx keeps classic, the others take steps; then 10 cells for ctx.
  const style = (q) => (asked.push(q), { all: 'steps', each: ['classic', 'steps', 'steps', 'steps'] });
  const cells = (q) => (asked.push(q), { all: q.options.find((o) => o.value === '10').value, each: [] });
  const io = choosing([pick('No'), enter, enter, enter, style, cells, enter, enter, enter, enter, enter]);
  assert.deepEqual(await runWizard(io, { preview }), {
    statusLine: ['--bar-style', 'steps,ctx=classic', '--segments', '10'],
    tokenLine: [],
  });
  assert.deepEqual(asked[0].targets, ['ctx', '5h', '7d', 'ram']);
  assert.deepEqual(asked[0].initial, { all: 'dots', each: ['dots', 'dots', 'dots', 'dots'] }, 'a new setup starts from dots');
  assert.deepEqual(asked[1].targets, [], 'one classic bar: that bar alone, with no All');
  assert.equal(asked[1].allLabel, 'ctx');
  assert.equal(asked[1].message, 'Cells per classic bar?');
});

test('configure: each question defaults to the installed value, and the switches it does not ask about stay', async () => {
  const io = scripted(['change', '', '', '', '', '', '', '', '', 'y']);
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
  assert.match(io.questions[3], /\[classic\] $/);
  assert.match(io.questions[4], /\[10\] $/);
  assert.match(io.questions[5], /\[mono\] $/);
  assert.match(io.questions[6], /\[y\/N\] $/, 'labels are off');
  assert.match(io.questions[7], /token line.*\[Y\/n\] $/, 'a token line is set up');
});

test('configure: the token line defaults to no when none is set up, and answers change only what they name', async () => {
  const { preview } = fakePreview();
  const installed = { statusLine: ['--text', 'a b', '--segments', '10'] };
  // No --show: the two default rows, one question each.
  const io = scripted(['change', '', '', '', '', '5', 'pastel', '', '', 'y']);
  assert.deepEqual(await runWizard(io, { preview, installed }), { statusLine: ['--theme', 'pastel', '--text', 'a b'], tokenLine: null });
  assert.match(io.questions[8], /token line.*\[y\/N\] $/);
  assert.deepEqual(await runWizard(scripted(['change', '', '', '', '', '', '', '', 'y', '', 'y']), { preview, installed }), { statusLine: ['--segments', '10', '--text', 'a b'], tokenLine: [] });
  // Two rows asked for where one is set up: the second offers the default row.
  const rows = scripted(['change', '2', '', '', '', '', '', '', '', 'y']);
  await runWizard(rows, { preview, installed: { statusLine: ['--show', 'ctx'] } });
  assert.match(rows.questions[3], new RegExp(`\\[${DEFAULT_ROWS[1].join(',')}\\] $`));
  // More rows set up than the wizard offers: Enter keeps them all.
  const four = ['--show', 'ctx', '--show', '5h', '--show', '7d', '--show', 'model'];
  const many = scripted(['change', '', '', '', '', '', '', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(many, { preview, installed: { statusLine: four } }), { statusLine: four, tokenLine: null });
  assert.match(many.questions[1], /1 to 4\? \[4\] $/);
});

test('setup, or configure with no bar set up, starts from the factory defaults', async () => {
  for (const installed of [undefined, {}]) {
    const io = scripted(['y']);
    const { preview } = fakePreview();
    assert.deepEqual(await runWizard(io, { preview, installed }), { statusLine: ['--bar-style', 'dots'], tokenLine: ['--bar-style', 'dots'] });
    assert.match(io.questions[0], /Use the defaults/);
  }
});

test('a no at the last question changes nothing, and the end of the answers stops the wizard', async () => {
  const { preview } = fakePreview();
  assert.equal(await runWizard(scripted(['n', '', '', '', 'classic', '', '', '', '', '', 'n']), { preview }), null);
  await assert.rejects(runWizard(scripted([]), { preview }), EndOfAnswers);
  await assert.rejects(runWizard(scripted(['n', '2', 'ctx']), { preview }), EndOfAnswers);
});

test('the star offer defaults to yes, runs the star on a yes or Enter, and is skipped without gh', async () => {
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

  for (const no of ['n', 'no', 'N']) assert.equal((await offer(true, [no])).starred, 0, JSON.stringify(no));
  assert.equal((await offer(true, [])).starred, 0, 'the end of the answers is a no');
  for (const yes of ['', 'y', 'Yes']) assert.equal((await offer(true, [yes])).starred, 1, JSON.stringify(yes));
  const yes = await offer(true, ['y']);
  assert.equal(yes.starred, 1);
  assert.match(yes.io.questions[0], /Star jv-k\/claude-gauge/);
  assert.match(yes.io.questions[0], /\[Y\/n\] $/, 'the default is yes');
  assert.match(yes.io.output, /Thank you/);

  const io = scripted(['y']);
  await offerStar(io, { hasGh: () => true, star: () => false });
  assert.match(io.output, /could not star/);
});

test('Ctrl+C at the star offer stops setup, as at any other question, and stars nothing', async () => {
  const stopped = { ...scripted([]), choices: { one: async () => { throw new Interrupted(); }, many: async () => [], preview: () => {} } };
  let starred = 0;
  await assert.rejects(offerStar(stopped, { hasGh: () => true, star: () => { starred++; return true; } }), (err) => err instanceof Interrupted && /settings are written/.test(err.message));
  assert.equal(starred, 0);
});

test('the preview uses the payload the status line saved, else a sample', () => {
  const dir = tempDir('claude-gauge-wizard-');
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
  assert.equal(plain(preview(['--show', 'model,ctx', '--no-bars'])), 'Saved Model │ ctx 12% 24.0k', "the sample's window size under the saved percentage");
  assert.equal(plain(preview(['--show', 'text', '--text', 'a label'])), 'a label', 'a value with a space stays one word');
  const sample = previewer(samplePayload(now), { nowMs: now, env: {} });
  assert.match(plain(sample(['--show', 'ctx,5h,7d'])), /^ctx \d+% .+ │ 5h \d+% .+ │ 7d \d+% /);
  assert.match(plain(sample(['--show', 'ctx', '--segments', '10'])), /^ctx \d+% [▓░]{10} /);
});

test('with sweep, a moving preview moves the ctx, 5h and 7d bars with the clock, keeps the other parts, and runs git once', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  let gitCalls = 0;
  const options = (nowMs) => ({ nowMs, env: {}, statusOf: () => (gitCalls++, '# branch.head main\n'), branchOf: () => 'main', sweep: true });
  const shown = ['--show', 'ctx,5h,7d,model', '--no-reset'];
  const frames = [0, 1000, 2000, 3000].map((ms) => plain(previewer(samplePayload(now), options(now + ms))(shown, false, true)));
  assert.equal(new Set(frames).size, frames.length, JSON.stringify(frames));
  for (const frame of frames) assert.match(frame, /^ctx \d+% [▓░]{5} [\d.]+k? │ 5h \d+% \S+ │ 7d \d+% \S+ │ Opus$/);
  // Without sweep, or with sweep but not moving, the payload's own figures.
  assert.match(plain(previewer(samplePayload(now), { nowMs: now, env: {} })(shown, false, true)), /^ctx 43% /);
  assert.match(plain(previewer(samplePayload(now), options(now + 1000))(shown)), /^ctx 43% /);
  // One previewer renders many frames, with git run once.
  gitCalls = 0;
  const preview = previewer(samplePayload(now), options(undefined));
  for (let i = 0; i < 5; i++) preview(['--show', 'branch']);
  assert.equal(gitCalls, 1);
  // plain draws underline as classic, as --latest does.
  assert.match(preview([...shown, '--bar-style', 'underline'], true), /[▓░]{5}/);
});

test('a moving preview moves the ram bar too, and shows the time of the clock it is given', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  const memory = { used: 8 * 1024 ** 3, total: 16 * 1024 ** 3 };
  let time = now;
  const options = (nowMs) => ({ nowMs, env: {}, memoryOf: () => memory, sweep: true, clock: () => time });
  const shown = ['--show', 'ctx,ram'];
  const at = (ms) => ((time = now + ms), plain(previewer(samplePayload(now), options(now))(shown, false, true)));
  const frames = [0, 1500, 3000, 4500].map(at);
  assert.equal(new Set(frames.map((f) => f.split(' │ ')[1])).size, frames.length, JSON.stringify(frames));
  // The clock, not nowMs, sets the moving bars: the same clock time, the same frame.
  time = now + 1500;
  assert.equal(plain(previewer(samplePayload(now), options(now + 99999))(shown, false, true)), frames[1]);
  // Still, ram shows the memory as it is.
  assert.match(plain(previewer(samplePayload(now), options(now))(shown)), /ram 50% /);
});

test('the preview shows every part, alone, from a fresh config folder outside git', () => {
  const dir = tempDir('claude-gauge-wizard-');
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
  const options = { nowMs: now, env: { CLAUDE_CONFIG_DIR: dir } };
  const fresh = previewer({ ...samplePayload(now), workspace: { current_dir: dir } }, options);
  const saved = previewer({ model: { display_name: 'Saved Model' }, workspace: { current_dir: dir }, transcript_path: path.join(dir, 'gone.jsonl'), fast_mode: false }, options);
  for (const part of PARTS) {
    assert.notEqual(plain(fresh(['--show', part])), '', `${part} shows nothing from the sample`);
    assert.notEqual(plain(saved(['--show', part])), '', `${part} shows nothing from a saved payload`);
  }
});

test("the samples for the git and worktree parts stay out of the branch part's real branch", () => {
  const dir = tempDir('claude-gauge-wizard-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
  const preview = previewer({ ...samplePayload(now), workspace: { current_dir: dir } }, { nowMs: now, env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(plain(preview(['--show', 'branch'])), '⎇ main', 'a clean folder in no worktree');
  assert.match(plain(preview(['--show', 'git'])), /\S/, 'the git part shows the sample changes');
  assert.match(plain(preview(['--show', 'worktree'])), /^wt \S/, 'the worktree part shows the sample worktree');
});

test('the preview keeps what the payload holds, and never runs the command', () => {
  const dir = tempDir('claude-gauge-wizard-');
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
  const preview = previewer({ model: { display_name: 'Saved Model' }, cost: { total_cost_usd: 9.5 }, workspace: { current_dir: dir } }, { nowMs: now, env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(plain(preview(['--show', 'model,cost'])), 'Saved Model │ $9.50');
  assert.match(plain(preview(['--show', 'lines'])), /^\+\d+ −\d+$/, 'a gap in an object the payload has');
  const marker = path.join(dir, 'ran');
  assert.notEqual(plain(preview(['--show', 'command', '--command', `touch ${JSON.stringify(marker)}`])), '');
  assert.equal(fs.existsSync(marker), false, 'the command did not run');
});

// A stand-in for the output stream: a terminal of `columns` when `isTTY`,
// else a pipe, keeping all that is written to it.
function fakeOutput(isTTY, columns) {
  const output = { isTTY, columns, text: '', write: (t) => { output.text += t; return true; } };
  return output;
}

// The answers as piped lines, and the wizard run over them on `output`.
async function runOn(output, answers) {
  const io = streamIo(Readable.from([answers.map((a) => `${a}\n`).join('')]), output, false);
  const { preview, calls } = fakePreview();
  try {
    return { result: await runWizard(io, { preview }), calls };
  } finally {
    io.close();
  }
}

// One row of ctx, the rest with Enter, no token line, and a yes to write.
const oneRow = ['n', '1', 'ctx', 'classic', '', '', '', 'n', 'y'];

// The code that moves the cursor up `n` rows to the start of the old
// preview, and clears from there to the end of the screen.
const rewind = (n) => `\r\x1b[${n}A\x1b[J`;
const REWIND = /\r\x1b\[(\d+)A\x1b\[J/g;

test('on a terminal, each preview after an answer moves up over the last one and the question under it, and clears them', async () => {
  const output = fakeOutput(true, 80);
  const { result, calls } = await runOn(output, oneRow);
  assert.deepEqual(result, { statusLine: ['--show', 'ctx'], tokenLine: null });
  assert.equal(calls.length, 8);
  // A no to the defaults clears the first preview with the question under
  // it: the blank line before the heading, the heading and the blank line
  // after it, the two rows (the fake preview draws one line, so the second
  // is empty), a blank line, the token line's heading and the blank line
  // after it, and its sample of 81 characters, which takes two rows; then
  // the CONFIRM pill and its blank line, and the question and its answer:
  // thirteen rows. The STATUS LINE pill takes their place, and the first
  // preview after it starts fresh.
  const rewinds = [...output.text.matchAll(REWIND)];
  assert.equal(rewinds.length, 7, JSON.stringify(output.text));
  assert.equal(rewinds[0][0], rewind(13));
  assert.ok(rewinds[0].index < output.text.indexOf('STATUS LINE'));
  assert.ok(output.text.indexOf('STATUS LINE') < rewinds[1].index);
  // The next replaces the first preview of the status line's own steps,
  // which leaves the token line out: the blank line, the heading and the
  // blank line after it, the one row, the INPUT pill and its blank line,
  // then the question and its answer: seven rows.
  assert.equal(rewinds[1][0], rewind(7));
  assert.ok(output.text.lastIndexOf('<--show ctx>') > rewinds.at(-1).index, 'the last preview follows the last rewind');
});

test('on a narrow terminal, the rewind counts the rows that long lines wrap to', async () => {
  const output = fakeOutput(true, 20);
  await runOn(output, oneRow);
  // As on a wide terminal, but the row of 37 characters, the defaults' dots
  // style with it, takes two rows, and the question and its answer of 49
  // characters take three: ten rows in all.
  assert.equal([...output.text.matchAll(REWIND)][1][0], rewind(10));
});

test('with piped output, each preview prints below the last, with no cursor codes', async () => {
  const output = fakeOutput(false, undefined);
  const { calls } = await runOn(output, oneRow);
  assert.doesNotMatch(output.text, /\x1b/);
  assert.equal(output.text.match(/^Status line/gm).length, calls.length, 'every preview is in the output');
});

test('a typed < lists the steps answered so far, and a number goes back to that step, the answers after it kept', async () => {
  const { preview } = fakePreview();
  // The defaults, rows, two rows, bar style, cells, theme: mono, labels: no,
  // then < at the token line, back to the theme.
  const io = scripted(['n', '', '', '', 'classic', '', 'mono', 'n', '<', '7', 'pastel', '', '', '', 'y']);
  const choices = await runWizard(io, { preview });
  assert.deepEqual(choices, { statusLine: ['--theme', 'pastel', '--no-labels'], tokenLine: [] });
  assert.match(plain(io.output), /GO BACK\n {2}1\. Use the defaults +no\n {2}2\. Rows +2\n[\s\S]*7\. Theme +mono\n {2}8\. Labels +no\n {5}Token line +on {3}← you are here\n\n/);
  assert.match(plain(io.questions.at(-6)), /Go back to which step, 1 to 8\? Enter stays at Token line\. $/);
  assert.match(io.questions.at(-4), /Labels in front of the values[\s\S]*\[y\/N\]/, 'the answer given before is the one in brackets');
});

test('Enter or < at the list of steps stays at the step, and < at the first step says there is none before it', async () => {
  const { preview } = fakePreview();
  const io = scripted(['<', 'n', '<', '', '<', '<', '', '', '', 'classic', '', '', '', '', '', 'y']);
  assert.deepEqual(await runWizard(io, { preview }), { statusLine: [], tokenLine: [] });
  assert.match(plain(io.output), /There is no earlier step\./);
  const asked = io.questions.map(plain);
  assert.match(asked[2], /How many status line rows/);
  assert.match(asked[3], /Go back to which step/);
  assert.match(asked[4], /How many status line rows/, 'Enter stays');
  assert.match(asked[5], /Go back to which step/);
  assert.match(asked[6], /How many status line rows/, '< at the list stays');
});

test('with an order question, the wizard asks for the order of the rows, and with an edit question, edits each row with it', async () => {
  const asked = [];
  const notes = [];
  const left = [
    () => false, // the defaults: no
    (q) => q.options[q.initial].value, // rows: 2
    (q) => (notes.push(q.note('time')), [q.initial[1], q.initial[0], q.initial[2]]), // row 1: 5h,ctx,7d
    (q) => (notes.push(q.note('ctx'), q.note('cost')), ['time', 'model']), // row 2
    (q) => [q.options[1].value, q.options[0].value], // the rows: row 2 first
  ];
  const answer = async (q) => (asked.push(q), left.length ? left.shift()(q) : q.targets ? { all: q.initial.all, each: [...q.initial.each] } : Array.isArray(q.initial) ? [...q.initial] : q.options[q.initial].value);
  const many = async () => assert.fail('the edit question asks, not the tick list');
  const io = { ask: async () => undefined, write: () => {}, choices: { one: answer, many, each: answer, edit: answer, order: answer, preview: () => {} } };
  const choices = await runWizard(io, { preview: fakePreview().preview });
  assert.deepEqual(choices.statusLine, ['--show', 'time,model', '--show', '5h,ctx,7d', '--bar-style', 'dots']);
  assert.match(plain(notes[0]), /^time current local time\. Also in row 2\.$/);
  assert.match(plain(notes[1]), /^ctx .*\. Also in row 1\.$/);
  assert.doesNotMatch(plain(notes[2]), /Also in/, 'cost is in no other row');
  assert.deepEqual(asked[4].options.map((o) => o.label), ['5h, ctx, 7d', 'time, model']);
  assert.equal(asked[4].message, 'Order of the rows');
});

test('a third row starts with parts that no row before it shows', async () => {
  const io = scripted(['n', '3', 'cost,ctx', '', '', 'classic', '', '', '', 'n', 'y']);
  const { preview } = fakePreview();
  const { statusLine } = await runWizard(io, { preview });
  assert.deepEqual(statusLine.slice(0, 6), ['--show', 'cost,ctx', '--show', DEFAULT_ROWS[1].join(','), '--show', 'lines,git,todos,tools']);
  assert.match(io.questions[4], /Row 3: the parts, comma-separated \[lines,git,todos,tools\]/);
});

test('a row dropped by fewer rows comes back with its parts when the rows go up again in the same run', async () => {
  const { preview } = fakePreview();
  // Three rows, row 3: cost. Back to the rows: one row. Back again: three.
  const io = scripted(['n', '3', '', '', 'cost', '<', '2', '1', '', '<', '2', '3', '', '', '', 'classic', '', '', '', '', '', '', 'y']);
  const choices = await runWizard(io, { preview });
  assert.deepEqual(choices.statusLine.slice(-2), ['--show', 'cost']);
  assert.match(io.questions.filter((q) => q.startsWith('Row 3')).at(-1), /Row 3: the parts, comma-separated \[cost\]/);
});

test('"Keep them as they are", picked after changes, says the changes are not written', async () => {
  const { preview } = fakePreview();
  const installed = { statusLine: ['--theme', 'mono'] };
  const io = scripted(['change', '', '', '', '', '', 'pastel', '<', '1', 'keep']);
  assert.deepEqual(await runWizard(io, { preview, installed }), {});
  assert.match(plain(io.output), /Kept the lines as set up\. The changes made in this run are not written\./);
  const quiet = scripted(['change', '<', '1', 'keep']);
  assert.deepEqual(await runWizard(quiet, { preview, installed }), {});
  assert.doesNotMatch(plain(quiet.output), /Kept the lines/, 'no changes, no note');
});

test('the preview marks the part being edited in brackets, starts a third row with parts of its own, shows a row with no parts yet, and leaves the token line out of the status line steps', async () => {
  const nowMs = Date.UTC(2026, 10, 3, 12);
  // Each question's preview, drawn while the question is asked, by its
  // message, with the selection given here.
  const drawn = {};
  const selections = {
    'How many status line rows?': [3],
    'Row 1: the parts': [['ctx', '5h', '7d'], 1],
    'Row 3: the parts': [[], 0],
    'Bar style?': ['dots', ['dots', 'hairline', 'dots', 'dots'], { row: 0, part: 1 }],
    'Add the token line, shown when each turn ends?': [true],
    'Token line parts': [['time', 'req'], 1],
  };
  const answer = async (q) => {
    if (selections[q.message]) drawn[q.message] = plain(q.preview(...selections[q.message]));
    if (/Use the defaults/.test(q.message)) return false;
    if (/How many status line rows/.test(q.message)) return 3;
    if (/Row 3/.test(q.message)) return ['cost'];
    if (q.message === 'Order of the rows') return q.options.map((o) => o.value);
    return enter(q);
  };
  const io = { ask: async () => undefined, write: () => {}, choices: { one: answer, many: answer, each: answer, edit: answer, order: answer, preview: () => {} } };
  await runWizard(io, { preview: previewer(samplePayload(nowMs), { nowMs }), tokenPreview: tokenPreviewer(nowMs) });
  const rows = drawn['How many status line rows?'];
  assert.match(rows, /\n {2}\$1\.24 │ \+156 −23 │ [^\n]*\n$/, 'the third row, with parts no row before it shows: cost, lines, git and todos');
  assert.doesNotMatch(rows, /Token line/, 'a status line step leaves the token line out');
  assert.match(drawn['Row 1: the parts'], /❯ ctx 43% [^\n]* │ \[5h 9%[^\]\n]*\] │ 7d/, 'the row edited marked with ❯, and its part at the cursor in brackets');
  assert.match(drawn['Row 3: the parts'], /❯ row 3: no parts yet/);
  assert.match(drawn['Bar style?'], /❯ ctx 43% [^\n]* │ \[5h 9% ━[^\]\n]*\] │ 7d/, 'the bar at the cursor in brackets, in its style');
  assert.match(drawn['Add the token line, shown when each turn ends?'], /Token line, when each turn ends/, 'the token line steps show it');
  assert.match(drawn['Token line parts'], /Token line, when each turn ends\n\n❯ \d\d:\d\d │ \[4 req\]\n/, 'the token line part at the cursor in brackets');
});

test('the customise path links to the table of parts in the README, as a terminal link only in colour', async () => {
  const { preview } = fakePreview();
  const url = 'https://github.com/jv-k/claude-gauge#what-the-lines-show';
  const io = scripted(['n', '1', 'ctx']);
  await assert.rejects(runWizard(io, { preview }), EndOfAnswers);
  assert.ok(io.output.includes(`What each part shows: ${url}\n`), 'the address in full, with no codes');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /^## What the lines show$/m, 'the heading the anchor names');
  const coloured = Object.assign(scripted(['n', '1', 'ctx']), { color: true });
  await assert.rejects(runWizard(coloured, { preview }), EndOfAnswers);
  assert.ok(coloured.output.includes(`\x1b]8;;${url}\x07`), 'in colour, a link a terminal can open');
});
