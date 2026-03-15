# spawn-interceptor

OpenClaw plugin that automatically tracks task spawns, injects `streamTo: "parent"`, and detects completion with transcript fallback and full Discord notifications.

## Problem

When agents call `sessions_spawn(runtime="acp")`, they often forget to register the task. This means:
- No one tracks whether the ACP task completed
- No completion notification is sent to the user
- Tasks fall into a "black hole"

## Solution

This plugin uses OpenClaw hooks to:

1. **Automatically log** every `sessions_spawn` call to `task-log.jsonl`
2. **Inject** `streamTo: "parent"` and `taskId` into ACP prompts (parentStreamRelay)
3. **Detect completion** via ACP session poller, stale reaper, and subagent_ended
4. **Fallback chain** for output: native acp-stream.jsonl → child transcript .jsonl
5. **Full completion reports** to Discord (no truncation)

## Architecture (v3.3.0)

```
Hooks:
  before_tool_call   → inject streamTo + taskId
  after_tool_call   → link ACP session
  subagent_spawning/spawned → Discord context
  subagent_ended    → L1 completion
  before_prompt_build → completion injection

Background:
  Progress relay (30s)   → readProgressFromStreamLog from .acp-stream.jsonl
  ACP session poller (15s)
  Stale reaper (5min)
  ACPX zombie cleanup

Fallback chain:
  native acp-stream.jsonl → child transcript .jsonl
  (OpenClaw Issue #45205: acp-stream often only has start/stall; transcript has full output)
```

## Version History

- **v3.0.0**: Simplified; removed manual stream file reading. Introduced `streamTo: "parent"` injection.
- **v3.1.0**: Restored progress polling; `readProgressFromStreamLog` from `.acp-stream.jsonl` via Discord.
- **v3.2.0**: Transcript fallback for Issue #45205 (ACP in gateway subprocess; onAgentEvent not cross-process).
- **v3.3.0**: Full completion reports; all completion paths read transcript before delete; no message length limit.

## Installation

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/

# Add to openclaw.json
{
  "plugins": {
    "allow": ["spawn-interceptor"],
    "entries": {
      "spawn-interceptor": {
        "enabled": true
      }
    }
  }
}
```

## Data Format

### task-log.jsonl

```json
{
  "taskId": "tsk_20260312_abc123",
  "agentId": "main",
  "runtime": "acp",
  "task": "Analyze code performance...",
  "spawnedAt": "2026-03-12T23:00:00.000Z",
  "status": "spawning",
  "completionReceived": false
}
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| Task log path | `~/.openclaw/shared-context/monitor-tasks/task-log.jsonl` | Where spawn events are logged |
| Completion session | `agent:main:completion-relay` | Session key for completion notifications |

## Limitations

- Requires `before_tool_call` to be wired in the tool execution pipeline (Issue #5943)
- ACP completion depends on poller/reaper/transcript fallback (native relay unreliable)
- Does not replace dead-letter-queue or deduplication logic

> **Note (2026-03-14)**: With [PR #46308](https://github.com/openclaw/openclaw/pull/46308), ACP sessions are now registered in the subagent registry, so `subagent_ended` hooks fire for them. This makes the ACP Session Poller a fallback rather than the primary detection path for ACP completion.

## Related

- [COMMUNICATION_ISSUES.md](../../COMMUNICATION_ISSUES.md) — Full problem analysis
- [completion-relay example](../../examples/completion-relay/) — Completion listener
- OpenClaw Issue #40272 — ACP notifyChannel bug
- OpenClaw Issue #45205 — ACP onAgentEvent cross-process
- OpenClaw Issue #5943 — before_tool_call wiring
