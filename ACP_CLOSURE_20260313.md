# ACP Closure Report — 2026-03-13

> **2026-03-14 Update**: The root cause of ACP lifecycle invisibility has been identified and fixed upstream. See the "Upstream Fix" section below.

## Summary

As of 2026-03-13 evening, the main ACP completion-truth problem is considered **contained**:

- The Category 4 failure mode is now explicitly recognized:
  - **artifact exists, but task state remains `spawning` / `pending` / `timeout`**
- The content-aware reconciliation path has been validated:
  - `content_aware_completer.py` exists
  - `test_content_aware_completer.py` exists
  - test run passed with **10/10** success
  - `task-log.jsonl` contains real `completionSource = content_reconciler` records

This means the core “completed in reality but not closed in task-log” problem is no longer purely theoretical; we have a working reconciliation path and verified evidence in the live system.

---

## What is now considered true

### 1. ACP completion truth model
ACP task truth should be classified into four buckets:

1. **True success** — artifact exists + terminal success recorded
2. **True failure** — failure evidence exists + terminal failure recorded
3. **Launched deadlock** — registered/launched, but no artifact and no valid terminal close
4. **Registered false non-terminal** — artifact exists, but task remains `spawning` / `pending` / `timeout`

The recent ACP investigation confirmed that Category 4 is a real operational class and must be handled explicitly.

### 2. Validated reconciliation path
The content-aware reconciler is now part of the practical recovery strategy:

- strong evidence can upgrade a false non-terminal ACP task to `completed`
- reconciled entries are marked with `completionSource = content_reconciler`
- reconciliation is append-only and idempotent at the event-stream level

### 3. Better execution mode for ACP bugfix work
For internal ACP repair/debug tasks, the more reliable execution mode is:

- `runtime="acp"`
- `mode="run"`
- `thread=false`
- `streamTo="parent"`

This avoids the thread/session-close ambiguity that contributed to false non-terminal states.

---

## Verified evidence

### Code / files
- `workspace/skills/task_callback_bus/content_aware_completer.py`
- `workspace/skills/task_callback_bus/test_content_aware_completer.py`

### Test result
- command: `python3 test_content_aware_completer.py`
- result: **10/10 tests passed**

### Live evidence
- `shared-context/monitor-tasks/task-log.jsonl` already includes real reconciliation writes with:
  - `status = completed`
  - `completionSource = content_reconciler`

---

## Upstream Fix (2026-03-14)

The root cause of the ACP lifecycle invisibility problem has been identified and fixed:

**Root cause**: `acp-spawn.ts` did not call `registerSubagentRun()` after dispatching an ACP session. This meant ACP sessions were invisible to OpenClaw's subagent registry, so `subagent_ended` hooks never fired for them.

**Fix**: [PR #46308](https://github.com/openclaw/openclaw/pull/46308) adds a `registerSubagentRun()` call in `spawnAcpDirect()` after successful dispatch, wrapped in a `try/catch` to avoid breaking the spawn flow if registration fails.

**Impact**: With this fix deployed, `subagent_ended` hooks now fire for ACP sessions, making the ACP Session Poller (Layer 3) a fallback rather than the sole detection mechanism.

**Related**: [PR #44970](https://github.com/openclaw/openclaw/pull/44970) fixes a separate bug where embedded LLM runs didn't throw `FailoverError`, breaking the model fallback chain.

---

## Remaining open items

The ACP main problem is contained, but the overall system is **not yet fully closed**. The remaining items are:

### A. task-log retention / cleanup policy
Current `task-log.jsonl` behavior is append-only, which is correct for audit history but will grow without bound.

Proposed retention policy:

- terminal tasks older than **48h** → archive
- non-terminal tasks older than **48h** but newer than **7d** → compress to one latest summary per task
- non-terminal tasks older than **7d** → move to quarantine/stale area
- implementation should be merged into the existing **03:00 daily backup chain**, not a separate high-frequency monitor

### B. health / heartbeat reporting semantics
Current health reporting needs to distinguish:

1. **currently due and failed**
2. **historical failed residue, next run not due yet**

Without this split, tasks like weekly jobs can be misreported as “current incidents” when they are actually residual timeout states from off-schedule/manual runs.

### C. timeout root-cause investigation
There are still unresolved timeout-class jobs that need root-cause analysis, including:

- `daily-reflection-trading`
- `macro-daily-check`
- `content-daily-inspiration`

These are timeout symptoms, but their actual causes still need to be separated into:

- prompt too heavy
- external commands too slow
- timeoutSeconds too tight
- scheduling collision / resource contention

### D. off-schedule weekly job trigger source
It is already verified that `trading-weekly-review` was **not** triggered because its cron schedule drifted.

What is verified:

- configured schedule remains Sunday 19:30 (`30 19 * * 0`)
- an off-schedule run occurred on **2026-03-12 22:22 +08:00**
- that run timed out and left a residual `error` state

What is still unresolved:

- the final trigger source for that off-schedule run

---

## Operational decisions adopted

1. Treat ACP false non-terminal states as a first-class operational problem.
2. Use content-aware reconciliation as the minimal repair path.
3. Prefer background ACP run mode for internal bugfix/repair tasks.
4. Merge task-log cleanup into the daily backup/maintenance chain.
5. Do **not** mix cleanup logic into high-frequency monitor polling.
6. Separate residual historical failure from currently-due failure in health reporting.

---

## Bottom line

**ACP completion truth is now materially improved and the main failure mode is under control.**

What remains is no longer the original “we cannot close ACP tasks correctly at all” problem.
The remaining work is operational hardening:

- retention / archive / quarantine for `task-log.jsonl`
- health reporting semantics
- timeout root-cause cleanup
- off-schedule trigger source tracing
