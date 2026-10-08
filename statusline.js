#!/usr/bin/env node
'use strict';

// claude-gauge status line for the Claude Code terminal CLI.
//
// Reads the JSON Claude Code sends on stdin and prints one or more rows. The
// default is two:
//
//   ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
//   14:58 │ 1h12m │ jv-k/claude-gauge │ ⎇ main │ Opus 5.5 │ effort high
//
// Everything comes from Claude Code's own payload
// (https://code.claude.com/docs/en/statusline): `rate_limits` carries the
// claude.ai 5-hour and 7-day windows. The only side call is
// `git branch --show-current`.
//
// Switches:
//   --show <parts>     one row: the parts to show, in order, comma-separated,
//                      from the PARTS list below. Repeat it for more rows.
//                      Default: the two rows of DEFAULT_ROWS.
//   --segments <5|10>  cells per bar (default 5)
//   --no-labels        drop the labels in front of values (ctx, 5h, effort...)
//   --no-bars          drop the bars
//   --no-pace          drop the pace markers
//   --no-reset         drop the reset times
//   --12h              12-hour clock for the time part and reset times
//                      (default 24-hour)

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PARTS = [
  'dir', 'branch', 'model', 'ctx', '5h', '7d',
  'time', 'duration', 'cost', 'lines', 'name',
  'effort', 'thinking', 'fast', 'style',
  'repo', 'worktree', 'pr', 'agent',
  'cache', 'spend', 'version',
];

// The rows shown when no --show names a known part: the headroom figures on
// top, the session around them below.
const DEFAULT_ROWS = [
  ['ctx', '5h', '7d'],
  ['time', 'duration', 'repo', 'branch', 'model', 'effort'],
];

const DEFAULTS = {
  rows: DEFAULT_ROWS,
  segments: 5,
  labels: true,
  bars: true,
  pace: true,
  reset: true,
  hour12: false,
};

// Turns the switches into a config. Unknown switches and part names are
// ignored, and a --show with no known part adds no row: a status line should
// show something rather than fail.
function parseArgs(argv) {
  const config = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i] ?? '';
    switch (name) {
      case '--show': {
        const parts = value().split(',').map((p) => p.trim()).filter((p) => PARTS.includes(p));
        if (parts.length) (config.rows ??= []).push(parts);
        break;
      }
      case '--segments': config.segments = value(); break;
      case '--no-labels': config.labels = false; break;
      case '--no-bars': config.bars = false; break;
      case '--no-pace': config.pace = false; break;
      case '--no-reset': config.reset = false; break;
      case '--12h': config.hour12 = true; break;
      default: break;
    }
  }
  return config;
}

const RESET = '\x1b[0m';
const BLUE = '\x1b[0;34m';
const GREEN = '\x1b[0;32m';
const GRAY = '\x1b[0;90m';
const YELLOW = '\x1b[0;33m';
const CYAN = '\x1b[0;36m';
const RED = '\x1b[0;31m';
const ansi256 = (n) => `\x1b[38;5;${n}m`;

// Ten usage levels: dark green at 0-10%, deep red above 90%.
const LEVELS = [22, 28, 34, 100, 142, 178, 172, 166, 160, 124].map(ansi256);
const levelColor = (pct) => LEVELS[Math.min(9, Math.max(0, Math.ceil(pct / 10) - 1))];

// Pace marker colours, by the usage the current rate projects for the end of
// the window.
const paceColor = (projected) =>
  projected < 50 ? ansi256(34) // comfortable
  : projected < 75 ? ansi256(37) // on track
  : projected < 90 ? ansi256(178) // warming
  : projected < 100 ? ansi256(208) // pressing
  : projected < 120 ? ansi256(160) // critical
  : ansi256(135); // runaway

const WINDOWS = {
  '5h': { key: 'five_hour', seconds: 5 * 3600, minElapsed: 540 }, // 9 minutes
  '7d': { key: 'seven_day', seconds: 7 * 86400, minElapsed: 3024 }, // about 50 minutes
};

// Compact counts, the same as the token line's: 1.69M, 427k, 6.5k, 830.
const fmt = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
  : n >= 1e5 ? `${Math.round(n / 1e3)}k`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
  : String(n);

// Bars come in 5 or 10 cells; anything else falls back to 5.
const segmentsOf = (value) => (Number(value) === 10 ? 10 : 5);

