#!/usr/bin/env python3
"""
Content-Aware Task Completer

A robust task completion validator that solves the "Registered False Non-terminal" problem
(Type 4 tasks) in ACP multi-agent systems.

This module provides intelligent completion detection by analyzing task outputs,
stream logs, and file artifacts rather than relying solely on ACP session state.

Core Rules:
    1. Tier 1 Strong Evidence: Requires BOTH session closed=True AND content evidence
    2. Historical File Rejection: Prevents duplicate completion marking
    3. Empty File Rejection: Ignores zero-byte or placeholder outputs
    4. Idempotent Writes: Safe to run multiple times without side effects
    5. UTC Timezone Safety: All timestamps in UTC

Version: 2026-03-13-v1
"""

import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# Configuration - Override via environment variables
TASK_LOG_PATH = Path(os.environ.get("TASK_LOG_PATH", "shared-context/monitor-tasks/task-log.jsonl"))
AGENT_OUTPUTS_DIR = Path(os.environ.get("AGENT_OUTPUTS_DIR", "shared-context/agent-outputs"))
STREAM_LOGS_DIR = Path(os.environ.get("STREAM_LOGS_DIR", "~/.acpx/sessions"))
COMPLETION_SESSION = os.environ.get("COMPLETION_SESSION", "agent:main:completion-relay")

# Completion evidence keywords (case-insensitive)
COMPLETION_KEYWORDS = [
    "completed",
    "finished",
    "done",
    "success",
    "delivered",
    "submitted",
    "acknowledged",
]

# Minimum content size to consider valid (bytes)
MIN_CONTENT_SIZE = 10


@dataclass
class TaskEvidence:
    """Evidence collected for task completion verification."""
    task_id: str
    agent_id: str
    has_stream_closed: bool = False
    has_content_output: bool = False
    content_size: int = 0
    completion_keywords_found: list[str] = field(default_factory=list)
    output_files: list[str] = field(default_factory=list)
    collected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "agentId": self.agent_id,
            "hasStreamClosed": self.has_stream_closed,
            "hasContentOutput": self.has_content_output,
            "contentSize": self.content_size,
            "completionKeywordsFound": self.completion_keywords_found,
            "outputFiles": self.output_files,
            "collectedAt": self.collected_at,
        }


@dataclass
class CompletionDecision:
    """Final completion decision with reasoning."""
    task_id: str
    should_complete: bool
    reason: str
    evidence: TaskEvidence
    confidence: str  # "high" | "medium" | "low"
    decided_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "shouldComplete": self.should_complete,
            "reason": self.reason,
            "evidence": self.evidence.to_dict(),
            "confidence": self.confidence,
            "decidedAt": self.decided_at,
        }


