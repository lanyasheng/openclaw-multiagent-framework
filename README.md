# OpenClaw Multi-Agent Collaboration Framework

# OpenClaw 多 Agent 协作框架

> A battle-tested multi-agent collaboration protocol and architecture for OpenClaw, tackling unreliable ACP communication, agent task-registration amnesia, and ambiguous timeout semantics.
>
> 统一、高效、可追溯的多 Agent 团队协作协议与架构模式，解决 ACP 异步通信不可靠、Agent 遗忘任务注册、timeout 语义模糊三大痛点。

**Version**: 2026-03-13-v3
**License**: MIT
**Status**: Production Ready (internally validated) / OSS Ready
**Author**: lanyasheng (OpenClaw Community)

---

## What problem does this solve? / 解决什么问题

| Problem | Root Cause | Our Solution |
|---------|-----------|-------------|
| ACP task completion has no notification | OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272) — `notifyChannel` not forwarded | `spawn-interceptor` plugin auto-injects completion callback |
| Agent forgets to register monitoring | LLM muscle memory points to native tools | `before_tool_call` hook intercepts automatically |
| Timeout gives no success/failure signal | `sessions_send` only returns ok/timeout | Deterministic tracking via `task-log.jsonl` |
| Long-running task execution | Sync-wait or manual follow-up | Background execution + completion callback push |
| Cross-agent collaboration | Free-form, hard to trace | Standard handoff template (request/ack/final) |
| Source of truth management | Relies on chat history | State file + report file dual persistence |

