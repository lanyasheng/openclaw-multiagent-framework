# OpenClaw 多 Agent 协作框架

> 统一、高效、可追溯的多 Agent 团队协作协议与架构模式

**Version**: 2026-03-12-v1  
**License**: MIT  
**Status**: Production Ready (内部验证) / OSS Ready (文档框架)  
**作者**: lanyasheng (OpenClaw 社区)

---

## 📖 一句话说明

这是一套**经过实战验证的 OpenClaw 多 Agent 协作框架**，把"聊天式派单"升级为**协议化、可追溯、异步优先**的团队级协作系统。

---

## 🎯 解决什么问题

| 问题 | 传统做法 | 本框架方案 |
|------|----------|------------|
| 长任务执行 | 同步等待 or 口头催办 | 后台执行 + 终态自动推送 |
| 任务状态 | 散落在聊天记录里 | 统一落盘到 `shared-context/` |
| 跨 Agent 协作 | 自由格式，难以追溯 | 标准 handoff 模板 (request/ack/final) |
| 每日反思 | 写完就忘，次日不落地 | 强制转成 `followups/YYYY-MM-DD.md` |
| 真值管理 | 依赖聊天历史 | 状态文件 + 报告文件双落盘 |

---

## 🚀 5 分钟快速开始

### 前置条件

- OpenClaw 已安装并运行
- 至少配置 1 个以上 Agent
- Python 3.10+

### 5 步部署

```bash
# 1. 克隆框架
git clone https://github.com/lanyasheng/openclaw-multiagent-framework.git
cd openclaw-multiagent-framework

# 2. 复制到你的 shared-context 目录
cp -r * ~/.openclaw/shared-context/

# 3. 创建必要目录
mkdir -p ~/.openclaw/shared-context/{job-status,monitor-tasks,dispatches,intel,followups}

# 4. 阅读接入指引，了解 MVP 与进阶能力
open GETTING_STARTED.md
```

详细部署指南见 [QUICKSTART.md](QUICKSTART.md) 和 [GETTING_STARTED.md](GETTING_STARTED.md)。

---

## 📚 文档导航

| 文档 | 用途 | 阅读顺序 |
|------|------|----------|
| `README.md` | 框架说明（本文档） | 1 |
| `GETTING_STARTED.md` | 接入指引（MVP / 进阶集合） | 2 |
| `QUICKSTART.md` | 15 分钟快速部署指南 | 3 |
| `INTERNAL_VS_OSS.md` | 开源包 vs 内部运行版差异 | 4 |
| `AGENT_PROTOCOL.md` | 完整协议规范 | 5 |
| `ARCHITECTURE.md` | 架构设计和技术细节 | 6 |
| `TEMPLATES.md` | 消息和文件模板 | 7 |
| `CAPABILITY_LAYERS.md` | 能力分层表 (L1/L2/L3) | 8 |
| `CONTRIBUTING.md` | 贡献方式与提交流程 | 9 |

---

## 🏗️ 核心架构

```
┌─────────────────────────────────────────────────────────┐
│                   控制面 (Control Plane)                 │
│              sessions_send - 派单/ACK/结论               │
└─────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│   异步回执面               │   │     共享状态面             │
│   task-watcher            │   │     shared-context/*      │
│   后台执行 + 终态推送       │   │     状态文件 + 报告文件    │
└───────────────────────────┘   └───────────────────────────┘
```

### 三层分工

1. **控制面**：`sessions_send` 用于短任务和正式通信
2. **异步回执面**：`task-watcher` 用于长任务后台执行
3. **共享状态面**：`shared-context/*` 用于状态落盘和真值管理

---

## 📦 开源范围说明

### 包含内容

| 文件 | 说明 |
|------|------|
| `AGENT_PROTOCOL.md` | 统一协作协议（脱敏版） |
| `ARCHITECTURE.md` | 架构说明 + Mermaid 图表 |
| `QUICKSTART.md` | 15 分钟快速部署指南 |
| `TEMPLATES.md` | 派单/ACK/Final/Follow-up 模板 |
| `CAPABILITY_LAYERS.md` | 能力分层表 (L1/L2/L3) |
| `README.md` | 本文件 |

### 脱敏规则

以下信息已从原始协议中移除：

| 类型 | 替换方式 |
|------|----------|
| Discord Channel ID | `<channel-id>` |
| Session Key | `agent:<name>:<transport>:<channel>` |
| Agent ID | `agent:<name>:...` |
| 具体 Cron ID | `<cron-id>` |
| 具体文件路径 | `~/.openclaw/...` |

### 不包含内容

- ❌ 具体 Agent 角色定义（trading/macro/ainews 等）
- ❌ 具体业务逻辑和数据处理规则
- ❌ 团队内部 runbook 和 SOP
- ❌ 密钥、配置等敏感信息

