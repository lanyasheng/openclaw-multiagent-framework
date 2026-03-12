# OpenClaw 多 Agent 协作框架 — 快速开始指南

<!-- 阅读顺序: 2/5 -->
<!-- 前置: README.md -->
<!-- 后续: AGENT_PROTOCOL.md -->

> Version: 2026-03-12-v3
> 适用对象：已有 OpenClaw 部署，想要引入多 Agent 协作规范

---

## 前置条件

| 依赖 | 版本 | 检查命令 |
|------|------|----------|
| Python | 3.10+ | `python3 --version` |
| OpenClaw Gateway | 运行中 | `launchctl list \| grep openclaw` |
| 目录权限 | 可写 | `mkdir -p ./shared-context && touch ./shared-context/.test` |

**无外部依赖**——框架和示例全部基于 Python 标准库。

---

## 5 分钟快速部署

### 步骤 1：创建必要目录

```bash
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

mkdir -p $FRAMEWORK_HOME/shared-context/{job-status,monitor-tasks,dispatches,intel,followups,archive/protocol-history}
```

### 步骤 2：克隆仓库

```bash
git clone https://github.com/lanyasheng/openclaw-multiagent-framework.git
```

### 步骤 3：安装 spawn-interceptor plugin

```bash
# 复制 plugin 到 OpenClaw plugins 目录
cp -r openclaw-multiagent-framework/plugins/spawn-interceptor ~/.openclaw/extensions/

# 用 openclaw CLI 安装（需要 --link 保持本地联动）

# 重启 Gateway
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

验证 plugin 加载：
```bash
openclaw plugins list | grep spawn-interceptor
# 应显示 status: loaded
```

### 步骤 4：部署 completion-listener

```bash
# 添加到 crontab (每分钟检查一次)
(crontab -l 2>/dev/null; echo "*/1 * * * * cd ~/.openclaw/repos/openclaw-multiagent-framework/examples/completion-relay && python3 completion_listener.py --once >> /tmp/completion-relay.log 2>&1") | crontab -
```

### 步骤 5：配置你的 Agent 团队

编辑 `$FRAMEWORK_HOME/shared-context/AGENT_PROTOCOL.md`，替换为你的团队配置：

```markdown
## 你的 Agent 团队

| Agent | 职责 | Channel |
|-------|------|---------|
| main | 协调与决策 | #general |
| research | 信息搜集 | #research |
| writing | 内容创作 | #writing |
| review | 质量审查 | #review |
```

---

## 核心概念

```
Agent 调用 sessions_spawn(acp)
    ↓ (before_tool_call hook 自动拦截)
spawn-interceptor plugin:
    1. 记录到 task-log.jsonl
    2. 注入完成回调到 ACP prompt
    ↓
ACP 子 Agent 执行任务
    ↓ (完成时主动 sessions_send)
completion-listener → 更新 task-log → 通知用户
```

**整个框架的核心是「拦截 + 回调」**：
1. Agent 正常使用 `sessions_spawn`（无需记住额外步骤）
2. `spawn-interceptor` plugin 自动记录任务并注入完成回调
3. ACP 完成时主动通过 `sessions_send` 推送结果
4. `completion-listener` 处理通知并更新状态

---

## 端到端可运行示例

### 示例 1：completion-relay（核心示例）

```bash
cd examples/completion-relay
python3 -m pytest tests/ -v
```

验证 task-log 读写、消息解析、边界条件处理。

### 示例 2：L2 能力演示

```bash
cd examples
python3 -m pytest tests/test_l2_capabilities.py -v
```

验证 ACK 守门、Handoff 模板、交付物结构等增强能力。

### 示例 3：协议消息交互

```bash
python3 examples/protocol_messages.py
```

验证 request/ACK/final 三段式消息格式。

---

## 验证 plugin 工作

```bash
# 触发一个 ACP 任务后，检查 task-log
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```

你应该看到类似输出：
```json
{"taskId":"tsk_20260312120000_abc123","agentId":"main","runtime":"acp","task":"分析报告...","spawnedAt":"2026-03-12T12:00:00.000Z","status":"spawning"}
```

---

## 首次派单测试

### 短任务（< 10 秒）

```text
[Request] ack_id=test-001 | topic=测试短任务 | ask=回复"收到" | due=1 分钟

预期流程：
1. Agent 回复 [ACK] ack_id=test-001 state=confirmed
2. Agent 执行
3. Agent 回复 [Final] ack_id=test-001 state=final
```

### 长任务（> 10 秒）

```text
[Request] ack_id=test-002 | topic=测试长任务 | ask=执行后台任务 | due=5 分钟

预期流程：
1. 接收方回复 ACK
2. sessions_spawn (plugin 自动记录 + 注入回调)
3. ACP 完成后 sessions_send 回推结果
4. completion-listener 推送通知
```

---

## 故障排查

### 任务完成但没收到通知

```bash
# 1. plugin 是否加载？
openclaw plugins list | grep spawn-interceptor

# 2. task-log 是否有记录？
tail -20 ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl

# 3. completion-listener 是否在运行？
grep completion /tmp/completion-relay.log | tail -10

# 4. Gateway 错误日志
tail -20 ~/.openclaw/logs/gateway.err.log | grep spawn-interceptor
```

### 常见错误

| 症状 | 原因 | 修复 |
|------|------|------|
| plugin 未加载 | 缺少 `openclaw.plugin.json` | 确认 `plugins/spawn-interceptor/` 包含所有文件 |
| hooks 未注册 | `register()` 导出格式不对 | 检查 `index.js` 使用 `module.exports = { register(api) {...} }` |
| task-log 无记录 | plugin 未拦截 | 确认 Gateway 重启后日志显示 "hooks registered" |
| ACP 完成无通知 | prompt 注入的回调未执行 | 检查 ACP Agent 是否有 `sessions_send` 权限 |

---

## 验证清单

- [ ] `openclaw plugins list` 显示 spawn-interceptor 为 loaded
- [ ] Gateway 日志显示 "spawn-interceptor: hooks registered"
- [ ] `python3 -m pytest examples/completion-relay/tests/ -v` 全部通过
- [ ] 所有 Agent 已阅读 AGENT_PROTOCOL.md
- [ ] 必要目录已创建（`shared-context/{job-status,monitor-tasks,...}`）
- [ ] 首次短任务派单测试通过
- [ ] completion-listener cron 已配置

---

## 下一步

1. **阅读完整协议** → [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md)
2. **理解架构** → [ARCHITECTURE.md](ARCHITECTURE.md)
3. **能力分层** → [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md)（L1/L2/L3 区分）
4. **通信层设计** → [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md)（核心设计文档）
5. **踩坑避雷** → [ANTIPATTERNS.md](ANTIPATTERNS.md)

---

*最后更新：2026-03-12*
