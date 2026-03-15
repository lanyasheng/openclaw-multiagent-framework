# 一人公司的 Multi-Agent 通信与协调模型

> 不是 Agent 群聊，也不是 completion trick——而是一套面向小团队的轻量化 multi-agent 通信架构

**作者**：OpenClaw Team
**日期**：2026-03-13
**版本**：V2（完整通信矩阵版）

---

## 导语：为什么大多数 multi-agent 文章都讲偏了

如果你搜索"multi-agent framework"，你会看到两类文章：

**第一类**是科幻叙事。一群 AI Agent 在 Slack 频道里激烈辩论，像人类团队一样头脑风暴、互相质疑、最终达成共识。作者会告诉你：这就是未来的工作方式。

**第二类**是工程叙事。如何用 50 行代码实现一个"智能体协作系统"，Agent A 调用 Agent B，Agent B 调用 Agent C，最后返回结果。作者会告诉你：multi-agent 就是这么简单。

这两种叙事都回避了真正的问题：

- 任务发出去了，怎么知道它做完了？
- 多个 Agent 在同一个频道里，怎么不互相抢话？
- Agent 的产物应该发到公共频道，还是沉淀到内部知识库？
- 外部异步系统（数据库、监控、第三方 API）怎么和内部 ACP 任务交互？
- 失败和恢复路径是什么？谁来保证最终一致性？

本文介绍 OpenClaw Multi-Agent Framework 的完整通信模型——不是 completion trick，不是群聊模拟，而是一套**面向一人公司/小团队的轻量化 multi-agent 通信与协调架构**。

---

## 一、问题定义：这个框架真正解决什么

### 1.1 我们面对的真实场景

假设你是一人公司，运营着一个量化交易系统：

- **Trading Agent**：分析市场数据，生成交易信号
- **AINews Agent**：监控 AI 行业新闻，提取市场情绪
- **Macro Agent**：跟踪宏观数据（利率、CPI、就业）
- **Content Agent**：将分析转化为 Twitter/博客内容
- **Zoe/Main**：你，或者代表你的主调度器

典型的一天：

1. 早上 9 点，你问 Zoe："今天 BTC 怎么看？"
2. Zoe 需要派给 Trading、AINews、Macro 三个 Agent 并行分析
3. Trading Agent 需要读取昨天的仓位状态
4. AINews Agent 需要知道 Trading 关注哪些标的
5. 三个 Agent 完成后，Zoe 要综合出一个交易建议
6. 如果建议开仓，Zoe 要派单给 Trading Agent 执行
7. 执行完成后，Content Agent 要生成一条 Twitter
8. 所有过程要有审计日志，失败要能恢复

这不是"一群 AI 在群里闲聊"，这是一套**有明确输入输出、有状态依赖、有失败恢复路径的分布式任务系统**。

### 1.2 核心痛点（不是科幻问题）

| 痛点 | 具体表现 | 根因 |
|------|---------|------|
| **完成通知黑洞** | 调用 `sessions_spawn` 后没有回调，不知道任务何时完成 | OpenClaw Bug #40272 |
| **Agent 健忘** | 文档要求"先注册再 spawn"，但 Agent 每次都直接调用原生工具 | LLM 肌肉记忆 |
| **假完成** | Session 关闭了，但产物不存在或为空 | Session closed ≠ Content delivered |
| **频道混乱** | 多个 Agent 同时发言，信息分散，难以跟踪 | 只有 routing，没有 behavior protocol |
| **内外不分** | 内部技术报告直接发到公共频道，信息过载 | 没有区分 internal coordination vs user-visible delivery |
| **状态丢失** | Gateway 重启后，任务状态消失 | 只有内存状态，没有持久化 |
| **失败无法恢复** | ACK timeout 后不知道任务状态，无法决策下一步 | 没有终态真值源 |

### 1.3 框架边界：解决什么，不解决什么

✅ **我们解决的**：
- 任务路由与生命周期管理
- 多平面通信（控制面/执行面/状态面/异步回调面）
- 完成检测与内容验证
- 共享频道的讨论秩序
- 对外汇报与内部沉淀的边界
- 失败恢复与审计追踪

❌ **我们不解决的**：
- Agent 自主发现与动态组网
- 复杂工作流（cycles、conditions、parallel-join）
- 大规模（10+ Agent）场景
- 全自动无人监督运行
- 通用知识图谱或共享内存

---

## 二、通信全景图：9 类情况总览