| 问题 | 根因 | 本框架方案 |
|------|------|------------|
| ACP 任务完成没通知 | OpenClaw Bug [#40272](https://github.com/openclaw/openclaw/issues/40272) (notifyChannel 不转发) | spawn-interceptor plugin 自动注入完成回调 |
| Agent 忘记注册监控 | LLM 肌肉记忆指向原生工具 | before_tool_call hook 自动拦截 |
| timeout 不知道成败 | sessions_send 只有 ok/timeout | task-log 确定性追踪 |
| 长任务执行 | 同步等待 or 口头催办 | 后台执行 + 完成回调推送 |
| 跨 Agent 协作 | 自由格式，难以追溯 | 标准 handoff 模板 (request/ack/final) |
| 真值管理 | 依赖聊天历史 | 状态文件 + 报告文件双落盘 |

See [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) for the full problem analysis and design rationale.

---

## Core Architecture / 核心架构

```
Agent -> sessions_spawn(acp)
    | (before_tool_call hook auto-intercepts)
spawn-interceptor plugin:
    1. Log to task-log.jsonl
    2. Inject completion callback instruction into ACP prompt
    |
ACP Sub-Agent executes task
    | (on completion)
ACP -> sessions_send -> completion-relay session
    |
completion-listener -> Update task-log -> Notify user
```

**Zero cognitive load**: Agents don't need to remember any extra steps — the system handles everything automatically.

**零认知负担**: Agent 不需要记住额外步骤，系统自动处理。

---

## Known OpenClaw Bugs & Workarounds / 已知 OpenClaw Bug 与临时方案

This framework exists partly because of unresolved bugs in OpenClaw's ACP subsystem. Here are the key ones affecting multi-agent orchestration:

本框架的诞生部分源于 OpenClaw ACP 子系统中尚未修复的 Bug。以下是影响多 Agent 编排的关键问题：

| Issue | Description | Impact | Our Workaround |
|-------|------------|--------|---------------|
| [#34054](https://github.com/openclaw/openclaw/issues/34054) | Gateway doesn't call `runtime.close()` for completed oneshot sessions | Zombie sessions accumulate, hit `maxConcurrentSessions` limit | Daily GC in Guardian script ([our comment](https://github.com/openclaw/openclaw/issues/34054#issuecomment-4048248380)) |
| [#35886](https://github.com/openclaw/openclaw/issues/35886) | ACP child processes not cleaned after TTL | Zombie process accumulation | Guardian health-check auto-restart |
| [#40243](https://github.com/openclaw/openclaw/issues/40243) | Persistent session agent dies silently | Messages silently dropped | Prefer oneshot over persistent |
| [#40272](https://github.com/openclaw/openclaw/issues/40272) | `notifyChannel` doesn't work in ACP | No native completion notification | `spawn-interceptor` + `completion-listener` |

For the **#34054 workaround** (zombie session cleanup), see [our detailed comment on GitHub](https://github.com/openclaw/openclaw/issues/34054#issuecomment-4048248380).

---

## Quick Start / 快速开始

### Prerequisites / 前置条件

- OpenClaw >= 2026.3.x (requires `before_tool_call` plugin hook support)
- Python 3.10+
- At least 1 Agent configured

### Deploy spawn-interceptor plugin / 部署 spawn-interceptor 插件

```bash
# 1. Copy plugin / 复制插件
cp -r plugins/spawn-interceptor ~/.openclaw/plugins/

# 2. Install via OpenClaw CLI / 通过 CLI 安装
openclaw plugins install --link ~/.openclaw/plugins/spawn-interceptor

# 3. Restart Gateway / 重启 Gateway
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
# or: systemctl --user restart openclaw-gateway
```

### Deploy completion-listener / 部署 completion-listener

```bash
# Add to crontab (check every minute) / 添加到 crontab（每分钟检查）
echo "*/1 * * * * cd ~/.openclaw/repos/openclaw-multiagent-framework/examples/completion-relay && python3 completion_listener.py --once >> /tmp/completion-relay.log 2>&1" | crontab -

# Or run manually / 或手动运行
python3 examples/completion-relay/completion_listener.py --loop
```

### Verify / 验证

```bash
# After triggering an ACP task, check the task log
# 触发一个 ACP 任务后检查 task-log
tail -f ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl
```

See [QUICKSTART.md](QUICKSTART.md) and [GETTING_STARTED.md](GETTING_STARTED.md) for detailed deployment guides.

---

## Documentation / 文档导航

| Document | Purpose | Order |
|----------|---------|-------|
| `README.md` | Overview (this file) | 1 |
| `COMMUNICATION_ISSUES.md` | Problem analysis & design rationale | 2 |
| `GETTING_STARTED.md` | Onboarding guide | 3 |
| `QUICKSTART.md` | Quick deployment guide | 4 |
| `AGENT_PROTOCOL.md` | Full protocol specification | 5 |
| `ARCHITECTURE.md` | Architecture design (incl. new communication layer) | 6 |
| `CAPABILITY_LAYERS.md` | Capability tiers (L1/L2/L3) | 7 |
| `ANTIPATTERNS.md` | Pitfalls & lessons learned | 8 |
| `TESTING.md` | Test architecture & how to run | 9 |
| `TEMPLATES.md` | Message & file templates | 10 |
| `INTERNAL_VS_OSS.md` | OSS package vs internal deployment diff | 11 |
| `CONTRIBUTING.md` | How to contribute | 12 |
| `RELEASE_NOTES.md` | Version history | 13 |

---

## Repository Structure / 仓库结构

```
.
├── COMMUNICATION_ISSUES.md    # Communication layer analysis & design (core doc)
├── AGENT_PROTOCOL.md          # Collaboration protocol spec
├── ARCHITECTURE.md            # Architecture design
├── CAPABILITY_LAYERS.md       # Capability tiers (L1/L2/L3)
├── ANTIPATTERNS.md            # Pitfalls & lessons learned
├── plugins/
│   └── spawn-interceptor/     # OpenClaw plugin — auto task tracking
│       ├── index.js           # Plugin (before_tool_call + subagent_ended hooks)
│       ├── package.json
│       ├── openclaw.plugin.json
│       └── README.md
├── examples/
│   ├── completion-relay/      # Completion notification listener
│   │   ├── completion_listener.py
│   │   ├── tests/
│   │   └── README.md
│   ├── l2_capabilities.py     # L2 capability demo
│   └── protocol_messages.py   # Protocol message format demo
└── ...
```

---

## Design Philosophy / 设计哲学

> **If a behavior is mandatory, it should not be optional.**
>
> **如果一个行为是强制的，它就不应该是可选的。**

The old approach required agents to "remember" to register with the watcher via a wrapper function (documentation constraint). The new approach uses plugin hooks to intercept automatically (system constraint).

旧方案要求 Agent "记住"用 wrapper 注册 watcher（文档约束）。新方案用 plugin hook 自动拦截（系统约束）。

See [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) §6 for details.

---

## License / 许可证

MIT License

## Contributing / 贡献

PRs and Issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

欢迎 PR 和 Issue。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
