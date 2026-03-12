# OpenClaw Multi-Agent Collaboration Framework

> A battle-tested multi-agent collaboration protocol and architecture for OpenClaw. Solves unreliable ACP communication, agent task-registration amnesia, and ambiguous timeout semantics with a zero-config plugin system.

[中文版 (Chinese README)](README_CN.md)

**Version**: 2026-03-13-v8 | **License**: MIT | **Status**: Production Ready

---

## The Problem

When running multiple AI agents in OpenClaw, you quickly hit fundamental limitations:

### 1. No Completion Notification

You call `sessions_spawn` to start a sub-agent via ACP. It runs in the background. Then... nothing. OpenClaw never tells you when it finishes. No callback, no webhook, no event, no notification.

**Root cause**: OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272) — the `notifyChannel` parameter in ACP is accepted but silently ignored.

### 2. Agent Registration Amnesia

You meticulously write documentation: "Before calling `sessions_spawn`, always register the task with the monitoring system." The LLM reads it. Understands it. Then calls `sessions_spawn` directly anyway, skipping registration. Every. Single. Time.

LLMs have muscle memory — they default to native tool calls and skip wrapper functions. Documentation-based constraints don't work for mandatory behaviors.

### 3. Zombie Sessions

Completed ACP sessions don't get properly cleaned up by the OpenClaw Gateway (Bug [#34054](https://github.com/openclaw/openclaw/issues/34054)). These zombie sessions accumulate silently until they hit the `maxConcurrentSessions` limit (default: 6), at which point all new ACP tasks fail with a cryptic "max sessions exceeded" error — even though the agent swears everything is closed.

### 4. Timeout Ambiguity

`sessions_send` returns "timeout". But what does that mean?
- The task failed? → Maybe
- The task is still running? → Maybe
- The message was never delivered? → Also maybe
- The task completed but the response was too slow? → Possible

You simply cannot tell. There's no follow-up mechanism, no status query, no retry protocol.

### 5. No Audit Trail

After a day of multi-agent orchestration, you ask: "What tasks were spawned today? Which completed? Which failed? How long did they take?" The answer: scroll through 50KB of chat history and try to piece it together manually.

---

## The Solution

**Core insight**: If a behavior is mandatory, it should be a system constraint — not a documentation constraint.

Instead of teaching agents to remember extra steps (which always fails), we intercept at the system level using OpenClaw's plugin hooks (which always works).

### spawn-interceptor Plugin (v2.4)

A single OpenClaw plugin (~250 lines of JavaScript) that:

1. **Automatically intercepts** every `sessions_spawn` call via the `before_tool_call` hook
2. **Logs the task** to `task-log.jsonl` with status `spawning`
3. **Detects completion** through a 3-layer defense system
4. **Updates the log** when the task completes, fails, or times out

Zero configuration. Zero agent-side changes. Agents don't even know it exists.

### Architecture

```
Agent calls sessions_spawn()
         │
         ▼
┌─────────────────────────────────────────────────┐
│             spawn-interceptor v2.4              │
│          (OpenClaw Plugin, ~250 lines)          │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─ before_tool_call hook ──────────────────┐   │
│  │  • Detect sessions_spawn calls           │   │
│  │  • Extract task metadata (agent, runtime) │   │
│  │  • Log to task-log.jsonl (spawning)      │   │
│  │  • Store in pendingTasks Map             │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─ Completion Detection (3 layers) ────────┐   │
│  │                                          │   │
│  │  L1: subagent_ended hook         (<1s)   │   │
│  │      OpenClaw fires this event when a    │   │
│  │      subagent finishes. BUT: it does     │   │
│  │      NOT fire for ACP runtime sessions.  │   │
│  │      Covers: runtime=subagent only.      │   │
│  │                                          │   │
│  │  L2: ACP Session Poller          (~15s)  │   │
│  │      Polls ~/.acpx/sessions/index.json   │   │
│  │      every 15 seconds. When a session    │   │
│  │      has closed:true, matches it to a    │   │
│  │      pending task by creation timestamp  │   │
│  │      (±60s window).                      │   │
│  │      Covers: runtime=acp.               │   │
│  │                                          │   │
│  │  L3: Stale Reaper                (30min) │   │
│  │      Safety net. Any task pending for    │   │
│  │      >30 minutes is marked as timeout.   │   │
│  │      Covers: all runtimes.              │   │
│  │                                          │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  → Update task-log.jsonl (completed/failed)     │
│  → Persist pendingTasks to .pending-tasks.json  │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│              task-log.jsonl                     │
│    (Single source of truth for ALL events)      │
├─────────────────────────────────────────────────┤
│ Writers:                                        │
│   • spawn-interceptor (internal ACP/subagent)   │
│   • task-callback-bus WatcherBus (external)      │
│                                                 │
│ Consumers:                                      │
│   • completion-listener (alerts/notifications)  │
│   • discord_task_panel.py (status dashboard)    │
│   • Any JSONL reader                            │
└─────────────────────────────────────────────────┘
```

### External Task Monitoring

For tasks that run outside of OpenClaw (browser automation, social media monitoring, cron jobs), a separate Python component handles monitoring:

```
┌───────────────┐     ┌──────────────────────────────┐
│ External      │     │  task-callback-bus v1.1.0     │
│ Systems       │◄──► │  WatcherBus (2,543 lines)     │
│ ─────────     │     │                              │
│ • XHS posts   │     │  Adapters:                   │
│ • GitHub PRs  │     │  • XiaohongshuNoteReview     │
│ • Cron jobs   │     │  • GitHubPRStatus            │
│ • ACP status  │     │  • CronJobCompletion         │
│               │     │  • AcpSessionCompletion      │
└───────────────┘     │  • CodingAgentRunStatus      │
                      │                              │
                      │  Notifiers:                  │
                      │  • Discord, Telegram, Session │
                      │                              │
                      │  Guardrails (v1.1.0):        │
                      │  • DLQ (Dead Letter Queue)   │
                      │  • Terminal Bridge           │
                      │  • Agent Comm Guardrail      │
                      │    (dedup/identity/channel)  │
                      └──────────────────────────────┘
```