### 2.1 通信对象与平面划分

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MULTI-AGENT COMMUNICATION MATRIX                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐                                                            │
│  │    USER     │                                                            │
│  │  (人类用户)  │                                                            │
│  └──────┬──────┘                                                            │
│         │ ① User ↔ Orchestrator                                            │
│         ▼                                                                   │
│  ┌─────────────────┐                                                        │
│  │   ZOE/MAIN      │  ← Control Plane (控制面)                               │
│  │  (Orchestrator) │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│     ┌─────┴─────┬─────────────────┬─────────────────┐                      │
│     │           │                 │                 │                      │
│     ▼           ▼                 ▼                 ▼                      │
│  ┌────────┐ ┌────────┐      ┌──────────┐     ┌──────────┐                  │
│  │Existing│ │  New   │      │  Shared  │     │ External │                  │
│  │Session │ │Session │      │  State   │     │  Async   │                  │
│  │ (②)    │ │ (③)    │      │  (④)     │     │  (⑥)     │                  │
│  └────────┘ └────────┘      └──────────┘     └──────────┘                  │
│     ↑           ↑                 ↑                 ↑                      │
│     └───────────┴─────────────────┴─────────────────┘                      │
│              Execution Plane (执行面) + State Plane (状态面)                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    ACP Runtime Progress (⑤)                        │   │
│  │  streamTo="parent" → progress / stall / resumed / completion       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              Roundtable / Shared Channel (⑦)                       │   │
│  │  V1: 收口    V2: 发言秩序    routing ≠ behavior                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │           Human-visible vs Internal-only (⑧)                       │   │
│  │  公共频道摘要  ≠  内部详细报告  ≠  技术中间产物                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              Failure / Recovery Paths (⑨)                          │   │
│  │  ACK timeout → session close → content reconciliation → stale reaper │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 通信机制总表

| 情况 | 通信双方 | 机制 | 共享什么 | 不共享什么 | 可见性 |
|------|---------|------|---------|-----------|--------|
| ① | User ↔ Orchestrator | 自然语言对话 | 上下文、意图、偏好 | 内部实现细节 | 用户可见 |
| ② | Orchestrator ↔ Existing Session | `sessions_send` | 同一 session 的历史 | 其他 session 的状态 | 内部 |
| ③ | Orchestrator ↔ New Session | `sessions_spawn` | Prompt 中显式传递的上下文 | 默认无共享 | 内部 |
| ④ | Session ↔ Shared State | 文件读写 (`shared-context/`) | Artifact、Report、Status | 执行中间状态 | 可配置 |
| ⑤ | ACP Runtime | `streamTo="parent"` | Progress、Stall、Resumed、Completion | 详细日志 | 内部 |
| ⑥ | External Async ↔ Internal | Watcher / Poller / Webhook | 状态变更事件 | 完整内容 | 内部 |
| ⑦ | Multi-Agent Discussion | Roundtable Protocol | 对话历史（在 thread 中） | 内部技术细节 | 用户可见 |
| ⑧ | Delivery vs Internal | 显式 handoff / 收口 | 摘要、结论、行动项 | 详细推理、中间产物 | 分层可见 |
| ⑨ | Failure Recovery | ACK / Poller / Reaper / Reconciler | 终态真值 | 中间尝试 | 审计日志 |

---

## 三、控制面与执行面

### 3.1 三个核心概念的严格区分

**Agent**：配置实体
```
Agent "trading":
  - system prompt: "你是专业量化交易员..."
  - tools: [market_data, place_order, risk_check]
  - capabilities: [technical_analysis, position_sizing]
```

**Session**：执行实例
```
Session "agent:trading:task-001":
  - 创建时间: 2026-03-13T09:00:00Z
  - 历史记录: [user prompt, agent response, ...]
  - 状态: running / completed / failed / timeout
```

**Thread**：UI 容器
```
Thread "#trading-alerts":
  - Discord/Slack 频道
  - 显示多个 session 的输出
  - 不是内存边界，只是视觉分组
```

**关键区分**：
- 一个 Agent 可以有多个 Session（同时执行多个任务）
- 一个 Thread 可以显示多个 Session 的输出
- Session 之间的内存默认隔离

### 3.2 `sessions_send` vs `sessions_spawn`

| 维度 | `sessions_send` | `sessions_spawn` |
|------|----------------|------------------|
| 作用 | 向已有 session 发消息 | 创建新 session |
| 上下文 | 继承 session 历史 | 全新上下文 |
| 使用场景 | 追问、补充、催办 | 启动新任务 |
| 示例 | "刚才的分析里，RSI 是多少？" | "分析今天 BTC 走势" |

