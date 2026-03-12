# OpenClaw 多 Agent 协作框架 — 快速开始指南

<!-- 阅读顺序: 2/5 -->
<!-- 前置: README.md -->
<!-- 后续: AGENT_PROTOCOL.md -->

> Version: 2026-03-12-v1
> 适用对象：已有 OpenClaw 部署，想要引入多 Agent 协作规范

---

## 前置条件

| 依赖 | 版本 | 检查命令 |
|------|------|----------|
| Python | 3.10+ | `python3 --version` |
| OpenClaw Gateway | 运行中 | `launchctl list | grep openclaw` |
| 目录权限 | 可写 | `mkdir -p ./shared-context && touch ./shared-context/.test` |

**所需 Python 包**（框架本身不依赖，但示例脚本可能需要）：
```bash
pip3 install pydantic  # 如果需要运行验证脚本
```

---

## 5 分钟快速部署

### 步骤 1：创建必要目录（1 分钟）

```bash
# 设置框架根目录（根据你的部署调整）
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

mkdir -p $FRAMEWORK_HOME/shared-context/{job-status,monitor-tasks,dispatches,intel,followups,archive/protocol-history}
```

### 步骤 2：复制框架文档（1 分钟）

```bash
# 假设你已克隆本仓库到 openclaw-multiagent-framework/
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

cp -r openclaw-multiagent-framework/* \
      $FRAMEWORK_HOME/shared-context/
```

### 步骤 3：配置你的 Agent 团队（3 分钟）

编辑 `$FRAMEWORK_HOME/shared-context/AGENT_PROTOCOL.md`，替换为你的团队配置：

```markdown
## 你的 Agent 团队示例

| Agent | 职责 | Channel |
|-------|------|---------|
| main | 协调与决策 | #general |
| research | 信息搜集 | #research |
| writing | 内容创作 | #writing |
| review | 质量审查 | #review |
```

---

## 完整可运行示例

### 示例：注册并监控一个后台任务

> **注意**：以下示例展示框架概念。开源用户需自行实现 `register_generic_task.py` 或参考 `examples/task_state_machine.py`。

