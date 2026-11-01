// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar style, bar size, theme and labels, and the
// token line and its parts, with a preview of the status line redrawn after
// each answer. With lines set up, the first answer keeps them, changes them,
// each question offering the value set up, or starts over from the defaults.
// It returns the switches for each line, as words, for the CLI to write; it
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

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import {
  render,
  parseArgs,
  readSwitches,
  stripOwnCodes,
  readTranscriptActivity,
  readSetup,
  readMemory,
  gitStatus,
  headBranch,
  AGENT_LINGER_MS,
  PARTS,
  THEMES,
  BAR_STYLES,
  BARS,
  perBarOf,
  perBarList,
  DEFAULT_ROWS,
} from './statusline';
import { PARTS as TOKEN_PARTS, parseArgs as parseTokenArgs, readSwitches as readTokenSwitches, summarize } from './tokenline';
import type { StatusData, Part, TranscriptActivity, Ledger, Setup, Bar, PerBar as BarValues } from './statusline';
import type { Part as TokenPart, TranscriptRecord as TokenRecord } from './tokenline';
import type { PerBar, InstalledSwitches } from './settings';
import { colorEnabled } from './wordmark';
import { styles } from './styles';
import type { Styles } from './styles';

interface WizardIo {
  // Shows `question` and resolves to the answer, or to undefined at the end
  // of the input. The answer's line ends before anything else is written.
  ask(question: string): Promise<string | undefined>;
  write(text: string): void;
  // Whether the questions are in colour. Unset is no colour.
  color?: boolean;
  // Set when the output is a terminal, so that each preview can replace the
  // one before it. `columns` is its width, for the rows a long line wraps to.
  terminal?: { columns?: number };
  // Set by a front end that offers each question as a choice. The wizard then
  // asks through it, and `ask` goes unused.
  choices?: ChoiceIo;
  // Set by a front end that redraws its preview with the clock, so the
  // preview can animate.
  animated?: boolean;
}

// One option of a choice: the words it shows, and the answer it gives.
interface Option<T> {
  label: string;
  value: T;
}

// A question as a choice of one option, the one at `initial` first. The pill
// before it is CONFIRM for a yes or no, INPUT for any other. `preview`, when
// set, gives the preview with the option the selection is on. `moving`, when
// set, says the preview moves with the clock, so a front end that animates
// redraws it while the question waits.
interface PickOne<T> {
  kind: 'CONFIRM' | 'INPUT';
  message: string;
  options: Option<T>[];
  initial: number;
  preview?: (value: T) => string;
  moving?: boolean;
}

// A question as a list of parts to tick, with `initial` ticked first. The
// answer is the ticked parts: those of `initial` still ticked, in their
// order, then each part ticked since, in the order it was ticked. `preview`,
// when set, gives the preview with the parts ticked now.
interface PickMany<P extends string> {
  message: string;
  options: readonly P[];
  initial: readonly P[];
  preview?: (value: P[]) => string;
}

// A question with a choice for each of `targets`, and one for All of them,
// each starting on its value in `initial`. A choice at All sets every
// target. The answer is All's choice and each target's, in the order of
// `targets`. `preview`, when set, gives the preview with the choices as
// they are now; `moving` is as for PickOne.
interface PickEach<T> {
  message: string;
  targets: readonly string[];
  options: Option<T>[];
  initial: { all: T; each: T[] };
  preview?: (all: T, each: T[]) => string;
  moving?: boolean;
}

// A front end that asks with choices. Each question rejects with
// EndOfAnswers when it is stopped, such as at Ctrl+C. `preview` sets the
// preview that the questions after it show, or none for ''. A function
// gives the preview as it is now, for a front end that animates it.
interface ChoiceIo {
  one<T>(question: PickOne<T>): Promise<T>;
  many<P extends string>(question: PickMany<P>): Promise<P[]>;
  each<T>(question: PickEach<T>): Promise<{ all: T; each: T[] }>;
  preview(text: string | (() => string)): void;
}

interface WizardOptions {
  // The status line's rows when run with these switches, as plain text when
  // `plain` is set, with the bars moving with the clock when `moving` is set.
  preview: (statusLineSwitches: readonly string[], plain?: boolean, moving?: boolean) => string;
  // The token line when run with these switches, else the sample run's.
  tokenPreview?: (tokenLineSwitches: readonly string[]) => string;
  // The bars configure found. The wizard starts from them, and from the
  // factory defaults when neither bar is set up.
  installed?: InstalledSwitches;
}