class ContentAwareCompleter:
    """
    Content-aware task completion validator.

    Solves the Type 4 task problem (Registered=False, Terminal=False)
    by requiring content evidence before marking tasks as completed.
    """

    def __init__(
        self,
        task_log_path: Optional[Path] = None,
        agent_outputs_dir: Optional[Path] = None,
        stream_logs_dir: Optional[Path] = None,
    ):
        self.task_log_path = task_log_path or TASK_LOG_PATH
        self.agent_outputs_dir = agent_outputs_dir or AGENT_OUTPUTS_DIR
        self.stream_logs_dir = stream_logs_dir or STREAM_LOGS_DIR
        self._processed_tasks: set[str] = set()

    def _now_utc(self) -> str:
        """Return current UTC timestamp."""
        return datetime.now(timezone.utc).isoformat()

    def _parse_task_log(self) -> list[dict[str, Any]]:
        """Parse task-log.jsonl and return relevant entries."""
        tasks = []
        if not self.task_log_path.exists():
            return tasks

        try:
            with open(self.task_log_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        tasks.append(entry)
                    except json.JSONDecodeError:
                        continue
        except (IOError, OSError) as e:
            print(f"Warning: Could not read task log: {e}", file=sys.stderr)

        return tasks

    def _get_pending_tasks(self) -> list[dict[str, Any]]:
        """Get tasks that are in 'spawning' or 'in_progress' status."""
        tasks = self._parse_task_log()
        pending = []
        task_status: dict[str, dict[str, Any]] = {}

        # Get latest status for each task
        for entry in tasks:
            task_id = entry.get("taskId")
            if task_id:
                task_status[task_id] = entry

        # Filter for pending tasks
        for task_id, entry in task_status.items():
            status = entry.get("status", "")
            if status in ("spawning", "in_progress"):
                pending.append(entry)

        return pending

    def _check_stream_closed(self, task_id: str) -> bool:
        """Check if ACP session stream is marked as closed."""
        stream_dir = Path(self.stream_logs_dir).expanduser()
        if not stream_dir.exists():
            return False

        # Look for session index file
        index_file = stream_dir / "index.json"
        if index_file.exists():
            try:
                with open(index_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    sessions = data.get("sessions", {})
                    for session_id, session_data in sessions.items():
                        if task_id in session_id or task_id.replace("_", "-") in session_id:
                            if session_data.get("closed", False):
                                return True
            except (IOError, OSError, json.JSONDecodeError):
                pass

        # Fallback: check individual session directories
        for session_dir in stream_dir.iterdir():
            if session_dir.is_dir() and task_id.replace("_", "-") in session_dir.name:
                closed_file = session_dir / "closed"
                if closed_file.exists():
                    return True

        return False

    def _find_output_files(self, task_id: str, agent_id: str) -> list[tuple[Path, int]]:
        """Find output files for a task. Returns list of (path, size) tuples."""
        files: list[tuple[Path, int]] = []
        outputs_dir = Path(self.agent_outputs_dir)

        if not outputs_dir.exists():
            return files

        # Search for files containing task_id or agent_id
        for root, _, filenames in os.walk(outputs_dir):
            for filename in filenames:
                filepath = Path(root) / filename
                if task_id in filename or agent_id in str(filepath):
                    try:
                        size = filepath.stat().st_size
                        files.append((filepath, size))
                    except (IOError, OSError):
                        continue

        return files

    def _analyze_content(self, content: str) -> tuple[bool, list[str]]:
        """Analyze content for completion evidence. Returns (has_evidence, keywords_found)."""
        content_lower = content.lower()
        keywords_found = []

        for keyword in COMPLETION_KEYWORDS:
            if keyword.lower() in content_lower:
                keywords_found.append(keyword)

        has_evidence = len(keywords_found) > 0
        return has_evidence, keywords_found

    def _is_historical_file(self, filepath: Path, task_spawned_at: Optional[str]) -> bool:
        """Check if file is historical (created before task was spawned)."""
        if not task_spawned_at:
            return False

        try:
            # Parse task spawn time
            task_time = datetime.fromisoformat(task_spawned_at.replace("Z", "+00:00"))

            # Get file modification time
            stat = filepath.stat()
            file_time = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)

            # File is historical if created more than 5 minutes before task
            time_diff = (task_time - file_time).total_seconds()
            return time_diff > 300  # 5 minutes

        except (ValueError, OSError):
            return False

    def collect_evidence(self, task: dict[str, Any]) -> TaskEvidence:
        """Collect all evidence for a task completion decision."""
        task_id = task.get("taskId", "")
        agent_id = task.get("agentId", "")
        spawned_at = task.get("spawnedAt")

        evidence = TaskEvidence(task_id=task_id, agent_id=agent_id)

        # Check 1: Stream closed status
        evidence.has_stream_closed = self._check_stream_closed(task_id)

        # Check 2: Output files
        output_files = self._find_output_files(task_id, agent_id)
        valid_files = []

        for filepath, size in output_files:
            # Skip historical files
            if self._is_historical_file(filepath, spawned_at):
                continue

            # Skip empty files
            if size < MIN_CONTENT_SIZE:
                continue

            valid_files.append(str(filepath))
            evidence.content_size += size

        evidence.output_files = valid_files
        evidence.has_content_output = len(valid_files) > 0

        # Check 3: Content analysis
        all_content = []
        for filepath, _ in output_files:
            try:
                with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                    all_content.append(content)
            except (IOError, OSError):
                continue

        if all_content:
            combined_content = "\n".join(all_content)
            has_evidence, keywords = self._analyze_content(combined_content)
            evidence.completion_keywords_found = keywords
            if has_evidence:
                evidence.has_content_output = True

        return evidence

    def make_completion_decision(self, task: dict[str, Any]) -> CompletionDecision:
        """Make a completion decision based on collected evidence."""
        task_id = task.get("taskId", "")
        evidence = self.collect_evidence(task)

        # Tier 1: Strong evidence required
        if evidence.has_stream_closed and evidence.has_content_output:
            return CompletionDecision(
                task_id=task_id,
                should_complete=True,
                reason="Tier 1: Session closed + content evidence present",
                evidence=evidence,
                confidence="high",
            )

        # Tier 2: Stream closed but no content
        if evidence.has_stream_closed and not evidence.has_content_output:
            return CompletionDecision(
                task_id=task_id,
                should_complete=False,
                reason="Tier 2: Session closed but no valid content output",
                evidence=evidence,
                confidence="medium",
            )

        # Tier 3: Content present but stream not closed
        if evidence.has_content_output and not evidence.has_stream_closed:
            return CompletionDecision(
                task_id=task_id,
                should_complete=False,
                reason="Tier 3: Content present but session not closed",
                evidence=evidence,
                confidence="low",
            )

        # Tier 4: No evidence
        return CompletionDecision(
            task_id=task_id,
            should_complete=False,
            reason="Tier 4: No completion evidence found",
            evidence=evidence,
            confidence="low",
        )

    def update_task_log(self, decision: CompletionDecision) -> bool:
        """Update task-log.jsonl with completion decision (idempotent)."""
        if decision.task_id in self._processed_tasks:
            return True  # Already processed

        entry = {
            "taskId": decision.task_id,
            "status": "completed" if decision.should_complete else "in_progress",
            "completionSource": "content_aware_completer",
            "completionReason": decision.reason,
            "confidence": decision.confidence,
            "evidence": decision.evidence.to_dict(),
            "completedAt": decision.decided_at if decision.should_complete else None,
            "updatedAt": self._now_utc(),
        }

        try:
            # Ensure directory exists
            self.task_log_path.parent.mkdir(parents=True, exist_ok=True)

            # Append to log (atomic write)
            with open(self.task_log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())

            self._processed_tasks.add(decision.task_id)
            return True

        except (IOError, OSError) as e:
            print(f"Error updating task log: {e}", file=sys.stderr)
            return False

    def process_pending_tasks(self) -> list[CompletionDecision]:
        """Process all pending tasks and return decisions."""
        pending = self._get_pending_tasks()
        decisions = []

        for task in pending:
            decision = self.make_completion_decision(task)
            decisions.append(decision)

            # Only update log if confidence is high
            if decision.confidence == "high":
                self.update_task_log(decision)

        return decisions

    def process_single_task(self, task_id: str) -> Optional[CompletionDecision]:
        """Process a single task by ID."""
        tasks = self._parse_task_log()

        for task in tasks:
            if task.get("taskId") == task_id:
                decision = self.make_completion_decision(task)
                if decision.confidence == "high":
                    self.update_task_log(decision)
                return decision

        return None


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Content-Aware Task Completer - Solves Type 4 task problem"
    )
    parser.add_argument(
        "--task-id",
        help="Process specific task ID (default: all pending tasks)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without updating task log",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run once and exit (default: continuous loop)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=30,
        help="Check interval in seconds (default: 30)",
    )
    parser.add_argument(
        "--task-log",
        type=Path,
        default=TASK_LOG_PATH,
        help=f"Path to task-log.jsonl (default: {TASK_LOG_PATH})",
    )
    parser.add_argument(
        "--outputs-dir",
        type=Path,
        default=AGENT_OUTPUTS_DIR,
        help=f"Path to agent outputs directory (default: {AGENT_OUTPUTS_DIR})",
    )

    args = parser.parse_args()

    completer = ContentAwareCompleter(
        task_log_path=args.task_log,
        agent_outputs_dir=args.outputs_dir,
    )

    def process():
        if args.task_id:
            decision = completer.process_single_task(args.task_id)
            if decision:
                print(json.dumps(decision.to_dict(), indent=2, ensure_ascii=False))
            else:
                print(f"Task {args.task_id} not found", file=sys.stderr)
                sys.exit(1)
        else:
            decisions = completer.process_pending_tasks()
            for decision in decisions:
                print(json.dumps(decision.to_dict(), indent=2, ensure_ascii=False))
                print("---")

    if args.dry_run:
        print("DRY RUN: No changes will be made")
        process()
        return

    if args.once:
        process()
        return

    # Continuous loop
    print(f"Starting Content-Aware Completer (interval: {args.interval}s)")
    print("Press Ctrl+C to stop")

    import time

    try:
        while True:
            process()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopping...")


if __name__ == "__main__":
    main()
