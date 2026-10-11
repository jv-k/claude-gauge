#!/usr/bin/env node

// claude-gauge status line for the Claude Code terminal CLI.
//
// Reads the JSON Claude Code sends on stdin and prints one or more rows. The
// default is two:
//
//   ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
//   14:58 │ 1h12m │ jv-k/claude-gauge │ ⎇ main* ↑1 │ Opus 5.5 │ effort high
//
// Almost everything comes from Claude Code's own payload
// (https://code.claude.com/docs/en/statusline): `rate_limits` carries the
// claude.ai 5-hour and 7-day windows, and any per-model weekly windows. The
// side calls are one `git status`, when a git part is shown, the modification
// times of the changed files, when the files part is, `vm_stat` for the ram
// part on macOS, the command --command names, for the command part, and, only
// when a part that needs it is shown, a read of the bytes the session
// transcript has gained since the last render. The env and plan parts read
// Claude Code's own config files, and the model part reads the provider from
// the environment. The today and week parts add the cost ledger, which each
// render keeps in the state folder.
//
// The parts it can show are in PART_REGISTRY, the switches it takes in
// SWITCHES and the --theme presets in THEME_REGISTRY, all below. README.md
// documents each in a table, and a test fails when the tables and the
// registry disagree. test/snapshots/themes/ holds the default rows in every
// theme.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';


// What a part's builder reads: the payload, the config, the clock, the cost
// ledger, the folder Claude Code runs in, and what git says about it. render
// sanitises the payload, the folder's name, the branch and the names of
// changed files before any part sees them.
interface PartContext {
  data: StatusData;
  config: Config;
  // The colours to draw with: the --theme preset, or one --color for the
  // whole part.
  theme: Theme;
  nowMs: number;
  ledger: Ledger;
  // The folder's path as it is, for git to run in, and its name to print.
  cwd: string;
  folder: string;
  // The machine's name, for the folder's file URL.
  hostname: string;
  // The folder's git state, read on first use and kept for the render.
  git: () => GitState;
  // A changed file's last modification time, by its path from the folder.
  mtimeOf: (file: string) => number | undefined;
  // What the session transcript shows, read on the first call only, so a
  // render that shows no transcript part never reads it.
  activity: () => TranscriptActivity;
  // The environment Claude Code runs the command in, which names the API
  // provider.
  processEnv: Env;
  // What Claude Code loads for the folder, read from the files on disk the
  // first time a part asks.
  setup: () => Setup;
  // The system's memory in use, read the first time a part asks.
  memory: () => Memory | undefined;
  // The first line of output of the command --command names, run the first
  // time a part asks; not yet sanitised.
  commandOutput: () => string;
}

type Env = Record<string, string | undefined>;

// What Claude Code loads into a session, and the account it signs in with:
// counts of CLAUDE.md files, rules, MCP servers and hooks, and the plan and
// user when the config names them.
interface Setup {
  claudeMd: number;
  rules: number;
  mcp: number;
  hooks: number;
  plan?: string;
  user?: string;
}

interface PartSpec {
  description: string;
  // The default row the part shows in, counted from 0. A part without one
  // shows only when a --show names it.
  row?: number;
  build: (ctx: PartContext) => string;
  // The address the part links to, when one is known. render wraps what the
  // part printed in an OSC 8 hyperlink to it.
  link?: (ctx: PartContext) => string | undefined;
}

// Every status line part, by the name --show takes. The default parts come
// first, in the order their rows show them; the order of the rest is the
// reference's (docs/reference.md).
const partRegistry = {
  ctx: { description: 'context window in use: percentage, bar and token count', row: 0, build: contextPart },
  '5h': { description: '5-hour usage, with pace marker and reset time', row: 0, build: (ctx) => windowPart('5h', ctx) },
  '7d': { description: 'weekly usage, with pace marker and days to reset', row: 0, build: (ctx) => windowPart('7d', ctx) },
  time: { description: 'current local time', row: 1, build: timePart },
  duration: { description: 'how long the session has run', row: 1, build: durationPart },
  repo: {
    description: 'owner/name from the origin remote, else the folder name',
    row: 1,
    build: repoPart,
    link: folderUrl,
  },
  branch: {
    description: 'current git branch, dirty marker, ahead and behind, and the linked worktree',
    row: 1,
    build: branchPart,
    link: ({ data, git }) => branchUrl(data.workspace?.repo, git().upstream),
  },
  model: { description: 'model name, and the API provider when not first-party', row: 1, build: modelPart },
  effort: { description: 'reasoning effort', row: 1, build: effortPart },
  dir: { description: 'folder Claude Code runs in', build: ({ theme, folder }) => `${theme.info}${folder}${RESET}`, link: folderUrl },
  cost: { description: 'estimated session cost', build: costPart },
  lines: { description: 'lines added and removed this session', build: linesPart },
  name: { description: 'session name or title', build: namePart },
  thinking: { description: 'extended thinking, when on', build: thinkingPart },
  fast: { description: 'fast mode, when on', build: fastPart },
  style: { description: 'output style, when not the default', build: stylePart },
  git: { description: 'modified, staged, deleted and untracked file counts, when any', build: gitCountsPart },
  files: { description: 'the most recently changed files', build: filesPart },
  worktree: { description: 'linked git worktree', build: worktreePart },
  pr: { description: "the branch's open pull request and its review state", build: prPart, link: ({ data }) => webUrl(data.pr?.url) },
  agent: { description: 'agent name, with --agent', build: agentPart },
  cache: { description: 'prompt cache hit ratio and warmth', build: cachePart },
  spend: { description: 'spend against a gateway spend limit', build: spendPart },
  version: { description: 'Claude Code version', build: versionPart },
  today: { description: "today's spend across sessions, from the cost ledger", build: (ctx) => spentPart('today', ctx) },
  week: { description: "this week's spend across sessions, from the cost ledger", build: (ctx) => spentPart('week', ctx) },
  tools: { description: 'the running tool and its target, and completed tools with counts', build: toolsPart },
  agents: { description: 'running subagents, and those finished in the last minute', build: agentsPart },
  todos: { description: 'the todo in progress, and how many todos are done', build: todosPart },
  skills: { description: 'skills used, and MCP servers called, marking those whose last call failed', build: skillsPart },
  compactions: { description: 'how many times the conversation was compacted', build: compactionsPart },
  reply: { description: 'time since the last reply', build: replyPart },
  speed: { description: 'output tokens per second of the last response', build: speedPart },
  env: { description: 'CLAUDE.md files, rules, MCP servers and hooks loaded', build: envPart },
  plan: { description: 'subscription plan and signed-in user', build: planPart },
  models: { description: 'per-model weekly usage, as 7d shows the week', build: modelsPart },
  limit: { description: 'a notice naming each exhausted window and its reset', build: limitPart },
  ram: { description: 'system memory in use: percentage, bar and amount', build: ramPart },
  text: { description: 'fixed text, with --text', build: textPart },
  command: { description: 'first line of output of a shell command, with --command', build: commandPart },
} satisfies Record<string, PartSpec>;

type Part = keyof typeof partRegistry;

// The same object, typed so that every entry reads as a PartSpec: the literal
// above keeps the names for the Part type, this keeps row optional on each.
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
  compact: boolean;
  // Whether dir, repo, branch and pr link to what they name.
  links: boolean;
  // The parts --right moves to the end of their row.
  right: Part[];
  // What the text part prints, as --text gives it: not yet sanitised.
  text: string;
  // The shell command the command part runs, as --command gives it; none
  // when empty.
  command: string;
  // The --theme preset's name, as given: render takes an unknown one as the
  // default.
  theme: string;
  // The --color overrides: a colour code for each part named.
  colors: Partial<Record<Part, string>>;
  // The characters of a bar's filled and empty cells.
  barFilled: string;
  barEmpty: string;
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
  compact: false,
  links: true,
  right: [],
  text: '',
  command: '',
  theme: 'default',
  colors: {},
  barFilled: '▓',
  barEmpty: '░',
};

interface Switch {
  name: string;
  // The value the switch takes, as docs/reference.md writes it; none for a flag.
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
  { name: '--compact', description: 'shorter separators and labels, for narrow terminals', apply: (config) => { config.compact = true; } },
  { name: '--no-links', description: 'drop the links on dir, repo, branch and pr', apply: (config) => { config.links = false; } },
  {
    name: '--right',
    value: '<parts>',
    description: 'the parts to right-align within their row, comma-separated, when the terminal width is known',
    apply: (config, value) => {
      config.right = [...(config.right ?? []), ...value.split(',').map((p) => p.trim()).filter(isPart)];
    },
  },
  { name: '--text', value: '<text>', description: 'the text the text part shows', apply: (config, value) => { config.text = value; } },
  {
    name: '--command',
    value: '<command>',
    description: 'the shell command the command part runs, with a short timeout',
    apply: (config, value) => { config.command = value; },
  },
  { name: '--theme', value: '<name>', description: 'the colour preset: default, mono, high-contrast or pastel', apply: (config, value) => { config.theme = value.trim(); } },
  {
    name: '--color',
    value: '<part>=<colour>',
    description: "one part's colour: a name, a 256-colour number or a hex colour; comma-separate or repeat it for more parts",
    apply: (config, value) => {
      for (const pair of value.split(',')) {
        const [part, color] = pair.split(/=(.*)/s).map((p) => p.trim());
        const code = colorCode(color ?? '');
        if (isPart(part) && code) config.colors = { ...config.colors, [part]: code };
      }
    },
  },
  { name: '--bar-filled', value: '<char>', description: 'the character of a filled bar cell (default ▓)', apply: (config, value) => { if (isBarChar(value)) config.barFilled = value; } },
  { name: '--bar-empty', value: '<char>', description: 'the character of an empty bar cell (default ░)', apply: (config, value) => { if (isBarChar(value)) config.barEmpty = value; } },
  { name: '--latest', description: "print the calling session's rows from its transcript, as plain text" },
  { name: '--window', value: '<size>', description: 'with --latest: the context window size, such as 200k or 1m' },
  { name: '--instruct', description: 'as a SessionStart hook: have Claude end each reply with the --latest rows' },
];

// A bar cell is one character, and never a control character: the switch is
// printed as it is, in every cell.
const isBarChar = (value: string) => Array.from(value).length === 1 && sanitise(value) === value;

// One switch as readSwitches reads it: its name, its value, the switch it is
// when the status line knows it, and the words it was read from.
interface ReadSwitch {
  name: string;
  value: string;
  known?: Switch;
  words: string[];
}

// The switches in `argv` as the status line reads them: a known switch that
// takes a value takes the next word, unless it has one after `=`. Any other
// word stands alone.
function readSwitches(argv: readonly string[]): ReadSwitch[] {
  const read: ReadSwitch[] = [];
  for (let i = 0; i < argv.length; i++) {
    const start = i;
    const [name, inline] = argv[i].split(/=(.*)/s);
    const known = SWITCHES.find((s) => s.name === name && s.apply);
    const value = known?.value ? (inline ?? argv[++i] ?? '') : '';
    read.push({ name, value, known, words: argv.slice(start, i + 1) });
  }
  return read;
}