**重要**：`sessions_send` 要求 session 已存在。如果 session 已关闭，调用会失败。

### 3.3 控制面：Zoe/Main 的编排逻辑

```python
# 典型编排流程
class Orchestrator:
    def analyze_market(self, symbol):
        # 并行 spawn 三个分析任务
        tasks = [
            spawn("trading", f"技术分析 {symbol}"),
            spawn("ainews", f"AI 新闻情绪 {symbol}"),
            spawn("macro", f"宏观影响 {symbol}")
        ]

        # 等待全部完成（通过 completion detection）
        results = wait_for_all(tasks)

        # 综合决策
        decision = self.synthesize(results)

        # 如果需要执行，派单给 trading
        if decision.should_trade:
            spawn("trading", f"执行交易: {decision}")

        # 生成对外汇报
        summary = self.create_user_summary(decision)
        return summary
```

控制面的核心职责：
1. **任务分解**：将用户请求拆分为可并行/串行的子任务
2. **任务派发**：决定哪个 Agent 执行哪个任务
3. **状态聚合**：收集各任务的完成状态和产物
4. **综合决策**：基于多源信息做出最终判断
5. **对外收口**：向用户提供简洁、可读的结论

### 3.4 执行面：ACP Runtime 与事件流

```python
# 启用 Layer 1 事件流
sessions_spawn(
    sessionKey="agent:trading:analysis-001",
    agentId="trading",
    prompt="分析 BTC 走势",
    mode="run",
    streamTo="parent"  # ← 启用实时事件流
)
```

收到的事件类型：
- `progress`: 任务进展（"正在下载数据..."）
- `stall`: 任务停滞（可能需要干预）
- `resumed`: 任务恢复
- `completion`: 任务完成（但产物仍需验证）

这些事件用于实时状态展示，**不是**完成真值。完成真值需要 L2-L4 的验证链。

---

## 四、共享状态与真值平面

### 4.1 共享状态的四种机制

| 机制 | 适用场景 | 持久化 | 示例 |
|------|---------|--------|------|
| **Prompt Injection** | 一次性上下文传递 | 否 | 将市场数据直接写在 prompt 里 |
| **Artifacts** | 结构化数据交换 | 是 | JSON 报告、分析结果 |
| **Resume** | 长任务断点续传 | 是 | `resume=session_id` |
| **External State** | 跨 session 持久化 | 是 | 数据库、KV 存储 |

### 4.2 文件系统作为共享内存

```
shared-context/
├── agent-outputs/
│   ├── trading/
│   │   ├── report-2026-03-13.json
│   │   └── status-2026-03-13.json
│   ├── ainews/
│   │   └── sentiment-2026-03-13.md
│   └── macro/
│       └── macro-summary-2026-03-13.md
├── monitor-tasks/
│   └── task-log.jsonl  ← 统一状态真值
└── shared-reports/
    └── daily-brief-2026-03-13.md
```

**Single-Writer 原则**：
- 每个文件只有一个写入者
- 写入完成后，通过 handoff 通知读取者
- 避免并发写入导致的冲突

### 4.3 四层完成检测链路（真值平面）

```
Layer 1: Native Event Stream
  └─ streamTo="parent" 接收实时事件
         ↓
Layer 2: Registration Layer (spawn-interceptor)
  └─ before_tool_call hook 自动登记任务启动
         ↓
Layer 3: Basic Completion
  ├─ ACP Session Poller (~15s): 检测 session 关闭
  └─ Stale Reaper (30min): 超时兜底
         ↓
Layer 4: Terminal-State Correction
  └─ content-aware-completer: 验证内容证据
         ↓
Unified: task-log.jsonl (唯一真值源)
```

**为什么分层**：
- L1 快但不完整（只有 runtime=acp + streamTo 时有效）
- L2 保证登记但不保证检测
- L3 检测关闭但不验证内容
- L4 验证内容但较慢

**为什么 15s 轮询不走 LLM**：
- Session 状态是二进制（closed=true/false）
- 文件轮询快速、确定、零成本
- LLM 增加费用和延迟，但没有成比例收益

### 4.4 Content Reconciliation 与 Supersede

**场景**：Trading Agent 生成了一份报告，但 Zoe 发现数据过时，要求重新生成。

**问题**：旧报告还在文件系统里，如何避免读取错误版本？