```bash
#!/bin/bash
# save as: test-framework.sh

set -e

# ========== 配置 ==========
# 设置框架根目录（根据你的部署调整）
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

TASK_ID="test_task_$(date +%s)"
STATUS_FILE="$FRAMEWORK_HOME/shared-context/job-status/${TASK_ID}.json"
OUTPUT_FILE="$FRAMEWORK_HOME/shared-context/job-status/${TASK_ID}-report.md"
TASKS_FILE="$FRAMEWORK_HOME/shared-context/monitor-tasks/tasks.jsonl"

echo "📝 Task ID: $TASK_ID"
echo "📝 Status File: $STATUS_FILE"
echo "📝 Output File: $OUTPUT_FILE"

# ========== 1. 注册任务 ==========
echo ""
echo "🔧 Step 1: Registering task..."

# 注：以下命令为内部实现示例，开源用户需自行开发
# python3 $FRAMEWORK_HOME/skills/task_callback_bus/scripts/register_generic_task.py \
#   --task-id "$TASK_ID" \
#   --task-type sessions_spawn \
#   --status-file "$STATUS_FILE" \
#   --output-file "$OUTPUT_FILE" \
#   --reply-to "user:main" \
#   --owner main \
#   --task-subject "框架测试任务" \
#   --silent-until-terminal

# 模拟任务注册（实际使用时替换为真实的任务注册逻辑）
echo "{\"task_id\": \"$TASK_ID\", \"state\": \"registered\"}" >> "$TASKS_FILE"

# ========== 2. 验证注册成功 ==========
echo ""
echo "🔍 Step 2: Verifying registration..."

if grep -q "\"task_id\": \"$TASK_ID\"" "$TASKS_FILE"; then
    echo "✅ Task registered successfully"
else
    echo "❌ Task registration failed"
    exit 1
fi

# ========== 3. 模拟 ACP worker 写状态 ==========
echo ""
echo "🔧 Step 3: Simulating worker writing status..."

cat > "$STATUS_FILE" << 'EOF'
{
  "state": "started",
  "started_at": "2026-03-12T12:00:00",
  "summary": "任务已启动"
}
EOF

echo "✅ Status file written: started"

sleep 2

# 模拟任务进行中
cat > "$STATUS_FILE" << EOF
{
  "state": "in_progress",
  "updated_at": "2026-03-12T12:00:05",
  "summary": "任务执行中..."
}
EOF

echo "✅ Status file updated: in_progress"

sleep 2

# 模拟任务完成
cat > "$STATUS_FILE" << EOF
{
  "state": "completed",
  "completed_at": "2026-03-12T12:00:10",
  "summary": "任务已完成",
  "report_file": "$OUTPUT_FILE"
}
EOF

echo "✅ Status file written: completed"

# 写入报告文件
cat > "$OUTPUT_FILE" << EOF
# Task Report: $TASK_ID

## 基本信息
- **Task ID**: $TASK_ID
- **Status**: completed
- **Owner**: main

## 执行摘要
这是一个框架测试任务，用于验证监控和通知链路是否正常工作。

## 验证结果
- [x] 任务注册成功
- [x] 状态文件写入正常
- [x] 报告文件生成成功
EOF

echo "✅ Report file written"

# ========== 4. 验证终态可检测 ==========
echo ""
echo "🔍 Step 4: Verifying terminal state..."

STATE=$(cat "$STATUS_FILE" | grep -o '"state": "[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$STATE" = "completed" ]; then
    echo "✅ Terminal state detected: completed"
else
    echo "❌ Unexpected state: $STATE"
    exit 1
fi

# ========== 5. 总结 ==========
echo ""
echo "🎉 All tests passed!"
echo ""
echo "📋 Summary:"
echo "   Task ID: $TASK_ID"
echo "   Status File: $STATUS_FILE"
echo "   Report File: $OUTPUT_FILE"
echo ""
echo "📋 故障排查时查看:"
echo "   - 任务注册: $FRAMEWORK_HOME/shared-context/monitor-tasks/tasks.jsonl"
echo "   - Watcher 日志: $FRAMEWORK_HOME/shared-context/monitor-tasks/watcher.log"
echo "   - 通知记录: $FRAMEWORK_HOME/shared-context/monitor-tasks/notifications/"
```

**运行方法：**
```bash
chmod +x test-framework.sh
./test-framework.sh
```

> **重要提示**：此示例脚本展示框架概念，不依赖内部实现。开源用户需自行开发 `register_generic_task.py` 或参考 `examples/task_state_machine.py` 中的状态管理示例。详见 [INTERNAL_VS_OSS.md](INTERNAL_VS_OSS.md)。

---

## 状态文件 Schema

### 最小状态文件（JSON）

```json
{
  "state": "completed",
  "summary": "任务已完成"
}
```

### 完整状态文件 Schema

```json
{
  "task_id": "task-YYYYMMDD-NNN",
  "state": "completed | failed | timeout | running | started",
  "summary": "简短描述（用于通知）",
  "report_file": "报告文件路径",
  "error": "错误信息（如果有）",
  "started_at": "2026-03-12T12:00:00",
  "completed_at": "2026-03-12T12:05:00",
  "metadata": {
    "任意": "自定义字段"
  }
}
```

### 状态值说明

| 状态 | 说明 | 是否终态 |
|------|------|----------|
| `started` | 任务已启动 | 否 |
| `running` | 运行中 | 否 |
| `in_progress` | 执行中 | 否 |
| `completed` | 已完成 | ✅ 是 |
| `failed` | 失败 | ✅ 是 |
| `timeout` | 超时 | ✅ 是 |

---

## 故障排查指南

### 症状：任务完成但没有收到通知

#### 排查步骤 1：检查任务是否注册成功

```bash
# 设置框架根目录（根据你的部署调整）
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

# 在 tasks.jsonl 中查找任务
TASK_ID="your_task_id"
grep "\"task_id\": \"$TASK_ID\"" $FRAMEWORK_HOME/shared-context/monitor-tasks/tasks.jsonl

# 应该看到包含 task_id 的 JSON 行
# 如果没有输出，说明注册失败
```

#### 排查步骤 2：检查 status_file 是否存在且格式正确

