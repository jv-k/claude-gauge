---
description: Add claude-gauge's status line and token line to your Claude Code settings
allowed-tools: Bash(node:*), AskUserQuestion
---

# Set up claude-gauge

You are adding claude-gauge to the user's Claude Code settings: a **status line** (context, 5-hour and weekly usage) and a **token line** (tokens spent per turn, shown when each turn ends). The claude-gauge command does the writing. Your job is to ask the questions, turn the answers into switches, and run it once. Never edit `settings.json` yourself.

## 1. Check Node.js

Run `node -v`. If Node.js is missing or older than 18, stop and tell the user that claude-gauge needs Node.js 18 or later.

## 2. Ask what to set up

Ask with one `AskUserQuestion` call, the recommended option first in each question:

- **Which bars?** Both (recommended), the status line only, or the token line only.
- **Defaults or your own?** The defaults (recommended), or choose the layout, bar size, theme and token line parts.
- **Context window?** The token line cannot read the window size, so it assumes 200k until the context grows past it. Offer 1M (`--window 1m`) and 200k, the default, with no switch. Name your own context window in the question, and recommend the option that matches it. The answer applies only if the user chooses the token line.

If the user chose their own, ask a second `AskUserQuestion` call with each question that applies to the bars they chose:

- **Status line rows?** The default two rows (recommended): `ctx,5h,7d` above `time,duration,repo,branch,model,effort`. Offer one row of usage only (`--show 5h,7d`). The user can also type their own rows: each `--show` is one row, its parts separated by commas, from the parts tables in the claude-gauge README.
- **Bar size?** 5 cells (recommended, the default), or 10 (`--segments 10`).
- **Theme?** `default` (recommended), `mono`, `high-contrast` or `pastel` (`--theme <name>`).
- **Token line parts?** All of them (recommended): `time,req,out,cache,ctx`. Offer `req,out,ctx` (`--show req,out,ctx`), or the user's own list from those five.

## 3. Run setup

Build each bar's switches from the answers. A default answer adds no switch, so the defaults give an empty string. Then run, with each bar's switches as one single-quoted argument:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup --status-line '<status line switches>' --token-line '<token line switches>'
```

For a bar the user did not choose, pass `--no-status-line` or `--no-token-line` in place of its pair. For example, both bars with every default, on a 1M-context model:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup --status-line '' --token-line '--window 1m'
```

If the command exits 1 because the settings already run another status line, such as claude-hud, show the user the command it printed and ask with `AskUserQuestion` whether to replace it. Recommend replacing it: claude-gauge saves it, and `/claude-gauge:uninstall` puts it back. With consent, run the same command again with `--replace` added. Without it, run it again with `--no-status-line` in place of the status line pair if the user still wants the token line, or stop.

If the command exits 2, the switches are wrong: read its message, fix the command, and run it again. Never write the settings by hand instead.

## 4. Report

Tell the user, in a few lines:

- what the command set up, with the commands it printed;
- that the bars show from the next Claude Code session in the terminal;
- that plugin updates take effect by themselves, with no setup, because the settings run a launcher that picks the newest installed version;
- that `/claude-gauge:configure` changes the bars and `/claude-gauge:uninstall` takes them out again.
