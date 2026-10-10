# Detecting OSC 8 link support in the terminal

claude-gauge does not try to find out whether the terminal supports OSC 8 hyperlinks. The folder, branch and pull request parts always print their links, and `--no-links` turns them off.

## Why this is out of scope

A terminal that does not support OSC 8 drops the codes. ECMA-48 parsing reads an OSC string up to its terminator and shows nothing of it, so the user sees the plain text and loses only the click. The cost of a wrong guess is therefore small, and the user who sees stray codes has a one-switch fix.

Detection would cost more than it saves:

- No standard signal exists. A heuristic must read `TERM_PROGRAM`, `TERM`, `VTE_VERSION`, `WT_SESSION` and others, and keep a list of terminals and versions that goes stale as terminals add support.
- Claude Code runs the status line as a subprocess. The environment that the status line sees can differ from the terminal's own, for example inside tmux, SSH or an IDE terminal, so a guess from the environment can be wrong in both directions.
- A wrong "no" removes links that would have worked, and the user has no switch to force them on.

The switch keeps the user in control and keeps the status line free of terminal guesswork.

```sh
npx @jv-k/claude-gauge configure --status-line "--no-links"
```

## Prior requests

- #68: "Detect whether the terminal supports OSC 8 links"
