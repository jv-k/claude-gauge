'use strict';

// Prints each screen of the setup questions as a terminal shows it: what the
// questions wrote so far, then the question on screen now. It drives the Ink
// front end with ink-testing-library and the real preview of a sample
// session, so the spacing between the parts of each screen can be read.
//
//   pnpm build && node docs/qa/setup-back-and-order/screens.js [setup|configure]

const path = require('node:path');
const root = path.join(__dirname, '..', '..', '..');
const { runWizard, previewer, samplePayload } = require(path.join(root, 'dist/wizard.js'));
const { inkIoWith } = require(path.join(root, 'dist/ink-io.js'));
const { plain } = require(path.join(root, 'test/helpers'));

const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', space: ' ', esc: '\x1b' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Text in reverse video as ⟦text⟧, so the plain screen shows the mark. A run
// of codes turns reverse on with 7, and off with a code that starts with 0.
function reversed(text) {
  let on = false;
  return text.replace(/(?:\x1b\[[0-9;]*m)+/g, (run) => {
    let now = on;
    for (const [code] of run.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const params = code.slice(2, -1);
      if (params === '' || params === '0' || params === '27' || params.startsWith('0;')) now = false;
      if (params.split(';').includes('7')) now = true;
    }
    const mark = now === on ? '' : now ? '⟦' : '⟧';
    on = now;
    return `${run}${mark}`;
  });
}

async function main() {
  const flow = process.argv[2] ?? 'configure';
  const ink = await import('ink');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const mounted = [];
  let ready = 0;
  let seen = 0;
  let out = '';
  const deps = { ink, React, mount: (tree) => (mounted.push(render(tree)), mounted.at(-1)), ready: () => ready++ };
  // Each answered question leaves its last frame on screen, then the io
  // writes its newline.
  const write = (t) => {
    const last = mounted.at(-1);
    if (t === '\n' && last && !last.kept) {
      last.kept = true;
      out += last.lastFrame();
    }
    out += t;
  };
  const io = inkIoWith(deps, { write, columns: 100 }, true);
  const nowMs = Date.UTC(2026, 10, 3, 12);
  const preview = previewer(samplePayload(nowMs), { nowMs });
  const installed =
    flow === 'configure'
      ? {
          statusLine: ['--show', 'ctx,5h,7d,ram', '--show', 'time,duration,repo,branch,model,effort', '--bar-style', 'classic,ctx=dots,5h=hairline', '--no-labels'],
          tokenLine: ['--bar-style', 'dots'],
        }
      : undefined;
  const run = runWizard(io, { preview, installed });
  const next = async () => {
    for (let waited = 0; ready <= seen; waited++) {
      if (waited > 3000) throw new Error(`no question ${seen + 1}: the keys no longer match the questions`);
      await delay(1);
    }
    return mounted[seen++];
  };
  let n = 0;
  const shot = (title, question) => {
    const screen = `${out}${question.lastFrame()}`;
    n++;
    // RAW=<n> writes screen n with its codes, for freeze, and nothing else.
    if (process.env.RAW) {
      if (Number(process.env.RAW) === n) process.stdout.write(screen.split('\n').slice(-60).join('\n'));
      return;
    }
    console.log(`\n${'═'.repeat(30)} ${n}. ${title} ${'═'.repeat(30)}\n${plain(reversed(screen)).replace(/ +$/gm, '')}\n${'─'.repeat(100)}`);
  };
  const step = async (title, ...keys) => {
    const q = await next();
    for (const key of keys.slice(0, -1)) {
      q.stdin.write(key);
      await delay(5);
    }
    shot(title, q);
    q.stdin.write(keys.at(-1));
    await delay(5);
  };
  if (flow === 'configure') await step('keep, change or over', KEY.down, KEY.enter);
  else await step('use the defaults', KEY.down, KEY.enter);
  await step('rows', KEY.enter);
  await step('parts, cursor on 5h', KEY.right, KEY.enter);
  await step('rows order, row 1 pushed down', '\t', KEY.enter);
  await step('bar style, cursor on ctx', KEY.right, KEY.enter);
  // A new setup starts from dots, which has no cells question.
  if (flow === 'configure') await step('cells', KEY.enter);
  await step('theme', KEY.enter);
  await step('labels', KEY.enter);
  await step('token line', KEY.enter);
  await step('token parts, cursor on out', KEY.right, KEY.right, KEY.enter);
  await step('write', KEY.esc);
  await step('steps list from write', KEY.up, KEY.enter);
  await step('token line again', KEY.enter);
  await step('token parts again', KEY.enter);
  await step('write again', KEY.enter);
  await run;
  shot('after', { lastFrame: () => '' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
