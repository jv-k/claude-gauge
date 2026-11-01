"use strict";
// The Ink front end of the setup and configure questions. Each question is a
// choice: the arrow keys move the selection and Enter accepts it, and the
// parts of a row are a list to tick with Space. A choice for each bar has a
// row of tabs: left and right move between All and each bar, and a choice
// at All sets every bar. The preview above the question redraws as the
// selection moves, before the answer is accepted.
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
// On a terminal a question whose preview moves, the bar style's, redraws it
// every FRAME_MS while it waits, so its bars move with the clock. Space
// pauses the animation and plays it again: the io's clock stops while it is
// paused, so a selection moved then shows at the paused time.
Object.defineProperty(exports, "__esModule", { value: true });
exports.inkIoWith = inkIoWith;
exports.loadInkIo = loadInkIo;
const wizard_1 = require("./wizard");
const styles_1 = require("./styles");
// How often an animated question redraws: about 12 frames a second.
const FRAME_MS = 80;
// The most options a list shows at once. A longer list scrolls with the
// selection.
const VISIBLE = 10;
// The questions as Ink choices on `deps`, with the text the wizard writes
// between them going to `output`, in colour when `color` is set.
function inkIoWith({ ink, React, mount, ready, animate = false }, output, color) {
    const s = (0, styles_1.styles)(color);
    const h = React.createElement;
    let preview = '';
    const previewNow = () => (typeof preview === 'function' ? preview() : preview);
    let live;
    // The animation's clock: now, less the time spent paused, and still while
    // paused.
    const clock = { paused: false, pausedAt: 0, lost: 0 };
    const timeNow = () => (clock.paused ? clock.pausedAt : Date.now() - clock.lost);
    const togglePause = () => {
        if (clock.paused)
            clock.lost = Date.now() - clock.pausedAt;
        else
            clock.pausedAt = Date.now() - clock.lost;
        clock.paused = !clock.paused;
    };
    // Whether `view` animates: a moving preview, with animate set.
    const animates = (view) => animate && view.moving === true;
    // The answer as it shows after the question: the option, the ticked parts,
    // or with tabs, All's option and each tab whose option differs, as
    // steps,ctx=rising.
    const answerOf = (view, cursor, ticked, cursors) => {
        if (view.ticked)
            return ticked.map((i) => view.labels[i]).join(',');
        if (!view.tabs)
            return view.labels[cursor];
        const all = cursors[0];
        const own = view.tabs.labels.slice(1).flatMap((tab, i) => (cursors[i + 1] === all ? [] : [`${tab}=${view.labels[cursors[i + 1]]}`]));
        return [view.labels[all], ...own].join(',');
    };
    // The row of tabs, the one in use marked, each after All with its option.
    const tabRow = (view, tab, cursors) => (view.tabs?.labels ?? [])
        .map((label, i) => {
        const text = i === 0 ? label : `${label} ${view.labels[cursors[i]]}`;
        return i === tab ? s.value(`[${text}]`) : s.dim(` ${text} `);
    })
        .join(' ');
    // The frame for `view`: the preview, the pill, the question, the tabs, the
    // options in view with the selection marked, a reason the answer is not
    // taken, and the keys.
    const frame = (view, cursor, ticked, warning, tab, cursors) => {
        const many = view.ticked !== undefined;
        const from = Math.max(0, Math.min(cursor - Math.floor(VISIBLE / 2), view.labels.length - VISIBLE));
        const shown = view.labels.slice(from, from + VISIBLE);
        const lines = shown.map((label, k) => {
            const i = from + k;
            const box = many ? `${ticked.includes(i) ? '◉' : '◯'} ` : '';
            return i === cursor ? `${s.value('❯')} ${box}${s.value(label)}` : `  ${box}${label}`;
        });
        if (from > 0)
            lines.unshift(s.dim('  ↑ more'));
        if (from + VISIBLE < view.labels.length)
            lines.push(s.dim('  ↓ more'));
        const pause = animates(view) ? (clock.paused ? 'Space to play, ' : 'Space to pause, ') : '';
        const keys = many
            ? '↑↓ to move, Space to tick, Enter to accept'
            : `${view.tabs ? '←→ to pick a bar, ' : ''}↑↓ to move, ${pause}Enter to accept`;
        return [
            view.preview(cursor, ticked, cursors),
            s.pill(view.kind, 'question'),
            `${view.message}\n`,
            view.tabs ? `${tabRow(view, tab, cursors)}\n` : '',
            `${lines.join('\n')}\n`,
            warning ? s.warn(warning) : '',
            s.dim(keys),
        ].join('');
    };
    // The question as Ink shows it. The selection and the ticks live in a ref,
    // so a key read before React draws the last one still sees them.
    // With tabs, `cursors` holds each tab's selection and `cursor` the one in
    // use; a move at All moves every tab.
    const Question = ({ view, done }) => {
        const state = React.useRef({
            cursor: view.initial,
            ticked: [...(view.ticked ?? [])],
            warning: '',
            answered: false,
            tab: 0,
            cursors: [...(view.tabs?.cursors ?? [view.initial])],
        });
        const [, redraw] = React.useState(0);
        ink.useInput((input, key) => {
            const now = state.current;
            if (now.answered)
                return;
            const n = view.labels.length;
            if (input === 'c' && key.ctrl) {
                now.answered = true;
                done(now.cursor, null, now.cursors);
                return;
            }
            const tabs = view.tabs?.labels.length ?? 0;
            if (key.upArrow || key.downArrow) {
                now.cursor = (now.cursor + (key.upArrow ? -1 : 1) + n) % n;
                if (tabs) {
                    if (now.tab === 0)
                        now.cursors.fill(now.cursor);
                    else
                        now.cursors[now.tab] = now.cursor;
                }
            }
            else if (tabs && (key.leftArrow || key.rightArrow)) {
                now.tab = (now.tab + (key.leftArrow ? -1 : 1) + tabs) % tabs;
                now.cursor = now.cursors[now.tab];
            }
            else if (input === ' ' && animates(view)) {
                togglePause();
            }
            else if (input === ' ' && view.ticked) {
                now.ticked = now.ticked.includes(now.cursor) ? now.ticked.filter((i) => i !== now.cursor) : [...now.ticked, now.cursor];
                now.warning = '';
            }
            else if (key.return) {
                if (view.ticked && !now.ticked.length)
                    now.warning = 'Tick at least one part with Space.';
                else {
                    now.answered = true;
                    done(now.cursor, now.ticked, now.cursors);
                    return;
                }
            }
            else
                return;
            redraw((r) => r + 1);
        });
        // After useInput's own effect, which starts to read the keys.
        React.useEffect(() => {
            ready?.();
        }, []);
        React.useEffect(() => {
            if (!animates(view))
                return undefined;
            const timer = setInterval(() => {
                if (!state.current.answered && !clock.paused)
                    redraw((r) => r + 1);
            }, FRAME_MS);
            return () => clearInterval(timer);
        }, []);
        const now = state.current;
        return h(ink.Text, null, frame(view, now.cursor, now.ticked, now.warning, now.tab, now.cursors));
    };
    // Mounts `view` and resolves to the selection and the ticks once accepted.
    // The question and its answer replace the frame, then Ink unmounts. Ctrl+C
    // clears the frame and rejects with Interrupted.
    const ask = (view) => new Promise((resolve, reject) => {
        const done = (cursor, ticked, cursors) => {
            // After the key's update, so the last frame is the one drawn here.
            setImmediate(() => {
                const answer = ticked ? answerOf(view, cursor, ticked, cursors) : '';
                question.rerender(h(ink.Text, null, ticked ? `${s.pill(view.kind, 'question')}${view.message} ${s.value(answer)}` : ''));
                question.unmount();
                live = undefined;
                // Ink leaves the cursor at the end of its last line.
                output.write('\n');
                if (ticked)
                    resolve({ cursor, ticked, cursors });
                else
                    reject(new wizard_1.Interrupted());
            });
        };
        const question = mount(h(Question, { view, done }));
        live = question;
    });
    const choices = {
        one: async ({ kind, message, options, initial, preview: previewFor, moving }) => {
            const { cursor } = await ask({
                kind,
                message,
                labels: options.map((o) => o.label),
                initial,
                moving,
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
        each: async ({ message, targets, options, initial, preview: previewFor, moving }) => {
            const at = (value) => Math.max(0, options.findIndex((o) => o.value === value));
            const cursors = [at(initial.all), ...initial.each.map(at)];
            const { cursors: chosen } = await ask({
                kind: 'INPUT',
                message,
                labels: options.map((o) => o.label),
                initial: cursors[0],
                tabs: { labels: ['All', ...targets], cursors },
                moving,
                preview: (_, __, now) => (previewFor ? previewFor(options[now[0]].value, now.slice(1).map((i) => options[i].value)) : previewNow()),
            });
            return { all: options[chosen[0]].value, each: chosen.slice(1).map((i) => options[i].value) };
        },
        preview: (text) => {
            preview = text;
        },
    };
    return {
        color,
        choices,
        animated: animate,
        clock: timeNow,
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
async function loadInkIo(input, output, color) {
    const [ink, react] = await Promise.all([import('ink'), import('react')]);
    const React = react.default ?? react;
    const mount = (tree) => ink.render(tree, {
        stdin: input,
        stdout: output,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    return inkIoWith({ ink, React, mount, animate: true }, output, color);
}
