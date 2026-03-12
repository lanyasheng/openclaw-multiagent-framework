# OpenClaw 多 Agent 协作框架 — 模板库

<!-- 阅读顺序: 5/5 -->
<!-- 前置: AGENT_PROTOCOL.md -->
<!-- 关联: ARCHITECTURE.md -->

> Version: 2026-03-12-v1

---

### 1. 标准派单模板（Request）

```text
[Request] ack_id=<唯一 ID> | topic=<主题> | ask=<具体要求> | due=<截止时间>

背景：<可选，简要说明背景>
期望结果：<明确描述期望的输出>
约束条件：<可选，时间/资源/质量约束>
相关链接：<可选，参考文档/数据源>
```

**示例**：
```text
[Request] ack_id=20260312-001 | topic=AI 新闻日报 | ask=生成今日 AI 领域重要新闻摘要 | due=今日 18:00

背景：每日例行 AI 情报收集
期望结果：5-10 条重要新闻，每条含标题 + 链接 + 一句话摘要
约束条件：优先关注 LLM/Agent/多模态方向
相关链接：shared-context/intel/ai-news-sources.md
```

---

### 2. ACK 确认模板

```text
[ACK] ack_id=<原请求 ID> state=confirmed | handling=<处理摘要>

预计完成时间：<可选，如与 due 不同>
执行计划：<可选，简要说明方法>
需要协作：<可选，如需其他 Agent 配合>
```

**示例**：
```text
[ACK] ack_id=20260312-001 state=confirmed | handling=AI 新闻抓取与分析

预计完成时间：今日 17:30
执行计划：并发抓取 5 个数据源 -> 去重 -> LLM 摘要
需要协作：无
```

---

### 3. 最终结论模板（Final）

```text
[Final] ack_id=<原请求 ID> state=final | result=<结果摘要>

交付物：
- <文件路径 1>
- <文件路径 2>

关键发现：
1. <发现 1>
2. <发现 2>

后续建议：<可选，下一步行动建议>
```

**示例**：
```text
[Final] ack_id=20260312-001 state=final | result=完成 12 条 AI 新闻摘要

交付物：
- shared-context/intel/ai-news-2026-03-12.md
- knowledge/daily/ai-news-summary-2026-03-12.md

关键发现：
1. OpenAI 发布新模型
2. Google 推出 Agent 新框架

后续建议：建议 trading 关注 AI 芯片相关股票
```

---

### 4. 催办模板（Follow-up）

```text
[Follow-up] ack_id=<原请求 ID> | status=checking

当前状态：等待中
已超时：<超时时长>
是否需要调整 due time 或重新派单？
```

**示例**：
```text
[Follow-up] ack_id=20260312-001 | status=checking

当前状态：等待 Final
已超时：30 分钟
是否需要调整 due time 或重新派单？请确认。
```

---

### 5. 任务替代模板（Supersede）

```text
[Supersede] ack_id=<原请求 ID> | new_ack_id=<新任务 ID>

替代原因：<说明为什么需要重新派单>
新任务范围：<说明新任务的调整>
旧任务处理：<标记为 superseded>
```

**示例**：
```text
[Supersede] ack_id=20260312-001 | new_ack_id=20260312-005

替代原因：需求范围变更，需要增加竞品分析
新任务范围：原 AI 新闻 + 竞品动态对比
旧任务处理：标记为 superseded，停止写入
```

---

## 长任务异步执行模板

### 1. 后台任务注册

```text
[Async Task Registration]
task_id: <唯一任务 ID>
task_type: <任务类型，如 sessions_spawn/exec>
task_subject: <任务主题>
status_file: <状态文件路径>
report_file: <报告文件路径>
silent_until_terminal: <true/false>
```

**示例**：
```text
[Async Task Registration]
task_id: task-20260312-001
task_type: sessions_spawn
task_subject: AI 新闻日报生成
status_file: shared-context/job-status/task-20260312-001.json
report_file: shared-context/job-status/task-20260312-001-report.md
silent_until_terminal: true
```

---

