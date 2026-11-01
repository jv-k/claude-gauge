# Each bar can have its own style and cells, in one list switch

- Status: accepted
- Date: 2026-11-01

## Context

[0007](0007-bar-styles.md) made one `--bar-style` draw every bar, and kept `--segments` as one size for every `classic` bar. The owner then wanted to set the bars one by one in the setup questions, with left and right to choose a bar and an "All" choice to set every bar at once.

## Decision

- `--bar-style` and `--segments` each take a list: a bare value for every bar, then `<bar>=<value>` for each bar with its own, such as `steps,ctx=rising` and `5,ctx=10`. A bare value alone works as before, so no setup changes.
- The bars are `ctx`, `5h`, `7d` and `ram`. The per-model limits of the `models` part follow `7d`, and the token line's one bar follows `ctx`.
- With no bare value, the other bars take the default. If a bar is in a list twice, the last one wins. An unknown style reads as `classic` and an unknown size as 5, as before; an entry for an unknown bar is left out.
- The token line reads a list too and takes the `ctx` bar's value. The setup questions write only the `ctx` bar's style into the token line's switches, so its command stays short.
- In the setup questions, the bar style and cells questions have a tab for All and one for each bar; the cells question has a tab only for each `classic` bar, and no tabs when only one bar is `classic`. A typed answer is a list in the switch's form.

## Considered options

- **A switch for each bar, such as `--ctx-bar-style`.** Rejected: eight new switches for the docs, the sync tests and the questions, where one list form covers both switches.
- **Per-bar style only, with one size for every `classic` bar.** Rejected by the owner, who wanted the cells set per bar too.
- **Step through only the bars in the rows chosen.** Rejected: the tabs would change with the rows, and a bar added to a row later would have no style of its own.
