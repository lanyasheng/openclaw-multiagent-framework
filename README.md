# OpenClaw Multi-Agent Collaboration Framework

# OpenClaw 多 Agent 协作框架

> A battle-tested multi-agent collaboration protocol and architecture for OpenClaw, tackling unreliable ACP communication, agent task-registration amnesia, and ambiguous timeout semantics.
>
> 经过实战验证的多 Agent 协作协议与架构，解决 OpenClaw ACP 异步通信不可靠、Agent 遗忘任务注册、timeout 语义模糊三大核心痛点。

**Version**: 2026-03-13-v7 | **License**: MIT | **Status**: Production Ready

---

## TL;DR

**English**: OpenClaw's ACP (Agent Communication Protocol) has no native completion notification — when you spawn a sub-agent, you never know if it finished. This framework solves that with a zero-config plugin that automatically tracks every ACP/subagent task and provides deterministic completion detection through a 3-layer defense system.

**中文**: OpenClaw 的 ACP（Agent 通信协议）没有原生的任务完成通知——当你启动一个子 Agent 时，你永远不知道它是否完成了。本框架通过一个零配置插件自动追踪每个 ACP/subagent 任务，并通过三层防御体系提供确定性的完成检测。

---

## Why This Exists / 为什么需要这个框架

[English](#the-problem-english) | [中文](#问题背景-中文)

### The Problem (English)

When running multiple AI agents in OpenClaw, you quickly hit these walls:

1. **No completion notification**: You `sessions_spawn` a sub-agent (ACP), it runs in the background, but OpenClaw never tells you when it's done. There's no callback, no webhook, no event. (Root cause: OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272))

2. **Agent amnesia**: You tell the main agent "register this task with the watcher before spawning", but LLMs have muscle memory — they go straight to `sessions_spawn` and skip the registration. Every. Single. Time.

3. **Zombie sessions**: Completed ACP sessions don't get cleaned up properly (Bug [#34054](https://github.com/openclaw/openclaw/issues/34054)), eventually hitting the concurrent session limit and blocking all new tasks.

4. **Timeout ambiguity**: `sessions_send` returns "timeout" — but does that mean the task failed? Or is it still running? You can't tell.

5. **No audit trail**: Which tasks were spawned? When did they finish? What was the result? All you have is chat history.

### The Solution

Instead of teaching agents to remember (documentation constraint — always fails), we intercept at the system level (plugin hooks — always works):

```
                    ┌─────────────────────────────────────┐
                    │        spawn-interceptor v2.3       │
                    │     (OpenClaw Plugin, ~250 lines)   │
                    ├─────────────────────────────────────┤
Agent calls         │                                     │
sessions_spawn ───> │  before_tool_call hook intercepts   │
                    │  ├─ Log to task-log.jsonl (spawning) │
                    │  └─ Track in pendingTasks Map       │
                    │                                     │
                    │  === Completion Detection ===       │
                    │                                     │
                    │  L1: subagent_ended hook   (<1s)    │
                    │      └─ runtime=subagent only       │
                    │                                     │
                    │  L2: ACP Session Poller   (~15s)    │
                    │      └─ polls ~/.acpx/sessions/     │
                    │      └─ runtime=acp                 │
                    │                                     │
                    │  L3: Stale Reaper         (30min)   │
                    │      └─ safety net for all runtimes │
                    │                                     │
                    │  → Update task-log.jsonl (completed) │
                    └─────────────────────────────────────┘
```

**Zero cognitive load for agents**: They don't need to know this system exists. They just call `sessions_spawn` as usual, and everything is tracked automatically.

**Agent 零认知负担**: 不需要知道这个系统的存在。照常调用 `sessions_spawn`，一切自动追踪。

### 问题背景 (中文)

在 OpenClaw 中运行多个 AI Agent 时，你会很快遇到以下问题：

1. **没有完成通知**: 你通过 `sessions_spawn` 启动一个子 Agent (ACP)，它在后台运行，但 OpenClaw 永远不会告诉你它何时完成。没有回调，没有 webhook，没有事件。（根因：OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272)）

2. **Agent 健忘症**: 你告诉主 Agent "启动前先注册 watcher"，但 LLM 有肌肉记忆——它们直接调用 `sessions_spawn` 跳过注册。每次都这样。

