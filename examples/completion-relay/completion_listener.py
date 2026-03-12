"""
completion_listener.py — Monitors task-log.jsonl for completed/failed tasks and dispatches alerts.

v2.3 compatible: Reads completion events from task-log.jsonl, which is written by:
  - spawn-interceptor's subagent_ended hook (runtime=subagent, <1s latency)
  - spawn-interceptor's ACP Session Poller (runtime=acp, ~15s latency)
  - spawn-interceptor's Stale Reaper (any runtime stuck >30min)
  - task-callback-bus WatcherBus (runtime=external, adapter-driven)

This listener doesn't care about the completion source — it just reads task-log.jsonl
as the single source of truth for all task lifecycle events.

Usage:
    python completion_listener.py --once           # single check
    python completion_listener.py --loop            # continuous (every 30s)
    python completion_listener.py --task-log PATH   # custom task log location

No external dependencies (stdlib only).
"""

import argparse
import json
import os
import time
import logging
from datetime import datetime
from typing import Dict, Set

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [relay] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("completion-relay")

DEFAULT_TASK_LOG = os.path.expanduser(
    "~/.openclaw/shared-context/monitor-tasks/task-log.jsonl"
)
CURSOR_FILE = os.path.expanduser(
    "~/.openclaw/shared-context/monitor-tasks/.relay-cursor-v2"
)


def read_task_log(path: str) -> list:
    entries = []
    if not os.path.exists(path):
        return entries
    with open(path) as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entry["_line"] = line_num
                entries.append(entry)
            except json.JSONDecodeError:
                continue
    return entries


def get_cursor() -> int:
    if os.path.exists(CURSOR_FILE):
        try:
            with open(CURSOR_FILE) as f:
                return int(f.read().strip())
        except (ValueError, OSError):
            pass
    return 0


def set_cursor(line_num: int) -> None:
    os.makedirs(os.path.dirname(CURSOR_FILE) or ".", exist_ok=True)
    with open(CURSOR_FILE, "w") as f:
        f.write(str(line_num))


def notify(task_id: str, status: str, task_desc: str, source: str, runtime: str) -> None:
    icon = {"completed": "OK", "failed": "FAIL"}.get(status, "UPDATE")
    log.info(
        "[%s] Task %s (%s/%s): %s | %s",
        icon, task_id, runtime, source, status, task_desc[:80]
    )


def check_once(task_log_path: str) -> dict:
    stats = {"checked": 0, "completions": 0, "new_spawns": 0}
    cursor = get_cursor()

    entries = read_task_log(task_log_path)
    notified: Set[str] = set()
    max_line = cursor

    for entry in entries:
        line_num = entry.get("_line", 0)
        if line_num <= cursor:
            continue

        stats["checked"] += 1
        max_line = max(max_line, line_num)

        status = entry.get("status", "")
        task_id = entry.get("taskId", "")

        if status in ("completed", "failed") and task_id and task_id not in notified:
            source = entry.get("completionSource", "unknown")
            runtime = entry.get("runtime", "?")
            task_desc = entry.get("task", "")
            notify(task_id, status, task_desc, source, runtime)
            notified.add(task_id)
            stats["completions"] += 1

        elif status == "spawning" and task_id:
            stats["new_spawns"] += 1

    if max_line > cursor:
        set_cursor(max_line)

    return stats


def main():
    parser = argparse.ArgumentParser(description="ACP completion relay listener (v2)")
    parser.add_argument("--task-log", default=DEFAULT_TASK_LOG,
                        help="Path to task-log.jsonl")
    parser.add_argument("--once", action="store_true",
                        help="Single check then exit")
    parser.add_argument("--loop", action="store_true",
                        help="Continuous checking")
    parser.add_argument("--interval", type=int, default=30,
                        help="Check interval in seconds (default: 30)")
    args = parser.parse_args()

    log.info("Completion listener v2 started — log=%s", args.task_log)

    if args.once or not args.loop:
        stats = check_once(args.task_log)
        log.info("Check done: %s", stats)
        return

    log.info("Entering loop (interval=%ds)", args.interval)
    try:
        while True:
            stats = check_once(args.task_log)
            if stats["completions"] or stats["new_spawns"]:
                log.info("Check: %s", stats)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("Listener stopped")


if __name__ == "__main__":
    main()
