# OpenClaw 多智能体协作框架

> 一套经过生产环境验证的多智能体协作协议和架构。解决 ACP 通信不可靠、Agent 忘记注册任务、超时语义模糊等核心问题，通过零配置的插件系统实现。

[English Version](README.md)

**版本**: 2026-03-13-v8 | **许可证**: MIT | **状态**: 生产可用

---

## 问题是什么？

在 OpenClaw 中运行多个 AI 智能体时，你会很快遇到以下根本性问题：

### 1. 没有完成通知

你调用 `sessions_spawn` 启动一个 ACP 子 Agent。它在后台运行。然后……什么都没有。OpenClaw 不会告诉你它什么时候完成。没有回调，没有 webhook，没有事件，没有任何通知。

**根因**: OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272) — ACP 的 `notifyChannel` 参数被接受但被静默忽略。

### 2. Agent 注册遗忘症

你仔细编写文档："调用 `sessions_spawn` 前，必须先向监控系统注册任务。"LLM 读了。理解了。然后还是直接调用 `sessions_spawn`，跳过了注册。每一次都这样。

LLM 有"肌肉记忆"——它们默认使用原生工具调用，跳过包装函数。基于文档的约束对强制行为无效。

### 3. 僵尸会话

完成的 ACP 会话不会被 OpenClaw Gateway 正确清理（Bug [#34054](https://github.com/openclaw/openclaw/issues/34054)）。这些僵尸会话悄悄堆积，直到达到 `maxConcurrentSessions` 限制（默认 6），此时所有新 ACP 任务都会失败并报一个晦涩的"max sessions exceeded"错误——即使 Agent 发誓一切都已关闭。

### 4. 超时语义模糊

`sessions_send` 返回 "timeout"。但这意味着什么？
- 任务失败了？→ 也许
- 任务还在运行？→ 也许
- 消息根本没发送出去？→ 也可能
- 任务完成了但响应太慢？→ 有可能

你根本无法判断。没有后续机制，没有状态查询，没有重试协议。

### 5. 没有审计日志

一天的多 Agent 编排后，你问："今天启动了哪些任务？哪些完成了？哪些失败了？耗时多久？"答案是：翻阅 50KB 的聊天历史，手动拼凑信息。

---

## 解决方案

**核心洞察**: 如果某个行为是强制性的，它应该是系统约束——而不是文档约束。

我们不再教 Agent 记住额外步骤（这永远会失败），而是在系统层面使用 OpenClaw 的插件 Hook 进行拦截（这永远有效）。

### spawn-interceptor 插件 (v2.4)

一个 OpenClaw 插件（约 250 行 JavaScript），功能如下：

1. **自动拦截** 每次 `sessions_spawn` 调用（通过 `before_tool_call` hook）
2. **记录任务** 到 `task-log.jsonl`，状态为 `spawning`
3. **检测完成** 通过三层防御系统
4. **更新日志** 任务完成、失败或超时时

零配置。零 Agent 侧改动。Agent 甚至不知道它的存在。

### 架构

```
Agent 调用 sessions_spawn()
         │
         ▼
┌─────────────────────────────────────────────────┐
│             spawn-interceptor v2.4              │
│          (OpenClaw 插件, ~250 行)               │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─ before_tool_call hook ──────────────────┐   │
│  │  • 检测 sessions_spawn 调用              │   │
│  │  • 提取任务元数据（agent, runtime）      │   │
│  │  • 写入 task-log.jsonl (spawning)        │   │
│  │  • 存储到 pendingTasks Map               │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─ 完成检测 (三层防御) ────────────────────┐   │
│  │                                          │   │
│  │  L1: subagent_ended hook         (<1s)   │   │
│  │      OpenClaw 在 subagent 完成时触发。   │   │
│  │      但：不对 ACP runtime 触发。         │   │
│  │      覆盖: runtime=subagent              │   │
│  │                                          │   │
│  │  L2: ACP Session Poller          (~15s)  │   │
│  │      每 15 秒轮询 ~/.acpx/sessions/      │   │
│  │      index.json。当会话 closed:true      │   │
│  │      时，通过创建时间戳匹配（±60s）      │   │
│  │      关联到 pending task。               │   │
│  │      覆盖: runtime=acp                   │   │
│  │                                          │   │
│  │  L3: Stale Reaper                (30min) │   │
│  │      安全网。pending 超过 30 分钟的      │   │
│  │      任务标记为 timeout。                │   │
│  │      覆盖: 所有 runtime                  │   │
│  │                                          │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  → 更新 task-log.jsonl (completed/failed)       │
│  → 持久化 pendingTasks 到 .pending-tasks.json   │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│              task-log.jsonl                     │
│       (所有事件的单一事实来源)                   │
├─────────────────────────────────────────────────┤
│ 写入者:                                         │
│   • spawn-interceptor (内部 ACP/subagent 任务) │
│   • task-callback-bus WatcherBus (外部任务)     │
│                                                 │
│ 消费者:                                         │
│   • completion-listener (告警/通知)             │
│   • discord_task_panel.py (状态面板)            │
│   • 任何 JSONL 读取器                           │
└─────────────────────────────────────────────────┘
```

### 外部任务监控

对于在 OpenClaw 之外运行的任务（浏览器自动化、社交媒体监控、定时任务），由独立的 Python 组件处理：

```
┌───────────────┐     ┌──────────────────────────────┐
│ 外部系统      │     │  task-callback-bus v1.1.0     │
│               │◄──► │  WatcherBus (2,543 行)        │
│ ─────────     │     │                              │
│ • 小红书发帖  │     │  适配器:                     │
│ • GitHub PR   │     │  • XiaohongshuNoteReview     │
│ • 定时任务    │     │  • GitHubPRStatus            │
│ • ACP 状态    │     │  • CronJobCompletion         │
│               │     │  • AcpSessionCompletion      │
│               │     │  • CodingAgentRunStatus      │
│               │     │                              │
│               │     │  通知器:                     │
│               │     │  • Discord, Telegram, Session│
│               │     │                              │
│               │     │  护栏 (v1.1.0):              │
│               │     │  • DLQ (死信队列)            │
│               │     │  • Terminal Bridge (任务链)  │
│               │     │  • Agent 通信护栏            │
│               │     │    (去重/身份/通道验证)      │
│               │     └──────────────────────────────┘
└───────────────┘
```

### 为什么需要三层检测？

我们通过惨痛教训发现 **OpenClaw 的 `subagent_ended` hook 不会对 ACP runtime 会话触发**。这是一个未文档化的限制。ACP 会话由 `acpx` 二进制管理，其生命周期在 `~/.acpx/sessions/` 中跟踪——与 OpenClaw 的 Hook 系统完全隔离。

完成检测经历了 3 次迭代才到达当前设计：

| 尝试 | 方案 | 结果 |
|------|------|------|
| v2.1 | Prompt 注入（告诉 ACP Agent 发送完成消息） | 失败。Oneshot ACP Agent 完成主任务后忽略注入的指令。 |
| v2.2 | 依赖 `subagent_ended` hook 作为主要机制 | 失败。该 hook 不对 `runtime=acp` 触发。所有 ACP 任务永远停留在 `spawning`。 |
| v2.3 | ACP Session Poller + `subagent_ended` + Stale Reaper | 成功。分层防御覆盖所有 runtime，优雅降级。 |

---

## 快速开始

### 前置条件

- OpenClaw >= 2026.3.x（需要 `before_tool_call` 插件 hook 支持）
- Python 3.10+（用于 completion-listener 和 task-callback-bus）
- 至少配置 1 个 agent

### 1. 安装插件

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/extensions/
```

### 2. 重启 Gateway

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Linux
systemctl --user restart openclaw-gateway
```

### 3. 验证

```bash
# 触发一个 ACP 任务，然后检查日志：
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```

你应该看到如下条目：

```json
{
  "taskId": "tsk_20260313_abc123",
  "agentId": "main",
  "runtime": "acp",
  "status": "spawning",
  "spawnedAt": "2026-03-13T01:30:00.000Z"
}
```

ACP 任务完成约 15 秒后：

```json
{
  "taskId": "tsk_20260313_abc123",
  "status": "completed",
  "completionSource": "acp_session_poller",
  "completedAt": "2026-03-13T01:32:15.000Z"
}
```

### 4.（可选）设置 completion-listener

```bash
# 添加到 crontab 定时检查
echo "*/1 * * * * cd /path/to/examples/completion-relay && python3 completion_listener.py --once >> /tmp/completion.log 2>&1" | crontab -

# 或持续运行
python3 examples/completion-relay/completion_listener.py --loop --interval 30
```

完整部署指南见 [QUICKSTART.md](QUICKSTART.md)。

---

## 已知 OpenClaw Bug

这个框架的存在部分原因是 OpenClaw 中以下未解决的 bug：

| Issue | 描述 | 影响 | 我们的 Workaround |
|-------|------|------|-------------------|
| [#34054](https://github.com/openclaw/openclaw/issues/34054) | Gateway 不对已完成的 oneshot 会话调用 `runtime.close()` | 僵尸会话触达 `maxConcurrentSessions` 限制 | Guardian 脚本每日 GC |
| [#35886](https://github.com/openclaw/openclaw/issues/35886) | ACP 子进程在 TTL 后未被清理 | 僵尸进程堆积 | Guardian 健康检查自动重启 |
| [#40272](https://github.com/openclaw/openclaw/issues/40272) | ACP 的 `notifyChannel` 不生效 | 无原生完成通知 | spawn-interceptor 插件 |
| （未文档化） | `subagent_ended` hook 不对 ACP runtime 触发 | ACP 任务状态永远停留在 `spawning` | v2.4 ACP Session Poller |

---

## 文档导航

| 文档 | 用途 |
|------|------|
| [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) | 问题分析和设计原理（README 之后首选阅读） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构深度解析，含数据流图 |
| [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | 完整的协作协议规范 |
| [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md) | L1（OpenClaw 原生）/ L2（框架增强）/ L3（需要核心修改） |
| [QUICKSTART.md](QUICKSTART.md) | 详细部署指南 |
| [GETTING_STARTED.md](GETTING_STARTED.md) | 新用户引导 |
| [ANTIPATTERNS.md](ANTIPATTERNS.md) | 踩坑经验和教训 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 版本历史 |

---

## 仓库结构

```
├── plugins/
│   └── spawn-interceptor/        # OpenClaw 插件 (~250 行)
│       ├── index.js              # v2.4: hooks + ACP poller + stale reaper
│       ├── package.json          # 插件元数据
│       └── openclaw.plugin.json  # OpenClaw 插件清单
├── examples/
│   ├── completion-relay/         # 完成通知监听器
│   │   ├── completion_listener.py
│   │   └── tests/
│   ├── l2_capabilities.py        # L2 能力实现演示
│   └── protocol_messages.py      # 协议消息格式演示
├── COMMUNICATION_ISSUES.md       # 核心设计文档
├── ARCHITECTURE.md               # 架构深度解析
├── AGENT_PROTOCOL.md             # 协作协议
├── RELEASE_NOTES.md              # 版本历史
└── README_CN.md                  # 中文 README
```

---

## 设计理念

| 维度 | 传统方式 | 我们的方式 |
|------|----------|-----------|
| 任务注册 | Agent 需记住调用包装函数 | 插件 hook 自动拦截 |
| 完成检测 | Prompt 注入（被 ACP 忽略） | 基于文件的会话轮询 |
| 状态管理 | 纯内存（重启即丢失） | 持久化到 JSONL + pending 文件 |
| 监控 | 每个组件各自一个文件 | 统一的 task-log.jsonl |
| 错误处理 | 静默失败 | DLQ + Stale Reaper + 健康检查 |

---

## 贡献

欢迎 PR 和 Issue。贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT 许可证
