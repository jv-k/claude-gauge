"use strict";
// The claude-gauge wordmark, which the CLI prints above its usage and at the
// start of the setup and configure questions. It is figlet's "future" font,
// as jv-k/deslopper draws its own, kept here as text so the CLI needs no
// figlet: three rows of one 3-cell chunk per character of "claude-gauge".
Object.defineProperty(exports, "__esModule", { value: true });
exports.wordmark = wordmark;
exports.colorEnabled = colorEnabled;
const WORDMARK = [
    ['┏━╸', '╻  ', '┏━┓', '╻ ╻', '╺┳┓', '┏━╸', '   ', '┏━╸', '┏━┓', '╻ ╻', '┏━╸', '┏━╸'],
    ['┃  ', '┃  ', '┣━┫', '┃ ┃', ' ┃┃', '┣╸ ', '╺━╸', '┃╺┓', '┣━┫', '┃ ┃', '┃╺┓', '┣╸ '],
    ['┗━╸', '┗━╸', '╹ ╹', '┗━┛', '╺┻┛', '┗━╸', '   ', '┗━┛', '╹ ╹', '┗━┛', '┗━┛', '┗━╸'],
];
// A 256-colour number for each chunk: deslopper's rainbow widened to the 11
// letters, with 27 for blue because 21 reads poorly on a dark background, and
// grey for the hyphen.
const COLORS = [196, 202, 208, 214, 226, 118, 244, 82, 39, 27, 93, 163];
const RESET = '\x1b[0m';
// Whether to colour what goes to `stream`, in deslopper's order: a non-empty
// NO_COLOR turns colour off, a FORCE_COLOR or CLICOLOR_FORCE that is neither
// empty nor 0 turns it on, and otherwise only a terminal gets colour.
function colorEnabled(stream, env = process.env) {
    if (env.NO_COLOR)
        return false;
    if (['CLICOLOR_FORCE', 'FORCE_COLOR'].some((name) => env[name] && env[name] !== '0'))
        return true;
    return stream.isTTY === true;
}
// The wordmark's three rows, each ending in a newline. In colour each chunk
// starts with its colour code and each row ends with a reset.
function wordmark(color) {
    const row = (chunks) => color ? chunks.map((chunk, i) => `\x1b[38;5;${COLORS[i]}m${chunk}`).join('') + RESET : chunks.join('');
    return WORDMARK.map((chunks) => row(chunks) + '\n').join('');
}
