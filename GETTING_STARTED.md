# 开源接入指引

> Version: 2026-03-12-v1  
> 目标：帮助外部用户以最小成本引入本框架

---

## 快速决策树

```
你是哪种情况？
│
├─ A. 刚开始用 OpenClaw，还没配置多 Agent
│   └─ → 先掌握 L1 默认能力，再引入本框架
│
├─ B. 已有 2-3 个 Agent，协作混乱
│   └─ → 优先引入 ACK 守门 + handoff 模板
│
├─ C. 已有 5+ Agent，需要规范化
│   └─ → 完整引入 L2 增强能力
│
└─ D. 遇到特定问题（如任务追踪/异步执行）
    └─ → 针对性引入 task-watcher + 状态落盘
```

---

## 最小可用集合（MVP）

**适用**：所有团队  
**引入成本**：约 30 分钟  
**核心收益**：统一协作语言，减少沟通混乱

### 1. ACK 守门协议

**位置**：`AGENT_PROTOCOL.md` 第 4 章

**核心规则**：
```
收到正式消息 → 3 秒内必须 ACK → ACK 后才执行实际工作
```

**模板**：
```text
[ACK] ack_id=<原请求 ID> state=confirmed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【处理人】<agent 名>
【处理方式】<简述做法>
【预计完成】<时间>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**为什么优先**：
- ✅ 无需代码实现
- ✅ 立即减少"已读不回"问题
- ✅ 建立基本协作节奏

### 2. handoff 标准模板

**位置**：`AGENT_PROTOCOL.md` 附录 A

**核心结构**：
```text
[Request] ack_id=<唯一 ID> | topic=<主题>
【任务】<要做什么>
【背景】<为什么做>
【预期输出】<交付物形式>
【验收标准】<什么算完成>
【失败回退】<超时/失败怎么处理>
```

**为什么优先**：
- ✅ 无需代码实现
- ✅ 减少需求歧义
- ✅ 便于后续追溯

### 3. 每日反思→次日落地

**位置**：`AGENT_PROTOCOL.md` 第 7 章

**核心动作**：
```bash
# 每天创建 follow-up 文件
mkdir -p ~/.openclaw/shared-context/followups/
cat > ~/.openclaw/shared-context/followups/$(date +%Y-%m-%d).md << 'EOF'
# Follow-ups for TODAY

