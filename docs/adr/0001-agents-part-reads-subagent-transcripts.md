# The agents part reads each running subagent's own transcript

The agents part used to read only the session transcript. That transcript names no model for a subagent in the foreground until its result arrives, and it says nothing while the subagent works. So the agents part now also reads the own transcript of each subagent that is still running. Claude Code writes it in `<session>/subagents/agent-<agentId>.jsonl`, and the `toolUseId` in `agent-<agentId>.meta.json` names the Agent call that started it. That transcript gives the subagent's model while it runs, and its last change time is a liveness signal for #60. The reader keeps a byte offset for each subagent transcript, as it does for the session transcript, in state files beside the session's. It stops reading a subagent transcript once the subagent has finished, so each render reads only the new bytes of the subagents that are running.

## Consequences

- The reader depends on the layout of Claude Code's `subagents/` folder and on the `toolUseId` field of its meta files. When these change, the part falls back to what the session transcript shows.
- Each subagent leaves a state file of its own. Issue #51 prunes them.
