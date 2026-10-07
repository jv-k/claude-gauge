# Installing claude-gauge: instructions for Claude Code

Claude, you are installing claude-gauge into the Claude Code setup you are running in: a **status line** (context, 5-hour and weekly usage) and a **token line** (tokens spent per turn). Both are Node.js scripts that the user's `~/.claude/settings.json` runs. Work through the steps in order; each ends on its done condition.

A second run of these steps updates the install rather than duplicating it.

## 1. Check the prerequisites

Run `node --version` and `git --version`.

Done when you know the Node.js version is 18 or later, and whether git is present. If Node.js is older or missing, stop and tell the user claude-gauge needs Node.js 18 or later.

## 2. Fetch the scripts

- If `~/.claude/claude-gauge/.git` exists, update it: `git -C ~/.claude/claude-gauge pull`.
- Otherwise, with git: `git clone https://github.com/jv-k/claude-gauge.git ~/.claude/claude-gauge`.
- Without git, download `statusline.js`, `tokenline.js` and `README.md` into `~/.claude/claude-gauge/` with `curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/<file>`.

Done when `~/.claude/claude-gauge/statusline.js`, `tokenline.js` and `README.md` exist.

## 3. Learn the switches

Read the **Options** section of `~/.claude/claude-gauge/README.md`. It lists every switch and part name for both lines. Use only those switches in the commands below.

Done when you can name the parts `--show` accepts for each line.

## 4. Ask the user what to install

Ask with one `AskUserQuestion` call, the recommended option first in each question:

- **Which bars?** The status line, the token line, or both. Recommend both.
- **Which status line layout?** Recommend the default two rows (no `--show`): `ctx,5h,7d` above `time,duration,repo,branch,model,effort`. Offer one row of usage only (`--show 5h,7d`), and a custom layout: each `--show` is one row, built from the parts in the README's two parts tables.
- **Bar size?** 5 cells (the default) or 10 (`--segments 10`).
- **Where should the token line appear?** As a Stop hook, it shows in the terminal CLI. In surfaces that do not show hook messages, such as the VS Code extension, you show it yourself through a `~/.claude/CLAUDE.md` instruction (step 7). Recommend the hook, plus the instruction when this session runs outside the terminal.

Decide the context window yourself: if your own context window is 1M tokens, add `--window 1m` to the token line, so its percentage is right from the first turn.

Done when every question that applies has an answer.

## 5. Build the commands and check they run

Build each command from the answers, for example `node ~/.claude/claude-gauge/statusline.js --show ctx,5h,7d`.

Check the status line with a sample payload:

```sh
echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'"$PWD"'"},"context_window":{"used_percentage":25}}' | node ~/.claude/claude-gauge/statusline.js <switches>
```

Check the token line on this session: `node ~/.claude/claude-gauge/tokenline.js --latest <switches>`.

Done when both commands print one line each.

## 6. Merge the entries into settings.json

Read `~/.claude/settings.json` (treat a missing file as `{}`), and copy it to `~/.claude/settings.json.claude-gauge-bak` before you change it. Then merge with Edit, keeping every existing key:

- **Status line:** set `statusLine` to `{ "type": "command", "command": "<status line command>" }`. If `statusLine` already holds a different command, show it to the user and replace it only with their consent.
- **Token line:** append `{ "hooks": [ { "type": "command", "command": "<token line command>" } ] }` to the `hooks.Stop` array, creating `hooks` and `Stop` as needed. Keep the user's other hooks. If an entry already runs `claude-gauge/tokenline.js`, update that entry instead of adding a second one.

Confirm the result parses: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" ~/.claude/settings.json`.

Claude Code may refuse your edit to its own settings, for example under auto mode. Then give the user the exact JSON to merge, and continue.

Done when settings.json parses and holds the entries the user chose, or the user has the JSON to merge.

## 7. Add the CLAUDE.md instruction (if chosen)

Append this to `~/.claude/CLAUDE.md`, unless it already mentions `tokenline.js --latest`:

```md
## Token usage

End every reply with the output of `node ~/.claude/claude-gauge/tokenline.js --latest <switches>`,
run as the last tool call of the turn, pasted verbatim as a code block.
```

Replace `<switches>` with the token line switches from step 5, or remove it.

Done when `~/.claude/CLAUDE.md` holds exactly one such instruction.

## 8. Report

Tell the user, in a few lines:

- what you installed, with each command;
- that the changes take effect in a new Claude Code session;
- that the status line shows in the terminal CLI, and in VS Code only when `claude` runs in its integrated terminal;
- where the settings backup is, and that `git -C ~/.claude/claude-gauge pull` updates claude-gauge.
