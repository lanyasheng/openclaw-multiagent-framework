# OpenClaw 多智能体协作框架

> 一套经过生产环境验证的多智能体协作协议和架构。解决 ACP 通信不可靠、Agent 忘记注册任务、超时语义模糊等核心问题，通过零配置的插件系统实现。

[English Version](README.md)

**版本**: 2026-03-13-v9 | **许可证**: MIT | **状态**: 生产可用

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

## 解决方案：四层完成检测链路

**核心洞察**: 如果某个行为是强制性的，它应该是系统约束——而不是文档约束。

我们不再教 Agent 记住额外步骤（这永远会失败），而是在系统层面使用 OpenClaw 的插件 Hook 进行拦截（这永远有效）。

### 四层完成检测架构

我们的完成检测采用**四层防御架构**，处理不同类型的任务和边界情况：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    完成检测链路 v2.5 (COMPLETION PIPELINE)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  第一层：原生事件流 (OpenClaw)                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  sessions_spawn(runtime="acp", streamTo="parent")                  │   │
│  │  • 接收 progress、stall、resumed 事件                              │   │
│  │  • 通过 stream 实时状态更新                                         │   │
│  │  • 覆盖：使用 streamTo 的 runtime=acp                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  第二层：启动登记层 (spawn-interceptor)                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  before_tool_call hook 拦截 sessions_spawn                          │   │
│  │  • 记录任务到 task-log.jsonl (spawning 状态)                       │   │
│  │  • 存储到 pendingTasks Map                                          │   │
│  │  • 不是完成真值——仅负责启动登记                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  第三层：基础终态层 (Poller + Reaper)                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  L3a: ACP Session Poller (~15秒轮询)                               │   │
│  │       轮询 ~/.acpx/sessions/ 查找已关闭会话                         │   │
│  │                                                                     │   │
│  │  L3b: Stale Reaper (30分钟安全网)                                  │   │
│  │       将长期 pending 的任务标记为 timeout                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  第四层：终态纠偏层 (content-aware-completer)                                │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  解决"Registered=False, Terminal=False"（第4类任务）问题           │   │
│  │  • 第一层：需要同时满足会话关闭 + 内容证据                          │   │
│  │  • 拒绝历史文件、空文件                                             │   │
│  │  • 幂等写入、UTC 时区安全                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│                    统一出口：task-log.jsonl                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 关键澄清

| 误解 | 真值 |
|------|------|
| "Hook 就是完成真值" | Hook 只登记任务**启动**。完成需要第3/4层。 |
| "中间状态来自 hook" | 中间状态来自第1层原生事件流，不是 hook。 |
| "Plugin 自动闭环" | Plugin 提供追踪能力。content-aware completer 验证完成。 |

### spawn-interceptor 插件 (v2.4)

一个 OpenClaw 插件（约 250 行 JavaScript），功能如下：

1. **自动拦截** 每次 `sessions_spawn` 调用（通过 `before_tool_call` hook）
2. **记录任务** 到 `task-log.jsonl`，状态为 `spawning`
3. **提供基础** 用于完成检测（第2层）

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
│  ┌─ 完成检测 (四层架构) ────────────────────┐   │
│  │                                          │   │
│  │  L1: 原生事件流                          │   │
│  │      streamTo="parent" 进度事件         │   │
│  │                                          │   │
│  │  L2: 启动登记层 (hook)                   │   │
│  │      记录 spawning 状态                  │   │
│  │                                          │   │
│  │  L3: 基础终态层                          │   │
│  │      • ACP Session Poller (~15秒)        │   │
│  │      • Stale Reaper (30分钟)             │   │
│  │                                          │   │
│  │  L4: 终态纠偏层                          │   │
│  │      content-aware-completer.py          │   │
│  │      需要内容证据                        │   │
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
│   • spawn-interceptor (第2层)                   │
│   • content-aware-completer (第4层)             │
│   • completion-listener (通知)                  │
│                                                 │
│ 消费者:                                         │
│   • 任意 JSONL 读取器                           │
└─────────────────────────────────────────────────┘
```

### content-aware-completer（第4层）

解决**第4类任务问题**（已注册但非终态的任务）：

| 层级 | 所需证据 | 操作 | 置信度 |
|------|---------|------|--------|
| 第一层 | 会话关闭 + 内容证据 | 标记完成 | 高 |
| 第二层 | 会话关闭，无内容 | 保持 pending | 中 |
| 第三层 | 有内容，会话未关闭 | 保持 pending | 低 |
| 第四层 | 无证据 | 保持 pending | 低 |

**核心规则**：
- **强证据要求**：同时满足会话关闭 AND 内容证据
- **历史文件拒绝**：防止基于旧文件标记任务完成
- **空文件拒绝**：忽略零字节输出
- **幂等写入**：多次运行安全
- **UTC 时区安全**：所有时间戳使用 UTC

---

## 快速开始

### 前置条件

- OpenClaw >= 2026.3.x（需要 `before_tool_call` 插件 hook 支持）
- Python 3.10+（用于 completion-listener 和 content-aware-completer）
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

### 4.（可选）设置 content-aware-completer

```bash
# 持续运行第4层终态纠偏
python3 examples/content-aware-completer/content_aware_completer.py --loop --interval 30

