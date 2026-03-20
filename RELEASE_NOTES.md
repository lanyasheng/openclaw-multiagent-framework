# Release Notes

---
## v2.6.0 — subagent ↔ orchestrator runtime bridge v1 (2026-03-20)

### 核心变化

- **subagent 生命周期桥接**：`spawn-interceptor` 在 `runtime=subagent` 的 `before_tool_call` 阶段同步创建 `shared-context/job-status/{taskId}.json`
- **终态写回**：`subagent_ended` 与 `reconcileSubagentRuns()` 都会把 completed / failed / timeout 写回对应 job-status 文件
- **batch 聚合**：`batch_id` 优先取显式 `batchId`，否则从 `requesterSessionKey` 派生，便于 batch summary / decision 聚合
- **decision-only v1**：终态后机会式调用 `orchestrator/cli.py batch-summary <batch_id>` 与 `decide <batch_id>`，**只产出 decision / dispatch-plan，不自动 spawn 下一轮**
- **精确匹配修正**：`subagent_ended` 改为严格按 `targetSessionKey` / `spawnedSessionKey` 匹配 pending task，去掉单 pending fallback
- **父会话唤醒安全修正**：CLI 唤醒仅接受显式 session id（数字/UUID），不再把 `agent:main:discord:channel:*` 这类 requester session key 当作 `--session-id`

### 对外意义

- 公开仓现在包含一份可执行的 engine 侧适配：runtime 观察层可以直接为 orchestrator 生成 task state 与 batch-level decision 输入
- 当前策略仍保持克制：plugin 只负责**状态桥接与决策触发**，不在 hook 内内联业务编排

---
## v2.5.2 — spawn-interceptor 可靠性强化 + 上游 ACP 修复 (2026-03-14)

### 上游修复