// The cells of a bar, filled in proportion to pct.
const cellsFor = (pct, segments) => {
  const filled = Math.min(segments, Math.max(0, Math.round((pct * segments) / 100)));
  return '▓'.repeat(filled) + '░'.repeat(segments - filled);
};

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return ''; // not a repository, or git is missing
  }
}

const gitBranch = (cwd) => git(cwd, ['branch', '--show-current']);

// Reset times are rounded to the nearest minute, so 6:59:45 shows as 07:00.
const resetDate = (epochSeconds) => new Date(Math.round(epochSeconds / 60) * 60 * 1000);

function formatTime(epochSeconds, config) {
  return resetDate(epochSeconds).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: config.hour12,
  });
}

// The weekly window resets days away: show the calendar days until the
// reset ("3d"), or the time when the reset falls today.
function formatDaysOrTime(epochSeconds, config, nowMs) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(resetDate(epochSeconds)) - midnight(new Date(nowMs))) / 86400000);
  return days > 0 ? `${days}d` : formatTime(epochSeconds, config);
}

// A usage bar. With a pace marker, ┃ replaces the cell where "now" falls in
// the window, coloured by the projected end-of-window usage.
function usageBar(pct, color, window, resetsAt, config, nowMs) {
  const cells = cellsFor(pct, config.segments);
  const remaining = resetsAt ? resetsAt - nowMs / 1000 : 0;
  if (!config.pace || remaining <= 0 || remaining >= window.seconds) return ` ${cells}`;

  const elapsed = window.seconds - remaining;
  const pos = Math.min(config.segments - 1, Math.max(0, Math.round((elapsed * config.segments) / window.seconds)));
  // Early in a window the projection is noise, so keep the usage colour.
  const marker = elapsed >= window.minElapsed ? paceColor((pct * window.seconds) / elapsed) : color;
  return ` ${cells.slice(0, pos)}${marker}┃${RESET}${color}${cells.slice(pos + 1)}`;
}

// The 5h or 7d part. rate_limits is present only for claude.ai Pro and Max
// subscribers, after the first response of a session; "~" marks a window
// Claude Code has not reported yet.
function windowPart(name, data, config, nowMs) {
  const window = WINDOWS[name];
  const label = config.labels ? `${name} ` : '';
  const limit = data.rate_limits?.[window.key];
  if (limit?.used_percentage == null) return `${YELLOW}${label}~${RESET}`;

  const pct = Math.round(limit.used_percentage);
  const color = levelColor(pct);
  const bar = config.bars ? usageBar(pct, color, window, limit.resets_at, config, nowMs) : '';
  let reset = '';
  if (config.reset && limit.resets_at) {
    const when = name === '7d' ? formatDaysOrTime(limit.resets_at, config, nowMs) : formatTime(limit.resets_at, config);
    reset = ` → ${when}`;
  }
  return `${color}${label}${pct}%${bar}${reset}${RESET}`;
}

// The context in the token line's shape: ctx 43% ▓▓░░░ 86.0k. Both figures
// count input only (fresh input plus cache writes and reads), as Claude
// Code's used_percentage does.
function contextPart(data, config) {
  const ctx = data.context_window;
  if (!ctx) return '';
  const u = ctx.current_usage;
  const size = ctx.context_window_size;
  let tokens = u
    ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    : (ctx.total_input_tokens ?? null);
  const pct = ctx.used_percentage ?? (tokens != null && size ? (tokens * 100) / size : null);
  if (pct == null) return '';
  if (tokens == null && size) tokens = Math.round((pct * size) / 100);

  const color = pct <= 50 ? CYAN : pct <= 75 ? YELLOW : LEVELS[8];
  const label = config.labels ? 'ctx ' : '';
  const bar = config.bars ? ` ${cellsFor(pct, config.segments)}` : '';
  const count = tokens != null ? ` ${fmt(tokens)}` : '';
  return `${color}${label}${Math.round(pct)}%${bar}${count}${RESET}`;
}

// The current local time, on the same clock as the reset times.
function timePart(config, nowMs) {
  const time = new Date(nowMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: config.hour12 });
  return `${GRAY}${time}${RESET}`;
}

// A session's running time: 45s, 12m, 1h12m, 2d3h. A zero lower unit is
// left off, so an hour on the dot reads 1h.
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

function durationPart(data) {
  const ms = data.cost?.total_duration_ms;
  return ms != null ? `${GRAY}${formatDuration(ms)}${RESET}` : '';
}

