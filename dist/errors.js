"use strict";
// The errors that the claude-gauge command and its settings file reader
// throw on purpose. Each keeps its values (a path, a command or a switch)
// apart from its text, because a throw site does not know the stream the
// message goes to: the CLI's top-level handler renders it through the styles
// of stderr, so the values are green on a colour terminal, as they are in the
// rest of the output. `message` stays the plain text, for logs and tests.
//
//   throw new GaugeError(message`${file} is not valid JSON (${plain(err.message)}).`);
//
// Every value in the template is painted, save one wrapped in plain(): text
// from Node itself, such as the message of a caught fs error, or a word the
// user typed that claude-gauge does not know.
Object.defineProperty(exports, "__esModule", { value: true });
exports.plain = exports.message = exports.GaugeError = void 0;
const plain = (text) => ({ plain: text });
exports.plain = plain;
// The tag that builds a Message from a template literal.
const message = (text, ...values) => ({ text: [...text], values });
exports.message = message;
// The message, with each value passed through `paint` and plain text as it is.
function join({ text, values }, paint) {
    return text.reduce((out, part, i) => {
        const value = values[i - 1];
        return out + (typeof value === 'string' ? paint(value) : value.plain) + part;
    });
}
class GaugeError extends Error {
    parts;
    constructor(parts) {
        super(join(parts, (value) => value));
        this.parts = parts;
    }
    // The message with each value styled by `s`. A value over several lines is
    // painted line by line, so the CLI can split the message into lines and
    // each line still resets its own colour.
    render(s) {
        return join(this.parts, (value) => value.split('\n').map(s.value).join('\n'));
    }
}
exports.GaugeError = GaugeError;
