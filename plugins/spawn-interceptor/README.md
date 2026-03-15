# spawn-interceptor

> Zero-config OpenClaw plugin for ACP task lifecycle management. Tracks spawns, relays progress, detects completion, and notifies Discord — without any agent-side code changes.

## The Problem

OpenClaw's ACP (Agent Cloud Platform) has three fundamental gaps:

1. **No completion signal** — `sessions_spawn(runtime="acp")` returns immediately. When the child finishes, nothing happens. No callback, no event, no webhook.
2. **Broken event relay** — `parentStreamRelay` has a cross-process bug ([#45205](https://github.com/openclaw/openclaw/issues/45205)): ACP runs in a gateway subprocess, so `onAgentEvent` never crosses the process boundary. Only synthetic `start`/`stall` notices reach the parent.
3. **Zombie accumulation** — Dead sessions stay `closed: false` in `~/.acpx/sessions/index.json`, consuming `maxConcurrentSessions` slots until manual restart.

Result: agents dispatch tasks into a black hole with zero visibility.

## Architecture

```
┌─────────────────── spawn-interceptor v3.5.0 ───────────────────┐
│                                                                 │
│  HOOKS (system-level interception)                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ before_tool_call   → inject streamTo + taskId + relay    │   │
│  │ after_tool_call    → link ACP session + streamLogPath    │   │
│  │ subagent_spawning  → enrich with Discord context         │   │
│  │ subagent_spawned   → precise session key binding         │   │
│  │ subagent_ended     → L1 completion detection             │   │
│  │ before_prompt_build→ inject completion report            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  BACKGROUND WORKERS                                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Progress relay (15s tick, adaptive rate)                  │   │
│  │   <2min: every tick │ 2-10min: 60s │ >10min: 5min        │   │
│  │                                                          │   │
│  │ ACP session poller (15s) → L2 completion detection       │   │
│  │ Stale reaper (5min) → L3 timeout fallback                │   │
│  │ ACPX zombie cleanup → close dead sessions                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  PROGRESS READING (dual-mode)                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Incremental (relay):                                     │   │
│  │   L1: acp-stream.jsonl → filter noise → assistant_delta  │   │
│  │   L2: child .jsonl transcript → offset-tracked fallback  │   │
│  │   Heartbeat: stall detected → emit status message        │   │
│  │                                                          │   │
│  │ Full (completion):                                       │   │
│  │   Read entire transcript → no offset → idempotent        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  OUTPUT                                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ task-log.jsonl      → single source of truth             │   │
│  │ .pending-tasks.json → survives gateway restart           │   │
│  │ Discord messages    → start / progress / completion      │   │
│  │ Prompt injection    → inform parent agent                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### Why plugin hooks instead of wrapper functions?

Agents have "muscle memory" from training. They call `sessions_spawn` directly — a native OpenClaw tool trained millions of times. Wrapper functions like `spawn_with_tracking()` get skipped. Even `MUST`/`P0`/`NON-NEGOTIABLE` prompt directives fail. System-level `before_tool_call` hooks are invisible to the agent — **impossible to bypass**.

### Why two read modes?

v3.3 used one `readProgress` for both relay and completion. Relay consumed the file offset, then completion found nothing left to read — empty completion reports. v3.4+ splits into:

- **`readProgressIncremental`**: offset-tracked, avoids re-sending. Filters noise ("Started ...", "no output for 60s"). Used by periodic relay.
- **`readProgressFull`**: reads entire transcript from byte 0. Idempotent. Used by all completion paths.

### Why adaptive relay frequency?

Fixed 15s relay floods Discord during 30-minute tasks (120+ messages). Adaptive rate:

| Task age | Relay interval | Rationale |
|----------|---------------|-----------|
| < 2 min  | Every 15s tick | Maximum visibility for short tasks |
| 2–10 min | Every 60s | Reduce noise, still responsive |
| > 10 min | Every 5 min | Summary-level updates only |

### Why heartbeat messages?

Due to #45205, `acp-stream.jsonl` only contains `system_event` entries (start, stall). No `assistant_delta`. The transcript `.jsonl` only writes assistant messages at turn completion — not during tool execution. For single-turn tasks, there's zero intermediate output. When stream shows "no output for 60s" but transcript has nothing, we emit a heartbeat so users know the task is alive.

## Version History

| Version | Key Changes |
|---------|-------------|
| **v3.5.0** | Immediate start notification. Heartbeat on stall. |
| **v3.4.0** | Split full/incremental read. Adaptive relay. 42 unit tests. |
| **v3.3.0** | Full transcript in completion reports. Remove message truncation. |
| **v3.2.0** | Transcript fallback for #45205. |
| **v3.1.0** | Restore progress polling via acp-stream.jsonl. |
| **v3.0.0** | Simplify to `streamTo: "parent"` injection. |

## Testing

```bash
node test.js  # 42 tests, ~500ms
```

Covers: `readProgressFromStreamLog`, `readProgressFromTranscript`, `readProgressFull`, `readProgressIncremental`, `extractChildSessionKey`, `extractStreamLogPath`, `parseDiscordChannelFromSessionKey`, `resolveTranscriptPath`, `genId`, plus 5 end-to-end scenarios.

## Installation

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/
```

```json
{
  "plugins": {
    "allow": ["spawn-interceptor"],
    "entries": { "spawn-interceptor": { "enabled": true } }
  }
}
```

## Known Limitations

- **Single-turn ACP tasks**: No intermediate progress (transcript writes only at turn completion). Heartbeat messages provide liveness signal.
- **Same-host only**: File system polling requires all processes on one machine.
- **acpx dependency**: If `kill -9` bypasses acpx cleanup, poller can't detect completion.
- **No auto-retry**: Detects and reports failure, doesn't retry. Retry is orchestrator's responsibility.

## Related

- [COMMUNICATION_ISSUES.md](../../COMMUNICATION_ISSUES.md) — Problem analysis
- OpenClaw [#45205](https://github.com/openclaw/openclaw/issues/45205) — Cross-process event bug
- OpenClaw [#40272](https://github.com/openclaw/openclaw/issues/40272) — notifyChannel ignored
- OpenClaw [PR #46308](https://github.com/openclaw/openclaw/pull/46308) — ACP lifecycle registration
- OpenClaw [PR #46949](https://github.com/openclaw/openclaw/pull/46949) — Back-pressure eviction