// The session's estimated cost. Behind a spend limit it takes the usage
// colour of the limit's percentage; otherwise it is plain metadata.
function costPart(data) {
  const usd = data.cost?.total_cost_usd;
  if (usd == null) return '';
  const spent = data.rate_limits?.spend_limit?.used_percentage;
  const color = spent != null ? levelColor(Math.round(spent)) : GRAY;
  return `${color}$${usd.toFixed(2)}${RESET}`;
}

function linesPart(data) {
  const added = data.cost?.total_lines_added;
  const removed = data.cost?.total_lines_removed;
  if (added == null && removed == null) return '';
  return `${GREEN}+${added ?? 0}${RESET} ${RED}−${removed ?? 0}${RESET}`;
}

// The session's custom name or AI-generated title, cut to 30 characters.
function namePart(data) {
  const name = data.session_name;
  if (!name) return '';
  const shown = name.length > 30 ? `${name.slice(0, 29)}…` : name;
  return `${GRAY}${shown}${RESET}`;
}

// Model state, in the model's yellow. effort is labelled because "high" on
// its own could mean anything; thinking and fast are their own label and
// show only when on; style shows only when it is not the default.
function effortPart(data, config) {
  const level = data.effort?.level;
  return level ? `${YELLOW}${config.labels ? 'effort ' : ''}${level}${RESET}` : '';
}

const thinkingPart = (data) => (data.thinking?.enabled ? `${YELLOW}think${RESET}` : '');

const fastPart = (data) => (data.fast_mode ? `${YELLOW}fast${RESET}` : '');

function stylePart(data, config) {
  const name = data.output_style?.name;
  if (!name || name === 'default') return '';
  return `${GRAY}${config.labels ? 'style ' : ''}${name}${RESET}`;
}

// The repository as owner/name from the origin remote. Without one (outside
// git, or no origin) it falls back to the folder name, so a row that leads
// with repo never loses its location.
function repoPart(data, cwd) {
  const repo = data.workspace?.repo;
  const shown = repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : path.basename(cwd);
  return `${GRAY}${shown}${RESET}`;
}

// The linked git worktree the session is in, if any. workspace.git_worktree
// covers every linked worktree; worktree.name only Claude Code's own
// worktree sessions.
const worktreeName = (data) => data.workspace?.git_worktree || data.worktree?.name || '';

// The branch, followed by the worktree name inside a linked worktree.
function branchPart(data, config, branch) {
  if (!branch) return '';
  const wt = worktreeName(data);
  const inWorktree = wt ? ` (${config.labels ? 'wt ' : ''}${wt})` : '';
  return `${GREEN}⎇ ${branch}${inWorktree}${RESET}`;
}

function worktreePart(data, config) {
  const wt = worktreeName(data);
  return wt ? `${GRAY}${config.labels ? 'wt ' : ''}${wt}${RESET}` : '';
}

// The branch's open pull request, coloured by its review state. A GitLab
// merge request takes GitLab's ! prefix instead of #.
const PR_COLORS = { approved: GREEN, pending: YELLOW, changes_requested: RED, draft: GRAY };

function prPart(data) {
  const pr = data.pr;
  if (pr?.number == null) return '';
  const number = `${pr.kind === 'mr' ? '!' : '#'}${pr.number}`;
  const state = pr.review_state ? ` ${pr.review_state}` : '';
  return `${PR_COLORS[pr.review_state] ?? GRAY}${number}${state}${RESET}`;
}

function agentPart(data, config) {
  const name = data.agent?.name;
  return name ? `${GRAY}${config.labels ? 'agent ' : ''}${name}${RESET}` : '';
}

// The prompt cache's hit ratio and whether it is still warm. A high hit
// ratio is good, so the colour follows the miss rate on the usage scale.
function cachePart(data, config) {
  const cache = data.prompt_cache;
  if (!cache) return '';
  const label = config.labels ? 'cache ' : '';
  const state = cache.warm ? 'warm' : 'cold';
  if (cache.hit_ratio == null) return `${GRAY}${label}${state}${RESET}`;
  const hit = Math.round(cache.hit_ratio * 100);
  return `${levelColor(100 - hit)}${label}${hit}% ${state}${RESET}`;
}

// The spend limit behind a Claude apps gateway: dollars when Claude Code has
// them, which arrive a little after the percentage, and the percentage until
// then.
function spendPart(data, config) {
  const limit = data.rate_limits?.spend_limit;
  if (limit?.used_percentage == null) return '';
  const color = levelColor(Math.round(limit.used_percentage));
  if (limit.used_usd != null && limit.limit_usd != null) {
    return `${color}$${Math.round(limit.used_usd)}/$${Math.round(limit.limit_usd)}${RESET}`;
  }
  return `${color}${config.labels ? 'spend ' : ''}${Math.round(limit.used_percentage)}%${RESET}`;
}