### 2. 状态文件格式（JSON）

#### 最小状态文件

```json
{
  "state": "completed",
  "summary": "任务已完成"
}
```

#### 完整状态文件 Schema

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

#### 状态值说明

| 状态 | 说明 | 是否终态 |
|------|------|----------|
| `started` | 任务已启动 | 否 |
| `running` | 运行中 | 否 |
| `in_progress` | 执行中 | 否 |
| `completed` | 已完成 | ✅ 是 |
| `failed` | 失败 | ✅ 是 |
| `timeout` | 超时 | ✅ 是 |

**注意**：`completion-listener` 和 `spawn-interceptor` 检测终态时只看 `state` 字段是否为 `completed`/`failed`/`timeout`。

---

---

### 3. 报告文件格式（Markdown）

```markdown
# Task Report: <task_id>

## 基本信息
- **Task ID**: <id>
- **Subject**: <主题>
- **Owner**: <Agent>
- **Status**: <状态>
- **Duration**: <执行时长>

## 执行摘要
<简要描述执行过程和结果>

## 交付物
- <文件路径 1>
- <文件路径 2>

## 关键发现
1. <发现 1>
2. <发现 2>

## 问题与建议
<执行中遇到的问题及后续建议>

## 数据快照
<关键数据/日志/输出片段>
```

---

## Follow-up 模板

### 1. 每日 Follow-up 文件模板

```markdown
# Follow-ups for YYYY-MM-DD

## P0 事项

| 事项 | Priority | Owner | 状态 | 来源 | 证据路径 | 备注 |
|------|----------|-------|------|------|----------|------|
| <事项 1> | P0 | <Agent> | <状态> | <来源> | <路径> | <备注> |
| <事项 2> | P0 | <Agent> | <状态> | <来源> | <路径> | <备注> |

## P1 事项

| 事项 | Priority | Owner | 状态 | 来源 | 证据路径 | 备注 |
|------|----------|-------|------|------|----------|------|
| <事项 1> | P1 | <Agent> | <状态> | <来源> | <路径> | <备注> |

## 状态说明
- pending: 尚未开始
- in_progress: 进行中
- done: 已完成
- blocked: 被阻塞（需说明原因）

## 晚间更新
<20:30 前更新当日完成情况，未完成项说明 blocker 或 rollover>
```

---

### 2. Follow-up 条目填写示例

```markdown
# Follow-ups for 2026-03-12

## P0 事项

| 事项 | Priority | Owner | 状态 | 来源 | 证据路径 | 备注 |
|------|----------|-------|------|------|----------|------|
| 框架部署 | P0 | main | done | 反思 2026-03-11 | shared-context/openclaw-multiantent-framework/ | 已完成 |
| 团队配置 | P0 | main | in_progress | 反思 2026-03-11 | AGENT_PROTOCOL.md | 配置中 |
| 晨报发布 | P0 | trading | done | 例行 | knowledge/daily/morning-brief-2026-03-12.md | 8:30 发布 |

## P1 事项

| 事项 | Priority | Owner | 状态 | 来源 | 证据路径 | 备注 |
|------|----------|-------|------|------|----------|------|
| 技能优化 | P1 | ainews | pending | 反思 2026-03-11 | - | 等待排期 |
| 文档更新 | P1 | main | in_progress | 反思 2026-03-11 | TOOLS.md | 进行中 |

## 晚间更新
- 框架部署：已完成，输出 6 个文件
- 团队配置：已完成 80%，剩余 Agent 角色定义
- 晨报发布：按时完成，无问题
- 技能优化：rollover 到 2026-03-13，等待 ainews 排期
- 文档更新：完成 TOOLS.md 更新，README.md 待完成
```

---

### 3. Follow-up Review 模板（09:00）

