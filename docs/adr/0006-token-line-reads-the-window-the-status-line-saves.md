# The token line reads the context window size the status line saves

- Status: accepted
- Date: 2026-11-01

## Context

The token line runs as a Stop hook and reads the session transcript. Neither the hook input nor the transcript holds the context window size. The transcript names only the model, such as `claude-opus-5-5`, never a `[1m]` mark: the owner checked 875 local transcripts. So the token line used `--window` when set, and otherwise guessed 200k, or 1M once the context passed 200k. Setup asked "Context window?" to fill in `--window`, with a note that the token line cannot read it.

The status line gets the exact size at every render, in `context_window.context_window_size` of its payload.

## Decision

The owner chose to derive the size, and to drop the question:

- Each terminal render of the status line saves the size for its session in `.state/windows/` under `$CLAUDE_CONFIG_DIR/claude-gauge/`. The file is the SHA-1 of the session id, then `.json`, as the transcript reader names its state files, and it holds `{"context_window_size": <size>}`. A render that finds the same size there writes nothing, so most renders cost one small read. A changed size is written beside the file and renamed over it. A failed write never breaks the status line. `--latest` renders from a transcript, which holds no size, and saves none.
- The token line takes `--window` when set, then the size saved for its session, then the guess. As a Stop hook it names the session by `session_id` in its hook input, else by the transcript's file name. With `--latest` it names the session by the transcript it finds. A missing or unreadable file gives the guess, with no message. The token line holds its own copy of the file's name and folder, because the two scripts import nothing from each other.
- The prune of [ADR 0004](0004-prune-transcript-state-files-by-age.md) also runs on `windows/`, with its own stamp, `windows.pruned`. A render does not touch a window file it leaves unchanged. So a session that keeps one size for 30 days loses its file to the prune, and the next render saves it again.
- Setup no longer asks for the context window. `configure` keeps an installed `--window` as it is written. `--window` stays a documented switch.

## Options turned down

- **Read the window from the transcript.** The transcript does not hold it.
- **Keep the question.** It asks the user for a figure that Claude Code already gives the status line, and an answer goes stale when the user changes model.
- **One file for all sessions.** Two sessions that render at once would need a lock, as the cost ledger has. A file per session needs none.

## Consequences

- The token line's `ctx` matches the status line's from the first turn, and follows a change of model, wherever the status line renders in the terminal.
- Where the status line does not run, as in the VS Code extension and the desktop app, or when only the token line is set up, the token line still guesses. `--window` fixes it there.
- Each terminal render makes one more small read and, once a day, one more prune of a small folder. Each render pays one more `stat` for the second stamp.
