# AGENT_PROTOCOL.md — 团队统一协作协议

> Version: 2026-03-12-v2.1 (ACK-First 强制版 + Wrapper 推荐)
> Owner: main (Zoe)
> Scope: All agents
> Status: Canonical

---

## 1. 目标

统一以下原本分散的规则：
- ACK 守门
- Agent 间控制面通信
- 长任务异步执行与回推
- 共享状态落盘
- 每日反思的次日 P0/P1 跟进闭环

**从现在开始，以本文件为唯一规范入口。**

---

## 2. 三层分工

### 2.1 控制面：`sessions_send`
用于：派单、ACK、催办、简短结论、正式控制面消息。

### 2.2 异步回执面：`task-watcher`
用于：>10 秒长任务、后台任务、状态变化任务的终态通知。

### 2.3 共享状态面：`shared-context/*`
用于：协议、任务真值、中间状态、follow-up、intel、dispatches。

**规则**：关键事实不能只留在聊天历史里，必须落共享状态。

---

## 3. 双阈值规则（强制）

- `<= 3 秒`：允许同步完成
- `> 3 秒`：必须先 ACK
- `> 10 秒`：必须异步执行，并接入 task-watcher 或等价状态回推机制

标准链路：
`ACK -> 后台执行 -> 写 status/report -> terminal push`

---

## 4. ACK 守门（P0 强制）

适用范围：
- 用户追问
- `sessions_send`
- 跨 Agent intel 同步
- 带 `request_id / ack_id` 的正式控制面消息

硬规则：
1. **先 ACK，再处理**
2. 禁止先查文件、等线程、做分析而不回复
3. 若当前主线繁忙，也必须先做最小 ACK
4. 任何 >3 秒动作不得在 ACK 前或 ACK 后当前回合同步等待结果
5. 多线并行时，必须区分主线 / 支线 / 内控线，避免串线

ACK 最小格式：
- 对用户：`收到，正在查 X / 正在推进 Y`
- 对 agent：`[ACK] ack_id=<id> state=confirmed | 正在处理 <topic>`

### 4.1 进度追问与承诺回报（P0 强制）

适用范围：
- 用户追问：`现在什么进度` / `上午任务怎么样了` / `整体上到哪了`
- 任何明确承诺了 `N 分钟内补充` / `稍后给完整状态` 的场景

硬规则：
1. **先回当前已知真值，再补查缺口**；不得为了“等更完整答案”而先静默。
2. **承诺了时限，就必须在到点前回一次**；即使还没查完，也要发中间状态 + 未完成原因 + 新 ETA。
3. **超过承诺时限仍未完成时，默认优先发中间状态**，禁止无声超时。
4. **汇总类回复必须先枚举当日 active workstreams**（今日 dispatch / follow-up / 当前主线），不得只基于长期记忆或昨晚已完成事项作答。
5. **如果刚发生会话重置 / 新 session 启动**，第一版汇总必须显式标注：`已核对部分` vs `待补核部分`，避免把“已完成基础设施”误当成“当前主线全貌”。

推荐格式：
- `已确认：A / B / C`
- `还在补查：D / E`
- `下一次回报：<时间>`

---

## 5. 长任务执行规范（P0 强制）

符合以下任一条件，默认异步：
- 多次工具调用
- 文件系统搜索 / 日志扫描 / 网络抓取
- 长文生成
- 等待外部状态变化
- 子任务委派

执行顺序固定：
1. 当前会话先 ACK
2. 生成 `task_id`
3. 先注册 watcher / 状态文件
4. 再启动后台执行（`sessions_spawn(mode="run")` 或 `exec(background=true)`）
5. 终态由 watcher 或单一 terminal owner 回推

禁止：
- 把 `sessions_send` 当同步 RPC 长等完整结果
- 当前回合同步等待 ACP / agent / thread 回执
- 一个异步任务发出两条 final

### 5.1 ACP 任务监控注册规则（P0，2026-03-12）