# 或运行一次
python3 examples/content-aware-completer/content_aware_completer.py --once
```

**推荐模式**：编码/文档任务使用 `mode="run"`。仅复杂多轮任务使用 `mode="session"` 或 `mode="thread"`。

完整部署指南见 [QUICKSTART.md](QUICKSTART.md)。

---

## 已知 OpenClaw Bug

这个框架的存在部分原因是 OpenClaw 中以下未解决的 bug：

| Issue | 描述 | 影响 | 我们的 Workaround |
|-------|------|------|-------------------|
| [#34054](https://github.com/openclaw/openclaw/issues/34054) | Gateway 不对已完成的 oneshot 会话调用 `runtime.close()` | 僵尸会话触达 `maxConcurrentSessions` 限制 | Guardian 脚本每日 GC |
| [#35886](https://github.com/openclaw/openclaw/issues/35886) | ACP 子进程在 TTL 后未被清理 | 僵尸进程堆积 | Guardian 健康检查自动重启 |
| [#40272](https://github.com/openclaw/openclaw/issues/40272) | ACP 的 `notifyChannel` 不生效 | 无原生完成通知 | 四层完成检测链路 |
| （未文档化） | `subagent_ended` hook 不对 ACP runtime 触发 | ACP 任务状态永远停留在 `spawning` | ACP Session Poller（第3层） |

---

## Agent 默认模板

启动 ACP Agent 时，使用此最简模板：

```python
# 默认版本（编码/文档任务）
sessions_spawn(
    sessionKey=f"agent:{agent_id}:task",
    agentId=agent_id,
    prompt="你的任务",
    mode="run",  # 推荐用于大多数任务
    streamTo="parent",  # 启用第1层事件流
)
```

复杂多轮任务：

```python
# 扩展版本（仅用于复杂多轮任务）
sessions_spawn(
    sessionKey=f"agent:{agent_id}:task",
    agentId=agent_id,
    prompt="你的复杂任务",
    mode="session",  # 仅用于复杂多轮
    streamTo="parent",
)
```

---

## 文档导航

| 文档 | 用途 |
|------|------|
| [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) | 问题分析和设计原理（README 之后首选阅读） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构深度解析，含数据流图 |
| [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | 完整的协作协议规范 |
| [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md) | L1（OpenClaw 原生）/ L2（框架增强）/ L3（需要核心修改） |
| [CONTENT_AWARE_COMPLETER.md](CONTENT_AWARE_COMPLETER.md) | 第4层完成验证文档 |
| [QUICKSTART.md](QUICKSTART.md) | 详细部署指南 |
| [GETTING_STARTED.md](GETTING_STARTED.md) | 新用户引导 |
| [ANTIPATTERNS.md](ANTIPATTERNS.md) | 踩坑经验和教训 |
| [INTERNAL_VS_OSS.md](INTERNAL_VS_OSS.md) | 开源版与内部版差异说明 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 版本历史 |

---

## 仓库结构

```
├── plugins/
│   └── spawn-interceptor/        # OpenClaw 插件 (~250 行)
│       ├── index.js              # v2.4: hooks + 完成链路
│       ├── package.json          # 插件元数据
│       └── openclaw.plugin.json  # OpenClaw 插件清单
├── examples/
│   ├── completion-relay/         # 基础完成监听器
│   │   ├── completion_listener.py
│   │   └── tests/
│   ├── content-aware-completer/  # 第4层完成验证
│   │   ├── content_aware_completer.py
│   │   └── tests/
│   ├── l2_capabilities.py        # L2 能力实现演示
│   └── protocol_messages.py      # 协议消息格式演示
├── COMMUNICATION_ISSUES.md       # 核心设计文档
├── ARCHITECTURE.md               # 架构深度解析
├── AGENT_PROTOCOL.md             # 协作协议
├── CONTENT_AWARE_COMPLETER.md    # 第4层文档
├── INTERNAL_VS_OSS.md            # 开源版范围说明
├── RELEASE_NOTES.md              # 版本历史
└── README_CN.md                  # 中文 README
```

---

## 设计理念

| 维度 | 传统方式 | 我们的方式 |
|------|----------|-----------|
| 任务注册 | Agent 需记住调用包装函数 | 插件 hook 自动拦截（第2层） |
| 完成检测 | 单点故障 | 四层防御链路 |
| 中间状态 | 不追踪 | 原生事件流（第1层） |
| 终态验证 | 会话关闭 = 完成 | 需要内容证据（第4层） |
| 状态管理 | 纯内存（重启即丢失） | 持久化到 JSONL + pending 文件 |
| 监控 | 每个组件各自一个文件 | 统一的 task-log.jsonl |
| 错误处理 | 静默失败 | DLQ + Stale Reaper + 内容验证 |

---

## 贡献

欢迎 PR 和 Issue。贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT 许可证
