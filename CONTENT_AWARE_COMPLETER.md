# Content-Aware Task Completer

> Layer 4 of the Four-Layer Completion Pipeline
> Solves the "Type 4 Task" problem (Registered=False, Terminal=False)

**Version**: 2026-03-13-v1 | **Language**: Python 3.10+

---

## What Problem Does It Solve?

In ACP multi-agent systems, tasks can end up in a problematic state we call **"Type 4"**:

| Type | Registered | Terminal | Status |
|------|------------|----------|--------|
| Type 1 | ✅ Yes | ✅ Yes | Normal completion |
| Type 2 | ✅ Yes | ❌ No | Still running |
| Type 3 | ❌ No | ✅ Yes | Zombie/orphaned |
| **Type 4** | **❌ No** | **❌ No** | **"Registered False Non-terminal"** |

**Type 4 tasks** appear to be non-terminal (not complete) but should actually be marked as complete. This happens when:
- ACP session is closed but no completion was recorded
- File was written but session status wasn't updated
- Previous detection layers missed the completion

**The Solution**: Content-aware completion validation that requires **content evidence** before marking a task as complete.

---

## Core Rules

### 1. Tier 1 Strong Evidence

Task is marked complete **only if** both conditions are met:
- ✅ ACP session is closed (`closed: true` in session index)
- ✅ Valid content evidence exists (non-empty output files)

### 2. Historical File Rejection

Prevents marking tasks complete based on old files:
- File created > 5 minutes before task spawned → **rejected**
- Ensures we're not matching against stale outputs

### 3. Empty File Rejection

Ignores placeholder or failed outputs:
- File size < 10 bytes → **rejected**
- Zero-byte files → **rejected**

### 4. Idempotent Writes

Safe to run multiple times:
- Same task processed multiple times → only one completion entry
- Prevents duplicate log entries

### 5. UTC Timezone Safety

All timestamps in UTC:
- `datetime.now(timezone.utc)` for all timestamps
- ISO 8601 format with timezone info

---

## Four-Tier Decision System

```
┌─────────────────────────────────────────────────────────────┐
│                 COMPLETION DECISION TIERS                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  TIER 1: Strong Evidence (HIGH confidence)                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Session Closed: ✅                                 │   │
│  │  Content Evidence: ✅                               │   │
│  │                                                     │   │
│  │  → Action: Mark COMPLETED                           │   │
│  │  → Source: content_aware_completer                  │   │
│  │  → Confidence: high                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  TIER 2: State Without Content (MEDIUM confidence)         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Session Closed: ✅                                 │   │
│  │  Content Evidence: ❌                               │   │
│  │                                                     │   │
│  │  → Action: Keep PENDING                             │   │
│  │  → Reason: Possible false terminal                  │   │
│  │  → Confidence: medium                               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  TIER 3: Content Without State (LOW confidence)            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Session Closed: ❌                                 │   │
│  │  Content Evidence: ✅                               │   │
│  │                                                     │   │
│  │  → Action: Keep PENDING                             │   │
│  │  → Reason: Still running                            │   │
│  │  → Confidence: low                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  TIER 4: No Evidence (LOW confidence)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Session Closed: ❌                                 │   │
│  │  Content Evidence: ❌                               │   │
│  │                                                     │   │
│  │  → Action: Keep PENDING                             │   │
│  │  → Reason: No completion evidence                   │   │
│  │  → Confidence: low                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Installation

```bash
# The content-aware-completer is included in the framework
cd examples/content-aware-completer

# Install dependencies (only standard library required)
python3 --version  # Requires 3.10+
```

---

## Usage

### Command Line

```bash
# Process all pending tasks once
python3 content_aware_completer.py --once

# Dry run (show what would be done)
python3 content_aware_completer.py --once --dry-run

# Process specific task
python3 content_aware_completer.py --once --task-id tsk_20260313_abc123

# Run continuously with 30-second interval
python3 content_aware_completer.py --loop --interval 30

# Custom paths
python3 content_aware_completer.py \
    --once \
    --task-log /path/to/task-log.jsonl \
    --outputs-dir /path/to/agent-outputs
```

### Environment Variables

```bash
# Override default paths
export TASK_LOG_PATH="custom/path/task-log.jsonl"
export AGENT_OUTPUTS_DIR="custom/path/agent-outputs"
export STREAM_LOGS_DIR="~/.acpx/sessions"

python3 content_aware_completer.py --once
```

### Python API

```python
from content_aware_completer import ContentAwareCompleter

# Initialize completer
completer = ContentAwareCompleter(
    task_log_path=Path("shared-context/monitor-tasks/task-log.jsonl"),
    agent_outputs_dir=Path("shared-context/agent-outputs"),
    stream_logs_dir=Path("~/.acpx/sessions"),
)

# Process all pending tasks
decisions = completer.process_pending_tasks()

for decision in decisions:
    print(f"Task {decision.task_id}: {decision.should_complete}")
    print(f"  Reason: {decision.reason}")
    print(f"  Confidence: {decision.confidence}")