**解法**：
```python
# 1. 新任务标记为 supersede 旧任务
new_task = spawn("trading", "重新生成报告", supersede=old_task_id)

# 2. 写入时检查 task-log，只承认最新任务的内容
if task_log.get_latest(task_type) == current_task_id:
    write_file(output_path, content)
else:
    # 当前任务已被 supersede，不写入
    log.warning(f"Task {current_task_id} superseded, skipping output")
```

**Single-Writer + Supersede** 保证：读取者总是看到最新有效版本。

---

## 五、共享频道与 Roundtable 协议

### 5.1 问题的根源：Routing ≠ Behavior

OpenClaw 提供了 `requireMention` 和 `ignoreOtherMentions`，解决的是**路由**（谁收到消息），不是**行为**（收到后怎么做）。

```
Routing Layer (OpenClaw 原生):
├─ requireMention: true
│   → 只处理提到自己的消息
└─ ignoreOtherMentions: true
    → 不响应给别人的消息

Behavioral Layer (Roundtable Protocol):
├─ Only addressed agent speaks
│   → 只有被点名的 Agent 发言
├─ One turn = one complete message
│   → 一轮 = 一条完整消息
├─ Explicit handoff
│   → 显式交接给下一个 Agent
└─ Chair owns synthesis
    → 主持人拥有最终合成权
```

只有路由没有行为协议，会导致：
- 每个 Agent 响应每一次 mention → **Spam**
- 多个 Agent 同时发言 → **Chaos**
- 想法分散在多条消息中 → **Unreadable**
- 没有人负责最终决策 → **Indecision**

### 5.2 Roundtable V1：收口

**目标**：确保讨论有结论，不发散。

**流程**：
```
User: "今天 BTC 怎么看？"
  ↓
Zoe (Chair): 启动 roundtable
  ↓
@trading-agent: 技术分析
@ainews-agent: 新闻情绪
@macro-agent: 宏观视角
  ↓
Zoe (Chair): 综合三方观点，给出结论
  ↓
User: 收到清晰、可执行的建议
```

**关键**：Zoe 是唯一的收口点，防止多个 Agent 同时给用户发结论。

### 5.3 Roundtable V2：共享频道发言秩序

**四条规则**：

**规则 1：Only addressed agent speaks**
```
❌ WRONG:
User: @trading-agent BTC 怎么看？
ainews-agent: AI 行业今天有利好...

✅ CORRECT:
User: @trading-agent BTC 怎么看？
trading-agent: 从技术分析角度...
```

**规则 2：One turn = one complete message**
```
❌ WRONG:
trading-agent: 我认为
trading-agent: BTC 会
trading-agent: 上涨

✅ CORRECT:
trading-agent: 我认为 BTC 会上涨，理由：
           1. RSI 突破 70
           2. 成交量放大
           3. 关键阻力位突破
           → handing off to @ainews-agent
```

**规则 3：Explicit handoff**
```
✅ CORRECT:
trading-agent: ...技术面向好。
           → @ainews-agent, 新闻面有什么风险？

ainews-agent: ...监管新闻需要关注。
            → @macro-agent, 宏观层面怎么看？

macro-agent: ...美联储政策是最大变量。
           → @zoe, ready for synthesis.
```

**规则 4：Chair owns synthesis**
```
✅ CORRECT:
Zoe: 综合三方观点：
   - 技术面向好（RSI、成交量）
   - 新闻面有监管风险（SEC 调查）
   - 宏观面受美联储政策制约

   建议：小仓位试探，设置严格止损。
   → Round complete.
```

### 5.4 V1 vs V2 的关系

| 维度 | V1 | V2 |
|------|-----|-----|
| 解决的问题 | 收口（谁给结论） | 秩序（怎么讨论） |
| 关键角色 | Chair | All agents + Chair |
| 适用场景 | 任何多 Agent 任务 | 共享频道的公开讨论 |
| 技术依赖 | 无 | `requireMention` + `ignoreOtherMentions` |

---

## 六、对外汇报与内部沉淀边界

### 6.1 为什么不能直接等同

**反模式**：Trading Agent 生成了一份 2000 字的技术分析报告，直接发到 #trading-alerts 频道。

**问题**：
- 用户（你）被信息淹没
- 其他 Agent 无法有效引用（太长、结构混乱）
- 内部技术细节泄露到公共频道
- 没有决策依据，只有原始数据

