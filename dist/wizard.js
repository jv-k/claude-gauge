"use strict";
// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar size, theme and labels, and the token line,
// its parts and its context window, with a preview of the status line
// redrawn after each answer. configure starts from the bars set up now: the
// first answer keeps them, and each question offers the value set up. It
// returns the switches for each bar, as words, for the CLI to write; it
// reads and writes no settings itself.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample. On
// a terminal each preview replaces the one before it, in place; with piped
// output each preview prints below the last.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndOfAnswers = exports.confirm = void 0;
exports.runWizard = runWizard;
exports.offerStar = offerStar;
exports.streamIo = streamIo;
exports.samplePayload = samplePayload;
exports.loadPayload = loadPayload;
exports.previewer = previewer;
exports.switchesFor = switchesFor;
const fs = require("node:fs");
const readline = require("node:readline");
const statusline_1 = require("./statusline");
const tokenline_1 = require("./tokenline");
const wordmark_1 = require("./wordmark");
const styles_1 = require("./styles");
// The input ended before the last question: nothing is written.
class EndOfAnswers extends Error {
    constructor() {
        super('The answers ended before the last question. Nothing changed.');
    }
}
exports.EndOfAnswers = EndOfAnswers;
const MAX_ROWS = 3;
const SEGMENTS = [5, 10];
const DEFAULT_CHOICES = { rows: statusline_1.DEFAULT_ROWS, segments: 5, theme: 'default', labels: true, others: [] };
// Whether two lists of parts, or of rows of parts, are the same, in order.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The fewest switches that give `choices`: none for the defaults, then the
// switches the wizard does not ask about. A row not chosen yet is left out.
function switchesFor({ rows, segments, theme, labels, others }) {
    const chosen = rows.filter((row) => row.length);
    const words = [];
    if (!same(chosen, statusline_1.DEFAULT_ROWS))
        for (const row of chosen)
            words.push('--show', row.join(','));
    if (segments !== 5)
        words.push('--segments', String(segments));
    if (theme !== 'default')
        words.push('--theme', theme);
    if (!labels)
        words.push('--no-labels');
    return [...words, ...others];
}
// The status line choices that `switches` give, read as the status line reads
// them, so the last --segments or --theme wins. A part name or theme the
// status line does not know reads as the status line shows it: left out, or
// the default theme.
function statusChoicesOf(switches) {
    const status = { ...DEFAULT_CHOICES, rows: [], others: [] };
    for (const { name, value, words } of (0, statusline_1.readSwitches)(switches)) {
        if (name === '--show') {
            const row = value.split(',').map((p) => p.trim()).filter((p) => statusline_1.PARTS.includes(p));
            if (row.length)
                status.rows.push(row);
        }
        else if (name === '--segments')
            status.segments = Number(value) === 10 ? 10 : 5;
        else if (name === '--theme')
            status.theme = statusline_1.THEMES.includes(value.trim()) ? value.trim() : 'default';
        else if (name === '--no-labels')
            status.labels = false;
        else
            status.others.push(...words);
    }
    if (!status.rows.length)
        status.rows = statusline_1.DEFAULT_ROWS;
    return status;
}
const isSetUp = (installed) => installed?.statusLine !== undefined || installed?.tokenLine !== undefined;
// The start from the bars set up, else from the factory defaults.
function startFrom(installed) {
    if (!isSetUp(installed))
        return { status: DEFAULT_CHOICES, tokenLine: true, tokenSwitches: [] };
    return {
        status: statusChoicesOf(installed.statusLine ?? []),
        tokenLine: installed.tokenLine !== undefined,
        tokenSwitches: installed.tokenLine ?? [],
    };
}
const stylesOf = (io) => (0, styles_1.styles)(io.color === true);
// A default in brackets, dim, such as [Y/n].
const hint = (s, value) => s.dim(`[${value}]`);
// Asks until `read` takes the answer: it returns the value, or a retry that
// says why it cannot. Each `read` says what an empty answer, Enter, gives.
// A magenta pill comes before the question, as VerBump's prompts have one:
// CONFIRM for a yes or no, INPUT for any other answer.
async function askFor(io, question, read, kind = 'INPUT') {
    const s = stylesOf(io);
    io.write(s.pill(kind, 'question'));
    for (;;) {
        const answer = await io.ask(question);
        if (answer === undefined)
            throw new EndOfAnswers();
        const value = read(answer.trim());
        if (typeof value === 'object' && value !== null && 'retry' in value) {
            io.write(s.warn(value.retry));
            continue;
        }
        return value;
    }
}
const yesNo = (fallback) => (answer) => {
    if (!answer)
        return fallback;
    if (/^y(?:es)?$/i.test(answer))
        return true;
    if (/^no?$/i.test(answer))
        return false;
    return { retry: 'Answer y or n.' };
};
const confirm = (io, question, fallback) => askFor(io, `${question} ${hint(stylesOf(io), fallback ? 'Y/n' : 'y/N')} `, yesNo(fallback), 'CONFIRM');
exports.confirm = confirm;
// Reads a list of parts from `known`, or `fallback` on Enter. An unknown
// part is asked again, named, with `where` to say which parts there are.
function readParts(fallback, known, where = 'The parts are listed above.') {
    return (answer) => {
        if (!answer && fallback)
            return fallback;
        const names = answer.split(/[\s,]+/).filter(Boolean);
        const unknown = names.filter((n) => !known.includes(n));
        if (unknown.length)
            return { retry: `Unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ${where}` };
        if (!names.length)
            return { retry: 'Name at least one part.' };
        return [...new Set(names)];
    };
}
// The parts the token line shows with `switches`, read as the token line
// reads them: all of them without a --show it can use.
const tokenPartsOf = (switches) => (0, tokenline_1.parseArgs)(switches).show ?? [...tokenline_1.PARTS];
// The token line's `switches` without each `name` switch and its value, as
// the token line reads them, so the rest stay as written.
const without = (switches, name) => (0, tokenline_1.readSwitches)(switches).filter((s) => s.name !== name).flatMap(({ words }) => words);
// The token line's switches for `parts`. Parts the installed switches show
// already keep those switches as they are. Other parts drop the installed
// --show and keep the rest. All five parts, in order, need no --show; any
// other list goes first, as --show <parts>.
function tokenSwitchesFor(parts, installed) {
    if (same(parts, tokenPartsOf(installed)))
        return installed;
    const others = without(installed, '--show');
    return same(parts, tokenline_1.PARTS) ? others : ['--show', parts.join(','), ...others];
}
// Reads the token line's parts: `all` for all five, else a list as readParts
// reads it.
function readTokenParts(fallback) {
    const list = readParts(fallback, tokenline_1.PARTS, `The token line parts are ${tokenline_1.PARTS.join(', ')}.`);
    return (answer) => (/^all$/i.test(answer) ? [...tokenline_1.PARTS] : list(answer));
}
// The context window the token line assumes at the first turn without a
// --window it can read.
const DEFAULT_WINDOW = (0, tokenline_1.contextWindow)(0);
// The context window `switches` name, as the token line reads them: the last
// --window's value, as written, or undefined without one it can read.
function tokenWindowOf(switches) {
    const value = (0, tokenline_1.parseArgs)(switches).window;
    return (0, tokenline_1.parseSize)(value) > 0 ? value : undefined;
}
// The token line's switches for a context window `size`. The size the
// installed --window gives keeps those switches as they are. Another size
// drops the installed --window and keeps the rest, then adds the size as
// --window <size>, unless it is the 200k the token line assumes without one.
function tokenSwitchesForWindow(size, installed) {
    if ((0, tokenline_1.parseSize)(size) === (0, tokenline_1.parseSize)(tokenWindowOf(installed)))
        return installed;
    const others = without(installed, '--window');
    return (0, tokenline_1.parseSize)(size) === DEFAULT_WINDOW ? others : [...others, '--window', size];
}
// Reads a context window size as the token line reads --window, in lower
// case: 200k, 1m or a count. Enter gives undefined, which keeps the switches
// as they are.
const readTokenWindow = (answer) => {
    if (!answer)
        return undefined;
    return (0, tokenline_1.parseSize)(answer) > 0 ? answer.toLowerCase() : { retry: 'Answer a size such as 200k or 1m.' };
};
// The wizard's io, which counts the screen rows written since the last
// preview: each newline, and each wrap of a line wider than the terminal,
// with a character counted one column wide, and colour codes and links,
// the only escapes the wizard and the preview write, counted as none. On a
// terminal the next preview moves the cursor up over those rows, clears
// them, and takes their place, so the questions asked under the old preview
// go with it. `clear` does the same with no preview to follow. Text written
// with `keep` stays: the next preview starts below it. With piped output
// every preview prints below the last, and `clear` does nothing.
function screenOf(io) {
    let rows = 0;
    let column = 0;
    let live = false;
    const count = (text) => {
        const width = io.terminal?.columns || Infinity;
        for (const ch of (0, statusline_1.stripOwnCodes)(text)) {
            if (ch === '\n') {
                rows++;
                column = 0;
            }
            else if (++column > width) {
                rows++;
                column = 1;
            }
        }
    };
    const write = (text) => {
        io.write(text);
        count(text);
    };
    const clear = () => {
        if (io.terminal && live)
            io.write(`\r${rows ? `\x1b[${rows}A` : ''}\x1b[J`);
        rows = 0;
        column = 0;
        live = false;
    };
    const screen = {
        color: io.color,
        terminal: io.terminal,
        write,
        // The answer's line ends before the next write, so the cursor is at the
        // start of the row after the question.
        ask: async (question) => {
            const answer = await io.ask(question);
            count(`${question}${answer ?? ''}\n`);
            return answer;
        },
        keep: (text) => {
            write(text);
            live = false;
        },
        preview: (text) => {
            clear();
            live = true;
            write(text);
        },
        clear,
    };
    return screen;
}
async function runWizard(userIo, { preview, installed }) {
    const io = screenOf(userIo);
    const s = stylesOf(io);
    const start = startFrom(installed);
    let status = { ...start.status };
    let tokenLine = start.tokenLine;
    // The preview in the status line's own colours, or as plain text when the
    // questions take no colour, under `heading` when one is given.
    const show = (heading = '') => {
        const rendered = preview(switchesFor(status));
        const rows = io.color ? rendered : (0, statusline_1.stripOwnCodes)(rendered);
        io.preview(`${heading}\n${rows.split('\n').map((row) => `  ${row}`).join('\n')}\nToken line: ${tokenLine ? 'on, when each turn ends' : 'off'}\n`);
    };
    if (isSetUp(installed)) {
        show(installed.statusLine ? 'The status line as set up now:\n' : 'The status line is not set up. With the defaults it shows:\n');
        if (await confirm(io, 'Keep the current bars as they are?', true))
            return {};
    }
    else {
        show('The status line with the defaults:\n');
        if (await confirm(io, 'Use the defaults: both bars, with the parts above?', true))
            return { statusLine: [], tokenLine: [] };
    }
    // A row set up, else the default row there.
    const rowAt = (i) => start.status.rows[i] ?? statusline_1.DEFAULT_ROWS[i];
    // More rows than the wizard offers stay possible when that many are set up.
    const rowsNow = start.status.rows.length;
    const maxRows = Math.max(MAX_ROWS, rowsNow);
    // The customise path starts below the questions, where the first preview
    // and the question under it were: the next preview takes their place.
    io.clear();
    io.keep(`${s.pill('Status line')}The parts: ${statusline_1.PARTS.map(s.value).join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`);
    const count = await askFor(io, `How many status line rows, 1 to ${maxRows}? ${hint(s, rowsNow)} `, (answer) => {
        const n = answer ? Number(answer) : rowsNow;
        return Number.isInteger(n) && n >= 1 && n <= maxRows ? n : { retry: `Answer a number from 1 to ${maxRows}.` };
    });
    status = { ...status, rows: Array.from({ length: count }, (_, i) => rowAt(i) ?? []) };
    show();
    for (let i = 0; i < count; i++) {
        const fallback = rowAt(i);
        const brackets = fallback ? ` ${hint(s, fallback.join(','))}` : '';
        const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${brackets} `, readParts(fallback, statusline_1.PARTS));
        status = { ...status, rows: status.rows.map((row, j) => (j === i ? parts : row)) };
        show();
    }
    const segments = await askFor(io, `Cells per bar, ${SEGMENTS.join(' or ')}? ${hint(s, start.status.segments)} `, (answer) => SEGMENTS.find((n) => String(n) === (answer || String(start.status.segments))) ?? { retry: `Answer ${SEGMENTS.join(' or ')}.` });
    status = { ...status, segments };
    show();
    const theme = await askFor(io, `Theme: ${statusline_1.THEMES.join(', ')}? ${hint(s, start.status.theme)} `, (answer) => {
        const name = answer.toLowerCase() || start.status.theme;
        return statusline_1.THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${statusline_1.THEMES.join(', ')}.` };
    });
    status = { ...status, theme };
    show();
    status = { ...status, labels: await confirm(io, 'Labels in front of the values, such as ctx and 5h?', start.status.labels) };
    show();
    tokenLine = await confirm(io, 'Add the token line, shown when each turn ends?', start.tokenLine);
    show();
    let tokenSwitches = start.tokenSwitches;
    if (tokenLine) {
        io.keep(s.pill('Token line'));
        const fallback = tokenPartsOf(start.tokenSwitches);
        const question = `Token line parts: all, req,out,ctx, or your own list from ${tokenline_1.PARTS.map(s.value).join(', ')}? ${hint(s, fallback.join(','))} `;
        tokenSwitches = tokenSwitchesFor(await askFor(io, question, readTokenParts(fallback)), start.tokenSwitches);
        io.write(s.info('The token line cannot read the context window, so it assumes 200k until the context grows past it.'));
        const window = await askFor(io, `Context window, 200k or 1m? ${hint(s, tokenWindowOf(start.tokenSwitches) ?? '200k')} `, readTokenWindow);
        if (window !== undefined)
            tokenSwitches = tokenSwitchesForWindow(window, tokenSwitches);
    }
    if (!(await confirm(io, 'Write these choices?', true)))
        return null;
    return { statusLine: switchesFor(status), tokenLine: tokenLine ? tokenSwitches : null };
}
const REPO = 'jv-k/claude-gauge';
// The end of setup: with gh at hand, offers to star the repo, and stars it
// on a yes or Enter. Without gh it says nothing. The end of the input is a no.
async function offerStar(io, { hasGh, star }) {
    if (!hasGh())
        return;
    let yes;
    try {
        yes = await confirm(io, `Star ${REPO} on GitHub with gh?`, true);
    }
    catch (err) {
        if (err instanceof EndOfAnswers)
            return;
        throw err;
    }
    if (!yes)
        return;
    const s = stylesOf(io);
    io.write(star() ? s.ok(`Starred ${s.value(REPO)}. Thank you.`) : s.warn(`gh could not star ${s.value(REPO)}. Nothing else changed.`));
}
// A status payload to preview with when the status line has saved none:
// two-fifths of the context, and a 5-hour and a weekly window part used.
function samplePayload(nowMs) {
    const at = (ms) => Math.floor((nowMs + ms) / 1000);
    const hour = 3600 * 1000;
    return {
        model: { display_name: 'Opus' },
        effort: { level: 'high' },
        workspace: { current_dir: process.cwd() },
        context_window: { context_window_size: 200000, used_percentage: 43 },
        rate_limits: {
            five_hour: { used_percentage: 9, resets_at: at(2 * hour) },
            seven_day: { used_percentage: 41, resets_at: at(3 * 24 * hour) },
        },
        cost: { total_duration_ms: 72 * 60 * 1000 },
    };
}
// The payload the status line saved, or the sample when there is none, or
// none that reads as a payload: a JSON object that holds something.
function loadPayload(file, nowMs = Date.now()) {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof saved === 'object' && saved !== null && !Array.isArray(saved) && Object.keys(saved).length)
            return saved;
    }
    catch {
        /* no payload saved yet, or half of one */
    }
    return samplePayload(nowMs);
}
// The preview: the status line's rows for `payload`, with the given switches
// as words, as the settings command passes them.
function previewer(payload, options = {}) {
    return (switches) => (0, statusline_1.render)(payload, { ...options, config: (0, statusline_1.parseArgs)([...switches]) });
}
// The questions on a pair of streams: each prompt on `output`, each answer a
// line of `input`. Lines are queued as they arrive, so answers piped in all
// at once each reach their question. A terminal echoes each answer and its
// Enter; a piped answer is not, so the io writes it and ends its line
// itself, as a terminal would show it, and a retry or a preview never runs
// on from the question. The questions are in
// colour when the colour gate allows, and redraw the preview in place when
// `output` is a terminal.
function streamIo(input, output, color = (0, wordmark_1.colorEnabled)(output)) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const lines = rl[Symbol.asyncIterator]();
    return {
        color,
        terminal: output.isTTY ? output : undefined,
        ask: async (question) => {
            output.write(question);
            const next = await lines.next();
            if (!input.isTTY)
                output.write(`${next.done ? '' : next.value}\n`);
            return next.done ? undefined : next.value;
        },
        write: (text) => {
            output.write(text);
        },
        close: () => rl.close(),
    };
}