# Process specific task
decision = completer.process_single_task("tsk_20260313_abc123")
if decision:
    print(f"Decision: {decision.to_dict()}")
```

---

## Configuration

### Completion Keywords

Content is analyzed for these keywords (case-insensitive):

```python
COMPLETION_KEYWORDS = [
    "completed",
    "finished",
    "done",
    "success",
    "delivered",
    "submitted",
    "acknowledged",
]
```

Customize by editing the source or extending the class.

### Minimum Content Size

```python
MIN_CONTENT_SIZE = 10  # bytes
```

Files smaller than this are considered empty/placeholders.

---

## Output Format

When a task is marked complete, the following entry is appended to `task-log.jsonl`:

```json
{
  "taskId": "tsk_20260313_abc123",
  "status": "completed",
  "completionSource": "content_aware_completer",
  "completionReason": "Tier 1: Session closed + content evidence present",
  "confidence": "high",
  "evidence": {
    "taskId": "tsk_20260313_abc123",
    "agentId": "worker-agent",
    "hasStreamClosed": true,
    "hasContentOutput": true,
    "contentSize": 15420,
    "completionKeywordsFound": ["completed", "finished"],
    "outputFiles": [
      "shared-context/agent-outputs/tsk_20260313_abc123/output.md",
      "shared-context/agent-outputs/tsk_20260313_abc123/summary.json"
    ],
    "collectedAt": "2026-03-13T10:30:00.000+00:00"
  },
  "completedAt": "2026-03-13T10:30:00.000+00:00",
  "updatedAt": "2026-03-13T10:30:00.000+00:00"
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Content-Aware Completer (L4)                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Input: Pending Tasks from task-log.jsonl ─────────┐    │
│  │  • status = "spawning" or "in_progress"            │    │
│  └─────────────────────────────────────────────────────┘    │
│                              ↓                              │
│  ┌─ Evidence Collection ─────────────────────────────┐     │
│  │                                                    │     │
│  │  1. Check Stream Closed                            │     │
│  │     • ~/.acpx/sessions/index.json                  │     │
│  │     • closed: true                                 │     │
│  │                                                    │     │
│  │  2. Find Output Files                              │     │
│  │     • shared-context/agent-outputs/                │     │
│  │     • Match task_id or agent_id                    │     │
│  │                                                    │     │
│  │  3. Validate Files                                 │     │
│  │     • Reject historical (> 5 min before)           │     │
│  │     • Reject empty (< 10 bytes)                    │     │
│  │                                                    │     │
│  │  4. Analyze Content                                │     │
│  │     • Search COMPLETION_KEYWORDS                   │     │
│  │     • Record matches                               │     │
│  │                                                    │     │
│  └─────────────────────────────────────────────────────┘    │
│                              ↓                              │
│  ┌─ Four-Tier Decision ──────────────────────────────┐     │
│  │  • Tier 1: Complete if strong evidence             │     │
│  │  • Tier 2-4: Keep pending with reason              │     │
│  └─────────────────────────────────────────────────────┘    │
│                              ↓                              │
│  ┌─ Output: Update task-log.jsonl ────────────────────┐     │
│  │  • Only for Tier 1 (high confidence)               │     │
│  │  • Idempotent writes                               │     │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Testing

```bash
# Run all tests
cd examples/content-aware-completer
python3 -m pytest tests/ -v

# Run specific test
python3 -m pytest tests/test_content_aware_completer.py::TestContentAwareCompleter::test_make_completion_decision_tier1 -v

# Run with coverage
python3 -m pytest tests/ -v --cov=content_aware_completer
```

### Test Coverage

| Test Category | Count | Description |
|--------------|-------|-------------|
| Unit Tests | 20+ | Core functionality |
| Integration Tests | 1 | Full workflow |
| Edge Cases | 3 | Historical/empty files, idempotency |

---

## Integration with Four-Layer Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    COMPLETION PIPELINE                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  L1: Native Event Stream                                   │
│  • streamTo="parent" → Real-time progress                 │
│                                                             │
│  L2: Registration Layer                                    │
│  • spawn-interceptor → Records spawning                   │
│                                                             │
│  L3: Basic Completion                                      │
│  • ACP Session Poller → Detects session closed            │
│  • Stale Reaper → Timeout safety net                      │
│                                                             │
│  L4: Terminal-State Correction  ◄── YOU ARE HERE          │
│  • content-aware-completer → Validates content evidence   │
│  • Solves Type 4 tasks                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### No tasks being completed

**Check**:
1. Are there pending tasks in `task-log.jsonl`?
2. Are ACP sessions being closed? Check `~/.acpx/sessions/`
3. Are output files being written to `agent-outputs/`?
4. Run with `--dry-run` to see evidence collection

### False completions

**Check**:
1. Historical file rejection working? Check file timestamps
2. Empty file rejection working? Check file sizes
3. Adjust `MIN_CONTENT_SIZE` if needed

### Duplicate completion entries

**This shouldn't happen** (idempotent writes). If it does:
1. Check task-log format
2. Verify `.processed_tasks` tracking
3. File an issue

---

## License

MIT License - See LICENSE file in repository root.