// The switches for each bar, as words: the words to run it with, null to
// leave it out, undefined to leave it as it is, which a yes to keeping the
// bars gives. Only the token line can be left out, so only it takes null:
// that is PerBar's second parameter.
type WizardChoices = PerBar<string[], string[] | null>;

// The input ended before the last question: nothing is written.
class EndOfAnswers extends Error {
  constructor(message = 'The answers ended before the last question. Nothing changed.') {
    super(message);
  }
}

// Ctrl+C stopped the questions: nothing is written, as at the end of the
// input. The star offer, after the settings are written, says so instead.
class Interrupted extends EndOfAnswers {
  constructor(message = 'Stopped at Ctrl+C. Nothing changed.') {
    super(message);
  }
}

const MAX_ROWS = 3;
const SEGMENTS = ['5', '10'] as const;

// The status line choices, as the wizard builds them up. The bar style and
// the cells are for every bar, each bar's own after them. The ctx bar's
// style is the token line's too.
interface StatusChoices {
  rows: Part[][];
  barStyle: BarValues;
  segments: BarValues;
  theme: string;
  labels: boolean;
  // The switches the wizard does not ask about, as words, kept as they are.
  others: string[];
}

const DEFAULT_CHOICES: StatusChoices = {
  rows: DEFAULT_ROWS,
  barStyle: { all: 'classic', each: {} },
  segments: { all: '5', each: {} },
  theme: 'default',
  labels: true,
  others: [],
};

// A per-bar list read with only the values in `values`: any other reads as
// `fallback`, as the status line reads an unknown name or size.
function barValuesOf(list: string, values: readonly string[], fallback: string): BarValues {
  const { all, each } = perBarOf(list);
  const known = (value: string) => (values.includes(value) ? value : fallback);
  return { all: known(all), each: Object.fromEntries(Object.entries(each).map(([bar, value]) => [bar, known(value)])) };
}

// The value of `bar`: its own, else the one for every bar.
const valueAt = ({ all, each }: BarValues, bar: Bar) => each[bar] ?? all;

// The values for `all` and each of `bars`, keeping only the bars whose value
// differs from all.
const barValuesFrom = (all: string, bars: readonly Bar[], each: readonly string[]): BarValues => ({
  all,
  each: Object.fromEntries(bars.flatMap((bar, i) => (each[i] === all ? [] : [[bar, each[i]]]))),
});

// Reads a typed per-bar list, such as steps,ctx=rising: each entry a value
// from `values`, bare for every bar or after a bar's name for that bar. A
// list with no bare value changes only the bars it names in `fallback`;
// Enter keeps all of it.
function readBarValues(answer: string, fallback: BarValues, values: readonly string[], what: string, example: string): BarValues | { retry: string } {
  if (!answer.trim()) return fallback;
  for (const item of answer.split(',')) {
    const [key, value] = item.split(/=(.*)/s).map((word) => word.trim().toLowerCase());
    const known = value === undefined ? values.includes(key) : (BARS as readonly string[]).includes(key) && values.includes(value);
    if (!known) return { retry: `Unknown ${what}: ${item.trim()}. Answer one of ${values.join(', ')}, or a list such as ${example}.` };
  }
  const { all, each } = perBarOf(answer);
  return all ? { all, each } : { all: fallback.all, each: { ...fallback.each, ...each } };
}

// Where the wizard starts: the status line choices, whether the token line
// is on, and the token line's switches to keep when it stays on.
interface WizardStart {
  status: StatusChoices;
  tokenLine: boolean;
  tokenSwitches: string[];
}

// Whether two lists of parts, or of rows of parts, are the same, in order.
const same = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

// The fewest switches that give `choices`: none for the defaults, then the
// switches the wizard does not ask about. A row not chosen yet is left out.
function switchesFor({ rows, barStyle, segments, theme, labels, others }: StatusChoices): string[] {
  const chosen = rows.filter((row) => row.length);
  const words: string[] = [];
  if (!same(chosen, DEFAULT_ROWS)) for (const row of chosen) words.push('--show', row.join(','));
  if (perBarList(barStyle) !== 'classic') words.push('--bar-style', perBarList(barStyle));
  if (perBarList(segments) !== '5') words.push('--segments', perBarList(segments));
  if (theme !== 'default') words.push('--theme', theme);
  if (!labels) words.push('--no-labels');
  return [...words, ...others];
}

