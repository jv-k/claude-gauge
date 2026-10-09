# claude-gauge

Two small bars for [Claude Code](https://code.claude.com) that show how much room you have left: in the context window, in your 5-hour usage window, and in your weekly limit.

**Status line**, shown under the prompt in the terminal, in two rows by default:

```text
ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
11:10 │ 1h12m │ jv-k/claude-gauge │ ⎇ main │ Opus 5.5 │ effort high
```

**Token line**, shown when each turn ends:

```text
12:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 427k
```

Both are TypeScript modules built to single Node.js files with no dependencies, and both use the same parts: `│` between segments, short lowercase labels, and `▓░` bars. Switches choose what each line shows and how (see [Options](#options)). For example, `--show 5h,7d --segments 10` gives a status line with only your usage, in 10-cell bars:

```text
5h 9% ▓░░░┃░░░░░ → 14:10 │ 7d 41% ▓▓▓▓░░┃░░░ → 3d
```

The terminal CLI shows both bars by itself. In the VS Code extension and the desktop app, Claude can paste them into its replies instead (see [In VS Code and the desktop app](#in-vs-code-and-the-desktop-app)).

## What the bars show

### Status line

The default rows hold these parts, in this order. The name in the first column is what `--show` takes.

| Part | Shows | Meaning |
| --- | --- | --- |
| `ctx` | `ctx 43% ▓▓░░░ 86.0k` | How much of the context window is in use, as a percentage, a bar and a token count, the same shape as the token line's `ctx`. Cyan up to 50%, yellow up to 75%, red above. |
| `5h` | `5h 9% ░░┃░░ → 14:10` | Your 5-hour usage, as a bar, and the time the window resets. |
| `7d` | `7d 41% ▓▓░┃░ → 3d` | Your weekly usage, and the days until it resets. On the day of the reset it shows the time instead. |
| `time` | `11:10` | The current local time, or `11:10 am` with `--12h`. |
| `duration` | `1h12m` | How long the session has run: `45s`, `12m`, `1h12m`, `2d3h`. |
| `repo` | `jv-k/claude-gauge` | The repository from the `origin` remote. Without one it shows the folder name. |
| `branch` | `⎇ main` | The current git branch. Inside a linked worktree it names that too: `⎇ feat-x (wt my-feature)`. |
| `model` | `Opus 5.5` | The model. |
| `effort` | `effort high` | The reasoning effort, following `/effort` changes, when the model supports effort. |

**Context.** The percentage counts input only: fresh input, cache writes and cache reads. It does not count output. A high figure means that Claude Code will soon compact the conversation.

**Usage colours.** Each usage bar has 10 colour steps, from dark green at 0–10% to deep red above 90%.

**Pace marker.** The `┃` sits at the share of the window that has passed. If it is ahead of the filled cells, you are using less than an even pace. Its colour comes from the usage projected for the end of the window, calculated as used % × window length ÷ time elapsed:

| Projected usage | Colour |
| --- | --- |
| below 50% | green |
| 50% to 75% | teal |
| 75% to 90% | yellow |
| 90% to 100% | orange |
| 100% to 120% | red |
| above 120% | purple |

For the first 9 minutes of the 5-hour window, and for about the first 50 minutes of the week, the marker uses the bar's own colour, because the projection is not reliable that early.

**Reset times.** Reset times use the 24-hour clock and are rounded to the nearest minute.

**`~`.** A usage part shows `~`, as in `5h ~`, when Claude Code has not sent usage data yet. This happens before the first response of a session, and on plans that have no such limits. The usage parts need a claude.ai Pro or Max subscription.

### More status line parts

These parts show only when you name them in a `--show`. A part with nothing to report stays out of its row.

| Part | Shows | When |
| --- | --- | --- |
| `dir` | The folder Claude Code runs in: `my-project`. | Always. |
| `cost` | The session's estimated cost at list price: `$1.23`. Behind a spend limit it takes that limit's usage colour. | Always. Resets on `/clear`. |
| `lines` | Lines of code added and removed this session: `+156 −23`. | Always. |
| `name` | The session's name, or its AI-generated title, cut to 30 characters with `…`. | When the session has one. |
| `thinking` | `think`, when extended thinking is on. | Only when on. |
| `fast` | `fast`, when fast mode is on. | Only when on. |
| `style` | The output style: `style explanatory`. | When it is not `default`. |
| `worktree` | The linked git worktree: `wt my-feature`. The `branch` part names it too: `⎇ feat-x (wt my-feature)`. | Inside a linked worktree. |
| `pr` | The branch's open pull request and its review state: `#1234 approved`. Green when approved, yellow when pending, red when changes are requested, grey as a draft. A GitLab merge request reads `!1234`. | While a PR is open. |
| `agent` | The agent: `agent security-reviewer`. | When Claude Code runs with `--agent`. |
| `cache` | The prompt cache's hit ratio and state: `cache 91% warm`. Green when most requests hit the cache, red when most miss. | After the session's first response. |
| `spend` | Your spend against the limit: `$314/$500`, or `spend 63%` until Claude Code has the dollar amounts. | Behind a Claude apps gateway with a spend limit. |
| `version` | The Claude Code version: `v2.1.90`. | Always. |

### Token line

| Part | Meaning |
| --- | --- |
| `12:10` | The local time the turn ended. |
| `4 req` | API requests made since your last prompt, subagents included. |
| `out 3.4k (1.2k think)` | Output tokens, and how many of them were thinking. |
| `cache w6.5k r1.69M` | Prompt-cache writes and reads. |
| `ctx 43% ▓▓░░░ 427k` | The context the last request carried, as a share of the window and as a bar. |

**Requests.** One request is one model call, so each tool round trip counts as one request. With `--latest`, the count leaves out the request that writes the final reply, because that request is still running. As a Stop hook, the count includes every request.

**Thinking.** Thinking tokens are part of the output figure. They are not added to it.

**Cache.** Cache writes (`w`) are new content stored for reuse, and they cost a little more than plain input. Cache reads (`r`) come to about the number of requests × the context size, so they can reach millions. Reads are cheap, so a large `r` is normal.

**Fresh input.** Uncached input counts toward `ctx` but is not shown on its own, because it is usually tiny.

**Context.** The `ctx` figure should match the status line's context percentage, when the token line uses the right window size (see [Token line options](#token-line-options)).

## Requirements

- Claude Code
- Node.js 18 or later

## Install

### With Claude Code

Paste this into a Claude Code session:

```text
Install claude-gauge: clone https://github.com/jv-k/claude-gauge to ~/.claude/claude-gauge, then follow INSTALL-WITH-CLAUDE.md in it.
```

Claude asks which bars and parts you want, checks that they run, backs up your settings and merges the new entries into them. If you also use the VS Code extension or the desktop app, it adds the hooks that paste the bars into its replies there. To update later, ask the same again.

### By hand

Clone the repo into your Claude Code folder:

```sh
git clone https://github.com/jv-k/claude-gauge.git ~/.claude/claude-gauge
```

Then add one or both bars to `~/.claude/settings.json`. If the file already has a `hooks` block, add the `Stop` entry to it rather than replacing it.

**Status line:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/claude-gauge/dist/statusline.js"
  }
}
```

**Token line**, as a hook that runs when each turn ends:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node ~/.claude/claude-gauge/dist/tokenline.js" }
        ]
      }
    ]
  }
}
```

Start a new Claude Code session to pick up the changes.

To install without git, download the two built files instead:

```sh
mkdir -p ~/.claude/claude-gauge/dist
curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/dist/statusline.js -o ~/.claude/claude-gauge/dist/statusline.js
curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/dist/tokenline.js -o ~/.claude/claude-gauge/dist/tokenline.js
```

### In VS Code and the desktop app

Claude Code runs a custom status line and shows Stop hook messages only in the terminal CLI. At the time of writing, the VS Code extension and the desktop app show neither. You can still see both bars there in two ways:

- **Run `claude` in VS Code's integrated terminal.** That is the terminal CLI, so both bars show as usual.
- **Have Claude paste the bars into its replies.** A SessionStart hook asks it to, in those two hosts only.

For the second way, keep the settings entries above and add one hook per bar you want in the replies:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "node ~/.claude/claude-gauge/dist/statusline.js --instruct" } ] },
    { "hooks": [ { "type": "command", "command": "node ~/.claude/claude-gauge/dist/tokenline.js --instruct" } ] }
  ]
}
```

`--instruct` reads the host from the `CLAUDE_CODE_ENTRYPOINT` variable, which Claude Code sets and its hooks inherit. In the VS Code extension (`claude-vscode`) and the desktop app (`claude-desktop`, `claude-desktop-3p`) it prints an instruction into Claude's context: end every reply with the output of the same command with `--latest` in place of `--instruct`, run as the last tool call of the turn and pasted verbatim in one code block, never guessed and never reused from an earlier turn. In the terminal CLI (`cli`) it prints nothing. One settings file therefore serves every host, and the terminal, which shows the bars already, stays as it is. Any other or missing value also prints nothing: the variable is not documented, so a host under a new name gets a quiet session rather than a wrong one. `echo $CLAUDE_CODE_ENTRYPOINT` in Claude's shell shows the value.

The hook runs when a session starts, resumes, is cleared with `/clear`, or compacts, so the instruction survives all four. The reply in the VS Code panel then ends like this:

```text
ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
11:10 │ 1h12m │ jv-k/claude-gauge │ ⎇ main │ Opus 5.5 │ effort high
12:10 │ 4 req │ out 3.4k (1.2k think) │ cache w6.5k r1.69M │ ctx 43% ▓▓░░░ 427k
```

Each hook takes its bar's usual switches, such as `--show` and `--segments`, and passes them on to the command it names. On a 1M-context model, add `--window 1m` to both, for the reason in [Token line options](#token-line-options). Each reply costs one or two short tool calls more.

`--latest` finds the calling session by the `CLAUDE_CODE_SESSION_ID` variable, which Claude Code sets for the commands it runs. Without that variable, it takes the newest transcript of the current folder. It prints no colours, because a reply shows colour codes as junk.

**What the status line can rebuild.** A transcript holds less than the input Claude Code sends a status line, so with `--latest`:

- `ctx`, `model` and `effort` come from the session's last response. `duration` counts from the first entry in the transcript.
- `time`, `dir`, `repo`, `branch` and `worktree` come from the clock and from git, as in the terminal.
- `5h` and `7d` come from the last time the status line ran in a terminal, in any session. Claude Code sends usage figures only to a status line, so each terminal render saves them in `~/.claude/claude-gauge/.state/usage.json`. The figures are as recent as that render. Until a terminal render saves them, and after a window resets, the part shows `~`.
- The other parts, such as `cost`, `lines`, `pr` and `cache`, have nothing to report, and stay out of their row.

## Options

Both scripts take switches on the command line, so you set them in the `command` of your settings and never edit the scripts. A switch takes its value after a space or an `=`: `--show 5h,7d` and `--show=5h,7d` are the same.

### Status line options

| Switch | Effect |
| --- | --- |
| `--show <parts>` | One row: the parts to show, in the order given, separated by commas. Parts: those in [Status line](#status-line) and [More status line parts](#more-status-line-parts). Repeat `--show` for more rows. Default: two rows, `ctx,5h,7d` and `time,duration,repo,branch,model,effort`. |
| `--segments <5\|10>` | Cells per bar. Default: 5. Any other value gives 5. |
| `--no-labels` | Drops the labels in front of values, such as `ctx`, `5h`, `7d` and `effort`. |
| `--no-bars` | Drops the bars, and with them the pace markers. |
| `--no-pace` | Drops the pace markers. |
| `--no-reset` | Drops the reset times. |
| `--12h` | Shows the `time` part and reset times on the 12-hour clock. Default: 24-hour. |
| `--compact` | Fits narrow terminals: `│` between parts with no spaces round it, and shorter labels: `c` for `ctx`, `eff` for `effort`, `sty` for `style`, `agt` for `agent`, `cch` for `cache` and `spd` for `spend`. The other labels are short already. |
| `--right <parts>` | The parts to right-align, separated by commas. In each row that shows any of them, they move to the end of the row, in the row's order, and spaces fill the gap so the row ends at the terminal's right edge. Claude Code gives the terminal width in `COLUMNS`. When the width is unknown, as with `--latest`, the row is too long to leave a gap, or the row holds characters whose width varies by terminal, such as CJK text and emoji, the row is left as it is. Repeat `--right` to name more parts. |
| `--latest` | Prints the rows for the calling session from its transcript, as plain text, instead of reading Claude Code's input. See [In VS Code and the desktop app](#in-vs-code-and-the-desktop-app). |
| `--window <size>` | With `--latest`: the context window size, for example `200k` or `1m`, as for the token line. |
| `--instruct` | As a SessionStart hook: in the VS Code extension and the desktop app, prints an instruction that has Claude end each reply with the `--latest` rows; in the terminal CLI, prints nothing. The other switches pass through to the command it names. See [In VS Code and the desktop app](#in-vs-code-and-the-desktop-app). |

A row with nothing to show is left out, and a `--show` that names no known part adds no row.

#### Examples

Put the switches after the script in the `command` of your settings, for example `"command": "node ~/.claude/claude-gauge/dist/statusline.js --show 5h,7d"`.

Only your usage, on one row:

```text
--show 5h,7d