const versionPart = (data) => (data.version ? `${GRAY}v${data.version}${RESET}` : '');

function render(data, { config: overrides = {}, nowMs = Date.now(), branchOf = gitBranch } = {}) {
  const config = { ...DEFAULTS, ...overrides };
  config.segments = segmentsOf(config.segments);
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();

  const build = {
    dir: () => `${BLUE}${path.basename(cwd)}${RESET}`,
    branch: () => branchPart(data, config, branchOf(cwd)),
    model: () => (data.model?.display_name ? `${YELLOW}${data.model.display_name}${RESET}` : ''),
    ctx: () => contextPart(data, config),
    '5h': () => windowPart('5h', data, config, nowMs),
    '7d': () => windowPart('7d', data, config, nowMs),
    time: () => timePart(config, nowMs),
    duration: () => durationPart(data),
    cost: () => costPart(data),
    lines: () => linesPart(data),
    name: () => namePart(data),
    effort: () => effortPart(data, config),
    thinking: () => thinkingPart(data),
    fast: () => fastPart(data),
    style: () => stylePart(data, config),
    repo: () => repoPart(data, cwd),
    worktree: () => worktreePart(data, config),
    pr: () => prPart(data),
    agent: () => agentPart(data, config),
    cache: () => cachePart(data, config),
    spend: () => spendPart(data, config),
    version: () => versionPart(data),
  };

  // One output line per row. A part with nothing to show drops out of its
  // row, and a row left with no parts drops out of the status line.
  return config.rows
    .map((row) =>
      row
        .map((part) => build[part]?.() ?? '')
        .filter(Boolean)
        .join(`${GRAY} │ ${RESET}`),
    )
    .filter(Boolean)
    .join('\n');
}

// --latest: the status line where Claude Code runs none (the VS Code panel).
// It rebuilds a payload from the session transcript, and takes the 5h and 7d
// windows from the last terminal render, which saves them.

const fs = require('node:fs');
const os = require('node:os');

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const usageFile = () => path.join(configDir(), 'claude-gauge', '.state', 'usage.json');

// Best effort: a failed save never breaks the status line.
function saveUsage(data, nowMs) {
  if (!data.rate_limits) return;
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify({ savedAt: nowMs, rate_limits: data.rate_limits }));
  } catch {
    /* read-only home or similar: skip */
  }
}

// The saved windows, without any that have reset since they were saved.
function loadUsage(nowMs) {
  try {
    const { rate_limits: saved } = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    const live = Object.entries(saved ?? {}).filter(([, w]) => !w?.resets_at || w.resets_at * 1000 > nowMs);
    return live.length ? Object.fromEntries(live) : undefined;
  } catch {
    return undefined;
  }
}

// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5.
function modelName(id) {
  if (!id) return undefined;
  const parts = id.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  const family = parts.shift();
  if (!family) return id;
  return [family[0].toUpperCase() + family.slice(1), parts.join('.')].filter(Boolean).join(' ');
}

// --window when given (200k, 1m, 1000000); else 200k, or 1M once past it.
function windowSize(tokens, explicit) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(explicit ?? ''));
  if (m) return Math.round(Number(m[1]) * { '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()]);
  return tokens > 200e3 ? 1e6 : 200e3;
}

// A status line payload rebuilt from transcript records.
function payloadFromTranscript(records, { nowMs = Date.now(), window, usage } = {}) {
  const data = {};
  const cwd = [...records].reverse().find((r) => r.cwd)?.cwd;
  if (cwd) data.workspace = { current_dir: cwd };
  const main = records.filter((r) => r.type === 'assistant' && !r.isSidechain && r.message?.usage);
  const last = main[main.length - 1];
  if (last) {
    const u = last.message.usage;
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const size = windowSize(tokens, window);
    data.context_window = { context_window_size: size, used_percentage: (tokens * 100) / size, total_input_tokens: tokens };
    data.model = { display_name: modelName(last.message.model) };
    const effort = typeof last.effort === 'string' ? last.effort : last.effort?.level;
    if (effort) data.effort = { level: effort };
  }
  const first = records.find((r) => r.timestamp)?.timestamp;
  if (first) data.cost = { total_duration_ms: nowMs - Date.parse(first) };
  if (usage) data.rate_limits = usage;
  return data;
}

// A remote URL as { host, owner, name }, the shape Claude Code sends:
// git@github.com:jv-k/claude-gauge.git, https://github.com/jv-k/claude-gauge.
function repoFromRemote(url) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url ?? '');
  return m ? { host: m[1], owner: m[2], name: m[3] } : undefined;
}

