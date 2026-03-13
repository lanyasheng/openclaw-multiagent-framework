# 通信层设计与演化

> Version: 2026-03-13-v9
> Status: 已实施 (spawn-interceptor v2.4)
> 目标: 解决 OpenClaw 多 Agent 通信的三大痛点，用最小改动量实现可靠的异步通信

> **See also**:
> - [Positioning](README.md#positioning-why-this-approach-now) — our design philosophy
> - [Framework Comparison](README.md#what-we-borrowed-from-mainstream-frameworks) — comparison with AutoGen Core, LangGraph, CrewAI
> - [Completion Truth Matrix](COMPLETION_TRUTH_MATRIX.md) — runtime completion sources and fallbacks

---

## 文档结构

| Section | Purpose | For Whom |
|---------|---------|----------|
| [Current Recommended Architecture](#current-recommended-architecture) | 当前生产环境使用的四层完成检测链路 | **新读者从这里开始** |
| [Historical Problems & Evolution](#historical-problems--evolution) | 问题背景与方案演化历史 | 想了解"为什么这样设计" |
| [Deprecated Paths](#deprecated-paths) | 已废弃的旧方案及废弃原因 | 维护旧代码或迁移参考 |

---

## Current Recommended Architecture

当前生产环境使用的四层完成检测架构（v2.5）：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    COMPLETION DETECTION PIPELINE v2.5                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LAYER 1: Native Event Stream (OpenClaw)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  sessions_spawn(runtime="acp", streamTo="parent")                  │   │
│  │  • Receives progress, stall, resumed events                        │   │
│  │  • Real-time status updates via stream                             │   │
│  │  • Covers: runtime=acp with streamTo                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  LAYER 2: Registration Layer (spawn-interceptor)                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  before_tool_call hook intercepts sessions_spawn                    │   │
│  │  • Records task to task-log.jsonl (spawning)                       │   │
│  │  • Stores in pendingTasks Map                                       │   │
│  │  • NOT completion truth — only start registration                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  LAYER 3: Basic Completion (Poller + Reaper)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  L3a: ACP Session Poller (~15s)                                     │   │
│  │       Polls ~/.acpx/sessions/ for closed sessions                  │   │
│  │                                                                     │   │
│  │  L3b: Stale Reaper (30min safety net)                               │   │
│  │       Marks long-pending tasks as timeout                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  LAYER 4: Terminal-State Correction (content-aware-completer)              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Solves "Registered=False, Terminal=False" (Type 4 tasks)          │   │
│  │  • Tier 1: Requires BOTH session closed + content evidence         │   │
│  │  • Rejects historical files, empty files                           │   │
│  │  • Idempotent writes, UTC timezone safe                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│                    Unified: task-log.jsonl                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 核心组件（当前主线）

| Component | Layer | Purpose | Status |
|-----------|-------|---------|--------|
| `spawn-interceptor` plugin | L2 | Auto-intercept sessions_spawn, log to task-log | **Production** |
| ACP Session Poller | L3a | Poll `~/.acpx/sessions/` every ~15s | **Production** |
| Stale Reaper | L3b | 30min safety net for stuck tasks | **Production** |
| content-aware-completer | L4 | Content evidence validation | **Production** |
| completion-listener | - | Notification relay (optional) | **Production** |

### 关键澄清

| Misconception | Reality |
|--------------|---------|
| "Hook is completion truth" | Hook only registers task **START**. Completion needs Layer 3/4. |
| "Intermediate states from hook" | Intermediate states come from Layer 1 native event stream, not hook. |
| "Plugin auto-closes loop" | Plugin enables tracking. Content-aware completer validates completion. |

---

## Historical Problems & Evolution

### Phase 1: Initial Problems (Pre-2026-03)

在运行 8 个 Agent 的生产环境中（main/trading/ainews/macro/codex/claude/butler/content），我们遇到了三个核心通信问题：

#### Problem A: ACP Completion Notification Unreliable

```
Agent calls sessions_spawn(runtime="acp", task="分析报告")
→ ACP sub-agent executes for 30 minutes
→ Execution completes
→ ❌ No notification back to main agent or user
→ User: "Is it done?" → Agent: "Let me check..."
```

**Root cause**: OpenClaw's `notifyChannel` parameter is not forwarded in ACP runtime (Issue #40272).

#### Problem B: sessions_spawn Timeout Ambiguity

```
result = sessions_spawn(task="发帖", runTimeoutSeconds=120)
→ result.status = "timeout"

What does this mean?
  a) Task timed out and failed?
  b) Wait timed out but task still running?
  c) Delivered successfully but no result?
  d) Delivery failed?

Answer: Could be any. Cannot distinguish.
```

**Root cause**: OpenClaw's `sessions_send` / `sessions_spawn` only returns `ok` and `timeout` (Issue #28053).

#### Problem C: Agent Says Done But Actually Didn't

**Root cause**: LLM "muscle memory" points to L1 native tools (sessions_spawn), doesn't remember to use L2 wrapper scripts first. "Documentation constraint ≠ System constraint".

### Phase 2: Task-Callback-Bus Compensation (Deprecated)

To compensate for these issues, we built `task-callback-bus`:

| Component | Lines | Purpose |
|-----------|-------|---------|
| bus.py | 467 | Event bus core |
| stores.py | 431 | JSONL task storage |
| models.py | 263 | Data models |
| adapters.py | 1,127 | Multi-type task adapters |
| notifiers.py | 902 | Notification sending |
| completion_bus.py | 507 | Completion event bus |
| completion_consumer.py | 506 | Completion event consumer |
| terminal_bridge.py | 451 | Terminal→follow-up bridge |
| discord_panel_bridge.py | 488 | Discord panel bridge |
| dead_letter_queue.py | 271 | Dead letter queue |
| deduplicator.py | 100 | Deduplicator |
| agent_comm_guardrail.py | 383 | ACK guardrail |
| Others | ~2,700 | Various helpers |
| **Total** | **~2,543** | — |

**Problems**: High complexity, watcher reporting degraded, 0 actual notifications sent, all owners unknown.

### Phase 3: Plugin-Based Solution (Current v2.5)

**Core insight**: If a behavior is mandatory, it should be a system constraint — not a documentation constraint.

**Evolution timeline**:

| Version | Approach | Key Learning |
|---------|----------|--------------|
| v1.x | task-callback-bus | File polling is industry anti-pattern; too complex |
| v2.0 | acp-completion-relay (prompt injection) | ACP agents ignore callback instructions in prompt |
| v2.1 | subagent_ended hook | Hook doesn't fire for ACP runtime (OpenClaw bug) |
| v2.2 | sessions/index.json polling | Works but delay too high (5 min) |
| v2.3 | ACP session poller (~15s) | **Working solution** — poll `~/.acpx/sessions/` |
| v2.4 | spawn-interceptor + poller + reaper | **Current production** — four-layer pipeline |
| v2.5 | + content-aware-completer | **Latest** — content evidence validation |

### Design Philosophy Shift

```
Old approach: Agent obligated to register watcher (documentation constraint)
        → Agent forgets → patch Agent protocol → still forgets → add more code
        → Complexity spiral

New approach: System obligated to track tasks (infrastructure constraint)
        → Agent just spawns → hook auto-tracks → prompt auto-injects callback
        → Zero extra code, zero cognitive burden
```

> **Core principle**: If a behavior is mandatory, it shouldn't be optional.

---

## Deprecated Paths

### Deprecated: Task-Callback-Bus v1.x

**Status**: Deprecated, do not use for new code

**Why deprecated**:
- 2,543 lines of complexity
- File polling is industry anti-pattern
- Notification reliability issues
- Replaced by spawn-interceptor plugin (v2.4+)

**Migration path**:
```
Old: wrapper script → tasks.jsonl → cron(5min) → file scan → notifier
New: sessions_spawn → [hook auto-intercept] → ACP → sessions/index.json poller → task-log
```

### Deprecated: ACP Completion Relay (Prompt Injection) v2.0

**Status**: Deprecated approach

**Why deprecated**:
- ACP oneshot agents exit immediately after main task, ignoring callback instructions
- Not reliable enough for production
- Replaced by ACP session poller (v2.3+)

**Note**: Prompt injection is still used in some contexts, but not relied upon as primary completion mechanism.

### Deprecated: subagent_ended Hook v2.1

**Status**: Deprecated due to OpenClaw bug

**Why deprecated**:
- `subagent_ended` hook does not fire for ACP runtime (OpenClaw issue)
- Replaced by explicit session polling (v2.3+)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.x | 2026-03-12 | Initial task-callback-bus implementation |
| v2.0 | 2026-03-12 | acp-completion-relay with prompt injection |
| v2.1 | 2026-03-12 | subagent_ended hook attempt |
| v2.2 | 2026-03-12 | sessions/index.json polling |
| v2.3 | 2026-03-13 | ACP session poller (~15s) |
| v2.4 | 2026-03-13 | spawn-interceptor + four-layer pipeline |
| v2.5 | 2026-03-13 | + content-aware-completer (L4) |

---

*Last updated: 2026-03-13 | See [Completion Truth Matrix](COMPLETION_TRUTH_MATRIX.md) for runtime completion sources*