### 6.2 三层信息分层

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Public Channel                                     │
│  ─────────────────                                           │
│  用户可见的最终输出                                           │
│  • 简洁摘要（< 200 字）                                       │
│  • 明确的结论和行动项                                         │
│  • 可选的"查看详情"链接                                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Internal Report                                    │
│  ─────────────────                                           │
│  Agent 间的结构化数据交换                                      │
│  • 详细的分析结果（JSON/Markdown）                            │
│  • 技术中间产物（指标计算、数据源）                            │
│  • 供其他 Agent 引用的标准化格式                               │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Raw Output / Debug                                 │
│  ─────────────────                                           │
│  Agent 内部生成过程                                            │
│  • 详细的推理过程                                              │
│  • 中间计算结果                                                │
│  • 错误日志和调试信息                                          │
│  • 通常不持久化，或只保留短期                                   │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 正确的信息流动

```
Trading Agent
  ├─→ L1: Raw analysis (内部)
  ├─→ L2: structured-report.json (shared-context/)
  │       "rsi": 72,
  │       "trend": "bullish",
  │       "confidence": 0.8
  └─→ (不直接发公共频道)

Zoe (Orchestrator)
  └─→ 读取 L2 报告
      └─→ 生成 L3 摘要
          "技术面向好（RSI 72），建议小仓位试探。"
          └─→ 发送到 #trading-alerts
```

### 6.4 Handoff 模板中的分层

```markdown
## 给下一个 Agent（L2）
- 详细数据: shared-context/agent-outputs/trading/report-001.json
- 关键指标: RSI=72, MA50 突破
- 风险提示: 监管不确定性

## 给 Zoe 收口（L2 → L3）
- 结论: 技术面向好
- 置信度: 80%
- 建议行动: 小仓位试探

## 给用户（L3）
【BTC 技术分析】
技术面向好（RSI 72），建议小仓位试探，止损设在 $42,000。
```

---

## 七、失败与恢复路径

### 7.1 失败模式矩阵

| 失败模式 | 检测方式 | 恢复策略 |
|---------|---------|---------|
| ACK Timeout | `sessions_send` 返回 timeout | Poll session status → 决定重试或标记失败 |
| Session Crash | ACP Poller 检测到异常关闭 | Content reconciliation → 检查是否有部分产物 |
| Zombie Session | Stale Reaper 检测到超时 | 强制关闭 + 标记失败 |
| Content Mismatch | L4 completer 检测到无效产物 | 标记为需要人工检查 |
| Gateway Restart | 启动时 task-log 重载 | 从持久化状态恢复跟踪 |
| Agent Error | 错误输出到 stream | 捕获错误 + 通知 Zoe |

### 7.2 恢复流程示例

**场景**：Trading Agent 执行任务时 Gateway 重启。

```
1. 重启前状态:
   task-log.jsonl: {"taskId": "t-001", "status": "running", ...}

2. Gateway 重启:
   - 内存中的 pending tasks 丢失
   - task-log.jsonl 保留在磁盘

3. 启动恢复:
   - 读取 task-log.jsonl
   - 找到状态为 "running" 但 session 已关闭的任务
   - 启动 L4 completer 验证内容

4. 内容验证:
   - 检查 shared-context/agent-outputs/trading/
   - 如果找到有效产物 → 标记 completed
   - 如果没有产物 → 标记 failed，通知 Zoe

5. Zoe 决策:
   - 如果标记 completed → 继续工作流
   - 如果标记 failed → 决定重试或人工处理
```

### 7.3 最终一致性保证

通过 **L4 Content Reconciliation** 实现最终一致性：

```
即使：
- Gateway 重启
- Session 异常关闭
- 通知丢失

只要：
- Agent 写入了产物文件
- 文件符合有效性规则（大小、时间、关键词）

就能：
- 在 L4 被检测为完成
- 状态同步到 task-log.jsonl
- 工作流继续推进
```

---

## 八、为什么当前是轻量方案

### 8.1 规模假设

- 3-5 个 Agent
- 1-3 人团队
- 显式编排，人类 oversight
- 任务以分钟/小时为单位

### 8.2 设计取舍

| 需求 | 我们的选择 | 重型框架的选择 |
|------|-----------|---------------|
| Agent 发现 | 静态配置 | 动态注册/发现 |
| 消息路由 | Point-to-point | Message bus / Broadcast |
| 状态共享 | 文件系统 | 共享内存 / 知识图谱 |
| 工作流 | 线性 orchestrator | Graph workflow |
| 持久化 | JSONL 文件 | Database / Event sourcing |
| 故障恢复 | L4 reconciliation | Checkpoint / Replay |

### 8.3 与主流框架的关系