// The linked worktree's name, from its git dir: <common>/worktrees/<name>.
function worktreeFromGitDir(gitDir) {
  return gitDir && path.basename(path.dirname(gitDir)) === 'worktrees' ? path.basename(gitDir) : undefined;
}

// What Claude Code's payload says about the repository, read from git, so
// repo and branch show as they do in the terminal.
function gitWorkspace(cwd) {
  const repo = repoFromRemote(git(cwd, ['remote', 'get-url', 'origin']));
  const worktree = worktreeFromGitDir(git(cwd, ['rev-parse', '--absolute-git-dir']));
  return { ...(repo && { repo }), ...(worktree && { git_worktree: worktree }) };
}

function readRecords(file) {
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a partially flushed final line is expected */
    }
  }
  return records;
}

// The calling session's transcript, found by the id Claude Code exports to
// the commands it runs; else the newest transcript of this folder.
function latestTranscript(cwd) {
  const projects = path.join(configDir(), 'projects');
  if (!fs.existsSync(projects)) return null;
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (own) {
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${own}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  const dir = path.join(projects, cwd.replace(/[/.]/g, '-'));
  if (!fs.existsSync(dir)) return null;
  const newest = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? newest.f : null;
}

// --instruct: the SessionStart hook for hosts that show no status line. In
// the VS Code extension and the desktop app it prints an instruction that has
// Claude end each reply with it. In the terminal CLI, where it already shows,
// it prints nothing. Claude Code names the host in CLAUDE_CODE_ENTRYPOINT,
// which hooks inherit; an unknown or missing value counts as a host that
// needs nothing.
const INSTRUCT_HOSTS = ['claude-vscode', 'claude-desktop', 'claude-desktop-3p'];

function instruction(argv, { host, script }) {
  if (!INSTRUCT_HOSTS.includes(host)) return null;
  const command = ['node', script, '--latest', ...argv.filter((a) => a !== '--instruct')].join(' ');
  return [
    '## Status line in replies',
    '',
    "End every reply with the claude-gauge status line, as a copyable code block, so this panel shows what the terminal's status line does:",
    '',
    '```sh',
    command,
    '```',
    '',
    "Run it as the last tool call of the turn, then paste its rows verbatim as the final thing in the reply, in one plain code block. `ctx` is the context the most recent request carried in. Skip it only if the command fails. Never guess the figures, and never reuse an earlier turn's rows.",
    '',
  ].join('\n');
}

// This script's path as a hook command can name it: ~ for the home folder.
const ownPath = () => process.argv[1].replace(new RegExp(`^${os.homedir()}(?=/)`), '~');

module.exports = {
  render,
  parseArgs,
  PARTS,
  DEFAULT_ROWS,
  payloadFromTranscript,
  modelName,
  repoFromRemote,
  worktreeFromGitDir,
  instruction,
  INSTRUCT_HOSTS,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const config = parseArgs(argv);
  const nowMs = Date.now();
  if (argv.includes('--instruct')) {
    const text = instruction(argv, { host: process.env.CLAUDE_CODE_ENTRYPOINT, script: ownPath() });
    if (text) process.stdout.write(text);
  } else if (argv.includes('--latest')) {
    const at = argv.findIndex((a) => a === '--window' || a.startsWith('--window='));
    const window = at < 0 ? undefined : argv[at].includes('=') ? argv[at].split('=')[1] : argv[at + 1];
    const transcript = latestTranscript(process.cwd());
    const records = transcript ? readRecords(transcript) : [];
    const data = payloadFromTranscript(records, { nowMs, window, usage: loadUsage(nowMs) });
    if (data.workspace) Object.assign(data.workspace, gitWorkspace(data.workspace.current_dir));
    // Plain text: it is pasted into a reply, where colour codes show as junk.
    process.stdout.write(render(data, { config, nowMs }).replace(/\x1b\[[0-9;]*m/g, '') + '\n');
  } else {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      let data = {};
      try {
        data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {
        /* render what we can from an empty payload rather than print nothing */
      }
      saveUsage(data, nowMs);
      process.stdout.write(render(data, { config, nowMs }) + '\n');
    });
  }
}
