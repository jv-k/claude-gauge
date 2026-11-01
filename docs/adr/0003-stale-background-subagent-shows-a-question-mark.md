# A background subagent whose transcript is unchanged for 10 minutes shows as stale, with a dim `?`

- Status: accepted
- Date: 2026-10-11
- Issue: #60

## Context

A subagent in the background runs on after the Agent call that started it returns. Only its task notification in the session transcript ends it. When that notification never arrives, the agents part shows the subagent as running for ever. [ADR 0005, the agents part reads the transcript of each running subagent](0005-agents-part-reads-subagent-transcripts.md), gives the reader the last change time of each running subagent's own transcript, as a liveness signal for this issue.

## Decision

The owner chose on 2026-10-11:

- A running subagent shows a dim `?` in place of `◐` when it runs in the background, its own transcript was found, and that transcript last changed 10 minutes or more ago. The rest of the item stays as it is for a running subagent, elapsed time included.
- The 10 minutes is `AGENT_STALE_MS` in `src/statusline.ts`.
- The part reads the time from the render clock it already gets (`nowMs`), so tests set it.
- When the transcript changes again, the subagent shows `◐` again. When the notification arrives, it shows as finished, as before.
- A subagent in the foreground, and one whose own transcript is not found, show `◐` until they end, as before.
- Nothing is hidden. A stale subagent keeps its place among the three the part shows.

## Options turned down

- **Hide a stale subagent.** A subagent that is only slow would drop out of the part with no trace. The owner kept it in view.

## Consequences

- The reader's result now says which subagents run in the background (`background: true`), so the part can apply the rule.
- A subagent in the background that waits more than 10 minutes on a single long tool call, and so writes nothing to its transcript, shows `?` while it waits. It shows `◐` again at its next record.
- When Claude Code changes where it writes subagent transcripts, no transcript is found, and the part falls back to `◐`, as [that ADR](0005-agents-part-reads-subagent-transcripts.md) describes.
