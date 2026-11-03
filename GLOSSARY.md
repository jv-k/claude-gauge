# claude-gauge

claude-gauge draws two lines in Claude Code: the status line, with context and usage limits, and the token line, with the tokens of the last reply.

## Language

**Line**:
One of the two things claude-gauge draws in Claude Code: the status line or the token line.
_Avoid_: Bar (for a whole line)

**Status line**:
The line that shows context, the 5-hour and weekly usage windows, and session details, in one or more rows.

**Row**:
One row of the status line: the parts it shows, in their order.
_Avoid_: Line (for a row)

**Part**:
One item a row can show, such as ctx, 5h or branch.
_Avoid_: Component, segment, item

**Token line**:
The line that shows the tokens, cache and context of the last reply.

**Bar**:
The mark that shows one percentage, such as context used or a usage window used, drawn in a bar style.
_Avoid_: Gauge, meter, progress bar

**Cell**:
One character position in a bar, filled or empty.
_Avoid_: Segment, block

**Bar style**:
The way a bar is drawn: its characters, its width in cells, and how it shows the pace marker. One bar style can draw every bar on both lines, or each bar can have its own. A bar style never changes the labels, percentages, reset times or separators around a bar.
_Avoid_: Theme (a theme sets colours only), look, skin

**Pace marker**:
The mark in a usage window's bar at the share of the window that has passed, coloured by the usage projected for the end of the window.
_Avoid_: Now marker, cursor

## Setup

**Row editor**:
The setup step that edits the rows in place: each row's parts side by side, in their order, with the add slot after them.
_Avoid_: Tick list, order step

**Add slot**:
The place after the last part in a row editor, shown as "+", that becomes a new part when given one.
_Avoid_: Placeholder, ghost item, empty slot
