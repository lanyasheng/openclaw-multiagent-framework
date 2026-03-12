#!/usr/bin/env python3
"""Task State Machine - Implementation Example

Demonstrates task lifecycle management per AGENT_PROTOCOL.md Section 5.
Implements watcher-driven state transitions and status file updates.

Usage:
    from task_state_machine import TaskStateMachine, TaskState

    task = TaskStateMachine("task_001", "trading")
    task.transition_to(TaskState.IN_PROGRESS, "Fetching market data...")
    task.transition_to(TaskState.COMPLETED, "Analysis complete", report_file="report.md")
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, auto
from typing import Optional, Dict, Any, List, Callable
from pathlib import Path
import json
import os


class TaskState(Enum):
    """Task lifecycle states per AGENT_PROTOCOL.md Section 5.

    State Flow:
        PENDING -> ACKNOWLEDGED -> IN_PROGRESS -> [COMPLETED | FAILED | CANCELLED]
                        |
                        v
                    BLOCKED -> IN_PROGRESS
    """
    PENDING = "pending"           # Task created, not yet acknowledged
    ACKNOWLEDGED = "acknowledged" # Agent accepted the task
    IN_PROGRESS = "in_progress"   # Actively working
    BLOCKED = "blocked"           # Waiting for dependency/resource
    COMPLETED = "completed"       # Successfully finished
    FAILED = "failed"             # Error occurred
    CANCELLED = "cancelled"       # Manually cancelled


class StateTransitionError(Exception):
    """Raised when invalid state transition is attempted."""
    pass


@dataclass
class StateTransition:
    """Record of a state change."""
    from_state: TaskState
    to_state: TaskState
    timestamp: str
    reason: str
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskRecord:
    """Complete task record for status file."""
    task_id: str
    agent: str
    current_state: TaskState
    created_at: str
    updated_at: str
    summary: str
    history: List[StateTransition]
    report_file: Optional[str] = None
    error_details: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "agent": self.agent,
            "state": self.current_state.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "summary": self.summary,
            "history": [
                {
                    "from": t.from_state.value,
                    "to": t.to_state.value,
                    "at": t.timestamp,
                    "reason": t.reason,
                    "metadata": t.metadata,
                }
                for t in self.history
            ],
            "report_file": self.report_file,
            "error_details": self.error_details,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskRecord":
        return cls(
            task_id=data["task_id"],
            agent=data["agent"],
            current_state=TaskState(data["state"]),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            summary=data.get("summary", ""),
            history=[
                StateTransition(
                    from_state=TaskState(h["from"]),
                    to_state=TaskState(h["to"]),
                    timestamp=h["at"],
                    reason=h["reason"],
                    metadata=h.get("metadata", {}),
                )
                for h in data.get("history", [])
            ],
            report_file=data.get("report_file"),
            error_details=data.get("error_details"),
            metadata=data.get("metadata", {}),
        )


class TaskStateMachine:
    """Task state machine with persistence.

    Per AGENT_PROTOCOL.md Section 5, implements:
    - State transitions with validation
    - Status file persistence (JSON)
    - Watcher-compatible notifications
    - History tracking
    """

    # Valid state transitions
    VALID_TRANSITIONS: Dict[TaskState, List[TaskState]] = {
        TaskState.PENDING: [TaskState.ACKNOWLEDGED, TaskState.CANCELLED],
        TaskState.ACKNOWLEDGED: [TaskState.IN_PROGRESS, TaskState.CANCELLED],
        TaskState.IN_PROGRESS: [TaskState.COMPLETED, TaskState.FAILED, TaskState.BLOCKED, TaskState.CANCELLED],
        TaskState.BLOCKED: [TaskState.IN_PROGRESS, TaskState.FAILED, TaskState.CANCELLED],
        TaskState.COMPLETED: [],  # Terminal state
        TaskState.FAILED: [],     # Terminal state
        TaskState.CANCELLED: [],  # Terminal state
    }

    def __init__(
        self,
        task_id: str,
        agent: str,
        status_dir: Optional[Path] = None,
        notification_dir: Optional[Path] = None,
    ):
        """Initialize state machine.

        Args:
            task_id: Unique task identifier
            agent: Agent name (e.g., "trading", "macro")
            status_dir: Directory for status JSON files
            notification_dir: Directory for watcher notifications
        """
        self.task_id = task_id
        self.agent = agent
        self.status_dir = status_dir or Path(os.environ.get(
            "OPENCLAW_STATUS_DIR",
            "./shared-context/job-status"
        )).expanduser()
        self.notification_dir = notification_dir or Path(os.environ.get(
            "OPENCLAW_NOTIFICATION_DIR",
            "./shared-context/monitor-tasks/notifications"
        )).expanduser()

        # Ensure directories exist
        self.status_dir.mkdir(parents=True, exist_ok=True)
        self.notification_dir.mkdir(parents=True, exist_ok=True)

        # Initialize task record
        now = datetime.utcnow().isoformat()
        self._record = TaskRecord(
            task_id=task_id,
            agent=agent,
            current_state=TaskState.PENDING,
            created_at=now,
            updated_at=now,
            summary="Task created",
            history=[],
        )

        # Callbacks for state changes
        self._on_state_change: Optional[Callable[[TaskState, TaskState], None]] = None

    @property
    def state(self) -> TaskState:
        return self._record.current_state

    @property
    def record(self) -> TaskRecord:
        return self._record

    def on_state_change(self, callback: Callable[[TaskState, TaskState], None]):
        """Register callback for state transitions."""
        self._on_state_change = callback

    def can_transition_to(self, new_state: TaskState) -> bool:
        """Check if transition to new_state is valid."""
        return new_state in self.VALID_TRANSITIONS.get(self.state, [])

    def transition_to(
        self,
        new_state: TaskState,
        reason: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        report_file: Optional[str] = None,
    ) -> bool:
        """Attempt state transition.

        Args:
            new_state: Target state
            reason: Human-readable reason for transition
            metadata: Additional context data
            report_file: Path to task report (for completed tasks)

        Returns:
            True if transition succeeded

        Raises:
            StateTransitionError: If transition is invalid
        """
        if not self.can_transition_to(new_state):
            raise StateTransitionError(
                f"Invalid transition: {self.state.value} -> {new_state.value}"
            )

        old_state = self._record.current_state
        now = datetime.utcnow().isoformat()

        # Create transition record
        transition = StateTransition(
            from_state=old_state,
            to_state=new_state,
            timestamp=now,
            reason=reason or f"Transition to {new_state.value}",
            metadata=metadata or {},
        )

        # Update record
        self._record.current_state = new_state
        self._record.updated_at = now
        self._record.summary = reason
        self._record.history.append(transition)

        if report_file:
            self._record.report_file = report_file

        # Persist state
        self._persist_state()

        # Notify watcher
        self._notify_watcher(old_state, new_state)

        # Trigger callback
        if self._on_state_change:
            self._on_state_change(old_state, new_state)

        return True

    def _persist_state(self):
        """Write current state to status file."""
        status_file = self.status_dir / f"{self.task_id}.json"
        with open(status_file, 'w') as f:
            json.dump(self._record.to_dict(), f, indent=2)

    def _notify_watcher(self, old_state: TaskState, new_state: TaskState):
        """Create watcher notification file."""
        notification = {
            "type": "state_change",
            "task_id": self.task_id,
            "agent": self.agent,
            "from_state": old_state.value,
            "to_state": new_state.value,
            "timestamp": datetime.utcnow().isoformat(),
            "summary": self._record.summary,
        }

        notif_file = self.notification_dir / f"{self.task_id}_{datetime.utcnow().timestamp()}.json"
        with open(notif_file, 'w') as f:
            json.dump(notification, f, indent=2)

    def mark_started(self, reason: str = "Task started"):
        """Convenience: Transition to IN_PROGRESS."""
        self.transition_to(TaskState.IN_PROGRESS, reason)

    def mark_completed(self, report_file: Optional[str] = None, summary: str = "Task completed"):
        """Convenience: Transition to COMPLETED."""
        self.transition_to(TaskState.COMPLETED, summary, report_file=report_file)

    def mark_failed(self, error: str, details: Optional[Dict[str, Any]] = None):
        """Convenience: Transition to FAILED with error details."""
        self._record.error_details = {"error": error, "details": details or {}}
        self.transition_to(TaskState.FAILED, f"Failed: {error}", metadata=details)

    def mark_blocked(self, reason: str):
        """Convenience: Transition to BLOCKED."""
        self.transition_to(TaskState.BLOCKED, reason)

    def get_duration_seconds(self) -> float:
        """Get task duration in seconds."""
        created = datetime.fromisoformat(self._record.created_at)
        updated = datetime.fromisoformat(self._record.updated_at)
        return (updated - created).total_seconds()

    @classmethod
    def load_from_file(cls, status_file: Path) -> "TaskStateMachine":
        """Restore state machine from status file."""
        with open(status_file, 'r') as f:
            data = json.load(f)

        record = TaskRecord.from_dict(data)
        sm = cls(record.task_id, record.agent)
        sm._record = record
        return sm


def example_workflow():
    """Demonstrate complete task lifecycle."""
    print("=" * 60)
    print("Task State Machine Example")
    print("=" * 60)

    # Create task
    task = TaskStateMachine(
        task_id="example_task_001",
        agent="trading",
    )

    print(f"\n1. Task Created")
    print(f"   ID: {task.task_id}")
    print(f"   State: {task.state.value}")
    print(f"   Status file: {task.status_dir}/{task.task_id}.json")

    # Transition: PENDING -> ACKNOWLEDGED
    print(f"\n2. Agent acknowledges task")
    task.transition_to(TaskState.ACKNOWLEDGED, "Task accepted, queued for execution")
    print(f"   State: {task.state.value}")

    # Transition: ACKNOWLEDGED -> IN_PROGRESS
    print(f"\n3. Agent starts working")
    task.mark_started("Fetching market data for BTC/USD")
    print(f"   State: {task.state.value}")
    print(f"   Summary: {task.record.summary}")

    # Simulate some work (blocked state)
    print(f"\n4. Waiting for external API...")
    task.mark_blocked("Waiting for exchange API response")
    print(f"   State: {task.state.value}")

    # Back to in_progress
    print(f"\n5. API response received, continuing...")
    task.mark_started("Processing data and generating signals")
    print(f"   State: {task.state.value}")

    # Complete
    print(f"\n6. Task completed")
    task.mark_completed(
        report_file="/path/to/report.md",
        summary="Analysis complete: Buy signal generated"
    )
    print(f"   State: {task.state.value}")
    print(f"   Report: {task.record.report_file}")

    # Show history
    print(f"\n7. State Transition History:")
    for i, transition in enumerate(task.record.history, 1):
        print(f"   {i}. {transition.from_state.value} -> {transition.to_state.value}")
        print(f"      Reason: {transition.reason}")

    print(f"\n8. Final Status File Content:")
    print(json.dumps(task.record.to_dict(), indent=2))

    print("\n" + "=" * 60)
    print("Example complete.")
    print("=" * 60)


if __name__ == "__main__":
    example_workflow()
