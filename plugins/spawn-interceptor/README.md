# spawn-interceptor

> Zero-config OpenClaw plugin for **multi-runtime** task lifecycle management. Tracks spawns across `subagent` and legacy `ACP` runtimes, detects completion/failure/stuck states, implements safety guards (idempotency, stale reaper), reconciles with `runs.json` and `tmux` sessions, actively wakes parent agents, and now bridges subagent terminal states into orchestrator-friendly `job-status/` artifacts — without any agent-side code changes.

## The Problem

OpenClaw's task dispatch has fundamental gaps (each discovered in production):

1. **No completion signal** — `sessions_spawn` returns immediately. When the child finishes, nothing happens. No callback, no event, no webhook.
2. **Broken event relay** — `parentStreamRelay` has a cross-process bug: ACP runs in a gateway subprocess, so `onAgentEvent` never crosses the process boundary.
3. **Zombie accumulation** — Dead sessions stay open, consuming `maxConcurrentSessions` slots.
4. **Timeout/duplicate execution** — Tasks time out prematurely (30min default was too short), get re-dispatched by parent agents, leading to the same task executing 10+ times.
5. **No stuck detection** — Tasks that hang silently (tmux session dies, subagent crashes) go unnoticed indefinitely.
6. **No idempotency** — Nothing prevents the same task from being spawned multiple times in quick succession.

Result: agents dispatch tasks into a black hole with zero visibility, duplicate execution, false timeout reports, and no automatic continuation.

## Architecture