**根规则**：任何需要用户可见终态回推的 ACP 任务，不允许“裸启动”。

必须满足：
1. 有 `task_id`
2. 有明确 `status_file`
3. 有明确 `report_file` / `output_file`
4. 已注册到 `monitor-tasks/tasks.jsonl`
5. watcher 有可监控对象后，ACP 才算真正进入标准链路

#### ACP 强制顺序 (v3 - 2026-03-12)

1. ACK 用户
2. 预先确定 `task_id / task_subject / reply_to`
3. **必须使用 wrapper 启动**（自动处理 Guard 验证 + watcher 注册 + ACP 启动）
4. ACP 线程按约定写 `status_file / report_file`
5. watcher 盯 `status_file / report_file` 终态并推送

> 强制 wrapper: `spawn_acp_with_watcher.py`
>
> 对**用户可见终态**的 ACP 长任务，直接裸 `sessions_spawn(runtime="acp")` 视为违规启动；仅允许用于本地 smoke / 调试 / 不需要 watcher 的内部实验。

#### 最小注册模板 (推荐 wrapper)

```bash
python3 ~/.openclaw/workspace/skills/task_callback_bus/scripts/spawn_acp_with_watcher.py \
  --task-id <task_id> \
  --task-subject "<任务主题>" \
  --prompt-file <prompt_file> \
  --reply-to channel:<channel_id> \
  --owner main \
  --silent-until-terminal
```

wrapper 自动生成:
- `status_file`: `~/.openclaw/shared-context/job-status/<task_id>.json`
- `report_file`: `~/.openclaw/shared-context/job-status/reports/<task_id>.md`

#### 最小注册模板 (手动注册 - 备选)

```bash
python3 ~/.openclaw/workspace/skills/task_callback_bus/scripts/register_generic_task.py \
  --task-id <task_id> \
  --task-type sessions_spawn \
  --status-file <status_file> \
  --output-file <report_file> \
  --reply-to channel:<channel_id> \
  --owner main \
  --task-subject <subject> \
  --silent-until-terminal
```

#### ACP worker 最小落盘要求
- 启动即写 `status_file.state=started`
- 中间阶段写 `reviewing / implementing / testing / finalizing`
- 终态必须写 `completed / failed / timeout`
- 终态必须有 `report_file`

#### 验收要求
如果 ACP 报告已经生成，但 watcher 没有终态通知，默认判定为：
**监控注册缺失或链路不完整**，而不是“watcher 自己会发现”。

---

## 6. 共享状态与真值规则

关键状态必须落到以下位置之一：
- `shared-context/job-status/`
- `shared-context/monitor-tasks/`
- `shared-context/dispatches/`
- `shared-context/intel/`
- `shared-context/followups/`

验收真值顺序：
1. 核心产物是否存在
2. `status_file` 是否一致
3. `report_file` 是否存在
4. 测试/日志是否通过
5. 最后才看聊天回执

**completed 不能只看状态字样，必须核真实产物。**

---

## 7. 每日反思 → 次日 P0/P1 落地链路（P0 强制）

### 7.1 原则
**反思完成 ≠ 落地完成。**

每日反思中写出的“明日重点 / P0 / P1”，第二天必须转成明确动作，不能只停留在总结文本里。

### 7.2 固定落地物
每个自然日必须有一份：
- `shared-context/followups/YYYY-MM-DD.md`

其中至少包含：
- 事项
- Priority（P0/P1）
- Owner
- 来源（出自哪份反思）
- 当前状态（pending/in_progress/done/blocked）
- 证据路径（dispatch / intel / report / runbook / code / message）

### 7.3 固定时间点
- **前一日晚间反思结束后**：写出次日 follow-up 初稿
- **次日 09:00 前**：main 完成 review，确认当天 P0/P1
- **次日 09:30 前**：相关事项必须转成实际动作（dispatch / task / file / sync）
- **次日 20:30 前**：更新状态；未完成项要么说明 blocker，要么 rollover 到下一天

