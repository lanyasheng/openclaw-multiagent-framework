# Completion Truth Matrix

> Version: 2026-03-13-v1
> 目标: 明确任务完成的真值来源、降级路径和实现细节

> **See also**: [ARCHITECTURE.md](ARCHITECTURE.md) — four-layer completion architecture

---

## Quick Reference

| Task Type | Normal Completion | Fallback | Safety Net | LLM Involved? |
|-----------|------------------|----------|------------|---------------|
| ACP runtime (`mode=run`) | `acp_session_poller` | `content_reconciler` | `stale_reaper` | No |
| Thread/session-bound | `streamTo="parent"` events | `content_reconciler` | `stale_reaper` | No |
| Orphaned (no registration) | N/A | `content_reconciler` | `stale_reaper` | No |

---

## Completion Sources Explained

### 1. `acp_session_poller` — Primary Source for ACP Tasks

**What it does:**
- Polls `~/.acpx/sessions/index.json` every ~15 seconds
- Checks `closed` field of ACP sessions
- Updates task-log.jsonl when session closes

**Implementation:**
```python
# Local file polling, no LLM
# Reads: ~/.acpx/sessions/index.json
# Writes: task-log.jsonl
```

**Reliability:** High
- Direct session state from OpenClaw
- ~15s latency (acceptable for most tasks)

**Caveats:**
- Only works for ACP runtime
- Session closed ≠ content actually produced (see L4)

---

### 2. `content_reconciler` / `content-aware-completer` — Content Evidence Validation

**What it does:**
- Validates that completed sessions actually produced content
- Prevents "false completion" (session closed but no output)

**Evidence sources:**
| Evidence Type | Source | Weight |
|--------------|--------|--------|
| Output file existence | `agent-outputs/{taskId}/output.md` | High |
| File size | `stat.st_size > 10 bytes` | High |
| File modification time | `mtime > task.spawnTime` | Medium |
| Completion markers | Keywords in file: "completed", "finished", "done" | Medium |
| task-log status | Cross-reference with L3 detection | Medium |

**Implementation:**
```python
# Local file operations, no LLM
# Reads: task-log.jsonl, agent-outputs/*
# Writes: task-log.jsonl (completion entry)
```

**Decision matrix:**

| Session Closed | Content Evidence | Action | Confidence |
|----------------|------------------|--------|------------|
| ✅ Yes | ✅ Yes | Mark completed | High |
| ✅ Yes | ❌ No | Keep pending | Medium (possible false terminal) |
| ❌ No | ✅ Yes | Keep pending | Low (still running) |
| ❌ No | ❌ No | Keep pending | Low |

**Caveats:**
- Historical file rejection: files created >5min before task spawn → rejected
- Empty file rejection: files <10 bytes → rejected
- Not a "model judgment" — purely file/metadata based

---

### 3. `stale_reaper` — Safety Net

**What it does:**
- Marks tasks as `timeout` if pending >30 minutes
- Prevents tasks from staying in "limbo" forever

**When it triggers:**
- Task status = `spawning` or `in_progress`
- Last update >30 minutes ago
- No completion detected by L3/L4

**Role:**
- **Safety net**, not ideal completion source
- Indicates "something went wrong"
- Triggers investigation, not celebration

**Caveats:**
- 30min delay means long tasks may be falsely reaped
- Should be paired with L4 to distinguish "stuck" vs "slow"

---

## Task Type Completion Matrix

### ACP Runtime Tasks (`mode=run`, `runtime=acp`)

| Scenario | L1 Events | L2 Hook | L3 Poller | L4 Content | Result |
|----------|-----------|---------|-----------|------------|--------|
| Normal completion | ✅ progress → closed | ✅ logged | ✅ detects closed | ✅ validates content | **completed** |
| Session closed, no content | ✅ closed | ✅ logged | ✅ detects closed | ❌ rejects (empty) | **pending** → stale reaper |
| Agent crash | ❌ no closed | ✅ logged | ✅ detects closed (on restart) | ❌ no content | **failed** |
| Long-running (>30min) | ✅ progress | ✅ logged | ⏳ waiting | ⏳ waiting | **pending** → reaper → **timeout** |

### Thread/Session-Bound Tasks (`mode=thread`, `mode=session`)

| Scenario | L1 Stream | L2 Hook | L3 Detection | L4 Content | Result |
|----------|-----------|---------|--------------|------------|--------|
| Normal completion | ✅ stream events | ✅ logged | ℹ️ session-based | ✅ validates | **completed** |
| Stream disconnected | ❌ lost events | ✅ logged | ℹ️ manual check | ✅ validates | **completed** (if content) |
| Thread abandoned | ❌ no events | ✅ logged | ℹ️ timeout-based | ❌ no content | **timeout** |

