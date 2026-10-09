#!/usr/bin/env node

// claude-gauge token line for Claude Code.
//
// Reports the tokens spent since your last prompt, from the session
// transcript, as one compact line:
//
//   12:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 427k
//
// Two ways to run it:
//   - as a Stop hook: Claude Code pipes the hook payload on stdin and shows
//     the line as a system message when the turn ends;
//   - with --latest: prints the line for the calling session, for Claude to
//     paste into its reply where hook messages are not shown.
//
// Switches:
//   --show <parts>      parts to show, in order, comma-separated, from
//                       time,req,out,cache,ctx (default: all of them)
//   --segments <5|10>   cells in the context bar (default 5)
//   --window <tokens>   context window size, e.g. 200k or 1m. Without it the
//                       window is 200k, or 1M once the context passes 200k.
//   --latest            print the line for the calling session
//   --instruct          as a SessionStart hook: in the VS Code extension and
//                       the desktop app, tell Claude to end each reply with
//                       the line; in the terminal CLI, print nothing

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PARTS = ['time', 'req', 'out', 'cache', 'ctx'] as const;

type Part = (typeof PARTS)[number];

const isPart = (name: string): name is Part => (PARTS as readonly string[]).includes(name);

interface Options {
  latest: boolean;
  show?: Part[];
  segments?: string;
  window?: string;
}

// Turns the switches into options. Unknown switches and part names are
// ignored, so a hook never fails over a typo.
function parseArgs(argv: string[]): Options {
  const opts: Options = { latest: false };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i] ?? '';
    switch (name) {
      case '--show': {
        const parts = value().split(',').map((p) => p.trim()).filter(isPart);
        if (parts.length) opts.show = parts;
        break;
      }
      case '--segments': opts.segments = value(); break;
      case '--window': opts.window = value(); break;
      case '--latest': opts.latest = true; break;
      default: break;
    }
  }
  return opts;
}

// Compact counts: 1.69M, 427k, 6.5k, 830.
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
  : n >= 1e5 ? `${Math.round(n / 1e3)}k`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
  : String(n);

const SCALES: Record<string, number> = { '': 1, k: 1e3, m: 1e6 };

// Parses "200000", "200k" or "1m" into a token count; NaN when it is none.
function parseSize(value: string | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(value ?? ''));
  if (!m) return NaN;
  const scale = SCALES[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * scale);
}

// The transcript records the model but not its context window, so take the
// window from --window when set. Otherwise assume Claude Code's default of
// 200k, and 1M once the context is past that.
function contextWindow(ctx: number, explicit?: string): number {
  const size = parseSize(explicit);
  if (size > 0) return size;
  return ctx > 200e3 ? 1e6 : 200e3;
}

// Bars come in 5 or 10 cells; anything else falls back to 5.
const segmentsOf = (value: number | string | undefined) => (Number(value) === 10 ? 10 : 5);

// A bar of `segments` cells over the context window.
const bar = (pct: number, segments: number) => {
  const filled = Math.min(segments, Math.max(0, Math.round((pct * segments) / 100)));
  return '▓'.repeat(filled) + '░'.repeat(segments - filled);
};

// Local HH:MM, enough to tell runs apart in a scrollback.
const stamp = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// A session transcript record, as far as the token line reads it.
interface Usage {
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptRecord {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    id?: string;
    usage?: Usage;
    content?: unknown;
  };
}

// A human prompt, as opposed to a tool_result echoed back as a user record.
function isHumanPrompt(rec: TranscriptRecord): boolean {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const content = rec.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) return !content.some((b) => b?.type === 'tool_result');
  return false;
}

interface Tally {
  reqs: number;
  out: number;
  thinking: number;
  cacheWrite: number;
  cacheRead: number;
  ctx: number;
}