// The status line choices that `switches` give, read as the status line reads
// them, so the last --bar-style, --segments or --theme wins. A part name or theme the
// status line does not know reads as the status line shows it: left out, or
// the default theme.
function statusChoicesOf(switches: readonly string[]): StatusChoices {
  const status: StatusChoices = { ...DEFAULT_CHOICES, rows: [], others: [] };
  for (const { name, value, words } of readSwitches(switches)) {
    if (name === '--show') {
      const row = value.split(',').map((p) => p.trim()).filter((p): p is Part => (PARTS as readonly string[]).includes(p));
      if (row.length) status.rows.push(row);
    } else if (name === '--bar-style') status.barStyle = barValuesOf(value, BAR_STYLES, 'classic');
    else if (name === '--segments') status.segments = barValuesOf(value, SEGMENTS, '5');
    else if (name === '--theme') status.theme = THEMES.includes(value.trim()) ? value.trim() : 'default';
    else if (name === '--no-labels') status.labels = false;
    else status.others.push(...words);
  }
  if (!status.rows.length) status.rows = DEFAULT_ROWS;
  return status;
}

const isSetUp = (installed: InstalledSwitches | undefined): installed is InstalledSwitches =>
  installed?.statusLine !== undefined || installed?.tokenLine !== undefined;

// The start from the bars set up, else from the factory defaults.
function startFrom(installed: InstalledSwitches | undefined): WizardStart {
  if (!isSetUp(installed)) return { status: DEFAULT_CHOICES, tokenLine: true, tokenSwitches: [] };
  return {
    status: statusChoicesOf(installed.statusLine ?? []),
    tokenLine: installed.tokenLine !== undefined,
    tokenSwitches: installed.tokenLine ?? [],
  };
}

const stylesOf = (io: WizardIo): Styles => styles(io.color === true);

// A default in brackets, dim, such as [Y/n].
const hint = (s: Styles, value: string | number) => s.dim(`[${value}]`);

// Asks until `read` takes the answer: it returns the value, or a retry that
// says why it cannot. Each `read` says what an empty answer, Enter, gives.
// A magenta pill comes before the question, as VerBump's prompts have one:
// CONFIRM for a yes or no, INPUT for any other answer. A front end with
// choices asks with `pick` instead, the same question as a choice.
async function askFor<T>(
  io: WizardIo,
  question: string,
  read: (answer: string) => T | { retry: string },
  kind: 'CONFIRM' | 'INPUT' = 'INPUT',
  pick?: (choices: ChoiceIo) => Promise<T>,
): Promise<T> {
  if (io.choices && pick) return pick(io.choices);
  const s = stylesOf(io);
  io.write(s.pill(kind, 'question'));
  for (;;) {
    const answer = await io.ask(question);
    if (answer === undefined) throw new EndOfAnswers();
    const value = read(answer.trim());
    if (typeof value === 'object' && value !== null && 'retry' in value) {
      io.write(s.warn(value.retry));
      continue;
    }
    return value as T;
  }
}

const yesNo = (fallback: boolean) => (answer: string) => {
  if (!answer) return fallback;
  if (/^y(?:es)?$/i.test(answer)) return true;
  if (/^no?$/i.test(answer)) return false;
  return { retry: 'Answer y or n.' };
};

// A yes or no, `fallback` on Enter. As a choice, Yes and No, with `preview`
// for the preview each gives.
const confirm = (io: WizardIo, question: string, fallback: boolean, preview?: (yes: boolean) => string) =>
  askFor(io, `${question} ${hint(stylesOf(io), fallback ? 'Y/n' : 'y/N')} `, yesNo(fallback), 'CONFIRM', (c) =>
    c.one({ kind: 'CONFIRM', message: question, options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], initial: fallback ? 0 : 1, preview }),
  );

// A choice of one of `values`, shown as written, `fallback` first.
const oneOf =
  <T extends string | number>(message: string, values: readonly T[], fallback: T, preview?: (value: T) => string, moving = false) =>
  (c: ChoiceIo) =>
    c.one({ kind: 'INPUT', message, options: values.map((value) => ({ label: String(value), value })), initial: Math.max(0, values.indexOf(fallback)), preview, moving });

// Reads a list of parts from `known`, or `fallback` on Enter. An unknown
// part is asked again, named, with `where` to say which parts there are.
function readParts<P extends string>(fallback: P[] | undefined, known: readonly P[], where = 'The parts are listed above.') {
  return (answer: string): P[] | { retry: string } => {
    if (!answer && fallback) return fallback;
    const names = answer.split(/[\s,]+/).filter(Boolean);
    const unknown = names.filter((n) => !(known as readonly string[]).includes(n));
    if (unknown.length) return { retry: `Unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ${where}` };
    if (!names.length) return { retry: 'Name at least one part.' };
    return [...new Set(names)] as P[];
  };
}

