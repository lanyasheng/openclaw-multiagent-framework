# 反模式速查（Anti-Patterns）

> Version: 2026-03-14-v3
> 目标：帮助 Agent 和用户避免已知的协作陷阱

---

## 目录

| # | 反模式 | 严重度 | 推荐方案 |
|---|--------|--------|----------|
| 1 | sessions_send 当同步 RPC | P0 | ACK 守门 |
| 2 | 不带 ack_id | P0 | 强制带 ID |
| 3 | 裸 sessions_spawn（旧版注意） | P1 | spawn-interceptor 自动拦截 |
| 4 | timeout 推断执行状态 | P0 | 查 task-log |
| 5 | 两条 final | P1 | 单 Final 规则 |
| 6 | 只在聊天说结论 | P0 | 真值落盘 |
| 7 | 反思无落地 | P1 | followups/ |
| 8 | 旧线程不停写 | P0 | 单写入者 |
| 9 | 静默超时 | P1 | 主动报告 |
| 10 | 无验收标准 | P1 | handoff 模板 |
| 11 | 文件轮询做异步编排 | P0 | plugin + 事件驱动 |
| 12 | 文档约束代替系统约束 | P0 | plugin hook |
| 13 | 用 message.send 做控制面通信 | P0 | sessions_send + sessionKey |

---

## 1. sessions_send 当同步 RPC

**症状**：发送消息后同步等待完整结果（>10 秒不回）

**问题**：阻塞当前 Agent，浪费时间

**修复**：
```
发 Request → 收 ACK → 继续做其他事 → 收 Final
```

---

## 2. 不带 ack_id

**症状**：发消息不带追踪 ID，无法关联 ACK 和 Final

**问题**：消息丢失无法检测，无法审计

**修复**：
```
[Request] ack_id=tsk_xxx | topic=<主题>
```

---

## 3. 裸 sessions_spawn

**症状**：直接调用 `sessions_spawn` 而不做任何追踪

**v2 注意**：如果已安装 `spawn-interceptor` plugin，plugin 会自动拦截并追踪，这个反模式已被系统级解决。

**如果未安装 plugin**：
- 没有任何记录
- 无法知道任务是否完成
- 无法接收完成通知

**修复**：安装 `spawn-interceptor` plugin（详见 QUICKSTART.md）

---

## 4. timeout 推断执行状态

**症状**：收到 `sessions_send` timeout 后，认为任务失败

**问题**：timeout 可能只是通信超时，任务本身可能在正常执行

**修复**：
```bash
# 检查 task-log 确认真实状态
tail -20 ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl | grep <task_id>
```

---

## 5. 两条 final

**症状**：同一个 `ack_id` 发送了两次 Final 消息

**问题**：接收方不知道以哪个为准

**修复**：Final 只发一次。需要补充信息用 Follow-up 而非重发 Final。

---

## 6. 只在聊天说结论

**症状**：任务完成后只在聊天窗口说"已完成"，不落文件

**问题**：聊天历史会丢，重启会话后无法追溯

**修复**：
```
关键结论 → shared-context/job-status/ 或 intel/
报告 → shared-context/job-status/reports/
```

---

## 7. 反思无落地

**症状**：每日反思写了"明日重点"，但第二天没有转成实际动作

**问题**：反思流于形式

**修复**：
```
反思 → followups/YYYY-MM-DD.md → 次日 09:30 前转成动作
```

---

## 8. 旧线程不停写

**症状**：任务被替代后，旧线程继续写状态文件

**问题**：状态冲突，新 owner 的状态被覆盖

**修复**：旧线程收到替代信号后必须立即停写，新 owner 声明所有权。

---

## 9. 静默超时

**症状**：承诺了"5 分钟后给结果"，到点了没有任何回复

**问题**：用户/其他 Agent 不知道发生了什么

**修复**：
```
到期前 → 发中间状态 + 未完成原因 + 新 ETA
到期后无进展 → 发 "blocked: <原因>"
```

---

## 10. 无验收标准

**症状**：派单时不说什么算完成

**问题**：做完后争论"这算不算完成"

**修复**：使用 handoff 标准模板（AGENT_PROTOCOL.md 附录 A），必含"验收标准"字段。

---

## 11. 文件轮询做异步编排

**症状**：用 cron 每 N 分钟扫描状态文件来追踪异步任务

**问题**：
- 延迟高（最坏 N 分钟）
- 代码量大（曾达 ~9,600 行）
- 行业共识：轮询做编排是反模式

**修复**：使用 `spawn-interceptor` plugin（事件驱动，< 1 分钟通知）。

**详细分析**：[COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md)

---

## 12. 文档约束代替系统约束

**症状**：在协议文档中要求 Agent "记住用 wrapper / 记住注册监控"

**问题**：
- LLM 会忘记
- 新 Agent 加入后需要培训
- 违规无法自动检测

**修复**：用 plugin hook 自动拦截，Agent 继续用原生工具。系统层保障 > 文档约束。

---

## 13. 用 message.send 做控制面通信

**症状**：用 `message.send` 或 provider channel 发送控制消息给其他 Agent

**问题**：
```
message delivered ≠ control request received
```

- 消息投递成功只表示消息到达频道
- 接收方可能因 `requireMention=true` 等配置忽略该消息
- 无 ACK 机制，无法确认控制请求被处理
- 典型故障：Discord `allowBots=mentions` 配置下，非 mention 消息不被处理

**修复**：
```
❌ 错误：用 message.send 发控制消息
   message.send(channel="#trading", text="@trading 分析BTC")

✅ 正确：用 sessions_send + sessionKey
   sessions_send(
       sessionKey="agent:trading:control",
       message="[Request] ack_id=..."
   )
```

**规则**：
- **控制面**：`sessions_send` + `sessionKey` → Agent-to-Agent 控制
- **消息面**：`message.send` / provider → 仅用户可见通知

**参考**：[AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) - 控制面 vs 消息面章节

---

## 自查清单

```
□ 所有正式消息都带 ack_id？
□ spawn-interceptor plugin 已安装并 loaded？
□ completion-listener cron 已配置？
□ 从不用 timeout 推断任务失败？
□ 关键结论都落 shared-context/？
□ 每日反思都有 followups/ 文件？
□ 没有 Agent 在用文件轮询追踪任务？
□ 没有在用 message.send 做控制面通信？
```
