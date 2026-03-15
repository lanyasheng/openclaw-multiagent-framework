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
6. **Adaptive relay frequency** to avoid message flooding during long tasks

## Architecture (v3.4.0)

```
Hooks:
  before_tool_call       → inject streamTo + taskId
  after_tool_call        → link ACP session + streamLogPath
  subagent_spawning/spawned → Discord context enrichment
  subagent_ended         → L1 completion detection
  before_prompt_build    → completion report injection

Background:
  Progress relay (15s tick, adaptive rate)
    - <2min: every tick (15s)
    - 2-10min: every 60s
    - >10min: every 5min
  ACP session poller (15s)
  Stale reaper (5min)
  ACPX zombie cleanup

Progress reading:
  Incremental (for relay):
    L1: acp-stream.jsonl (filters "Started ..." and "no output" messages)
    L2: child transcript .jsonl (fallback for Issue #45205)
  Full (for completion):
    Reads entire transcript without offset tracking (idempotent)
```

## Key Design Decisions

### Why two read modes? (readProgressFull vs readProgressIncremental)

The incremental reader tracks file offsets to avoid re-sending already-relayed content.
But completion notifications need the *full* task output regardless of what was already relayed.
v3.3.0 used a single `readProgress` for both paths — this caused completion reports to be empty
when relay had already consumed the offset. v3.4.0 splits them into separate functions.

### Why filter "Started ..." from relay?

OpenClaw's `parentStreamRelay` emits a synthetic `system_event` ("Started claude session ...")
as the first message. This is not useful progress — relaying it just sends noise to Discord.
Due to Issue #45205, no `assistant_delta` events follow in the stream log, so the stream log
is effectively useless for progress. The transcript fallback (L2) provides real assistant output.

### Why adaptive relay frequency?

Fixed 15s relay works well for short tasks (<2min), but long-running tasks (10-60min) would
flood Discord with dozens of progress messages. The adaptive strategy throttles relay frequency
based on task age, keeping early visibility while reducing noise for long tasks.

## Version History

- **v3.4.0**: Split readProgress into full (completion) vs incremental (relay). Adaptive relay
  frequency. Filter "Started ..." messages from relay. Debug logging for relay diagnostics.
- **v3.3.0**: Full completion reports; all completion paths read transcript before delete.
- **v3.2.0**: Transcript fallback for Issue #45205.
- **v3.1.0**: Restored progress polling with `readProgressFromStreamLog`.
- **v3.0.0**: Simplified; introduced `streamTo: "parent"` injection.

## Testing

```bash
node test.js
# 42 tests covering all core functions and E2E scenarios
```

## Installation

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/

# Add to openclaw.json
{
  "plugins": {
    "allow": ["spawn-interceptor"],
    "entries": {
      "spawn-interceptor": { "enabled": true }
    }
  }
}
```

## Limitations

- ACP completion depends on poller/reaper/transcript fallback (native relay unreliable due to #45205)
- Transcript file must exist on same host (local deployment only)
- Progress relay adds 15s latency compared to real-time streaming

## Related

- [COMMUNICATION_ISSUES.md](../../COMMUNICATION_ISSUES.md) — Full problem analysis
- OpenClaw Issue #45205 — ACP onAgentEvent cross-process bug
- OpenClaw Issue #5943 — before_tool_call wiring
- OpenClaw PR #45739 — Proposed gateway fallback (chat.history + agent.wait)
