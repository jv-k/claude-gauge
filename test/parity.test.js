'use strict';

// The built status line and token line, run as programs, print the README
// examples, and the TypeScript sources run under Bun print the same bytes.
// The Bun checks skip where Bun is not installed. With REQUIRE_BUN=1, as the
// Bun jobs in CI set, they fail there instead, so a failed Bun install cannot
// pass as a skip.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const requireBun = process.env.REQUIRE_BUN === '1';
const withoutBun = !hasBun && !requireBun && 'bun is not installed';
const needBun = () => {
  if (!hasBun) assert.fail('Bun is required (REQUIRE_BUN=1) but bun is not on the PATH');
};

// The model part names the API provider from the environment, so the suite
// runs without the caller's provider variables.
for (const name of Object.keys(process.env)) {
  if (/^CLAUDE_CODE_USE_|^ANTHROPIC_BASE_URL$/.test(name)) delete process.env[name];
}

// A config folder of its own, so a terminal render here never saves usage
// into the real one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));
// No COLUMNS of the caller's: an example that needs a width names its own.
const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
delete env.COLUMNS;
// What the terminal shows: no colour codes, and no OSC 8 link wrappers.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

const envFor = (columns) => (columns ? { ...env, COLUMNS: String(columns) } : env);
const node = (script, args, input, columns) =>
  execFileSync(process.execPath, [path.join(root, 'dist', `${script}.js`), ...args], { env: envFor(columns), input, encoding: 'utf8' });
const bun = (script, args, input, columns) =>
  execFileSync('bun', [path.join(root, 'src', `${script}.ts`), ...args], { env: envFor(columns), input, encoding: 'utf8' });

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
  [
    ['--show', 'ctx,5h,7d', '--theme', 'pastel', '--bar-filled', '█', '--bar-empty', '·', '--no-reset'],
    'ctx 43% ██··· 86.0k │ 5h 9% ···┃· │ 7d 41% ██·┃·\n',
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
  needBun();
  for (const [args, , columns] of statusExamples) {
    assert.equal(bun('statusline', args, payload, columns), node('statusline', args, payload, columns), args.join(' '));
  }
});

test('bun runs the token line from source with the same bytes as the build', { skip: withoutBun }, () => {
  needBun();
  for (const [args] of tokenExamples) {
    assert.equal(bun('tokenline', args, hook), node('tokenline', args, hook), args.join(' '));
  }
});

// The suite again in a child process, with only its Bun cases and an empty
// folder for PATH, so bun is not found. Bun runs the suites with its own
// runner, which has no --test switch, so these two checks run under Node.
const underBun = Boolean(process.versions.bun) && "the child run needs Node's test runner";
const runBunCasesWithoutBun = (extra) => {
  const empty = fs.mkdtempSync(path.join(tmp, 'path-'));
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PATH|REQUIRE_BUN|NODE_TEST_CONTEXT)$/i.test(name)));
  return spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-name-pattern=^bun runs', __filename],
    { env: { ...childEnv, ...extra, PATH: empty }, encoding: 'utf8' },
  );
};

test('REQUIRE_BUN=1 fails the Bun cases where bun is not on the PATH', { skip: underBun }, () => {
  const run = runBunCasesWithoutBun({ REQUIRE_BUN: '1' });
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /^not ok \d+ - bun runs the status line/m);
  assert.match(run.stdout, /^not ok \d+ - bun runs the token line/m);
  assert.match(run.stdout, /Bun is required \(REQUIRE_BUN=1\) but bun is not on the PATH/);
});

test('without REQUIRE_BUN, the Bun cases skip where bun is not on the PATH', { skip: underBun }, () => {
  const run = runBunCasesWithoutBun({});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^ok \d+ - bun runs the status line[^\n]*# SKIP bun is not installed/m);
  assert.match(run.stdout, /^ok \d+ - bun runs the token line[^\n]*# SKIP bun is not installed/m);
});
