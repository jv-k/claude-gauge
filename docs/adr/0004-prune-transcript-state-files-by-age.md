# Transcript state files no render has touched for 30 days are pruned, at most once a day

- Status: accepted
- Date: 2026-10-11
- Issue: #51

## Context

The transcript reader keeps one small JSON state file per transcript in `.state/transcripts/` under `$CLAUDE_CONFIG_DIR/claude-gauge/`. Since [ADR 0005, the agents part reads subagent transcripts](0005-agents-part-reads-subagent-transcripts.md), it also keeps one per running subagent's own transcript. Nothing removed them, so the folder gained a file for every session and every subagent, for ever.

## Decision

The owner chose on 2026-10-11 to prune by age:

- After a render prints, it removes every state file in that folder, session and subagent alike, whose last change time is 30 days or more ago.
- The prune runs at most once a day. A stamp file, `transcripts.pruned` in the state folder beside `transcripts/`, holds the time of the last prune as its last change time. It stays out of `transcripts/`, so that folder holds the reader's state files alone. When the stamp is less than a day old, the render does nothing more than one `stat` of it. When the stamp is missing, or a day old or more, the render prunes and then touches the stamp, even when `transcripts/` does not exist yet. A stamp dated in the future, after the clock was put back, counts as old.
- A render that uses a state file updates its last change time, even when its transcript gained nothing and the state is not written. So the state of a session that is still shown is never pruned. A state file's last change time is the file system's, from the wall clock, which is also what a write sets, so the touch uses the wall clock as well.
- The two limits are `STATE_KEEP_MS` and `PRUNE_EVERY_MS` in `src/statusline.ts`. The prune reads the render clock (`nowMs`), so tests set it.
- Only files named as the reader names them, the SHA-1 of a transcript's path then `.json`, are removed. The prune never fails the render and never prints: a file another render removed first is skipped, and a folder that cannot be listed counts as empty.

## Options turned down

- **Prune by count**, keeping the newest N files. A machine with many short sessions would lose the state of a session it still shows, and a machine with few would keep files for years.
- **Prune when the transcript no longer exists.** That needs a `stat` of each transcript the state names, and Claude Code keeps transcripts for a long time, so the folder would still grow.

## Consequences

- A session resumed after 30 days or more with no render reads its transcript again from the start, once. The result is the same, so only that render is slower.
- One render a day lists the folder and stats each state file. Every other render pays one `stat`.
- The cost ledger, `usage.json` and the other files in `.state/` are not pruned by this rule. The ledger keeps its own 31 days.
