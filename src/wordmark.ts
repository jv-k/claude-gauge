// The claude-gauge wordmark, which the CLI prints above its usage and at the
// start of the setup and configure questions. It is figlet's "future" font,
// as jv-k/deslopper draws its own, kept here as text so the CLI needs no
// figlet: three rows of one 3-cell chunk per character of "claude-gauge".

const WORDMARK: readonly (readonly string[])[] = [
  ['┏━╸', '╻  ', '┏━┓', '╻ ╻', '┳━┓', '┏━╸', '   ', '┏━╸', '┏━┓', '╻ ╻', '┏━╸', '┏━╸'],
  ['┃  ', '┃  ', '┣━┫', '┃ ┃', '┃ ┃', '┣╸ ', '╺━╸', '┃╺┓', '┣━┫', '┃ ┃', '┃╺┓', '┣╸ '],
  ['┗━╸', '┗━╸', '╹ ╹', '┗━┛', '┻━┛', '┗━╸', '   ', '┗━┛', '╹ ╹', '┗━┛', '┗━┛', '┗━╸'],
];

type Rgb = readonly [number, number, number];

// The gradient's three stops: coral, pink and violet, which read on a dark
// and a light background alike.
const STOPS: readonly Rgb[] = [
  [242, 119, 74],
  [224, 69, 146],
  [139, 92, 246],
];

// How many columns each row's gradient starts to the right of the row above,
// which tilts the gradient into a diagonal.
const SHIFT = 2;

const RESET = '\x1b[0m';

// The colour at `t`, from 0 at the first stop to 1 at the last, blended
// straight between the two stops on each side.
function blend(t: number): Rgb {
  const at = t * (STOPS.length - 1);
  const i = Math.min(Math.floor(at), STOPS.length - 2);
  const f = at - i;
  const [from, to] = [STOPS[i], STOPS[i + 1]];
  return [0, 1, 2].map((c) => Math.round(from[c] + (to[c] - from[c]) * f)) as unknown as Rgb;
}

// Whether to colour what goes to `stream`, in deslopper's order: a non-empty
// NO_COLOR turns colour off, a FORCE_COLOR or CLICOLOR_FORCE that is neither
// empty nor 0 turns it on, and otherwise only a terminal gets colour.
function colorEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (['CLICOLOR_FORCE', 'FORCE_COLOR'].some((name) => env[name] && env[name] !== '0')) return true;
  return stream.isTTY === true;
}

// The wordmark's three rows, each ending in a newline. In colour each cell
// starts with a 24-bit colour code from a diagonal gradient, and each row
// ends with a reset.
function wordmark(color: boolean): string {
  const width = WORDMARK[0].join('').length;
  const span = width - 1 + SHIFT * (WORDMARK.length - 1);
  const row = (chunks: readonly string[], y: number) => {
    const cells = [...chunks.join('')];
    if (!color) return cells.join('');
    const coloured = cells.map((cell, x) => {
      const [r, g, b] = blend((x + SHIFT * y) / span);
      return `\x1b[38;2;${r};${g};${b}m${cell}`;
    });
    return coloured.join('') + RESET;
  };
  return WORDMARK.map((chunks, y) => row(chunks, y) + '\n').join('');
}

export { wordmark, colorEnabled };
