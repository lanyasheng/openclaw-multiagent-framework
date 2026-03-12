# 开源接入指引

> Version: 2026-03-12-v2
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
│   └─ → 优先引入 ACK 守门 + handoff 模板 + spawn-interceptor plugin
│
├─ C. 已有 5+ Agent，需要规范化
│   └─ → 完整引入通信层 + L2 增强能力
│
└─ D. 遇到特定问题（如 ACP 任务没通知/timeout 歧义）
    └─ → 针对性引入 spawn-interceptor + completion-listener
```

---

## 最小可用集合（MVP）

**适用**：所有团队
**引入成本**：约 30 分钟
**核心收益**：统一协作语言，自动追踪 ACP 任务

### 1. 安装 spawn-interceptor plugin

```bash
cp -r plugins/spawn-interceptor ~/.openclaw/extensions/
# 重启 Gateway
```

**为什么优先**：
- ✅ 零认知负担——Agent 不需要改变行为
- ✅ 自动追踪所有 `sessions_spawn` 调用
- ✅ ACP 任务自动注入完成回调

### 2. 部署 completion-listener

```bash
# cron 每分钟运行
*/1 * * * * cd /path/to/examples/completion-relay && python3 completion_listener.py --once >> /tmp/completion-relay.log 2>&1
```

**为什么优先**：
- ✅ 接收 ACP 任务的完成通知
- ✅ 更新 task-log 状态
- ✅ 可扩展到 Discord/Telegram 通知

### 3. ACK 守门协议

**位置**：`AGENT_PROTOCOL.md` 第 4 章

**核心规则**：
```
收到正式消息 → 3 秒内必须 ACK → ACK 后才执行实际工作
```

**为什么优先**：
- ✅ 无需代码实现
- ✅ 立即减少"已读不回"问题
- ✅ 建立基本协作节奏

### 4. handoff 标准模板

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

---

## 进阶集合（稳定后再引入）

**适用**：已稳定运行 MVP 2 周以上的团队

### 1. 每日反思→次日落地

**位置**：`AGENT_PROTOCOL.md` 第 7 章

```bash
mkdir -p ~/.openclaw/shared-context/followups/
```

### 2. 真值落盘规则

**位置**：`AGENT_PROTOCOL.md` 第 6 章

```bash
mkdir -p ~/.openclaw/shared-context/{job-status,dispatches,intel,followups}
```

### 3. 协作模板

**位置**：`TEMPLATES.md`

标准化 Request/ACK/Final/Follow-up 消息格式。

---

## 常见引入误区

> 更多真实踩坑案例见 [ANTIPATTERNS.md](ANTIPATTERNS.md)

### ❌ 误区 1：用文件轮询代替 plugin hook

**问题**：自建 cron 每 5 分钟扫描状态文件来追踪任务

**建议**：安装 spawn-interceptor plugin，系统自动追踪

### ❌ 误区 2：文档约束代替系统约束

**问题**：在协议文档中要求 Agent "记住用 wrapper"

**建议**：用 before_tool_call hook 自动拦截，Agent 继续用原生工具

### ❌ 误区 3：一次性引入全部能力

**问题**：想一步到位，团队适应成本过高

**建议**：
```
MVP (第 1 周) → 习惯养成 (第 2-3 周) → 全量能力 (第 4 周+)
```

---

## 检查清单

### 部署前

- [ ] OpenClaw >= 2026.3.x 已安装并运行
- [ ] spawn-interceptor plugin 已安装并 loaded
- [ ] completion-listener cron 已配置
- [ ] Python 3.10+ 可用

### MVP 部署后

- [ ] `AGENT_PROTOCOL.md` 已通知团队
- [ ] 必要目录已创建
- [ ] 触发 ACP 任务后 task-log.jsonl 有记录
- [ ] 所有测试通过（50 个）

---

## 获取帮助

- GitHub Issues: https://github.com/lanyasheng/openclaw-multiagent-framework/issues
- OpenClaw Discord: https://discord.gg/clawd

---

## 下一步

1. **运行测试**：验证所有组件正常
   ```bash
   cd examples/completion-relay && python3 -m pytest tests/ -v
   cd examples && python3 -m pytest tests/test_l2_capabilities.py -v
   ```

2. **阅读完整协议**：深入理解 `AGENT_PROTOCOL.md`

3. **阅读设计方案**：理解 [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md)
