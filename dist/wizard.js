"use strict";
// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar size, theme and labels, and the token line
// and its parts, with a preview of the status line redrawn after each
// answer. configure starts from the bars set up now: the first answer keeps
// them, and each question offers the value set up. It returns the switches
// for each bar, as words, for the CLI to write; it reads and writes no
// settings itself.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndOfAnswers = exports.confirm = void 0;
exports.runWizard = runWizard;
exports.offerStar = offerStar;
exports.samplePayload = samplePayload;
exports.loadPayload = loadPayload;
exports.previewer = previewer;
exports.switchesFor = switchesFor;
const fs = require("node:fs");
const statusline_1 = require("./statusline");
const tokenline_1 = require("./tokenline");
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
// Asks until `read` takes the answer: it returns the value, or a retry that
// says why it cannot. Each `read` says what an empty answer, Enter, gives.
async function askFor(io, question, read) {
    for (;;) {
        const answer = await io.ask(question);
        if (answer === undefined)
            throw new EndOfAnswers();
        const value = read(answer.trim());
        if (typeof value === 'object' && value !== null && 'retry' in value) {
            io.write(`${value.retry}\n`);
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
const confirm = (io, question, fallback) => askFor(io, `${question} ${fallback ? '[Y/n]' : '[y/N]'} `, yesNo(fallback));
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
// The token line's switches for `parts`. Parts the installed switches show
// already keep those switches as they are. Other parts drop the installed
// --show and keep the rest. All five parts, in order, need no --show; any
// other list goes first, as --show <parts>.
function tokenSwitchesFor(parts, installed) {
    if (same(parts, tokenPartsOf(installed)))
        return installed;
    const others = (0, tokenline_1.readSwitches)(installed).filter(({ name }) => name !== '--show').flatMap(({ words }) => words);
    return same(parts, tokenline_1.PARTS) ? others : ['--show', parts.join(','), ...others];
}
// Reads the token line's parts: `all` for all five, else a list as readParts
// reads it.
function readTokenParts(fallback) {
    const list = readParts(fallback, tokenline_1.PARTS, `The token line parts are ${tokenline_1.PARTS.join(', ')}.`);
    return (answer) => (/^all$/i.test(answer) ? [...tokenline_1.PARTS] : list(answer));
}
async function runWizard(io, { preview, installed }) {
    const start = startFrom(installed);
    let status = { ...start.status };
    let tokenLine = start.tokenLine;
    const show = () => {
        const rows = preview(switchesFor(status));
        io.write(`\n${rows.split('\n').map((row) => `  ${row}`).join('\n')}\n`);
        io.write(`Token line: ${tokenLine ? 'on, when each turn ends' : 'off'}\n\n`);
    };
    if (isSetUp(installed)) {
        io.write(installed.statusLine ? 'The status line as set up now:\n' : 'The status line is not set up. With the defaults it shows:\n');
        show();
        if (await confirm(io, 'Keep the current bars as they are?', true))
            return {};
    }
    else {
        io.write('The status line with the defaults:\n');
        show();
        if (await confirm(io, 'Use the defaults: both bars, with the parts above?', true))
            return { statusLine: [], tokenLine: [] };
    }
    // A row set up, else the default row there.
    const rowAt = (i) => start.status.rows[i] ?? statusline_1.DEFAULT_ROWS[i];
    // More rows than the wizard offers stay possible when that many are set up.
    const rowsNow = start.status.rows.length;
    const maxRows = Math.max(MAX_ROWS, rowsNow);
    io.write(`\nThe parts: ${statusline_1.PARTS.join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`);
    const count = await askFor(io, `How many status line rows, 1 to ${maxRows}? [${rowsNow}] `, (answer) => {
        const n = answer ? Number(answer) : rowsNow;
        return Number.isInteger(n) && n >= 1 && n <= maxRows ? n : { retry: `Answer a number from 1 to ${maxRows}.` };
    });
    status = { ...status, rows: Array.from({ length: count }, (_, i) => rowAt(i) ?? []) };
    show();
    for (let i = 0; i < count; i++) {
        const fallback = rowAt(i);
        const hint = fallback ? ` [${fallback.join(',')}]` : '';
        const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${hint} `, readParts(fallback, statusline_1.PARTS));
        status = { ...status, rows: status.rows.map((row, j) => (j === i ? parts : row)) };
        show();
    }
    const segments = await askFor(io, `Cells per bar, ${SEGMENTS.join(' or ')}? [${start.status.segments}] `, (answer) => SEGMENTS.find((n) => String(n) === (answer || String(start.status.segments))) ?? { retry: `Answer ${SEGMENTS.join(' or ')}.` });
    status = { ...status, segments };
    show();
    const theme = await askFor(io, `Theme: ${statusline_1.THEMES.join(', ')}? [${start.status.theme}] `, (answer) => {
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
        const fallback = tokenPartsOf(start.tokenSwitches);
        const question = `Token line parts: all, req,out,ctx, or your own list from ${tokenline_1.PARTS.join(', ')}? [${fallback.join(',')}] `;
        tokenSwitches = tokenSwitchesFor(await askFor(io, question, readTokenParts(fallback)), start.tokenSwitches);
    }
    if (!(await confirm(io, 'Write these choices?', true)))
        return null;
    return { statusLine: switchesFor(status), tokenLine: tokenLine ? tokenSwitches : null };
}
const REPO = 'jv-k/claude-gauge';
// The end of setup: with gh at hand, offers to star the repo, and stars it
// only on a yes. Without gh it says nothing. The end of the input is a no.
async function offerStar(io, { hasGh, star }) {
    if (!hasGh())
        return;
    let yes;
    try {
        yes = await confirm(io, `Star ${REPO} on GitHub with gh?`, false);
    }
    catch (err) {
        if (err instanceof EndOfAnswers)
            return;
        throw err;
    }
    if (!yes)
        return;
    io.write(star() ? `Starred ${REPO}. Thank you.\n` : `gh could not star ${REPO}. Nothing else changed.\n`);
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