```
┌─────────────── spawn-interceptor v3.10.0 ───────────────┐
│                                                          │
│  HOOKS (system-level interception)                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │ before_tool_call  → inject params + taskId         │  │
│  │                     + IDEMPOTENCY GUARD            │  │
│  │ after_tool_call   → link session + detect failure  │  │
│  │ subagent_spawned  → session key binding            │  │
│  │ subagent_ended    → L1 completion detection        │  │
│  │ before_prompt_build → inject completion report     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  SAFETY GUARDS                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Idempotency: block duplicate spawn (100-char hash) │  │
│  │ Stale Reaper: 60min timeout + runner liveness chk  │  │
│  │ Health Poller: 30-60min stuck detection + auto-warn │  │
│  │ GC: cap consumedSessionIds at 500                  │  │
│  │ Log Rotation: archive task-log.jsonl at 2MB        │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  MULTI-RUNTIME RECONCILIATION                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ subagent: ~/.openclaw/subagents/runs.json          │  │
│  │   → startedAt / endedAt / outcome / frozenResult   │  │
│  │ tmux: cc-* sessions via tmux list-sessions         │  │
│  │   → /tmp/cc-{label}-completion-report.json         │  │
│  │ ACP (legacy): status.json heartbeat check          │  │
│  │ reconcileSubagentRuns(): periodic sync             │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  POST-COMPLETION                                         │
│  ┌────────────────────────────────────────────────────┐  │
│  │ subagent.run(parentSessionKey) → wake parent       │  │
│  │ prompt injection → completion + status rules       │  │
│  │ job-status patch → batch-summary/decide bridge     │  │
│  │ Emoji: ✅ success │ ❌ fail │ ⏰ timeout │ ⚠️ stuck │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  PERSISTENCE                                             │
│  ┌────────────────────────────────────────────────────┐  │
│  │ task-log.jsonl       → append-only audit log       │  │
│  │ .pending-tasks.json  → survives gateway restart    │  │
│  │ subagent-task-registry.json → lifecycle tracking   │  │
│  │ job-status/{taskId}.json → orchestrator bridge     │  │
│  │ health-warnings.json → stuck task alerts           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Key Features (v3.10.0)

### Idempotency Guard
Before tracking a new spawn, checks if an identical task (first 100 chars) is already pending. If a match exists and hasn't timed out, the spawn is **blocked** with a `Duplicate task blocked` message. This prevents the #1 production issue: parent agents re-dispatching the same task due to perceived inactivity.

### Multi-Runtime Liveness Check
`isRunnerStillActive()` supports three runtimes:

| Runtime | Check Method | Stuck Criteria |
|---------|-------------|----------------|
| `subagent` | `runs.json` (startedAt/endedAt) | endedAt exists or no record |
| `subagent+tmux` | runs.json + `tmux list-sessions` + completion report | tmux session dead + no report file |
| ACP (legacy) | `status.json` heartbeat | No heartbeat for 10min |

### Health Check Poller
Runs every 10 minutes. For pending tasks aged 30-60 minutes with no progress:
1. Checks runtime-specific evidence (runs.json, tmux sessions)
2. Marks qualifying tasks as `possibly_stuck`
3. Writes warnings to `health-warnings.json`
4. **Auto-injects** `⚠️ possibly_stuck` into parent agent's prompt queue

### Stale Reaper
60-minute timeout (configurable). Before reaping:
1. Calls `isRunnerStillActive()` — if runner is alive, skip
2. Classifies timeout: `stale_no_signal` vs `stale_had_progress`
3. Injects `⏰ timeout` report with guidance: "do NOT auto-retry"

### Subagent Reconciliation
`reconcileSubagentRuns()` periodically syncs `pendingTasks` with `~/.openclaw/subagents/runs.json`:
- If `endedAt` exists → mark completed/failed
- If no runs.json entry after 30min → mark as `lost`
- Prevents zombie pending tasks from missed `subagent_ended` events

### Task Log Rotation
Auto-archives `task-log.jsonl` when it exceeds 2MB, checked hourly.

### Subagent → Orchestrator Runtime Bridge
For `runtime="subagent"`, the plugin now writes a companion state file at spawn time and updates it on terminal events:

- **Spawn hook**: `registerJobStatusTaskForSubagent()` creates `shared-context/job-status/{taskId}.json`
- **Terminal hook**: `subagent_ended` and `reconcileSubagentRuns()` call `markJobStatusTaskCompletedFromSubagent()`
- **Batch grouping**: `batch_id` is derived from explicit `batchId` or fallback `requesterSessionKey`
- **Post-terminal fan-out**: opportunistically runs `orchestrator/cli.py batch-summary <batch_id>` and `decide <batch_id>`

This bridge is intentionally **decision-only** in v1:

- it refreshes task state and batch-level artifacts
- it allows the orchestrator to materialize a `dispatch-plan` / next-step decision
- it **does not auto-spawn the next round** from the plugin
- retry / follow-up / dispatch execution remains the orchestrator or human owner's responsibility

## Design Decisions

### Why plugin hooks instead of wrapper functions?
Agents call `sessions_spawn` directly from training. Wrapper functions get skipped. System-level `before_tool_call` hooks are **invisible to the agent — impossible to bypass**.

### Why idempotency guard before tracking?
Earlier versions tracked the task first, then checked for duplicates. If blocked, the orphan entry remained in `pendingTasks` forever. Guard now runs **before** `appendLog` and `pendingTasks.set`.

### Why tmux awareness?
`subagent` tasks frequently launch `tmux` sessions (via `start-tmux-task.sh`) for long-running coding tasks. Without tmux checks, a subagent whose tmux session crashed would appear "still running" in `runs.json` indefinitely.

### Why auto-inject stuck warnings?
`before_prompt_build` is passive — only fires on new turns. Without active injection via `completedTasksSinceLastPrompt`, stuck tasks would go unnoticed until someone manually checks.

### Why only wake parent via explicit session IDs?
A requester session key like `agent:main:discord:channel:...` is **not** the same thing as an agent session id accepted by `openclaw agent --session-id`. The bridge now refuses to synthesize CLI wake commands unless the value is an explicit numeric/UUID session id, preventing accidental delivery to the wrong surface.

### Why decision-only instead of auto-dispatch?
The plugin can reliably observe lifecycle transitions, but it does **not** own workflow policy. Auto-spawning the next batch inside the hook would couple runtime observation with orchestration policy and make retries harder to reason about. v1 therefore stops at `batch-summary` + `decide`, leaving actual dispatch to the orchestrator.

### Why 60-minute stale timeout?
- 30min (v3.6): Too aggressive — complex coding tasks routinely take 40-50min. 11% false-positive timeout rate.
- 120min: Too long — genuinely stuck tasks waste resources.
- 60min: Balanced — covers 95% of legitimate tasks while catching real stalls.

## Version History

| Version | Key Changes |
|---------|-------------|
| **v3.10.0** | **Runtime bridge v1**: subagent lifecycle now patches `job-status/{taskId}.json`, derives `batch_id`, and opportunistically runs `batch-summary` + `decide`. **Exact subagent matching** via `spawnedSessionKey`/`targetSessionKey`. **Safe parent wake** only when CLI gets an explicit session id. **Still no auto-dispatch** from the plugin. |
| **v3.9.0** | **Multi-runtime**: subagent + tmux + ACP support. **Idempotency guard** (position fix). **Health check poller** with auto-inject. **Reconciliation** via runs.json. **GC** for session IDs. **Log rotation**. Dead code cleanup. Version unification. |
| **v3.8.0** | Stale timeout 30min→60min. Runner liveness check. Completion report includes childSessionKey. Timeout classification. |
| **v3.6.0** | Failure detection. Active parent wake via `subagent.run()`. Spawn error detection. |
| **v3.5.0** | Immediate start notification. Heartbeat on stall. Adaptive relay. |
| **v3.4.0** | Split full/incremental read. 42 unit tests. |
| **v3.3.0** | Full transcript in completion reports. |
| **v3.0.0** | Simplify to `streamTo: "parent"` injection. |

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `STALE_TIMEOUT_MS` | 60 min | Time before a task is considered timed out |
| `REAPER_INTERVAL_MS` | 5 min | How often stale reaper + reconciliation runs |
| `HEALTH_CHECK_INTERVAL_MS` | 10 min | How often health check poller runs |
| `LOG_ROTATION_CHECK_MS` | 1 hour | How often task-log size is checked |
| `MAX_LOG_SIZE_BYTES` | 2 MB | Threshold for log rotation |
| `MAX_CONSUMED_IDS` | 500 | Cap for consumedAcpSessionIds before GC |

## Installation

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/
# or symlink for development:
ln -s $(pwd)/plugins/spawn-interceptor ~/.openclaw/plugins/spawn-interceptor
```

