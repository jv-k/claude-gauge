# The agents part reads the transcript of each running subagent

The agents part used to read only the session transcript. That transcript names no model for a subagent in the foreground until its result arrives, and it says nothing while the subagent works. So the agents part now also reads the transcript of each subagent that is still running. Claude Code writes it in `<session>/subagents/agent-<agentId>.jsonl`, and the `toolUseId` in `agent-<agentId>.meta.json` names the Agent call that started it. That transcript gives the subagent's model while it runs, and its last change time is a liveness signal for #60. The reader keeps a byte offset for each subagent transcript, as it does for the session transcript. It reads a subagent transcript while the subagent runs, and one last time in the first render after the subagent has finished. So each render reads only the new bytes of the subagents that are running or that have just finished.

## The todos part uses the same read (issue #148)

Claude Code writes a subagent's TaskCreate and TaskUpdate to the subagent's transcript, not to the session's. So the todos part needs those transcripts too. One read of each subagent transcript in a render serves both parts, with one byte offset: it gives the model and the last change time to the agents part, and the task calls that got a result to the todos part. The reader does this read when a row shows `agents` or `todos`.

The session's task calls and the subagents' apply in the order of the times of their results. Each task also keeps the time of the result that changed it last, and an older TaskUpdate does not change it. So the later change wins, also when the two transcripts are read in different renders.

A subagent can write records between the last render and its end, and its last task calls are among them. This is why the reader reads a subagent transcript one more time after the subagent has finished. At first the reader stopped at the end of the subagent, and that lost those records.

The byte offset of each subagent transcript is kept with the subagent in the state file of the session, not in a state file of its own as at first. The task list and the offsets that it was read up to are then saved in one write. With two files, a render that stopped between the two writes, or two renders at the same time, could move an offset past task calls that the saved list did not have, and no later render read them again. When the reader reads a session from the start, it reads the subagent transcripts from the start too.

## Consequences

- The reader depends on the layout of Claude Code's `subagents/` folder and on the `toolUseId` field of its meta files. When these change, the part falls back to what the session transcript shows.
- A subagent has no state file of its own. The state files that earlier versions wrote for subagents are not used, and the prune of issue #51 removes them after 30 days.
- The reader keeps at most 20 finished subagents. When it reads a long session from the start, older subagents drop out before their last read, so their task calls do not count. A later TaskList in the session transcript corrects the list.