```bash
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

TASK_ID="your_task_id"
cat $FRAMEWORK_HOME/shared-context/job-status/${TASK_ID}.json

# 应该包含 {"state": "completed"} 或 {"state": "failed"}
# 如果文件不存在或格式错误，watcher 无法检测到终态
```

#### 排查步骤 3：检查 watcher 日志

```bash
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

# 查看 watcher 运行日志
tail -50 $FRAMEWORK_HOME/shared-context/monitor-tasks/watcher.log

# 查找与你的 task_id 相关的日志
```

#### 排查步骤 4：检查通知是否已生成

```bash
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

# 查看通知目录
ls -la $FRAMEWORK_HOME/shared-context/monitor-tasks/notifications/ | grep "$TASK_ID"

# 如果存在对应的通知文件，说明 watcher 已工作，问题可能在推送环节
```

#### 排查步骤 5：验证任务注册脚本

```bash
# 确认 register_generic_task.py 存在（需自行实现）
# 示例路径（根据你的部署调整）：
ls -la $FRAMEWORK_HOME/skills/task_callback_bus/scripts/register_generic_task.py

# 如果不存在，需自行开发或参考 examples/task_state_machine.py
```

### 常见错误及修复

| 错误 | 症状 | 修复 |
|------|------|------|
| 路径错误 | `No such file or directory` | 使用 `task_callback_bus`（下划线），不是 `task-callback-bus` |
| 缺少 `--task-subject` | 任务难以辨识 | 注册时添加 `--task-subject "描述"` |
| status_file 不存在 | watcher 不推送 | 确保 ACP worker 写入 status_file |
| state 格式错误 | watcher 检测不到终态 | 使用 `"state": "completed"`，不是 `"status": "done"` |
| reply-to 格式错误 | 通知发送失败 | 使用 `"user:main"` 或 `"channel:123456"` |

### 手动触发通知测试

```bash
# 如果怀疑 watcher 有问题，可以手动模拟通知
export FRAMEWORK_HOME=${FRAMEWORK_HOME:-~/.openclaw}

cat > $FRAMEWORK_HOME/shared-context/monitor-tasks/notifications/test_$(date +%s).json << EOF
{
  "task_id": "test_manual",
  "state": "completed",
  "summary": "手动测试通知",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

---

## 首次派单测试

### 测试场景：短任务（<= 10 秒）

```text
[Request] ack_id=test-001 | topic=测试短任务 | ask=回复"收到" | due=1 分钟

测试目的：验证 ACK 机制和 sessions_send 通信
预期流程：
1. Agent 收到请求
2. Agent 回复 [ACK] ack_id=test-001 state=confirmed
3. Agent 执行（回复"收到"）
4. Agent 回复 [Final] ack_id=test-001 state=final
```

### 测试场景：长任务（> 10 秒）

```text
[Request] ack_id=test-002 | topic=测试长任务 | ask=执行后台任务并回推结果 | due=5 分钟

测试目的：验证 task-watcher 异步执行机制
预期流程：
1. 接收方回复 [ACK] ack_id=test-002 state=confirmed
2. 注册 task-watcher（使用上面的示例脚本）
3. sessions_spawn(mode="run") 启动后台任务
4. 任务完成后写 status_file + report_file
5. task-watcher 推送 terminal 通知
```

---

## 验证清单

部署完成后，验证以下项目：

- [ ] 所有 Agent 已阅读协议
- [ ] 必要目录已创建
- [ ] 首次任务注册测试通过
- [ ] 首次异步任务测试通过
- [ ] 状态文件终态检测正常
- [ ] 通知推送功能正常
- [ ] Follow-up 文件已创建
- [ ] 团队配置已更新

---

## 下一步

完成快速部署后：

1. **阅读完整协议**：[AGENT_PROTOCOL.md](AGENT_PROTOCOL.md)
2. **理解架构设计**：[ARCHITECTURE.md](ARCHITECTURE.md)
3. **使用模板派单**：[TEMPLATES.md](TEMPLATES.md)
4. **建立团队规范**：根据业务调整阈值和流程
5. **持续改进**：记录经验到 `.learnings/`

---

*最后更新：2026-03-12*
