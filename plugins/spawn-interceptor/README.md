# spawn-interceptor

OpenClaw plugin that automatically tracks task spawns and injects completion relay instructions into ACP prompts.

## Problem

When agents call `sessions_spawn(runtime="acp")`, they often forget to register the task with a watcher. This means:
- No one tracks whether the ACP task completed
- No completion notification is sent to the user
- Tasks fall into a "black hole"

## Solution

This plugin uses OpenClaw's `before_tool_call` hook to:

1. **Automatically log** every `sessions_spawn` call to `task-log.jsonl`
2. **Inject completion relay** instructions into ACP prompts, so the ACP sub-agent sends a `sessions_send` notification when done

No wrapper scripts. No manual registration. Zero cognitive load on the agent.

## Installation

```bash
# Copy to your OpenClaw plugins directory
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

## How It Works

```
Agent calls sessions_spawn(runtime="acp", task="Analyze code...")
    ↓
before_tool_call hook fires
    ↓
Plugin:
  1. Generates taskId
  2. Appends to task-log.jsonl
  3. Appends completion relay instructions to prompt
    ↓
ACP sub-agent receives augmented prompt
    ↓
ACP finishes work
    ↓
ACP calls sessions_send to completion-relay session (as instructed)
    ↓
completion-listener picks up the notification
    ↓
User gets notified
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
- ACP completion relay depends on the ACP agent following the injected instructions
- Does not replace dead-letter-queue or deduplication logic

> **Note (2026-03-14)**: With [PR #46308](https://github.com/openclaw/openclaw/pull/46308), ACP sessions are now registered in the subagent registry, so `subagent_ended` hooks fire for them. This makes the ACP Session Poller a fallback rather than the primary detection path for ACP completion.

## Related

- [COMMUNICATION_ISSUES.md](../../COMMUNICATION_ISSUES.md) — Full problem analysis
- [completion-relay example](../../examples/completion-relay/) — Completion listener
- OpenClaw Issue #40272 — ACP notifyChannel bug
- OpenClaw Issue #5943 — before_tool_call wiring
