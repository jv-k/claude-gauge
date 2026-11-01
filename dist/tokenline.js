#!/usr/bin/env node
"use strict";
// claude-gauge token line for Claude Code.
//
// Reports the tokens spent since your last prompt, from the session
// transcript, as one compact line:
//
//   12:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 86.0k
//
// Two ways to run it:
//   - as a Stop hook: Claude Code pipes the hook payload on stdin and shows
//     the line as a system message when the turn ends;
//   - with --latest: prints the line for the calling session, for Claude to
//     paste into its reply where hook messages are not shown.
//
// Neither the hook input nor the transcript holds the context window size.
// The status line gets it from Claude Code at each render and saves it per
// session, and ctx reads it from there (docs/adr/0006).
//
// Switches:
//   --show <parts>      parts to show, in order, comma-separated, from
//                       time,req,out,cache,ctx (default: all of them)
//   --segments <5|10>   cells in the context bar, with the classic bar style
//                       (default 5). A list for the status line's bars,
//                       such as 5,ctx=10, gives the ctx bar's.
//   --bar-style <name>  how the context bar is drawn: classic, steps,
//                       rising, hairline, dots, spark or underline, as on
//                       the status line (default classic). A list for the
//                       status line's bars, such as steps,ctx=rising, gives
//                       the ctx bar's.
//   --window <tokens>   context window size, e.g. 200k or 1m, over the size
//                       the status line saved for the session. Without
//                       either, the window is 200k, or 1M once the context
//                       passes 200k.
//   --latest            print the line for the calling session
//   --instruct          as a SessionStart hook: in the VS Code extension and
//                       the desktop app, tell Claude to end each reply with
//                       the line; in the terminal CLI, print nothing
Object.defineProperty(exports, "__esModule", { value: true });
exports.INSTRUCT_HOSTS = exports.PARTS = void 0;
exports.summarize = summarize;
exports.parseArgs = parseArgs;
exports.readSwitches = readSwitches;
exports.parseSize = parseSize;
exports.contextWindow = contextWindow;
exports.instruction = instruction;
const node_crypto_1 = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PARTS = ['time', 'req', 'out', 'cache', 'ctx'];
exports.PARTS = PARTS;
const isPart = (name) => PARTS.includes(name);
// Every switch parseArgs reads, one row each: readSwitches takes a value for
// a row that says so, and parseArgs runs the row's apply. --instruct is
// not here, because the program reads it from argv itself, below.
const SWITCHES = [
    {
        name: '--show',
        takesValue: true,
        apply: (opts, value) => {
            const parts = value.split(',').map((p) => p.trim()).filter(isPart);
            if (parts.length)
                opts.show = parts;
        },
    },
    { name: '--segments', takesValue: true, apply: (opts, value) => { opts.segments = value; } },
    { name: '--bar-style', takesValue: true, apply: (opts, value) => { opts.barStyle = value.trim(); } },
    { name: '--window', takesValue: true, apply: (opts, value) => { opts.window = value; } },
    { name: '--latest', apply: (opts) => { opts.latest = true; } },
];
const switchNamed = (name) => SWITCHES.find((s) => s.name === name);
// The switches in `argv` as the token line reads them: a switch that takes a
// value takes the next word, unless it has one after `=`. Any other word
// stands alone.
function readSwitches(argv) {
    const read = [];
    for (let i = 0; i < argv.length; i++) {
        const start = i;
        const [name, inline] = argv[i].split(/=(.*)/s);
        const value = switchNamed(name)?.takesValue ? (inline ?? argv[++i] ?? '') : '';
        read.push({ name, value, words: argv.slice(start, i + 1) });
    }
    return read;
}
// Turns the switches into options. Unknown switches and part names are
// ignored, so a hook never fails over a typo.
function parseArgs(argv) {
    const opts = { latest: false };
    for (const { name, value } of readSwitches(argv))
        switchNamed(name)?.apply(opts, value);
    return opts;
}
// Compact counts: 1.69M, 427k, 6.5k, 830.
const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e5 ? `${Math.round(n / 1e3)}k`
        : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
            : String(n);
