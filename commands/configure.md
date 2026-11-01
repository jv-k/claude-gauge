---
description: Change what claude-gauge's status line and token line show, or take one of them out
allowed-tools: Bash(node:*), AskUserQuestion, Read
---

# Configure claude-gauge

You are changing the switches of claude-gauge's lines in the user's Claude Code settings: the **status line** and the **token line**. The claude-gauge command does the writing. Your job is to ask the questions, turn the answers into switches, and run it once. Never edit `settings.json` yourself.

## 1. Read what is set up now

Read the user's settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. claude-gauge's status line is the `statusLine` command that runs a `claude-gauge` `statusline.js`, and its token line is the `hooks.Stop` command that runs a `claude-gauge` `tokenline.js`. The switches after the script are the line's current choices.

If neither is there, tell the user to run `/claude-gauge:setup` first, and stop.

## 2. Ask what to change

`AskUserQuestion` takes at most four options per question, and the user can always type an answer of their own. Name the current choices in each question.

First ask one question, with one `AskUserQuestion` call:

- **What to change?** Offer the status line, the token line, and taking a line out. When only one line is set up, offer to add the missing one in place of the line that is not there.

Then ask a second `AskUserQuestion` call with only the questions for the line the user chose, the recommended option first in each. For the status line:

- **Rows?** Keep them (recommended), the default two rows (`ctx,5h,7d` above `time,duration,repo,branch,model,effort`), or one row of usage only (`--show 5h,7d`). The user can also type their own rows: each `--show` is one row, its parts separated by commas, from the parts tables in the claude-gauge README.
- **Bar style?** Keep it (recommended), or two of `classic` (the default, `▓▓┃░░`), `steps` (`▅▅▅▁▁▁`) and `hairline` (`━━╋───`) that are not the current one (`--bar-style <name>`). The user can also type `rising`, `dots`, `spark` or `underline`, or a style for each bar, such as `steps,ctx=rising`: the style for every bar, then `<bar>=<style>` for each of `ctx`, `5h`, `7d` and `ram` that differs. When the style changes, set the `ctx` bar's style as the token line's `--bar-style` too, if a token line is set up (`--bar-style rising` for that example).
- **Bar size?** Ask only when a bar's style is `classic`. Keep it (recommended), 5 cells (the default), or 10 (`--segments 10`). The user can also type a size for each bar, such as `5,ctx=10`.
- **Theme?** Keep it (recommended), or one of `default`, `mono`, `high-contrast` and `pastel` (`--theme <name>`) that is not the current one.

For the token line:

- **Parts?** Keep them (recommended), all of them (`time,req,out,cache,ctx`), or `req,out,ctx` (`--show req,out,ctx`). The user can also type their own list from those five.

Do not ask for the context window. The token line takes it from the status line. Keep a `--window` that is set up now, as it is written.

To take a line out, ask which one. To add the missing line, ask the same questions for it, with its defaults in place of "Keep", and pass its switches to `configure` as for a changed line: `configure` adds a line that is not there. A token line added next to a status line with a `--bar-style` takes the same `--bar-style`.

## 3. Run configure

A line's switches replace all of its current ones, so start from its current switches and change only what the user changed. Pass each changed line's full switches as one single-quoted argument, and leave a line the user did not change out of the command:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --status-line '<status line switches>' --token-line '<token line switches>'
```

To take a line out, pass `--no-status-line` or `--no-token-line` in place of its pair. Taking the status line out puts back the status line that setup replaced, if there was one.

If the command exits 1 because the settings run another status line, show the user the command it printed and ask with `AskUserQuestion` whether to replace it, recommending to replace it, since claude-gauge saves it. With consent, run the same command again with `--replace` added.

If the command exits 2, the switches are wrong: read its message, fix the command, and run it again. Never write the settings by hand instead.

## 4. Report

Tell the user what changed, with the commands the command printed, and that the change shows from the next Claude Code session.