### 7.4 验收标准
以下任一缺失，都不算“已落实”：
- 没有 owner
- 没有证据路径
- 没有实际派单/文件/任务注册
- 只有反思文本，没有第二天动作

### 7.5 main 的职责
main 每天必须回答两个问题：
1. 昨天反思里的 P0/P1，今天哪些已经转成实际动作？
2. 哪些还没转？为什么？谁负责？

---

## 8. 正式控制面消息格式（推荐）

```text
[Request] ack_id=<id> | topic=<topic> | ask=<what> | due=<time>
[ACK] ack_id=<id> state=confirmed | handling=<summary>
[Final] ack_id=<id> state=final | result=<summary>
```

闭环后“收到/感谢/OK”统一 `NO_REPLY`。

### 8.1 Handoff 标准模板（P0）

#### Request
```text
[Request] ack_id=<唯一ID> | topic=<主题>
任务: <一句话要做什么>
背景: <为什么需要做>
输入: <已有材料/上下文/数据>
预期输出: <交付物形式>
验收标准: <什么算完成>
失败回退: <超时/失败怎么处理>
```

#### ACK
```text
[ACK] ack_id=<同请求ID> state=confirmed
处理方式: <准备怎么做>
预计完成: <可选>
```

#### Final
```text
[Final] ack_id=<同请求ID> state=final
结论: <核心结果>
证据路径: <文件/链接/报告>
动作: <下一步>
验收状态: PASS / FAIL / NEEDS_WORK
```

### 8.2 交付物三层结构（P0）
所有跨 agent 协作交付物默认包含：
1. **结论**
2. **证据**
3. **动作**

---

## 9. 单写入者（single-writer）规则

适用：重开任务、rerun、fallback、并发子任务。

规则：
1. 旧线程一旦被替代，必须停写
2. 新线程成为唯一合法 owner
3. owner 必须落文件
4. 最终补旧线程 superseded / terminal close

---

## 10. 现阶段唯一规范入口

- 协议总入口：`~/.openclaw/shared-context/AGENT_PROTOCOL.md`
- 历史设计/审计/实现文档：归档到 `~/.openclaw/shared-context/archive/protocol-history/`

如果旧文档与本文件冲突，以本文件为准。

---

## 11. ACK-First 协议 (P0 强制，2026-03-12)

### 11.1 核心规则

```
收到正式消息 → 3 秒内必须 ACK → ACK 后才执行实际工作
```

**硬性要求**:
1. **3 秒规则**: 收到 Request 后 3 秒内必须返回 ACK
2. **先 ACK 后处理**: 禁止在 ACK 前执行任何 >3 秒的操作
3. **状态落盘**: ACK 时必须同时写状态文件 `shared-context/job-status/{ack_id}.json`
4. **禁止重复 Final**: 相同 `ack_id` 的 Final 消息只能发送一次

### 11.2 ACK 执行流程

接收方流程:
```
T+0s: 收到 Request
T+0-3s: 返回 ACK + 写状态文件 (state=acknowledged)
T+3s+: 开始实际工作
T+N: 更新状态文件 (state=in_progress/completed)
T+终态: 发送 Final (仅一次)
```

### 11.3 状态文件规范

**位置**: `shared-context/job-status/{ack_id}.json`

**最小内容**:
```json
{
  "ack_id": "tsk_xxx",
  "agent": "<agent名>",
  "state": "acknowledged",
  "acknowledged_at": "2026-03-12T12:34:56",
  "requester": "<发送方>"
}
```

**状态枚举**:
- `acknowledged` - 已 ACK，未开始
- `started` - 开始处理
- `in_progress` - 处理中
- `completed` - 完成
- `failed` - 失败
- `timeout` - 超时

### 11.4 Timeout 处理

发送方收到 `timeout` 后:
1. 查询状态文件 `shared-context/job-status/{ack_id}.json`
2. 如果 state 是 `acknowledged/started/in_progress` → 等待 watcher
3. 如果 state 是 `completed` → 检查 report_file
4. 如果无状态文件 → 可能投递失败，人工介入