| 事项 | Priority | Owner | 状态 | 证据路径 |
|------|----------|-------|------|----------|
| <事项> | P0/P1 | <owner> | pending/done | <文件/链接> |
EOF
```

**为什么优先**：
- ✅ 避免反思写完就忘
- ✅ 强制转为实际行动
- ✅ 形成团队级记忆

### 4. 真值落盘规则

**位置**：`AGENT_PROTOCOL.md` 第 6 章

**核心规则**：
```
关键事实不能只留在聊天历史里，必须落 shared-context/*
```

**最小目录**：
```bash
mkdir -p ~/.openclaw/shared-context/{job-status,dispatches,intel,followups}
```

---

## 进阶集合（稳定后再引入）

**适用**：已稳定运行 MVP 2 周以上的团队  
**引入成本**：约 2-4 小时  
**核心收益**：自动化任务追踪，减少人工催办

### 1. task-watcher 终态播报

**位置**：内部实现 `skills/task_callback_bus/`

**功能**：
- 任务完成后自动推送通知
- 支持 completed/failed/timeout 三种终态
- 可配置 Discord/Telegram 等渠道

**引入方式**：
1. 参考 `QUICKSTART.md` 注册测试任务
2. 自行实现 watcher 或参考内部代码
3. 配置通知渠道

### 2. follow-up/dispatch bridge

**位置**：内部实现 `terminal_bridge.py`

**功能**：
- 任务完成后自动生成下一步待办
- 写入 `followups/` 或 `dispatches/`
- 支持 `next_action` / `next_owner` 元数据

**引入方式**：
1. 先有 task-watcher 基础
2. 参考 `taskwatcher-followup-bridge-20260312.md` 报告
3. 自行实现桥接逻辑

### 3. Discord 单帖状态面板

**位置**：内部实现 `discord_task_panel.py`

**功能**：
- 单条 Discord 消息持续 edit 更新
- 显示 running/completed/superseded 统计
- 支持内容哈希去重 + 节流控制

**引入方式**：
1. 先有 task-watcher 基础
2. 参考 `watcher-discord-panel-bridge-20260312.md` 报告
3. 自行实现面板脚本

### 4. Guardian 白天 warn-only

**位置**：内部实现 `heartbeat-guardian.sh`

**功能**：
- 白天活跃时段抑制 `DEGRADED:*` 重启
- 硬故障（HTTP/RPC/PID）仍保留自愈
- 减少 cron 任务被打断

**引入方式**：
1. 参考 `tsk_guardian_closure_20260312_0000.md` 报告
2. 自行修改 guardian 脚本
3. 配置 active hours

---

## L3 缺口的变通方案

| 缺口 | 变通方案 | 参考文档 |
|------|----------|----------|
| `sessions_send` timeout | 按"ambiguous success"处理，通过 watcher/状态文件追踪终态 | `CAPABILITY_LAYERS.md` 3.1 |
| 无法 fire-and-forget | 用 `sessions_spawn(mode="run")` + task-watcher 替代 | `CAPABILITY_LAYERS.md` 3.2 |
| 无法全局查 ACK | 自建 `ack-state-bridge.py` 本地桥接 | `AGENT_PROTOCOL.md` 11.4 |
| 无法优先级插队 | 用 `timeoutSeconds` 区分紧急程度，人工介入 | `CAPABILITY_LAYERS.md` 3.4 |

---

## 分阶段引入路线图

### 第 1 周：MVP 部署

**目标**：统一协作语言

**动作**：
1. 复制框架文档到 `shared-context/`
2. 创建必要目录
3. 向团队发送协议通知
4. 开始使用 ACK/handoff/follow-up 模板

**验收标准**：
- [ ] 所有 Agent 都能正确回复 ACK
- [ ] 派单使用标准模板
- [ ] 每日 follow-up 文件正常创建

### 第 2-3 周：习惯养成

**目标**：让协议成为自然行为

**动作**：
1. 每日检查 follow-up 落地情况
2. 纠正不规范的派单/ACK
3. 收集团队反馈

**验收标准**：
- [ ] ACK 成为默认行为，无需提醒
- [ ] 派单模板使用率 >80%
- [ ] follow-up 完成率 >80%

### 第 4 周+：自动化增强

**目标**：引入 task-watcher 等自动化能力

**动作**：
1. 评估是否需要 task-watcher
2. 自行实现或参考内部代码
3. 逐步接入长任务

**验收标准**：
- [ ] 长任务 100% 注册 watcher
- [ ] 终态通知正常推送
- [ ] 状态文件规范落盘

---

## 常见引入误区

### ❌ 误区 1：一次性引入全部能力

**问题**：想一步到位，结果团队适应成本过高

**建议**：
```
MVP (第 1 周) → 习惯养成 (第 2-3 周) → 自动化 (第 4 周+)
```

### ❌ 误区 2：只引入文档，不改执行习惯

**问题**：文档很完善，但实际协作还是老样子

**建议**：
- 指定 1 人负责协议执行监督
- 每日站会检查 follow-up 落地
- 第一周适当"强制"使用模板

### ❌ 误区 3：过度设计 ACK 格式

**问题**：花太多时间讨论 ACK 模板细节

**建议**：
- 先用框架提供的模板
- 运行 1 周后再根据实际调整
- 格式一致性 > 格式完美

### ❌ 误区 4：忽视 follow-up 落地

**问题**：反思写得很认真，但次日不行动

**建议**：
- 每日 09:30 前检查 follow-up
- 未完成项必须说明 blocker
- main 负责追踪 P0 事项

---

## 检查清单

### 部署前

- [ ] OpenClaw 已安装并运行
- [ ] 至少配置 1 个以上 Agent
- [ ] Python 3.10+ 可用
- [ ] `~/.openclaw/shared-context/` 目录可写

### MVP 部署后

- [ ] `AGENT_PROTOCOL.md` 已复制到 `shared-context/`
- [ ] 必要目录已创建（job-status/dispatches/intel/followups）
- [ ] 团队已收到协议通知
- [ ] 今日 follow-up 文件已创建

### 习惯养成后

- [ ] ACK 成为默认行为
- [ ] 派单模板使用率 >80%
- [ ] follow-up 完成率 >80%
- [ ] 关键状态已落盘

---

## 获取帮助

### 文档问题

- 查看 `QUICKSTART.md` 故障排查章节
- 参考 `TEMPLATES.md` 中的完整示例
- 阅读 `CAPABILITY_LAYERS.md` 了解能力边界

### GitHub Issues

请在 https://github.com/lanyasheng/openclaw-multiagent-framework/issues 报告：
- 文档错误或不清晰
- 示例无法运行
- 缺少的使用场景
- 改进建议

### 社区支持

- OpenClaw Discord: https://discord.gg/clawd
- 本框架 Issues: 见上方链接

---

## 下一步

完成 MVP 部署后，建议：

1. **运行测试任务**：验证 watcher 注册和状态追踪
   ```bash
   bash scripts/test-framework.sh
   ```
   > **注意**：此脚本为内部实现示例，开源用户需参考 [QUICKSTART.md](QUICKSTART.md) 自行实现。

2. **阅读完整协议**：深入理解 `AGENT_PROTOCOL.md`

3. **规划进阶能力**：根据团队需求选择 L2 增强项

4. **分享反馈**：在 Issues 中分享你的引入经验
