'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, parseArgs, parseSize, contextWindow } = require('../tokenline.js');

const NOW = new Date(2026, 9, 7, 12, 5);

const usage = (out, write, read, input = 2, thinking) => ({
  output_tokens: out,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  input_tokens: input,
  ...(thinking ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
});

const assistant = (id, u, extra = {}) => ({ type: 'assistant', message: { id, usage: u }, ...extra });
const prompt = (text) => ({ type: 'user', message: { content: text } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result' }] } });

test('counts each API response once and only since the last prompt', () => {
  const records = [
    prompt('earlier question'),
    assistant('m0', usage(999, 999, 999)),
    prompt('this question'),
    // One response written as two records (a thinking block and a tool call).
    assistant('m1', usage(1000, 4000, 100000, 2, 400)),
    assistant('m1', usage(1000, 4000, 100000, 2, 400)),
    toolResult(),
    assistant('m2', usage(500, 1000, 104000)),
  ];
  assert.equal(
    summarize(records, { now: NOW }),
    '12:05 │ 2 req │ out 1.5k (400 think) │ cache w5.0k r204k │ ctx 53% ▓▓▓░░ 105k',
  );
});

test('a subagent request counts toward the run but not toward the context', () => {
  const records = [
    prompt('go'),
    assistant('m1', usage(100, 0, 50000)),
    assistant('s1', usage(100, 0, 900000), { isSidechain: true }),
  ];
  assert.match(summarize(records, { now: NOW }), /│ 2 req │.*│ ctx 25% ▓░░░░ 50\.0k$/);
});

// Summarizes with the given switches.
const withArgs = (records, args) => {
  const { latest, ...opts } = parseArgs(args);
  return summarize(records, { now: NOW, ...opts });
};

test('--segments 10 draws a 10-cell context bar', () => {
  const records = [prompt('go'), assistant('m1', usage(100, 6000, 100000))];
  assert.match(withArgs(records, ['--segments', '10']), /ctx 53% ▓▓▓▓▓░░░░░ 106k$/);
  assert.match(withArgs(records, ['--segments=7']), /ctx 53% ▓▓▓░░ 106k$/);
});

test('--show picks the parts and their order, ignoring unknown ones', () => {
  const records = [prompt('go'), assistant('m1', usage(100, 6000, 100000))];
  assert.equal(withArgs(records, ['--show', 'req,ctx']), '1 req │ ctx 53% ▓▓▓░░ 106k');
  assert.equal(withArgs(records, ['--show=ctx,time']), 'ctx 53% ▓▓▓░░ 106k │ 12:05');
  assert.equal(withArgs(records, ['--show', 'req,weather']), '1 req');
});

test('--window sets the context window, and --latest is a flag', () => {
  const records = [prompt('go'), assistant('m1', usage(100, 6000, 100000))];
  assert.match(withArgs(records, ['--window', '1m', '--show', 'ctx']), /^ctx 11% ▓░░░░ 106k$/);
  assert.deepEqual(parseArgs(['--latest', '--window=1m']), { latest: true, window: '1m' });
});

test('returns null before the run makes a request', () => {
  assert.equal(summarize([prompt('hi')], { now: NOW }), null);
});

test('reads window sizes like 200k, 1m and 1000000', () => {
  assert.equal(parseSize('200k'), 200000);
  assert.equal(parseSize('1m'), 1000000);
  assert.equal(parseSize('1000000'), 1000000);
  assert.ok(Number.isNaN(parseSize('lots')));
});

test('assumes 200k, then 1M once the context passes it, unless told', () => {
  assert.equal(contextWindow(150000), 200000);
  assert.equal(contextWindow(250000), 1000000);
  assert.equal(contextWindow(150000, '1m'), 1000000);
});

test('--instruct prints the reply instruction in hosts without hook messages, and nothing elsewhere', () => {
  const { instruction, INSTRUCT_HOSTS } = require('../tokenline.js');
  const script = '~/.claude/claude-gauge/tokenline.js';
  const text = instruction(['--instruct', '--window=1m'], { host: 'claude-vscode', script });
  assert.match(text, /^## Token line in replies\n/);
  assert.match(text, /\n```sh\nnode ~\/\.claude\/claude-gauge\/tokenline\.js --latest --window=1m\n```\n/);
  assert.match(text, /Never guess the figures/);
  const spaced = instruction(['--instruct', '--show', 'req, ctx', '--window', '1m'], { host: 'claude-vscode', script });
  assert.match(spaced, /\nnode ~\/\.claude\/claude-gauge\/tokenline\.js --latest --show 'req, ctx' --window 1m\n/);
  assert.deepEqual(INSTRUCT_HOSTS, ['claude-vscode', 'claude-desktop', 'claude-desktop-3p']);
  for (const host of INSTRUCT_HOSTS) assert.ok(instruction(['--instruct'], { host, script }), host);
  for (const host of ['cli', 'sdk-ts', 'local-agent', 'jetbrains', '', undefined]) {
    assert.equal(instruction(['--instruct'], { host, script }), null, String(host));
  }
});

test('--instruct as a command reads the host from CLAUDE_CODE_ENTRYPOINT', () => {
  const { execFileSync } = require('node:child_process');
  const script = require('node:path').join(__dirname, '..', 'tokenline.js');
  const run = (host) =>
    execFileSync(process.execPath, [script, '--instruct'], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: host },
      input: '{"source":"startup"}',
      encoding: 'utf8',
    });
  assert.equal(run('cli'), '');
  assert.match(run('claude-vscode'), /^## Token line in replies\n[\s\S]*tokenline\.js --latest\n/);
});
