'use strict';

// The built status line and token line, run as programs, print the README
// examples, and the TypeScript sources run under Bun print the same bytes.
// The Bun checks skip where Bun is not installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const withoutBun = !hasBun && 'bun is not installed';

// A config folder of its own, so a terminal render here never saves usage
// into the real one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));
// No COLUMNS of the caller's: an example that needs a width names its own.
const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
delete env.COLUMNS;
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const node = (script, args, input, columns) =>
  execFileSync(process.execPath, [path.join(root, 'dist', `${script}.js`), ...args], {
    env: columns ? { ...env, COLUMNS: String(columns) } : env,
    input,
    encoding: 'utf8',
  });
const bun = (script, args, input, columns) =>
  execFileSync('bun', [path.join(root, 'src', `${script}.ts`), ...args], {
    env: columns ? { ...env, COLUMNS: String(columns) } : env,
    input,
    encoding: 'utf8',
  });

// The README's status line payload, in a folder outside any git repository,
// so the branch part drops out and repo falls back to the folder name.
const project = path.join(tmp, 'project');
fs.mkdirSync(project);
const now = Math.floor(Date.now() / 1000);
const payload = JSON.stringify({
  model: { display_name: 'Opus 5.5' },
  workspace: { current_dir: project },
  context_window: { context_window_size: 200000, used_percentage: 43 },
  cost: { total_duration_ms: 72 * 60_000 },
  effort: { level: 'high' },
  rate_limits: {
    five_hour: { used_percentage: 9.4, resets_at: now + 2 * 3600 },
    seven_day: { used_percentage: 41.2, resets_at: now + 3 * 86400 },
  },
});

// The README examples' switches, less the parts that read the clock, so two
// runs a moment apart print the same bytes, and the terminal width an
// example needs.
const statusExamples = [
  [
    ['--show', 'ctx,5h,7d', '--show', 'duration,repo,branch,model,effort', '--no-reset'],
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ │ 7d 41% ▓▓░┃░\n1h12m │ project │ Opus 5.5 │ effort high\n',
  ],
  [
    ['--show', 'ctx,5h,7d', '--segments', '10', '--no-pace', '--no-reset'],
    'ctx 43% ▓▓▓▓░░░░░░ 86.0k │ 5h 9% ▓░░░░░░░░░ │ 7d 41% ▓▓▓▓░░░░░░\n',
  ],
  [['--show', 'ctx,5h,7d,model', '--no-labels', '--no-bars', '--no-reset', '--12h'], '43% 86.0k │ 9% │ 41% │ Opus 5.5\n'],
  [
    ['--show', 'ctx,5h,7d', '--show', 'duration,repo,branch,model,effort', '--no-reset', '--compact'],
    'c 43% ▓▓░░░ 86.0k│5h 9% ░░░┃░│7d 41% ▓▓░┃░\n1h12m│project│Opus 5.5│eff high\n',
  ],
  [
    ['--show', 'ctx,5h,7d', '--show', 'duration,repo,branch,model,effort', '--right', 'model,effort', '--no-reset'],
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ │ 7d 41% ▓▓░┃░\n1h12m │ project                       Opus 5.5 │ effort high\n',
    60,
  ],
];

// A transcript of one prompt and two API responses, as the Stop hook sees it.
const usage = (out, write, read, thinking) => ({
  output_tokens: out,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  input_tokens: 2,
  ...(thinking ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
});
const records = [
  { type: 'user', message: { content: 'this question' } },
  { type: 'assistant', message: { id: 'm1', usage: usage(1000, 4000, 100000, 400) } },
  { type: 'assistant', message: { id: 'm1', usage: usage(1000, 4000, 100000, 400) } },
  { type: 'user', message: { content: [{ type: 'tool_result' }] } },
  { type: 'assistant', message: { id: 'm2', usage: usage(500, 1000, 104000) } },
];
const transcript = path.join(tmp, 'transcript.jsonl');
fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const hook = JSON.stringify({ transcript_path: transcript });

const tokenExamples = [
  [['--show', 'req,out,cache,ctx'], '2 req │ out 1.5k (400 think) │ cache w5.0k r204k │ ctx 53% ▓▓▓░░ 105k'],
  [['--show', 'req,ctx', '--segments', '10', '--window', '1m'], '2 req │ ctx 11% ▓░░░░░░░░░ 105k'],
];

test('the built status line prints the README examples', () => {
  for (const [args, expected, columns] of statusExamples) {
    assert.equal(plain(node('statusline', args, payload, columns)), expected, args.join(' '));
  }
});

test('the built token line prints the README example as a Stop hook message', () => {
  for (const [args, expected] of tokenExamples) {
    assert.deepEqual(JSON.parse(node('tokenline', args, hook)), { systemMessage: expected }, args.join(' '));
  }
});

test('bun runs the status line from source with the same bytes as the build', { skip: withoutBun }, () => {
  for (const [args, , columns] of statusExamples) {
    assert.equal(bun('statusline', args, payload, columns), node('statusline', args, payload, columns), args.join(' '));
  }
});

test('bun runs the token line from source with the same bytes as the build', { skip: withoutBun }, () => {
  for (const [args] of tokenExamples) {
    assert.equal(bun('tokenline', args, hook), node('tokenline', args, hook), args.join(' '));
  }
});