### Why 3 Layers?

We discovered the hard way that **OpenClaw's `subagent_ended` hook does NOT fire for ACP runtime sessions**. This is an undocumented limitation. ACP sessions are managed by the `acpx` binary, and their lifecycle is tracked in `~/.acpx/sessions/` — completely separate from OpenClaw's hook system.

Our completion detection went through 3 iterations before landing on the current design:

| Attempt | Approach | Result |
|---------|----------|--------|
| v2.1 | Prompt injection (tell ACP agent to send completion message) | Failed. Oneshot ACP agents ignore injected instructions after completing their primary task. |
| v2.2 | Rely on `subagent_ended` hook as primary | Failed. Hook doesn't fire for `runtime=acp`. All ACP tasks stuck at `spawning` forever. |
| v2.3 | ACP Session Poller + `subagent_ended` + Stale Reaper | Works. Layered defense covers all runtimes with graceful degradation. |

---

## Quick Start

### Prerequisites

- OpenClaw >= 2026.3.x (requires `before_tool_call` plugin hook support)
- Python 3.10+ (for completion-listener and task-callback-bus)
- At least 1 agent configured

### 1. Install the plugin

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/extensions/
```

### 2. Restart the Gateway

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Linux
systemctl --user restart openclaw-gateway
```

### 3. Verify

```bash
# Trigger an ACP task, then check the log:
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```

You should see entries like:

```json
{
  "taskId": "tsk_20260313_abc123",
  "agentId": "main",
  "runtime": "acp",
  "status": "spawning",
  "spawnedAt": "2026-03-13T01:30:00.000Z"
}
```

And ~15 seconds after the ACP task completes:

```json
{
  "taskId": "tsk_20260313_abc123",
  "status": "completed",
  "completionSource": "acp_session_poller",
  "completedAt": "2026-03-13T01:32:15.000Z"
}
```

### 4. (Optional) Set up completion-listener

```bash
# Add to crontab for periodic checks
echo "*/1 * * * * cd /path/to/examples/completion-relay && python3 completion_listener.py --once >> /tmp/completion.log 2>&1" | crontab -

# Or run continuously
python3 examples/completion-relay/completion_listener.py --loop --interval 30
```

See [QUICKSTART.md](QUICKSTART.md) for the full deployment guide.

---

## Known OpenClaw Bugs

This framework exists partly because of these unresolved bugs in OpenClaw:

| Issue | Description | Impact | Our Workaround |
|-------|------------|--------|---------------|
| [#34054](https://github.com/openclaw/openclaw/issues/34054) | Gateway doesn't call `runtime.close()` for completed oneshot sessions | Zombie sessions hit `maxConcurrentSessions` limit | Daily GC in Guardian script |
| [#35886](https://github.com/openclaw/openclaw/issues/35886) | ACP child processes not cleaned after TTL | Zombie process accumulation | Guardian health-check auto-restart |
| [#40272](https://github.com/openclaw/openclaw/issues/40272) | `notifyChannel` doesn't work in ACP | No native completion notification | spawn-interceptor plugin |
| (undocumented) | `subagent_ended` hook doesn't fire for ACP runtime | ACP task status stuck at `spawning` | v2.4 ACP Session Poller |

---

## Documentation

| Document | Purpose |
|----------|---------|
| [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) | Problem analysis & design rationale (start here after README) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture deep-dive with data flow diagrams |
| [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | Full collaboration protocol specification |
| [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md) | L1 (OpenClaw native) / L2 (framework) / L3 (needs core changes) |
| [QUICKSTART.md](QUICKSTART.md) | Detailed deployment guide |
| [GETTING_STARTED.md](GETTING_STARTED.md) | Onboarding for new users |
| [ANTIPATTERNS.md](ANTIPATTERNS.md) | Pitfalls and lessons learned |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Version history |

---

## Repository Structure

```
├── plugins/
│   └── spawn-interceptor/        # OpenClaw plugin (~250 lines)
│       ├── index.js              # v2.4: hooks + ACP poller + stale reaper
│       ├── package.json          # Plugin metadata
│       └── openclaw.plugin.json  # OpenClaw plugin manifest
├── examples/
│   ├── completion-relay/         # Completion notification listener
│   │   ├── completion_listener.py
│   │   └── tests/
│   ├── l2_capabilities.py        # L2 capability implementations
│   └── protocol_messages.py      # Protocol message format demo
├── COMMUNICATION_ISSUES.md       # Core design document
├── ARCHITECTURE.md               # Architecture deep-dive
├── AGENT_PROTOCOL.md             # Collaboration protocol
├── RELEASE_NOTES.md              # Version history
└── README_CN.md                  # Chinese README
```

---

## Design Principles

| Principle | Old Way | Our Way |
|-----------|---------|---------|
| Task registration | Agent must remember wrapper function | Plugin hook auto-intercepts |
| Completion detection | Prompt injection (ignored by ACP agents) | File-based session polling |
| State management | In-memory only (lost on restart) | Persistent to JSONL + pending file |
| Monitoring | Separate files per component | Unified task-log.jsonl |
| Error handling | Silent failures | DLQ + Stale Reaper + health checks |

---

## Contributing

PRs and Issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License
