# 能力分层模型

> Version: 2026-03-13-v3

---

## 分层概览

| 层 | 来源 | 复杂度 | 说明 |
|----|------|--------|------|
| **L1** | OpenClaw 默认 | 零配置 | sessions_send、sessions_spawn、文件系统、streamTo 事件流 |
| **L2** | 本框架增强 | 低（plugin + 脚本） | 四层完成检测、ACK 守门、handoff 模板、真值落盘 |
| **L3** | 需 Core 修改 | 高 | 需要 OpenClaw 核心代码变更（如修复 ACP notifyChannel bug） |

---

## L1：OpenClaw 默认能力

### 通信
- `sessions_send`：同步/短异步消息传递
- `sessions_spawn`：启动子 Agent（subagent / ACP）
- `streamTo="parent"`：原生事件流（progress/stall/resumed）

### 存储
- 文件系统读写（`shared-context/` 等）

### 执行
- 工具调用（MCP tools、built-in tools）
- ACP 远程执行

### 限制
- ACP 完成没有可靠通知（Bug #40272）
- `sessions_spawn` timeout 语义模糊（Issue #28053）
- 无原生任务状态追踪
- 仅依赖会话状态可能产生假完成

---

## L2：本框架增强能力

### 2.1 四层完成检测链路

**实现**：`plugins/spawn-interceptor/` + `examples/content-aware-completer/`

**四层架构**：

| 子层 | 组件 | 能力 |
|------|------|------|
| L2.1 | 原生事件流 | `streamTo="parent"` 实时状态更新 |
| L2.2 | spawn-interceptor | Hook 拦截、任务登记到 task-log |
| L2.3 | Poller + Reaper | ACP 会话轮询、超时收割 |
| L2.4 | content-aware-completer | 内容证据验证、Type 4 任务纠偏 |

**Agent 负担**：零——正常使用 `sessions_spawn` 即可

**关键澄清**：
- L2.2 只负责启动登记，不是完成真值
- 中间状态来自 L2.1 原生事件流，不是 hook
- 完成检测需要 L2.3 + L2.4 配合

### 2.2 完成通知（completion-listener）

**实现**：`examples/completion-relay/completion_listener.py`

**能力**：
- 监听 `agent:main:completion-relay` session
- 解析 ACP 完成通知
- 更新 task-log 状态
- 可扩展到 Discord/Telegram 通知

**Agent 负担**：如需完成回调，按注入的指令执行 `sessions_send`

### 2.3 ACK 守门协议

**实现**：协议规范（`AGENT_PROTOCOL.md` 第 4 章、第 11 章）

**能力**：
- 收到 Request 后 3 秒内强制 ACK
- ACK 后才执行实际工作
- 状态落盘 `job-status/{ack_id}.json`

**Agent 负担**：遵循协议规范

### 2.4 Handoff 标准模板

**实现**：协议规范（`AGENT_PROTOCOL.md` 附录 A）

**能力**：
- Request/ACK/Final 三段式模板
- 交付物三层结构（结论 + 证据 + 动作）
- 可直接复用的消息模板

### 2.5 真值落盘

**实现**：协议规范 + 目录结构

**能力**：
- 关键事实必须写入 `shared-context/`
- 验收优先检查文件产物
- 状态枚举：spawning → in_progress → completed/failed
- L2.4 验证内容证据（文件大小、关键词、时间戳）

### 2.6 反思落地闭环

**实现**：协议规范（`AGENT_PROTOCOL.md` 第 7 章）

**能力**：
- 每日反思产出 `followups/YYYY-MM-DD.md`
- 次日 09:30 前转成实际动作
- P0/P1 强制跟进

---

## L3：需要 Core 修改

### 3.1 ACP notifyChannel

**Issue**：#40272

**现状**：ACP 完成后不触发 `notifyChannel`，导致无原生完成通知

**当前绕过**：四层完成检测链路（L2.1-L2.4）

**理想修复**：OpenClaw core 修复 `notifyChannel`，ACP 完成自动通知

### 3.2 sessions_spawn 明确返回值

**Issue**：#28053

**现状**：`sessions_spawn` 超时时无法区分"未投递"和"投递成功但执行超时"

**当前绕过**：task-log 记录 spawning 状态，四层链路完成确认

