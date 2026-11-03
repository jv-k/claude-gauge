"use strict";
// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar style, bar size, theme and labels, and the
// token line and its parts, with a preview of the status line redrawn after
// each answer. With lines set up, the first answer keeps them, changes them,
// each question offering the value set up, or starts over from the defaults.
// It returns the switches for each line, as words, for the CLI to write; it
// reads and writes no settings itself.
//
// The questions are a list of steps, which the answers so far make: a step
// for each row, and where the front end asks for an order, a step for the
// order of the rows. At any step
// the user can go back, with Esc or a typed <: the wizard lists the steps
// before it, and asks again from the one picked. Each step offers the value
// chosen last, so the answers after it stay.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample. On
// a terminal each preview replaces the one before it, in place; with piped
// output each preview prints below the last.
//
// Two front ends ask the same questions, with the same defaults, and give the
// same answers. The readline one reads a typed line for each question. The
// Ink one (ink-io.ts) offers each as a choice: the arrow keys and Enter for
// one option, the row editor for the parts of a row, and the preview redrawn as
// the selection moves. openIo picks Ink when stdin and stdout are both a
// terminal and Ink loads, and the readline one otherwise.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAMPLE_RUN = exports.DEFAULT_SWITCHES = exports.GoBack = exports.Interrupted = exports.EndOfAnswers = exports.confirm = void 0;
exports.runWizard = runWizard;
exports.offerStar = offerStar;
exports.streamIo = streamIo;
exports.openIo = openIo;
exports.samplePayload = samplePayload;
exports.loadPayload = loadPayload;
exports.previewer = previewer;
exports.tokenPreviewer = tokenPreviewer;
exports.switchesFor = switchesFor;
const fs = require("node:fs");
const readline = require("node:readline");
const statusline_1 = require("./statusline");
const tokenline_1 = require("./tokenline");
const wordmark_1 = require("./wordmark");
const styles_1 = require("./styles");
// The input ended before the last question: nothing is written.
class EndOfAnswers extends Error {
    constructor(message = 'The answers ended before the last question. Nothing changed.') {
        super(message);
    }
}
exports.EndOfAnswers = EndOfAnswers;
// Ctrl+C stopped the questions: nothing is written, as at the end of the
// input. The star offer, after the settings are written, says so instead.
class Interrupted extends EndOfAnswers {
    constructor(message = 'Stopped at Ctrl+C. Nothing changed.') {
        super(message);
    }
}
exports.Interrupted = Interrupted;
// The user asked to go back: the wizard offers the steps answered so far, to
// go back to one of them. Not an EndOfAnswers, as nothing has stopped.
class GoBack extends Error {
    constructor(message = 'Go back to an earlier step.') {
        super(message);
    }
}
exports.GoBack = GoBack;
// The typed answer that goes back.
const BACK = '<';
const MAX_ROWS = 3;
// The parts a row with no default of its own starts with: the first
// EXTRA_ROW_SIZE of these that no row before it shows, so a third row
// shows something new.
const EXTRA_ROW_PARTS = ['cost', 'lines', 'git', 'todos', 'tools', 'agents', 'reply', 'version'];
const EXTRA_ROW_SIZE = 4;
const extraRow = (shown) => {
    const parts = EXTRA_ROW_PARTS.filter((part) => !shown.includes(part)).slice(0, EXTRA_ROW_SIZE);
    return parts.length ? parts : undefined;
};
const SEGMENTS = ['5', '10'];
// The status line's choices with no switches, as it reads them.
const NO_SWITCHES = {
    rows: statusline_1.DEFAULT_ROWS,
    barStyle: { all: 'classic', each: {} },
    segments: { all: '5', each: {} },
    theme: 'default',
    labels: true,
    others: [],
};
// The defaults a new setup offers and writes: the same, but in the dots bar
// style. The status line's own default stays classic, so a line set up
// before, with no --bar-style, keeps its bars after an update.
const DEFAULT_BAR_STYLE = 'dots';
const DEFAULT_CHOICES = { ...NO_SWITCHES, barStyle: { all: DEFAULT_BAR_STYLE, each: {} } };
// The switches the defaults give each line, as setup --yes writes them.
const DEFAULT_SWITCHES = ['--bar-style', DEFAULT_BAR_STYLE];
exports.DEFAULT_SWITCHES = DEFAULT_SWITCHES;
// A per-bar list read with only the values in `values`: any other reads as
// `fallback`, as the status line reads an unknown name or size.
function barValuesOf(list, values, fallback) {
    const { all, each } = (0, statusline_1.perBarOf)(list);
    const known = (value) => (values.includes(value) ? value : fallback);
    return { all: known(all), each: Object.fromEntries(Object.entries(each).map(([bar, value]) => [bar, known(value)])) };
}
// The value of `bar`: its own, else the one for every bar.
const valueAt = ({ all, each }, bar) => each[bar] ?? all;
// The values for `all` and each of `bars`, keeping only the bars whose value
// differs from all.
const barValuesFrom = (all, bars, each) => ({
    all,
    each: Object.fromEntries(bars.flatMap((bar, i) => (each[i] === all ? [] : [[bar, each[i]]]))),
});
// Reads a typed per-bar list, such as steps,ctx=rising: each entry a value
// from `values`, bare for every bar or after a bar's name for that bar. A
// list with no bare value changes only the bars it names in `fallback`;
// Enter keeps all of it.
function readBarValues(answer, fallback, values, what, example) {
    if (!answer.trim())
        return fallback;
    for (const item of answer.split(',')) {
        const [key, value] = item.split(/=(.*)/s).map((word) => word.trim().toLowerCase());
        const known = value === undefined ? values.includes(key) : statusline_1.BARS.includes(key) && values.includes(value);
        if (!known)
            return { retry: `Unknown ${what}: ${item.trim()}. Answer one of ${values.join(', ')}, or a list such as ${example}.` };
    }
    const { all, each } = (0, statusline_1.perBarOf)(answer);
    return all ? { all, each } : { all: fallback.all, each: { ...fallback.each, ...each } };
}
// Whether two lists of parts, or of rows of parts, are the same, in order.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The fewest switches that give `choices`: none for the defaults, then the
// switches the wizard does not ask about. A row not chosen yet is left out.
function switchesFor({ rows, barStyle, segments, theme, labels, others }) {
    const chosen = rows.filter((row) => row.length);
    const words = [];
    if (!same(chosen, statusline_1.DEFAULT_ROWS))
        for (const row of chosen)
            words.push('--show', row.join(','));
    if ((0, statusline_1.perBarList)(barStyle) !== 'classic')
        words.push('--bar-style', (0, statusline_1.perBarList)(barStyle));
    if ((0, statusline_1.perBarList)(segments) !== '5')
        words.push('--segments', (0, statusline_1.perBarList)(segments));
    if (theme !== 'default')
        words.push('--theme', theme);
    if (!labels)
        words.push('--no-labels');
    return [...words, ...others];
}
// The status line choices that `switches` give, read as the status line reads
// them, so the last --bar-style, --segments or --theme wins. A part name or theme the
// status line does not know reads as the status line shows it: left out, or
// the default theme.
function statusChoicesOf(switches) {
    const status = { ...NO_SWITCHES, rows: [], others: [] };
    for (const { name, value, words } of (0, statusline_1.readSwitches)(switches)) {
        if (name === '--show') {
            const row = value.split(',').map((p) => p.trim()).filter((p) => statusline_1.PARTS.includes(p));
            if (row.length)
                status.rows.push(row);
        }
        else if (name === '--bar-style')
            status.barStyle = barValuesOf(value, statusline_1.BAR_STYLES, 'classic');
        else if (name === '--segments')
            status.segments = barValuesOf(value, SEGMENTS, '5');
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
// CONFIRM for a yes or no, INPUT for any other answer. A front end with
// choices asks with `pick` instead, the same question as a choice.
async function askFor(io, question, read, kind = 'INPUT', pick) {
    if (io.choices && pick)
        return pick(io.choices);
    const s = stylesOf(io);
    io.write(s.pill(kind, 'question'));
    for (;;) {
        const answer = await io.ask(question);
        if (answer === undefined)
            throw new EndOfAnswers();
        if (answer.trim() === BACK)
            throw new GoBack();
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
// A yes or no, `fallback` on Enter. As a choice, Yes and No, with `preview`
// for the preview each gives.
const confirm = (io, question, fallback, preview) => askFor(io, `${question} ${hint(stylesOf(io), fallback ? 'Y/n' : 'y/N')} `, yesNo(fallback), 'CONFIRM', (c) => c.one({ kind: 'CONFIRM', message: question, options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], initial: fallback ? 0 : 1, preview }));
exports.confirm = confirm;
// A choice of one of `values`, shown as written, `fallback` first.
const oneOf = (message, values, fallback, preview, moving = false) => (c) => c.one({ kind: 'INPUT', message, options: values.map((value) => ({ label: String(value), value })), initial: Math.max(0, values.indexOf(fallback)), preview, moving });
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
// The token line's `switches` with the status line's ctx bar style, so the
// two ctx bars look alike. classic needs no switch.
const withBarStyle = (switches, barStyle) => {
    const ctx = valueAt(barStyle, 'ctx');
    return [...without(switches, '--bar-style'), ...(ctx === 'classic' ? [] : ['--bar-style', ctx])];
};
// Reads the token line's parts: `all` for all five, else a list as readParts
// reads it.
function readTokenParts(fallback) {
    const list = readParts(fallback, tokenline_1.PARTS, `The token line parts are ${tokenline_1.PARTS.join(', ')}.`);
    return (answer) => (/^all$/i.test(answer) ? [...tokenline_1.PARTS] : list(answer));
}
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
        io.choices?.preview('');
        if (io.terminal && live)
            io.write(`\r${rows ? `\x1b[${rows}A` : ''}\x1b[J`);
        rows = 0;
        column = 0;
        live = false;
    };
    const screen = {
        color: io.color,
        terminal: io.terminal,
        choices: io.choices,
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
        // A front end with choices shows the preview with its questions, and
        // takes the function, to call as often as it redraws.
        preview: (text) => {
            if (io.choices)
                return io.choices.preview(text);
            clear();
            live = true;
            write(typeof text === 'function' ? text() : text);
        },
        clear,
    };
    return screen;
}
const START_OPTIONS = [
    { label: 'Keep them as they are', value: 'keep', words: ['keep', 'k'] },
    { label: 'Change them', value: 'change', words: ['change', 'c'] },
    { label: 'Start over from the defaults', value: 'over', words: ['over', 'o', 'start over', 's'] },
];
// The ids of the status line's own steps, from the number of rows to the
// labels.
const STATUS_STEPS = /^(rows|parts|row \d+|rows order|bar style|cells|theme|labels)$/;
// The preview's heading for the factory defaults.
const WITH_DEFAULTS = 'Status line, with the defaults';
// The questions, then the switches for each bar. A front end with choices
// shows no preview once they end, so a question after them, such as the star
// offer, comes without one.
async function runWizard(userIo, options) {
    try {
        return await askAll(userIo, options);
    }
    finally {
        userIo.choices?.preview('');
    }
}
// The longest answer the list of steps shows: a longer one ends in an
// ellipsis.
const STEP_VALUE = 56;
// The steps as the list of steps shows them: each name padded to the
// longest, then its answer.
const stepLabels = (steps) => {
    const width = Math.max(...steps.map((step) => step.name.length));
    const cut = (value) => (value.length > STEP_VALUE ? `${value.slice(0, STEP_VALUE - 1)}…` : value);
    return steps.map((step) => (step.value ? `${step.name.padEnd(width)}   ${cut(step.value)}` : step.name));
};
// Asks which of `earlier` steps to go back to, the one before `current`
// first, or none to stay at `current`: the index of the step, or -1. The
// list ends with `current`, marked as where the user is, which stays, as
// Enter does when typed and Esc does here.
async function pickStep(io, earlier, current) {
    const s = stylesOf(io);
    if (!earlier.length) {
        io.write(s.info('There is no earlier step.'));
        return -1;
    }
    const stay = -1;
    const all = stepLabels([...earlier, current]);
    const labels = all.slice(0, -1);
    // A step with no answer yet, such as the last, has the marker in the
    // answers' column.
    const nameWidth = Math.max(...[...earlier, current].map((step) => step.name.length));
    const here = `${current.value ? all[all.length - 1] : current.name.padEnd(nameWidth)}   ${s.dim('← you are here')}`;
    try {
        if (!io.choices) {
            const width = String(labels.length).length;
            const numbered = labels.map((label, i) => `  ${String(i + 1).padStart(width)}. ${label}`);
            io.write(`${s.pill('Go back')}${[...numbered, `  ${' '.repeat(width + 2)}${here}`].join('\n')}\n`);
        }
        return await askFor(io, `Go back to which step, 1 to ${earlier.length}? ${s.key('Enter')} stays at ${current.name}. `, (answer) => {
            if (!answer)
                return stay;
            const n = Number(answer);
            return Number.isInteger(n) && n >= 1 && n <= earlier.length ? n - 1 : { retry: `Answer a number from 1 to ${earlier.length}, or Enter to stay.` };
        }, 'INPUT', (c) => c.one({
            kind: 'INPUT',
            message: 'Go back to which step?',
            hint: 'The answers after it stay as they are.',
            options: [...labels.map((label, i) => ({ label, value: i, answer: earlier[i].name })), { label: here, value: stay, answer: `${current.name}, where you are` }],
            initial: earlier.length - 1,
        }));
    }
    catch (err) {
        if (err instanceof GoBack)
            return stay;
        throw err;
    }
}
// What each token line part shows, for the row editor's note.
const TOKEN_NOTES = {
    time: 'the local time the turn ended',
    req: 'API requests made since your last prompt, subagents included',
    out: 'output tokens, and how many of them were thinking',
    cache: 'prompt-cache writes and reads',
    ctx: 'the context the last request carried, as a share of the window and as a bar',
};
async function askAll(userIo, { preview, tokenPreview = tokenPreviewer(), installed }) {
    const io = screenOf(userIo);
    const s = stylesOf(io);
    const setUp = isSetUp(installed);
    let start = startFrom(installed);
    let status = { ...start.status };
    let tokenLine = start.tokenLine;
    let tokenSwitches = start.tokenSwitches;
    // The answer to the first question when lines are set up, once given.
    let startAnswer;
    // Whether the defaults question is asked: on a first setup, and on a start
    // over.
    const fresh = () => !setUp || startAnswer === 'over';
    // Each row's parts as last chosen, kept when the number of rows goes down,
    // so a row added back in the same run comes back with them.
    let lastRows = [];
    // The rows that have the set of parts a row with no default of its own
    // starts with, and that are not answered yet. Each is made again from the
    // rows before it when it is asked, as those may have changed since.
    const autoRows = new Set();
    // Whether the step being asked is one of the status line's own, whose
    // preview leaves the token line out.
    let statusOnly = false;
    // Whether the customise path's heading, and the token line's, are written
    // yet.
    let headed = false;
    let tokenHeaded = false;
    const order = io.choices?.order?.bind(io.choices);
    const rowsEditor = io.choices?.rows?.bind(io.choices);
    const gutter = (marked) => (marked ? `${s.select('❯')} ` : '  ');
    // A preview line, after `gutter`, with its marked part, if it has one, in
    // red-pink brackets.
    const bracketed = (line, lead) => `${lead}${line.replace(statusline_1.MARK_START, s.select('[')).replace(statusline_1.MARK_END, s.select(']'))}`;
    const previewOf = (choices, { tokenLine: on = tokenLine, heading = 'Status line', tokenSwitches: token = tokenSwitches, moving = false, mark, tokenMark } = {}) => {
        // The status line leaves out a row with no parts, so a row's line is
        // the one after the rows before it that have parts.
        const lineOf = (row) => choices.rows.slice(0, row).filter((parts) => parts.length).length;
        const part = mark?.part === undefined ? undefined : { row: lineOf(mark.row), part: mark.part };
        const rendered = preview(switchesFor(choices), !io.color, moving, part);
        const lines = (io.color ? rendered : (0, statusline_1.stripOwnCodes)(rendered)).split('\n');
        // Each row, and a faint line in place of a row with no parts yet.
        const rows = choices.rows.map((parts, i) => bracketed(mark?.row === i && mark.whole ? `${statusline_1.MARK_START}${lines[lineOf(i)] ?? ''}${statusline_1.MARK_END}` : parts.length ? (lines[lineOf(i)] ?? '') : s.dim(`row ${i + 1}: no parts yet`), gutter(mark?.row === i)));
        const statusBlock = `\n${s.dim(heading)}\n\n${rows.join('\n')}\n`;
        // The status line's own steps show the status line alone: the token
        // line comes after it.
        if (statusOnly)
            return statusBlock;
        let tokenBlock = s.dim('Token line: off');
        if (on) {
            const line = tokenPreview(withBarStyle(token, choices.barStyle), tokenMark?.part);
            tokenBlock = `${s.dim('Token line, when each turn ends')}\n\n${bracketed(io.color ? line : (0, statusline_1.stripOwnCodes)(line), gutter(tokenMark !== undefined))}`;
        }
        return `${statusBlock}\n${tokenBlock}\n`;
    };
    // A function, so a front end that animates the preview can redraw it.
    const show = (heading, parts = {}) => {
        const now = status;
        const line = tokenLine;
        io.preview(() => previewOf(now, { tokenLine: line, heading, ...parts }));
    };
    // The preview with `change` made to the choices so far, for a choice whose
    // selection moves.
    const previewWith = (change, parts = {}) => previewOf({ ...status, ...change }, parts);
    // A value for every bar, and each bar's own, from `values`. Typed, a list
    // such as steps,ctx=rising, Enter for `fallback`. As a choice, a tab for
    // All and one for each of `bars`, or one plain choice for a single bar.
    const askPerBar = (typed, message, values, fallback, bars, previewFor, { what, example, moving = false, note }) => {
        const options = values.map((value) => ({ label: value, value }));
        return askFor(io, `${typed} ${hint(s, (0, statusline_1.perBarList)(fallback))} `, (answer) => readBarValues(answer, fallback, values, what, example), 'INPUT', async (c) => {
            if (bars.length === 1) {
                // One bar: its choice alone, by its own name.
                const one = { all: valueAt(fallback, bars[0]), each: [] };
                const { all } = await c.each({
                    message,
                    targets: [],
                    allLabel: bars[0],
                    options,
                    initial: one,
                    note,
                    rows: status.rows,
                    preview: (v, _, at) => previewFor({ all: v, each: {} }, at),
                    moving,
                });
                return { all, each: {} };
            }
            const initial = { all: fallback.all, each: bars.map((bar) => valueAt(fallback, bar)) };
            const chosen = await c.each({
                message,
                targets: bars,
                options,
                initial,
                note,
                rows: status.rows,
                preview: (all, each, at) => previewFor(barValuesFrom(all, bars, each), at),
                moving,
            });
            return barValuesFrom(chosen.all, bars, chosen.each);
        });
    };
    // A row as chosen so far, else as set up, else the default row there.
    // A row with none of those, such as a third row, gets a set of its own,
    // from the parts no row before it shows.
    const knownRow = (i) => [status.rows[i], lastRows[i], start.status.rows[i], statusline_1.DEFAULT_ROWS[i]].find((row) => row?.length);
    const rowAt = (i) => knownRow(i) ?? extraRow(status.rows.slice(0, i).flat());
    const rowsFor = (n) => Array.from({ length: n }, (_, i) => rowAt(i) ?? []);
    // More rows than the wizard offers stay possible when that many are set up.
    const maxRows = () => Math.max(MAX_ROWS, start.status.rows.length);
    // The bars in classic style that a row shows: only those draw their cells.
    const classicBars = () => statusline_1.BARS.filter((bar) => valueAt(status.barStyle, bar) === 'classic' && status.rows.some((row) => row.includes(bar)));
    const yesNoWord = (yes) => (yes ? 'yes' : 'no');
    // With lines set up: keep them, change them from where they are, or start
    // over from the defaults, as a first setup does. A new answer starts from
    // the lines it names; the same answer again keeps the choices made since.
    const startStep = () => ({
        id: 'start',
        name: 'Keep, change or start over',
        value: startAnswer === 'over' ? 'start over' : 'change',
        run: async () => {
            if (!isSetUp(installed))
                return undefined;
            const heading = installed.statusLine ? 'Status line, as set up now' : 'Status line: not set up. With the defaults, it shows';
            const setUpStart = startFrom(installed);
            const defaults = startFrom(undefined);
            const asSetUp = () => previewOf(setUpStart.status, { tokenLine: setUpStart.tokenLine, heading, tokenSwitches: setUpStart.tokenSwitches });
            io.preview(asSetUp);
            const answer = await askFor(io, `Keep the current lines, change them, or start over from the defaults? keep, change or over ${hint(s, 'keep')} `, (typed) => START_OPTIONS.find((o) => o.words.includes(typed.trim().toLowerCase() || 'keep'))?.value ?? { retry: 'Answer keep, change or over.' }, 'INPUT', (c) => c.one({
                kind: 'INPUT',
                message: 'Keep the current lines, change them, or start over?',
                options: START_OPTIONS,
                initial: 0,
                preview: (value) => value === 'over' ? previewOf(defaults.status, { tokenLine: defaults.tokenLine, heading: WITH_DEFAULTS, tokenSwitches: defaults.tokenSwitches }) : asSetUp(),
            }));
            if (answer === 'keep') {
                const linesOf = (choices, on, token) => JSON.stringify([switchesFor(choices), on && withBarStyle(token, choices.barStyle)]);
                const changed = startAnswer !== undefined && linesOf(status, tokenLine, tokenSwitches) !== linesOf(setUpStart.status, setUpStart.tokenLine, setUpStart.tokenSwitches);
                if (changed)
                    io.write(s.info('Kept the lines as set up. The changes made in this run are not written.'));
                return { end: {} };
            }
            if (answer !== startAnswer) {
                lastRows = [];
                autoRows.clear();
                start = answer === 'over' ? defaults : setUpStart;
                status = { ...start.status };
                tokenLine = start.tokenLine;
                tokenSwitches = start.tokenSwitches;
            }
            startAnswer = answer;
            return undefined;
        },
    });
    const defaultsStep = () => ({
        id: 'defaults',
        name: 'Use the defaults',
        value: 'no',
        run: async () => {
            const defaults = startFrom(undefined);
            io.preview(() => previewOf(defaults.status, { tokenLine: defaults.tokenLine, heading: WITH_DEFAULTS, tokenSwitches: defaults.tokenSwitches }));
            if (await confirm(io, 'Use the defaults: both lines, with the parts above?', true)) {
                return { end: { statusLine: switchesFor(defaults.status), tokenLine: withBarStyle(defaults.tokenSwitches, defaults.status.barStyle) } };
            }
            return undefined;
        },
    });
    // The number of rows. The customise path starts below the questions before
    // it, where the first preview and the question under it were: the next
    // preview takes their place.
    const rowsStep = () => ({
        id: 'rows',
        name: 'Rows',
        value: String(status.rows.length),
        run: async () => {
            if (headed)
                show();
            else {
                io.clear();
                // Info lines are faint, with each key bold.
                const keys = io.choices
                    ? `${s.dim('Press')} ${s.key('Enter')} ${s.dim('to keep an answer as it is, and')} ${s.key('Esc')} ${s.dim('to go back to an earlier step.')}`
                    : `${s.dim('Press')} ${s.key('Enter')} ${s.dim('to keep the value in brackets, and answer')} ${s.key(BACK)} ${s.dim('to go back to an earlier step.')}`;
                io.keep(`${s.pill('Status line')}${s.dim('The parts:')} ${statusline_1.PARTS.map(s.value).join(s.dim(', '))}${s.dim('.')}\n\n${s.dim('What each part shows:')} ${partsLink(io.color === true, s)}\n\n${keys}\n`);
                headed = true;
            }
            const now = status.rows.length;
            const most = maxRows();
            const counts = Array.from({ length: most }, (_, i) => i + 1);
            const count = await askFor(io, `How many status line rows, 1 to ${most}? ${hint(s, now)} `, (answer) => {
                const n = answer ? Number(answer) : now;
                return Number.isInteger(n) && n >= 1 && n <= most ? n : { retry: `Answer a number from 1 to ${most}.` };
            }, 'INPUT', oneOf('How many status line rows?', counts, now, (n) => previewWith({ rows: rowsFor(n) })));
            for (let i = status.rows.length; i < count; i++)
                if (!knownRow(i))
                    autoRows.add(i);
            lastRows = rowsFor(Math.max(count, status.rows.length, lastRows.length));
            status = { ...status, rows: rowsFor(count) };
            return undefined;
        },
    });
    const withRow = (i, parts) => status.rows.map((row, j) => (j === i ? parts : row));
    // The parts of row `i`: in the row editor, where the front end has one,
    // else as a list to tick, those of the row kept in their order, then each
    // part ticked since.
    const rowStep = (i) => ({
        id: `row ${i}`,
        name: `Row ${i + 1}`,
        value: status.rows[i]?.join(', ') || 'no parts yet',
        run: async () => {
            show(undefined, { mark: { row: i } });
            if (autoRows.has(i))
                status = { ...status, rows: withRow(i, extraRow(status.rows.slice(0, i).flat()) ?? []) };
            const fallback = status.rows[i]?.length ? status.rows[i] : undefined;
            const brackets = fallback ? ` ${hint(s, fallback.join(','))}` : '';
            // What `part` shows, and the other rows that show it, for the row
            // editor's note.
            const note = (part) => {
                const others = status.rows.flatMap((row, j) => (j !== i && row.includes(part) ? [j + 1] : []));
                return `${s.value(part)} ${s.dim(`${(0, statusline_1.describePart)(part)}.${others.length ? ` Also in row ${others.join(' and ')}.` : ''}`)}`;
            };
            const question = {
                message: `Row ${i + 1}: the parts`,
                options: statusline_1.PARTS,
                initial: fallback ?? [],
                note,
                preview: (now, cursor) => previewWith({ rows: withRow(i, now) }, { mark: { row: i, part: cursor !== undefined && cursor < now.length ? cursor : undefined } }),
            };
            const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${brackets} `, readParts(fallback, statusline_1.PARTS), 'INPUT', (c) => c.edit ? c.edit(question) : c.many(question));
            status = { ...status, rows: withRow(i, parts) };
            autoRows.delete(i);
            return undefined;
        },
    });
    // All the rows' parts in one question, for a front end that edits them
    // together.
    const partsStep = (ask) => ({
        id: 'parts',
        name: 'Parts',
        value: status.rows.map((row) => row.join(', ')).join(' | '),
        run: async () => {
            show();
            // A row with the set a row with no default starts with is made again
            // from the rows before it, in turn.
            for (let i = 0; i < status.rows.length; i++) {
                if (autoRows.has(i))
                    status = { ...status, rows: withRow(i, extraRow(status.rows.slice(0, i).flat()) ?? []) };
            }
            const rows = await ask({
                message: 'The parts of each row',
                options: statusline_1.PARTS,
                initial: status.rows,
                note: (part) => `${s.value(part)} ${s.dim(`${(0, statusline_1.describePart)(part)}.`)}`,
                preview: (now, at) => previewWith({ rows: now }, at ? { mark: { row: at.row, part: at.part < now[at.row].length ? at.part : undefined } } : {}),
            });
            status = { ...status, rows };
            autoRows.clear();
            return undefined;
        },
    });
    // The order of the rows, for a front end that asks for an order.
    const rowsOrderStep = (ask) => ({
        id: 'rows order',
        name: 'Order of the rows',
        value: '',
        run: async () => {
            show();
            const rows = await ask({
                message: 'Order of the rows',
                options: status.rows.map((row) => ({ label: row.join(', '), value: row })),
                describe: (now) => (now.every((at, i) => at === i) ? 'as they were' : `rows ${now.map((at) => at + 1).join(', ')}`),
                preview: (now, cursor) => previewWith({ rows: now }, cursor === undefined ? {} : { mark: { row: cursor, whole: true } }),
            });
            status = { ...status, rows };
            return undefined;
        },
    });
    // The bar style: for every bar, and for each bar on its own. The one
    // question whose preview moves: its bars sweep, to show how each style
    // fills and how it marks the pace.
    const barStyleStep = () => ({
        id: 'bar style',
        name: 'Bar style',
        value: (0, statusline_1.perBarList)(status.barStyle),
        run: async () => {
            show();
            const barStyle = await askPerBar(`Bar style: ${statusline_1.BAR_STYLES.join(', ')}, or a list such as steps,ctx=rising?`, 'Bar style?', statusline_1.BAR_STYLES, status.barStyle, statusline_1.BARS, (values, at) => previewWith({ barStyle: values }, { moving: true, ...(at ? { mark: at } : {}) }), {
                what: 'bar style',
                example: 'steps,ctx=rising',
                moving: true,
                note: (style) => `${s.value(style)} ${s.dim(`${statusline_1.BAR_STYLE_REGISTRY[style].description}.`)}`,
            });
            status = { ...status, barStyle };
            return undefined;
        },
    });
    // Only classic takes a number of cells: each other style has its own. So
    // the question is for the classic bars only, and none asks none.
    const cellsStep = () => ({
        id: 'cells',
        name: 'Cells per classic bar',
        value: (0, statusline_1.perBarList)(status.segments),
        run: async () => {
            show();
            const segments = await askPerBar(`Cells per classic bar, ${SEGMENTS.join(' or ')}, or a list such as 5,ctx=10?`, 'Cells per classic bar?', SEGMENTS, status.segments, classicBars(), (values, at) => previewWith({ segments: values }, at ? { mark: at } : {}), { what: 'number of cells', example: '5,ctx=10', note: (cells) => `${s.value(cells)} ${s.dim('cells in each classic bar.')}` });
            status = { ...status, segments };
            return undefined;
        },
    });
    const themeStep = () => ({
        id: 'theme',
        name: 'Theme',
        value: status.theme,
        run: async () => {
            show();
            const fallback = status.theme;
            const theme = await askFor(io, `Theme: ${statusline_1.THEMES.join(', ')}? ${hint(s, fallback)} `, (answer) => {
                const name = answer.toLowerCase() || fallback;
                return statusline_1.THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${statusline_1.THEMES.join(', ')}.` };
            }, 'INPUT', oneOf('Theme?', statusline_1.THEMES, fallback, (name) => previewWith({ theme: name })));
            status = { ...status, theme };
            return undefined;
        },
    });
    const labelsStep = () => ({
        id: 'labels',
        name: 'Labels',
        value: yesNoWord(status.labels),
        run: async () => {
            show();
            status = {
                ...status,
                labels: await confirm(io, 'Labels in front of the values, such as ctx and 5h?', status.labels, (yes) => previewWith({ labels: yes })),
            };
            return undefined;
        },
    });
    const tokenLineStep = () => ({
        id: 'token line',
        name: 'Token line',
        value: tokenLine ? 'on' : 'off',
        run: async () => {
            show();
            tokenLine = await confirm(io, 'Add the token line, shown when each turn ends?', tokenLine, (yes) => previewOf(status, { tokenLine: yes }));
            return undefined;
        },
    });
    // The token line reads the context window the status line saves, so there
    // is no question for it. A --window set up stays as it is.
    const tokenPartsStep = () => ({
        id: 'token parts',
        name: 'Token line parts',
        value: tokenPartsOf(tokenSwitches).join(', '),
        run: async () => {
            if (!tokenHeaded) {
                io.clear();
                io.keep(s.pill('Token line'));
                tokenHeaded = true;
            }
            show(undefined, { tokenMark: {} });
            const fallback = tokenPartsOf(tokenSwitches);
            const question = `Token line parts: all, req,out,ctx, or your own list from ${tokenline_1.PARTS.map(s.value).join(', ')}? ${hint(s, fallback.join(','))} `;
            const edit = {
                message: 'Token line parts',
                options: tokenline_1.PARTS,
                initial: fallback,
                note: (part) => `${s.value(part)} ${s.dim(`${TOKEN_NOTES[part]}.`)}`,
                preview: (now, cursor) => previewOf(status, {
                    tokenLine: true,
                    tokenSwitches: tokenSwitchesFor(now, start.tokenSwitches),
                    tokenMark: { part: cursor !== undefined && cursor < now.length ? cursor : undefined },
                }),
            };
            const parts = await askFor(io, question, readTokenParts(fallback), 'INPUT', (c) => (c.edit ? c.edit(edit) : c.many(edit)));
            tokenSwitches = tokenSwitchesFor(parts, start.tokenSwitches);
            return undefined;
        },
    });
    const writeStep = () => ({
        id: 'write',
        name: 'Write these choices',
        value: '',
        run: async () => {
            show();
            if (!(await confirm(io, 'Write these choices?', true)))
                return { end: null };
            return { end: { statusLine: switchesFor(status), tokenLine: tokenLine ? withBarStyle(tokenSwitches, status.barStyle) : null } };
        },
    });
    // The steps as the answers so far make them: a row step for each row, the
    // rows' order step where there are two or more rows and the front end asks
    // for an order, and the cells step only while a bar is classic.
    const steps = () => {
        const rows = status.rows.length;
        return [
            ...(setUp ? [startStep()] : []),
            ...(fresh() ? [defaultsStep()] : []),
            rowsStep(),
            ...(rowsEditor ? [partsStep(rowsEditor)] : Array.from({ length: rows }, (_, i) => rowStep(i))),
            ...(order && rows > 1 ? [rowsOrderStep(order)] : []),
            barStyleStep(),
            ...(classicBars().length ? [cellsStep()] : []),
            themeStep(),
            labelsStep(),
            tokenLineStep(),
            ...(tokenLine ? [tokenPartsStep()] : []),
            writeStep(),
        ];
    };
    // Each step in turn. At a step, the user can go back to any step before
    // it: the steps after it stay answered, and are asked again in turn.
    let at = 0;
    for (;;) {
        const list = steps();
        const step = list[at];
        statusOnly = STATUS_STEPS.test(step.id);
        try {
            const done = await step.run();
            if (done)
                return done.end;
            at = steps().findIndex((s) => s.id === step.id) + 1;
        }
        catch (err) {
            if (!(err instanceof GoBack))
                throw err;
            const to = await pickStep(io, list.slice(0, at), step);
            if (to >= 0)
                at = to;
        }
    }
}
// The token line's sample run since the last prompt: four requests, the last
// at 43% of a 200k context, as in the status line's sample.
const SAMPLE_RUN = [
    { type: 'user', message: { content: 'Fix the login redirect.' } },
    ...[
        { output_tokens: 900, thinking: 400, cacheWrite: 1500, cacheRead: 78000, input: 600 },
        { output_tokens: 700, thinking: 300, cacheWrite: 1000, cacheRead: 80000, input: 400 },
        { output_tokens: 800, thinking: 200, cacheWrite: 2000, cacheRead: 82000, input: 300 },
        { output_tokens: 1000, thinking: 300, cacheWrite: 2000, cacheRead: 83500, input: 500 },
    ].map((u, i) => ({
        type: 'assistant',
        message: {
            id: `sample-${i}`,
            usage: {
                output_tokens: u.output_tokens,
                output_tokens_details: { thinking_tokens: u.thinking },
                input_tokens: u.input,
                cache_creation_input_tokens: u.cacheWrite,
                cache_read_input_tokens: u.cacheRead,
            },
        },
    })),
];
exports.SAMPLE_RUN = SAMPLE_RUN;
const SAMPLE_WINDOW = 200000;
// The token line's preview: the sample run's line with the given switches,
// as the token line reads them.
function tokenPreviewer(nowMs) {
    return (switches, mark) => {
        const { show, segments, barStyle, window } = (0, tokenline_1.parseArgs)([...switches]);
        return (0, tokenline_1.summarize)(SAMPLE_RUN, { now: nowMs === undefined ? new Date() : new Date(nowMs), show, segments, barStyle, window, savedWindow: SAMPLE_WINDOW, mark }) ?? '';
    };
}
const REPO = 'jv-k/claude-gauge';
// The README's table of parts, on the repo's page.
const PARTS_URL = `https://github.com/${REPO}#what-the-lines-show`;
// The link to the table of parts: the address in full, so any terminal shows
// where it goes, and in colour a link a terminal can open (OSC 8) as well.
const partsLink = (color, s) => (color ? `\x1b]8;;${PARTS_URL}\x07${s.value(PARTS_URL)}\x1b]8;;\x07` : PARTS_URL);
// The end of setup: with gh at hand, offers to star the repo, and stars it
// on a yes or Enter. Without gh it says nothing. The end of the input is a no,
// and Ctrl+C stops setup, as at any other question.
async function offerStar(io, { hasGh, star }) {
    if (!hasGh())
        return;
    let yes;
    try {
        yes = await confirm(io, `Star ${REPO} on GitHub with gh?`, true);
    }
    catch (err) {
        if (err instanceof Interrupted)
            throw new Interrupted('Stopped at Ctrl+C. The settings are written, and the repo is not starred.');
        if (err instanceof EndOfAnswers || err instanceof GoBack)
            return;
        throw err;
    }
    if (!yes)
        return;
    const s = stylesOf(io);
    io.write(star() ? s.ok(`Starred ${s.value(REPO)}. Thank you.`) : s.warn(`gh could not star ${s.value(REPO)}. Nothing else changed.`));
}
// The preview's examples, for a part that has nothing to show from the
// payload, the transcript or the folder, so that every part ticked shows. All
// of them are one session about an hour in: Opus at 43% of its context, at
// work on a fix for a login redirect on its own branch and worktree.
// The sample's transcript path, which the preview never reads.
const SAMPLE_TRANSCRIPT = 'claude-gauge-sample.jsonl';
const SAMPLE_TEXT = 'on call';
const SAMPLE_COMMAND_OUTPUT = 'build passing';
const SAMPLE_PLAN = 'Claude Max 5x';
// The sample's worktree, for the worktree part only: the branch part names
// the worktree too, and a session in no worktree shows none there.
const SAMPLE_WORKTREE = 'login-redirect';
const SAMPLE_ENV = { claudeMd: 2, rules: 3, mcp: 2, hooks: 1 };
const SAMPLE_MEMORY = { used: 11 * 1024 ** 3, total: 16 * 1024 ** 3 };
// What git status --porcelain=v2 --branch would print: the branch two
// commits ahead, with a file staged, one modified and one untracked.
const SAMPLE_GIT_HEAD = ['# branch.head fix/login-redirect', '# branch.upstream origin/fix/login-redirect', '# branch.ab +2 -0'];
const SAMPLE_GIT_CHANGES = [
    '1 M. N... 100644 100644 100644 0000000 0000000 src/auth/session.ts',
    '1 .M N... 100644 100644 100644 0000000 0000000 src/auth/redirect.ts',
    '? test/redirect.test.ts',
];
// What earlier sessions spent, today first and then a day back each.
const SAMPLE_DAYS = [3.06, 5.12, 2.47, 6.8, 4.15, 1.92, 3.38];
// A status payload to preview with when the status line has saved none, and
// the fields under a saved one.
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
            seven_day_opus: { used_percentage: 58, resets_at: at(3 * 24 * hour) },
            seven_day_sonnet: { used_percentage: 100, resets_at: at(3 * 24 * hour) },
            spend_limit: { used_percentage: 31, used_usd: 62, limit_usd: 200 },
        },
        cost: { total_duration_ms: 72 * 60 * 1000, total_cost_usd: 1.24, total_lines_added: 156, total_lines_removed: 23 },
        session_name: 'Fix the login redirect',
        transcript_path: SAMPLE_TRANSCRIPT,
        version: '2.1.300',
        thinking: { enabled: true },
        fast_mode: true,
        output_style: { name: 'Explanatory' },
        pr: { number: 128, review_state: 'approved' },
        agent: { name: 'reviewer' },
        prompt_cache: { warm: true, hit_ratio: 0.92 },
    };
}
// What the sample session's transcript shows.
function sampleActivity(nowMs) {
    const minute = 60 * 1000;
    return {
        tools: { running: [{ name: 'Edit', target: 'src/auth/redirect.ts' }], completed: { Read: 12, Bash: 4, Grep: 3 } },
        agents: [{ type: 'Explore', model: 'Haiku 4.5', description: 'Find the session store', startedAt: nowMs - 2 * minute }],
        todos: [
            { content: 'Find the redirect', status: 'completed' },
            { content: 'Fix the check', status: 'completed' },
            { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
            { content: 'Update the docs', status: 'pending' },
            { content: 'Open the pull request', status: 'pending' },
        ],
        skills: ['tdd'],
        mcp: [{ name: 'github' }],
        compactions: 1,
        lastReplyAt: nowMs - 2 * minute,
        speed: 84,
    };
}
// The sample cost ledger, keyed by local day as the status line keys it.
function sampleLedger(nowMs) {
    const now = new Date(nowMs);
    const days = {};
    SAMPLE_DAYS.forEach((usd, i) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        days[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = usd;
    });
    return { days, sessions: {} };
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// The real value with the sample's under it, object by object: the sample
// fills only what is missing or null.
function underSample(real, sample) {
    if (real === undefined || real === null)
        return sample;
    if (!isRecord(real) || !isRecord(sample))
        return real;
    const merged = { ...sample, ...real };
    for (const key of Object.keys(sample))
        merged[key] = underSample(real[key], sample[key]);
    return merged;
}
// The payload with the sample's fields under it. thinking, fast and style
// show nothing while they are off, so the preview shows the sample's. The
// sample's worktree comes in only when `shown` holds the worktree part.
function withSamplePayload(payload, nowMs, shown) {
    const sample = samplePayload(nowMs);
    const data = underSample(payload, sample);
    if (shown.has('worktree') && !data.workspace?.git_worktree && !data.worktree?.name)
        data.workspace = { ...data.workspace, git_worktree: SAMPLE_WORKTREE };
    if (!data.thinking?.enabled)
        data.thinking = sample.thinking;
    if (!data.fast_mode)
        data.fast_mode = sample.fast_mode;
    if (!data.output_style?.name || data.output_style.name === 'default')
        data.output_style = sample.output_style;
    return data;
}
// What the transcript shows, with the sample's in each kind it shows none of.
function withSampleActivity(real, nowMs) {
    const sample = sampleActivity(nowMs);
    const { tools, agents = [], todos = [], skills = [], mcp = [], compactions, lastReplyAt, speed } = real;
    const shownAgent = agents.some((a) => a.endedAt === undefined || nowMs - a.endedAt < statusline_1.AGENT_LINGER_MS);
    return {
        tools: tools.running.length || Object.keys(tools.completed).length ? tools : sample.tools,
        agents: shownAgent ? agents : sample.agents,
        todos: todos.length ? todos : sample.todos,
        ...(skills.length || mcp.length ? { skills, mcp } : { skills: sample.skills, mcp: sample.mcp }),
        compactions: compactions > 0 ? compactions : sample.compactions,
        lastReplyAt: lastReplyAt ?? sample.lastReplyAt,
        speed: speed ?? sample.speed,
    };
}
// The git status, with the sample's branch where it names none, and, when
// `withChanges`, the sample's changes where it has none. The changes are
// for the git and files parts only: the branch part marks them with *, and
// a clean folder shows no * there. Without a status in time, the branch
// comes from HEAD.
function withSampleStatus(status, branch, withChanges) {
    const lines = (status ?? '').split(/\r?\n/).filter(Boolean);
    const head = lines.filter((line) => line.startsWith('#'));
    const changes = lines.filter((line) => !line.startsWith('#'));
    const named = status === undefined && branch() ? [`# branch.head ${branch()}`] : head;
    const hasBranch = named.some((line) => /^# branch\.head (?!\(detached\))\S/.test(line));
    return [...(hasBranch ? named : SAMPLE_GIT_HEAD), ...(changes.length || !withChanges ? changes : SAMPLE_GIT_CHANGES)].join('\n');
}
// What Claude Code loads, with the sample's counts where it loads nothing
// and the sample's plan where neither plan nor user is known.
function withSampleSetup(real) {
    const counts = real.claudeMd || real.rules || real.mcp || real.hooks ? {} : SAMPLE_ENV;
    return { ...real, ...counts, ...(real.plan || real.user ? {} : { plan: SAMPLE_PLAN }) };
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
// Where a bar is at `nowMs` in the preview's animation: 0 to 1 and back on
// `period`, from `phase`, as a triangle wave, and as a percentage that eases
// at each end.
const waveAt = (nowMs, period, phase) => {
    const x = (((nowMs / period + phase) % 1) + 1) % 1;
    return x < 0.5 ? x * 2 : 2 - x * 2;
};
const levelAt = (nowMs, period, phase) => {
    const x = waveAt(nowMs, period, phase);
    return Math.round(100 * x * x * (3 - 2 * x));
};
// The memory with the ram bar moved to where it is at `nowMs` in the
// preview's animation, as swept moves the others.
const sweptMemory = ({ total }, nowMs) => ({ used: (total * levelAt(nowMs, 28000, 0.8)) / 100, total });
// The payload with the context, 5h and 7d bars moved to where they are at
// `nowMs` in the preview's animation. Each climbs and falls on its own
// period, and "now" moves through each window, so the pace marker walks
// and changes colour. The other fields stay as they are.
function swept(payload, nowMs) {
    const wave = (period, phase) => waveAt(nowMs, period, phase);
    const pct = (period, phase) => levelAt(nowMs, period, phase);
    const resetsAt = (seconds, period, phase) => Math.floor(nowMs / 1000 + seconds * (0.92 - 0.84 * wave(period, phase)));
    // Without the token counts, ctx counts its tokens from the percentage.
    const context = { context_window_size: 200000, ...payload.context_window, used_percentage: pct(32000, 0.5) };
    delete context.current_usage;
    delete context.total_input_tokens;
    return {
        ...payload,
        context_window: context,
        rate_limits: {
            ...payload.rate_limits,
            five_hour: { used_percentage: pct(24000, 0), resets_at: resetsAt(5 * 3600, 28000, 0.15) },
            seven_day: { used_percentage: pct(36000, 0.3), resets_at: resetsAt(7 * 86400, 44000, 0.6) },
        },
    };
}
// `read` with each answer kept by its key, for an animated preview, which
// renders many times a second and must not run git or read files each time.
function kept(read) {
    const answers = new Map();
    return (...args) => {
        const key = JSON.stringify(args);
        if (!answers.has(key))
            answers.set(key, read(...args));
        return answers.get(key);
    };
}
// The preview: the status line's rows for `payload`, with the given switches
// as words, as the settings command passes them. A part with nothing to show
// shows its sample, and only the preview does: the status line itself shows
// nothing for it. The preview reads the transcript, git and the files Claude
// Code loads, as the status line does, but never runs --command, and takes
// the sample ledger in place of the real one.
function previewer(payload, options = {}) {
    const { sweep = false, ...renderOptions } = options;
    const keep = (read) => (sweep ? kept(read) : read);
    const transcript = keep(options.transcript ?? statusline_1.readTranscriptActivity);
    const statusOf = keep(options.statusOf ?? statusline_1.gitStatus);
    const branchOf = keep(options.branchOf ?? statusline_1.headBranch);
    const memoryOf = keep(options.memoryOf ?? statusline_1.readMemory);
    const setupOf = keep(options.setupOf ?? ((cwd) => (0, statusline_1.readSetup)(cwd, { env: options.env ?? process.env })));
    return (switches, plain = false, moving = false, mark) => {
        const nowMs = options.nowMs ?? Date.now();
        const config = (0, statusline_1.parseArgs)([...switches]);
        const shown = new Set((config.rows ?? statusline_1.DEFAULT_ROWS).flat());
        const data = withSamplePayload(payload, nowMs, shown);
        // The moving bars show the clock's time, which stops while paused.
        const move = sweep && moving;
        const at = move && options.clock ? options.clock() : nowMs;
        return (0, statusline_1.render)(move ? swept(data, at) : data, {
            ...renderOptions,
            nowMs,
            plain,
            mark,
            // Any command will do, as the preview runs none: the part shows the
            // sample's output.
            config: { ...config, text: config.text || SAMPLE_TEXT, command: config.command || 'sample' },
            transcript: (file, read) => {
                let real = { tools: { running: [], completed: {} }, agents: [], todos: [], skills: [], mcp: [], compactions: 0 };
                try {
                    if (file !== SAMPLE_TRANSCRIPT)
                        real = transcript(file, read);
                }
                catch {
                    /* a transcript that cannot be read shows the sample */
                }
                return withSampleActivity(real, nowMs);
            },
            statusOf: (cwd) => withSampleStatus(statusOf(cwd), () => branchOf(cwd), shown.has('git') || shown.has('files')),
            setupOf: (cwd) => withSampleSetup(setupOf(cwd)),
            memoryOf: () => {
                const memory = memoryOf() ?? SAMPLE_MEMORY;
                return move ? sweptMemory(memory, at) : memory;
            },
            commandOutputOf: () => SAMPLE_COMMAND_OUTPUT,
            ledger: options.ledger ?? sampleLedger(nowMs),
        });
    };
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
const loadInk = async (input, output, color) => (await import('./ink-io.js')).loadInkIo(input, output, color);
// The questions on a pair of streams: the Ink front end when both are a
// terminal and Ink loads, else the readline one, with no warning, as for
// piped answers.
async function openIo(input, output, load = loadInk) {
    const color = (0, wordmark_1.colorEnabled)(output);
    if (input.isTTY && output.isTTY) {
        try {
            return await load(input, output, color);
        }
        catch {
            /* no Ink here: the readline questions ask instead */
        }
    }
    return streamIo(input, output, color);
}
