# Setup defaults to the dots bar style; the status line's own default stays classic

- Status: accepted
- Date: 2026-11-03

## Context

[0007](0007-bar-styles.md) made `classic` the default bar style, so that an update changes nothing for current users. The owner then wanted `dots` as the default for new setups.

## Decision

- Setup's defaults draw the bars in `dots`. A yes to the defaults, a start over, `setup --yes` and the plugin's `/claude-gauge:setup` defaults all write `--bar-style dots` on each line. Customising starts from `dots` too, so the cells question, which is for `classic` bars only, is not asked unless a bar is changed to `classic`.
- The status line's and the token line's own default stays `classic`. A line with no `--bar-style`, such as one set up before this change, keeps its bars after an update, and configure reads it as `classic`.

## Considered options

- **Make `dots` the status line's own default.** Rejected: every line set up with no `--bar-style` would change after an update, without the user asking, which 0007 set out to avoid.
- **Keep `classic` for new setups too.** Rejected by the owner, who prefers `dots`.
