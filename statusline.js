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

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return ''; // not a repository, or git is missing
  }
}

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

module.exports = { render, parseArgs, PARTS, DEFAULT_ROWS };

if (require.main === module) {
  const config = parseArgs(process.argv.slice(2));
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let data = {};
    try {
      data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      /* render what we can from an empty payload rather than print nothing */
    }
    process.stdout.write(render(data, { config }) + '\n');
  });
}
