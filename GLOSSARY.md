# claude-gauge

claude-gauge draws two lines in Claude Code: the status line, with context and usage limits, and the token line, with the tokens of the last reply.

## Language

**Line**:
One of the two things claude-gauge draws in Claude Code: the status line or the token line.
_Avoid_: Bar (for a whole line)

**Status line**:
The line that shows context, the 5-hour and weekly usage windows, and session details, in one or more rows.

**Token line**:
The line that shows the tokens, cache and context of the last reply.

**Bar**:
The mark that shows one percentage, such as context used or a usage window used, drawn in a bar style.
_Avoid_: Gauge, meter, progress bar

**Cell**:
One character position in a bar, filled or empty.
_Avoid_: Segment, block

**Bar style**:
The way every bar on both lines is drawn: its characters, its width in cells, and how it shows the pace marker. A bar style never changes the labels, percentages, reset times or separators around a bar.
_Avoid_: Theme (a theme sets colours only), look, skin

**Pace marker**:
The mark in a usage window's bar at the share of the window that has passed, coloured by the usage projected for the end of the window.
_Avoid_: Now marker, cursor
