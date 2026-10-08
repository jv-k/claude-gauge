#!/usr/bin/env node

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
// The parts it can show are in PART_REGISTRY and the switches it takes in
// SWITCHES, both below. README.md documents each in a table, and a test fails
// when the tables and the registry disagree.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// What a part's builder reads: the payload, the config, the clock, the
// folder Claude Code runs in, and the git branch reader.
interface PartContext {
  data: StatusData;
  config: Config;
  nowMs: number;
  cwd: string;
  branchOf: (cwd: string) => string;
}

interface PartSpec {
  description: string;
  // The default row the part shows in, counted from 0. A part without one
  // shows only when a --show names it.
  row?: number;
  build: (ctx: PartContext) => string;
}

// Every status line part, by the name --show takes. The default parts come
// first, in the order their rows show them; the order of the rest is the
// README's.
const partRegistry = {
  ctx: { description: 'context window in use: percentage, bar and token count', row: 0, build: ({ data, config }) => contextPart(data, config) },
  '5h': { description: '5-hour usage, with pace marker and reset time', row: 0, build: ({ data, config, nowMs }) => windowPart('5h', data, config, nowMs) },
  '7d': { description: 'weekly usage, with pace marker and days to reset', row: 0, build: ({ data, config, nowMs }) => windowPart('7d', data, config, nowMs) },
  time: { description: 'current local time', row: 1, build: ({ config, nowMs }) => timePart(config, nowMs) },
  duration: { description: 'how long the session has run', row: 1, build: ({ data }) => durationPart(data) },
  repo: { description: 'owner/name from the origin remote, else the folder name', row: 1, build: ({ data, cwd }) => repoPart(data, cwd) },
  branch: { description: 'current git branch, and the linked worktree', row: 1, build: ({ data, config, cwd, branchOf }) => branchPart(data, config, branchOf(cwd)) },
  model: { description: 'model name', row: 1, build: ({ data }) => (data.model?.display_name ? `${YELLOW}${data.model.display_name}${RESET}` : '') },
  effort: { description: 'reasoning effort', row: 1, build: ({ data, config }) => effortPart(data, config) },
  dir: { description: 'folder Claude Code runs in', build: ({ cwd }) => `${BLUE}${path.basename(cwd)}${RESET}` },
  cost: { description: 'estimated session cost', build: ({ data }) => costPart(data) },
  lines: { description: 'lines added and removed this session', build: ({ data }) => linesPart(data) },
  name: { description: 'session name or title', build: ({ data }) => namePart(data) },
  thinking: { description: 'extended thinking, when on', build: ({ data }) => thinkingPart(data) },
  fast: { description: 'fast mode, when on', build: ({ data }) => fastPart(data) },
  style: { description: 'output style, when not the default', build: ({ data, config }) => stylePart(data, config) },
  worktree: { description: 'linked git worktree', build: ({ data, config }) => worktreePart(data, config) },
  pr: { description: "the branch's open pull request and its review state", build: ({ data }) => prPart(data) },
  agent: { description: 'agent name, with --agent', build: ({ data, config }) => agentPart(data, config) },
  cache: { description: 'prompt cache hit ratio and warmth', build: ({ data, config }) => cachePart(data, config) },
  spend: { description: 'spend against a gateway spend limit', build: ({ data, config }) => spendPart(data, config) },
  version: { description: 'Claude Code version', build: ({ data }) => versionPart(data) },
} satisfies Record<string, PartSpec>;

type Part = keyof typeof partRegistry;

const PART_REGISTRY: Readonly<Record<Part, PartSpec>> = partRegistry;

const PARTS = Object.keys(PART_REGISTRY) as Part[];

const isPart = (name: string): name is Part => (PARTS as readonly string[]).includes(name);

// The rows shown when no --show names a known part: the headroom figures on
// top, the session around them below.
const DEFAULT_ROWS: Part[][] = PARTS.reduce<Part[][]>((rows, part) => {
  const { row } = PART_REGISTRY[part];
  if (row != null) (rows[row] ??= []).push(part);
  return rows;
}, []);

interface Config {
  rows: Part[][];
  segments: number;
  labels: boolean;
  bars: boolean;
  pace: boolean;
  reset: boolean;
  hour12: boolean;
}

// What parseArgs returns and render takes: any subset of the config, with
// segments still the text of the switch.
type Overrides = Partial<Omit<Config, 'segments'>> & { segments?: number | string };

const DEFAULTS: Config = {
  rows: DEFAULT_ROWS,
  segments: 5,
  labels: true,
  bars: true,
  pace: true,
  reset: true,
  hour12: false,
};

