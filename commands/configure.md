---
description: Change what claude-gauge's status line and token line show, or take one of them out
allowed-tools: Bash(node:*), AskUserQuestion, Read
---

# Configure claude-gauge

You are changing the switches of claude-gauge's bars in the user's Claude Code settings: the **status line** and the **token line**. The claude-gauge command does the writing. Your job is to ask the questions, turn the answers into switches, and run it once. Never edit `settings.json` yourself.

## 1. Read what is set up now

Read the user's settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. claude-gauge's status line is the `statusLine` command that runs a `claude-gauge` `statusline.js`, and its token line is the `hooks.Stop` command that runs a `claude-gauge` `tokenline.js`. The switches after the script are the bar's current choices.

If neither is there, tell the user to run `/claude-gauge:setup` first, and stop.

## 2. Ask what to change

Ask with one `AskUserQuestion` call, the recommended option first in each question, and name the current choices in each question:

- **Which bar?** The status line, the token line, or both. Offer to take a bar out, or to add the one that is missing.
- **Status line rows?** Keep them (recommended), the default two rows (`ctx,5h,7d` above `time,duration,repo,branch,model,effort`), or one row of usage only (`--show 5h,7d`). The user can also type their own rows: each `--show` is one row, its parts separated by commas, from the parts tables in the claude-gauge README.
- **Bar size and theme?** Keep them (recommended), 5 or 10 cells (`--segments 10`), and the theme: `default`, `mono`, `high-contrast` or `pastel` (`--theme <name>`).
- **Token line parts?** Keep them (recommended), all of them (`time,req,out,cache,ctx`), or the user's own list from those five (`--show <parts>`).

Ask only the questions that apply to the bars the user is changing.

## 3. Run configure

A bar's switches replace all of its current ones, so start from its current switches and change only what the user changed. Pass each changed bar's full switches as one single-quoted argument, and leave a bar the user did not change out of the command:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --status-line '<status line switches>' --token-line '<token line switches>'
```

To take a bar out, pass `--no-status-line` or `--no-token-line` in place of its pair. Taking the status line out puts back the status line that setup replaced, if there was one.

If the command exits 1 because the settings run another status line, show the user the command it printed and ask with `AskUserQuestion` whether to replace it, recommending to replace it, since claude-gauge saves it. With consent, run the same command again with `--replace` added.

If the command exits 2, the switches are wrong: read its message, fix the command, and run it again. Never write the settings by hand instead.

## 4. Report

Tell the user what changed, with the commands the command printed, and that the change shows from the next Claude Code session.
