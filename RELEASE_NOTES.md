# 发布说明

## v1.0.0 (2026-03-12)

### 首次发布

OpenClaw 多 Agent 协作框架首个开源版本，包含完整的协议文档与协作规范。

---

### 包含内容

| 文档 | 说明 |
|------|------|
| `README.md` | 框架概述与快速导航 |
| `GETTING_STARTED.md` | MVP 与进阶能力接入指引 |
| `QUICKSTART.md` | 15 分钟快速部署指南 |
| `AGENT_PROTOCOL.md` | 完整协作协议规范 |
| `ARCHITECTURE.md` | 架构设计与技术细节 |
| `TEMPLATES.md` | 派单/ACK/Final/Follow-up 模板 |
| `CAPABILITY_LAYERS.md` | L1/L2/L3 能力分层说明 |
| `INTERNAL_VS_OSS.md` | 开源包与内部运行版差异说明 |
| `CONTRIBUTING.md` | 贡献指南与提交流程 |

---

### 核心特性

- **ACK 守门协议** — 3 秒内确认，建立协作节奏
- **handoff 标准模板** — Request/ACK/Final 三段式派单
- **状态落盘机制** — `shared-context/` 真值管理
- **每日反思→次日落地** — follow-ups 文件化追踪
- **能力分层** — L1(默认)/L2(增强)/L3(需 Core 改动) 清晰分界

---

### 适用场景

- 3+ Agent 团队协作
- 需要异步任务追踪
- 任务可追溯、可审计
- 从单 Agent 向多 Agent 扩展

---

### 已知限制

- 开源包为**文档框架**，不含内部实现代码
- 需自行实现 `task-watcher` 等 L2 增强组件
- 详见 [INTERNAL_VS_OSS.md](INTERNAL_VS_OSS.md)

---

### 后续计划

- [ ] 视频教程
- [ ] 更多使用示例
- [ ] 社区最佳实践收集
- [ ] 与 OpenClaw Core L3 能力对接

---

### 反馈渠道

- GitHub Issues: https://github.com/lanyasheng/openclaw-multiagent-framework/issues
- OpenClaw Discord: https://discord.gg/clawd

---

*首次发布于 2026-03-12*