---

## 🎯 适用场景

- ✅ 多 Agent 团队协作（3+ Agent）
- ✅ 需要异步任务执行和状态追踪
- ✅ 要求任务可追溯、可审计
- ✅ 希望建立统一的协作规范
- ✅ 计划从单 Agent 扩展到多 Agent

### 不太适合

- ❌ 单 Agent 场景（过度设计）
- ❌ 不需要任务追踪的临时协作
- ❌ 已有成熟协作协议的团队

---

## 🔧 能力分层

### L1: OpenClaw 默认自带（8 项）

- `sessions_send` / `sessions_spawn` / `message` 工具
- Discord 频道绑定 / cron 定时任务
- 基础 session 管理 / 工具调用机制 / Gateway 健康检查

### L2: 我们额外补的增强（12 项）

**协作协议层**：ACK 守门、handoff 模板、交付物三层结构、单写入者规则  
**任务监控层**：task-watcher 终态播报、follow-up bridge、ACP 监控注册 SOP  
**展示层**：Discord 单帖状态面板、watcher→panel 自动桥  
**治理层**：每日反思→次日落地、Guardian 白天 warn-only

### L3: 需要改 OpenClaw Core（4 项）

- `sessions_send` 返回值语义拆分
- Fire-and-forget 模式
- 全局 ACK 状态服务
- Session Lane 优先级

详见 [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md)。

---

## 📝 使用示例

### 示例 1：短任务派单

```text
[Request] ack_id=20260312-001 | topic=AI 新闻 | ask=生成摘要 | due=18:00

期望：5-10 条重要新闻，含标题 + 链接 + 摘要
```

### 示例 2：长任务异步执行

```text
[Request] ack_id=20260312-002 | topic=市场分析 | ask=深度报告 | due=明日

执行流程：
1. 接收方回复 ACK
2. 注册 task-watcher
3. sessions_spawn(mode="run") 后台执行
4. 完成后写 status_file + report_file
5. watcher 推送 terminal 通知
```

### 示例 3：每日 Follow-up

```markdown
# Follow-ups for 2026-03-12

| 事项 | Priority | Owner | 状态 | 证据路径 |
|------|----------|-------|------|----------|
| 框架部署 | P0 | main | done | shared-context/ |
| 晨报发布 | P0 | trading | done | knowledge/daily/ |
```

---

## 🔍 内部运行版 vs 开源包

| 维度 | 内部运行版 | 开源包 |
|------|------------|--------|
| 定位 | 完整生产系统 | 脱敏文档框架 |
| 包含内容 | 全部实现代码 + 配置 | 协议文档 + 模板 |
| Agent 角色 | trading/macro/ainews 等 | 通用角色模板 |
| 业务逻辑 | 完整金融/交易规则 | 脱敏示例 |
| 可直接运行 | ✅ 是 | ⚠️ 需适配 |

**重要**：开源包是"可迁移的协作规范"，不是"内部运行的完整导出"。

---

## 🛣️ 路线图

### 已完成（2026-03-12）

- ✅ 核心协议文档（AGENT_PROTOCOL / ARCHITECTURE / TEMPLATES）
- ✅ 快速部署指南（QUICKSTART）
- ✅ 能力分层表（CAPABILITY_LAYERS）
- ✅ 测试验证脚本
- ✅ 故障排查指南

### 计划中

- [ ] 视频教程
- [ ] 更多使用示例
- [ ] 社区最佳实践
- [ ] 与 OpenClaw Core 的 L3 能力对接

---

## 📁 仓库结构

```text
openclaw-multiagent-framework/
├── README.md
├── RELEASE_NOTES.md
├── QUICKSTART.md
├── GETTING_STARTED.md
├── INTERNAL_VS_OSS.md
├── AGENT_PROTOCOL.md
├── ARCHITECTURE.md
├── TEMPLATES.md
├── CAPABILITY_LAYERS.md
├── CONTRIBUTING.md
├── .github/ISSUE_TEMPLATE/
└── scripts/test-framework.sh
```

---

## 🤝 贡献指南

完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 报告问题

请在 GitHub Issues 中报告：
- 文档错误或不清晰
- 示例无法运行
- 缺少的使用场景
- 改进建议

### 提交 PR

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交变更 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

---

## 📬 联系方式

- **GitHub**: [@lanyasheng](https://github.com/lanyasheng)
- **OpenClaw**: https://openclaw.ai
- **社区**: https://discord.gg/clawd

---

## 🙏 致谢

本框架基于 OpenClaw 社区的最佳实践，吸收了以下项目的思想：

- [hermes-agent](https://github.com/...) - Agent 通信协议
- [agency-agents](https://github.com/...) - 多 Agent 编排模式
- OpenClaw 官方文档

感谢所有贡献者！
