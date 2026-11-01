# Bar styles are separate from themes, and each style sets its own width

- Status: accepted, amended by [0008](0008-bar-style-and-cells-per-bar.md): each bar can have its own style and cells
- Date: 2026-11-01

## Context

Every bar was drawn the same way: 5 or 10 cells of `▓` and `░`, set by `--segments`, with `┃` for the pace marker. `--bar-filled` and `--bar-empty` could change the two characters, but not the shape. A prototype tried slimmer bars: thin rules, dots, one rising cell, an underline under the text, and tall blocks over a low track. Several of them look right only at their own width: one cell, three cells or the width of the text.

## Decision

The owner chose a new switch, `--bar-style <name>`, with seven styles: `classic`, `steps`, `rising`, `hairline`, `dots`, `spark` and `underline`.

- A bar style sets how every bar on both lines is drawn. A theme still sets colours only.
- A style changes only the bar and the pace marker. The label, the percentage, the reset time and the separators around a bar stay as they are, so styles work with `--no-labels`, `--compact` and `--right`.
- Each style has its own width in cells. `--segments` applies to `classic` only.
- `classic` is the default, so an update changes nothing for current users.
- `--bar-filled` and `--bar-empty` replace the characters of the styles that have filled and empty cells: `classic`, `steps`, `hairline` and `dots`. `rising`, `spark` and `underline` ignore them.
- `steps` and `underline` show the pace marker by colour alone, and `rising` and `spark` by a `•` in the pace colour after the bar. Without colour (the mono theme, and the plain text of `--latest`), `steps` draws `┃` in the marker's cell and `rising` and `spark` leave out the `•`. With mono, `underline` inverts the marker's character, because a `┃` would replace a letter of the text. In plain text, `underline` draws as `classic`, because its underline is removed with the other codes. The token line is always plain text, so there `underline` always draws as `classic`.

## Considered options

- **Themes carry the style.** Rejected: a user could not pair the pastel colours with the steps bar, and every new style would need a theme for each set of colours.
- **A style also sets the order of the values, or the separators.** Rejected: styles would then conflict with `--no-labels`, `--compact` and `--right`.
- **`--segments` applies to every style, or overrides each style's width.** Rejected: 5 or 10 cells removes the point of `rising` and `spark`, and an override adds one more combination to test for each style.