// The parts the token line shows with `switches`, read as the token line
// reads them: all of them without a --show it can use.
const tokenPartsOf = (switches: readonly string[]): TokenPart[] => parseTokenArgs(switches).show ?? [...TOKEN_PARTS];

// The token line's `switches` without each `name` switch and its value, as
// the token line reads them, so the rest stay as written.
const without = (switches: readonly string[], name: string): string[] =>
  readTokenSwitches(switches).filter((s) => s.name !== name).flatMap(({ words }) => words);

// The token line's switches for `parts`. Parts the installed switches show
// already keep those switches as they are. Other parts drop the installed
// --show and keep the rest. All five parts, in order, need no --show; any
// other list goes first, as --show <parts>.
function tokenSwitchesFor(parts: TokenPart[], installed: string[]): string[] {
  if (same(parts, tokenPartsOf(installed))) return installed;
  const others = without(installed, '--show');
  return same(parts, TOKEN_PARTS) ? others : ['--show', parts.join(','), ...others];
}

// The token line's `switches` with the status line's ctx bar style, so the
// two ctx bars look alike. classic needs no switch.
const withBarStyle = (switches: readonly string[], barStyle: BarValues): string[] => {
  const ctx = valueAt(barStyle, 'ctx');
  return [...without(switches, '--bar-style'), ...(ctx === 'classic' ? [] : ['--bar-style', ctx])];
};

