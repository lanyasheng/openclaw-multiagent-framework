# OpenClaw Multi-Agent Framework 摘要

## 一句话定义

一套面向小团队的轻量化 multi-agent 通信与协调架构，系统覆盖 9 类通信情况，解决任务完成检测、共享频道秩序、内外信息分层等真实工程问题。

## 核心问题（不是科幻场景）

1. **完成通知黑洞**：`sessions_spawn` 启动任务后没有回调
2. **频道混乱**：多个 Agent 同时发言，信息分散
3. **内外不分**：内部技术报告直接发到公共频道
4. **状态丢失**：Gateway 重启后任务状态消失
5. **失败不可恢复**：ACK timeout 后无法决策下一步

## 9 类通信情况矩阵

| # | 情况 | 机制 | 可见性 |
|---|------|------|--------|
| ① | User ↔ Orchestrator | 自然语言对话 | 用户可见 |
| ② | Orchestrator ↔ Existing Session | `sessions_send` | 内部 |
| ③ | Orchestrator ↔ New Session | `sessions_spawn` | 内部 |
| ④ | Session ↔ Shared State | 文件系统 (`shared-context/`) | 可配置 |
| ⑤ | ACP Runtime Progress | `streamTo="parent"` | 内部 |
| ⑥ | External Async ↔ Internal | Watcher / Poller | 内部 |
| ⑦ | Roundtable / Shared Channel | V1 收口 + V2 发言秩序 | 用户可见 |
| ⑧ | Human-visible vs Internal | 显式分层（L1/L2/L3） | 分层可见 |
| ⑨ | Failure / Recovery | ACK → Poller → Reaper → L4 | 审计日志 |

## 核心概念区分

```
Agent: 配置实体（system prompt、tools）
  └── Session: 执行实例（隔离的历史和状态）
        └── Thread: UI 容器（视觉分组，不是内存边界）
```

**关键区分**：
- Agent ≠ Session：一个 Agent 可以有多个 Session
- Session 之间默认隔离，共享需要显式机制
- Thread 只是显示容器，不是状态边界

## 四层平面架构

```
Control Plane (控制面)
  └─ Zoe/Main: 任务分解、派发、聚合、决策

Execution Plane (执行面)
  ├─ sessions_send: 向已有 session 发消息
  ├─ sessions_spawn: 创建新 session
  └─ ACP Runtime: streamTo="parent" 事件流

Shared State Plane (状态面)
  ├─ Artifacts: 结构化数据交换
  ├─ Reports: Agent 产物
  └─ task-log.jsonl: 统一状态真值

Async Callback Plane (异步面)
  ├─ External Watcher: 数据库、监控、第三方 API
  ├─ ACP Session Poller: ~15s 检测 session 关闭
  └─ Stale Reaper: 30min 超时兜底
```

## Roundtable 协议

**V1（收口）**：确保多 Agent 讨论有结论，Zoe 是唯一收口点

**V2（发言秩序）**：维护共享频道秩序，四条规则：
1. Only addressed agent speaks（只有被点名的发言）
2. One turn = one complete message（一轮 = 一条完整消息）
3. Explicit handoff（显式交接）
4. Chair owns synthesis（主持人拥有最终合成权）

**核心洞察**：Routing（谁会醒）≠ Behavior（醒后怎么做）

## 信息分层（对外 vs 内部）

```
L3: Public Channel（用户可见）
   └─ 简洁摘要（< 200 字）、明确结论

L2: Internal Report（Agent 间交换）
   └─ 详细数据、结构化格式、技术中间产物

L1: Raw Output / Debug（内部生成过程）
   └─ 详细推理、计算过程、错误日志
```

**原则**：Agent 产物先到 L2，Zoe 收口后生成 L3 摘要发给用户

## 四层完成检测链路

```
L1: Native Event Stream — 实时事件（快但不完整）
L2: Registration Layer — 自动拦截登记（Plugin hook）
L3: Basic Completion — Session Poller + Stale Reaper
L4: Terminal-State Correction — 内容证据验证
     └─ Unified: task-log.jsonl（唯一真值源）
```

**为什么 15s 轮询不走 LLM**：Session 状态是二进制信号，文件轮询快速、确定、零成本。

## 失败恢复路径

```
ACK Timeout → Poll Status → Content Reconciliation
                              ↓
                    ┌─ Valid content → Mark completed
                    └─ No content → Mark failed → Notify Zoe
```

**最终一致性**：即使 Gateway 重启、通知丢失，只要产物文件存在且有效，L4 就能检测到并恢复状态。

## 与主流框架的关系

| 框架 | 我们借鉴的 | 我们选择不同的 |
|------|-----------|---------------|
| AutoGen Core | Orchestrator、handoff | 不用 message bus，point-to-point 足够 |
| LangGraph | 持久化层、显式状态 | 不用 graph workflow，线性路由足够 |
| CrewAI | 角色定义、任务委派 | 不用高层抽象，需要低层控制绕过 OpenClaw bug |

## 适用边界

✅ **适合**：3-5 Agent、显式编排、人类 oversight、愿意理解底层原语
❌ **不适合**：10+ Agent、全自动运行、复杂 workflow、毫秒级响应

## 反模式速查

| 反模式 | 正确做法 |
|--------|---------|
| Agent 直接对话 | 所有对话通过 Zoe 路由 |
| Session 隐式共享状态 | 通过文件或 prompt 显式传递 |
| 内部报告直接发公共频道 | Zoe 生成摘要，详细报告放 shared-context |
| 忽略 L4 内容验证 | 始终验证产物有效性 |

## 真实价值

不是"让 Agent 像人类一样自由讨论"的科幻框架，而是：

> 一套务实的通信架构，让你的 3-5 个 Agent 在今天就能可靠地协作——任务不丢失、频道不混乱、信息不泛滥、失败可恢复。

---

*完整文章见 [why-we-built-this-multiagent-engine-zh.md](./why-we-built-this-multiagent-engine-zh.md)*

*框架版本：v9 | 文档版本：V2*