## Persistence Files

| File | Location | Purpose |
|------|----------|---------|
| `task-log.jsonl` | `~/.openclaw/shared-context/monitor-tasks/` | Append-only audit log of all task events |
| `.pending-tasks.json` | Same directory | Active pending tasks, survives restart |
| `subagent-task-registry.json` | Same directory | Lifecycle + callback tracking for subagent tasks |
| `job-status/{taskId}.json` | `~/.openclaw/shared-context/job-status/` | Orchestrator-facing task state bridge for subagent tasks |
| `health-warnings.json` | Same directory | Current stuck task warnings |

## Known Limitations

- **Single-host only**: File system polling requires co-located processes
- **tmux label matching**: Only detects tmux tasks with explicit `--label` in task prompt
- **Decision-only bridge**: Plugin updates task state and batch artifacts, but does not auto-dispatch next tasks
- **No auto-retry**: Detects and reports failures/timeouts, does not retry. Retry is orchestrator's responsibility
- **ACP deprecated**: ACP runtime support retained for backward compatibility but not actively tested

## Related

- `subagent_execution_policy.js` — Defines subagent execution profiles, timeout, and output constraints
- `~/.openclaw/subagents/runs.json` — Authoritative state for subagent runtime tasks
- `start-tmux-task.sh` / `complete-tmux-task.sh` — tmux task lifecycle scripts
