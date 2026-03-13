# 文档导航

> Version: 2026-03-13-v1
> 目标: 帮助新读者以正确顺序理解本框架

---

## 推荐阅读顺序

### 第一阶：入门必读（Start Here）

| 顺序 | 文档 | 解决的问题 | 阅读时间 |
|------|------|-----------|----------|
| 1 | [README.md](README.md) / [README_CN.md](README_CN.md) | 这个框架是什么、解决什么问题、核心概念 | 15 min |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) | 系统架构、四层完成检测、数据流 | 20 min |

**读完这两份，你应该理解：**
- Agent ≠ Session ≠ Thread
- 四层完成检测链路（L1-L4）
- 本框架是轻量级协调层，不是完整 Agent 运行时

---

### 第二阶：深度理解

| 顺序 | 文档 | 解决的问题 | 阅读时间 |
|------|------|-----------|----------|
| 3 | [CAPABILITY_LAYERS.md](CAPABILITY_LAYERS.md) | L1（OpenClaw原生）vs L2（框架增强）vs L3（需要核心修改） | 15 min |
| 4 | [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) | 通信问题历史、方案演化、当前架构 | 15 min |
| 5 | [CONTENT_AWARE_COMPLETER.md](CONTENT_AWARE_COMPLETER.md) / [COMPLETION_TRUTH_MATRIX.md](COMPLETION_TRUTH_MATRIX.md) | L4内容验证、运行时完成真值来源 | 15 min |

**读完这三份，你应该理解：**
- 为什么我们不用文件轮询（反模式）
- 四层架构每层解决什么问题
- 任务完成的真值来源是什么

---

### 第三阶：实现与协议

| 顺序 | 文档 | 解决的问题 | 阅读时间 |
|------|------|-----------|----------|
| 6 | [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | Agent间通信协议、ACK守门、handoff模板 | 20 min |
| 7 | [ROUNDTABLE_PROTOCOL.md](ROUNDTABLE_PROTOCOL.md) | 多Agent共享频道讨论协议（V2） | 15 min |
| 8 | [INTERNAL_VS_OSS.md](INTERNAL_VS_OSS.md) | 开源版与内部版差异、迁移路径 | 10 min |
| 9 | [QUICKSTART.md](QUICKSTART.md) / [GETTING_STARTED.md](GETTING_STARTED.md) | 快速开始、接入指引 | 15 min |

**读完这三份，你应该能：**
- 实现符合协议的Agent间通信
- 判断哪些功能在开源版可用
- 在自己的环境部署框架

---

### 参考文档（按需阅读）

| 文档 | 何时阅读 |
|------|----------|
| [TEMPLATES.md](TEMPLATES.md) | 需要标准消息模板时 |
| [ANTIPATTERNS.md](ANTIPATTERNS.md) | 避免常见错误 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 了解版本历史 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 想贡献代码时 |
| [ACP_CLOSURE_20260313.md](ACP_CLOSURE_20260313.md) | 了解ACP特定问题 |
| [ROUNDTABLE_PROTOCOL.md](ROUNDTABLE_PROTOCOL.md) | 设置多Agent共享频道讨论时 |

---

## 文档速查表

| 如果你想知道... | 读这份文档 |
|----------------|-----------|
| 这个框架是什么？ | README.md |
| 系统如何架构？ | ARCHITECTURE.md |
| 任务怎么算完成？ | COMPLETION_TRUTH_MATRIX.md |
| Agent间怎么通信？ | AGENT_PROTOCOL.md |
| 共享频道多Agent如何讨论？ | ROUNDTABLE_PROTOCOL.md |
| 能用在哪（开源vs内部）？ | INTERNAL_VS_OSS.md |
| 怎么快速开始？ | QUICKSTART.md |
| 有哪些坑要避免？ | ANTIPATTERNS.md |
| 为什么这样设计？ | COMMUNICATION_ISSUES.md |

---

## 核心概念索引

### 通信模型
- [Agent/Session/Thread 区别](README.md#core-concepts-agent--session--thread)
- [sessions_send vs sessions_spawn](README.md#sessions_send-vs-sessions_spawn)
- [上下文共享模型](README.md#context-sharing-model)

### 完成检测
- [四层完成检测架构](ARCHITECTURE.md#four-layer-completion-detection)
- [完成真值矩阵](COMPLETION_TRUTH_MATRIX.md)
- [L4 内容验证规则](CONTENT_AWARE_COMPLETER.md)

### 讨论协议
- [圆桌讨论协议 V2](ROUNDTABLE_PROTOCOL.md) — 共享频道多Agent讨论规则
- [V1 vs V2 区别](ROUNDTABLE_PROTOCOL.md#v1-vs-v2-key-differences) — 任务执行 vs 共享频道讨论
- [路由 vs 行为](ROUNDTABLE_PROTOCOL.md#core-insight-routing--behavior) — `requireMention` 不等于行为规范

### 架构定位
- [为什么选择这个方案](README.md#positioning-why-this-approach-now)
- [与主流框架对比](README.md#what-we-borrowed-from-mainstream-frameworks)
- [何时演进超越本设计](README.md#when-to-evolve-beyond-this-design)

---

*导航页维护: 与版本 v9 同步 | 最后更新: 2026-03-13*
