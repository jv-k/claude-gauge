'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render, parseArgs } = require('../statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A fixed local noon, so every reset below is relative to a known "now".
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const at = (ms) => Math.floor(ms / 1000);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const payload = (rateLimits) => ({
  model: { display_name: 'Opus' },
  workspace: { current_dir: '/home/me/project' },
  context_window: { context_window_size: 200000, used_percentage: 43 },
  rate_limits: rateLimits,
});

const bothWindows = () =>
  payload({
    five_hour: { used_percentage: 9.4, resets_at: at(NOW + 2 * HOUR) },
    seven_day: { used_percentage: 41.2, resets_at: at(NOW + 3 * DAY) },
  });

// Renders with the given switches, colours stripped.
const run = (data, args = []) =>
  plain(render(data, { nowMs: NOW, branchOf: () => 'main', config: parseArgs(args) }));

test('shows two rows by default: the headroom figures, then the session', () => {
  const data = bothWindows();
  data.cost = { total_duration_ms: 72 * 60_000 };
  data.workspace.repo = { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' };
  data.effort = { level: 'high' };
  assert.equal(
    run(data),
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ → 14:00 │ 7d 41% ▓▓░┃░ → 3d\n12:00 │ 1h12m │ jv-k/claude-gauge │ ⎇ main │ Opus │ effort high',
  );
});

test('the default second row keeps what it can when parts are missing', () => {
  assert.equal(
    run(bothWindows()),
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ → 14:00 │ 7d 41% ▓▓░┃░ → 3d\n12:00 │ project │ ⎇ main │ Opus',
  );
});

test('--show picks the parts and their order', () => {
  assert.equal(run(bothWindows(), ['--show', '5h,7d']), '5h 9% ░░░┃░ → 14:00 │ 7d 41% ▓▓░┃░ → 3d');
  assert.equal(
    run(bothWindows(), ['--show=ctx,5h,7d']),
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ → 14:00 │ 7d 41% ▓▓░┃░ → 3d',
  );
  assert.equal(run(bothWindows(), ['--show', '7d, 5h']), '7d 41% ▓▓░┃░ → 3d │ 5h 9% ░░░┃░ → 14:00');
});

test('--show ignores unknown parts, and falls back to the default when none is known', () => {
  assert.equal(run(bothWindows(), ['--show', '5h,weather']), '5h 9% ░░░┃░ → 14:00');
  assert.equal(run(bothWindows(), ['--show', 'weather']), run(bothWindows()));
});

test('each --show is one row, in order', () => {
  assert.equal(
    run(bothWindows(), ['--show', 'ctx,5h,7d', '--show', 'dir,branch,model']),
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░░┃░ → 14:00 │ 7d 41% ▓▓░┃░ → 3d\nproject │ ⎇ main │ Opus',
  );
});

test('a --show with no known part adds no row', () => {
  assert.equal(run(bothWindows(), ['--show', 'weather', '--show', 'model']), 'Opus');
});

test('a row with nothing to show drops out', () => {
  const noBranch = plain(
    render(bothWindows(), { nowMs: NOW, branchOf: () => '', config: parseArgs(['--show', 'branch', '--show', 'model']) }),
  );
  assert.equal(noBranch, 'Opus');
});

test('--segments 10 draws 10-cell bars, and any other value gives 5', () => {
  assert.equal(
    run(bothWindows(), ['--show', 'ctx,5h,7d', '--segments', '10']),
    'ctx 43% ▓▓▓▓░░░░░░ 86.0k │ 5h 9% ▓░░░░░┃░░░ → 14:00 │ 7d 41% ▓▓▓▓░░┃░░░ → 3d',
  );
  assert.equal(run(bothWindows(), ['--segments=7']), run(bothWindows()));
});

test('shows "~" for a window Claude Code has not reported yet', () => {
  assert.equal(run(payload(undefined), ['--show', 'ctx,5h,7d']), 'ctx 43% ▓▓░░░ 86.0k │ 5h ~ │ 7d ~');
  assert.equal(run(payload(undefined), ['--show', '5h,7d', '--no-labels']), '~ │ ~');
});

test('the weekly reset shows the time when it falls today, and days otherwise', () => {
  const week = (resetsAt) => ({
    five_hour: { used_percentage: 1, resets_at: at(NOW + HOUR) },
    seven_day: { used_percentage: 50, resets_at: resetsAt },
  });
  const today = at(new Date(2026, 9, 7, 23, 30).getTime());
  const tomorrow = at(new Date(2026, 9, 8, 9, 0).getTime());
  // Late in the week the marker sits in the last cell.
  assert.equal(run(payload(week(today)), ['--show', '7d']), '7d 50% ▓▓▓░┃ → 23:30');
  assert.equal(run(payload(week(tomorrow)), ['--show', '7d']), '7d 50% ▓▓▓░┃ → 1d');
});

test('the pace marker sits where "now" falls in the 5-hour window', () => {
  // 3 of 5 hours gone: the marker replaces the fourth of 5 cells, or the
  // seventh of 10.
  const data = payload({ five_hour: { used_percentage: 62, resets_at: at(NOW + 2 * HOUR) } });
  assert.equal(run(data, ['--show', '5h']), '5h 62% ▓▓▓┃░ → 14:00');
  assert.equal(run(data, ['--show', '5h', '--segments', '10']), '5h 62% ▓▓▓▓▓▓┃░░░ → 14:00');
});

test('switches drop labels, bars, pace markers and reset times', () => {
  const data = bothWindows();
  assert.equal(run(data, ['--show', '5h', '--no-pace']), '5h 9% ░░░░░ → 14:00');
  assert.equal(run(data, ['--show', '5h', '--no-reset']), '5h 9% ░░░┃░');
  assert.equal(run(data, ['--show', '5h', '--12h']), '5h 9% ░░░┃░ → 02:00 pm');
  assert.equal(run(data, ['--show', 'ctx,5h,7d', '--no-labels', '--no-bars']), '43% 86.0k │ 9% → 14:00 │ 41% → 3d');
});

test('time shows the current local time, on the 24-hour clock unless --12h', () => {
  assert.equal(run({}, ['--show', 'time']), '12:00');
  assert.equal(run({}, ['--show', 'time', '--12h']), '12:00 pm');
});

test('duration counts seconds, minutes, hours and days, leaving off a zero lower unit', () => {
  const at = (ms) => run({ cost: { total_duration_ms: ms } }, ['--show', 'duration']);
  assert.equal(at(45_000), '45s');
  assert.equal(at(12 * 60_000), '12m');
  assert.equal(at(72 * 60_000), '1h12m');
  assert.equal(at(60 * 60_000), '1h');
  assert.equal(at(51 * 3600_000), '2d3h');
  assert.equal(run({}, ['--show', 'duration', '--show', 'model']), '');
});

test('cost shows dollars, coloured by a spend limit when there is one', () => {
  const data = { cost: { total_cost_usd: 1.234 } };
  assert.equal(run(data, ['--show', 'cost']), '$1.23');
  const grey = render(data, { config: parseArgs(['--show', 'cost']) });
  assert.ok(grey.startsWith('\x1b[0;90m'));
  data.rate_limits = { spend_limit: { used_percentage: 95 } };
  const red = render(data, { config: parseArgs(['--show', 'cost']) });
  assert.ok(red.startsWith('\x1b[38;5;124m'));
});

test('lines shows code added and removed this session', () => {
  const data = { cost: { total_lines_added: 156, total_lines_removed: 23 } };
  assert.equal(run(data, ['--show', 'lines']), '+156 −23');
});

test('name shows the session name, cut to 30 characters', () => {
  assert.equal(run({ session_name: 'fix the login bug' }, ['--show', 'name']), 'fix the login bug');
  assert.equal(
    run({ session_name: 'a very long session title that goes on and on' }, ['--show', 'name']),
    'a very long session title tha…',
  );
  assert.equal(run({}, ['--show', 'name', '--show', 'model']), '');
});

test('model state parts show effort, thinking, fast mode and a non-default style', () => {
  const data = { effort: { level: 'high' }, thinking: { enabled: true }, fast_mode: true, output_style: { name: 'explanatory' } };
  const show = ['--show', 'effort,thinking,fast,style'];
  assert.equal(run(data, show), 'effort high │ think │ fast │ style explanatory');
  assert.equal(run(data, [...show, '--no-labels']), 'high │ think │ fast │ explanatory');
  const off = { thinking: { enabled: false }, fast_mode: false, output_style: { name: 'default' } };
  assert.equal(run(off, [...show, '--show', 'model']), '');
});

test('repo shows owner/name, or the folder name without an origin remote', () => {
  const data = payload(undefined);
  data.workspace.repo = { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' };
  assert.equal(run(data, ['--show', 'repo']), 'jv-k/claude-gauge');
  assert.equal(run(payload(undefined), ['--show', 'repo']), 'project');
});

test('branch names the linked worktree, and worktree shows it on its own', () => {
  const data = payload(undefined);
  data.workspace.git_worktree = 'my-feature';
  assert.equal(run(data, ['--show', 'branch,worktree']), '⎇ main (wt my-feature) │ wt my-feature');
  assert.equal(run(data, ['--show', 'branch,worktree', '--no-labels']), '⎇ main (my-feature) │ my-feature');
  assert.equal(run(payload(undefined), ['--show', 'branch,worktree']), '⎇ main');
});

test('pr shows the open PR and its review state, coloured by the state', () => {
  const pr = (fields) => ({ pr: { number: 1234, url: 'https://example.com/pr/1234', ...fields } });
  assert.equal(run(pr({ review_state: 'approved' }), ['--show', 'pr']), '#1234 approved');
  assert.equal(run(pr({}), ['--show', 'pr']), '#1234');
  assert.equal(run(pr({ kind: 'mr', review_state: 'pending' }), ['--show', 'pr']), '!1234 pending');
  const red = render(pr({ review_state: 'changes_requested' }), { config: parseArgs(['--show', 'pr']) });
  assert.ok(red.startsWith('\x1b[0;31m'));
  assert.equal(run({}, ['--show', 'pr', '--show', 'model']), '');
});

test('agent shows the agent name when running with --agent', () => {
  assert.equal(run({ agent: { name: 'security-reviewer' } }, ['--show', 'agent']), 'agent security-reviewer');
  assert.equal(run({ agent: { name: 'security-reviewer' } }, ['--show', 'agent', '--no-labels']), 'security-reviewer');
  assert.equal(run({}, ['--show', 'agent', '--show', 'model']), '');
});

test('cache shows the hit ratio and warmth, green for a high hit ratio', () => {
  const data = { prompt_cache: { warm: true, hit_ratio: 0.91 } };
  assert.equal(run(data, ['--show', 'cache']), 'cache 91% warm');
  assert.equal(run(data, ['--show', 'cache', '--no-labels']), '91% warm');
  const green = render(data, { config: parseArgs(['--show', 'cache']) });
  assert.ok(green.startsWith('\x1b[38;5;22m'));
  assert.equal(run({ prompt_cache: { warm: false } }, ['--show', 'cache']), 'cache cold');
  assert.equal(run({}, ['--show', 'cache', '--show', 'model']), '');
});

test('spend shows dollars against the limit, or the percentage until dollars arrive', () => {
  const limit = (fields) => ({ rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 1, ...fields } } });
  assert.equal(run(limit({ used_usd: 314.12, limit_usd: 500 }), ['--show', 'spend']), '$314/$500');
  assert.equal(run(limit({}), ['--show', 'spend']), 'spend 63%');
  assert.equal(run({}, ['--show', 'spend', '--show', 'model']), '');
});

