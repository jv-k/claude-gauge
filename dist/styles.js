"use strict";
// The look of the claude-gauge command's output, after jv-k/VerBump's
// lib/styles.sh, lib/icons.sh and lib/ui.sh: section headers as inverted,
// bold pills in capitals, status lines that start with an icon, values in
// green and defaults dim. Every call site goes through these helpers, so one
// edit here re-skins the command, as one edit to VerBump's styles.sh does.
//
// The status line and the token line never import this module: each runs
// alone from the copy that setup makes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.stylesFor = void 0;
exports.styles = styles;
const wordmark_1 = require("./wordmark");
const RESET = '\x1b[0m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[0;31m';
const CYAN = '\x1b[0;36m';
const DIM = '\x1b[2m';
// The pills: one combined code each, 7 for invert, 1 for bold and 3N for the
// colour, because a colour code that starts with 0; would reset the invert.
//   section:  cyan, a part of the command's run, such as SETUP or DONE
//   question: magenta, a question that waits for an answer: CONFIRM or INPUT
//   warning:  yellow
//   error:    red
const PILLS = {
    section: '\x1b[7;1;36m',
    question: '\x1b[7;1;35m',
    warning: '\x1b[7;1;33m',
    error: '\x1b[7;1;31m',
};
function styles(color) {
    const paint = (code, text) => (color ? `${code}${text}${RESET}` : text);
    const status = (code, icon) => (text) => `${paint(code, icon)} ${text}\n`;
    return {
        pill: (text, tone = 'section') => {
            const label = text.toUpperCase();
            return `\n${color ? `${PILLS[tone]} ${label} ${RESET}` : label}\n`;
        },
        ok: status(GREEN, '✔'),
        warn: status(YELLOW, '!'),
        error: status(RED, '✖'),
        info: status(CYAN, 'ℹ'),
        trace: (text) => `  ${paint(DIM, `↳ ${text}`)}\n`,
        value: (text) => paint(GREEN, text),
        dim: (text) => paint(DIM, text),
    };
}
// The styles for what goes to `stream`, in colour when the colour gate allows.
const stylesFor = (stream) => styles((0, wordmark_1.colorEnabled)(stream));
exports.stylesFor = stylesFor;