**工具**: `python3 shared-context/job-status/ack-state-bridge.py --check-timeout {ack_id}`

### 11.5 ACK-First 模板

详见: `shared-context/dispatches/templates/ack-first-protocol.md`

---

## 12. 今日执行要求（立即生效）

1. 所有 agent 读取并遵守本文件
2. 后续引用协议时，只引用本文件路径
3. 每日反思必须产出次日 `followups/YYYY-MM-DD.md`
4. 每日 09:30 前，P0/P1 必须至少转成一条可验证动作
5. **ACK-First 协议立即生效**: 所有正式控制面消息必须先 ACK

---

## 附录 A: 日常 Dispatch 可直接复用的 Handoff 模板

> 以下模板复制即用，无需重新组织语言。

### A.1 标准请求模板（sessions_send）

```
[Request] ack_id=<任务ID> | topic=<一句话主题>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【任务】<要做什么>
【背景】<为什么做>
【输入】<已有材料/数据/上下文>
【预期输出】<交付物形式>
【验收标准】<什么算完成>
【截止时间】<如有时限>
【失败回退】<超时/失败怎么处理>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### A.2 标准 ACK 模板

```
[ACK] ack_id=<同请求ID> state=confirmed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【处理人】<agent名>
【处理方式】<简述做法>
【预计完成】<时间>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### A.3 标准 Final 模板

```
[Final] ack_id=<同请求ID> state=final
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【结论】<核心结果>
【证据】<数据/文件/链接>
【动作】<下一步>
【验收状态】PASS / FAIL / NEEDS_WORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### A.4 失败/超时 Final 模板

```
[Final] ack_id=<同请求ID> state=failed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【失败原因】<简述>
【已尝试】<做过哪些>
【建议回退】<如何处理>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### A.5 跨 Agent 协作快速模板

**main → trading（交易分析请求）**
```
[Request] ack_id=tsk_trading_<日期>_001 | topic=晨报分析
【任务】生成今日晨报
【背景】开盘前需掌握市场动态
【输入】隔夜美股数据、夜盘商品、宏观新闻（见 shared-context/intel/）
【预期输出】晨报文档 + 数据快照
【验收标准】包含美股/商品/汇率三锚点 + 交易建议
【失败回退】记录 blocker，升级 main
```

**main → ainews（技术调研请求）**
```
[Request] ack_id=tsk_ainews_<日期>_001 | topic=工具调研
【任务】调研 <工具名>
【背景】评估是否值得引入
【输入】工具官网、GitHub、相关讨论
【预期输出】调研报告
【验收标准】结论 + 证据 + 动作 三层结构
【失败回退】标记为 pending-info，说明缺什么
```

**trading → macro（宏观确认）**
```
[Request] ack_id=tsk_macro_<日期>_001 | topic=CPI影响确认
【任务】确认今日CPI数据对盘面的影响
【背景】trading建议需宏观前提
【输入】已发布的CPI数据
【预期输出】宏观判断 + 对交易的影响
【验收标准】明确结论（利多/利空/中性）+ 依据
【失败回退】说明数据不足，trading暂缓建议
```

---

## 附录 B: Phase Progression 管理（长任务分阶段）

| Phase | 名称 | 报告内容 | 接收人 |
|-------|------|----------|--------|
| P1 | 需求确认 | 任务理解/输入材料/完成标准 | main |
| P2 | 执行中 | 初步发现/阻塞/ETA | main |
| P3 | 草稿验收 | 交付物草稿/自检结果 | main |
| P4 | 最终交付 | 最终产物/验收状态/归档路径 | main |

**规则**：
- 每个 phase 结束必须报告
- phase 之间调整方向需先确认
- main 可在任意 phase 叫停或调整

### Phase 报告快速模板

```
[Phase] ack_id=<任务ID> phase=<P1/P2/P3/P4>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【当前状态】<进展>
【发现/问题】<关键信息>
【预计完成】<时间>
【需要决策】<如需 main 决定>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
