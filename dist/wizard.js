"use strict";
// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar size, theme and labels, and the token line
// and its parts, with a preview of the status line
// redrawn after each answer. configure starts from the bars set up now: the
// first answer keeps them, and each question offers the value set up. It
// returns the switches for each bar, as words, for the CLI to write; it
// reads and writes no settings itself.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample. On
// a terminal each preview replaces the one before it, in place; with piped
// output each preview prints below the last.
//
// Two front ends ask the same questions, with the same defaults, and give the
// same answers. The readline one reads a typed line for each question. The
// Ink one (ink-io.ts) offers each as a choice: the arrow keys and Enter for
// one option, Space to tick the parts of a row, and the preview redrawn as
// the selection moves. openIo picks Ink when stdin and stdout are both a
// terminal and Ink loads, and the readline one otherwise.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interrupted = exports.EndOfAnswers = exports.confirm = void 0;
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
const MAX_ROWS = 3;
const SEGMENTS = [5, 10];
const DEFAULT_CHOICES = { rows: statusline_1.DEFAULT_ROWS, barStyle: 'classic', segments: 5, theme: 'default', labels: true, others: [] };
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
    if (barStyle !== 'classic')
        words.push('--bar-style', barStyle);
    if (segments !== 5)
        words.push('--segments', String(segments));
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
    const status = { ...DEFAULT_CHOICES, rows: [], others: [] };
    for (const { name, value, words } of (0, statusline_1.readSwitches)(switches)) {
        if (name === '--show') {
            const row = value.split(',').map((p) => p.trim()).filter((p) => statusline_1.PARTS.includes(p));
            if (row.length)
                status.rows.push(row);
        }
        else if (name === '--bar-style')
            status.barStyle = statusline_1.BAR_STYLES.includes(value.trim()) ? value.trim() : 'classic';
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
const oneOf = (message, values, fallback, preview) => (c) => c.one({ kind: 'INPUT', message, options: values.map((value) => ({ label: String(value), value })), initial: Math.max(0, values.indexOf(fallback)), preview });
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
// The token line's `switches` with the status line's bar style, so the two
// lines draw their bars alike. classic needs no switch.
const withBarStyle = (switches, barStyle) => [
    ...without(switches, '--bar-style'),
    ...(barStyle === 'classic' ? [] : ['--bar-style', barStyle]),
];
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
async function askAll(userIo, { preview, tokenPreview = tokenPreviewer(), installed }) {
    const io = screenOf(userIo);
    const s = stylesOf(io);
    const start = startFrom(installed);
    let status = { ...start.status };
    let tokenLine = start.tokenLine;
    let tokenSwitches = start.tokenSwitches;
    // The preview of `choices` in the status line's own colours, or as plain
    // text when the questions take no colour, under `heading` when one is given.
    // With the token line on, its line with `withTokenSwitches` comes under it.
    const previewOf = (choices, withTokenLine = tokenLine, heading = '', withTokenSwitches = tokenSwitches) => {
        const rendered = preview(switchesFor(choices), !io.color);
        const rows = io.color ? rendered : (0, statusline_1.stripOwnCodes)(rendered);
        const token = withTokenLine ? `on, when each turn ends\n  ${tokenPreview(withBarStyle(withTokenSwitches, choices.barStyle))}` : 'off';
        return `${heading}\n${rows.split('\n').map((row) => `  ${row}`).join('\n')}\nToken line: ${token}\n`;
    };
    // A function, so a front end that animates the preview can redraw it.
    const show = (heading = '') => {
        const now = status;
        const line = tokenLine;
        io.preview(() => previewOf(now, line, heading));
    };
    // The preview with `change` made to the choices so far, for a choice whose
    // selection moves.
    const previewWith = (change) => previewOf({ ...status, ...change });
    if (isSetUp(installed)) {
        show(installed.statusLine ? 'The status line as set up now:\n' : 'The status line is not set up. With the defaults it shows:\n');
        if (await confirm(io, 'Keep the current lines as they are?', true))
            return {};
    }
    else {
        show('The status line with the defaults:\n');
        if (await confirm(io, 'Use the defaults: both lines, with the parts above?', true))
            return { statusLine: [], tokenLine: [] };
    }
    // A row set up, else the default row there.
    const rowAt = (i) => start.status.rows[i] ?? statusline_1.DEFAULT_ROWS[i];
    const rowsFor = (n) => Array.from({ length: n }, (_, i) => rowAt(i) ?? []);
    // More rows than the wizard offers stay possible when that many are set up.
    const rowsNow = start.status.rows.length;
    const maxRows = Math.max(MAX_ROWS, rowsNow);
    // The customise path starts below the questions, where the first preview
    // and the question under it were: the next preview takes their place.
    io.clear();
    io.keep(`${s.pill('Status line')}The parts: ${statusline_1.PARTS.map(s.value).join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`);
    const counts = Array.from({ length: maxRows }, (_, i) => i + 1);
    const count = await askFor(io, `How many status line rows, 1 to ${maxRows}? ${hint(s, rowsNow)} `, (answer) => {
        const n = answer ? Number(answer) : rowsNow;
        return Number.isInteger(n) && n >= 1 && n <= maxRows ? n : { retry: `Answer a number from 1 to ${maxRows}.` };
    }, 'INPUT', oneOf('How many status line rows?', counts, rowsNow, (n) => previewWith({ rows: rowsFor(n) })));
    status = { ...status, rows: rowsFor(count) };
    show();
    for (let i = 0; i < count; i++) {
        const fallback = rowAt(i);
        const brackets = fallback ? ` ${hint(s, fallback.join(','))}` : '';
        const withRow = (parts) => status.rows.map((row, j) => (j === i ? parts : row));
        const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${brackets} `, readParts(fallback, statusline_1.PARTS), 'INPUT', (c) => c.many({ message: `Row ${i + 1}: the parts`, options: statusline_1.PARTS, initial: fallback ?? [], preview: (ticked) => previewWith({ rows: withRow(ticked) }) }));
        status = { ...status, rows: withRow(parts) };
        show();
    }
    const barStyle = await askFor(io, `Bar style: ${statusline_1.BAR_STYLES.join(', ')}? ${hint(s, start.status.barStyle)} `, (answer) => {
        const name = answer.toLowerCase() || start.status.barStyle;
        return statusline_1.BAR_STYLES.includes(name) ? name : { retry: `Unknown bar style: ${answer}. Answer one of ${statusline_1.BAR_STYLES.join(', ')}.` };
    }, 'INPUT', oneOf('Bar style?', statusline_1.BAR_STYLES, start.status.barStyle, (name) => previewWith({ barStyle: name })));
    status = { ...status, barStyle };
    show();
    // Only classic takes a number of cells: each other style has its own.
    if (barStyle === 'classic') {
        const segments = await askFor(io, `Cells per bar, ${SEGMENTS.join(' or ')}? ${hint(s, start.status.segments)} `, (answer) => SEGMENTS.find((n) => String(n) === (answer || String(start.status.segments))) ?? { retry: `Answer ${SEGMENTS.join(' or ')}.` }, 'INPUT', oneOf('Cells per bar?', SEGMENTS, start.status.segments, (n) => previewWith({ segments: n })));
        status = { ...status, segments };
        show();
    }
    const theme = await askFor(io, `Theme: ${statusline_1.THEMES.join(', ')}? ${hint(s, start.status.theme)} `, (answer) => {
        const name = answer.toLowerCase() || start.status.theme;
        return statusline_1.THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${statusline_1.THEMES.join(', ')}.` };
    }, 'INPUT', oneOf('Theme?', statusline_1.THEMES, start.status.theme, (name) => previewWith({ theme: name })));
    status = { ...status, theme };
    show();
    status = {
        ...status,
        labels: await confirm(io, 'Labels in front of the values, such as ctx and 5h?', start.status.labels, (yes) => previewWith({ labels: yes })),
    };
    show();
    tokenLine = await confirm(io, 'Add the token line, shown when each turn ends?', start.tokenLine, (yes) => previewOf(status, yes));
    show();
    if (tokenLine) {
        io.keep(s.pill('Token line'));
        const fallback = tokenPartsOf(start.tokenSwitches);
        const question = `Token line parts: all, req,out,ctx, or your own list from ${tokenline_1.PARTS.map(s.value).join(', ')}? ${hint(s, fallback.join(','))} `;
        const parts = await askFor(io, question, readTokenParts(fallback), 'INPUT', (c) => c.many({
            message: 'Token line parts',
            options: tokenline_1.PARTS,
            initial: fallback,
            preview: (ticked) => previewOf(status, true, '', tokenSwitchesFor(ticked, start.tokenSwitches)),
        }));
        // The token line reads the context window the status line saves, so
        // there is no question for it. A --window set up stays as it is.
        tokenSwitches = tokenSwitchesFor(parts, start.tokenSwitches);
        show();
    }
    if (!(await confirm(io, 'Write these choices?', true)))
        return null;
    return { statusLine: switchesFor(status), tokenLine: tokenLine ? withBarStyle(tokenSwitches, status.barStyle) : null };
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
const SAMPLE_WINDOW = 200000;
// The token line's preview: the sample run's line with the given switches,
// as the token line reads them.
function tokenPreviewer(nowMs) {
    return (switches) => {
        const { show, segments, barStyle, window } = (0, tokenline_1.parseArgs)([...switches]);
        return (0, tokenline_1.summarize)(SAMPLE_RUN, { now: nowMs === undefined ? new Date() : new Date(nowMs), show, segments, barStyle, window, savedWindow: SAMPLE_WINDOW }) ?? '';
    };
}
const REPO = 'jv-k/claude-gauge';
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
        if (err instanceof EndOfAnswers)
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
// The payload with the context, 5h and 7d bars moved to where they are at
// `nowMs` in the preview's animation. Each climbs and falls on its own
// period, and "now" moves through each window, so the pace marker walks
// and changes colour. The other fields stay as they are.
function swept(payload, nowMs) {
    const wave = (period, phase) => {
        const x = (((nowMs / period + phase) % 1) + 1) % 1;
        return x < 0.5 ? x * 2 : 2 - x * 2;
    };
    const pct = (period, phase) => {
        const x = wave(period, phase);
        return Math.round(100 * x * x * (3 - 2 * x));
    };
    const resetsAt = (seconds, period, phase) => Math.floor(nowMs / 1000 + seconds * (0.92 - 0.84 * wave(period, phase)));
    // Without the token counts, ctx counts its tokens from the percentage.
    const context = { context_window_size: 200000, ...payload.context_window, used_percentage: pct(8000, 0.5) };
    delete context.current_usage;
    delete context.total_input_tokens;
    return {
        ...payload,
        context_window: context,
        rate_limits: {
            ...payload.rate_limits,
            five_hour: { used_percentage: pct(6000, 0), resets_at: resetsAt(5 * 3600, 7000, 0.15) },
            seven_day: { used_percentage: pct(9000, 0.3), resets_at: resetsAt(7 * 86400, 11000, 0.6) },
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
    return (switches, plain = false) => {
        const nowMs = options.nowMs ?? Date.now();
        const config = (0, statusline_1.parseArgs)([...switches]);
        const shown = new Set((config.rows ?? statusline_1.DEFAULT_ROWS).flat());
        const data = withSamplePayload(payload, nowMs, shown);
        return (0, statusline_1.render)(sweep ? swept(data, nowMs) : data, {
            ...renderOptions,
            nowMs,
            plain,
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
            memoryOf: () => memoryOf() ?? SAMPLE_MEMORY,
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