// Turns the switches into a config. Unknown switches and part names are
// ignored, and a --show with no known part adds no row: a status line should
// show something rather than fail.
function parseArgs(argv: string[]): Overrides {
  const config: Overrides = {};
  for (const { known, value } of readSwitches(argv)) known?.apply?.(config, value);
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
// The 16-colour palette's bright half, and its bold form.
const bright = (n: number) => `\x1b[0;${n}m`;
const bold = (n: number) => `\x1b[1;${n}m`;

// The colours a status line draws with. Each part takes its colours from
// these roles, never a code of its own, so a theme restyles every part.
interface Theme {
  description: string;
  // Usage, in ten steps: 0-10% up to above 90%.
  levels: readonly string[];
  // The pace marker, by the usage projected for the end of the window:
  // below 50%, 75%, 90%, 100%, 120%, and above.
  pace: readonly string[];
  // ctx: up to 50%, up to 75%, and above.
  context: readonly string[];
  // Session details and the separator: time, duration, repo, name and the like.
  muted: string;
  // Model state, work in progress, and a usage window not reported yet.
  accent: string;
  // The branch, lines added, an approved pull request, work done.
  good: string;
  // Lines removed, a pull request with changes requested, a failure.
  bad: string;
  // The folder.
  info: string;
}

// The --theme presets, by name. default is the first, and what an unknown
// name gives.
const THEME_REGISTRY = {
  default: {
    description: 'green-to-red usage, cyan context, grey details',
    levels: [22, 28, 34, 100, 142, 178, 172, 166, 160, 124].map(ansi256),
    pace: [34, 37, 178, 208, 160, 135].map(ansi256),
    context: [CYAN, YELLOW, ansi256(160)],
    muted: GRAY,
    accent: YELLOW,
    good: GREEN,
    bad: RED,
    info: BLUE,
  },
  mono: {
    description: "no colour: the terminal's own text colour throughout",
    levels: Array(10).fill(''),
    pace: Array(6).fill(''),
    context: ['', '', ''],
    muted: '',
    accent: '',
    good: '',
    bad: '',
    info: '',
  },
  'high-contrast': {
    description: "the terminal's bright colours, and white details, for dim screens and low vision",
    levels: [92, 92, 92, 92, 93, 93, 93, 91, 91].map(bright).concat(bold(91)),
    pace: [bright(92), bright(96), bright(93), bold(93), bright(91), bright(95)],
    context: [bright(96), bright(93), bright(91)],
    muted: bright(97),
    accent: bright(93),
    good: bright(92),
    bad: bright(91),
    info: bright(94),
  },
  pastel: {
    description: 'soft 256-colour tones on the same green-to-red scale',
    levels: [157, 151, 150, 187, 229, 223, 216, 217, 210, 211].map(ansi256),
    pace: [151, 152, 229, 216, 210, 183].map(ansi256),
    context: [152, 229, 210].map(ansi256),
    muted: ansi256(248),
    accent: ansi256(229),
    good: ansi256(151),
    bad: ansi256(210),
    info: ansi256(153),
  },
} satisfies Record<string, Theme>;

const THEMES = Object.keys(THEME_REGISTRY);

// A --color value as a colour code: a name such as red or bright-red, a
// 256-colour number, or a hex colour as #f80 or #ff8800. Anything else is
// none, so a switch can never print a code of its own.
const NAMED_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function colorCode(text: string): string | undefined {
  const name = text.toLowerCase();
  if (name === 'gray' || name === 'grey') return GRAY;
  const named = NAMED_COLORS.indexOf(name.replace(/^bright-/, ''));
  if (named >= 0) return `\x1b[0;${(name.startsWith('bright-') ? 90 : 30) + named}m`;
  if (/^\d{1,3}$/.test(name) && Number(name) <= 255) return ansi256(Number(name));
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(name)?.[1];
  if (!hex) return undefined;
  const full = hex.length === 3 ? [...hex].map((d) => d + d).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m`;
}

// A theme that draws everything in one colour, for a part --color names. The
// pace marker keeps the theme's colours, because its colour is what it says.
const solid = (theme: Theme, color: string): Theme => ({
  description: theme.description,
  levels: theme.levels.map(() => color),
  pace: theme.pace,
  context: theme.context.map(() => color),
  muted: color,
  accent: color,
  good: color,
  bad: color,
  info: color,
});

// A record's own value for a key, never one it inherits, such as
// constructor: names from switches and the payload reach these lookups.
const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// The preset a --theme names, else the default.
const themeOf = (name: string): Theme => ownValue<Theme>(THEME_REGISTRY, name) ?? THEME_REGISTRY.default;

// Terminal escape sequences, whole: CSI (colours, cursor moves, erases), OSC
// (window titles, hyperlinks, the clipboard), the DCS, SOS, PM and APC
// strings, and every other ESC sequence, each in its 7-bit and 8-bit forms.
// An OSC or string left unterminated runs to the end of the text, as a
// terminal would read it.
const ESCAPE_SEQUENCE =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g;

// The control characters an escape sequence leaves behind or that act alone:
// C0, DEL, C1, and the bidirectional formatting characters that reorder text.
const CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Text from outside claude-gauge (the payload, the transcript, git), safe to
// print: nothing in it can move the cursor, change colours or reorder the
// row. claude-gauge's own colours are added around it afterwards. render
// cleans what reaches the parts through their context; a part that prints
// text from anywhere else, such as a switch or a command, calls this itself.
const sanitise = (text: string) => text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTER, '');

// Text without claude-gauge's own colour codes and OSC 8 links, the only
// escapes left in a rendered row once its parts are sanitised.
const stripOwnCodes = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '');

// A parsed payload with every string in it sanitised, at any depth.
function sanitiseAll<T>(value: T): T {
  if (typeof value === 'string') return sanitise(value) as T;
  if (Array.isArray(value)) return value.map(sanitiseAll) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitiseAll(v)])) as T;
  }
  return value;
}

// The labels --compact shortens, and their short forms. A label not named
// here is short already.
const COMPACT_LABELS: Record<string, string> = {
  ctx: 'c',
  effort: 'eff',
  style: 'sty',
  agent: 'agt',
  cache: 'cch',
  spend: 'spd',
  today: 'tdy',
  week: 'wk',
  compactions: 'cmp',
};

// A part's label and the space after it: none with --no-labels, the short
// form with --compact.
const labelOf = (config: Config, name: string) =>
  config.labels ? `${config.compact ? (COMPACT_LABELS[name] ?? name) : name} ` : '';

// The separator between a row's segments.
const separatorOf = (config: Config, theme: Theme) => `${theme.muted}${config.compact ? '│' : ' │ '}${RESET}`;

// The usage level's colour, in ten steps: in the default theme, dark green
// at 0-10% and deep red above 90%.
const levelColor = (theme: Theme, pct: number) => theme.levels[Math.min(9, Math.max(0, Math.ceil(pct / 10) - 1))];

// The pace marker's colour, by the usage the current rate projects for the
// end of the window.
const PACE_LIMITS = [50, 75, 90, 100, 120]; // comfortable, on track, warming, pressing, critical; then runaway
const paceColor = (theme: Theme, projected: number) => {
  const step = PACE_LIMITS.findIndex((limit) => projected < limit);
  return theme.pace[step < 0 ? PACE_LIMITS.length : step];
};

// A reset as a window shows it: a time of day, or days away.
type ResetText = (epochSeconds: number, config: Config, nowMs: number) => string;

interface UsageWindow {
  key: 'five_hour' | 'seven_day';
  seconds: number;
  minElapsed: number;
  resetText: ResetText;
}

const WINDOWS: Record<'5h' | '7d', UsageWindow> = {
  '5h': { key: 'five_hour', seconds: 5 * 3600, minElapsed: 540, resetText: (at, config) => formatTime(at, config) }, // 9 minutes
  '7d': { key: 'seven_day', seconds: 7 * 86400, minElapsed: 3024, resetText: (at, config, nowMs) => formatDaysOrTime(at, config, nowMs) }, // about 50 minutes
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

// A window Claude Code has reported a percentage for.
type ReportedLimit = RateLimit & { used_percentage: number };

interface StatusData {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
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
  // Per-model weekly windows arrive beside the week as seven_day_<model>,
  // such as seven_day_opus, when Claude Code sends them.
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
    spend_limit?: RateLimit;
    [key: string]: RateLimit | null | undefined;
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

// A word with its first letter in capitals: opus → Opus.
const capitalised = (word: string) => word[0].toUpperCase() + word.slice(1);

// Bars come in 5 or 10 cells; anything else falls back to 5.
const segmentsOf = (value: number | string | undefined) => (Number(value) === 10 ? 10 : 5);

// The cells of a bar, filled in proportion to pct, one character each.
const cellsFor = (pct: number, { segments, barFilled, barEmpty }: Config) => {
  const filled = Math.min(segments, Math.max(0, Math.round((pct * segments) / 100)));
  return [...Array<string>(filled).fill(barFilled), ...Array<string>(segments - filled).fill(barEmpty)];
};

// How every git call runs: for at most a second, with its output as text
// and its errors dropped.
const GIT_OPTIONS: ExecFileSyncOptionsWithStringEncoding = { timeout: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };

// A program's output, with no input and a one-second timeout. Throws when
// the program fails.
const runQuietly = (command: string, args: string[], cwd?: string) =>
  execFileSync(command, args, { cwd, timeout: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

function git(cwd: string, args: string[]): string {
  try {
    return runQuietly('git', args, cwd).trim();
  } catch {
    return ''; // not a repository, or git is missing
  }
}

// The nearest .git entry at or above a folder, read from the files rather
// than from git: the folder that holds it, and the git folder it stands for.
// Inside a linked worktree .git is a file that names the worktree's own git
// folder under the main checkout's .git/worktrees. undefined outside a
// repository. Throws where a file cannot be read.
function gitEntryAbove(cwd: string): { dir: string; gitDir: string } | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      const gitDir = fs.statSync(dotGit).isFile()
        ? path.resolve(dir, /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1].trim() ?? '.git')
        : dotGit;
      return { dir, gitDir };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// The branch HEAD names, read from the repository's files rather than from
// git: the fallback when git status takes too long, so the render never
// waits on a second git process. '' outside a repository and on a detached
// HEAD.
function headBranch(cwd: string): string {
  try {
    const entry = gitEntryAbove(cwd);
    if (!entry) return '';
    return /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(entry.gitDir, 'HEAD'), 'utf8'))?.[1].trim() ?? '';
  } catch {
    return '';
  }
}

// What `git status --porcelain=v2 --branch` prints for the folder: '' when
// it is not a repository or git is missing, and undefined when git gave no
// answer in time or printed more than a status line can use. It takes no
// optional locks, so it never blocks a git command the user runs, and the
// two settings fix its paths as relative to the folder and unquoted where
// they can be.
function gitStatus(cwd: string): string | undefined {
  try {
    return execFileSync(
      'git',
      ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'status.relativePaths=true', 'status', '--porcelain=v2', '--branch'],
      { ...GIT_OPTIONS, cwd, maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ETIMEDOUT' || code === 'ENOBUFS' ? undefined : '';
  }
}

// A changed file's last modification time; none for a deleted file. A
// symbolic link is the change, so its own time counts, not its target's, and
// a link whose target is gone still has one.
function fileMtime(file: string): number | undefined {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

// The folder's git state. Without a status only the branch is known: the
// counts stay at 0 and changed stays empty.
interface GitState {
  branch: string;
  // The branch's upstream as git names it, such as origin/main; '' when it
  // has none, or when only the branch is known.
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  deleted: number;
  untracked: number;
  // Every changed file, in git's order: its path from the folder as git
  // printed it, to read its time with, and its name to print.
  changed: { path: string; name: string }[];
}

const noChanges = (branch: string): GitState => ({ branch, upstream: '', ahead: 0, behind: 0, staged: 0, modified: 0, deleted: 0, untracked: 0, changed: [] });

// A path as git prints it, unquoted. Git quotes a path that holds a control
// character, a double quote or a backslash, C-style, with octal for bytes.
function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  const chars = [...text.slice(1, -1)];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\\' || i + 1 === chars.length) {
      bytes.push(...Buffer.from(chars[i]));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(chars.slice(i + 1, i + 4).join(''));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const next = chars[++i];
      bytes.push(...(named[next] != null ? [named[next]] : Buffer.from(next)));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// A changed file from its path as git prints it. An untracked folder's path
// ends in /, and so does its name.
function changedFile(printed: string): GitState['changed'][number] {
  const file = unquotePath(printed);
  return { path: file, name: sanitise(path.basename(file) + (file.endsWith('/') ? '/' : '')) };
}

// The fields before the path on each kind of porcelain v2 entry line:
// ordinary, renamed or copied, and unmerged.
const FIELDS_BEFORE_PATH: Record<string, number> = { '1': 8, '2': 9, u: 10 };

// The state in porcelain v2 status output. Each side of an entry counts on
// its own: a deletion on either side as deleted, any other change in the
// index as staged and in the work tree as modified. So a file staged and
// then changed or deleted again counts twice. An unmerged file counts as
// modified.
function parseStatus(output: string): GitState {
  const state = noChanges('');
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(' ');
    const [kind, key] = fields;
    if (kind === '#') {
      if (key === 'branch.head' && fields[2] !== '(detached)') state.branch = fields.slice(2).join(' ');
      if (key === 'branch.upstream') state.upstream = fields.slice(2).join(' ');
      if (key === 'branch.ab') {
        state.ahead = Math.abs(Number.parseInt(fields[2], 10)) || 0;
        state.behind = Math.abs(Number.parseInt(fields[3], 10)) || 0;
      }
    } else if (kind === '?') {
      state.untracked++;
      state.changed.push(changedFile(line.slice(2)));
    } else if (Object.hasOwn(FIELDS_BEFORE_PATH, kind)) {
      // A renamed entry ends <path>TAB<original path>; git quotes a path
      // that holds a tab, so the first tab is the separator.
      state.changed.push(changedFile(fields.slice(FIELDS_BEFORE_PATH[kind]).join(' ').split('\t')[0]));
      const [x, y] = key;
      if (kind === 'u') state.modified++;
      else {
        if (x === 'D' || y === 'D') state.deleted++;
        if (x !== '.' && x !== 'D') state.staged++;
        if (y !== '.' && y !== 'D') state.modified++;
      }
    }
  }
  return state;
}

// The folder's git state from one status call, or the branch alone, read
// from HEAD, when the status took too long.
function readGit(cwd: string, statusOf: (cwd: string) => string | undefined, branchOf: (cwd: string) => string): GitState {
  const output = statusOf(cwd);
  const state = output === undefined ? noChanges(branchOf(cwd)) : parseStatus(output);
  return { ...state, branch: sanitise(state.branch) };
}

// Reset times are rounded to the nearest minute, so 6:59:45 shows as 07:00.
const resetDate = (epochSeconds: number) => new Date(Math.round(epochSeconds / 60) * 60 * 1000);

// hourCycle, not hour12: with hour12, Node 18 and 20 put en-GB on the 0-11
// clock, so noon reads 00:00 pm. hourCycle names the clock outright.
const clockOf = (config: Config): Intl.DateTimeFormatOptions => ({
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: config.hour12 ? 'h12' : 'h23',
});

function formatTime(epochSeconds: number, config: Config): string {
  return resetDate(epochSeconds).toLocaleTimeString('en-GB', clockOf(config));
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
  theme: Theme,
  nowMs: number,
): string {
  const cells = cellsFor(pct, config);
  const remaining = resetsAt ? resetsAt - nowMs / 1000 : 0;
  if (!config.pace || remaining <= 0 || remaining >= window.seconds) return ` ${cells.join('')}`;

  const elapsed = window.seconds - remaining;
  const pos = Math.min(config.segments - 1, Math.max(0, Math.round((elapsed * config.segments) / window.seconds)));
  // Early in a window the projection is noise, so keep the usage colour. A
  // pace colour of '' (mono) resets, so the marker never takes a --color.
  const marker = elapsed >= window.minElapsed ? paceColor(theme, (pct * window.seconds) / elapsed) || (color && RESET) : color;
  return ` ${cells.slice(0, pos).join('')}${marker}┃${RESET}${color}${cells.slice(pos + 1).join('')}`;
}

// The 5h or 7d part. rate_limits is present only for claude.ai Pro and Max
// subscribers, after the first response of a session; "~" marks a window
// Claude Code has not reported yet.
function windowPart(name: '5h' | '7d', { data, config, theme, nowMs }: PartContext): string {
  const window = WINDOWS[name];
  const label = labelOf(config, name);
  const limit = data.rate_limits?.[window.key];
  if (limit?.used_percentage == null) return `${theme.accent}${label}~${RESET}`;
  return usageSegment(label, { ...limit, used_percentage: limit.used_percentage }, window, config, theme, nowMs);
}

// A reported window's percentage, bar and reset, behind its label.
function usageSegment(label: string, limit: ReportedLimit, window: UsageWindow, config: Config, theme: Theme, nowMs: number): string {
  const pct = Math.round(limit.used_percentage);
  const color = levelColor(theme, pct);
  const bar = config.bars ? usageBar(pct, color, window, limit.resets_at, config, theme, nowMs) : '';
  const reset = config.reset && limit.resets_at ? ` → ${window.resetText(limit.resets_at, config, nowMs)}` : '';
  return `${color}${label}${pct}%${bar}${reset}${RESET}`;
}

// The per-model weekly windows Claude Code reports, as seven_day_<model>
// keys, sorted by key: the model's name and the window. Keys reach the row
// unsanitised, so a name is letters, digits, underscores, dots and hyphens
// only, and a key with anything else stays out. Underscores read as spaces:
// seven_day_opus is Opus, seven_day_oauth_apps is Oauth Apps.
function modelWindows(data: StatusData): { name: string; limit: ReportedLimit }[] {
  return Object.entries(data.rate_limits ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([key, limit]) => {
      const model = /^seven_day_([a-z0-9][\w.-]*)$/i.exec(key)?.[1];
      const used = limit?.used_percentage;
      if (!model || used == null) return [];
      const name = model.split('_').filter(Boolean).map(capitalised).join(' ');
      return [{ name, limit: { ...limit, used_percentage: used } }];
    });
}

// The models part: each per-model weekly window as 7d shows the week, with
// the model's name after the 7d label. The name stays with --no-labels,
// since without it two windows read alike.
function modelsPart({ data, config, theme, nowMs }: PartContext): string {
  return modelWindows(data)
    .map(({ name, limit }) =>
      usageSegment(`${labelOf(config, '7d')}${name} `, limit, WINDOWS['7d'], config, theme, nowMs),
    )
    .join(separatorOf(config, theme));
}

// The context in the token line's shape: ctx 43% ▓▓░░░ 86.0k. Both figures
// count input only (fresh input plus cache writes and reads), as Claude
// Code's used_percentage does.
function contextPart({ data, config, theme }: PartContext): string {
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

  const color = theme.context[pct <= 50 ? 0 : pct <= 75 ? 1 : 2];
  const label = labelOf(config, 'ctx');
  const bar = config.bars ? ` ${cellsFor(pct, config).join('')}` : '';
  const count = tokens != null ? ` ${fmt(tokens)}` : '';
  return `${color}${label}${Math.round(pct)}%${bar}${count}${RESET}`;
}

// The current local time, on the same clock as the reset times.
function timePart({ config, theme, nowMs }: PartContext): string {
  const time = new Date(nowMs).toLocaleTimeString('en-GB', clockOf(config));
  return `${theme.muted}${time}${RESET}`;
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

function durationPart({ data, theme }: PartContext): string {
  const ms = data.cost?.total_duration_ms;
  return ms != null ? `${theme.muted}${formatDuration(ms)}${RESET}` : '';
}

// The session's estimated cost. Behind a spend limit it takes the usage
// colour of the limit's percentage; otherwise it is plain metadata.
function costPart({ data, theme }: PartContext): string {
  const usd = data.cost?.total_cost_usd;
  if (usd == null) return '';
  const spent = data.rate_limits?.spend_limit?.used_percentage;
  const color = spent != null ? levelColor(theme, Math.round(spent)) : theme.muted;
  return `${color}$${usd.toFixed(2)}${RESET}`;
}

function linesPart({ data, theme }: PartContext): string {
  const added = data.cost?.total_lines_added;
  const removed = data.cost?.total_lines_removed;
  if (added == null && removed == null) return '';
  return `${theme.good}+${added ?? 0}${RESET} ${theme.bad}−${removed ?? 0}${RESET}`;
}

// Text cut to at most chars characters, ending in … when it was cut. It counts
// code points, so a cut never splits an emoji in two.
const cut = (text: string, chars: number) => {
  const points = [...text];
  return points.length <= chars ? text : `${points.slice(0, chars - 1).join('')}…`;
};

// The session's custom name or AI-generated title, cut to 30 characters.
function namePart({ data, theme }: PartContext): string {
  const name = data.session_name;
  if (!name) return '';
  const shown = cut(name, 30);
  return `${theme.muted}${shown}${RESET}`;
}

// Model state, in the model's colour, yellow by default. effort is labelled
// because "high" on its own could mean anything; thinking and fast are their
// own label and show only when on; style shows only when it is not the
// default.
function effortPart({ data, config, theme }: PartContext): string {
  const level = data.effort?.level;
  return level ? `${theme.accent}${labelOf(config, 'effort')}${level}${RESET}` : '';
}

function thinkingPart({ data, theme }: PartContext): string {
  return data.thinking?.enabled ? `${theme.accent}think${RESET}` : '';
}

function fastPart({ data, theme }: PartContext): string {
  return data.fast_mode ? `${theme.accent}fast${RESET}` : '';
}

function stylePart({ data, config, theme }: PartContext): string {
  const name = data.output_style?.name;
  if (!name || name === 'default') return '';
  return `${theme.muted}${labelOf(config, 'style')}${name}${RESET}`;
}

// The repository as owner/name from the origin remote. Without one (outside
// git, or no origin) it falls back to the folder name, so a row that leads
// with repo never loses its location.
function repoPart({ data, theme, folder }: PartContext): string {
  const repo = data.workspace?.repo;
  const shown = repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : folder;
  return `${theme.muted}${shown}${RESET}`;
}

// The folder Claude Code runs in as a file URL that names its machine, as
// the OSC 8 spec asks, so a terminal can tell a folder on a remote machine
// from a local one. dir and repo both link to it.
function folderUrl({ cwd, hostname }: PartContext): string | undefined {
  try {
    return `file://${hostname}${pathToFileURL(cwd).pathname}`;
  } catch {
    return undefined;
  }
}