```markdown
# Follow-up Review for YYYY-MM-DD

## Reviewer: main
## Review Time: 09:00

## 昨日 P0/P1 完成情况

### 已完成
- <事项 1>: <证据路径>
- <事项 2>: <证据路径>

### 进行中
- <事项 1>: <当前进度>, <预计完成时间>

### 未完成/Blocked
- <事项 1>: <blocker 说明>, <解决方案>

### Rollover
- <事项 1> -> YYYY-MM-DD+1

## 今日 P0/P1 确认

### P0
1. <事项 1> - <Owner>
2. <事项 2> - <Owner>

### P1
1. <事项 1> - <Owner>
2. <事项 2> - <Owner>

## 资源与风险
- 资源需求：<说明>
- 潜在风险：<说明>
```

---

## 跨 Agent 协作模板

### 1. Intel 共享模板

```markdown
# Intel: <主题>

## 来源
- Agent: <Agent ID>
- 时间：<ISO-8601>
- 来源文件：<原始文件路径>

## 摘要
<简要描述情报内容>

## 详细内容
<详细描述>

## 相关方
- <Agent 1>: <相关性说明>
- <Agent 2>: <相关性说明>

## 建议行动
<对相关 Agent 的建议>

## 附件
- <相关文件路径>
```

---

### 2. 圆桌讨论模板

```markdown
# Roundtable: <议题>

## 主持人
- main (Zoe)

## 参与方
- <Agent 1>
- <Agent 2>
- <Agent 3>

## 议题背景
<描述讨论背景和目标>

## 讨论记录

### Round 1
- [Request] ack_id=<id> | topic=<topic> | ask=<what>
- [ACK] <Agent 1>: ack_id=<id> state=confirmed
- [ACK] <Agent 2>: ack_id=<id> state=confirmed

### Round 2
- <Agent 1 分析>: <内容>
- <Agent 2 分析>: <内容>

### 交叉评议
- 分歧点：<描述>
- 判断：<main 的判断>

## 最终结论
[Final] ack_id=<id> state=final | result=<结论>

## 后续行动
- <Action 1>: <Owner>
- <Action 2>: <Owner>
```

---

## 故障处理模板

### 1. 任务失败报告

```markdown
# Task Failure Report

## 任务信息
- Task ID: <id>
- Subject: <主题>
- Owner: <Agent>
- Failed At: <时间>

## 失败原因
<详细描述失败原因>

## 影响范围
<说明影响的任务/Agent/系统>

## 恢复方案
1. <步骤 1>
2. <步骤 2>
3. <步骤 3>

## 预防措施
<如何避免类似问题>

## 经验记录
- 记录位置：`.learnings/ERRORS.md`
- 经验 ID: `ERR-YYYYMMDD-NNN`
```

---

### 2. 状态不一致修复

```markdown
# State Inconsistency Fix

## 问题描述
<描述不一致的状态>

## 真值来源
- 文件：<shared-context 文件路径>
- 时间：<文件最后修改时间>

## 修复操作
1. <步骤 1>
2. <步骤 2>

## 验证结果
- [ ] 文件状态一致
- [ ] 聊天历史同步
- [ ] 相关方通知

## 根本原因
<分析导致不一致的原因>
```

---

## 使用指南

### 模板选择流程

```
需要派单？
├─ 短任务（<= 10 秒）→ 标准派单模板
└─ 长任务（> 10 秒）→ 异步执行模板 + 标准派单

需要确认？
└─ ACK 确认模板

完成任务？
└─ 最终结论模板

超时未回复？
└─ 催办模板

需求变更？
└─ 任务替代模板

每日反思？
└─ Follow-up 模板

跨 Agent 共享？
└─ Intel 共享模板

多 Agent 讨论？
└─ 圆桌讨论模板

任务失败？
└─ 故障处理模板
```

### 模板定制

根据团队需求调整模板：
1. 复制模板到团队目录
2. 修改字段和格式
3. 添加团队特定要求
4. 培训团队成员

---

## 最佳实践

1. **始终使用 ack_id**：所有正式消息必须带唯一 ID
2. **明确 due time**：每个请求都要有截止时间
3. **结果落文件**：重要结论必须写入 shared-context/
4. **及时更新状态**：follow-up 状态实时维护
5. **闭环后静默**：Final 后不再回复"收到/感谢"