### Orphaned Tasks (no L2 registration)

| Scenario | L2 Hook | L3 Detection | L4 Content | Result |
|----------|---------|--------------|------------|--------|
| Spawned before plugin | ❌ missed | ✅ detects via poller | ✅ validates | **completed** (L4 catches) |
| Spawned outside framework | ❌ missed | ⚠️ may detect | ⚠️ may validate | **unreliable** |

---

## Implementation Details

### ACP Session Poller (L3a)

```python
# Implementation: local JSON polling
# No LLM calls, no external APIs

SESSIONS_INDEX = "~/.acpx/sessions/index.json"
POLL_INTERVAL = 15  # seconds

def poll_acp_sessions():
    with open(SESSIONS_INDEX) as f:
        sessions = json.load(f)

    for session_id, session in sessions.items():
        if session["closed"]:
            task = find_task_by_session(session_id)
            if task and task.status == "pending":
                update_task_log(task.id, status="detected_closed")
```

**Why not use LLM?**
- Session state is binary (closed/open) — no interpretation needed
- File polling is fast and deterministic
- Avoids unnecessary LLM billing

### Content-Aware Completer (L4)

```python
# Implementation: file metadata + content checks
# No LLM calls for completion detection

MIN_CONTENT_SIZE = 10  # bytes
MAX_HISTORY_GAP = 300  # seconds (5 min)

def validate_content_evidence(task):
    output_file = f"agent-outputs/{task.id}/output.md"

    if not os.path.exists(output_file):
        return False, "no_output_file"

    stat = os.stat(output_file)

    # Historical file rejection
    if stat.st_mtime < task.spawned_at - MAX_HISTORY_GAP:
        return False, "historical_file_rejected"

    # Empty file rejection
    if stat.st_size < MIN_CONTENT_SIZE:
        return False, "empty_file_rejected"

    # Completion markers (optional)
    content = open(output_file).read()
    has_markers = any(kw in content for kw in ["completed", "finished", "done"])

    return True, f"size={stat.st_size}, markers={has_markers}"
```

**Why not use LLM for content validation?**
- File existence/size/mtime are objective signals
- Keywords are sufficient for completion markers
- LLM would add cost and latency without proportional benefit

---

## Fallback Chain

```
Primary:    acp_session_poller detects closed session
                ↓ (if content evidence needed)
Fallback:   content_reconciler validates output
                ↓ (if stuck >30min)
Safety Net: stale_reaper marks timeout
                ↓ (if all else fails)
Manual:     Human investigation via task-log
```

---

## Billing Implications

| Component | LLM Calls | Cost | Frequency |
|-----------|-----------|------|-----------|
| `acp_session_poller` | 0 | Free | Every 15s |
| `content_reconciler` | 0 | Free | On-demand / loop |
| `stale_reaper` | 0 | Free | Every 30min |
| `completion-listener` | 0 | Free | Event-driven |

**Total LLM cost for completion detection: $0**

All completion detection is done via:
- Local file system operations
- JSON parsing
- String matching
- Timestamp comparisons

---

## Verification Commands

```bash
# Check task-log for completion sources
grep "completionSource" ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl | tail -20

# Check ACP session index
ls -la ~/.acpx/sessions/index.json
cat ~/.acpx/sessions/index.json | jq '.[] | select(.closed == true)'

# Check content evidence
ls -la ~/.openclaw/shared-context/agent-outputs/
find ~/.openclaw/shared-context/agent-outputs/ -name "output.md" -size +10c

# Check stale reaper status
grep "stale_reaper" ~/.openclaw/shared-context/monitor-tasks/task-log.jsonl | tail -10
```

---

## Known Limitations

1. **ACP-only**: `acp_session_poller` only works for ACP runtime
   - Subagent runtime uses different detection mechanism

2. **File-based**: L4 relies on file outputs
   - Tasks that don't write files need different validation

3. **15s latency**: Not suitable for sub-second completion detection
   - Use L1 event stream (`streamTo="parent"`) for real-time

4. **Local filesystem**: Assumes single-node OpenClaw
   - Distributed setups need different approach

---

*Last updated: 2026-03-14 | See [ARCHITECTURE.md](ARCHITECTURE.md) for full four-layer architecture*

> **2026-03-14 Update**: [PR #46308](https://github.com/openclaw/openclaw/pull/46308) fixes ACP lifecycle registration so `subagent_ended` hooks now fire for ACP sessions. With this fix, `acp_session_poller` becomes a fallback rather than the primary completion source for ACP tasks.