// The linked git worktree the session is in, if any. workspace.git_worktree
// covers every linked worktree; worktree.name only Claude Code's own
// worktree sessions.
const worktreeName = (data: StatusData) => data.workspace?.git_worktree || data.worktree?.name || '';

// The path to a branch's page from a repository's page, on each host whose
// addresses are known.
const BRANCH_PAGES: Record<string, string> = { 'github.com': '/tree/', 'gitlab.com': '/-/tree/' };

// The branch's page on GitHub or GitLab, by the name its upstream has on
// origin, the remote the repo comes from. Unknown without an upstream on
// origin, since the branch may not be on the remote, and on any other host.
function branchUrl(repo: NonNullable<StatusData['workspace']>['repo'], upstream: string): string | undefined {
  const { host, owner, name } = repo ?? {};
  if (typeof host !== 'string' || typeof owner !== 'string' || typeof name !== 'string' || !owner || !name) return undefined;
  const forge = host.toLowerCase();
  const page = ownValue(BRANCH_PAGES, forge);
  const branch = /^origin\/(.+)$/.exec(upstream)?.[1];
  if (!page || !branch) return undefined;
  // Each name between slashes percent-encoded, the slashes kept: a GitLab
  // group and a branch name may both hold them.
  const encoded = (text: string) => text.split('/').map(encodeURIComponent).join('/');
  try {
    return `https://${forge}/${encoded(owner)}/${encoded(name)}${page}${encoded(branch)}`;
  } catch {
    return undefined; // text that is not valid UTF-16
  }
}

// The branch, * when the work tree has changes, ↑n and ↓n for the commits
// it is ahead of and behind its upstream, and the worktree name inside a
// linked worktree.
function branchPart({ data, config, theme, git: gitOf }: PartContext): string {
  const git = gitOf();
  if (!git.branch) return '';
  const dirty = git.changed.length ? `${theme.accent}*${theme.good}` : '';
  const ahead = git.ahead ? ` ↑${git.ahead}` : '';
  const behind = git.behind ? ` ↓${git.behind}` : '';
  const wt = worktreeName(data);
  const inWorktree = wt ? ` (${labelOf(config, 'wt')}${wt})` : '';
  return `${theme.good}⎇ ${git.branch}${dirty}${ahead}${behind}${inWorktree}${RESET}`;
}

// The work tree's changes, as counts: !modified +staged ✘deleted ?untracked.
// Only counts above 0 show, and nothing shows when the tree is clean.
function gitCountsPart({ theme, git: gitOf }: PartContext): string {
  const git = gitOf();
  const counts: [number, string, string][] = [
    [git.modified, '!', theme.accent],
    [git.staged, '+', theme.good],
    [git.deleted, '✘', theme.bad],
    [git.untracked, '?', theme.muted],
  ];
  return counts
    .filter(([n]) => n > 0)
    .map(([n, mark, color]) => `${color}${mark}${n}${RESET}`)
    .join(' ');
}

// The changed files the files part names, at most.
const RECENT_FILES = 3;

// The changed files whose times the files part reads, at most, so a huge
// change set costs a bounded number of reads.
const TIMED_FILES = 1000;

// The most recently changed files, newest first, of the first TIMED_FILES
// that git lists. A deleted file has no time, so it follows the files that
// have one; files with the same time keep git's order.
function filesPart({ theme, git: gitOf, mtimeOf }: PartContext): string {
  return gitOf().changed
    .slice(0, TIMED_FILES)
    .map((file) => ({ ...file, time: mtimeOf(file.path) ?? -Infinity }))
    .sort((a, b) => b.time - a.time || 0)
    .slice(0, RECENT_FILES)
    .map((file) => `${theme.muted}${file.name}${RESET}`)
    .join(' ');
}

function worktreePart({ data, config, theme }: PartContext): string {
  const wt = worktreeName(data);
  return wt ? `${theme.muted}${labelOf(config, 'wt')}${wt}${RESET}` : '';
}

// The branch's open pull request, coloured by its review state. A GitLab
// merge request takes GitLab's ! prefix instead of #.
// The theme's roles that hold one colour.
type Role = { [K in keyof Theme]: Theme[K] extends string ? K : never }[Exclude<keyof Theme, 'description'>];

const PR_ROLES: Record<string, Role> = { approved: 'good', pending: 'accent', changes_requested: 'bad', draft: 'muted' };

function prPart({ data, theme }: PartContext): string {
  const pr = data.pr;
  if (pr?.number == null) return '';
  const number = `${pr.kind === 'mr' ? '!' : '#'}${pr.number}`;
  const state = pr.review_state ? ` ${pr.review_state}` : '';
  return `${theme[ownValue(PR_ROLES, pr.review_state ?? '') ?? 'muted']}${number}${state}${RESET}`;
}