// Reads the token line's parts: `all` for all five, else a list as readParts
// reads it.
function readTokenParts(fallback: TokenPart[]) {
  const list = readParts(fallback, TOKEN_PARTS, `The token line parts are ${TOKEN_PARTS.join(', ')}.`);
  return (answer: string) => (/^all$/i.test(answer) ? [...TOKEN_PARTS] : list(answer));
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
function screenOf(io: WizardIo) {
  let rows = 0;
  let column = 0;
  let live = false;
  const count = (text: string) => {
    const width = io.terminal?.columns || Infinity;
    for (const ch of stripOwnCodes(text)) {
      if (ch === '\n') {
        rows++;
        column = 0;
      } else if (++column > width) {
        rows++;
        column = 1;
      }
    }
  };
  const write = (text: string) => {
    io.write(text);
    count(text);
  };
  const clear = () => {
    io.choices?.preview('');
    if (io.terminal && live) io.write(`\r${rows ? `\x1b[${rows}A` : ''}\x1b[J`);
    rows = 0;
    column = 0;
    live = false;
  };
  const screen: WizardIo & { keep(text: string): void; preview(text: string | (() => string)): void; clear(): void } = {
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
      if (io.choices) return io.choices.preview(text);
      clear();
      live = true;
      write(typeof text === 'function' ? text() : text);
    },
    clear,
  };
  return screen;
}

// The first question when lines are set up, with the words each typed
// answer takes: keep them, change them from where they are, or start over
// from the defaults.
type Start = 'keep' | 'change' | 'over';
const START_OPTIONS: (Option<Start> & { words: string[] })[] = [
  { label: 'Keep them as they are', value: 'keep', words: ['keep', 'k'] },
  { label: 'Change them', value: 'change', words: ['change', 'c'] },
  { label: 'Start over from the defaults', value: 'over', words: ['over', 'o', 'start over', 's'] },
];

// The questions, then the switches for each bar. A front end with choices
// shows no preview once they end, so a question after them, such as the star
// offer, comes without one.
async function runWizard(userIo: WizardIo, options: WizardOptions): Promise<WizardChoices | null> {
  try {
    return await askAll(userIo, options);
  } finally {
    userIo.choices?.preview('');
  }
}

async function askAll(userIo: WizardIo, { preview, tokenPreview = tokenPreviewer(), installed }: WizardOptions): Promise<WizardChoices | null> {
  const io = screenOf(userIo);
  const s = stylesOf(io);
  let start = startFrom(installed);
  let status: StatusChoices = { ...start.status };
  let tokenLine = start.tokenLine;
  let tokenSwitches = start.tokenSwitches;
  // The preview of `choices` in the status line's own colours, or as plain
  // text when the questions take no colour, under `heading` when one is given.
  // With the token line on, its line with `withTokenSwitches` comes under it.
  // The bars move with the clock when `moving` is set.
  const previewOf = (choices: StatusChoices, withTokenLine = tokenLine, heading = '', withTokenSwitches = tokenSwitches, moving = false) => {
    const rendered = preview(switchesFor(choices), !io.color, moving);
    const rows = io.color ? rendered : stripOwnCodes(rendered);
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
  const previewWith = (change: Partial<StatusChoices>) => previewOf({ ...status, ...change });
  // A value for every bar, and each bar's own, from `values`. Typed, a list
  // such as steps,ctx=rising, Enter for `fallback`. As a choice, a tab for
  // All and one for each of `bars`, or one plain choice for a single bar.
  const askPerBar = (
    typed: string,
    message: string,
    values: readonly string[],
    fallback: BarValues,
    bars: readonly Bar[],
    previewFor: (values: BarValues) => string,
    { what, example, moving = false }: { what: string; example: string; moving?: boolean },
  ) => {
    const options = values.map((value) => ({ label: value, value }));
    return askFor(
      io,
      `${typed} ${hint(s, perBarList(fallback))} `,
      (answer) => readBarValues(answer, fallback, values, what, example),
      'INPUT',
      async (c): Promise<BarValues> => {
        if (bars.length === 1) {
          const at = Math.max(0, values.indexOf(valueAt(fallback, bars[0])));
          const value = await c.one({ kind: 'INPUT', message, options, initial: at, preview: (v) => previewFor({ all: v, each: {} }), moving });
          return { all: value, each: {} };
        }
        const initial = { all: fallback.all, each: bars.map((bar) => valueAt(fallback, bar)) };
        const chosen = await c.each({ message, targets: bars, options, initial, preview: (all, each) => previewFor(barValuesFrom(all, bars, each)), moving });
        return barValuesFrom(chosen.all, bars, chosen.each);
      },
    );
  };

  // With lines set up: keep them, change them from where they are, or start
  // over from the defaults, as a first setup does.
  let fresh = !isSetUp(installed);
  if (isSetUp(installed)) {
    const heading = installed.statusLine ? 'The status line as set up now:\n' : 'The status line is not set up. With the defaults it shows:\n';
    show(heading);
    const defaults = startFrom(undefined);
    const answer = await askFor(
      io,
      `Keep the current lines, change them, or start over from the defaults? keep, change or over ${hint(s, 'keep')} `,
      (typed) => START_OPTIONS.find((o) => o.words.includes(typed.trim().toLowerCase() || 'keep'))?.value ?? { retry: 'Answer keep, change or over.' },
      'INPUT',
      (c) =>
        c.one({
          kind: 'INPUT',
          message: 'Keep the current lines, change them, or start over?',
          options: START_OPTIONS,
          initial: 0,
          preview: (value) =>
            value === 'over'
              ? previewOf(defaults.status, defaults.tokenLine, 'The status line with the defaults:\n', defaults.tokenSwitches)
              : previewOf(status, tokenLine, heading),
        }),
    );
    if (answer === 'keep') return {};
    if (answer === 'over') {
      start = defaults;
      status = { ...defaults.status };
      tokenLine = defaults.tokenLine;
      tokenSwitches = defaults.tokenSwitches;
      fresh = true;
    }
  }
  if (fresh) {
    show('The status line with the defaults:\n');
    if (await confirm(io, 'Use the defaults: both lines, with the parts above?', true)) return { statusLine: [], tokenLine: [] };
  }

  // A row set up, else the default row there.
  const rowAt = (i: number): Part[] | undefined => start.status.rows[i] ?? DEFAULT_ROWS[i];
  const rowsFor = (n: number) => Array.from({ length: n }, (_, i) => rowAt(i) ?? []);
  // More rows than the wizard offers stay possible when that many are set up.
  const rowsNow = start.status.rows.length;
  const maxRows = Math.max(MAX_ROWS, rowsNow);
  // The customise path starts below the questions, where the first preview
  // and the question under it were: the next preview takes their place.
  io.clear();
  io.keep(
    `${s.pill('Status line')}The parts: ${PARTS.map(s.value).join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`,
  );
  const counts = Array.from({ length: maxRows }, (_, i) => i + 1);
  const count = await askFor(
    io,
    `How many status line rows, 1 to ${maxRows}? ${hint(s, rowsNow)} `,
    (answer) => {
      const n = answer ? Number(answer) : rowsNow;
      return Number.isInteger(n) && n >= 1 && n <= maxRows ? n : { retry: `Answer a number from 1 to ${maxRows}.` };
    },
    'INPUT',
    oneOf('How many status line rows?', counts, rowsNow, (n) => previewWith({ rows: rowsFor(n) })),
  );
  status = { ...status, rows: rowsFor(count) };
  show();

  for (let i = 0; i < count; i++) {
    const fallback = rowAt(i);
    const brackets = fallback ? ` ${hint(s, fallback.join(','))}` : '';
    const withRow = (parts: Part[]) => status.rows.map((row, j) => (j === i ? parts : row));
    const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${brackets} `, readParts(fallback, PARTS), 'INPUT', (c) =>
      c.many({ message: `Row ${i + 1}: the parts`, options: PARTS, initial: fallback ?? [], preview: (ticked) => previewWith({ rows: withRow(ticked) }) }),
    );
    status = { ...status, rows: withRow(parts) };
    show();
  }

  // The bar style: for every bar, and for each bar on its own. The one
  // question whose preview moves: its bars sweep, to show how each style
  // fills and how it marks the pace.
  const barStyle = await askPerBar(
    `Bar style: ${BAR_STYLES.join(', ')}, or a list such as steps,ctx=rising?`,
    'Bar style?',
    BAR_STYLES,
    start.status.barStyle,
    BARS,
    (values) => previewOf({ ...status, barStyle: values }, tokenLine, '', tokenSwitches, true),
    { what: 'bar style', example: 'steps,ctx=rising', moving: true },
  );
  status = { ...status, barStyle };
  show();

  // Only classic takes a number of cells: each other style has its own. So
  // the question is for the classic bars only, and none asks none.
  const classic = BARS.filter((bar) => valueAt(barStyle, bar) === 'classic');
  if (classic.length) {
    const segments = await askPerBar(
      `Cells per classic bar, ${SEGMENTS.join(' or ')}, or a list such as 5,ctx=10?`,
      'Cells per classic bar?',
      SEGMENTS,
      start.status.segments,
      classic,
      (values) => previewWith({ segments: values }),
      { what: 'number of cells', example: '5,ctx=10' },
    );
    status = { ...status, segments };
    show();
  }

  const theme = await askFor(
    io,
    `Theme: ${THEMES.join(', ')}? ${hint(s, start.status.theme)} `,
    (answer) => {
      const name = answer.toLowerCase() || start.status.theme;
      return THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${THEMES.join(', ')}.` };
    },
    'INPUT',
    oneOf('Theme?', THEMES, start.status.theme, (name) => previewWith({ theme: name })),
  );
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
    const question = `Token line parts: all, req,out,ctx, or your own list from ${TOKEN_PARTS.map(s.value).join(', ')}? ${hint(s, fallback.join(','))} `;
    const parts = await askFor(io, question, readTokenParts(fallback), 'INPUT', (c) =>
      c.many({
        message: 'Token line parts',
        options: TOKEN_PARTS,
        initial: fallback,
        preview: (ticked) => previewOf(status, true, '', tokenSwitchesFor(ticked, start.tokenSwitches)),
      }),
    );
    // The token line reads the context window the status line saves, so
    // there is no question for it. A --window set up stays as it is.
    tokenSwitches = tokenSwitchesFor(parts, start.tokenSwitches);
    show();
  }

  if (!(await confirm(io, 'Write these choices?', true))) return null;
  return { statusLine: switchesFor(status), tokenLine: tokenLine ? withBarStyle(tokenSwitches, status.barStyle) : null };
}

