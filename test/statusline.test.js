'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render, parseArgs } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// The model part names the API provider from the environment, so the suite
// runs without the caller's provider variables.
for (const name of Object.keys(process.env)) {
  if (/^CLAUDE_CODE_USE_|^ANTHROPIC_BASE_URL$/.test(name)) delete process.env[name];
}

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

test('rows handed in from JavaScript render unknown part names as nothing', () => {
  const rows = [['weather', 'model', 'constructor', 'toString', '__proto__'], ['hasOwnProperty']];
  assert.equal(plain(render(bothWindows(), { nowMs: NOW, branchOf: () => 'main', config: { rows } })), 'Opus');
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

test('model names the provider when requests do not go to the first-party API', () => {
  const data = { model: { display_name: 'Opus 5.5' } };
  const model = (env) => plain(render(data, { config: parseArgs(['--show', 'model']), env }));
  assert.equal(model({}), 'Opus 5.5');
  assert.equal(model({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'Opus 5.5 (Bedrock)');
  assert.equal(model({ CLAUDE_CODE_USE_MANTLE: 'true' }), 'Opus 5.5 (Bedrock)');
  assert.equal(model({ CLAUDE_CODE_USE_VERTEX: '1' }), 'Opus 5.5 (Vertex)');
  assert.equal(model({ CLAUDE_CODE_USE_FOUNDRY: '1' }), 'Opus 5.5 (Foundry)');
  assert.equal(model({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }), 'Opus 5.5 (AWS)');
  assert.equal(model({ ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic' }), 'Opus 5.5 (Enterprise)');
  // The first-party API under its own name, and switches set off, are no
  // provider at all.
  assert.equal(model({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), 'Opus 5.5');
  assert.equal(model({ CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '' }), 'Opus 5.5');
  // Without a model there is nothing to label.
  assert.equal(plain(render({}, { config: parseArgs(['--show', 'model']), env: { CLAUDE_CODE_USE_BEDROCK: '1' } })), '');
});

// Renders the given parts with a setup in place of the files on disk.
const withSetup = (setup, show, args = []) =>
  plain(render({ workspace: { current_dir: '/home/me/project' } }, { config: parseArgs(['--show', show, ...args]), setupOf: () => setup }));

const NOTHING_LOADED = { claudeMd: 0, rules: 0, mcp: 0, hooks: 0 };

test('env counts the CLAUDE.md files, rules, MCP servers and hooks loaded', () => {
  const setup = { claudeMd: 2, rules: 4, mcp: 3, hooks: 2 };
  assert.equal(withSetup(setup, 'env'), 'env 2 md 4 rules 3 mcp 2 hooks');
  assert.equal(withSetup(setup, 'env', ['--no-labels']), '2 md 4 rules 3 mcp 2 hooks');
  // One of a kind reads as one; nothing of a kind stays out.
  assert.equal(withSetup({ claudeMd: 1, rules: 1, mcp: 0, hooks: 1 }, 'env'), 'env 1 md 1 rule 1 hook');
  assert.equal(withSetup(NOTHING_LOADED, 'env'), '');
});

test('env reads the setup of the folder Claude Code runs in', () => {
  let seen;
  render({ workspace: { current_dir: '/home/me/project' } }, {
    config: parseArgs(['--show', 'env,plan']),
    setupOf: (cwd) => ((seen = cwd), NOTHING_LOADED),
  });
  assert.equal(seen, '/home/me/project');
});

test('plan shows the subscription and the signed-in user', () => {
  const plan = (fields) => withSetup({ ...NOTHING_LOADED, ...fields }, 'plan');
  assert.equal(plan({ plan: 'Claude Max 20x', user: 'me@example.com' }), 'Claude Max 20x (me@example.com)');
  assert.equal(plan({ plan: 'Claude Pro' }), 'Claude Pro');
  assert.equal(plan({ user: 'me@example.com' }), 'me@example.com');
  assert.equal(plan({}), '');
});

// A home folder, a managed settings folder and a project two levels under
// the home, in a temporary folder, with the given files written into it.
// files may be a function of the temporary folder's path.
function setupTree(files) {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'claude-gauge-setup-')));
  for (const [name, content] of Object.entries(typeof files === 'function' ? files(root) : files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const dir = (name) => (fs.mkdirSync(path.join(root, name), { recursive: true }), path.join(root, name));
  return { root, home: dir('home'), managedDir: dir('managed'), project: dir('home/work/project') };
}

const hooks = (...groups) => Object.fromEntries(groups.map(([event, n]) => [event, [{ hooks: Array.from({ length: n }, () => ({ type: 'command', command: 'true' })) }]]));

test('the setup counts what Claude Code loads, from the files on disk', () => {
  const { readSetup } = require('../dist/statusline.js');
  const project = 'home/work/project';
  const tree = setupTree((root) => ({
    // CLAUDE.md: managed, user, an ancestor of the project, and the project's
    // three. One in a subfolder loads only on demand, so it does not count.
    'managed/CLAUDE.md': '',
    'home/.claude/CLAUDE.md': '',
    'home/work/CLAUDE.md': '',
    [`${project}/CLAUDE.md`]: '',
    [`${project}/.claude/CLAUDE.md`]: '',
    [`${project}/CLAUDE.local.md`]: '',
    [`${project}/src/CLAUDE.md`]: '',
    // Rules: every .md under the user's rules and the rules of the project
    // and the folders above it, at any depth.
    'home/.claude/rules/style.md': '',
    'home/work/.claude/rules/shared.md': '',
    'home/.claude/rules/lang/ts.md': '',
    'home/.claude/rules/notes.txt': '',
    [`${project}/.claude/rules/testing.md`]: '',
    // MCP servers: user and local scope, the project's .mcp.json, and the
    // managed file, each named once, less a project server turned off.
    'home/.claude.json': {
      mcpServers: { github: {}, linear: {} },
      projects: { [require('node:path').join(root, project)]: { mcpServers: { neon: {} } } },
      oauthAccount: { emailAddress: 'me@example.com' },
    },
    [`${project}/.mcp.json`]: { mcpServers: { github: {}, sentry: {}, figma: {} } },
    'managed/managed-mcp.json': { mcpServers: { intranet: {} } },
    // Hooks: one per handler, across user, project, local and managed settings.
    'home/.claude/settings.json': { hooks: hooks(['Stop', 2], ['SessionStart', 1]) },
    [`${project}/.claude/settings.json`]: { hooks: hooks(['PreToolUse', 1]) },
    [`${project}/.claude/settings.local.json`]: { disabledMcpjsonServers: ['figma'] },
    'managed/managed-settings.json': { hooks: hooks(['Stop', 1]) },
    // The plan, from the subscription fields beside the login.
    'home/.claude/.credentials.json': { claudeAiOauth: { accessToken: 'secret', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } },
  }));
  const setup = readSetup(tree.project, { env: {}, home: tree.home, managedDir: tree.managedDir });
  assert.deepEqual(setup, { claudeMd: 6, rules: 4, mcp: 5, hooks: 5, plan: 'Claude Max 20x', user: 'me@example.com' });
  assert.doesNotMatch(JSON.stringify(setup), /secret/);
});

test('the setup follows CLAUDE_CONFIG_DIR, and names each plan', () => {
  const { readSetup } = require('../dist/statusline.js');
  const plan = (claudeAiOauth) => {
    const tree = setupTree({ 'config/.credentials.json': { claudeAiOauth }, 'config/.claude.json': { oauthAccount: { emailAddress: 'work@example.com' } } });
    const env = { CLAUDE_CONFIG_DIR: require('node:path').join(tree.root, 'config') };
    const { plan, user } = readSetup(tree.project, { env, home: tree.home, managedDir: tree.managedDir });
    return [plan, user];
  };
  assert.deepEqual(plan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }), ['Claude Max 5x', 'work@example.com']);
  assert.deepEqual(plan({ subscriptionType: 'pro' }), ['Claude Pro', 'work@example.com']);
  assert.deepEqual(plan({ subscriptionType: 'team', rateLimitTier: 'default_claude_team' }), ['Claude Team', 'work@example.com']);
  assert.deepEqual(plan({}), [undefined, 'work@example.com']);
});

test('the setup is empty where there is nothing to read, and skips files that are not JSON', () => {
  const { readSetup } = require('../dist/statusline.js');
  const empty = setupTree({});
  assert.deepEqual(readSetup(empty.project, { env: {}, home: empty.home, managedDir: empty.managedDir }), { claudeMd: 0, rules: 0, mcp: 0, hooks: 0 });
  const broken = setupTree({
    'home/.claude.json': '{ not json',
    'home/.claude/settings.json': '[1, 2',
    'home/.claude/.credentials.json': 'null',
    'home/work/project/.mcp.json': { mcpServers: ['not', 'an', 'object'] },
    'home/work/project/.claude/settings.json': { hooks: { Stop: 'not a list' } },
  });
  assert.deepEqual(readSetup(broken.project, { env: {}, home: broken.home, managedDir: broken.managedDir }), { claudeMd: 0, rules: 0, mcp: 0, hooks: 0 });
});

test('version shows the Claude Code version', () => {
  assert.equal(run({ version: '2.1.90' }, ['--show', 'version']), 'v2.1.90');
});

// Text that tries to take over the terminal: clear the screen, move the
// cursor, set the window title, open a hyperlink, ring the bell, back over
// what came before, and reverse the text, in 7-bit and 8-bit forms.
const HOSTILE = [
  '\x1b[2J\x1b[H', // CSI: erase the screen, cursor home
  '\x1b[1;31m\x1b[38;2;255;0;0m', // CSI: colours
  '\x1b]0;pwned\x07', // OSC: window title, BEL-terminated
  '\x1b]8;;https://evil.example\x1b\\', // OSC 8: hyperlink, ST-terminated
  '\x1b]52;c;cHduZWQ=\x07', // OSC 52: write the clipboard
  '\x1bP1$r\x1b\\', // DCS string
  '\x1b_payload\x1b\\', // APC string
  '\x1b(0', // character set switch
  '\x9b31m', // 8-bit CSI
  '\x9d0;pwned\x9c', // 8-bit OSC and ST
  '\x07\b\r\n\t\x7f\x85', // C0, DEL and C1 characters
  '\u202e\u2066\u200f', // bidi override, isolate and mark
].join('');

// Every terminal control character that may reach the terminal: C0, DEL, C1
// and the bidi formatting characters.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

// claude-gauge's own colour codes: reset, the 16 colours it names, and the
// 256-colour levels. HOSTILE's colours are none of these.
const OWN_COLOURS = /\x1b\[(?:0|0;3\d|0;90|38;5;\d{1,3})m/g;

// Renders the parts with the given payload, branch and setup, and checks
// that the only control codes left are claude-gauge's own colours.
const renderClean = (data, show, branch = 'main', setup = NOTHING_LOADED) => {
  const raw = render(data, { nowMs: NOW, branchOf: () => branch, setupOf: () => setup, config: parseArgs(['--show', show]) });
  assert.doesNotMatch(raw.replace(OWN_COLOURS, ''), CONTROL, JSON.stringify(raw));
  return plain(raw);
};

test('a hostile session name prints without its control codes', () => {
  assert.equal(renderClean({ session_name: `fix ${HOSTILE}the bug` }, 'name'), 'fix the bug');
  // Cut to 30 characters after the codes are gone, not before.
  assert.equal(renderClean({ session_name: `${HOSTILE}a session title of exactly thirty` }, 'name'), 'a session title of exactly th…');
  // An OSC with no terminator runs to the end, as a terminal reads it.
  assert.equal(renderClean({ session_name: 'title\x1b]0;pwned' }, 'name'), 'title');
});

test('a hostile branch from git, and a hostile worktree name, print without their control codes', () => {
  const data = { workspace: { current_dir: '/home/me/project', git_worktree: `my-${HOSTILE}feature` } };
  assert.equal(renderClean(data, 'branch,worktree', `feat/${HOSTILE}x`), '⎇ feat/x (wt my-feature) │ wt my-feature');
});

test('a hostile repo, from the remote or the folder name, prints without its control codes', () => {
  const repo = { host: 'github.com', owner: `jv-${HOSTILE}k`, name: `claude-${HOSTILE}gauge` };
  assert.equal(renderClean({ workspace: { current_dir: '/home/me/project', repo } }, 'repo'), 'jv-k/claude-gauge');
  // A folder name cannot hold a slash, so the hyperlink's URL loses its own.
  const folder = { workspace: { current_dir: `/home/me/pro${HOSTILE.replaceAll('/', '')}ject` } };
  assert.equal(renderClean(folder, 'repo,dir'), 'project │ project');
});

test('a hostile pull request prints without its control codes', () => {
  assert.equal(renderClean({ pr: { number: 12, review_state: `appr${HOSTILE}oved` } }, 'pr'), '#12 approved');
  // The payload is JSON from outside, so a field meant to be a number may
  // arrive as text.
  assert.equal(renderClean({ pr: { number: `12${HOSTILE}34` } }, 'pr'), '#1234');
});

test('a hostile plan or user from the config prints without its control codes', () => {
  const setup = { ...NOTHING_LOADED, plan: `Claude ${HOSTILE}Max 20x`, user: `me@${HOSTILE}example.com` };
  assert.equal(renderClean({ workspace: { current_dir: '/home/me/project' } }, 'plan', 'main', setup), 'Claude Max 20x (me@example.com)');
});

test('every part prints hostile payload text without its control codes', () => {
  const { PARTS } = require('../dist/statusline.js');
  const h = (text) => `${text.slice(0, 1)}${HOSTILE}${text.slice(1)}`;
  const data = {
    version: h('2.1.90'),
    session_name: h('session'),
    model: { display_name: h('Opus') },
    workspace: { current_dir: '/home/me/project', repo: { host: 'github.com', owner: h('jv-k'), name: h('claude-gauge') }, git_worktree: h('wt') },
    context_window: { context_window_size: 200000, used_percentage: 43, total_input_tokens: h('86000') },
    cost: { total_duration_ms: 60_000, total_cost_usd: 1, total_lines_added: h('15'), total_lines_removed: h('23') },
    effort: { level: h('high') },
    thinking: { enabled: true },
    fast_mode: true,
    output_style: { name: h('explanatory') },
    pr: { number: h('12'), kind: 'pr', review_state: h('pending') },
    agent: { name: h('reviewer') },
    prompt_cache: { warm: true, hit_ratio: 0.5 },
    rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 }, spend_limit: { used_percentage: 30 } },
  };
  const setup = { claudeMd: 1, rules: 0, mcp: 0, hooks: 0, plan: h('Claude Max 20x'), user: h('me@example.com') };
  for (const part of PARTS) assert.ok(renderClean(data, part, h('main'), setup), part);
  assert.equal(
    renderClean(data, 'model,effort,style,agent,version,lines,ctx'),
    'Opus │ effort high │ style explanatory │ agent reviewer │ v2.1.90 │ +15 −23 │ ctx 43% ▓▓░░░ 86.0k',
  );
});

test('hostile text from the transcript prints without its control codes', () => {
  const { payloadFromTranscript } = require('../dist/statusline.js');
  const records = [
    { type: 'assistant', effort: `hi${HOSTILE}gh`, message: { model: `claude-op${HOSTILE}us-5-5`, usage: { input_tokens: 1000 } } },
  ];
  assert.equal(renderClean(payloadFromTranscript(records, { nowMs: NOW }), 'model,effort'), 'Opus 5.5 │ effort high');
});

test('the folder git runs in keeps its name as it is', () => {
  const dir = `/home/me/pro\x1b[2Jject`;
  let seen;
  render({ workspace: { current_dir: dir } }, { config: parseArgs(['--show', 'branch']), branchOf: (cwd) => ((seen = cwd), 'main') });
  assert.equal(seen, dir);
});

test("external colour codes go and claude-gauge's own colours stay", () => {
  const raw = render({ session_name: 'red\x1b[31m\x1b[1;41mtext\x1b[0m' }, { config: parseArgs(['--show', 'name']) });
  assert.equal(raw, '\x1b[0;90mredtext\x1b[0m');
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
  const { payloadFromTranscript, modelName } = require('../dist/statusline.js');
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

test('--latest reads the repo and worktree from git, as the terminal payload has them', () => {
  const { repoFromRemote, worktreeFromGitDir } = require('../dist/statusline.js');
  const repo = { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' };
  assert.deepEqual(repoFromRemote('git@github.com:jv-k/claude-gauge.git'), repo);
  assert.deepEqual(repoFromRemote('https://github.com/jv-k/claude-gauge.git'), repo);
  assert.deepEqual(repoFromRemote('https://github.com/jv-k/claude-gauge'), repo);
  assert.deepEqual(repoFromRemote('ssh://git@github.com:22/jv-k/claude-gauge.git'), repo);
  assert.deepEqual(repoFromRemote('https://gitlab.com/group/sub/app.git'), { host: 'gitlab.com', owner: 'group/sub', name: 'app' });
  assert.equal(repoFromRemote('/srv/git/app.git'), undefined);
  assert.equal(repoFromRemote(''), undefined);
  assert.equal(worktreeFromGitDir('/home/me/project/.git/worktrees/my-feature'), 'my-feature');
  assert.equal(worktreeFromGitDir('/home/me/project/.git'), undefined);
  assert.equal(worktreeFromGitDir(''), undefined);
});

test('--instruct prints the reply instruction in hosts without a status line, and nothing elsewhere', () => {
  const { instruction, INSTRUCT_HOSTS } = require('../dist/statusline.js');
  const script = '~/.claude/claude-gauge/statusline.js';
  const args = ['--instruct', '--window', '1m', '--show', 'ctx,5h'];
  const text = instruction(args, { host: 'claude-vscode', script });
  assert.match(text, /^## Status line in replies\n/);
  assert.match(text, /\n```sh\nnode ~\/\.claude\/claude-gauge\/statusline\.js --latest --window 1m --show ctx,5h\n```\n/);
  assert.match(text, /last tool call .* verbatim .* one plain code block/);
  assert.match(text, /Never guess the figures/);
  assert.doesNotMatch(text, /--instruct/);
  const spaced = instruction(['--instruct', '--show', '7d, 5h', '--segments=10', "it's"], { host: 'claude-vscode', script });
  assert.match(spaced, /\nnode ~\/\.claude\/claude-gauge\/statusline\.js --latest --show '7d, 5h' --segments=10 'it'\\''s'\n/);
  assert.deepEqual(INSTRUCT_HOSTS, ['claude-vscode', 'claude-desktop', 'claude-desktop-3p']);
  for (const host of INSTRUCT_HOSTS) assert.ok(instruction(['--instruct'], { host, script }), host);
  for (const host of ['cli', 'sdk-ts', 'sdk-cli', 'local-agent', 'remote', 'jetbrains', '', undefined]) {
    assert.equal(instruction(['--instruct'], { host, script }), null, String(host));
  }
});

test('--instruct as a command reads the host from CLAUDE_CODE_ENTRYPOINT', () => {
  const { execFileSync } = require('node:child_process');
  const script = require('node:path').join(__dirname, '..', 'dist', 'statusline.js');
  const run = (host) =>
    execFileSync(process.execPath, [script, '--instruct', '--window', '1m'], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: host },
      input: '{"source":"startup"}',
      encoding: 'utf8',
    });
  assert.equal(run('cli'), '');
  const text = run('claude-desktop');
  assert.match(text, /^## Status line in replies\n/);
  assert.match(text, /statusline\.js --latest --window 1m\n/);
});

// Renders with the given switches and terminal width, colours stripped.
const runAt = (columns, data, args) =>
  plain(render(data, { nowMs: NOW, branchOf: () => 'main', config: parseArgs(args), columns }));

test('--right pads its parts to the end of the row, to the terminal width', () => {
  const data = { model: { display_name: 'Opus' } };
  assert.equal(runAt(20, data, ['--show', 'time,model', '--right', 'model']), '12:00           Opus');
  // A row of right-aligned parts only is padded at its start.
  assert.equal(runAt(10, data, ['--show', 'model', '--right', 'model']), '      Opus');
  // The colour codes take no room: the visible row is the terminal's width.
  const raw = render(data, { nowMs: NOW, config: parseArgs(['--show', 'time,model', '--right', 'model']), columns: 20 });
  assert.ok(raw.length > 20);
  assert.equal(plain(raw).length, 20);
});

test('--right moves its parts to the end in row order, and keeps their separators', () => {
  const data = { model: { display_name: 'Opus' }, effort: { level: 'high' }, version: '2.1.90' };
  const args = ['--show', 'model,time,effort,version', '--right', 'version,model'];
  assert.equal(runAt(40, data, args), '12:00 │ effort high       Opus │ v2.1.90');
  assert.equal(runAt(30, data, [...args, '--compact']), '12:00│eff high    Opus│v2.1.90');
  // Repeating --right adds to the parts it names; unknown names are ignored.
  assert.equal(runAt(40, data, [...args.slice(0, 2), '--right', 'model,weather', '--right', 'version']), runAt(40, data, args));
});

test('--right leaves rows unchanged when the terminal width is unknown', () => {
  const data = { model: { display_name: 'Opus' } };
  const args = ['--show', 'time,model', '--right', 'model'];
  for (const columns of [undefined, 0, -5, NaN, 2.5]) assert.equal(runAt(columns, data, args), '12:00 │ Opus', String(columns));
});

test('--right leaves a row unchanged when it does not fit, or has no right-aligned part to show', () => {
  const data = { model: { display_name: 'Opus' } };
  // Padding narrower than the separator would run the parts together.
  assert.equal(runAt(11, data, ['--show', 'time,model', '--right', 'model']), '12:00 │ Opus');
  assert.equal(runAt(12, data, ['--show', 'time,model', '--right', 'model']), '12:00   Opus');
  assert.equal(runAt(3, data, ['--show', 'model', '--right', 'model']), 'Opus');
  // pr has nothing to show, so the row has nothing to align.
  assert.equal(runAt(20, data, ['--show', 'time,model,pr', '--right', 'pr']), '12:00 │ Opus');
  // Only the rows holding a right-aligned part are padded.
  assert.equal(runAt(10, data, ['--show', 'time', '--show', 'model', '--right', 'model']), '12:00\n      Opus');
});

test('the status line program takes the terminal width from COLUMNS', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const script = path.join(__dirname, '..', 'dist', 'statusline.js');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-')) };
  delete env.COLUMNS;
  const statusLine = (columns) =>
    plain(
      execFileSync(process.execPath, [script, '--show', 'dir,model', '--right', 'model'], {
        env: columns === undefined ? env : { ...env, COLUMNS: columns },
        input: JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: '/home/me/project' } }),
        encoding: 'utf8',
      }),
    );
  assert.equal(statusLine('20'), 'project         Opus\n');
  for (const columns of [undefined, '', 'wide', '0']) assert.equal(statusLine(columns), 'project │ Opus\n', String(columns));
});

test('--right leaves a row unchanged when it holds text of uncertain width', () => {
  const args = ['--show', 'name,model', '--right', 'model'];
  const named = (session_name) => ({ session_name, model: { display_name: 'Opus' } });
  // Accented and Cyrillic letters take one column each.
  assert.equal(runAt(30, named('café réunion'), args), 'café réunion              Opus');
  assert.equal(runAt(30, named('встреча'), args), 'встреча                   Opus');
  // CJK and emoji take two columns in most terminals, and combining marks
  // none, so the row stays as it is rather than overshoot the edge.
  for (const name of ['東京の会議', '🚀 launch', 'cafe\u0301']) {
    assert.equal(runAt(30, named(name), args), `${name} │ Opus`, name);
  }
});

test("the README's compact and --right example rows are what the status line prints", () => {
  const readme = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8');
  const data = {
    model: { display_name: 'Opus 5.5' },
    effort: { level: 'high' },
    workspace: { current_dir: '/home/me/claude-gauge', repo: { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' } },
  };
  const show = ['--show', 'repo,branch,model,effort'];
  const compact = run(data, [...show, '--compact']);
  assert.equal(compact, 'jv-k/claude-gauge│⎇ main│Opus 5.5│eff high');
  const right = runAt(72, data, [...show, '--right', 'model,effort']);
  assert.equal(right, 'jv-k/claude-gauge │ ⎇ main                        Opus 5.5 │ effort high');
  assert.ok(readme.includes(`\n${compact}\n`), compact);
  assert.ok(readme.includes(`a 72-column terminal`));
  assert.ok(readme.includes(`\n${right}\n`), right);
});