// A web page's address as a link can carry it: http or https only, with
// every character outside ASCII percent-encoded. The payload is JSON from
// outside, so the address may not be text at all.
function webUrl(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function agentPart({ data, config, theme }: PartContext): string {
  const name = data.agent?.name;
  return name ? `${theme.muted}${labelOf(config, 'agent')}${name}${RESET}` : '';
}

// The prompt cache's hit ratio and whether it is still warm. A high hit
// ratio is good, so the colour follows the miss rate on the usage scale.
function cachePart({ data, config, theme }: PartContext): string {
  const cache = data.prompt_cache;
  if (!cache) return '';
  const label = labelOf(config, 'cache');
  const state = cache.warm ? 'warm' : 'cold';
  if (cache.hit_ratio == null) return `${theme.muted}${label}${state}${RESET}`;
  const hit = Math.round(cache.hit_ratio * 100);
  return `${levelColor(theme, 100 - hit)}${label}${hit}% ${state}${RESET}`;
}

// The spend limit behind a Claude apps gateway: dollars when Claude Code has
// them, which arrive a little after the percentage, and the percentage until
// then.
function spendPart({ data, config, theme }: PartContext): string {
  const limit = data.rate_limits?.spend_limit;
  if (limit?.used_percentage == null) return '';
  const color = levelColor(theme, Math.round(limit.used_percentage));
  if (limit.used_usd != null && limit.limit_usd != null) {
    return `${color}$${Math.round(limit.used_usd)}/$${Math.round(limit.limit_usd)}${RESET}`;
  }
  return `${color}${labelOf(config, 'spend')}${Math.round(limit.used_percentage)}%${RESET}`;
}

// The API provider when requests do not go to the first-party API, from the
// variables that select it: Bedrock (with its Mantle endpoint), Vertex,
// Foundry, Claude Platform on AWS, or a gateway at a base URL of its own.
// Claude Code reads these switches as on for 1, true, yes or on.
const isOn = (value: string | undefined) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');

function providerOf(env: Env): string {
  if (isOn(env.CLAUDE_CODE_USE_BEDROCK) || isOn(env.CLAUDE_CODE_USE_MANTLE)) return 'Bedrock';
  if (isOn(env.CLAUDE_CODE_USE_VERTEX)) return 'Vertex';
  if (isOn(env.CLAUDE_CODE_USE_FOUNDRY)) return 'Foundry';
  if (isOn(env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return 'AWS';
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return '';
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    /* not a URL: still not the first-party API */
  }
  return host === 'api.anthropic.com' ? '' : 'Enterprise';
}

// The model, with the provider after it: Opus 5.5 (Bedrock).
function modelPart({ data, theme, processEnv: env }: PartContext): string {
  const name = data.model?.display_name;
  if (!name) return '';
  const provider = providerOf(env);
  return `${theme.accent}${name}${provider ? ` (${provider})` : ''}${RESET}`;
}

// A count and what it counts, one or many: 1 rule, 4 rules.
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The kinds env counts, in order, and the words for one and for many.
const ENV_KINDS: ['claudeMd' | 'rules' | 'mcp' | 'hooks', string, string][] = [
  ['claudeMd', 'md', 'md'],
  ['rules', 'rule', 'rules'],
  ['mcp', 'mcp', 'mcp'],
  ['hooks', 'hook', 'hooks'],
];

// What the session loads, kind by kind, leaving out a kind with none.
function envPart({ config, theme, setup: setupOf }: PartContext): string {
  const setup = setupOf();
  const counts = ENV_KINDS.filter(([kind]) => setup[kind]).map(([kind, one, many]) => counted(setup[kind], one, many));
  return counts.length ? `${theme.muted}${labelOf(config, 'env')}${counts.join(' ')}${RESET}` : '';
}

// The plan, with the signed-in user after it: Claude Max 20x (me@example.com).
function planPart({ theme, setup: setupOf }: PartContext): string {
  const { plan, user } = setupOf();
  const shown = plan && user ? `${plan} (${user})` : plan || user;
  return shown ? `${theme.muted}${shown}${RESET}` : '';
}

// The limit part: every window at 100% or more, by its full name (5h, 7d,
// 7d Opus, spend) with or without --no-labels, since a notice that names no
// window says nothing. A reset shows as its window's part shows it. The
// spend part shows none, so a spend reset, when Claude Code sends one, shows
// as days or a time of day, as the weekly resets do.
function limitPart({ data, config, theme, nowMs }: PartContext): string {
  const limits = data.rate_limits ?? {};
  const windows: [string, RateLimit | null | undefined, ResetText][] = [
    ['5h', limits.five_hour, WINDOWS['5h'].resetText],
    ['7d', limits.seven_day, WINDOWS['7d'].resetText],
    ...modelWindows(data).map(({ name, limit }): [string, RateLimit, ResetText] => [`7d ${name}`, limit, WINDOWS['7d'].resetText]),
    ['spend', limits.spend_limit, formatDaysOrTime],
  ];
  const reached = windows
    .filter(([, limit]) => (limit?.used_percentage ?? 0) >= 100)
    .map(([name, limit, resetText]) =>
      config.reset && limit?.resets_at ? `${name} → ${resetText(limit.resets_at, config, nowMs)}` : name,
    );
  return reached.length ? `${theme.levels[9]}limit reached: ${reached.join(', ')}${RESET}` : '';
}

// Bytes in gibibytes, as the OS monitors count them: 0.4G, 10.5G, 120G.
const gib = (bytes: number) => {
  const n = bytes / 1024 ** 3;
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)}G`;
};

// The memory in use in the ctx part's shape: ram 66% ▓▓▓░░ 10.5G, on the
// usage colours.
function ramPart({ config, theme, memory: memoryOf }: PartContext): string {
  const memory = memoryOf();
  if (!memory) return '';
  const pct = (memory.used * 100) / memory.total;
  const bar = config.bars ? ` ${cellsFor(pct, config).join('')}` : '';
  return `${levelColor(theme, Math.round(pct))}${labelOf(config, 'ram')}${Math.round(pct)}%${bar} ${gib(memory.used)}${RESET}`;
}

// The text and command parts: text from --text or from the command's
// output. Neither comes through render's sanitised payload, so the part
// sanitises it here.
function outsideText(raw: string, theme: Theme): string {
  const text = sanitise(raw);
  return text ? `${theme.muted}${text}${RESET}` : '';
}

function textPart({ config, theme }: PartContext): string {
  return outsideText(config.text, theme);
}

function commandPart({ theme, commandOutput: commandOutputOf }: PartContext): string {
  return outsideText(commandOutputOf(), theme);
}

function versionPart({ data, theme }: PartContext): string {
  return data.version ? `${theme.muted}v${data.version}${RESET}` : '';
}

// The cost ledger: what every session has spent, by local day, kept in the
// state folder so that the today and week parts can add up spend across
// sessions. Each session's cost as last recorded is kept too, so a render
// records only what the session has spent since.
interface Ledger {
  // Spend in dollars, by local day as YYYY-MM-DD.
  days: Record<string, number>;
  // Each session's total cost when it was last recorded, and when that was.
  sessions: Record<string, { usd: number; at: number }>;
}

// A ledger from whatever the file held: its two tables where they are
// objects, else empty ones. The tables have no prototype, so a session id
// such as __proto__ is a key like any other.
function ledgerFrom(value: unknown): Ledger {
  const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v);
  const table = (v: unknown) => Object.assign(Object.create(null), isObject(v) ? v : {});
  const { days, sessions } = (isObject(value) ? value : {}) as Partial<Ledger>;
  return { days: table(days), sessions: table(sessions) };
}

// A number from a file or a reader outside claude-gauge's control, such as a
// ledger value or a transcript counter, or undefined when it is not a finite
// one.
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

// A local day as the ledger keys it.
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// What the session has spent since the ledger last recorded it: all of its
// cost when the ledger has not seen it, or when its cost fell, which means it
// started again from zero.
function unrecorded(ledger: Ledger, data: StatusData): number {
  const usd = finite(data.cost?.total_cost_usd);
  if (usd === undefined) return 0;
  const recorded = data.session_id ? finite(ledger.sessions[data.session_id]?.usd) : undefined;
  return recorded === undefined || usd < recorded ? usd : usd - recorded;
}

// The spans the today and week parts add up, each named as its part.
type Period = 'today' | 'week';

// The local days a period covers, newest first: today alone, or each day
// back to Monday.
function periodDays(period: Period, nowMs: number): string[] {
  const now = new Date(nowMs);
  const count = period === 'today' ? 1 : ((now.getDay() + 6) % 7) + 1;
  return Array.from({ length: count }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime()));
}

// Spend across sessions for today or this week: what the ledger holds for
// those days, and what this session has spent since it was last recorded.
// Nothing shows when neither has anything to add.
function spentPart(period: Period, { data, config, theme, nowMs, ledger }: PartContext): string {
  const byDay = periodDays(period, nowMs).map((day) => finite(ledger.days[day]));
  const known = byDay.some((usd) => usd !== undefined) || finite(data.cost?.total_cost_usd) !== undefined;
  if (!known) return '';
  const usd = byDay.reduce<number>((sum, day) => sum + (day ?? 0), 0) + unrecorded(ledger, data);
  return `${theme.muted}${labelOf(config, period)}$${usd.toFixed(2)}${RESET}`;
}

// The tools part shows the completed tools used most, up to this many, and
// cuts a target to this many characters.
const TOOLS_SHOWN = 5;
const TARGET_CHARS = 30;

// Tools whose target is a file: a cut keeps the end, where its name is.
const FILE_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

// A tool's target as the part prints it: a path inside the folder Claude
// Code runs in made relative to it, then cut to TARGET_CHARS.
function shortTarget(name: string, target: string, cwd: string): string {
  const relative = path.isAbsolute(target) ? path.relative(cwd, target) : '';
  const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
  if (shown.length <= TARGET_CHARS) return shown;
  return FILE_TOOLS.includes(name) ? `…${shown.slice(-(TARGET_CHARS - 1))}` : cut(shown, TARGET_CHARS);
}

// The tool running now, with its target, then the completed tools used most,
// with counts: ◐ Edit src/a.ts ✓ Read ×12 ✓ Bash ×3.
function toolsPart({ theme, cwd, activity: activityOf }: PartContext): string {
  const { running, completed } = activityOf().tools;
  const items: string[] = [];
  const now = running.at(-1);
  if (now) items.push(`${theme.accent}◐ ${now.name}${now.target ? ` ${shortTarget(now.name, now.target, cwd)}` : ''}${RESET}`);
  const done = Object.entries(completed)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOOLS_SHOWN);
  for (const [name, count] of done) items.push(`${theme.good}✓${RESET} ${theme.muted}${name} ×${count}${RESET}`);
  return items.join(' ');
}

// The agents part shows this many subagents, those running first, and keeps
// a finished one for AGENT_LINGER_MS. A description is cut to DESCRIPTION_CHARS.
const AGENTS_SHOWN = 3;
const AGENT_LINGER_MS = 60_000;
const DESCRIPTION_CHARS = 30;

// One subagent: ◐ Explore (Haiku 4.5) Find the config loader 1m while it
// runs, ✓ when it finished, ✗ when it failed or was stopped.
function agentItem(agent: AgentRun, theme: Theme, nowMs: number): string {
  const model = agent.model ? ` (${agent.model})` : '';
  const description = agent.description ? ` ${cut(agent.description, DESCRIPTION_CHARS)}` : '';
  const elapsed = agent.startedAt !== undefined ? ` ${formatDuration(Math.max(0, (agent.endedAt ?? nowMs) - agent.startedAt))}` : '';
  const text = `${agent.type}${model}${description}${elapsed}`;
  if (agent.endedAt === undefined) return `${theme.accent}◐ ${text}${RESET}`;
  return `${agent.failed ? `${theme.bad}✗` : `${theme.good}✓`}${RESET} ${theme.muted}${text}${RESET}`;
}

// The subagents running now, oldest first, then those finished in the last
// AGENT_LINGER_MS, newest first, up to AGENTS_SHOWN in all.
function agentsPart({ theme, nowMs, activity: activityOf }: PartContext): string {
  const { agents } = activityOf();
  const running = agents.filter((a) => a.endedAt === undefined);
  const finished = agents
    .filter((a): a is AgentRun & { endedAt: number } => a.endedAt !== undefined && nowMs - a.endedAt < AGENT_LINGER_MS)
    .sort((a, b) => b.endedAt - a.endedAt);
  return [...running, ...finished]
    .slice(0, AGENTS_SHOWN)
    .map((a) => agentItem(a, theme, nowMs))
    .join(' ');
}

// The todo in progress, by the form Claude Code shows while it runs, then
// how many todos are done: ◐ Writing the tests 1/3. With none in progress,
// todos 1/3, and ✓ todos 3/3 once all are done.
function todosPart({ config, theme, activity: activityOf }: PartContext): string {
  const { todos } = activityOf();
  if (!todos.length) return '';
  const done = todos.filter((t) => t.status === 'completed').length;
  const count = `${done}/${todos.length}`;
  const now = todos.find((t) => t.status === 'in_progress');
  if (now) return `${theme.accent}◐ ${cut(now.activeForm || now.content, DESCRIPTION_CHARS)}${RESET} ${theme.muted}${count}${RESET}`;
  const text = `${theme.muted}${labelOf(config, 'todos')}${count}${RESET}`;
  return done === todos.length ? `${theme.good}✓${RESET} ${text}` : text;
}

// The skills part shows this many skills and this many MCP servers, and
// every server whose latest call failed. A name is cut to DESCRIPTION_CHARS.
const SKILLS_PART_SHOWN = 3;

// The skills used, newest first, then the MCP servers called, those whose
// latest call failed first: skills tdd code-review mcp ✗ linear github.
function skillsPart({ config, theme, activity: activityOf }: PartContext): string {
  const activity = activityOf();
  // The skills, then the servers, each with its label: none when it has nothing.
  const sections: string[] = [];
  const section = (label: string, items: string[]) => {
    if (items.length) sections.push(`${theme.muted}${labelOf(config, label)}${RESET}${items.join(' ')}`);
  };
  const skills = [...activity.skills].reverse().slice(0, SKILLS_PART_SHOWN);
  section('skills', skills.map((s) => `${theme.muted}${cut(s, DESCRIPTION_CHARS)}${RESET}`));
  const newest = [...activity.mcp].reverse();
  const failing = newest.filter((s) => s.failed);
  const working = newest.filter((s) => !s.failed).slice(0, Math.max(0, SKILLS_PART_SHOWN - failing.length));
  section('mcp', [
    ...failing.map((s) => `${theme.bad}✗ ${cut(s.name, DESCRIPTION_CHARS)}${RESET}`),
    ...working.map((s) => `${theme.muted}${cut(s.name, DESCRIPTION_CHARS)}${RESET}`),
  ]);
  return sections.join(' ');
}

// How many times the conversation was compacted: compactions 2. Nothing
// before the first.
function compactionsPart({ config, theme, activity: activityOf }: PartContext): string {
  const { compactions } = activityOf();
  return compactions > 0 ? `${theme.muted}${labelOf(config, 'compactions')}${compactions}${RESET}` : '';
}

// The time since Claude last replied: reply 3m ago. A reply stamped ahead of
// this machine's clock counts as just now.
function replyPart({ config, theme, nowMs, activity: activityOf }: PartContext): string {
  const { lastReplyAt } = activityOf();
  if (lastReplyAt === undefined) return '';
  return `${theme.muted}${labelOf(config, 'reply')}${formatDuration(Math.max(0, nowMs - lastReplyAt))} ago${RESET}`;
}

// The output speed of the last response: 84 tok/s, or 6.3 tok/s below ten.
function speedPart({ theme, activity: activityOf }: PartContext): string {
  const { speed } = activityOf();
  if (speed === undefined) return '';
  return `${theme.muted}${speed < 10 ? speed.toFixed(1) : Math.round(speed)} tok/s${RESET}`;
}

// env and plan: what Claude Code loads into a session, and the account, read
// from the files it reads them from. Only local files, never the network or
// the macOS Keychain, and a file that is missing or not JSON counts as empty.

interface SetupOptions {
  env?: Env;
  home?: string;
  // The OS, as process.platform names it.
  platform?: string;
  // The folder of the managed policy files an administrator installs.
  managedDir?: string;
}

const MANAGED_DIRS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
};
const managedDirOf = (platform: string) => MANAGED_DIRS[platform] ?? '/etc/claude-code';

// Claude Code's config folder, and the .claude.json beside or inside it.
const configDirOf = (env: Env, home: string) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const claudeJsonOf = (env: Env, home: string) =>
  env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');

// A JSON object from a file, or {} when the file is missing or holds anything
// else.
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

function readJson(file: string): JsonObject {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

const objectAt = (value: unknown, key: string): JsonObject => (isObject(value) && isObject(value[key]) ? value[key] : {});
const stringAt = (value: unknown, key: string): string | undefined => {
  const field = isObject(value) ? value[key] : undefined;
  return typeof field === 'string' && field ? field : undefined;
};
const listAt = (value: unknown, key: string): unknown[] => {
  const field = isObject(value) ? value[key] : undefined;
  return Array.isArray(field) ? field : [];
};

const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// The .md files under a folder, at any depth.
function markdownUnder(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return markdownUnder(file);
    return e.name.endsWith('.md') && isFile(file) ? [file] : [];
  });
}

// A folder and every folder above it, from the root down.
function foldersDownTo(cwd: string): string[] {
  const folders: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    folders.unshift(dir);
    if (path.dirname(dir) === dir) return folders;
  }
}

// The folder Claude Code reads .claude/settings.local.json from: the root of
// the git repository the launch folder is in, and inside a linked worktree
// the main checkout's root, the folder above the .git folder the worktree's
// .git file names. The launch folder itself outside a repository, where the
// root is the home folder, on Windows, and where the root, its .git entry or
// its .claude folder is not the current user's.
function localSettingsDir(project: string, home: string, platform: string): string {
  if (platform === 'win32') return project;
  try {
    const entry = gitEntryAbove(project);
    if (!entry) return project;
    // A worktree's git folder is <main>/.git/worktrees/<name>.
    const worktrees = path.dirname(entry.gitDir);
    const linked = entry.gitDir !== path.join(entry.dir, '.git') && path.basename(worktrees) === 'worktrees' && path.basename(path.dirname(worktrees)) === '.git';
    const root = linked ? path.dirname(path.dirname(worktrees)) : entry.dir;
    if (root === path.resolve(home)) return project;
    const uid = process.getuid?.();
    if (uid !== undefined) {
      for (const owned of [root, path.join(root, '.git'), path.join(root, '.claude')]) {
        if (fs.existsSync(owned) && fs.statSync(owned).uid !== uid) return project;
      }
    }
    return root;
  } catch {
    return project;
  }
}

// Hook handlers in a settings file: one per command in each matcher group.
const hooksIn = (settings: JsonObject) =>
  Object.values(objectAt(settings, 'hooks')).reduce<number>(
    (n, groups) => n + (Array.isArray(groups) ? groups.reduce<number>((m, group) => m + listAt(group, 'hooks').length, 0) : 0),
    0,
  );

// claude.ai plan names from a subscription type and a rate-limit tier: max
// with the default_claude_max_20x tier is Claude Max 20x, pro is Claude Pro.
function planName(type: string | undefined, tier: string | undefined): string | undefined {
  if (!type) return undefined;
  const multiple = /_(\d+x)$/.exec(tier ?? '')?.[1];
  return ['Claude', capitalised(type), multiple].filter(Boolean).join(' ');
}

function readSetup(
  cwd: string,
  { env = process.env, home = os.homedir(), platform = process.platform, managedDir = managedDirOf(platform) }: SetupOptions = {},
): Setup {
  const config = configDirOf(env, home);
  const project = path.resolve(cwd);
  const folders = foldersDownTo(project);

  // CLAUDE.md files load from the managed folder, the user's config, and the
  // project and every folder above it. A path counts once, so the user's file
  // is not counted again as the home folder's .claude/CLAUDE.md.
  const claudeMd = new Set(
    [
      path.join(managedDir, 'CLAUDE.md'),
      path.join(config, 'CLAUDE.md'),
      ...folders.flatMap((dir) => ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'].map((f) => path.join(dir, f))),
    ].filter(isFile),
  );
  const rules = new Set([config, ...folders.map((dir) => path.join(dir, '.claude'))].flatMap((dir) => markdownUnder(path.join(dir, 'rules'))));

  // Settings: user, project, local and managed. Each may hold hooks, and
  // the names of project MCP servers turned off. The local file is the
  // repository root's; one in the launch folder under it is read too, and
  // the root's value applies where both set a key.
  const localDir = localSettingsDir(project, home, platform);
  const localIn = (dir: string) => readJson(path.join(dir, '.claude', 'settings.local.json'));
  const local = localDir === project ? localIn(project) : { ...localIn(project), ...localIn(localDir) };
  const settings = [
    path.join(config, 'settings.json'),
    path.join(project, '.claude', 'settings.json'),
    path.join(managedDir, 'managed-settings.json'),
  ]
    .filter((file, i, all) => all.indexOf(file) === i)
    .map(readJson)
    .concat(local);

  // MCP servers: user and local scope in .claude.json, the project's
  // .mcp.json and the managed file, each name once, less the project servers
  // turned off.
  const claudeJson = readJson(claudeJsonOf(env, home));
  const localScope = objectAt(objectAt(claudeJson, 'projects'), project);
  const turnedOff = new Set([...settings, localScope].flatMap((s) => listAt(s, 'disabledMcpjsonServers')));
  const projectServers = Object.keys(objectAt(readJson(path.join(project, '.mcp.json')), 'mcpServers')).filter((name) => !turnedOff.has(name));
  const mcp = new Set([
    ...Object.keys(objectAt(claudeJson, 'mcpServers')),
    ...Object.keys(objectAt(localScope, 'mcpServers')),
    ...projectServers,
    ...Object.keys(objectAt(readJson(path.join(managedDir, 'managed-mcp.json')), 'mcpServers')),
  ]);
  for (const name of listAt(localScope, 'disabledMcpServers')) if (typeof name === 'string') mcp.delete(name);

  // The plan from the login's subscription fields where they are in a file,
  // else from the account Claude Code keeps in .claude.json, as on macOS,
  // where the login is in the Keychain, which this does not read. Only the
  // plan fields are taken from the credentials file.
  const oauth = objectAt(readJson(path.join(config, '.credentials.json')), 'claudeAiOauth');
  const account = objectAt(claudeJson, 'oauthAccount');
  const plan =
    planName(stringAt(oauth, 'subscriptionType'), stringAt(oauth, 'rateLimitTier')) ??
    planName(/^claude_(\w+)$/.exec(stringAt(account, 'organizationType') ?? '')?.[1], stringAt(account, 'organizationRateLimitTier'));
  const user = stringAt(account, 'emailAddress');

  return {
    claudeMd: claudeMd.size,
    rules: rules.size,
    mcp: mcp.size,
    hooks: settings.reduce((n, s) => n + hooksIn(s), 0),
    ...(plan ? { plan } : {}),
    ...(user ? { user } : {}),
  };
}

// ram: the system's memory in use, in bytes, read the way each OS's own
// monitor reads it. Only local figures, from Node, a file or one short
// command.
interface Memory {
  used: number;
  total: number;
}

// Where readMemory reads from, for tests to replace: the OS, Node's figures,
// a file reader and a command runner.
interface MemorySources {
  platform?: string;
  totalmem?: () => number;
  freemem?: () => number;
  readFile?: (file: string) => string;
  run?: (command: string, args: string[]) => string;
}

// A number after a name in text such as /proc/meminfo or vm_stat's output.
const figureAfter = (text: string, name: string): number | undefined => {
  const m = new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : undefined;
};

// Memory in use, or undefined when the total is unknown. Linux counts what
// is not MemAvailable as used, so the page cache the kernel gives back on
// demand stays out. macOS counts app memory, wired and compressed pages from
// vm_stat, as Activity Monitor does, because Node's free figure there leaves
// out the inactive pages and reads close to full. Windows, and any OS or
// reading that fails, take Node's figures, which on Windows are the
// available memory already.
function readMemory({
  platform = process.platform,
  totalmem = os.totalmem,
  freemem = os.freemem,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  run = runQuietly,
}: MemorySources = {}): Memory | undefined {
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  let reading: Memory | undefined;
  if (platform === 'linux') {
    const meminfo = attempt(() => readFile('/proc/meminfo')) ?? '';
    const total = figureAfter(meminfo, 'MemTotal');
    const available = figureAfter(meminfo, 'MemAvailable');
    if (total && available != null) reading = { used: (total - available) * 1024, total: total * 1024 };
  } else if (platform === 'darwin') {
    const vmStat = attempt(() => run('vm_stat', [])) ?? '';
    const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
    const anonymous = figureAfter(vmStat, 'Anonymous pages');
    const wired = figureAfter(vmStat, 'Pages wired down');
    const compressed = figureAfter(vmStat, 'Pages occupied by compressor') ?? 0;
    const purgeable = figureAfter(vmStat, 'Pages purgeable') ?? 0;
    const total = attempt(totalmem) ?? 0;
    if (pageSize && anonymous != null && wired != null && total) {
      reading = { used: (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize, total };
    }
  }
  if (!reading) {
    const total = attempt(totalmem) ?? 0;
    const free = attempt(freemem) ?? 0;
    if (total > 0) reading = { used: total - free, total };
  }
  return reading && { used: Math.min(reading.total, Math.max(0, reading.used)), total: reading.total };
}

// command: the one part that runs a command the user names. It runs only
// when --command names one and a row shows the part, in the folder Claude
// Code runs in, with no input. It has COMMAND_TIMEOUT_MS to finish, and is
// then killed, so a slow or hung command costs the status line that long and
// no longer. Its output is cut to the first line with text in it, and
// capped at MAX_COMMAND_OUTPUT bytes; failure, a timeout or empty output
// shows nothing.
const COMMAND_TIMEOUT_MS = 500;
const MAX_COMMAND_OUTPUT = 64 * 1024;

function runCommand(command: string, cwd: string): string {
  // Outside Windows the shell leads a process group of its own, so that
  // whatever the command starts can be stopped with it.
  // Node 18 and Bun take detached in spawnSync, though Node's types list it
  // for spawn only.
  const grouped = process.platform !== 'win32';
  const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    shell: true,
    detached: grouped,
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COMMAND_OUTPUT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  };
  const result = spawnSync(command, options);
  // The timeout kills the shell alone, and a job it put in the background
  // outlives it, so stop the whole group, finished or not.
  if (grouped && result.pid) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {
      /* the group has exited already */
    }
  }
  // Failed, timed out, too much output, or no such folder.
  if (result.error || result.status !== 0) return '';
  // The first line with text left once sanitised, so a line of control codes
  // alone does not hide the line after it. The part sanitises what it shows.
  return result.stdout.split(/\r?\n/).find((line) => sanitise(line).trim())?.trim() ?? '';
}

interface RenderOptions {
  config?: Overrides;
  nowMs?: number;
  // The git readers: the status output (see gitStatus), the branch alone
  // for when the status gives no answer in time, and a file's modification
  // time.
  statusOf?: (cwd: string) => string | undefined;
  // The cost ledger, as read from the state folder.
  ledger?: Ledger;
  branchOf?: (cwd: string) => string;
  mtimeOf?: (file: string) => number | undefined;
  env?: Env;
  setupOf?: (cwd: string) => Setup;
  memoryOf?: () => Memory | undefined;
  commandOutputOf?: (command: string, cwd: string) => string;
  // The terminal's width in columns, when it is known.
  columns?: number;
  // The machine's name, for the folder's file URL.
  hostname?: string;
  // Reads what a transcript shows; by default incrementally, with its state
  // in the state folder.
  transcript?: (file: string) => TranscriptActivity;
}

// A terminal width, from render's option or the text of COLUMNS, which
// Claude Code sets for the status line command; unknown unless it is a whole
// number above 0.
const columnsOf = (value: number | string | undefined): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

// Characters that take exactly one terminal column: printable Latin,
// Greek and Cyrillic, and the punctuation, arrows, maths signs, box drawing,
// blocks and the git part's ✘ that claude-gauge draws with. CJK and emoji
// take two in most terminals and combining marks none, so they are left out.
const ONE_COLUMN = /^[\x20-\x7e\u00a0-\u02ff\u0370-\u0482\u048a-\u052f\u2010-\u2027\u2030-\u205e\u2190-\u22ff\u2387\u2500-\u259f\u2718]*$/;

// The columns a rendered text takes, or undefined when some character in it
// may take more or less than one.
const visibleWidth = (text: string): number | undefined => {
  const shown = stripOwnCodes(text);
  return ONE_COLUMN.test(shown) ? [...shown].length : undefined;
};

// An address a link can carry: printable ASCII only, as OSC 8 requires, so
// nothing in it can end the sequence early or reach the terminal as a code.
const LINKABLE = /^[\x21-\x7e]+$/;

// Text as an OSC 8 hyperlink. BEL ends each sequence, as in the example in
// Claude Code's status line docs. A terminal without OSC 8 shows the text.
const hyperlink = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

// A part a row shows: its name and what it printed.
interface ShownPart {
  part: string;
  text: string;
}

// A row's shown parts joined by the separator. With a known width, the parts
// named in right move to the end of the row, in row order, and spaces fill
// the gap so the row ends at the terminal's edge. A row with none of those
// parts, with text of uncertain width, or with too little room for a gap as
// wide as the separator, is left as it is.
function joinRow(shown: ShownPart[], separator: string, right: readonly string[], columns: number | undefined): string {
  const join = (parts: ShownPart[]) => parts.map((p) => p.text).join(separator);
  const atEnd = shown.filter((p) => right.includes(p.part));
  if (columns === undefined || !atEnd.length) return join(shown);
  const left = join(shown.filter((p) => !atEnd.includes(p)));
  const end = join(atEnd);
  const [leftWidth, endWidth, separatorWidth] = [left, end, separator].map(visibleWidth);
  if (leftWidth === undefined || endWidth === undefined || separatorWidth === undefined) return join(shown);
  const gap = columns - leftWidth - endWidth;
  if (gap < (left ? separatorWidth : 0)) return join(shown);
  return `${left}${' '.repeat(gap)}${end}`;
}

function render(
  data: StatusData,
  {
    config: overrides = {},
    nowMs = Date.now(),
    statusOf = gitStatus,
    branchOf = headBranch,
    mtimeOf = fileMtime,
    env = process.env,
    setupOf,
    memoryOf = readMemory,
    commandOutputOf = runCommand,
    transcript = readTranscriptActivity,
    columns,
    ledger,
    hostname = os.hostname(),
  }: RenderOptions = {},
): string {
  const merged = { ...DEFAULTS, ...overrides };
  const config: Config = { ...merged, segments: segmentsOf(merged.segments) };
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();
  const theme = themeOf(config.theme);

  let gitState: GitState | undefined;
  // The transcript is read at most once, and only when a part asks. A
  // transcript that cannot be read shows nothing rather than fails.
  let activity: TranscriptActivity | undefined;
  const readActivity = (): TranscriptActivity => {
    const file = data.transcript_path;
    if (typeof file !== 'string' || !file) return emptyActivity();
    try {
      return sanitiseActivity(transcript(file));
    } catch {
      return emptyActivity();
    }
  };

  let setup: Setup | undefined;
  let memory: { reading: Memory | undefined } | undefined;
  let commandOutput: string | undefined;
  const input: PartContext = {
    data: sanitiseAll(data),
    config,
    theme,
    nowMs,
    ledger: ledgerFrom(ledger),
    cwd,
    folder: sanitise(path.basename(cwd)),
    hostname,
    git: () => (gitState ??= readGit(cwd, statusOf, branchOf)),
    mtimeOf: (file) => mtimeOf(path.resolve(cwd, file)),
    activity: () => (activity ??= readActivity()),
    processEnv: env,
    // Read once per render, however many parts ask, and only when one does.
    setup: () => {
      if (!setup) {
        const read = setupOf ? setupOf(cwd) : readSetup(cwd, { env });
        setup = { ...read, plan: read.plan && sanitise(read.plan), user: read.user && sanitise(read.user) };
      }
      return setup;
    },
    memory: () => (memory ??= { reading: memoryOf() }).reading,
    // Nothing runs without a command, and a command runs once per render.
    commandOutput: () => (commandOutput ??= config.command ? commandOutputOf(config.command, cwd) : ''),
  };

  const separator = separatorOf(config, theme);
  const width = columnsOf(columns);

  // One output line per row. A part with nothing to show drops out of its
  // row, and a row left with no parts drops out of the status line.
  return config.rows
    .map((row) =>
      joinRow(
        row
          // Rows handed in from JavaScript may name parts the registry lacks;
          // those render as nothing, like every other part with nothing to show.
          .map((part) => {
            if (!isPart(part)) return { part, text: '' };
            const color = ownValue(config.colors, part);
            const spec = PART_REGISTRY[part];
            const text = spec.build(color ? { ...input, theme: solid(theme, color) } : input);
            const url = text && config.links ? spec.link?.(input) : undefined;
            return { part, text: url && LINKABLE.test(url) ? hyperlink(url, text) : text };
          })
          .filter((p) => p.text),
        separator,
        config.right,
        width,
      ),
    )
    .filter(Boolean)
    .join('\n');
}

// --latest: the status line where Claude Code runs none (the VS Code panel).
// It rebuilds a payload from the session transcript, and takes the 5h and 7d
// windows from the last terminal render, which saves them, and today and
// week from the cost ledger terminal renders keep.

const configDir = () => configDirOf(process.env, os.homedir());
// A file in the state folder.
const stateFile = (name: string) => path.join(configDir(), 'claude-gauge', '.state', name);
const usageFile = () => stateFile('usage.json');

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

// The last payload a terminal render read, for the claude-gauge wizard to
// preview its choices with. One file, overwritten by each render.
const payloadFile = () => stateFile('last-payload.json');

// A payload past this size is not a status payload, and is not kept, so the
// file stays small.
const MAX_SAVED_PAYLOAD = 64 * 1024;

// Best effort, like saveUsage. Replaced whole, so the wizard never reads
// half of one.
function savePayload(data: StatusData): void {
  const text = JSON.stringify(data);
  if (text.length <= MAX_SAVED_PAYLOAD) replaceQuietly(fs, payloadFile(), text);
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

// The cost ledger file. Each terminal render records its session's cost in
// it; the today and week parts read it, with --latest too.
const ledgerFile = () => stateFile('ledger.json');

// A session records its cost at most once in this time. The parts still show
// its latest cost, as the spend the ledger has not recorded yet.
const LEDGER_THROTTLE_MS = 10_000;

// Days and sessions older than this drop out of the ledger.
const LEDGER_KEEP_MS = 31 * 86400 * 1000;

// A lock this old was left by a render that stopped while holding it.
const STALE_LOCK_MS = 10_000;

// How long a render waits for another to finish writing, in all.
const LOCK_WAIT_MS = 100;

// The ledger the file holds, or an empty one when there is none or it is not
// JSON.
function readLedger(file: string): Ledger {
  try {
    return ledgerFrom(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return ledgerFrom(undefined);
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isStale = (file: string) => Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;

// Removes a lock a render left when it stopped while holding it. The lock is
// first renamed to a name of this render's own, which only one render can do,
// and then checked again, so a lock another render took in the meantime is
// put back rather than removed.
function breakStaleLock(lock: string, token: string): void {
  const taken = `${lock}.${token}`;
  try {
    if (!isStale(lock)) return;
    fs.renameSync(lock, taken);
  } catch {
    return; // the lock went, or another render took it first
  }
  try {
    if (!isStale(taken)) fs.linkSync(taken, lock);
  } catch {
    /* a newer lock is in place: leave it */
  }
  fs.rmSync(taken, { force: true });
}

// Runs write while holding the ledger's lock, a file only one render at a
// time can create, holding a token of the render's own. A render that cannot
// take the lock in LOCK_WAIT_MS writes nothing, and loses nothing: its
// session's spend stays unrecorded until a later render records it. write
// gets held, which says whether the lock is still this render's: a render
// that stopped for longer than STALE_LOCK_MS, as across a system sleep, can
// find its lock broken and taken by another, and must then commit nothing.
function withLock(file: string, write: (held: () => boolean) => void): void {
  const lock = `${file}.lock`;
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  for (let waited = 0; ; waited += 5) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      breakStaleLock(lock, token);
      if (waited >= LOCK_WAIT_MS) return;
      sleep(5);
    }
  }
  const held = () => {
    try {
      return fs.readFileSync(lock, 'utf8') === token;
    } catch {
      return false;
    }
  };
  try {
    write(held);
  } finally {
    // Only this render's own lock: another may hold it once this one was
    // taken for stale.
    if (held()) fs.rmSync(lock, { force: true });
  }
}

// Records what the session has spent since the ledger last recorded it,
// against today, and returns the ledger as it now stands. It writes only when
// the cost has changed and LEDGER_THROTTLE_MS has passed since the session
// last wrote. Under the lock it reads the file again, so a write never loses
// another session's, and it replaces the file in one rename, so a reader never
// sees half a ledger. Best effort: a failed write never breaks the status
// line.
function recordCost(data: StatusData, { file = ledgerFile(), nowMs = Date.now() }: { file?: string; nowMs?: number } = {}): Ledger {
  let ledger = readLedger(file);
  const id = data.session_id;
  const usd = finite(data.cost?.total_cost_usd);
  if (typeof id !== 'string' || !id || usd === undefined) return ledger;
  const last = ledger.sessions[id];
  if (finite(last?.usd) === usd) return ledger;
  const since = nowMs - (finite(last?.at) ?? -Infinity);
  if (since >= 0 && since < LEDGER_THROTTLE_MS) return ledger;

  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withLock(file, (held) => {
      const fresh = readLedger(file);
      const day = dayKey(nowMs);
      fresh.days[day] = (finite(fresh.days[day]) ?? 0) + unrecorded(fresh, data);
      fresh.sessions[id] = { usd, at: nowMs };
      forgetOld(fresh, nowMs);
      fs.writeFileSync(temp, JSON.stringify(fresh));
      // A lock lost while this render stopped: the ledger read above may be
      // out of date, so the session's spend waits for a later render.
      if (!held()) return;
      fs.renameSync(temp, file);
      ledger = fresh;
    });
  } catch {
    /* the folder cannot be written at all: the status line still shows */
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    /* nothing was left */
  }
  return ledger;
}

// Drops the days and sessions older than LEDGER_KEEP_MS, and any entry that
// is not a ledger entry.
function forgetOld(ledger: Ledger, nowMs: number): void {
  const oldest = dayKey(nowMs - LEDGER_KEEP_MS);
  for (const [day, usd] of Object.entries(ledger.days)) {
    if (day < oldest || finite(usd) === undefined) delete ledger.days[day];
  }
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    const at = finite(entry?.at);
    if (at === undefined || at < nowMs - LEDGER_KEEP_MS || finite(entry?.usd) === undefined) delete ledger.sessions[id];
  }
}

// The transcript reader. A transcript only grows while its session runs, so
// each render reads just the bytes added since the last one, from an offset
// kept per transcript in the state folder with what the earlier bytes showed.
// A transcript that shrank or was replaced by another file is read again
// from the start.

// A tool call: the tool's name and what it works on, if anything.
interface ToolCall {
  name: string;
  target?: string;
}

// A subagent the session started: its type, the model it runs on and the
// description it was given, when the transcript names them, and when it
// started and ended, in ms since the epoch. One with no end is running.
interface AgentRun {
  type: string;
  model?: string;
  description?: string;
  startedAt?: number;
  endedAt?: number;
  // Ended without finishing its work: it failed, or was stopped.
  failed?: boolean;
}

// A todo of the session's list: what to do, the form Claude Code shows
// while it is in progress, and its status.
interface Todo {
  content: string;
  activeForm?: string;
  status: TodoStatus;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';

// An MCP server the session called, by the name its tools carry, and whether
// its latest call failed.
interface McpServer {
  name: string;
  failed?: boolean;
}

// What a transcript shows: the tool calls still running, oldest first, how
// many calls of each tool have completed, the subagents, in the order they
// started, the todo list, in its order, the skills used and MCP servers
// called, in the order last used, and the session counters: how many times
// the conversation was compacted, when Claude last replied, in ms since the
// epoch, and the last response's output tokens per second.
interface TranscriptActivity {
  tools: { running: ToolCall[]; completed: Record<string, number> };
  agents: AgentRun[];
  todos: Todo[];
  skills: string[];
  mcp: McpServer[];
  compactions: number;
  lastReplyAt?: number;
  speed?: number;
}

const emptyActivity = (): TranscriptActivity => ({ tools: { running: [], completed: {} }, agents: [], todos: [], skills: [], mcp: [], compactions: 0 });

// Activity with every name and target sanitised. Two tool names that differ
// only in control codes count as one.
// A reader handed in from JavaScript may leave out all but the tools, or give
// counters that are not numbers.
function sanitiseActivity({ tools, agents = [], todos = [], skills = [], mcp = [], compactions, lastReplyAt, speed }: TranscriptActivity): TranscriptActivity {
  const running = tools.running.map(({ name, target }) => ({ name: sanitise(name), ...(target ? { target: sanitise(target) } : {}) }));
  const completed: Record<string, number> = {};
  for (const [name, count] of Object.entries(tools.completed)) completed[sanitise(name)] = (completed[sanitise(name)] ?? 0) + count;
  const cleanAgents = agents.map(({ type, model, description, ...times }) => ({
    ...times,
    type: sanitise(type),
    ...(model ? { model: sanitise(model) } : {}),
    ...(description ? { description: sanitise(description) } : {}),
  }));
  const cleanTodos = todos.map(({ content, activeForm, status }) => ({
    content: sanitise(content),
    ...(activeForm ? { activeForm: sanitise(activeForm) } : {}),
    status,
  }));
  const cleanSkills = skills.map(sanitise);
  const cleanMcp = mcp.map(({ name, failed }) => ({ name: sanitise(name), ...(failed ? { failed } : {}) }));
  const replyAt = finite(lastReplyAt);
  const tokensPerSecond = finite(speed);
  return {
    tools: { running, completed },
    agents: cleanAgents,
    todos: cleanTodos,
    skills: cleanSkills,
    mcp: cleanMcp,
    compactions: finite(compactions) ?? 0,
    ...(replyAt !== undefined ? { lastReplyAt: replyAt } : {}),
    ...(tokensPerSecond !== undefined ? { speed: tokensPerSecond } : {}),
  };
}

// What the reader keeps between renders. version changes when the shape
// does, so a state from an older claude-gauge is rebuilt, not misread.
const TRANSCRIPT_STATE_VERSION = 5;

interface TranscriptState {
  version: number;
  // The transcript, and the file it was: a replaced file has a new inode.
  file: string;
  dev: number;
  ino: number;
  // The bytes read so far, always up to the end of a whole line.
  offset: number;
  // The tool calls with no result yet, by call id, oldest first. A call
  // that was running when the user sent a prompt has ended, but its result
  // may still come, and then counts.
  pending: (ToolCall & { id: string; ended?: boolean; skill?: string })[];
  completed: Record<string, number>;
  // The subagents, by the id of the call that started them, in the order
  // they started. One in the background keeps running past its call's
  // result, until its task notification.
  agents: AgentEntry[];
  // The todo list, in its order, and the calls to the todo tools with no
  // result yet: a call changes the list once its result says it worked.
  todos: TodoEntry[];
  todoCalls: TodoCall[];
  // The skills used and the MCP servers called, in the order last used,
  // and the skill the user's last command names, until the skill's text
  // shows it was a skill and not a built-in command.
  skills: string[];
  mcp: McpServer[];
  command?: string;
  // How many times the conversation was compacted.
  compactions: number;
  // When the last prompt or tool result came, which asks for the next
  // response, and the last response so far.
  askedAt?: number;
  response?: ResponseEntry;
}

// A response as the reader keeps it: the message's id, when it was asked for
// and when its last block came, in ms since the epoch, and its output tokens.
// Claude Code writes a record per block, each with the message's final usage.
interface ResponseEntry {
  id: string;
  askedAt: number;
  endedAt: number;
  tokens: number;
}

// A todo as the reader keeps it: by the id the task tools gave it, if any.
type TodoEntry = Todo & { id?: string };

// A call to a todo tool, kept until its result comes: its id, the tool and
// what it was asked to write.
interface TodoCall {
  id: string;
  name: string;
  input: unknown;
}

// A subagent as the reader keeps it: by the id of the call that started it,
// and whether it runs in the background.
type AgentEntry = AgentRun & { id: string; background?: boolean };

// The ended calls kept at most, newest first: a call whose result never
// came must not grow the state for ever. Running calls are all kept, so a
// large parallel batch counts in full. Ended subagents are capped the same,
// and so are the todo tools' calls that wait for a result.
const ENDED_KEPT = 20;

// The tool that starts a subagent: Agent, named Task before Claude Code 2.1.
const AGENT_TOOLS = ['Agent', 'Task'];

// The tools that write the todo list: TodoWrite replaces it whole, and the
// task tools that replaced it in Claude Code 2.1 add a task and change one.
const TODO_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate'];

// The skills and the MCP servers kept at most, each the most recently used.
const RECENT_KEPT = 20;

// The text Claude Code adds as a meta message when a skill runs.
const SKILL_TEXT = 'Base directory for this skill:';

// The fs calls the reader makes, so a test can count the bytes it reads.
type TranscriptFs = Pick<typeof fs, 'statSync' | 'openSync' | 'readSync' | 'closeSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'rmSync'>;

interface TranscriptReadOptions {
  stateDir?: string;
  fs?: TranscriptFs;
}

const transcriptStateDir = () => path.join(configDir(), 'claude-gauge', '.state', 'transcripts');

// The input field that names what a tool works on, most telling first.
const TARGET_FIELDS = ['file_path', 'notebook_path', 'pattern', 'command', 'url', 'query', 'description', 'skill', 'path'];

function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  for (const field of TARGET_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0];
  }
  return undefined;
}

interface ContentBlock {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  text?: unknown;
  content?: unknown;
}

// A record's time in ms since the epoch, if it has a valid one.
const timeOf = (record: TranscriptRecord): number | undefined => {
  const ms = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

// A model as the agents part prints it, from an id or an alias: Haiku 4.5,
// Sonnet. inherit names no model of its own.
const agentModel = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim() !== 'inherit' ? modelName(value.trim()) : undefined;

// The subagent a call to the Agent tool starts.
function startAgent(state: TranscriptState, block: ContentBlock, startedAt: number | undefined): void {
  const input = isObject(block.input) ? block.input : {};
  const model = agentModel(input.model);
  const description = stringAt(input, 'description');
  state.agents.push({
    id: String(block.id),
    type: stringAt(input, 'subagent_type') ?? 'general-purpose',
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    // Known from the call, so a prompt before the launch result does not stop it.
    ...(input.run_in_background === true ? { background: true } : {}),
  });
}

// A subagent's end: when it ended, and whether it failed or was stopped. An
// end with no time counts as long ago, so the part drops it rather than
// shows it as running.
function endAgent(agent: AgentEntry, endedAt: number | undefined, failed: boolean): void {
  agent.endedAt = endedAt ?? 0;
  if (failed) agent.failed = true;
  else delete agent.failed;
}

// The result of an Agent call: the end of a subagent in the foreground, or,
// for one in the background, only its launch, which names the model.
function agentResult(agent: AgentEntry, block: ContentBlock, record: TranscriptRecord, at: number | undefined): void {
  const result = isObject(record.toolUseResult) ? record.toolUseResult : {};
  const model = agentModel(result.resolvedModel);
  if (model) agent.model = model;
  if (result.isAsync === true || result.status === 'async_launched') {
    agent.background = true;
    return;
  }
  endAgent(agent, at, block.is_error === true || (typeof result.status === 'string' && result.status !== 'completed'));
}

// The text of a message: its content when that is text, else its text blocks.
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : '')).join('\n')
      : '';

// A task notification, which Claude Code adds when a task in the background
// ends: the call that started the task, and its status. Not a prompt.
function taskNotification(record: TranscriptRecord): { id?: string; status?: string } | undefined {
  // Only the origin tells one apart: a prompt the user types can hold the same text.
  if (!isObject(record.origin) || record.origin.kind !== 'task-notification') return undefined;
  const text = textOf(record.message?.content);
  return {
    id: /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(text)?.[1]?.trim(),
    status: /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim(),
  };
}

// A status the todo tools write, or undefined for any other value.
const todoStatus = (value: unknown): TodoStatus | undefined =>
  value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined;

// A field that holds text, not only white space.
const textAt = (value: unknown, key: string): string | undefined => (stringAt(value, key)?.trim() ? stringAt(value, key) : undefined);

// A field that holds an id, as a string or a number, as a string.
const idAt = (value: unknown, key: string): string | undefined => {
  const field = isObject(value) ? value[key] : undefined;
  return typeof field === 'number' ? String(field) : stringAt(value, key);
};

// A todo from the fields a todo tool names, or undefined when it has no text.
function todoOf(content: string | undefined, activeForm: string | undefined, status: TodoStatus, id?: string): TodoEntry | undefined {
  if (!content) return undefined;
  return { ...(id ? { id } : {}), content, ...(activeForm ? { activeForm } : {}), status };
}

// The todos a TodoWrite call writes. One with no text drops out, and one
// with a status the part does not know counts as pending.
function writtenTodos(input: JsonObject): TodoEntry[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.flatMap((todo) => {
    const status = (isObject(todo) && todoStatus(todo.status)) || 'pending';
    return todoOf(textAt(todo, 'content'), textAt(todo, 'activeForm'), status) ?? [];
  });
}

// The id of the task a TaskCreate result names: from its data, else from
// its text, Task #7 created successfully.
function createdTaskId(block: ContentBlock, record: TranscriptRecord): string | undefined {
  const task = isObject(record.toolUseResult) ? record.toolUseResult.task : undefined;
  return idAt(task, 'id') ?? /Task #(\S+) created/.exec(textOf(block.content))?.[1];
}

// A todo tool's call applied to the list, once its result says it worked:
// TodoWrite replaces the list, TaskCreate adds a pending task, and
// TaskUpdate changes one, or drops it when it is deleted.
function applyTodoCall(state: TranscriptState, todoCall: TodoCall, block: ContentBlock, record: TranscriptRecord): void {
  if (resultFailed(block, record)) return;
  const input = isObject(todoCall.input) ? todoCall.input : {};
  if (todoCall.name === 'TodoWrite') {
    state.todos = writtenTodos(input);
  } else if (todoCall.name === 'TaskCreate') {
    const task = todoOf(textAt(input, 'subject'), textAt(input, 'activeForm'), 'pending', createdTaskId(block, record));
    if (task) state.todos = [...state.todos, task];
  } else if (todoCall.name === 'TaskUpdate') {
    const id = idAt(input, 'taskId');
    const task = id === undefined ? undefined : state.todos.find((t) => t.id === id);
    if (!task) return;
    if (input.status === 'deleted') {
      state.todos = state.todos.filter((t) => t !== task);
      return;
    }
    const status = todoStatus(input.status);
    if (status) task.status = status;
    const content = textAt(input, 'subject');
    if (content) task.content = content;
    const activeForm = textAt(input, 'activeForm');
    if (activeForm) task.activeForm = activeForm;
  }
}

// The MCP server a tool belongs to, from the name Claude Code gives an MCP
// server's tools: mcp__github__search_issues is github's.
const mcpServerOf = (tool: string): string | undefined => /^mcp__(.+?)__./.exec(tool)?.[1];

// A skill's name as the Skill tool or a command names it, with no slash.
const skillName = (value: string | undefined): string | undefined => value?.trim().replace(/^\//, '') || undefined;

// The skill a prompt's command names, from the text Claude Code records for
// a slash command: <command-name>/tdd</command-name>.
const commandOf = (content: unknown): string | undefined => skillName(/<command-name>([^<]*)<\/command-name>/.exec(textOf(content))?.[1]);

// A list in the order last used, with item moved to the end, and the
// oldest past RECENT_KEPT dropped.
const usedNow = <T>(list: T[], item: T): T[] => [...list.filter((i) => i !== item), item].slice(-RECENT_KEPT);

// An MCP server as called now, keeping whether its latest call failed.
function useServer(state: TranscriptState, name: string): void {
  state.mcp = usedNow(state.mcp, state.mcp.find((s) => s.name === name) ?? { name });
}

// A result that says its call did not work: an error, or data that says so.
const resultFailed = (block: ContentBlock, record: TranscriptRecord) =>
  block.is_error === true || (isObject(record.toolUseResult) && record.toolUseResult.success === false);

// The error results Claude Code writes when the user rejects or interrupts a
// call, or a permission rule denies it: the tool never ran, so they say
// nothing about whether it works.
const STOPPED_RESULTS = [/^The user doesn't want to proceed/, /^\[Request interrupted by user/, /^Permission to use /];
const resultStopped = (block: ContentBlock) => STOPPED_RESULTS.some((stopped) => stopped.test(textOf(block.content).trim()));

// The ended subagents past the newest ENDED_KEPT drop out; running ones stay.
function capAgents(state: TranscriptState): void {
  let ended = 0;
  state.agents = state.agents
    .reverse()
    .filter((a) => a.endedAt === undefined || ++ended <= ENDED_KEPT)
    .reverse();
}

// A response's record applied to the state: the first block of a message
// starts a response, timed from the prompt or tool result that asked for it,
// and each block after it moves the response's end. A reply Claude Code
// writes itself, such as an API error, is no response of the model's.
function applyResponse(state: TranscriptState, record: TranscriptRecord, at: number | undefined): void {
  const message = record.message;
  if (at === undefined || typeof message?.id !== 'string' || message.model === '<synthetic>') return;
  const tokens = finite(message.usage?.output_tokens) ?? 0;
  if (state.response?.id === message.id) {
    state.response.endedAt = Math.max(state.response.endedAt, at);
    state.response.tokens = tokens;
  } else {
    state.response = { id: message.id, askedAt: state.askedAt ?? at, endedAt: at, tokens };
  }
}

// The last response's output tokens per second, when it had tokens and took
// time to write.
function speedOf(response: ResponseEntry | undefined): number | undefined {
  const seconds = response ? (response.endedAt - response.askedAt) / 1000 : 0;
  return response && response.tokens > 0 && seconds > 0 ? response.tokens / seconds : undefined;
}

// One transcript record applied to the state. Subagent records are left out,
// as they are for --latest. A prompt from the user ends the turn, so a call
// still running then was interrupted: it no longer shows as running, and a
// subagent in the foreground shows as stopped. One in the background runs on
// until its task notification. A prompt that runs a command names a skill
// when the next record is the skill's text.
function applyRecord(state: TranscriptState, record: TranscriptRecord): void {
  if (!record || typeof record !== 'object' || record.isSidechain) return;
  const at = timeOf(record);
  if (record.type === 'system' && record.subtype === 'compact_boundary') state.compactions++;
  if (record.type === 'assistant') applyResponse(state, record, at);
  if (record.type === 'user' && at !== undefined) state.askedAt = at;
  const content = record.message?.content;
  const blocks: ContentBlock[] = Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
  const results = blocks.some((b) => b.type === 'tool_result');
  const { command } = state;
  delete state.command;
  if (record.type === 'user' && record.isMeta && !results) {
    if (command && textOf(content).startsWith(SKILL_TEXT)) state.skills = usedNow(state.skills, command);
    return;
  }
  // A task notification ends a task in the background, and is no prompt.
  const notified = record.type === 'user' ? taskNotification(record) : undefined;
  if (notified) {
    const agent = state.agents.find((a) => a.id === notified.id);
    if (agent) endAgent(agent, at, notified.status !== 'completed');
    capAgents(state);
    return;
  }
  if (record.type === 'user' && !results) {
    if (typeof content === 'string' || blocks.length) {
      const named = commandOf(content);
      if (named) state.command = named;
      state.pending = state.pending.map((p) => ({ ...p, ended: true })).slice(-ENDED_KEPT);
      for (const agent of state.agents) if (agent.endedAt === undefined && !agent.background) endAgent(agent, at, true);
      capAgents(state);
    }
    return;
  }
  for (const block of blocks) {
    if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      const target = toolTarget(block.input);
      const skill = block.name === 'Skill' ? skillName(stringAt(block.input, 'skill')) : undefined;
      state.pending = [...state.pending, { id: block.id, name: block.name, ...(target ? { target } : {}), ...(skill ? { skill } : {}) }];
      const server = mcpServerOf(block.name);
      if (server) useServer(state, server);
      if (AGENT_TOOLS.includes(block.name)) startAgent(state, block, at);
      if (TODO_TOOLS.includes(block.name)) state.todoCalls = [...state.todoCalls, { id: block.id, name: block.name, input: block.input }].slice(-ENDED_KEPT);
    } else if (record.type === 'user' && block.type === 'tool_result') {
      const agent = state.agents.find((a) => a.id === block.tool_use_id);
      if (agent) agentResult(agent, block, record, at);
      const todoCall = state.todoCalls.find((c) => c.id === block.tool_use_id);
      if (todoCall) {
        state.todoCalls = state.todoCalls.filter((c) => c !== todoCall);
        applyTodoCall(state, todoCall, block, record);
      }
      const call = state.pending.find((p) => p.id === block.tool_use_id);
      if (!call) continue;
      state.pending = state.pending.filter((p) => p !== call);
      state.completed[call.name] = (state.completed[call.name] ?? 0) + 1;
      if (call.skill && !resultFailed(block, record)) state.skills = usedNow(state.skills, call.skill);
      const server = state.mcp.find((s) => s.name === mcpServerOf(call.name));
      if (server && !resultStopped(block)) {
        if (resultFailed(block, record)) server.failed = true;
        else delete server.failed;
      }
    }
  }
  capAgents(state);
}

// Reads the transcript from offset to size, applying each whole line, and
// returns the offset after the last one. A line still being written is left
// for the next render.
function readLines(io: TranscriptFs, file: string, offset: number, size: number, apply: (line: string) => void): number {
  const fd = io.openSync(file, 'r');
  try {
    // The bytes read since the last newline, in the chunks they came in, so
    // a long line is joined once rather than copied again for every chunk.
    let rest: Buffer[] = [];
    let restLength = 0;
    let position = offset;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(1 << 16, size - position));
      const n = io.readSync(fd, chunk, 0, chunk.length, position);
      if (n <= 0) break;
      position += n;
      const read = chunk.subarray(0, n);
      const end = read.lastIndexOf(0x0a);
      if (end < 0) {
        rest.push(read);
        restLength += n;
        continue;
      }
      const lines = Buffer.concat([...rest, read.subarray(0, end)]).toString('utf8');
      for (const line of lines.split('\n')) apply(line);
      rest = [read.subarray(end + 1)];
      restLength = n - end - 1;
    }
    return position - restLength;
  } finally {
    io.closeSync(fd);
  }
}

function loadTranscriptState(io: TranscriptFs, stateFile: string): TranscriptState | undefined {
  try {
    const state = JSON.parse(String(io.readFileSync(stateFile, 'utf8'))) as TranscriptState;
    const valid =
      state?.version === TRANSCRIPT_STATE_VERSION &&
      Number.isInteger(state.offset) &&
      Array.isArray(state.pending) &&
      Array.isArray(state.agents) &&
      Array.isArray(state.todos) &&
      Array.isArray(state.todoCalls) &&
      Array.isArray(state.skills) &&
      Array.isArray(state.mcp) &&
      Number.isInteger(state.compactions) &&
      state.completed &&
      typeof state.completed === 'object';
    return valid ? state : undefined;
  } catch {
    return undefined;
  }
}

// Best effort, as saveUsage is. Unlike usage.json, which one render writes
// in place, the state is written whole to a file of its own and renamed over
// the old one: the status line can render twice at once, and the other
// render must never read half a state.
// Writes `text` beside `file` and renames it over the file, so a reader sees
// the old file or the new one. Best effort: in a read-only home or similar
// it writes nothing and leaves no temporary file.
function replaceQuietly(io: TranscriptFs, file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    io.writeFileSync(temporary, text);
    io.renameSync(temporary, file);
  } catch {
    try {
      io.rmSync(temporary, { force: true });
    } catch {
      /* nothing to remove */
    }
  }
}

// A state that is not saved makes the next render read from the start.
function saveTranscriptState(io: TranscriptFs, stateFile: string, state: TranscriptState): void {
  replaceQuietly(io, stateFile, JSON.stringify(state));
}

// What the transcript shows, reading only what it gained since the last
// call. A transcript that does not exist shows nothing.
function readTranscriptActivity(file: string, { stateDir = transcriptStateDir(), fs: io = fs }: TranscriptReadOptions = {}): TranscriptActivity {
  let stat: fs.Stats;
  try {
    stat = io.statSync(file);
  } catch {
    return emptyActivity();
  }
  const stateFile = path.join(stateDir, `${createHash('sha1').update(file).digest('hex')}.json`);
  const saved = loadTranscriptState(io, stateFile);
  const unchanged = saved && saved.file === file && saved.dev === stat.dev && saved.ino === stat.ino && saved.offset <= stat.size;
  const state: TranscriptState = unchanged
    ? saved
    : {
        version: TRANSCRIPT_STATE_VERSION,
        file,
        dev: stat.dev,
        ino: stat.ino,
        offset: 0,
        pending: [],
        completed: {},
        agents: [],
        todos: [],
        todoCalls: [],
        skills: [],
        mcp: [],
        compactions: 0,
      };

  if (stat.size > state.offset || !unchanged) {
    state.offset = readLines(io, file, state.offset, stat.size, (line) => {
      // Only lines that can hold a tool call, a result, a prompt, a response
      // or a compaction are parsed.
      if (!['"tool_', '"user"', '"assistant"', '"compact_boundary"'].some((key) => line.includes(key))) return;
      try {
        applyRecord(state, JSON.parse(line));
      } catch {
        /* not a record: skip it */
      }
    });
    saveTranscriptState(io, stateFile, state);
  }
  const running = state.pending.filter((p) => !p.ended).map(({ name, target }) => ({ name, ...(target ? { target } : {}) }));
  const agents = state.agents.map(({ id, background, ...agent }) => agent);
  const todos = state.todos.map(({ id, ...todo }) => todo);
  const mcp = state.mcp.map((server) => ({ ...server }));
  const lastReplyAt = state.response?.endedAt;
  const speed = speedOf(state.response);
  return {
    tools: { running, completed: { ...state.completed } },
    agents,
    todos,
    skills: [...state.skills],
    mcp,
    compactions: state.compactions,
    ...(lastReplyAt !== undefined ? { lastReplyAt } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5.
function modelName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const parts = id.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  const family = parts.shift();
  if (!family) return id;
  return [capitalised(family), parts.join('.')].filter(Boolean).join(' ');
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
  // What a system record reports, such as compact_boundary for a compaction.
  subtype?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  // Text Claude Code adds to the conversation, not typed by the user.
  isMeta?: boolean;
  // What Claude Code adds to a record: a tool's result as data, and where a
  // message came from, such as a task notification.
  toolUseResult?: unknown;
  origin?: unknown;
  effort?: string | { level?: string };
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      output_tokens?: number;
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
const shellWord = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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
  readSwitches,
  PARTS,
  THEMES,
  DEFAULT_ROWS,
  SWITCHES,
  payloadFromTranscript,
  recordCost,
  withLock,
  modelName,
  repoFromRemote,
  worktreeFromGitDir,
  instruction,
  INSTRUCT_HOSTS,
  readTranscriptActivity,
  payloadFile,
  readSetup,
  readMemory,
  runCommand,
  COMMAND_TIMEOUT_MS,
};

export type { StatusData, Config, Overrides, Part, Theme, TranscriptRecord, Ledger, TranscriptActivity, AgentRun, Todo, McpServer, Setup, Memory };

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
    // Plain text: it is pasted into a reply, where colour codes and links
    // show as junk.
    process.stdout.write(stripOwnCodes(render(data, { config, nowMs, ledger: readLedger(ledgerFile()) })) + '\n');
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      let data: StatusData = {};
      let parsed = false;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        parsed = true;
      } catch {
        /* render what we can from an empty payload rather than print nothing */
      }
      saveUsage(data, nowMs);
      // Only a payload that holds something replaces the one the wizard
      // previews with.
      if (parsed && isObject(data) && Object.keys(data).length) savePayload(data);
      const ledger = recordCost(data, { nowMs });
      process.stdout.write(render(data, { config, nowMs, ledger, columns: columnsOf(process.env.COLUMNS) }) + '\n');
    });
  }
}
