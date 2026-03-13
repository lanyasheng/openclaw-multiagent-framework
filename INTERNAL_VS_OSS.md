# 开源包 vs 内部运行版差异说明

> Version: 2026-03-13-v3
> 目标：明确告知外部用户开源包与内部实际运行版本的区别

---

## 核心结论

**开源包提供完整的四层完成检测链路 + 协作协议框架。内部版在此基础上有更多业务实现。**

| 维度 | 开源包 | 内部运行版 |
|------|--------|------------|
| **定位** | 四层完成链路 + 协议框架 | 完整生产系统 |
| **可直接运行** | ✅ plugin + completer 可直接部署 | ✅ 完整运行 |
| **包含实现代码** | ✅ spawn-interceptor (L2) + content-aware-completer (L4) + completion-relay | ✅ 全量代码 |
| **四层链路** | ✅ 完整四层实现 | ✅ 完整四层 + 扩展 |
| **Agent 角色** | 通用模板 | trading/macro/ainews/content/butler 等业务 Agent |
| **业务逻辑** | 脱敏示例 | 完整金融/交易规则 |
| **配置信息** | 占位符 | 真实配置 |

---

## 详细差异对照

### 1. 开源包包含的可运行组件

| 组件 | 类型 | 层级 | 说明 |
|------|------|------|------|
| `plugins/spawn-interceptor/` | Node.js plugin | L2 | 自动追踪 sessions_spawn，记录 task-log |
| `examples/content-aware-completer/` | Python 脚本 | L4 | 内容证据验证，解决 Type 4 任务问题 |
| `examples/completion-relay/` | Python 脚本 | 通知 | 监听完成通知 + 更新 task-log |
| `examples/l2_capabilities.py` | Python 演示 | L2 | 6 项 L2 能力的参考实现 |
| `examples/protocol_messages.py` | Python 演示 | — | 协议消息格式验证 |

### 2. 四层完成检测链路对比

| 层级 | 开源包 | 内部版 | 差异说明 |
|------|--------|--------|----------|
| **L1: 原生事件流** | ✅ `streamTo="parent"` 支持 | ✅ 相同 | 无差异 |
| **L2: 启动登记** | ✅ spawn-interceptor | ✅ 相同 | 无差异 |
| **L3: 基础终态** | ✅ Poller + Reaper | ✅ 相同 + 自定义规则 | 内部版可配置轮询间隔 |
| **L4: 终态纠偏** | ✅ content-aware-completer | ✅ 相同 + 业务规则 | 内部版有额外业务验证 |

**关键说明**：
- 开源包的 L4 实现完全可用，解决 Type 4 任务问题
- 内部版在 L4 基础上添加了业务特定的验证规则
- 四层链路的核心逻辑（Tier 1-4 决策）保持一致

### 3. 内部版额外组件（未开源）

| 组件 | 说明 | 开源替代 |
|------|------|----------|
| `task-callback-bus/` (2,543 行) | 旧版事件驱动任务监控 (已废弃) | 四层链路（推荐） |
| `discord_task_panel.py` | Discord 面板实现 | 自行实现 |
| `terminal_bridge.py` | follow-up 桥接 | 自行实现 |
| `heartbeat-guardian.sh` | Guardian 自愈脚本 | 自行实现 |
| 业务 Agent 实现 | trading/macro/ainews 等 | 基于模板自行开发 |

### 4. 配置与密钥

| 类型 | 开源包 | 内部版 |
|------|--------|--------|
| Channel ID | `<channel-id>` | 真实 Discord ID |
| API 密钥 | 不包含 | 真实密钥（本地存储） |
| Gateway 配置 | 示例说明 | 真实 `openclaw.json` |
| 业务配置 | 占位符 | 真实交易规则、风控参数 |

---

## 开源包能力边界

### ✅ 开源包已包含

1. **四层完成检测链路**（完整实现）
   - L2: spawn-interceptor plugin
   - L3: ACP Session Poller + Stale Reaper
   - L4: content-aware-completer

2. **协作协议框架**
   - ACK 守门协议
   - Handoff 标准模板
   - 真值落盘规范
   - 反思闭环流程

3. **基础工具**
   - completion-relay 监听器
   - L2 能力演示代码
   - 协议消息格式验证

### ❌ 开源包不包含

1. **业务 Agent 实现**
   - trading-agent 交易逻辑
   - macro-agent 宏观分析
   - ainews-agent 新闻追踪
   - content-agent 内容生成

2. **业务特定组件**
   - Discord 任务面板
   - 交易风控系统
   - 数据源接入（交易所 API）
   - 业务特定的 L4 验证规则

3. **生产环境配置**
   - 真实 API 密钥
   - 生产监控告警
   - 自动扩缩容配置

---

## 外部用户如何使用

### 推荐路径

```
1. 阅读 README.md → 理解四层链路架构
2. 安装 spawn-interceptor plugin → 启用 L2
3. 部署 content-aware-completer → 启用 L4
4. 学习 AGENT_PROTOCOL.md → 理解协议规范
5. 运行测试 → 确认组件正常（含 L4 测试）
```

### 快速开始

```bash
# 1. 安装 L2（启动登记层）
cp -r plugins/spawn-interceptor ~/.openclaw/extensions/
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 2. 运行 L4（终态纠偏层）
cd examples/content-aware-completer
python3 content_aware_completer.py --once --dry-run

# 3. 运行测试
python3 -m pytest tests/ -v
```

---

## 常见问题

### Q1: 开源包能直接运行吗？

**A**: 可以。plugin 和 content-aware-completer 可以直接部署：
- L2 (spawn-interceptor) 自动拦截任务
- L4 (content-aware-completer) 验证完成状态
- 协议文档需要根据你的团队适配

### Q2: 开源包的四层链路完整吗？

**A**: 是的。开源包包含完整的四层实现：
- L1: 依赖 OpenClaw 原生 `streamTo="parent"`
- L2: spawn-interceptor plugin（完整）
- L3: Poller + Reaper（完整）
- L4: content-aware-completer（完整）

内部版只在 L4 上添加了业务特定的扩展，核心逻辑一致。

### Q3: 还需要自建 task-watcher 吗？

**A**: 不需要。四层链路替代了旧的文件轮询 watcher：
- L2: Hook 自动登记（替代手动注册）
- L3: Poller 检测终态（替代定时扫描）
- L4: 内容验证（替代简单状态判断）

### Q4: content-aware-completer 是什么？

**A**: L4 终态纠偏层，解决"第4类任务"问题：
- 检测任务是否真的完成（不只是会话关闭）
- 验证内容证据（文件大小、关键词）
- 拒绝历史文件、空文件
- 四层决策：Tier 1-4

### Q5: 开源包会更新吗？

**A**: 会。更新节奏：
- 通信层 plugin：随 OpenClaw API 变化更新
- content-aware-completer：随实际使用反馈优化
- 协议文档：随最佳实践积累更新
- 测试：持续完善

---

## 版本对齐

| 版本 | 日期 | 内容 |
|------|------|------|
| v1 | 2026-03-12 | 首次发布：协议文档 + 文档框架 |
| v2 | 2026-03-12 | 通信层重设计：spawn-interceptor plugin + completion-relay |
| v3 | 2026-03-13 | 四层链路完成：新增 content-aware-completer (L4) |

---

## 反馈与建议

如果你在使用过程中发现问题，请在 GitHub Issues 中反馈。