test('version shows the Claude Code version', () => {
  assert.equal(run({ version: '2.1.90' }, ['--show', 'version']), 'v2.1.90');
});

test('computes context from token counts when Claude Code sends no percentage', () => {
  const data = payload(undefined);
  data.context_window = {
    context_window_size: 200000,
    current_usage: { input_tokens: 1000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 40000 },
  };
  // The count uses the token line's compact format.
  assert.equal(run(data, ['--show', 'ctx']), 'ctx 25% ▓░░░░ 50.0k');
  // --ctx-tokens is gone; like any unknown switch it changes nothing.
  assert.equal(run(data, ['--show', 'ctx', '--ctx-tokens']), 'ctx 25% ▓░░░░ 50.0k');
});

test('ctx shows the token count after the bar, from whatever Claude Code sends', () => {
  const ctx = (context_window) => run({ context_window }, ['--show', 'ctx']);
  assert.equal(ctx({ used_percentage: 43, context_window_size: 1000000, total_input_tokens: 430500 }), 'ctx 43% ▓▓░░░ 431k');
  assert.equal(ctx({ used_percentage: 43, context_window_size: 200000 }), 'ctx 43% ▓▓░░░ 86.0k');
  assert.equal(ctx({ used_percentage: 43 }), 'ctx 43% ▓▓░░░');
  assert.equal(run({ context_window: { used_percentage: 43, context_window_size: 200000 } }, ['--show', 'ctx', '--no-bars']), 'ctx 43% 86.0k');
});

test('--latest rebuilds a payload from the transcript, with saved usage', () => {
  const { payloadFromTranscript, modelName } = require('../statusline.js');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  const records = [
    { type: 'user', timestamp: new Date(NOW - 2 * HOUR).toISOString(), cwd: '/home/me/project', message: { content: 'hi' } },
    { type: 'assistant', cwd: '/home/me/project', effort: 'high', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 80000 } } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900000 } } },
  ];
  const usage = { five_hour: { used_percentage: 9.4, resets_at: at(NOW + 3 * HOUR) } };
  const data = payloadFromTranscript(records, { nowMs: NOW, usage });
  assert.equal(
    run(data),
    'ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 15:00 │ 7d ~\n12:00 │ 2h │ project │ ⎇ main │ Opus 5.5 │ effort high',
  );
  assert.match(run(payloadFromTranscript(records, { nowMs: NOW, window: '1m' }), ['--show', 'ctx']), /^ctx 9% ░░░░░ 86\.0k$/);
});
