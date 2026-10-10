// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar size, theme and labels, and the token line,
// its parts and its context window, with a preview of the status line
// redrawn after each answer. configure starts from the bars set up now: the first answer keeps
// them, and each question offers the value set up. It returns the switches
// for each bar, as words, for the CLI to write; it reads and writes no
// settings itself.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample.

import * as fs from 'node:fs';
import { render, parseArgs, readSwitches, PARTS, THEMES, DEFAULT_ROWS } from './statusline';
import { PARTS as TOKEN_PARTS, parseArgs as parseTokenArgs, readSwitches as readTokenSwitches, parseSize, contextWindow } from './tokenline';
import type { StatusData, Part } from './statusline';
import type { Part as TokenPart } from './tokenline';
import type { InstalledSwitches } from './settings';

interface WizardIo {
  // Shows `question` and resolves to the answer, or to undefined at the end
  // of the input.
  ask(question: string): Promise<string | undefined>;
  write(text: string): void;
}

interface WizardOptions {
  // The status line's rows when run with these switches.
  preview: (statusLineSwitches: readonly string[]) => string;
  // The bars configure found. The wizard starts from them, and from the
  // factory defaults when neither bar is set up.
  installed?: InstalledSwitches;
}

// The switches for each bar, as words: the words to run it with, null to
// leave it out, undefined to leave it as it is, which a yes to keeping the
// bars gives.
interface WizardChoices {
  statusLine?: string[];
  tokenLine?: string[] | null;
}

// The input ended before the last question: nothing is written.
class EndOfAnswers extends Error {
  constructor() {
    super('The answers ended before the last question. Nothing changed.');
  }
}

const MAX_ROWS = 3;
const SEGMENTS = [5, 10] as const;

// The status line choices, as the wizard builds them up.
interface StatusChoices {
  rows: Part[][];
  segments: (typeof SEGMENTS)[number];
  theme: string;
  labels: boolean;
  // The switches the wizard does not ask about, as words, kept as they are.
  others: string[];
}

const DEFAULT_CHOICES: StatusChoices = { rows: DEFAULT_ROWS, segments: 5, theme: 'default', labels: true, others: [] };

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
function switchesFor({ rows, segments, theme, labels, others }: StatusChoices): string[] {
  const chosen = rows.filter((row) => row.length);
  const words: string[] = [];
  if (!same(chosen, DEFAULT_ROWS)) for (const row of chosen) words.push('--show', row.join(','));
  if (segments !== 5) words.push('--segments', String(segments));
  if (theme !== 'default') words.push('--theme', theme);
  if (!labels) words.push('--no-labels');
  return [...words, ...others];
}

