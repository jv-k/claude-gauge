# Installing claude-gauge: instructions for Claude Code

Claude, you are installing claude-gauge into the Claude Code setup you are running in: a **status line** (context, 5-hour and weekly usage) and a **token line** (tokens spent per turn). Both are Node.js scripts that the user's `~/.claude/settings.json` runs. Work through the steps in order; each ends on its done condition.

A second run of these steps updates the install rather than duplicating it.

Steps 1 to 8 install from a git clone. When the user asks for the npm package, follow [The npm route](#the-npm-route) instead.

## 1. Check the prerequisites

Run `node --version` and `git --version`.

Done when you know the Node.js version is 18 or later, and whether git is present. If Node.js is older or missing, stop and tell the user claude-gauge needs Node.js 18 or later.

## 2. Fetch the scripts

- If `~/.claude/claude-gauge/.git` exists, update it: `git -C ~/.claude/claude-gauge pull`.
- Otherwise, with git: `git clone https://github.com/jv-k/claude-gauge.git ~/.claude/claude-gauge`.
- Without git, but with npm (`npm --version` prints a version), follow [The npm route](#the-npm-route) instead.
- Without git or npm, download `dist/statusline.js`, `dist/tokenline.js` and `README.md` into `~/.claude/claude-gauge/`, keeping the `dist/` folder, with `curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/<file>`.

Done when `~/.claude/claude-gauge/dist/statusline.js`, `dist/tokenline.js` and `README.md` exist.

## 3. Learn the switches

Read the **Options** section of `~/.claude/claude-gauge/README.md`. It lists every switch and part name for both lines. Use only those switches in the commands below.

Done when you can name the parts `--show` accepts for each line.

## 4. Ask the user what to install

Ask with one `AskUserQuestion` call, the recommended option first in each question:

- **Which bars?** The status line, the token line, or both. Recommend both.
- **Which status line layout?** Recommend the default two rows (no `--show`): `ctx,5h,7d` above `time,duration,repo,branch,model,effort`. Offer one row of usage only (`--show 5h,7d`), and a custom layout: each `--show` is one row, built from the parts in the README's two parts tables.
- **Bar size?** 5 cells (the default) or 10 (`--segments 10`).
- **Also in VS Code and the desktop app?** The VS Code extension and the desktop app show neither the status line nor hook messages. A SessionStart hook per bar, with `--instruct` (step 7), has you paste that bar at the end of each reply in those two hosts, and does nothing in the terminal CLI. Recommend it for every bar the user chose.

Decide the context window yourself: if your own context window is 1M tokens, add `--window 1m` to the token line, so its percentage is right from the first turn.

Done when every question that applies has an answer.

## 5. Build the commands and check they run

Build each command from the answers, for example `node ~/.claude/claude-gauge/dist/statusline.js --show ctx,5h,7d`.

Check the status line with a sample payload:

```sh
echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'"$PWD"'"},"context_window":{"used_percentage":25}}' | node ~/.claude/claude-gauge/dist/statusline.js <switches>
```

Check the token line on this session: `node ~/.claude/claude-gauge/dist/tokenline.js --latest <switches>`.

Done when both commands print one line each.

## 6. Merge the entries into settings.json

Read `~/.claude/settings.json` (treat a missing file as `{}`), and copy it to `~/.claude/settings.json.claude-gauge-bak` before you change it. Then merge with Edit, keeping every existing key:

- **Status line:** set `statusLine` to `{ "type": "command", "command": "<status line command>" }`. If `statusLine` already runs `claude-gauge/statusline.js` or `claude-gauge/dist/statusline.js`, replace that command. If it holds any other command, show it to the user and replace it only with their consent.
- **Token line:** append `{ "hooks": [ { "type": "command", "command": "<token line command>" } ] }` to the `hooks.Stop` array, creating `hooks` and `Stop` as needed. Keep the user's other hooks. If an entry already runs `claude-gauge/tokenline.js` or `claude-gauge/dist/tokenline.js`, update that entry to the new command instead of adding a second one.

Confirm the result parses: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" ~/.claude/settings.json`.

Claude Code may refuse your edit to its own settings, for example under auto mode. Then give the user the exact JSON to merge, and continue.

Done when settings.json parses and holds the entries the user chose, or the user has the JSON to merge.

## 7. Add the SessionStart hooks (if chosen)

For each bar the user wants in VS Code and the desktop app, append `{ "hooks": [ { "type": "command", "command": "<command>" } ] }` to the `hooks.SessionStart` array of `~/.claude/settings.json`, creating `hooks` and `SessionStart` as needed. The command is the bar's step 5 command with `--instruct` added, for example `node ~/.claude/claude-gauge/dist/statusline.js --instruct --window 1m`. If an entry already runs that script with `--instruct`, at either the old or the `dist/` path, update it instead of adding a second one. Keep the user's other hooks, and confirm the file parses as in step 6.

Check each hook:

```sh
CLAUDE_CODE_ENTRYPOINT=claude-vscode node ~/.claude/claude-gauge/dist/statusline.js --instruct <switches>
```

prints an instruction that names the `--latest` command. The same command without the variable prints nothing.

If `~/.claude/CLAUDE.md` holds an older claude-gauge instruction that mentions `--latest`, tell the user the hook replaces it, and remove it with their consent.

Done when settings.json holds one SessionStart entry per chosen bar, or the user has the JSON to merge.

## 8. Report

Tell the user, in a few lines:

- what you installed, with each command;
- that the changes take effect in a new Claude Code session;
- that the bars show in the terminal CLI, and, with the step 7 hooks, at the end of each reply in the VS Code extension and the desktop app;
- where the settings backup is, and that `git -C ~/.claude/claude-gauge pull` updates claude-gauge.

## The npm route

The `claude-gauge` command from npm does the fetch and the settings merge itself. It copies the scripts into `~/.claude/claude-gauge/runtime/` and backs up `~/.claude/settings.json` before it changes it.

1. **Check the prerequisites.** Run `node --version` and `npm --version`. Done when Node.js is 18 or later and npm is present. If not, stop and tell the user claude-gauge needs Node.js 18 or later, with npm.
2. **Learn the switches.** Read the **Options** section of the README, at `https://raw.githubusercontent.com/jv-k/claude-gauge/main/README.md`. Done when you can name the parts `--show` accepts for each line.
3. **Ask the user what to install,** as in step 4. Done when every question that applies has an answer.
4. **Run setup with the answers as switches.** It asks nothing when it gets bar switches:

   ```sh
   npx claude-gauge setup --status-line "<status line switches>" --token-line "<token line switches>"
   ```

   Give `""` for a bar with no switches, and `--no-token-line` or `--no-status-line` in place of a bar the user does not want. If setup stops because the settings run another status line, show that command to the user, and run again with `--replace` only with their consent. Setup saves the status line it replaces, and `npx claude-gauge uninstall` puts it back. Done when setup prints the commands it set up.
5. **Add the SessionStart hooks (if chosen),** as in step 7, with commands that name `~/.claude/claude-gauge/runtime/` in place of `~/.claude/claude-gauge/dist/`. Done when settings.json holds one SessionStart entry per chosen bar, or the user has the JSON to merge.
6. **Report,** as in step 8, with the backup path that setup printed. The update command is `npx claude-gauge@latest update`, which keeps the user's switches.