function tally(records: TranscriptRecord[]): Tally {
  const t: Tally = { reqs: 0, out: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, ctx: 0 };
  // The transcript writes one record per content block (thinking, text, each
  // tool_use), and every one of them carries the whole message's usage. Count
  // each API response once, by its message id, keeping its last record.
  const byMessage = new Map<string | undefined, TranscriptRecord>();
  for (const r of records) {
    if (r.message?.usage) byMessage.set(r.message.id ?? r.uuid, r);
  }
  for (const r of byMessage.values()) {
    const u = r.message?.usage ?? {};
    t.reqs += 1;
    t.out += u.output_tokens ?? 0;
    t.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    // Context at the end of the run is whatever the final main-thread request
    // carried in; subagent (sidechain) requests have their own context.
    if (!r.isSidechain) {
      t.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  return t;
}

interface SummarizeOptions {
  now?: Date;
  window?: string;
  segments?: number | string;
  show?: readonly Part[];
}

// Builds the line from parsed transcript records; null when the run made no
// API request yet, or when none of the chosen parts has anything to show.
function summarize(records: TranscriptRecord[], { now = new Date(), window, segments, show = PARTS }: SummarizeOptions = {}): string | null {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isHumanPrompt(records[i])) {
      start = i;
      break;
    }
  }

  const run = tally(records.slice(start).filter((r) => r.type === 'assistant'));
  if (run.reqs === 0) return null;

  const build: Record<Part, () => string> = {
    time: () => stamp(now),
    req: () => `${run.reqs} req`,
    // Thinking tokens are part of output_tokens, so show them inside it.
    out: () => (run.thinking ? `out ${fmt(run.out)} (${fmt(run.thinking)} think)` : `out ${fmt(run.out)}`),
    cache: () => `cache w${fmt(run.cacheWrite)} r${fmt(run.cacheRead)}`,
    ctx: () => {
      if (!run.ctx) return '';
      const pct = (run.ctx / contextWindow(run.ctx, window)) * 100;
      return `ctx ${Math.round(pct)}% ${bar(pct, segmentsOf(segments))} ${fmt(run.ctx)}`;
    },
  };
  // A show list handed in from JavaScript may name parts the registry lacks;
  // those render as nothing, like a part with nothing to show.
  const anyPart: Partial<Record<string, () => string>> = build;
  // The same separator as the status line.
  const line = show.map((part) => anyPart[part]?.() ?? '').filter(Boolean).join(' │ ');
  return line || null;
}

function readRecords(transcriptPath: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a partially flushed final line is expected */
    }
  }
  return records;
}

function latestTranscript(cwd: string): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projects)) return null;
  // Claude Code exports the calling session's id to the commands it runs.
  // Prefer it: with several sessions open in one project, the newest
  // transcript is often another session's. Search every project folder, so a
  // `cd` into a worktree does not lose the session.
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
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? newest.f : null;
}

// --instruct: the SessionStart hook for hosts that show no hook message. In
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
    '## Token line in replies',
    '',
    "End every reply with the claude-gauge token line, as a copyable code block, so this panel shows what the terminal's Stop hook does:",
    '',
    '```sh',
    command,
    '```',
    '',
    "Run it as the last tool call of the turn, then paste its line verbatim as the final thing in the reply, in one plain code block. Skip it only if the command fails or prints nothing. Never guess the figures, and never reuse an earlier turn's line.",
    '',
  ].join('\n');
}

// This script's path as a hook command can name it: ~ for the home folder.
const ownPath = () => process.argv[1].replace(new RegExp(`^${os.homedir()}(?=/)`), '~');

export { summarize, parseArgs, parseSize, contextWindow, PARTS, instruction, INSTRUCT_HOSTS };

export type { Options, Part, SummarizeOptions, TranscriptRecord };

// Whether this file is the program, not a module another file loaded. Node
// runs the compiled CommonJS, where require.main names the entry; Bun runs
// this source as an ES module, where Bun.main does.
declare const Bun: { main: string } | undefined;
const isMain = (typeof require !== 'undefined' && require.main === module) || (typeof Bun !== 'undefined' && Bun.main === __filename);

if (isMain) {
  const argv = process.argv.slice(2);
  const { latest, ...opts } = parseArgs(argv);

  if (argv.includes('--instruct')) {
    const text = instruction(argv, { host: process.env.CLAUDE_CODE_ENTRYPOINT, script: ownPath() });
    if (text) process.stdout.write(text);
  } else if (latest) {
    const t = latestTranscript(process.cwd());
    const line = t ? summarize(readRecords(t), opts) : null;
    if (line) process.stdout.write(line + '\n');
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      let line: string | null = null;
      try {
        const input: { transcript_path?: string } = JSON.parse(Buffer.concat(chunks).toString());
        if (input.transcript_path && fs.existsSync(input.transcript_path)) {
          line = summarize(readRecords(input.transcript_path), opts);
        }
      } catch {
        /* never break the turn over a reporting hook */
      }
      if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
    });
  }
}