**理想修复**：`sessions_spawn` 返回明确的投递确认

### 3.3 before_tool_call hook 完整支持

**Issue**：#5943

**现状**：`before_tool_call` hook 可能未在所有场景中触发

**当前绕过**：测试确认当前版本 hook 已可用

**理想修复**：OpenClaw 官方文档明确 hook 生命周期

---

## 能力矩阵

| 能力 | L1 | L2 (本框架) | L3 |
|------|----|-----------|----|
| Agent 间消息传递 | ✅ sessions_send | ✅ + ACK 守门 | — |
| 启动子 Agent | ✅ sessions_spawn | ✅ + 自动追踪 | — |
| ACP 完成通知 | ❌ Bug #40272 | ✅ 四层完成链路 | 🔧 修复 notifyChannel |
| 任务状态追踪 | ❌ | ✅ task-log.jsonl + 四层验证 | — |
| 标准协作模板 | ❌ | ✅ handoff 模板 | — |
| 真值落盘 | ❌ | ✅ shared-context/ + L2.4 验证 | — |
| 反思闭环 | ❌ | ✅ followups/ | — |
| 内容证据验证 | ❌ | ✅ content-aware-completer | — |

---

## 引入路径

```
第 1 周: L2.2 + L2.3（安装 plugin → 自动任务追踪）
         ↓
第 2 周: L2.4（启用 content-aware-completer → 终态纠偏）
         ↓
第 3 周: L2.1 + L2.5（streamTo 事件流 + 真值落盘）
         ↓
第 4 周: L2.3 + L2.6（ACK 守门 + 反思闭环 → 完整体系）
         ↓
持续关注: L3 issues，等待 OpenClaw core 修复
```

---

## 四层完成链路详解

### 为什么需要四层？

| 问题 | 单层方案的局限 | 四层方案的优势 |
|------|---------------|---------------|
| 假完成 | 仅依赖会话状态 | L2.4 内容证据验证 |
| 任务丢失 | 仅依赖 hook 拦截 | L2.3 Poller 兜底 |
| 无实时状态 | 仅依赖轮询 | L2.1 原生事件流 |
| 中间状态盲区 | 仅检测终态 | L2.1 progress/stall/resumed |

### 各层职责

```
┌─────────────────────────────────────────────────────────────┐
│  L2.1: 原生事件流 (streamTo="parent")                       │
│  • 实时状态：progress, stall, resumed                       │
│  • 无需额外组件                                             │
│  • Agent 负担：添加 streamTo 参数                           │
├─────────────────────────────────────────────────────────────┤
│  L2.2: 启动登记 (spawn-interceptor)                         │
│  • Hook 拦截 sessions_spawn                                 │
│  • 记录 spawning 状态                                       │
│  • Agent 负担：零                                           │
├─────────────────────────────────────────────────────────────┤
│  L2.3: 基础终态 (Poller + Reaper)                           │
│  • 轮询 ACP 会话状态                                        │
│  • 超时安全网                                               │
│  • Agent 负担：零                                           │
├─────────────────────────────────────────────────────────────┤
│  L2.4: 终态纠偏 (content-aware-completer)                   │
│  • 内容证据验证                                             │
│  • 拒绝历史文件、空文件                                     │
│  • 四层决策：Tier 1-4                                       │
│  • Agent 负担：零                                           │
└─────────────────────────────────────────────────────────────┘
```

### 推荐配置

```python
# 默认推荐（编码/文档任务）
sessions_spawn(
    sessionKey=f"agent:{agent_id}:task",
    agentId=agent_id,
    prompt="Task description",
    mode="run",           # L2.1 启用事件流
    streamTo="parent",    # L2.1 接收实时状态
)

# 复杂多轮任务（仅当需要）
sessions_spawn(
    sessionKey=f"agent:{agent_id}:task",
    agentId=agent_id,
    prompt="Complex task",
    mode="session",       # 多轮对话模式
    streamTo="parent",
)
```

### 启用四层链路

```bash
# 1. 安装 L2.2（启动登记）
cp -r plugins/spawn-interceptor ~/.openclaw/extensions/
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 2. 启用 L2.4（终态纠偏）
python3 examples/content-aware-completer/content_aware_completer.py \
    --loop --interval 30

# 3. 验证（查看 task-log）
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```
