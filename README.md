<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jv-k/claude-gauge/main/docs/media/wordmark-dark.png">
    <img src="https://raw.githubusercontent.com/jv-k/claude-gauge/main/docs/media/wordmark-light.png" alt="claude-gauge" width="360">
  </picture>
</h1>

<div align="center">
  <img src="https://raw.githubusercontent.com/jv-k/claude-gauge/main/docs/media/hero.png" alt="The bottom of a Claude Code session: the prompt, and under it the claude-gauge status line with context, 5-hour and weekly usage bars, then the time, session length, repository, branch, model and effort.">
  <p>
    <a href="https://www.npmjs.com/package/@jv-k/claude-gauge"><img src="https://img.shields.io/npm/v/%40jv-k%2Fclaude-gauge" alt="npm version"></a>
    <a href="https://github.com/jv-k/claude-gauge/actions/workflows/test.yml"><img src="https://github.com/jv-k/claude-gauge/actions/workflows/test.yml/badge.svg" alt="Test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="MIT licence"></a>
  </p>
</div>

claude-gauge shows how much room you have left in [Claude Code](https://code.claude.com): in the context window, in the 5-hour usage window and in the weekly limit. It adds two bars to Claude Code.

The status line shows under the prompt:

```text
ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
11:10 │ 1h12m │ jv-k/claude-gauge │ ⎇ main* ↑1 │ Opus 5.5 │ effort high
```

The token line shows when each turn ends:

```text
11:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 427k
```

## Getting started

You need Claude Code and Node.js 18 or later.

### Install the plugin

In Claude Code, run these three commands:

```text
/plugin marketplace add jv-k/claude-gauge
/plugin install claude-gauge@claude-gauge
/claude-gauge:setup
```

If Claude Code does not find `/claude-gauge:setup`, run `/reload-plugins` first. Setup asks which bars you want. Then it backs up `~/.claude/settings.json` and adds the bars to it. Start a new session to see them.

### Or install from npm

In a terminal, run:

```sh
npx @jv-k/claude-gauge setup
```

Setup shows the status line and asks which parts you want. It draws the status line again after each answer:

![claude-gauge setup in a terminal: it shows the default rows, then draws them again as the answers change the second row, the bar size and the theme.](https://raw.githubusercontent.com/jv-k/claude-gauge/main/docs/media/demo.gif)

### VS Code and the desktop app

The VS Code extension and the desktop app show no custom status line and no token line. To see the bars there, add one SessionStart hook for each bar. In those two apps, the hook tells Claude to end each reply with the bars. In the terminal, it does nothing. First install claude-gauge with the plugin or with npm, as above. Then add the hooks in one of two ways.

#### Ask Claude

Paste this prompt into a Claude Code session:

```text
Set up claude-gauge for the VS Code extension and the desktop app.
Read ~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json when that variable is set.
Make a backup copy of the file first.
Find the statusLine command that runs claude-gauge's statusline.js, and the Stop hook that runs its tokenline.js.
Add two entries to hooks.SessionStart and keep every entry that is there already:
one runs the same statusline.js with --instruct, and one runs the same tokenline.js with --instruct.
Put each bar's existing switches after --instruct.
The status line already shows the time, so give the token line hook a --show without time, such as --show req,out,cache,ctx.
Test each new command with CLAUDE_CODE_ENTRYPOINT=claude-vscode. It must print an instruction.
Then tell me to start a new session.
```

#### Add the hooks by hand

1. Open `~/.claude/settings.json` and find the `statusLine` command that setup wrote. Its folder is `~/.claude/claude-gauge/runtime/` after an npm install, or `~/.claude/claude-gauge/launcher/` after a plugin install.
2. Add these two entries to the `SessionStart` array under `hooks`, with the folder from step 1. Keep the entries that are there already.

   ```json
   { "hooks": [ { "type": "command", "command": "node ~/.claude/claude-gauge/runtime/statusline.js --instruct" } ] },
   { "hooks": [ { "type": "command", "command": "node ~/.claude/claude-gauge/runtime/tokenline.js --instruct --show req,out,cache,ctx" } ] }
   ```

3. Start a new session.

#### The result

Each reply then ends with the bars:

```text
ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
11:10 │ 1h12m │ jv-k/claude-gauge │ ⎇ main* ↑1 │ Opus 5.5 │ effort high
4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 427k
```

The token line leaves out its time there, because the status line shows it. To change a bar in the replies, put its switches after `--instruct`, for example `--show 5h,7d`. On a 1M-context model, add `--window 1m` to both hooks. Each reply needs one or two more short tool calls. Uninstall also removes these hooks.

### Change, update or remove the bars

| Plugin | npm | Effect |
| --- | --- | --- |
| `/claude-gauge:configure` | `npx @jv-k/claude-gauge configure` | Changes the parts and switches of the bars. |
| `/plugin`, then **Marketplaces** | `npx @jv-k/claude-gauge@latest update` | Updates claude-gauge and keeps your switches. |
| `/claude-gauge:uninstall` | `npx @jv-k/claude-gauge uninstall` | Removes claude-gauge and puts back the status line it replaced. |

## Upgrading from claude-hud

If you use [claude-hud](https://github.com/jarrodwatts/claude-hud), run setup as in [Getting started](#getting-started). Setup finds claude-hud's status line, shows it, and asks before it replaces it. It saves claude-hud's command, so uninstall puts claude-hud back. Keep the claude-hud plugin installed until you are sure, because that command needs it.

claude-gauge has no configuration file. Each claude-hud option becomes a part or a switch in the bar's command. The reference [maps each option](https://github.com/jv-k/claude-gauge/blob/main/docs/reference.md#upgrading-from-claude-hud) to claude-gauge.

## What the bars show

The status line shows these parts by default:

| Part | Example | Shows |
| --- | --- | --- |
| `ctx` | `ctx 43% ▓▓░░░ 86.0k` | How much of the context window is in use. |
| `5h` | `5h 9% ░░┃░░ → 14:10` | Your 5-hour usage, and the time the window resets. |
| `7d` | `7d 41% ▓▓░┃░ → 3d` | Your weekly usage, and the days until it resets. |
| `time` | `11:10` | The local time. |
| `duration` | `1h12m` | How long the session has run. |
| `repo` | `jv-k/claude-gauge` | The repository, or the folder name. |
| `branch` | `⎇ main* ↑1` | The git branch. `*` means changes, and `↑1` means one commit ahead of the remote. |
| `model` | `Opus 5.5` | The model. |
| `effort` | `effort high` | The reasoning effort. |

The pace marker `┃` shows how much of the window has passed. Its colour shows where your usage goes at the current pace. Green stays well under the limit. Red and purple go over it.

Other parts show the tools and subagents in use, todos, git changes, pull requests, the cost per day and week, memory use and more. The [reference](https://github.com/jv-k/claude-gauge/blob/main/docs/reference.md#more-status-line-parts) lists all of them.

## Customise

Each bar takes switches in its `command` in your settings. `configure` writes them for you. Two examples:

```text
--show 5h,7d

5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
```

```text
--show ctx,5h,7d --show repo,branch,pr,lines --show model,effort,cost,cache

ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
jv-k/claude-gauge │ ⎇ main │ #12 approved │ +156 −23
Opus 5.5 │ effort high │ $1.23 │ cache 91% warm
```

Each `--show` is one row. The reference lists every [part, switch and theme](https://github.com/jv-k/claude-gauge/blob/main/docs/reference.md#options).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) gives the setup, the tests and the rules for a change. [RELEASING.md](RELEASING.md) gives the release steps.

## Star history

[![Star history of jv-k/claude-gauge](https://api.star-history.com/svg?repos=jv-k/claude-gauge&type=Date)](https://star-history.com/#jv-k/claude-gauge&Date)

## License

[MIT](LICENSE)