5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
```

Usage and context in 10-cell bars, without pace markers:

```text
--show ctx,5h,7d --segments 10 --no-pace

ctx 43% ▓▓▓▓░░░░░░ 86.0k │ 5h 9% ▓░░░░░░░░░ → 14:10 │ 7d 41% ▓▓▓▓░░░░░░ → 3d
```

As short as it gets: no labels, no bars, the 12-hour clock:

```text
--show ctx,5h,7d,model --no-labels --no-bars --12h

43% 86.0k │ 9% → 02:10 pm │ 41% → 3d │ Opus 5.5
```

Narrow terminals, with `--compact`:

```text
--show ctx,5h,7d --show repo,branch,model,effort --compact

c 43% ▓▓░░░ 86.0k│5h 9% ░░┃░░ → 14:10│7d 41% ▓▓░┃░ → 3d
jv-k/claude-gauge│⎇ main│Opus 5.5│eff high
```

The model and effort at the right edge of a 72-column terminal, with `--right`:

```text
--show ctx,5h,7d --show repo,branch,model,effort --right model,effort

ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
jv-k/claude-gauge │ ⎇ main                        Opus 5.5 │ effort high
```

Three rows for pull-request work:

```text
--show ctx,5h,7d --show repo,branch,pr,lines --show model,effort,cost,cache

