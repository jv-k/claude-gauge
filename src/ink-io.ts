// The Ink front end of the setup and configure questions. Each question is a
// choice: the arrow keys move the selection and Enter accepts it, and the
// parts of a row are a list to tick with Space. The preview above the
// question redraws as the selection moves, before the answer is accepted.
// Ctrl+C stops the questions, and nothing is written.
//
// The wizard (wizard.ts) asks the questions, the same as the readline ones;
// this module only shows them. It loads Ink and React with import(), and only
// when stdin and stdout are both a terminal, so the plugin's checkout, which
// has no node_modules, still runs: the readline questions ask there instead.
//
// Each question mounts Ink on its own and unmounts it once answered, leaving
// the question and its answer on the screen, its line ended. Between
// questions Ink is not mounted, so what the wizard and the CLI write goes
// straight to the output.
// The look is VerBump's, from styles.ts, so NO_COLOR turns it off as it does
// for the readline questions.
//
// On a terminal the preview animates: each question redraws it every
// FRAME_MS, and the preview the wizard gives moves its bars with the clock.

import type { ReactElement } from 'react';
import { Interrupted } from './wizard';
import type { ChoiceIo, Input, Output, OpenIo } from './wizard';
import { styles } from './styles';

type InkModule = typeof import('ink', { with: { 'resolution-mode': 'import' } });
type ReactModule = typeof import('react');

// A mounted question: the tree it shows can be replaced, then unmounted.
interface Mounted {
  rerender(tree: ReactElement): void;
  unmount(): void;
}

// What the front end runs on: Ink, React, and the call that mounts a tree on
// the terminal, which a test replaces with ink-testing-library's. `ready`,
// when set, is called once each question reads keys, so a test presses none
// before then. A terminal keeps the keys typed before then for the question.
// `animate`, when set, redraws each question every FRAME_MS, so a preview
// that moves with the clock animates.
interface InkDeps {
  ink: InkModule;
  React: ReactModule;
  mount(tree: ReactElement): Mounted;
  ready?(): void;
  animate?: boolean;
}

// How often an animated question redraws: about 12 frames a second.
const FRAME_MS = 80;

// The most options a list shows at once. A longer list scrolls with the
// selection.
const VISIBLE = 10;

// A question as the view shows it: labels, the selection's start, and for a
// list to tick, the indexes ticked first.
interface View {
  kind: 'CONFIRM' | 'INPUT';
  message: string;
  labels: string[];
  initial: number;
  // Set for a list to tick, in the order ticked.
  ticked?: number[];
  // The preview with the selection, or the ticks, as they are now.
  preview(cursor: number, ticked: number[]): string;
}