interface Switch {
  name: string;
  // The value the switch takes, as the README writes it; none for a flag.
  value?: string;
  description: string;
  // What the switch sets in the config. A switch without one acts in the
  // program itself, not in render.
  apply?: (config: Overrides, value: string) => void;
}

// Every status line switch.
const SWITCHES: readonly Switch[] = [
  {
    name: '--show',
    value: '<parts>',
    description: 'one row: the parts to show, in order, comma-separated; repeat it for more rows',
    apply: (config, value) => {
      const parts = value.split(',').map((p) => p.trim()).filter(isPart);
      if (parts.length) (config.rows ??= []).push(parts);
    },
  },
  { name: '--segments', value: '<5|10>', description: 'cells per bar (default 5)', apply: (config, value) => { config.segments = value; } },
  { name: '--no-labels', description: 'drop the labels in front of values', apply: (config) => { config.labels = false; } },
  { name: '--no-bars', description: 'drop the bars', apply: (config) => { config.bars = false; } },
  { name: '--no-pace', description: 'drop the pace markers', apply: (config) => { config.pace = false; } },
  { name: '--no-reset', description: 'drop the reset times', apply: (config) => { config.reset = false; } },
  { name: '--12h', description: '12-hour clock for the time part and reset times', apply: (config) => { config.hour12 = true; } },
  { name: '--latest', description: "print the calling session's rows from its transcript, as plain text" },
  { name: '--window', value: '<size>', description: 'with --latest: the context window size, such as 200k or 1m' },
  { name: '--instruct', description: 'as a SessionStart hook: have Claude end each reply with the --latest rows' },
];

// Turns the switches into a config. Unknown switches and part names are
// ignored, and a --show with no known part adds no row: a status line should
// show something rather than fail.
function parseArgs(argv: string[]): Overrides {
  const config: Overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    const sw = SWITCHES.find((s) => s.name === name);
    if (!sw?.apply) continue;
    sw.apply(config, sw.value ? (inline ?? argv[++i] ?? '') : '');
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
const ansi256 = (n: number) => `\x1b[38;5;${n}m`;

// Ten usage levels: dark green at 0-10%, deep red above 90%.
const LEVELS = [22, 28, 34, 100, 142, 178, 172, 166, 160, 124].map(ansi256);
const levelColor = (pct: number) => LEVELS[Math.min(9, Math.max(0, Math.ceil(pct / 10) - 1))];

// Pace marker colours, by the usage the current rate projects for the end of
// the window.
const paceColor = (projected: number) =>
  projected < 50 ? ansi256(34) // comfortable
  : projected < 75 ? ansi256(37) // on track
  : projected < 90 ? ansi256(178) // warming
  : projected < 100 ? ansi256(208) // pressing
  : projected < 120 ? ansi256(160) // critical
  : ansi256(135); // runaway

interface UsageWindow {
  key: 'five_hour' | 'seven_day';
  seconds: number;
  minElapsed: number;
}

const WINDOWS: Record<'5h' | '7d', UsageWindow> = {
  '5h': { key: 'five_hour', seconds: 5 * 3600, minElapsed: 540 }, // 9 minutes
  '7d': { key: 'seven_day', seconds: 7 * 86400, minElapsed: 3024 }, // about 50 minutes
};

// The parts of Claude Code's payload the status line reads. Every field is
// optional: the payload grows with Claude Code, and a part with nothing to
// show drops out rather than fails.
interface RateLimit {
  used_percentage?: number | null;
  resets_at?: number;
  used_usd?: number | null;
  limit_usd?: number | null;
}

interface StatusData {
  cwd?: string;
  version?: string;
  session_name?: string;
  fast_mode?: boolean;
  model?: { display_name?: string };
  workspace?: {
    current_dir?: string;
    repo?: { host?: string; owner?: string; name?: string };
    git_worktree?: string;
  };
  worktree?: { name?: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number | null;
    total_input_tokens?: number | null;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
    spend_limit?: RateLimit;
  };
  cost?: {
    total_duration_ms?: number;
    total_cost_usd?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  output_style?: { name?: string };
  pr?: { number?: number; kind?: string; review_state?: string; url?: string };
  agent?: { name?: string };
  prompt_cache?: { warm?: boolean; hit_ratio?: number | null };
}

// Compact counts, the same as the token line's: 1.69M, 427k, 6.5k, 830.
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
  : n >= 1e5 ? `${Math.round(n / 1e3)}k`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
  : String(n);

// Bars come in 5 or 10 cells; anything else falls back to 5.
const segmentsOf = (value: number | string | undefined) => (Number(value) === 10 ? 10 : 5);

// The cells of a bar, filled in proportion to pct.
const cellsFor = (pct: number, segments: number) => {
  const filled = Math.min(segments, Math.max(0, Math.round((pct * segments) / 100)));
  return '▓'.repeat(filled) + '░'.repeat(segments - filled);
};

function git(cwd: string, args: string[]): string {
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

const gitBranch = (cwd: string) => git(cwd, ['branch', '--show-current']);

// Reset times are rounded to the nearest minute, so 6:59:45 shows as 07:00.
const resetDate = (epochSeconds: number) => new Date(Math.round(epochSeconds / 60) * 60 * 1000);

function formatTime(epochSeconds: number, config: Config): string {
  return resetDate(epochSeconds).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: config.hour12,
  });
}

// The weekly window resets days away: show the calendar days until the
// reset ("3d"), or the time when the reset falls today.
function formatDaysOrTime(epochSeconds: number, config: Config, nowMs: number): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(resetDate(epochSeconds)) - midnight(new Date(nowMs))) / 86400000);
  return days > 0 ? `${days}d` : formatTime(epochSeconds, config);
}