ctx 43% ▓▓░░░ 86.0k │ 5h 9% ░░┃░░ → 14:10 │ 7d 41% ▓▓░┃░ → 3d
jv-k/claude-gauge │ ⎇ main │ #12 approved │ +156 −23
Opus 5.5 │ effort high │ $1.23 │ cache 91% warm
```

#### Keeping time-based parts fresh

Claude Code reruns a status line when something happens in the session, such as a new message. While a session sits idle, `duration` and the cache's warm or cold state can fall behind. To rerun the status line on a timer as well, add `refreshInterval`, in seconds, next to the command:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/claude-gauge/dist/statusline.js",
  "refreshInterval": 60
}
```

### Token line options

| Switch | Effect |
| --- | --- |
| `--show <parts>` | The parts to show, in the order given, separated by commas. Parts: `time`, `req`, `out`, `cache`, `ctx`. Default: all of them, in that order. |
| `--segments <5\|10>` | Cells in the context bar. Default: 5. Any other value gives 5. |
| `--window <size>` | The context window size, for example `200k` or `1m`. |
| `--latest` | Prints the line for the calling session, instead of reading a hook payload. See [In VS Code and the desktop app](#in-vs-code-and-the-desktop-app). |
| `--instruct` | As a SessionStart hook: in the VS Code extension and the desktop app, prints an instruction that has Claude end each reply with the `--latest` line; in the terminal CLI, prints nothing. The other switches pass through to the command it names. See [In VS Code and the desktop app](#in-vs-code-and-the-desktop-app). |

The transcript does not record the context window size, so without `--window` the token line assumes Claude Code's default of 200k, and 1M once the context grows past 200k. If you use a 1M-context model, say so, and the percentage is right from the start:

```json
"command": "node ~/.claude/claude-gauge/dist/tokenline.js --window 1m"
```

Unknown switches and part names are ignored, so a typo never breaks your status line or your turn. If `--show` names no known part, the line shows every part.

## Update

```sh
git -C ~/.claude/claude-gauge pull
```

If your settings still name `~/.claude/claude-gauge/statusline.js` or `tokenline.js` from before the scripts moved into `dist/`, change each `command` to the `dist/` path shown in [By hand](#by-hand).

## Uninstall

Remove the `statusLine`, `Stop` and `SessionStart` entries that name claude-gauge from `~/.claude/settings.json`. Then delete the folder:

```sh
rm -rf ~/.claude/claude-gauge
```

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the rules for a change, and the branch and commit conventions.

```sh
pnpm install
pnpm test
```

Both lines are TypeScript modules in `src/`, built by `pnpm build` to the two self-contained Node.js files in `dist/` that the settings entries above run. `pnpm test` builds first, then runs the suites against the build with Node's built-in test runner; `pnpm typecheck` checks the sources without building. `dist/` is generated, so never edit it or commit it. After each merge to `main`, the `dist` workflow builds and tests `dist/`, and commits it to `main` as a bot commit marked `[auto]` when the build changed it. A clone of `main` works without a build. [CONTRIBUTING.md](CONTRIBUTING.md) says how to keep `dist/` out of a pull request. [Bun](https://bun.sh) runs the sources directly, with the same output as the build: `bun src/statusline.ts`.

To try the status line by hand, pipe it a sample of the JSON that Claude Code sends:

```sh
echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'"$PWD"'"},"context_window":{"used_percentage":25}}' | node dist/statusline.js
```

The full input format is in the [status line docs](https://code.claude.com/docs/en/statusline).

### Releases

Releases use [VerBump](https://github.com/jv-k/VerBump), and the tests must pass first. VerBump tags the version, and the `release` workflow then creates the GitHub release from the changelog and publishes the package to npm with provenance. [RELEASING.md](RELEASING.md) gives the steps.

## License

[MIT](LICENSE)
