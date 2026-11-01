// The errors that claude-gauge throws on purpose. Each keeps its values (a
// path, a command, a part name or a version) apart from its text, because a
// throw site does not know the stream the message goes to: the CLI's
// top-level handler renders it through the styles of stderr, so the values
// are green on a colour terminal, as they are in the rest of the output.
// `message` stays the plain text, for logs and tests.
//
//   throw new GaugeError(message`${file} is not valid JSON (${plain(err.message)}).`);
//
// Every value in the template is painted, save one wrapped in plain(): text
// from Node itself, such as the message of a caught fs error.

import type { Styles } from './styles';

// Text that goes into a message unpainted.
interface Plain {
  readonly plain: string;
}

const plain = (text: string): Plain => ({ plain: text });

// A message as template parts: text[0], values[0], text[1], ... text[n].
interface Message {
  readonly text: readonly string[];
  readonly values: readonly (string | Plain)[];
}

// The tag that builds a Message from a template literal.
const message = (text: TemplateStringsArray, ...values: (string | Plain)[]): Message => ({ text: [...text], values });

// The message, with each value passed through `paint` and plain text as it is.
function join({ text, values }: Message, paint: (value: string) => string): string {
  return text.reduce((out, part, i) => {
    const value = values[i - 1];
    return out + (typeof value === 'string' ? paint(value) : value.plain) + part;
  });
}

class GaugeError extends Error {
  readonly parts: Message;

  constructor(parts: Message) {
    super(join(parts, (value) => value));
    this.parts = parts;
  }

  // The message with each value styled by `s`. A value over several lines is
  // painted line by line, so the CLI can split the message into lines and
  // each line still resets its own colour.
  render(s: Styles): string {
    return join(this.parts, (value) => value.split('\n').map(s.value).join('\n'));
  }
}

export { GaugeError, message, plain };

export type { Message };
