"use strict";
// The Ink front end of the setup and configure questions. Each question is a
// choice: the arrow keys move the selection and Enter accepts it. A list of
// parts to tick, with Space, is there for a front end with no row editor.
// The row editor shows each row's parts side by side, with the add slot, +,
// after them: left and right move along a row, Tab changes row, up and down
// change the part there, Shift with an arrow moves it (or Space, then the
// arrows, then Space), and d or Backspace removes it. A choice for each bar
// shows the bars side by side, as the row editor shows parts: left and right
// (or Tab and Shift+Tab) move between All and each bar, up and down change
// its value, and a value
// at All sets every bar. An order question lists its options in their
// order: up and down select one, and Tab pushes it down, Shift+Tab up. The
// preview above the question redraws as the selection moves, before the
// answer is accepted. Esc goes back, and the wizard offers the steps to
// go back to. Ctrl+C stops the questions, and nothing is written.
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
exports.synchronized = synchronized;
const wizard_1 = require("./wizard");
const styles_1 = require("./styles");
// How often an animated question redraws: about 12 frames a second.
const FRAME_MS = 80;
// The most options a list shows at once, enough for the list of steps. A
// longer list scrolls with the selection.
const VISIBLE = 16;
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
        if (view.order)
            return view.order.describe(ticked);
        if (view.ticked)
            return ticked.map((i) => view.labels[i]).join(', ');
        if (!view.tabs)
            return view.answers?.[cursor] ?? view.labels[cursor];
        const all = cursors[0];
        const own = view.tabs.labels.slice(1).flatMap((tab, i) => (cursors[i + 1] === all ? [] : [`${tab}=${view.labels[cursors[i + 1]]}`]));
        return [view.labels[all], ...own].join(',');
    };
    // Places side by side, as many to a line as fit in `width`, each line
    // after `lead`. Each place's size is its width on screen.
    const wrapPlaces = (places, width, lead = '  ') => {
        const lines = [];
        let line = '';
        let size = 0;
        for (const place of places) {
            if (size && size + 1 + place.size > width) {
                lines.push(line);
                line = '';
                size = 0;
            }
            line += `${size ? ' ' : ''}${place.text}`;
            size += (size ? 1 : 0) + place.size;
        }
        lines.push(line);
        return lines.map((l) => `${lead}${l}`);
    };
    // The bars with their values. Without rows: side by side, All first, a
    // bar whose value is All's faint, as it follows All. With rows: All on a
    // line of its own when it is a stop of its own, then each row as the row
    // editor shows it, each bar's part with its value and every other part
    // faint. The stop at the cursor is in red-pink brackets.
    const tabRow = (view, stop, cursors) => {
        const tabs = view.tabs;
        if (!tabs)
            return '';
        const width = Math.max(20, (output.columns || 80) - 2);
        const place = (text, current, faint = false) => ({
            text: current ? s.select(`[${text}]`) : faint ? s.dim(` ${text} `) : ` ${text} `,
            size: text.length + 2,
        });
        const valued = (tab, name = tabs.labels[tab]) => `${name} ${view.labels[cursors[tab]]}`;
        if (!tabs.rows) {
            return wrapPlaces(tabs.labels.map((_, i) => place(valued(i), i === tabs.stops[stop].tab, i > 0 && cursors[i] === cursors[0])), width).join('\n');
        }
        const lines = [];
        const allStop = tabs.stops.findIndex((st) => st.row === undefined);
        if (allStop >= 0)
            lines.push(...wrapPlaces([place(valued(0), allStop === stop)], width));
        const many = tabs.rows.length > 1;
        tabs.rows.forEach((row, r) => {
            const places = row.map((part, c) => {
                const at = tabs.stops.findIndex((st) => st.row === r && st.col === c);
                return at < 0 ? place(part, false, true) : place(valued(tabs.stops[at].tab, part), at === stop);
            });
            const wrapped = wrapPlaces(places, width - (many ? 3 : 0), '');
            lines.push(...wrapped.map((l, k) => (many ? `  ${k ? ' ' : s.dim(String(r + 1))}  ${l}` : `  ${l}`)));
        });
        return lines.join('\n');
    };
    // The keys a question takes, after a blank line, on one line: each key
    // bold and a short word for what it does dim, with a dot between them,
    // wrapped before the terminal's edge. Enter and Esc come last.
    const keysOf = (keys) => {
        const width = Math.max(20, (output.columns || 80) - 2);
        const all = [...keys, ['Enter', 'accept'], ['Esc', 'back']];
        const lines = [];
        let size = 0;
        for (const key of all) {
            const length = [...key[0]].length + 1 + key[1].length;
            if (lines.length && size + 3 + length <= width) {
                lines[lines.length - 1].push(key);
                size += 3 + length;
            }
            else {
                lines.push([key]);
                size = length;
            }
        }
        return `\n${lines.map(s.keys).join('\n')}`;
    };
    // The frame for `view`: the preview, the pill, the question, the tabs, the
    // options in view with the selection marked, a reason the answer is not
    // taken, and the keys.
    const frame = (view, cursor, ticked, warning, stop, cursors) => {
        const st = view.tabs?.stops[stop];
        const tab = st?.tab ?? 0;
        const many = view.ticked !== undefined && !view.order;
        // An order question shows its options in their order now.
        const labels = view.order ? ticked.map((i) => view.labels[i]) : view.labels;
        const from = Math.max(0, Math.min(cursor - Math.floor(VISIBLE / 2), labels.length - VISIBLE));
        const shown = labels.slice(from, from + VISIBLE);
        const lines = shown.map((label, k) => {
            const i = from + k;
            const box = many ? `${ticked.includes(i) ? '◉' : '◯'} ` : '';
            if (i !== cursor)
                return `  ${box}${label}`;
            return `${s.select('❯')} ${box}${s.select(view.order ? `[${label}]` : label)}`;
        });
        if (from > 0)
            lines.unshift(s.dim('  ↑ more'));
        if (from + VISIBLE < view.labels.length)
            lines.push(s.dim('  ↓ more'));
        const pause = animates(view) ? [['Space', clock.paused ? 'play' : 'pause']] : [];
        const keys = view.order
            ? [['↑↓', 'select'], ['Tab', 'push down'], ['⇧Tab', 'push up']]
            : many
                ? [['↑↓', 'move'], ['Space', 'tick']]
                : view.tabs
                    ? [...(view.tabs.stops.length > 1 ? [['←→ Tab ⇧Tab', 'pick a bar']] : []), ['↑↓', 'change'], ...pause]
                    : [['↑↓', 'move'], ...pause];
        // With bars, a note on the value at the cursor in place of the list.
        const tabNote = view.tabs ? `  ${view.tabs.notes?.[cursor] ?? s.value(view.labels[cursor])}${tab === 0 && view.tabs.labels.length > 1 ? s.dim(' All sets every bar.') : ''}\n` : '';
        const at = st?.row !== undefined && st.col !== undefined ? { row: st.row, part: st.col } : undefined;
        return [
            view.preview(cursor, ticked, cursors, at),
            s.pill(view.kind, 'question'),
            `${view.message}\n`,
            view.hint ? `${s.dim(view.hint)}\n` : '',
            view.tabs ? `${tabRow(view, stop, cursors)}\n${tabNote}` : `${lines.join('\n')}\n`,
            warning ? s.warn(warning) : '',
            keysOf(keys),
        ].join('');
    };
    // The question as Ink shows it. The selection and the ticks live in a ref,
    // so a key read before React draws the last one still sees them.
    // With tabs, `cursors` holds each tab's selection, `stop` the place the
    // cursor is at, and `cursor` the selection of its tab; a move at All moves
    // every tab.
    // An order question keeps its order in `ticked`: up and down select an
    // option, and Tab pushes it down, Shift+Tab up.
    const Question = ({ view, done }) => {
        const state = React.useRef({
            cursor: view.initial,
            ticked: [...(view.ticked ?? [])],
            warning: '',
            answered: false,
            stop: 0,
            cursors: [...(view.tabs?.cursors ?? [view.initial])],
        });
        const [, redraw] = React.useState(0);
        ink.useInput((input, key) => {
            const now = state.current;
            if (now.answered)
                return;
            const n = view.labels.length;
            if ((input === 'c' && key.ctrl) || key.escape) {
                now.answered = true;
                done(key.escape ? 'back' : 'stop', now.cursor, now.ticked, now.cursors);
                return;
            }
            const stops = view.tabs?.stops ?? [];
            const tab = stops[now.stop]?.tab ?? 0;
            if (view.order && key.tab) {
                // The option selected goes one place down, or up with Shift; from
                // either end it goes round to the other.
                const to = (now.cursor + (key.shift ? -1 : 1) + n) % n;
                const [moved] = now.ticked.splice(now.cursor, 1);
                now.ticked.splice(to, 0, moved);
                now.cursor = to;
            }
            else if (key.upArrow || key.downArrow) {
                now.cursor = (now.cursor + (key.upArrow ? -1 : 1) + n) % n;
                if (stops.length) {
                    if (tab === 0)
                        now.cursors.fill(now.cursor);
                    else
                        now.cursors[tab] = now.cursor;
                }
            }
            else if (stops.length && (key.leftArrow || key.rightArrow || key.tab)) {
                // Left and Shift+Tab go to the bar before, right and Tab to the next.
                const back = key.leftArrow || (key.tab && key.shift);
                now.stop = (now.stop + (back ? -1 : 1) + stops.length) % stops.length;
                now.cursor = now.cursors[stops[now.stop].tab];
            }
            else if (input === ' ' && animates(view)) {
                togglePause();
            }
            else if (input === ' ' && view.ticked && !view.order) {
                now.ticked = now.ticked.includes(now.cursor) ? now.ticked.filter((i) => i !== now.cursor) : [...now.ticked, now.cursor];
                now.warning = '';
            }
            else if (key.return) {
                if (view.ticked && !now.ticked.length)
                    now.warning = 'Tick at least one part with Space.';
                else {
                    now.answered = true;
                    done('answer', now.cursor, now.ticked, now.cursors);
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
        return h(ink.Text, null, frame(view, now.cursor, now.ticked, now.warning, now.stop, now.cursors));
    };
    // Mounts the question that `make` builds, and resolves to its value once
    // accepted. The question and its answer, `answer`, replace the frame, then
    // Ink unmounts. Ctrl+C clears the frame and rejects with Interrupted, and
    // Esc with GoBack.
    const settle = (kind, message, make) => new Promise((resolve, reject) => {
        const finish = (end, value, answer = '') => {
            // After the key's update, so the last frame is the one drawn here.
            setImmediate(() => {
                // The question stays on screen with its answer, or, after Esc, with
                // a note that it went back. After Ctrl+C nothing stays. Ink ends
                // its last frame with a newline, so the next text starts on a line
                // of its own.
                const shown = { answer: `${s.pill(kind, 'question')}${message} ${s.value(answer)}`, back: `${s.pill(kind, 'question')}${message} ${s.dim('↩ went back')}`, stop: '' }[end];
                question.rerender(h(ink.Text, null, shown));
                question.unmount();
                live = undefined;
                const answered = end === 'answer';
                if (answered)
                    resolve(value);
                else
                    reject(end === 'back' ? new wizard_1.GoBack() : new wizard_1.Interrupted());
            });
        };
        const question = mount(make(finish));
        live = question;
    });
    // Mounts `view` and resolves to the selection and the ticks once accepted.
    const ask = (view) => settle(view.kind, view.message, (finish) => h(Question, {
        view,
        done: (end, cursor, ticked, cursors) => finish(end, { cursor, ticked, cursors }, end === 'answer' ? answerOf(view, cursor, ticked, cursors) : ''),
    }));
    // The editor's frame: the preview, the pill, the question, each row's
    // parts side by side with the add slot after them, wrapped to the
    // terminal, a note on the part at the cursor, a reason the answer is not
    // taken, and the keys. With more than one row, each starts with its
    // number, the cursor's in red-pink. Each place is as wide with the cursor on
    // it as without.
    const editFrame = (q, rows, at, held, warning) => {
        const many = rows.length > 1;
        const lead = many ? 5 : 2;
        const width = Math.max(20, (output.columns || 80) - lead);
        const rowLines = rows.flatMap((row, r) => {
            const places = [...row, '+'].map((label, i) => {
                const size = label.length + 2;
                if (r !== at.row || i !== at.col)
                    return { text: i === row.length ? s.dim(` ${label} `) : ` ${label} `, size };
                return { text: s.select(held ? `‹${label}›` : `[${label}]`), size };
            });
            const lines = wrapPlaces(places, width, '');
            if (!many)
                return lines.map((l) => `  ${l}`);
            const number = r === at.row ? s.select(String(r + 1)) : s.dim(String(r + 1));
            return lines.map((l, k) => `  ${k ? ' ' : number}  ${l}`);
        });
        const row = rows[at.row];
        const onPart = at.col < row.length;
        let note;
        if (onPart) {
            const part = row[at.col];
            const others = many ? rows.flatMap((other, r) => (r !== at.row && other.includes(part) ? [r + 1] : [])) : [];
            note = `${q.note?.(part) ?? s.value(part)}${others.length ? s.dim(` Also in row ${others.join(' and ')}.`) : ''}`;
        }
        else
            note = `${s.value('+')} ${s.dim('adds a part here:')} ${s.key('↑')} ${s.dim('or')} ${s.key('↓')} ${s.dim('picks one.')}`;
        const changeRow = many ? [['Tab', 'row']] : [];
        const keys = held
            ? [[many ? '←→↑↓' : '←→', 'move it'], ['Space', 'drop']]
            : onPart
                ? [['←→', 'move'], ['↑↓', 'change'], ...changeRow, [many ? '⇧←→↑↓' : '⇧←→', 'move it'], ['Space', 'pick up'], ['d', 'remove']]
                : [['←→', 'move'], ['↑↓', 'add a part'], ...changeRow];
        return [
            q.preview ? q.preview(rows, { row: at.row, part: at.col }) : previewNow(),
            s.pill('INPUT', 'question'),
            `${q.message}\n`,
            `${rowLines.join('\n')}\n`,
            note ? `${' '.repeat(lead)}${note}\n` : '',
            warning ? s.warn(warning) : '',
            keysOf(keys),
        ].join('');
    };
    // The editor as Ink shows it, for one row or several. Its state lives in a
    // ref, as Question's does. The cursor is on a part, or at its row's length
    // on the add slot. With more than one row, Tab and Shift+Tab move between
    // rows, and Shift with up or down, or up or down with the part picked up,
    // moves the part to the row above or below.
    const Editor = ({ q, done }) => {
        const state = React.useRef({ rows: q.initial.map((row) => [...row]), at: { row: 0, col: 0 }, held: false, warning: '', answered: false });
        const [, redraw] = React.useState(0);
        ink.useInput((input, key) => {
            const now = state.current;
            if (now.answered)
                return;
            const many = now.rows.length > 1;
            const row = now.rows[now.at.row];
            const n = row.length;
            const onPart = now.at.col < n;
            now.warning = '';
            if ((input === 'c' && key.ctrl) || key.escape) {
                now.answered = true;
                done(key.escape ? 'back' : 'stop', now.rows);
                return;
            }
            if (key.tab && many) {
                now.at.row = (now.at.row + (key.shift ? -1 : 1) + now.rows.length) % now.rows.length;
                now.at.col = Math.min(now.at.col, now.rows[now.at.row].length);
                now.held = false;
            }
            else if (key.leftArrow || key.rightArrow) {
                const to = now.at.col + (key.leftArrow ? -1 : 1);
                if ((key.shift || now.held) && onPart) {
                    // The part swaps with its neighbour, and never passes the add slot.
                    if (to < 0 || to >= n)
                        return;
                    [row[now.at.col], row[to]] = [row[to], row[now.at.col]];
                }
                else if (to < 0 || to > n)
                    return;
                now.at.col = to;
            }
            else if ((key.upArrow || key.downArrow) && (key.shift || now.held) && onPart && many) {
                // The part goes to the row above or below, at the same place or at
                // its end, unless that row shows it already.
                const target = now.at.row + (key.upArrow ? -1 : 1);
                if (target < 0 || target >= now.rows.length)
                    return;
                const part = row[now.at.col];
                if (now.rows[target].includes(part))
                    now.warning = `Row ${target + 1} shows ${part} already.`;
                else {
                    row.splice(now.at.col, 1);
                    const col = Math.min(now.at.col, now.rows[target].length);
                    now.rows[target].splice(col, 0, part);
                    now.at = { row: target, col };
                }
            }
            else if (key.upArrow || key.downArrow) {
                const step = key.upArrow ? -1 : 1;
                if (onPart) {
                    // The part at the cursor and each part not in the row, in order.
                    const cycle = q.options.filter((p) => p === row[now.at.col] || !row.includes(p));
                    const i = cycle.indexOf(row[now.at.col]);
                    row[now.at.col] = cycle[(i + step + cycle.length) % cycle.length];
                }
                else {
                    // The add slot becomes a part, and a new add slot follows it.
                    const free = q.options.filter((p) => !row.includes(p));
                    if (!free.length)
                        return;
                    row.push(step > 0 ? free[0] : free[free.length - 1]);
                }
            }
            else if (input === ' ' && onPart) {
                now.held = !now.held;
            }
            else if ((key.backspace || key.delete || (input === 'd' && !key.ctrl && !key.meta)) && onPart) {
                row.splice(now.at.col, 1);
                now.held = false;
            }
            else if (key.return) {
                const empty = now.rows.findIndex((r) => !r.length);
                if (empty >= 0) {
                    now.at = { row: empty, col: 0 };
                    now.warning = many ? `Row ${empty + 1} has no parts: ↑ or ↓ on + adds one.` : 'Add a part: ↑ or ↓ on +.';
                }
                else {
                    now.answered = true;
                    done('answer', now.rows);
                    return;
                }
            }
            else
                return;
            redraw((r) => r + 1);
        });
        React.useEffect(() => {
            ready?.();
        }, []);
        const now = state.current;
        return h(ink.Text, null, editFrame(q, now.rows, now.at, now.held, now.warning));
    };
    // The editor for `q`, as settle mounts it, resolving to the rows.
    const editRows = (q) => settle('INPUT', q.message, (finish) => h(Editor, {
        q,
        done: (end, rows) => finish(end, rows, rows.map((row) => row.join(', ')).join(' | ')),
    }));
    const choices = {
        one: async ({ kind, message, hint, options, initial, preview: previewFor, moving }) => {
            const { cursor } = await ask({
                kind,
                message,
                hint,
                labels: options.map((o) => o.label),
                answers: options.map((o) => o.answer),
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
        each: async ({ message, targets, options, initial, preview: previewFor, moving, note, allLabel = 'All', rows }) => {
            const at = (value) => Math.max(0, options.findIndex((o) => o.value === value));
            const cursors = [at(initial.all), ...initial.each.map(at)];
            const labels = [allLabel, ...targets];
            // Without rows, a stop for All and each target. With rows, a stop for
            // each part of a row that is a target, or with no targets, the one
            // named by allLabel; and one for All first, when there are targets.
            const stops = rows
                ? [
                    ...(targets.length ? [{ tab: 0 }] : []),
                    ...rows.flatMap((row, r) => row.flatMap((part, col) => {
                        const tab = targets.length ? targets.indexOf(part) + 1 : part === allLabel ? 0 : -1;
                        return tab < 0 || (targets.length && tab === 0) ? [] : [{ tab, row: r, col }];
                    })),
                ]
                : labels.map((_, tab) => ({ tab }));
            const { cursors: chosen } = await ask({
                kind: 'INPUT',
                message,
                labels: options.map((o) => o.label),
                initial: cursors[stops[0]?.tab ?? 0],
                tabs: { labels, cursors, notes: note && options.map((o) => note(o.value)), stops: stops.length ? stops : [{ tab: 0 }], rows: rows?.map((row) => [...row]) },
                moving,
                preview: (_, __, now, mark) => previewFor ? previewFor(options[now[0]].value, now.slice(1).map((i) => options[i].value), mark) : previewNow(),
            });
            return { all: options[chosen[0]].value, each: chosen.slice(1).map((i) => options[i].value) };
        },
        edit: async (q) => {
            const [row] = await editRows({
                message: q.message,
                options: q.options,
                initial: [q.initial],
                note: q.note,
                preview: q.preview && ((rows, at) => q.preview?.(rows[0], at?.part) ?? ''),
            });
            return row;
        },
        rows: editRows,
        order: async ({ message, options, describe, separator = ', ', preview: previewFor }) => {
            const { ticked } = await ask({
                kind: 'INPUT',
                message,
                labels: options.map((o) => o.label),
                initial: 0,
                ticked: options.map((_, i) => i),
                order: { describe: describe ?? ((order) => order.map((i) => options[i].label).join(separator)) },
                preview: (cursor, now) => (previewFor ? previewFor(now.map((i) => options[i].value), cursor) : previewNow()),
            });
            return ticked.map((i) => options[i].value);
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
// The codes that start and end a synchronized update: a terminal that
// knows them shows what comes between at once, and one that does not
// ignores them.
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
// `stream` with each write as one synchronized update. Ink redraws a
// question by erasing its lines and writing them again, many times a second
// while the bar style preview moves, and a terminal can show the frame half
// erased between the two, so the lines at the bottom, the keys, flash.
// Wrapped, each frame shows whole. Everything else passes through.
function synchronized(stream) {
    return new Proxy(stream, {
        get(target, key, receiver) {
            if (key === 'write')
                return (chunk, ...rest) => target.write(typeof chunk === 'string' && chunk ? `${SYNC_START}${chunk}${SYNC_END}` : chunk, ...rest);
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
async function loadInkIo(input, output, color) {
    const [ink, react] = await Promise.all([import('ink'), import('react')]);
    const React = react.default ?? react;
    const frames = synchronized(output);
    const mount = (tree) => ink.render(tree, {
        stdin: input,
        stdout: frames,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    return inkIoWith({ ink, React, mount, animate: true }, output, color);
}
