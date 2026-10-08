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

Both are single Node.js files with no dependencies, and both use the same parts: `│` between segments, short lowercase labels, and `▓░` bars. Switches choose what each line shows and how (see [Options](#options)). For example, `--show 5h,7d --segments 10` gives a status line with only your usage, in 10-cell bars:

```text
5h 9% ▓░░░┃░░░░░ → 14:10 │ 7d 41% ▓▓▓▓░░┃░░░ → 3d
```

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

Claude asks which bars and parts you want, checks that they run, backs up your settings and merges the new entries into them. To update later, ask the same again.

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
    "command": "node ~/.claude/claude-gauge/statusline.js"
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
          { "type": "command", "command": "node ~/.claude/claude-gauge/tokenline.js" }
        ]
      }
    ]
  }
}
```

Start a new Claude Code session to pick up the changes.

To install without git, download the two files instead:

```sh
mkdir -p ~/.claude/claude-gauge
curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/statusline.js -o ~/.claude/claude-gauge/statusline.js
curl -fsSL https://raw.githubusercontent.com/jv-k/claude-gauge/main/tokenline.js -o ~/.claude/claude-gauge/tokenline.js
```

### Where the bars appear

Claude Code shows a custom status line in the terminal CLI. At the time of writing, the VS Code extension and the desktop app do not show one. To get the status line in VS Code, run `claude` in its integrated terminal.

Where hook messages are not shown, Claude can paste the token line into its replies instead. Add this to `~/.claude/CLAUDE.md`:

```md
## Token usage

End every reply with the output of `node ~/.claude/claude-gauge/tokenline.js --latest`,
run as the last tool call of the turn, pasted verbatim as a code block.
```

`--latest` finds the calling session by the `CLAUDE_CODE_SESSION_ID` variable that Claude Code sets for the commands it runs.

The status line has the same mode. `node ~/.claude/claude-gauge/statusline.js --latest` rebuilds the rows for the calling session from its transcript, as plain text for pasting, and takes `--window` like the token line. The 5h and 7d figures come from the last time the status line ran in a terminal, which saves them; until then they show `~`. Add it to the CLAUDE.md instruction above, before the token line, to see both in the VS Code panel.

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

A row with nothing to show is left out, and a `--show` that names no known part adds no row.

#### Examples

Put the switches after the script in the `command` of your settings, for example `"command": "node ~/.claude/claude-gauge/statusline.js --show 5h,7d"`.

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
  "command": "node ~/.claude/claude-gauge/statusline.js",
  "refreshInterval": 60
}
```

### Token line options

| Switch | Effect |
| --- | --- |
| `--show <parts>` | The parts to show, in the order given, separated by commas. Parts: `time`, `req`, `out`, `cache`, `ctx`. Default: all of them, in that order. |
| `--segments <5\|10>` | Cells in the context bar. Default: 5. Any other value gives 5. |
| `--window <size>` | The context window size, for example `200k` or `1m`. |
| `--latest` | Prints the line for the calling session, instead of reading a hook payload. |

The transcript does not record the context window size, so without `--window` the token line assumes Claude Code's default of 200k, and 1M once the context grows past 200k. If you use a 1M-context model, say so, and the percentage is right from the start:

```json
"command": "node ~/.claude/claude-gauge/tokenline.js --window 1m"
```

Unknown switches and part names are ignored, so a typo never breaks your status line or your turn. If `--show` names no known part, the line shows every part.

## Update

```sh
git -C ~/.claude/claude-gauge pull
```

## Uninstall

Remove the `statusLine` and `Stop` entries from `~/.claude/settings.json`, then delete the folder:

```sh
rm -rf ~/.claude/claude-gauge
```

## Development

```sh
pnpm test
```

The tests use Node's built-in test runner. To try the status line by hand, pipe it a sample of the JSON that Claude Code sends:

```sh
echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'"$PWD"'"},"context_window":{"used_percentage":25}}' | node statusline.js
```

The full input format is in the [status line docs](https://code.claude.com/docs/en/statusline).

### Releases

Releases use [VerBump](https://github.com/jv-k/VerBump), which reads the Conventional Commits since the last tag, suggests the next version, updates `package.json` and `CHANGELOG.md`, tags, pushes, and publishes a GitHub release. The tests must pass first; `.verbumprc` runs them as a gate.

```sh
pnpm bump-release --dry-run   # preview the release, changes nothing
pnpm bump-release             # cut it
```

## License

[MIT](LICENSE)