- **ACP subagent_ended 修复** ([PR #46308](https://github.com/openclaw/openclaw/pull/46308))：`acp-spawn.ts` 现在调用 `registerSubagentRun()`，使 `subagent_ended` hook 也能被 ACP 会话触发。此前该 hook 仅对 `runtime=subagent` 生效。
- **LLM Fallback 降级修复** ([PR #44970](https://github.com/openclaw/openclaw/pull/44970))：修复 embedded run 不抛 `FailoverError` 导致 fallback 链断裂的问题。

### spawn-interceptor 改进 (v2.5.0 → v2.5.2)

- **v2.5.0**: `subagent_ended` 按 `targetSessionKey` 精确匹配（替代按类型首个匹配）；ACP poller 防重匹配已关闭会话；fallback 状态从 `completed` 改为 `assumed_complete`；新增 `unregister()` 清理定时器；版本号在 `package.json` 和 `index.js` 间同步
- **v2.5.1**: `consumedAcpSessionIds` 提升为模块级变量，跨 poll 迭代持久化
- **v2.5.2**: ACP matcher 要求 `sessionCreatedAt >= spawnTs - 2s`，防止旧会话误匹配新任务

---
## v2.4.0 — 通信护栏 + 死信队列 + 任务链自动化 (2026-03-13)

> **Note**: This release and subsequent versions use the `spawn-interceptor` plugin architecture. The older `task-callback-bus` (~2,543 lines, file-polling based) is deprecated and not included in the open source package. See [INTERNAL_VS_OSS.md](INTERNAL_VS_OSS.md) for details.

### 新增: Dead Letter Queue (DLQ)

- 当任务通知投递失败超过 3 次，自动移入死信队列 `dlq.jsonl`
- JSONL 持久化，支持回查和重试
- `WatcherBus.stats` 新增 `tasks_dlq` 指标

### 新增: Terminal Bridge（任务分发自动化）

- 任务到达终态（completed/failed/timeout）时自动匹配 follow-up 规则
- 规则引擎支持按 `trigger_state` + `trigger_task_type` 匹配
- 分发记录持久化到 `dispatch-log.jsonl`
- 支持自定义 `on_dispatch` 回调

### 新增: Agent Communication Guardrail

- **请求去重**: 同一 task_id + agent_id + content 在 TTL(300s) 内自动去重
- **身份检查**: 禁止冒充 `system/gateway/admin/root` 等保留身份
- **Channel 保护**: `completion-relay` 和 `system` channel 仅允许 `main` agent 写入
- `WatcherBus.stats` 新增 `guardrail_blocked` 指标

### 架构影响

```
task-callback-bus v1.1.0 (2,543 行, +247 行)
├── bus.py              — 主编排器 (+30 行集成逻辑)
├── dead_letter_queue.py — DLQ (60 行, 新)
├── terminal_bridge.py   — 任务链自动化 (98 行, 新)
├── guardrail.py         — 通信护栏 (89 行, 新)
└── __init__.py          — 导出更新 (+20 行)
```

### 验证

- `watcher.py --once` 运行正常，3 个活跃任务正常检查
- DLQ/Terminal Bridge/Guardrail 在条件触发时自动生效


## v2.3.0 — ACP Session Poller: 真正的完成检测闭环 (2026-03-13)

### 核心发现

**`subagent_ended` hook 不对 ACP runtime 生效**（在当时版本）。之前 v2.2 假设 `subagent_ended` 是 PRIMARY 完成检测机制，但实际测试表明 OpenClaw 的该 hook 仅对 `runtime=subagent` 触发，ACP session 结束时不会触发。这导致所有 ACP 任务永远卡在 `spawning` 状态。**注：此问题已在 [PR #46308](https://github.com/openclaw/openclaw/pull/46308) 中修复**。

### 新增: ACP Session Poller

- 每 15 秒轮询 `~/.acpx/sessions/index.json`
- 通过 `created_at` 时间窗口匹配（±60s）将 acpx session 关联到 pending task
- 检测到 session `closed: true` 后，自动标记任务为 `completed`
- 如果任务超过 2 分钟且所有 ACP session 都已关闭，执行批量清理

### 三层完成检测防御

| 层级 | 机制 | 覆盖场景 | 延迟 |
|------|------|----------|------|
| L1 | `subagent_ended` hook | `runtime=subagent` 正常完成/失败 | <1s |
| L2 | ACP session poller | `runtime=acp` session 关闭 | ~15s |
| L3 | Stale reaper | 任何 runtime 超过 30min | 30min |

### 统一 task-log.jsonl

`task-log.jsonl` 成为所有任务事件的单一事实源:
- spawn-interceptor 写入 ACP/subagent 内部任务的状态
- task_callback_bus watcher 写入外部异步任务（浏览器/社交媒体等）的状态
- completion-listener 只需监听一个文件即可获取所有完成事件

### 验证结果
- 模拟测试: 注入 pending ACP 任务 + 已关闭 acpx session → 启动时立即检测到完成（match=0s）
- 历史回溯: 之前卡住的真实 ACP 任务也被正确标记为 completed（match=9s）
- 真实 ACP 任务: 大龙虾触发的 ACP 任务被 poller 正确检测到完成（match=43s）
- watcher bridge: 外部任务状态变化正确写入 task-log.jsonl

---

## v2.2.0 — Completion 回传修复 + 防御增强 (2026-03-13)

### 核心修复
- **completion 回传闭环修复**: 用 subagent_ended hook 作为 PRIMARY 完成检测机制
  - 之前依赖 prompt 注入 sessions_send 指令，但 ACP agent 完成主任务后直接退出
  - 现在 subagent_ended 是系统事件，由 Gateway 自动触发，不依赖 agent 行为
- **Stale Task Reaper**: 每 5 分钟扫描，超过 30 分钟未完成的自动标记 timeout
- **持久化 pending state**: .pending-tasks.json 确保 Gateway 重启不丢失追踪状态
- **completion_listener v2**: 直接从 task-log.jsonl 读取完成状态

### 防御机制
| 场景 | 防御 |
|------|------|
| subagent 正常完成 | subagent_ended hook → completed |
| ACP 完成 | ~~subagent_ended~~ **v2.3: ACP session poller** → completed |
| Gateway 断开 | 持久化恢复 + stale reaper → timeout |
| ACP 崩溃 | ~~subagent_ended~~ **v2.3: ACP session poller** → completed |

### 已知 OpenClaw Bug
新增 Bug 追踪章节：#34054, #35886, #40243, #40272

---

## v2.0.0 — 通信层重设计 (2026-03-12)

### 核心变更：从文件轮询到拦截 + 回调

**问题背景**：
1. ACP 任务完成后没有可靠通知机制（ACP `notifyChannel` bug - Issue #40272）
2. `sessions_spawn` timeout 语义歧义（Issue #28053）
3. Agent 忘记执行监控步骤（LLM 固有局限）

为解决这三个问题，之前自建了 ~9,600 行的 `task_callback_bus`（文件轮询架构），现替换为 ~600 行的 plugin + listener 方案。

### 新增

- **spawn-interceptor plugin**（`plugins/spawn-interceptor/`）
  - 自动拦截 `sessions_spawn` 调用
  - 记录到 `task-log.jsonl`
  - 为 ACP 任务注入完成回调指令
  - 符合 OpenClaw plugin 规范（`register(api)` + `openclaw.plugin.json`）

- **completion-listener**（`examples/completion-relay/`）
  - 监听 `agent:main:completion-relay` session
  - 解析完成通知并更新 task-log
  - 可扩展到 Discord/Telegram

- **COMMUNICATION_ISSUES.md**
  - 核心设计文档，完整记录问题、方案、架构和实现

- **QUICKSTART.md v3**
  - 全面重写，5 分钟部署 plugin + listener
  - 涵盖验证、故障排查、清单

### 变更

- **ARCHITECTURE.md**：新增"通信层改进"章节
- **ANTIPATTERNS.md**：新增 #11 文件轮询反模式、#12 文档约束反模式
- **README.md**：重写为 plugin + 协议框架定位
- **GETTING_STARTED.md**：更新决策树和 MVP 集合
- **INTERNAL_VS_OSS.md**：反映开源包已包含可运行代码
- **CONTRIBUTING.md**：更新贡献范围和代码规范

### 移除

- `examples/mini-watcher/`（文件轮询反模式）
- `examples/task_state_machine.py`（已由 plugin 替代）
- `examples/test-protocol.sh`（已过时）
- `PROJECT_STATUS.md`（内部文档不应开源）

### 代码量对比

| 方案 | 行数 | 文件数 |
|------|------|--------|
| task_callback_bus（旧） | ~9,600 | ~40+ |
| spawn-interceptor + completion-relay（新） | ~600 | 6 |

### 测试

- completion-relay: 15 个测试
- l2_capabilities: 35 个测试
- 全部通过

---

## v1.0.0 — 协议框架初版 (2026-03-12)

### 新增

- **AGENT_PROTOCOL.md**: 五角色 Agent 协作协议
- **ARCHITECTURE.md**: 三层架构（L1/L2/L3）
- **QUICKSTART.md**: 快速开始指南
- **CAPABILITY_LAYERS.md**: 能力分层模型
- **ANTIPATTERNS.md**: 常见反模式（10 条）
- **TEMPLATES.md**: 标准消息模板
- **GETTING_STARTED.md**: 开源接入指引
- **examples/**: protocol_messages.py, l2_capabilities.py
- **tests/**: 35 个测试用例

---

## Documentation Version Alignment

| Document | Version | Last Updated |
|----------|---------|--------------|
| README.md | 2026-03-13-v9 | Positioning + Framework Comparison added |
| ARCHITECTURE.md | 2026-03-13-v9 | Cross-references added |
| CAPABILITY_LAYERS.md | 2026-03-13-v9 | Cross-references added |
| INTERNAL_VS_OSS.md | 2026-03-13-v9 | Cross-references added |
| AGENT_PROTOCOL.md | 2026-03-13-v4 | Cross-references added |
| GETTING_STARTED.md | 2026-03-13-v3 | Cross-references added |
| COMMUNICATION_ISSUES.md | 2026-03-13-v9 | Cross-references added |
| CONTENT_AWARE_COMPLETER.md | 2026-03-13-v1 | Base L4 documentation |