**AutoGen Core**：
- 借鉴：Orchestrator 模式、显式 handoff
- 不同：不用 message bus，point-to-point 足够

**LangGraph**：
- 借鉴：持久化层、显式状态管理
- 不同：不用 graph workflow，线性路由足够

**CrewAI**：
- 借鉴：角色定义、任务委派
- 不同：不用高层抽象，需要低层控制绕过 OpenClaw bug

---

## 九、适用边界与反模式

### 9.1 什么时候这套模型足够

✅ **适合**：
- 3-5 Agent，角色明确
- 显式编排，人类 oversight
- 任务以分钟/小时为单位
- 愿意理解和操作底层原语

### 9.2 什么时候应该升级

⚠️ **触发条件**：
- 10+ Agent，需要动态发现
- 复杂工作流（cycles、parallel-join）
- 全自动无人监督
- 毫秒级响应要求

**候选方案**：AutoGen Core（路由）、LangGraph（工作流）、CrewAI（快速启动）

### 9.3 反模式

**反模式 1：让 Agent 直接对话**
```
❌ WRONG:
trading-agent: @ainews-agent 你怎么看？
ainews-agent: @trading-agent 我觉得...

✅ CORRECT:
所有对话通过 Zoe 路由
```

**反模式 2：Session 之间隐式共享状态**
```
❌ WRONG:
Session A 写入内存变量
Session B 读取同一个变量

✅ CORRECT:
通过文件或 prompt 显式传递
```

**反模式 3：内部报告直接发公共频道**
```
❌ WRONG:
Agent 把 2000 字技术报告发到 #general

✅ CORRECT:
Zoe 生成摘要后发频道，详细报告放 shared-context
```

---

## 十、结论

### 10.1 这套框架的真实价值

不是"让 Agent 像人类一样自由讨论"的科幻框架，而是一套**务实的通信架构**：

1. **解决完成通知黑洞**：四层检测链路确保任务不丢失
2. **解决频道混乱**：Roundtable 协议维护共享频道秩序
3. **解决内外不分**：明确区分对外汇报与内部沉淀
4. **解决状态丢失**：文件系统持久化 + 最终一致性
5. **解决失败不可恢复**：ACK → Poller → Reaper → Reconciler 的完整链路

### 10.2 它适合谁

- 运行 OpenClaw，需要 3-5 个 Agent 协作
- 愿意显式编排，不追求全自动
- 理解并接受当前的设计取舍
- 一人公司或小团队，需要可靠但不复杂的 multi-agent 基础设施

### 10.3 它不适合谁

- 需要 10+ Agent 或动态组网
- 需要全自动、零监督运行
- 需要复杂工作流（cycles、conditions）
- 不想理解底层通信原语

### 10.4 最后一句话

> 这不是 multi-agent 的终极答案，而是一个特定规模、特定痛点的务实解法。它不会帮你实现"AI 团队自治"的科幻愿景，但会让你的 3-5 个 Agent 在今天就能可靠地协作——任务不丢失、频道不混乱、信息不泛滥、失败可恢复。

---

## 附录

### 9 类通信情况速查表

| # | 情况 | 关键机制 | 关键文件 |
|---|------|---------|---------|
| ① | User ↔ Orchestrator | 自然语言 | - |
| ② | Orchestrator ↔ Existing Session | `sessions_send` | - |
| ③ | Orchestrator ↔ New Session | `sessions_spawn` | task-log.jsonl |
| ④ | Session ↔ Shared State | 文件读写 | shared-context/ |
| ⑤ | ACP Runtime Progress | `streamTo="parent"` | - |
| ⑥ | External Async | Watcher / Poller | - |
| ⑦ | Roundtable | Protocol V1/V2 | ROUNDTABLE_PROTOCOL.md |
| ⑧ | Delivery vs Internal | Handoff / 收口 | - |
| ⑨ | Failure Recovery | ACK / L4 Reconciler | task-log.jsonl |

### 参考文件

- `README.md` — 框架概述
- `ARCHITECTURE.md` — 架构详解
- `COMMUNICATION_ISSUES.md` — 通信问题历史
- `ROUNDTABLE_PROTOCOL.md` — Roundtable V1/V2
- `COMPLETION_TRUTH_MATRIX.md` — 完成真值矩阵
- `AGENT_PROTOCOL.md` — Agent 协作协议
- `ANTIPATTERNS.md` — 反模式

---

*最后更新：2026-03-13 | 框架版本：v9 | 文章版本：V2*