// A usage bar. With a pace marker, ┃ replaces the cell where "now" falls in
// the window, coloured by the projected end-of-window usage.
function usageBar(
  pct: number,
  color: string,
  window: UsageWindow,
  resetsAt: number | undefined,
  config: Config,
  nowMs: number,
): string {
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
function windowPart(name: '5h' | '7d', data: StatusData, config: Config, nowMs: number): string {
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
function contextPart(data: StatusData, config: Config): string {
  const ctx = data.context_window;
  if (!ctx) return '';
  const u = ctx.current_usage;
  const size = ctx.context_window_size;
  let tokens: number | null = u
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
function timePart(config: Config, nowMs: number): string {
  const time = new Date(nowMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: config.hour12 });
  return `${GRAY}${time}${RESET}`;
}

// A session's running time: 45s, 12m, 1h12m, 2d3h. A zero lower unit is
// left off, so an hour on the dot reads 1h.
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

function durationPart(data: StatusData): string {
  const ms = data.cost?.total_duration_ms;
  return ms != null ? `${GRAY}${formatDuration(ms)}${RESET}` : '';
}

// The session's estimated cost. Behind a spend limit it takes the usage
// colour of the limit's percentage; otherwise it is plain metadata.
function costPart(data: StatusData): string {
  const usd = data.cost?.total_cost_usd;
  if (usd == null) return '';
  const spent = data.rate_limits?.spend_limit?.used_percentage;
  const color = spent != null ? levelColor(Math.round(spent)) : GRAY;
  return `${color}$${usd.toFixed(2)}${RESET}`;
}

function linesPart(data: StatusData): string {
  const added = data.cost?.total_lines_added;
  const removed = data.cost?.total_lines_removed;
  if (added == null && removed == null) return '';
  return `${GREEN}+${added ?? 0}${RESET} ${RED}−${removed ?? 0}${RESET}`;
}

// The session's custom name or AI-generated title, cut to 30 characters.
function namePart(data: StatusData): string {
  const name = data.session_name;
  if (!name) return '';
  const shown = name.length > 30 ? `${name.slice(0, 29)}…` : name;
  return `${GRAY}${shown}${RESET}`;
}

// Model state, in the model's yellow. effort is labelled because "high" on
// its own could mean anything; thinking and fast are their own label and
// show only when on; style shows only when it is not the default.
function effortPart(data: StatusData, config: Config): string {
  const level = data.effort?.level;
  return level ? `${YELLOW}${config.labels ? 'effort ' : ''}${level}${RESET}` : '';
}

const thinkingPart = (data: StatusData) => (data.thinking?.enabled ? `${YELLOW}think${RESET}` : '');

const fastPart = (data: StatusData) => (data.fast_mode ? `${YELLOW}fast${RESET}` : '');

function stylePart(data: StatusData, config: Config): string {
  const name = data.output_style?.name;
  if (!name || name === 'default') return '';
  return `${GRAY}${config.labels ? 'style ' : ''}${name}${RESET}`;
}

// The repository as owner/name from the origin remote. Without one (outside
// git, or no origin) it falls back to the folder name, so a row that leads
// with repo never loses its location.
function repoPart(data: StatusData, cwd: string): string {
  const repo = data.workspace?.repo;
  const shown = repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : path.basename(cwd);
  return `${GRAY}${shown}${RESET}`;
}

// The linked git worktree the session is in, if any. workspace.git_worktree
// covers every linked worktree; worktree.name only Claude Code's own
// worktree sessions.
const worktreeName = (data: StatusData) => data.workspace?.git_worktree || data.worktree?.name || '';

// The branch, followed by the worktree name inside a linked worktree.
function branchPart(data: StatusData, config: Config, branch: string): string {
  if (!branch) return '';
  const wt = worktreeName(data);
  const inWorktree = wt ? ` (${config.labels ? 'wt ' : ''}${wt})` : '';
  return `${GREEN}⎇ ${branch}${inWorktree}${RESET}`;
}

function worktreePart(data: StatusData, config: Config): string {
  const wt = worktreeName(data);
  return wt ? `${GRAY}${config.labels ? 'wt ' : ''}${wt}${RESET}` : '';
}

// The branch's open pull request, coloured by its review state. A GitLab
// merge request takes GitLab's ! prefix instead of #.
const PR_COLORS: Record<string, string> = { approved: GREEN, pending: YELLOW, changes_requested: RED, draft: GRAY };

function prPart(data: StatusData): string {
  const pr = data.pr;
  if (pr?.number == null) return '';
  const number = `${pr.kind === 'mr' ? '!' : '#'}${pr.number}`;
  const state = pr.review_state ? ` ${pr.review_state}` : '';
  return `${PR_COLORS[pr.review_state ?? ''] ?? GRAY}${number}${state}${RESET}`;
}

function agentPart(data: StatusData, config: Config): string {
  const name = data.agent?.name;
  return name ? `${GRAY}${config.labels ? 'agent ' : ''}${name}${RESET}` : '';
}

// The prompt cache's hit ratio and whether it is still warm. A high hit
// ratio is good, so the colour follows the miss rate on the usage scale.
function cachePart(data: StatusData, config: Config): string {
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
function spendPart(data: StatusData, config: Config): string {
  const limit = data.rate_limits?.spend_limit;
  if (limit?.used_percentage == null) return '';
  const color = levelColor(Math.round(limit.used_percentage));
  if (limit.used_usd != null && limit.limit_usd != null) {
    return `${color}$${Math.round(limit.used_usd)}/$${Math.round(limit.limit_usd)}${RESET}`;
  }
  return `${color}${config.labels ? 'spend ' : ''}${Math.round(limit.used_percentage)}%${RESET}`;
}

const versionPart = (data: StatusData) => (data.version ? `${GRAY}v${data.version}${RESET}` : '');

interface RenderOptions {
  config?: Overrides;
  nowMs?: number;
  branchOf?: (cwd: string) => string;
}

function render(data: StatusData, { config: overrides = {}, nowMs = Date.now(), branchOf = gitBranch }: RenderOptions = {}): string {
  const merged = { ...DEFAULTS, ...overrides };
  const config: Config = { ...merged, segments: segmentsOf(merged.segments) };
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();

  const ctx: PartContext = { data, config, nowMs, cwd, branchOf };

  // One output line per row. A part with nothing to show drops out of its
  // row, and a row left with no parts drops out of the status line.
  return config.rows
    .map((row) =>
      row
        // Rows handed in from JavaScript may name parts the registry lacks;
        // those render as nothing, like every other part with nothing to show.
        .map((part) => (isPart(part) ? PART_REGISTRY[part].build(ctx) : ''))
        .filter(Boolean)
        .join(`${GRAY} │ ${RESET}`),
    )
    .filter(Boolean)
    .join('\n');
}

// --latest: the status line where Claude Code runs none (the VS Code panel).
// It rebuilds a payload from the session transcript, and takes the 5h and 7d
// windows from the last terminal render, which saves them.

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const usageFile = () => path.join(configDir(), 'claude-gauge', '.state', 'usage.json');

// Best effort: a failed save never breaks the status line.
function saveUsage(data: StatusData, nowMs: number): void {
  if (!data.rate_limits) return;
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify({ savedAt: nowMs, rate_limits: data.rate_limits }));
  } catch {
    /* read-only home or similar: skip */
  }
}

// The saved windows, without any that have reset since they were saved.
function loadUsage(nowMs: number): StatusData['rate_limits'] | undefined {
  try {
    const { rate_limits: saved } = JSON.parse(fs.readFileSync(usageFile(), 'utf8')) as {
      rate_limits?: Record<string, RateLimit | undefined>;
    };
    const live = Object.entries(saved ?? {}).filter(([, w]) => !w?.resets_at || w.resets_at * 1000 > nowMs);
    return live.length ? Object.fromEntries(live) : undefined;
  } catch {
    return undefined;
  }
}

// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5.
function modelName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const parts = id.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  const family = parts.shift();
  if (!family) return id;
  return [family[0].toUpperCase() + family.slice(1), parts.join('.')].filter(Boolean).join(' ');
}

