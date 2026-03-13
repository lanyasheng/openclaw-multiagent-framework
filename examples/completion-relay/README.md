# completion-relay

Lightweight **event consumer** for `task-log.jsonl`.

轻量级 **事件消费者**，从 `task-log.jsonl` 读取事件并做通知/转发。

## What It Is / 它是什么

`completion_listener.py` **不负责判断任务是否真的完成**。

它只做两件事：
1. 读取 `task-log.jsonl`
2. 对新的终态事件（如 `completed` / `failed`）做通知

换句话说，它是 **relay / listener**，不是 completion truth engine。

## Event Writers / 事件写入者

`task-log.jsonl` 通常由以下组件写入：

| Writer / 写入者 | Role / 角色 |
|----------------|-------------|
| `spawn-interceptor` | 启动登记（`spawning`） |
| ACP Session Poller | 基础终态检测 |
| Stale Reaper | 超时兜底 |
| `content-aware-completer` | 终态纠偏（Type 4 task 修复） |
| optional external bridges | 外部任务接入（可选） |

## Data Flow / 数据流

```text
writers
  ↓
task-log.jsonl
  ↓
completion_listener.py
  ↓
stdout / webhook / Discord / Telegram / custom sink
```

## Usage / 用法

```bash
# Single check / 单次检查
python3 completion_listener.py --once

# Continuous monitoring / 持续监听
python3 completion_listener.py --loop --interval 30

# Custom task log path / 自定义路径
python3 completion_listener.py --once --task-log /path/to/task-log.jsonl
```

## Cron Example / 定时任务示例

```bash
*/1 * * * * cd /path/to/completion-relay && python3 completion_listener.py --once >> /tmp/completion-relay.log 2>&1
```

## Event Format / 事件格式

```json
{
  "taskId": "tsk_20260313_abc123",
  "agentId": "main",
  "runtime": "acp",
  "status": "completed",
  "completionSource": "content_reconciler",
  "spawnedAt": "2026-03-13T01:30:00.000Z",
  "completedAt": "2026-03-13T01:32:15.000Z"
}
```

Key fields / 关键字段：
- `status`: `spawning` → `completed` / `failed` / `timeout`
- `completionSource`: e.g. `acp_session_poller` | `stale_reaper` | `content_reconciler`

## Important Notes / 重要说明

- This listener is **append-log consumer logic**, not reconciliation logic.
- If you need completion correction for false non-terminal tasks, use `content-aware-completer`.
- If you need retention / archive / quarantine, implement it outside this listener.

## Extending Notifications / 扩展通知

The current `notify()` just prints to stdout. You can replace it with webhook or bot delivery:

```python
def notify(task_id, status, task_desc, source, runtime):
    print(f"[{status}] {task_id} ({runtime}/{source}): {task_desc}")
```

## Minimal Validation / 最小校验

```bash
python3 completion_listener.py --once --task-log /path/to/task-log.jsonl
python3 -m py_compile completion_listener.py
```