// The status line choices that `switches` give, read as the status line reads
// them, so the last --segments or --theme wins. A part name or theme the
// status line does not know reads as the status line shows it: left out, or
// the default theme.
function statusChoicesOf(switches: readonly string[]): StatusChoices {
  const status: StatusChoices = { ...DEFAULT_CHOICES, rows: [], others: [] };
  for (const { name, value, words } of readSwitches(switches)) {
    if (name === '--show') {
      const row = value.split(',').map((p) => p.trim()).filter((p): p is Part => (PARTS as readonly string[]).includes(p));
      if (row.length) status.rows.push(row);
    } else if (name === '--segments') status.segments = Number(value) === 10 ? 10 : 5;
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

// Asks until `read` takes the answer: it returns the value, or a retry that
// says why it cannot. Each `read` says what an empty answer, Enter, gives.
async function askFor<T>(io: WizardIo, question: string, read: (answer: string) => T | { retry: string }): Promise<T> {
  for (;;) {
    const answer = await io.ask(question);
    if (answer === undefined) throw new EndOfAnswers();
    const value = read(answer.trim());
    if (typeof value === 'object' && value !== null && 'retry' in value) {
      io.write(`${value.retry}\n`);
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

const confirm = (io: WizardIo, question: string, fallback: boolean) =>
  askFor(io, `${question} ${fallback ? '[Y/n]' : '[y/N]'} `, yesNo(fallback));

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

// The token line's switches for `parts`. Parts the installed switches show
// already keep those switches as they are. Other parts drop the installed
// --show and keep the rest. All five parts, in order, need no --show; any
// other list goes first, as --show <parts>.
function tokenSwitchesFor(parts: TokenPart[], installed: string[]): string[] {
  if (same(parts, tokenPartsOf(installed))) return installed;
  const others = readTokenSwitches(installed).filter(({ name }) => name !== '--show').flatMap(({ words }) => words);
  return same(parts, TOKEN_PARTS) ? others : ['--show', parts.join(','), ...others];
}

// Reads the token line's parts: `all` for all five, else a list as readParts
// reads it.
function readTokenParts(fallback: TokenPart[]) {
  const list = readParts(fallback, TOKEN_PARTS, `The token line parts are ${TOKEN_PARTS.join(', ')}.`);
  return (answer: string) => (/^all$/i.test(answer) ? [...TOKEN_PARTS] : list(answer));
}

// The context window the token line assumes at the first turn without a
// --window it can read.
const DEFAULT_WINDOW = contextWindow(0);

// The context window `switches` name, as the token line reads them: the last
// --window's value, as written, or undefined without one it can read.
function tokenWindowOf(switches: readonly string[]): string | undefined {
  const value = parseTokenArgs(switches).window;
  return parseSize(value) > 0 ? value : undefined;
}

// The token line's switches for a context window answer. The size the
// installed --window gives keeps those switches as they are. Another size
// drops the installed --window and keeps the rest, then adds the size as
// --window <size>, unless it is the 200k the token line assumes without one.
function tokenWindowFor(size: string, installed: string[]): string[] {
  if (parseSize(size) === parseSize(tokenWindowOf(installed))) return installed;
  const others = readTokenSwitches(installed).filter(({ name }) => name !== '--window').flatMap(({ words }) => words);
  return parseSize(size) === DEFAULT_WINDOW ? others : [...others, '--window', size];
}

// Reads a context window size as the token line reads --window, in lower
// case: 200k, 1m or a count. Enter gives undefined, which keeps the switches
// as they are.
const readWindow = (answer: string): string | undefined | { retry: string } => {
  if (!answer) return undefined;
  return parseSize(answer) > 0 ? answer.toLowerCase() : { retry: 'Answer a size such as 200k or 1m.' };
};

async function runWizard(io: WizardIo, { preview, installed }: WizardOptions): Promise<WizardChoices | null> {
  const start = startFrom(installed);
  let status: StatusChoices = { ...start.status };
  let tokenLine = start.tokenLine;
  const show = () => {
    const rows = preview(switchesFor(status));
    io.write(`\n${rows.split('\n').map((row) => `  ${row}`).join('\n')}\n`);
    io.write(`Token line: ${tokenLine ? 'on, when each turn ends' : 'off'}\n\n`);
  };

  if (isSetUp(installed)) {
    io.write(installed.statusLine ? 'The status line as set up now:\n' : 'The status line is not set up. With the defaults it shows:\n');
    show();
    if (await confirm(io, 'Keep the current bars as they are?', true)) return {};
  } else {
    io.write('The status line with the defaults:\n');
    show();
    if (await confirm(io, 'Use the defaults: both bars, with the parts above?', true)) return { statusLine: [], tokenLine: [] };
  }

  // A row set up, else the default row there.
  const rowAt = (i: number): Part[] | undefined => start.status.rows[i] ?? DEFAULT_ROWS[i];
  // More rows than the wizard offers stay possible when that many are set up.
  const rowsNow = start.status.rows.length;
  const maxRows = Math.max(MAX_ROWS, rowsNow);
  io.write(`\nThe parts: ${PARTS.join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`);
  const count = await askFor(io, `How many status line rows, 1 to ${maxRows}? [${rowsNow}] `, (answer) => {
    const n = answer ? Number(answer) : rowsNow;
    return Number.isInteger(n) && n >= 1 && n <= maxRows ? n : { retry: `Answer a number from 1 to ${maxRows}.` };
  });
  status = { ...status, rows: Array.from({ length: count }, (_, i) => rowAt(i) ?? []) };
  show();

  for (let i = 0; i < count; i++) {
    const fallback = rowAt(i);
    const hint = fallback ? ` [${fallback.join(',')}]` : '';
    const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${hint} `, readParts(fallback, PARTS));
    status = { ...status, rows: status.rows.map((row, j) => (j === i ? parts : row)) };
    show();
  }

  const segments = await askFor(io, `Cells per bar, ${SEGMENTS.join(' or ')}? [${start.status.segments}] `, (answer) =>
    SEGMENTS.find((n) => String(n) === (answer || String(start.status.segments))) ?? { retry: `Answer ${SEGMENTS.join(' or ')}.` },
  );
  status = { ...status, segments };
  show();

  const theme = await askFor(io, `Theme: ${THEMES.join(', ')}? [${start.status.theme}] `, (answer) => {
    const name = answer.toLowerCase() || start.status.theme;
    return THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${THEMES.join(', ')}.` };
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
    const question = `Token line parts: all, req,out,ctx, or your own list from ${TOKEN_PARTS.join(', ')}? [${fallback.join(',')}] `;
    tokenSwitches = tokenSwitchesFor(await askFor(io, question, readTokenParts(fallback)), start.tokenSwitches);
    const window = await askFor(io, `Context window, 200k or 1m? [${tokenWindowOf(start.tokenSwitches) ?? '200k'}] `, readWindow);
    if (window !== undefined) tokenSwitches = tokenWindowFor(window, tokenSwitches);
  }

  if (!(await confirm(io, 'Write these choices?', true))) return null;
  return { statusLine: switchesFor(status), tokenLine: tokenLine ? tokenSwitches : null };
}

const REPO = 'jv-k/claude-gauge';

interface StarOptions {
  // Whether the gh command runs here.
  hasGh: () => boolean;
  // Stars the repo with gh; false when gh failed.
  star: () => boolean;
}

// The end of setup: with gh at hand, offers to star the repo, and stars it
// only on a yes. Without gh it says nothing. The end of the input is a no.
async function offerStar(io: WizardIo, { hasGh, star }: StarOptions): Promise<void> {
  if (!hasGh()) return;
  let yes: boolean;
  try {
    yes = await confirm(io, `Star ${REPO} on GitHub with gh?`, false);
  } catch (err) {
    if (err instanceof EndOfAnswers) return;
    throw err;
  }
  if (!yes) return;
  io.write(star() ? `Starred ${REPO}. Thank you.\n` : `gh could not star ${REPO}. Nothing else changed.\n`);
}

// A status payload to preview with when the status line has saved none:
// two-fifths of the context, and a 5-hour and a weekly window part used.
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
    },
    cost: { total_duration_ms: 72 * 60 * 1000 },
  };
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

// The preview: the status line's rows for `payload`, with the given switches
// as words, as the settings command passes them.
function previewer(payload: StatusData, options: Omit<Parameters<typeof render>[1] & object, 'config'> = {}) {
  return (switches: readonly string[]) => render(payload, { ...options, config: parseArgs([...switches]) });
}

export { runWizard, offerStar, confirm, EndOfAnswers, samplePayload, loadPayload, previewer, switchesFor };

export type { WizardIo, WizardOptions, WizardChoices, StarOptions };