3. **僵尸会话**: 已完成的 ACP session 不能被正确清理（Bug [#34054](https://github.com/openclaw/openclaw/issues/34054)），最终触及并发 session 上限，阻塞所有新任务。

4. **Timeout 歧义**: `sessions_send` 返回 "timeout" —— 但这是任务失败了？还是仍在运行？无法判断。

5. **无审计轨迹**: 哪些任务被启动了？何时完成的？结果是什么？你只有聊天历史。

### 解决方案

不再教 Agent 记住步骤（文档约束——总会失败），而是在系统级别拦截（插件 hook——永远生效）：

- **spawn-interceptor 插件** (~250 行) 自动拦截所有 `sessions_spawn` 调用
- **三层完成检测**: subagent_ended hook → ACP Session 轮询 → 过期任务收割
- **task-log.jsonl** 作为所有任务事件的唯一事实源
- **零配置**: 安装插件后无需任何 Agent 端修改

---

## Architecture / 架构

### Internal Tasks (ACP/Subagent) / 内部任务

```
┌──────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Agent   │────>│ spawn-interceptor │────>│  task-log.jsonl     │
│          │     │   (plugin v2.3)  │     │  (single source of  │
│ calls    │     │                  │     │   truth for ALL      │
│ sessions │     │ Hooks:           │     │   task events)       │
│ _spawn   │     │ • before_tool_   │     │                     │
│          │     │   call           │     │ Fields:             │
└──────────┘     │ • subagent_ended │     │ • taskId            │
                 │                  │     │ • runtime (acp/     │
                 │ Pollers:         │     │   subagent/external)│
                 │ • ACP session    │     │ • status            │
                 │   (15s interval) │     │ • completionSource  │
                 │ • Stale reaper   │     └─────────────────────┘
                 │   (30min timeout)│              │
                 └──────────────────┘              v
                                          ┌─────────────────────┐
                                          │ completion-listener  │
                                          │ discord_task_panel   │
                                          │ (any JSONL consumer) │
                                          └─────────────────────┘
```

### External Tasks (Browser/Social Media) / 外部任务

```
┌──────────────┐     ┌────────────────────────┐     ┌──────────────┐
│ External     │     │ task-callback-bus v1.1.0│     │ task-log.jsonl│
│ Systems      │<───>│ WatcherBus (2,543 lines)│────>│              │
│ (XHS, GitHub,│     │                        │     │ (unified with│
│  Cron Jobs)  │     │ Components:            │     │  internal    │
│              │     │ • Adapter Registry     │     │  events)     │
└──────────────┘     │ • Notifier Registry    │     └──────────────┘
                     │ • DLQ (Dead Letter Q)  │
                     │ • Terminal Bridge      │
                     │ • Agent Guardrail      │
                     └────────────────────────┘
```

### Three-Layer Completion Detection / 三层完成检测

| Layer | Mechanism | Covers | Latency | How it works |
|-------|-----------|--------|---------|-------------|
| L1 | `subagent_ended` hook | `runtime=subagent` | <1s | OpenClaw fires event when subagent finishes |
| L2 | ACP Session Poller | `runtime=acp` | ~15s | Polls `~/.acpx/sessions/index.json` for `closed: true` |
| L3 | Stale Reaper | All runtimes | 30min | Safety net: marks stuck tasks as `timeout` |

| 层级 | 机制 | 覆盖范围 | 延迟 | 工作原理 |
|------|------|---------|------|---------|
| L1 | `subagent_ended` hook | `runtime=subagent` | <1s | 子 agent 结束时 OpenClaw 触发事件 |
| L2 | ACP Session 轮询 | `runtime=acp` | ~15s | 轮询 `~/.acpx/sessions/index.json` 检测 `closed: true` |
| L3 | 过期收割器 | 所有 runtime | 30 分钟 | 兜底：将卡住的任务标记为 `timeout` |

**Why L2 exists / 为什么需要 L2**: OpenClaw's `subagent_ended` hook does **NOT** fire for `acp` runtime sessions. This is an undocumented limitation. ACP sessions are managed by `acpx`, and their lifecycle is only recorded in `~/.acpx/sessions/`. The v2.3 ACP Session Poller bridges this gap.

---

## Known OpenClaw Bugs & Workarounds / 已知 OpenClaw Bug

This framework exists partly because of these unresolved bugs:

本框架的诞生部分源于以下未修复的 Bug：

| Issue | Description / 描述 | Impact / 影响 | Workaround / 方案 |
|-------|-------------------|--------------|------------------|
| [#34054](https://github.com/openclaw/openclaw/issues/34054) | Gateway doesn't `close()` completed oneshot sessions / Gateway 不关闭已完成的 oneshot session | Zombie sessions hit `maxConcurrentSessions` / 僵尸 session 触发并发限制 | Daily GC in Guardian script / Guardian 每日清理 |
| [#35886](https://github.com/openclaw/openclaw/issues/35886) | ACP child processes not cleaned after TTL / ACP 子进程 TTL 后不清理 | Zombie process accumulation / 僵尸进程堆积 | Guardian health-check auto-restart / Guardian 自动重启 |
| [#40272](https://github.com/openclaw/openclaw/issues/40272) | `notifyChannel` doesn't work in ACP / ACP 中 notifyChannel 无效 | No native completion notification / 无原生完成通知 | `spawn-interceptor` plugin / 插件自动追踪 |
| (undocumented) | `subagent_ended` hook doesn't fire for `acp` / hook 不对 acp 触发 | ACP tasks stuck at `spawning` / ACP 任务永远卡在 spawning | v2.3 ACP Session Poller / ACP 轮询器 |

---

## Quick Start / 快速开始

### 1. Install plugin / 安装插件

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/
openclaw plugins install --link ~/.openclaw/plugins/spawn-interceptor
```

### 2. Restart Gateway / 重启 Gateway

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

### 3. Verify / 验证

```bash
# Trigger an ACP task, then check / 触发 ACP 任务后检查
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```

That's it. No agent-side changes needed. / 就这样。不需要修改任何 Agent 代码。

See [QUICKSTART.md](QUICKSTART.md) for detailed deployment guide. / 详细部署指南见 [QUICKSTART.md](QUICKSTART.md)。

---

## Unified Monitoring / 统一监控

`task-log.jsonl` — single source of truth for all task events / 所有任务事件的唯一事实源：

| Writer / 写入者 | Scope / 范围 |
|-----------------|-------------|
| `spawn-interceptor` plugin | Internal: ACP + subagent tasks / 内部任务 |
| `task-callback-bus` WatcherBus | External: browser, social media, cron / 外部任务 |

| Field | Description / 描述 |
|-------|-------------------|
| `taskId` | Unique identifier / 唯一标识 |
| `runtime` | `acp` / `subagent` / `external` |
| `status` | `spawning` / `completed` / `failed` / `timeout` |
| `completionSource` | `acp_session_poller` / `subagent_ended_hook` / `stale_reaper` / `watcher_close` |

---

## Documentation / 文档导航

| Document | Purpose / 用途 |
|----------|---------------|
| [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) | Problem analysis & design rationale / 问题分析与设计思路 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture deep-dive / 架构详解 |
| [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | Collaboration protocol spec / 协作协议规范 |
| [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md) | Capability tiers (L1/L2/L3) / 能力分层 |
| [QUICKSTART.md](QUICKSTART.md) | Quick deployment / 快速部署 |
| [GETTING_STARTED.md](GETTING_STARTED.md) | Onboarding guide / 入门指南 |
| [ANTIPATTERNS.md](ANTIPATTERNS.md) | Pitfalls & lessons / 踩坑与教训 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Version history / 版本历史 |

---

## Repository Structure / 仓库结构

```
├── plugins/
│   └── spawn-interceptor/     # OpenClaw plugin (~250 lines)
│       ├── index.js           # v2.3: hooks + ACP poller + stale reaper
│       ├── package.json
│       └── openclaw.plugin.json
├── examples/
│   ├── completion-relay/      # Completion notification listener
│   └── l2_capabilities.py     # L2 capability demo
├── COMMUNICATION_ISSUES.md    # Core design document
├── ARCHITECTURE.md            # Architecture deep-dive
├── AGENT_PROTOCOL.md          # Collaboration protocol
└── RELEASE_NOTES.md           # Version history
```

---

## Design Philosophy / 设计哲学

> **If a behavior is mandatory, it should not be optional.**
> **如果一个行为是强制的，它就不应该是可选的。**

| Principle / 原则 | Old Approach / 旧方案 | New Approach / 新方案 |
|-----------------|---------------------|---------------------|
| Task registration / 任务注册 | Agent must remember to call wrapper / Agent 必须记住调用 wrapper | Plugin hook auto-intercepts / 插件 hook 自动拦截 |
| Completion detection / 完成检测 | Prompt injection (ignored by ACP) / 提示注入（被 ACP 忽略） | File-based session polling / 基于文件的 session 轮询 |
| State management / 状态管理 | In-memory only / 仅内存 | Persistent to JSONL / 持久化到 JSONL |
| Monitoring / 监控 | Separate files per system / 每个系统独立文件 | Unified task-log.jsonl / 统一 task-log.jsonl |

---

## License

MIT

## Contributing / 贡献

PRs and Issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). / 欢迎 PR 和 Issue。