const SCALES = { '': 1, k: 1e3, m: 1e6 };
// Parses "200000", "200k" or "1m" into a token count; NaN when it is none.
function parseSize(value) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(value ?? ''));
    if (!m)
        return NaN;
    const scale = SCALES[m[2].toLowerCase()];
    return Math.round(Number(m[1]) * scale);
}
// Neither the hook input nor the transcript holds the context window, so
// take it from --window when set, then from the size the status line saved
// for the session. Otherwise assume Claude Code's default of 200k, and 1M
// once the context is past that.
function contextWindow(ctx, explicit, saved) {
    const size = parseSize(explicit);
    if (size > 0)
        return size;
    if (saved !== undefined && saved > 0)
        return saved;
    return ctx > 200e3 ? 1e6 : 200e3;
}
// Bars come in 5 or 10 cells; anything else falls back to 5.
const segmentsOf = (value) => (Number(value) === 10 ? 10 : 5);
// The bar styles, as the status line draws them without colour (see
// docs/adr/0007), with the cells each one has. The token line is plain
// text, so underline, which needs an underline code, draws as classic, and
// there is no pace marker. classic takes --segments.
const BAR_STYLES = {
    classic: { filled: '▓', empty: '░' },
    steps: { cells: 6, filled: '▅', empty: '▁' },
    rising: { cells: 3 },
    hairline: { cells: 8, filled: '━', empty: '─' },
    dots: { cells: 6, filled: '•', empty: '·' },
    spark: { cells: 1 },
    underline: { filled: '▓', empty: '░' },
};
// The value for the ctx bar in a per-bar list, such as steps,ctx=rising:
// its own, else the bare one, as the status line reads it. The token line's
// one bar is a ctx bar.
const forCtx = (list) => {
    let all = '';
    let ctx = '';
    for (const item of String(list).split(',')) {
        const [key, own] = item.split(/=(.*)/s).map((word) => word.trim().toLowerCase());
        if (own === undefined)
            all = key || all;
        else if (key === 'ctx' && own)
            ctx = own;
    }
    return ctx || all;
};
// The context bar in `style` (classic for an unknown name), with `segments`
// cells for classic.
const bar = (pct, segments, style = 'classic') => {
    const spec = Object.hasOwn(BAR_STYLES, style) ? BAR_STYLES[style] : BAR_STYLES.classic;
    const n = spec.cells ?? segments;
    if (style === 'spark')
        return '▁▂▃▄▅▆▇█'[Math.min(7, Math.max(0, Math.floor((pct * 8) / 100)))];
    if (style === 'rising') {
        const units = Math.round((pct * n * 5) / 100);
        return `${Array.from({ length: n }, (_, i) => ' ▁▂▃▄▅·'[Math.max(0, Math.min(5, units - i * 5)) || 6]).join('')}▕`;
    }
    const filled = Math.min(n, Math.max(0, Math.round((pct * n) / 100)));
    return (spec.filled ?? '').repeat(filled) + (spec.empty ?? '').repeat(n - filled);
};
// Local HH:MM, enough to tell runs apart in a scrollback.
const stamp = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// A human prompt, as opposed to a tool_result echoed back as a user record.
function isHumanPrompt(rec) {
    if (rec.type !== 'user' || rec.isMeta || rec.isSidechain)
        return false;
    const content = rec.message?.content;
    if (typeof content === 'string')
        return true;
    if (Array.isArray(content))
        return !content.some((b) => b?.type === 'tool_result');
    return false;
}
function tally(records) {
    const t = { reqs: 0, out: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, ctx: 0 };
    // The transcript writes one record per content block (thinking, text, each
    // tool_use), and every one of them carries the whole message's usage. Count
    // each API response once, by its message id, keeping its last record.
    const byMessage = new Map();
    for (const r of records) {
        if (r.message?.usage)
            byMessage.set(r.message.id ?? r.uuid, r);
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
// Builds the line from parsed transcript records; null when the run made no
// API request yet, or when none of the chosen parts has anything to show.
function summarize(records, { now = new Date(), window, savedWindow, segments, barStyle, show = PARTS } = {}) {
    let start = 0;
    for (let i = records.length - 1; i >= 0; i--) {
        if (isHumanPrompt(records[i])) {
            start = i;
            break;
        }
    }
    const run = tally(records.slice(start).filter((r) => r.type === 'assistant'));
    if (run.reqs === 0)
        return null;
    const build = {
        time: () => stamp(now),
        req: () => `${run.reqs} req`,
        // Thinking tokens are part of output_tokens, so show them inside it.
        out: () => (run.thinking ? `out ${fmt(run.out)} (${fmt(run.thinking)} think)` : `out ${fmt(run.out)}`),
        cache: () => `cache w${fmt(run.cacheWrite)} r${fmt(run.cacheRead)}`,
        ctx: () => {
            if (!run.ctx)
                return '';
            const pct = (run.ctx / contextWindow(run.ctx, window, savedWindow)) * 100;
            return `ctx ${Math.round(pct)}% ${bar(pct, segmentsOf(forCtx(segments ?? '')), forCtx(barStyle ?? '') || undefined)} ${fmt(run.ctx)}`;
        },
    };
    // A show list handed in from JavaScript may name parts the registry lacks;
    // those render as nothing, like a part with nothing to show.
    const anyPart = build;
    // The same separator as the status line.
    const line = show.map((part) => anyPart[part]?.() ?? '').filter(Boolean).join(' │ ');
    return line || null;
}
function readRecords(transcriptPath) {
    const records = [];
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
        if (!line)
            continue;
        try {
            records.push(JSON.parse(line));
        }
        catch {
            /* a partially flushed final line is expected */
        }
    }
    return records;
}
// Claude Code's config folder: $CLAUDE_CONFIG_DIR when it is set and not
// empty, else ~/.claude. The status line resolves it the same way, with its
// own copy, because each script runs alone from the copy that setup makes.
const configDirOf = (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
// The context window size the status line saved for `session`, from the
// payload Claude Code sends it at each render (ADR 0006); undefined when it
// saved none or the file cannot be read. src/statusline.ts writes the file,
// named the same way: the SHA-1 of the session id, then .json.
function savedWindowOf(session) {
    if (!session)
        return undefined;
    const name = `${(0, node_crypto_1.createHash)('sha1').update(session).digest('hex')}.json`;
    const file = path.join(configDirOf(process.env, os.homedir()), 'claude-gauge', '.state', 'windows', name);
    try {
        const size = Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.context_window_size);
        return Number.isFinite(size) && size > 0 ? size : undefined;
    }
    catch {
        return undefined;
    }
}
// A transcript's session id: its file name, as Claude Code names it.
const sessionOf = (transcriptPath) => path.basename(transcriptPath, '.jsonl');
function latestTranscript(cwd) {
    const projects = path.join(configDirOf(process.env, os.homedir()), 'projects');
    if (!fs.existsSync(projects))
        return null;
    // Claude Code exports the calling session's id to the commands it runs.
    // Prefer it: with several sessions open in one project, the newest
    // transcript is often another session's. Search every project folder, so a
    // `cd` into a worktree does not lose the session.
    const own = process.env.CLAUDE_CODE_SESSION_ID;
    if (own) {
        for (const d of fs.readdirSync(projects)) {
            const f = path.join(projects, d, `${own}.jsonl`);
            if (fs.existsSync(f))
                return f;
        }
    }
    const dir = path.join(projects, cwd.replace(/[/.]/g, '-'));
    if (!fs.existsSync(dir))
        return null;
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
//
// src/statusline.ts holds a copy of INSTRUCT_HOSTS, shellWord and
// instruction(), because each script runs alone and imports no shared
// module. Change both copies together. The test "the token line's
// --instruct code is the status line's, apart from the prose" in
// test/tokenline.test.js fails when they differ.
const INSTRUCT_HOSTS = ['claude-vscode', 'claude-desktop', 'claude-desktop-3p'];
exports.INSTRUCT_HOSTS = INSTRUCT_HOSTS;
// A shell word: as is when plain, else in single quotes. ~ stays bare so the
// shell expands a ~/ path.
const shellWord = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
function instruction(argv, { host, script }) {
    if (host === undefined || !INSTRUCT_HOSTS.includes(host))
        return null;
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
const isMain = (typeof require !== 'undefined' && require.main === module) || (typeof Bun !== 'undefined' && Bun.main === __filename);
if (isMain) {
    const argv = process.argv.slice(2);
    const { latest, ...opts } = parseArgs(argv);
    if (argv.includes('--instruct')) {
        const text = instruction(argv, { host: process.env.CLAUDE_CODE_ENTRYPOINT, script: ownPath() });
        if (text)
            process.stdout.write(text);
    }
    else if (latest) {
        const t = latestTranscript(process.cwd());
        const line = t ? summarize(readRecords(t), { ...opts, savedWindow: savedWindowOf(sessionOf(t)) }) : null;
        if (line)
            process.stdout.write(line + '\n');
    }
    else {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => {
            let line = null;
            try {
                const input = JSON.parse(Buffer.concat(chunks).toString());
                if (input.transcript_path && fs.existsSync(input.transcript_path)) {
                    const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : sessionOf(input.transcript_path);
                    line = summarize(readRecords(input.transcript_path), { ...opts, savedWindow: savedWindowOf(session) });
                }
            }
            catch {
                /* never break the turn over a reporting hook */
            }
            if (line)
                process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
        });
    }
}
