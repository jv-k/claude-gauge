// The questions claude-gauge setup and configure ask when run with no bar
// switches: take the defaults in one answer, or walk through the status
// line's rows and parts, its bar size, theme and labels, and the token line,
// with a preview of the status line redrawn after each answer. It returns
// the switches for each bar, for the CLI to write; it reads and writes no
// settings itself.
//
// The questions go through a WizardIo, so a test can script the answers. The
// preview renders the payload the status line saved last, else a sample.

import * as fs from 'node:fs';
import { render, parseArgs, PARTS, THEMES, DEFAULT_ROWS } from './statusline';
import type { StatusData, Part } from './statusline';

interface WizardIo {
  // Shows `question` and resolves to the answer, or to undefined at the end
  // of the input.
  ask(question: string): Promise<string | undefined>;
  write(text: string): void;
}

interface WizardOptions {
  // The status line's rows when run with these switches.
  preview: (statusLineSwitches: string) => string;
}

// The switches for each bar: a string to run it with, null to leave it out.
interface WizardChoices {
  statusLine: string;
  tokenLine: string | null;
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
}

const DEFAULT_CHOICES: StatusChoices = { rows: DEFAULT_ROWS, segments: 5, theme: 'default', labels: true };

const sameRows = (a: Part[][], b: Part[][]) => JSON.stringify(a) === JSON.stringify(b);

// The fewest switches that give `choices`: none for the defaults. A row not
// chosen yet is left out.
function switchesFor({ rows, segments, theme, labels }: StatusChoices): string {
  const chosen = rows.filter((row) => row.length);
  const words: string[] = [];
  if (!sameRows(chosen, DEFAULT_ROWS)) for (const row of chosen) words.push('--show', row.join(','));
  if (segments !== 5) words.push('--segments', String(segments));
  if (theme !== 'default') words.push('--theme', theme);
  if (!labels) words.push('--no-labels');
  return words.join(' ');
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

function readParts(fallback: Part[] | undefined) {
  return (answer: string): Part[] | { retry: string } => {
    if (!answer && fallback) return fallback;
    const names = answer.split(/[\s,]+/).filter(Boolean);
    const unknown = names.filter((n) => !(PARTS as readonly string[]).includes(n));
    if (unknown.length) return { retry: `Unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The parts are listed above.` };
    if (!names.length) return { retry: 'Name at least one part.' };
    return [...new Set(names)] as Part[];
  };
}

async function runWizard(io: WizardIo, { preview }: WizardOptions): Promise<WizardChoices | null> {
  let status: StatusChoices = { ...DEFAULT_CHOICES };
  let tokenLine = true;
  const show = () => {
    const rows = preview(switchesFor(status));
    io.write(`\n${rows.split('\n').map((row) => `  ${row}`).join('\n')}\n`);
    io.write(`Token line: ${tokenLine ? 'on, when each turn ends' : 'off'}\n\n`);
  };

  io.write('The status line with the defaults:\n');
  show();
  if (await confirm(io, 'Use the defaults: both bars, with the parts above?', true)) return { statusLine: '', tokenLine: '' };

  io.write(`\nThe parts: ${PARTS.join(', ')}.\nREADME.md says what each shows. Press Enter to keep the value in brackets.\n`);
  const count = await askFor(io, `How many status line rows, 1 to ${MAX_ROWS}? [${DEFAULT_ROWS.length}] `, (answer) => {
    const n = answer ? Number(answer) : DEFAULT_ROWS.length;
    return Number.isInteger(n) && n >= 1 && n <= MAX_ROWS ? n : { retry: `Answer a number from 1 to ${MAX_ROWS}.` };
  });
  status = { ...status, rows: Array.from({ length: count }, (_, i) => DEFAULT_ROWS[i] ?? []) };
  show();

  for (let i = 0; i < count; i++) {
    const fallback = DEFAULT_ROWS[i];
    const hint = fallback ? ` [${fallback.join(',')}]` : '';
    const parts = await askFor(io, `Row ${i + 1}: the parts, comma-separated${hint} `, readParts(fallback));
    status = { ...status, rows: status.rows.map((row, j) => (j === i ? parts : row)) };
    show();
  }

  const segments = await askFor(io, `Cells per bar, ${SEGMENTS.join(' or ')}? [${SEGMENTS[0]}] `, (answer) =>
    SEGMENTS.find((n) => String(n) === (answer || String(SEGMENTS[0]))) ?? { retry: `Answer ${SEGMENTS.join(' or ')}.` },
  );
  status = { ...status, segments };
  show();

  const theme = await askFor(io, `Theme: ${THEMES.join(', ')}? [default] `, (answer) => {
    const name = answer.toLowerCase() || 'default';
    return THEMES.includes(name) ? name : { retry: `Unknown theme: ${answer}. Answer one of ${THEMES.join(', ')}.` };
  });
  status = { ...status, theme };
  show();

  status = { ...status, labels: await confirm(io, 'Labels in front of the values, such as ctx and 5h?', true) };
  show();

  tokenLine = await confirm(io, 'Add the token line, shown when each turn ends?', true);
  show();

  if (!(await confirm(io, 'Write these choices?', true))) return null;
  return { statusLine: switchesFor(status), tokenLine: tokenLine ? '' : null };
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

// The preview: the status line's rows for `payload`, with the given switches.
// The switches are split into words as the settings command splits them.
function previewer(payload: StatusData, options: Omit<Parameters<typeof render>[1] & object, 'config'> = {}) {
  return (switches: string) => render(payload, { ...options, config: parseArgs(switches.split(/\s+/).filter(Boolean)) });
}

export { runWizard, offerStar, confirm, EndOfAnswers, samplePayload, loadPayload, previewer, switchesFor };

export type { WizardIo, WizardOptions, WizardChoices, StarOptions };