// The questions as Ink choices on `deps`, with the text the wizard writes
// between them going to `output`, in colour when `color` is set.
function inkIoWith({ ink, React, mount, ready, animate = false }: InkDeps, output: Pick<Output, 'write'>, color: boolean): OpenIo {
  const s = styles(color);
  const h = React.createElement;
  let preview: string | (() => string) = '';
  const previewNow = () => (typeof preview === 'function' ? preview() : preview);
  let live: Mounted | undefined;

  // The frame for `view`: the preview, the pill, the question, the options in
  // view with the selection marked, a reason the answer is not taken, and the
  // keys.
  const frame = (view: View, cursor: number, ticked: number[], warning: string) => {
    const many = view.ticked !== undefined;
    const from = Math.max(0, Math.min(cursor - Math.floor(VISIBLE / 2), view.labels.length - VISIBLE));
    const shown = view.labels.slice(from, from + VISIBLE);
    const lines = shown.map((label, k) => {
      const i = from + k;
      const box = many ? `${ticked.includes(i) ? '◉' : '◯'} ` : '';
      return i === cursor ? `${s.value('❯')} ${box}${s.value(label)}` : `  ${box}${label}`;
    });
    if (from > 0) lines.unshift(s.dim('  ↑ more'));
    if (from + VISIBLE < view.labels.length) lines.push(s.dim('  ↓ more'));
    const keys = many ? '↑↓ to move, Space to tick, Enter to accept' : '↑↓ to move, Enter to accept';
    return [
      view.preview(cursor, ticked),
      s.pill(view.kind, 'question'),
      `${view.message}\n`,
      `${lines.join('\n')}\n`,
      warning ? s.warn(warning) : '',
      s.dim(keys),
    ].join('');
  };

  // The question as Ink shows it. The selection and the ticks live in a ref,
  // so a key read before React draws the last one still sees them.
  const Question = ({ view, done }: { view: View; done(cursor: number, ticked: number[] | null): void }) => {
    const state = React.useRef({ cursor: view.initial, ticked: [...(view.ticked ?? [])], warning: '', answered: false });
    const [, redraw] = React.useState(0);
    ink.useInput((input, key) => {
      const now = state.current;
      if (now.answered) return;
      const n = view.labels.length;
      if (input === 'c' && key.ctrl) {
        now.answered = true;
        done(now.cursor, null);
        return;
      }
      if (key.upArrow) now.cursor = (now.cursor - 1 + n) % n;
      else if (key.downArrow) now.cursor = (now.cursor + 1) % n;
      else if (input === ' ' && view.ticked) {
        now.ticked = now.ticked.includes(now.cursor) ? now.ticked.filter((i) => i !== now.cursor) : [...now.ticked, now.cursor];
        now.warning = '';
      } else if (key.return) {
        if (view.ticked && !now.ticked.length) now.warning = 'Tick at least one part with Space.';
        else {
          now.answered = true;
          done(now.cursor, now.ticked);
          return;
        }
      } else return;
      redraw((r) => r + 1);
    });
    // After useInput's own effect, which starts to read the keys.
    React.useEffect(() => {
      ready?.();
    }, []);
    React.useEffect(() => {
      if (!animate) return undefined;
      const timer = setInterval(() => {
        if (!state.current.answered) redraw((r) => r + 1);
      }, FRAME_MS);
      return () => clearInterval(timer);
    }, []);
    const now = state.current;
    return h(ink.Text, null, frame(view, now.cursor, now.ticked, now.warning));
  };

  // Mounts `view` and resolves to the selection and the ticks once accepted.
  // The question and its answer replace the frame, then Ink unmounts. Ctrl+C
  // clears the frame and rejects with Interrupted.
  const ask = (view: View) =>
    new Promise<{ cursor: number; ticked: number[] }>((resolve, reject) => {
      const done = (cursor: number, ticked: number[] | null) => {
        // After the key's update, so the last frame is the one drawn here.
        setImmediate(() => {
          const answer = !ticked ? '' : view.ticked ? ticked.map((i) => view.labels[i]).join(',') : view.labels[cursor];
          question.rerender(h(ink.Text, null, ticked ? `${s.pill(view.kind, 'question')}${view.message} ${s.value(answer)}` : ''));
          question.unmount();
          live = undefined;
          // Ink leaves the cursor at the end of its last line.
          output.write('\n');
          if (ticked) resolve({ cursor, ticked });
          else reject(new Interrupted());
        });
      };
      const question = mount(h(Question, { view, done }));
      live = question;
    });

  const choices: ChoiceIo = {
    one: async ({ kind, message, options, initial, preview: previewFor }) => {
      const { cursor } = await ask({
        kind,
        message,
        labels: options.map((o) => o.label),
        initial,
        preview: (at) => (previewFor ? previewFor(options[at].value) : previewNow()),
      });
      return options[cursor].value;
    },
    many: async ({ message, options, initial, preview: previewFor }) => {
      const ticked = initial.map((p) => options.indexOf(p)).filter((i) => i >= 0);
      const answer = await ask({
        kind: 'INPUT',
        message,
        labels: [...options],
        initial: 0,
        ticked,
        preview: (_, now) => (previewFor ? previewFor(now.map((i) => options[i])) : previewNow()),
      });
      return answer.ticked.map((i) => options[i]);
    },
    preview: (text) => {
      preview = text;
    },
  };

  return {
    color,
    choices,
    animated: animate,
    // Not asked: the wizard asks through `choices`.
    ask: async () => undefined,
    write: (text) => {
      output.write(text);
    },
    close: () => {
      live?.unmount();
      live = undefined;
    },
  };
}

// The Ink front end on the two streams, once Ink and React load. It rejects
// where they cannot, such as the plugin's checkout.
async function loadInkIo(input: Input, output: Output, color: boolean): Promise<OpenIo> {
  const [ink, react] = await Promise.all([import('ink'), import('react')]);
  const React = (react as ReactModule & { default?: ReactModule }).default ?? react;
  const mount = (tree: ReactElement) =>
    ink.render(tree, {
      stdin: input as NodeJS.ReadStream,
      stdout: output as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
  return inkIoWith({ ink, React, mount, animate: true }, output, color);
}

export { inkIoWith, loadInkIo };

export type { InkDeps };