const SCALES: Record<string, number> = { '': 1, k: 1e3, m: 1e6 };

// --window when given (200k, 1m, 1000000); else 200k, or 1M once past it.
function windowSize(tokens: number, explicit: string | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(explicit ?? ''));
  if (m) return Math.round(Number(m[1]) * SCALES[m[2].toLowerCase()]);
  return tokens > 200e3 ? 1e6 : 200e3;
}

// A session transcript record, as far as the status line reads it.
interface TranscriptRecord {
  type?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  effort?: string | { level?: string };
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface TranscriptOptions {
  nowMs?: number;
  window?: string;
  usage?: StatusData['rate_limits'];
}

// A status line payload rebuilt from transcript records.
function payloadFromTranscript(records: TranscriptRecord[], { nowMs = Date.now(), window, usage }: TranscriptOptions = {}): StatusData {
  const data: StatusData = {};
  const cwd = [...records].reverse().find((r) => r.cwd)?.cwd;
  if (cwd) data.workspace = { current_dir: cwd };
  const last = records.filter((r) => r.type === 'assistant' && !r.isSidechain && r.message?.usage).at(-1);
  if (last) {
    const u = last.message?.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const size = windowSize(tokens, window);
    data.context_window = { context_window_size: size, used_percentage: (tokens * 100) / size, total_input_tokens: tokens };
    data.model = { display_name: modelName(last.message?.model) };
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
function repoFromRemote(url: string | undefined): { host: string; owner: string; name: string } | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url ?? '');
  return m ? { host: m[1], owner: m[2], name: m[3] } : undefined;
}

// The linked worktree's name, from its git dir: <common>/worktrees/<name>.
function worktreeFromGitDir(gitDir: string | undefined): string | undefined {
  return gitDir && path.basename(path.dirname(gitDir)) === 'worktrees' ? path.basename(gitDir) : undefined;
}

// What Claude Code's payload says about the repository, read from git, so
// repo and branch show as they do in the terminal.
function gitWorkspace(cwd: string): NonNullable<StatusData['workspace']> {
  const repo = repoFromRemote(git(cwd, ['remote', 'get-url', 'origin']));
  const worktree = worktreeFromGitDir(git(cwd, ['rev-parse', '--absolute-git-dir']));
  return { ...(repo ? { repo } : {}), ...(worktree ? { git_worktree: worktree } : {}) };
}

function readRecords(file: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
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
function latestTranscript(cwd: string): string | null {
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

// A shell word: as is when plain, else in single quotes. ~ stays bare so the
// shell expands a ~/ path.
const shellWord = (s: string) => (/^[\w@%+=:,.\/~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function instruction(argv: string[], { host, script }: { host: string | undefined; script: string }): string | null {
  if (host === undefined || !INSTRUCT_HOSTS.includes(host)) return null;
  const command = ['node', script, '--latest', ...argv.filter((a) => a !== '--instruct')].map(shellWord).join(' ');
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

export {
  render,
  parseArgs,
  PARTS,
  PART_REGISTRY,
  DEFAULT_ROWS,
  SWITCHES,
  payloadFromTranscript,
  modelName,
  repoFromRemote,
  worktreeFromGitDir,
  instruction,
  INSTRUCT_HOSTS,
};

export type { StatusData, Config, Overrides, Part, PartSpec, PartContext, Switch, TranscriptRecord };

// Whether this file is the program, not a module another file loaded. Node
// runs the compiled CommonJS, where require.main names the entry; Bun runs
// this source as an ES module, where Bun.main does.
declare const Bun: { main: string } | undefined;
const isMain = (typeof require !== 'undefined' && require.main === module) || (typeof Bun !== 'undefined' && Bun.main === __filename);

if (isMain) {
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
    const cwd = data.workspace?.current_dir;
    if (data.workspace && cwd) Object.assign(data.workspace, gitWorkspace(cwd));
    // Plain text: it is pasted into a reply, where colour codes show as junk.
    process.stdout.write(render(data, { config, nowMs }).replace(/\x1b\[[0-9;]*m/g, '') + '\n');
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      let data: StatusData = {};
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