// The token line's sample run since the last prompt: four requests, the last
// at 43% of a 200k context, as in the status line's sample.
const SAMPLE_RUN: TokenRecord[] = [
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
function tokenPreviewer(nowMs?: number) {
  return (switches: readonly string[]) => {
    const { show, segments, barStyle, window } = parseTokenArgs([...switches]);
    return summarize(SAMPLE_RUN, { now: nowMs === undefined ? new Date() : new Date(nowMs), show, segments, barStyle, window, savedWindow: SAMPLE_WINDOW }) ?? '';
  };
}

const REPO = 'jv-k/claude-gauge';

interface StarOptions {
  // Whether the gh command runs here.
  hasGh: () => boolean;
  // Stars the repo with gh; false when gh failed.
  star: () => boolean;
}

// The end of setup: with gh at hand, offers to star the repo, and stars it
// on a yes or Enter. Without gh it says nothing. The end of the input is a no,
// and Ctrl+C stops setup, as at any other question.
async function offerStar(io: WizardIo, { hasGh, star }: StarOptions): Promise<void> {
  if (!hasGh()) return;
  let yes: boolean;
  try {
    yes = await confirm(io, `Star ${REPO} on GitHub with gh?`, true);
  } catch (err) {
    if (err instanceof Interrupted) throw new Interrupted('Stopped at Ctrl+C. The settings are written, and the repo is not starred.');
    if (err instanceof EndOfAnswers) return;
    throw err;
  }
  if (!yes) return;
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
function samplePayload(nowMs: number): StatusData {
  const at = (ms: number) => Math.floor((nowMs + ms) / 1000);
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
function sampleActivity(nowMs: number): TranscriptActivity {
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
function sampleLedger(nowMs: number): Ledger {
  const now = new Date(nowMs);
  const days: Record<string, number> = {};
  SAMPLE_DAYS.forEach((usd, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = usd;
  });
  return { days, sessions: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The real value with the sample's under it, object by object: the sample
// fills only what is missing or null.
function underSample(real: unknown, sample: unknown): unknown {
  if (real === undefined || real === null) return sample;
  if (!isRecord(real) || !isRecord(sample)) return real;
  const merged: Record<string, unknown> = { ...sample, ...real };
  for (const key of Object.keys(sample)) merged[key] = underSample(real[key], sample[key]);
  return merged;
}

// The payload with the sample's fields under it. thinking, fast and style
// show nothing while they are off, so the preview shows the sample's. The
// sample's worktree comes in only when `shown` holds the worktree part.
function withSamplePayload(payload: StatusData, nowMs: number, shown: ReadonlySet<string>): StatusData {
  const sample = samplePayload(nowMs);
  const data = underSample(payload, sample) as StatusData;
  if (shown.has('worktree') && !data.workspace?.git_worktree && !data.worktree?.name) data.workspace = { ...data.workspace, git_worktree: SAMPLE_WORKTREE };
  if (!data.thinking?.enabled) data.thinking = sample.thinking;
  if (!data.fast_mode) data.fast_mode = sample.fast_mode;
  if (!data.output_style?.name || data.output_style.name === 'default') data.output_style = sample.output_style;
  return data;
}

// What the transcript shows, with the sample's in each kind it shows none of.
function withSampleActivity(real: TranscriptActivity, nowMs: number): TranscriptActivity {
  const sample = sampleActivity(nowMs);
  const { tools, agents = [], todos = [], skills = [], mcp = [], compactions, lastReplyAt, speed } = real;
  const shownAgent = agents.some((a) => a.endedAt === undefined || nowMs - a.endedAt < AGENT_LINGER_MS);
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
function withSampleStatus(status: string | undefined, branch: () => string, withChanges: boolean): string {
  const lines = (status ?? '').split(/\r?\n/).filter(Boolean);
  const head = lines.filter((line) => line.startsWith('#'));
  const changes = lines.filter((line) => !line.startsWith('#'));
  const named = status === undefined && branch() ? [`# branch.head ${branch()}`] : head;
  const hasBranch = named.some((line) => /^# branch\.head (?!\(detached\))\S/.test(line));
  return [...(hasBranch ? named : SAMPLE_GIT_HEAD), ...(changes.length || !withChanges ? changes : SAMPLE_GIT_CHANGES)].join('\n');
}

// What Claude Code loads, with the sample's counts where it loads nothing
// and the sample's plan where neither plan nor user is known.
function withSampleSetup(real: Setup): Setup {
  const counts = real.claudeMd || real.rules || real.mcp || real.hooks ? {} : SAMPLE_ENV;
  return { ...real, ...counts, ...(real.plan || real.user ? {} : { plan: SAMPLE_PLAN }) };
}

// The payload the status line saved, or the sample when there is none, or
// none that reads as a payload: a JSON object that holds something.
function loadPayload(file: string, nowMs = Date.now()): StatusData {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved) && Object.keys(saved).length) return saved as StatusData;
  } catch {
    /* no payload saved yet, or half of one */
  }
  return samplePayload(nowMs);
}

// The preview's options: render's, and `sweep` to let the bars move with the
// clock in a preview asked for `moving`. With sweep set, the reads of git and
// the files are kept, as an animated preview renders many times a second.
type PreviewOptions = Omit<Parameters<typeof render>[1] & object, 'config' | 'plain'> & { sweep?: boolean };

// The payload with the context, 5h and 7d bars moved to where they are at
// `nowMs` in the preview's animation. Each climbs and falls on its own
// period, and "now" moves through each window, so the pace marker walks
// and changes colour. The other fields stay as they are.
function swept(payload: StatusData, nowMs: number): StatusData {
  const wave = (period: number, phase: number) => {
    const x = (((nowMs / period + phase) % 1) + 1) % 1;
    return x < 0.5 ? x * 2 : 2 - x * 2;
  };
  const pct = (period: number, phase: number) => {
    const x = wave(period, phase);
    return Math.round(100 * x * x * (3 - 2 * x));
  };
  const resetsAt = (seconds: number, period: number, phase: number) => Math.floor(nowMs / 1000 + seconds * (0.92 - 0.84 * wave(period, phase)));
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
function kept<A extends unknown[], R>(read: (...args: A) => R): (...args: A) => R {
  const answers = new Map<string, R>();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!answers.has(key)) answers.set(key, read(...args));
    return answers.get(key) as R;
  };
}

// The preview: the status line's rows for `payload`, with the given switches
// as words, as the settings command passes them. A part with nothing to show
// shows its sample, and only the preview does: the status line itself shows
// nothing for it. The preview reads the transcript, git and the files Claude
// Code loads, as the status line does, but never runs --command, and takes
// the sample ledger in place of the real one.
function previewer(payload: StatusData, options: PreviewOptions = {}) {
  const { sweep = false, ...renderOptions } = options;
  const keep = <A extends unknown[], R>(read: (...args: A) => R) => (sweep ? kept(read) : read);
  const transcript = keep(options.transcript ?? readTranscriptActivity);
  const statusOf = keep(options.statusOf ?? gitStatus);
  const branchOf = keep(options.branchOf ?? headBranch);
  const memoryOf = keep(options.memoryOf ?? readMemory);
  const setupOf = keep(options.setupOf ?? ((cwd: string) => readSetup(cwd, { env: options.env ?? process.env })));
  return (switches: readonly string[], plain = false, moving = false) => {
    const nowMs = options.nowMs ?? Date.now();
    const config = parseArgs([...switches]);
    const shown = new Set<string>((config.rows ?? DEFAULT_ROWS).flat());
    const data = withSamplePayload(payload, nowMs, shown);
    return render(sweep && moving ? swept(data, nowMs) : data, {
      ...renderOptions,
      nowMs,
      plain,
      // Any command will do, as the preview runs none: the part shows the
      // sample's output.
      config: { ...config, text: config.text || SAMPLE_TEXT, command: config.command || 'sample' },
      transcript: (file, read) => {
        let real: TranscriptActivity = { tools: { running: [], completed: {} }, agents: [], todos: [], skills: [], mcp: [], compactions: 0 };
        try {
          if (file !== SAMPLE_TRANSCRIPT) real = transcript(file, read);
        } catch {
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

// What the questions read from: a terminal, or a pipe or file.
type Input = NodeJS.ReadableStream & { isTTY?: boolean };

// An io for the questions on a pair of streams, which `close` lets go of.
type OpenIo = WizardIo & { close(): void };

// What streamIo writes to: a terminal, or a pipe or file.
interface Output {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

// The questions on a pair of streams: each prompt on `output`, each answer a
// line of `input`. Lines are queued as they arrive, so answers piped in all
// at once each reach their question. A terminal echoes each answer and its
// Enter; a piped answer is not, so the io writes it and ends its line
// itself, as a terminal would show it, and a retry or a preview never runs
// on from the question. The questions are in
// colour when the colour gate allows, and redraw the preview in place when
// `output` is a terminal.
function streamIo(input: Input, output: Output, color = colorEnabled(output)): OpenIo {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  return {
    color,
    terminal: output.isTTY ? output : undefined,
    ask: async (question) => {
      output.write(question);
      const next = await lines.next();
      if (!input.isTTY) output.write(`${next.done ? '' : next.value}\n`);
      return next.done ? undefined : next.value;
    },
    write: (text) => {
      output.write(text);
    },
    close: () => rl.close(),
  };
}

// Loads the Ink front end for the two streams. It rejects where Ink cannot be
// loaded, such as the plugin's checkout, which has no node_modules. The
// import() stays an import() in the build, which loads Ink, an ES module, on
// every Node the package runs on; a require() would not.
type LoadInk = (input: Input, output: Output, color: boolean) => Promise<OpenIo>;
const loadInk: LoadInk = async (input, output, color) => (await import('./ink-io.js')).loadInkIo(input, output, color);

// The questions on a pair of streams: the Ink front end when both are a
// terminal and Ink loads, else the readline one, with no warning, as for
// piped answers.
async function openIo(input: Input, output: Output, load: LoadInk = loadInk): Promise<OpenIo> {
  const color = colorEnabled(output);
  if (input.isTTY && output.isTTY) {
    try {
      return await load(input, output, color);
    } catch {
      /* no Ink here: the readline questions ask instead */
    }
  }
  return streamIo(input, output, color);
}

export { runWizard, offerStar, confirm, streamIo, openIo, EndOfAnswers, Interrupted, samplePayload, SAMPLE_RUN, loadPayload, previewer, tokenPreviewer, switchesFor };

export type { WizardIo, WizardOptions, WizardChoices, StarOptions, ChoiceIo, Output, Input, OpenIo };
