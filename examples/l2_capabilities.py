#!/usr/bin/env python3
"""
L2 Capability Examples — OpenClaw Multi-Agent Framework

Runnable implementations of key L2 capabilities described in CAPABILITY_LAYERS.md.
Each class is self-contained and can be used independently.

Run all demos:
    python3 examples/l2_capabilities.py

L2 capabilities covered:
  2.1.1  ACK Protocol      — 3-second ACK gate with timeout handling
  2.1.2  Handoff Template   — request/ack/final three-phase handoff
  2.1.3  Deliverable Layers — conclusion + evidence + action structure
  2.1.4  Single Writer      — file-level write lock to prevent races
  2.2.2  Follow-up Bridge   — auto-generate next-day action items from completed tasks
  2.4.1  Daily Reflection   — reflection → followup → next-day action pipeline
"""

import json
import os
import time
import fcntl
import hashlib
from datetime import datetime, timedelta
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any
from enum import Enum


# ---------------------------------------------------------------------------
# 2.1.1  ACK Protocol
# ---------------------------------------------------------------------------

class AckState(Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    TIMEOUT = "timeout"
    FINAL = "final"


@dataclass
class AckMessage:
    """ACK protocol message following Section 4.2 of AGENT_PROTOCOL.md."""
    ack_id: str
    from_agent: str
    to_agent: str
    state: str = AckState.PENDING.value
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    reason: str = ""
    payload: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


class AckGate:
    """
    ACK gate: sender must receive ACK within deadline (default 3s).

    Usage:
        gate = AckGate(timeout_seconds=3)
        gate.send_request("ack-001", "main", "research", {"ask": "fetch news"})
        gate.receive_ack("ack-001", "research", confirmed=True)
        status = gate.check("ack-001")
    """

    def __init__(self, timeout_seconds: float = 3.0):
        self.timeout = timeout_seconds
        self._pending: Dict[str, AckMessage] = {}
        self._history: List[AckMessage] = []

    def send_request(self, ack_id: str, from_agent: str, to_agent: str,
                     payload: Optional[Dict] = None) -> AckMessage:
        msg = AckMessage(
            ack_id=ack_id,
            from_agent=from_agent,
            to_agent=to_agent,
            state=AckState.PENDING.value,
            payload=payload or {},
        )
        self._pending[ack_id] = msg
        self._history.append(msg)
        return msg

    def receive_ack(self, ack_id: str, from_agent: str,
                    confirmed: bool = True, reason: str = "") -> Optional[AckMessage]:
        if ack_id not in self._pending:
            return None
        msg = self._pending[ack_id]
        ack = AckMessage(
            ack_id=ack_id,
            from_agent=from_agent,
            to_agent=msg.from_agent,
            state=AckState.CONFIRMED.value if confirmed else AckState.REJECTED.value,
            reason=reason,
        )
        del self._pending[ack_id]
        self._history.append(ack)
        return ack

    def check_timeouts(self) -> List[str]:
        """Check and mark timed-out requests."""
        now = datetime.now()
        timed_out = []
        for ack_id, msg in list(self._pending.items()):
            sent_at = datetime.fromisoformat(msg.timestamp)
            if (now - sent_at).total_seconds() > self.timeout:
                msg.state = AckState.TIMEOUT.value
                timed_out.append(ack_id)
                del self._pending[ack_id]
                self._history.append(AckMessage(
                    ack_id=ack_id,
                    from_agent="system",
                    to_agent=msg.from_agent,
                    state=AckState.TIMEOUT.value,
                    reason=f"No ACK within {self.timeout}s",
                ))
        return timed_out

    def status(self, ack_id: str) -> str:
        if ack_id in self._pending:
            return AckState.PENDING.value
        for msg in reversed(self._history):
            if msg.ack_id == ack_id:
                return msg.state
        return "unknown"


# ---------------------------------------------------------------------------
# 2.1.2  Handoff Template (request / ack / final)
# ---------------------------------------------------------------------------

@dataclass
class HandoffRequest:
    """Three-phase handoff: request → ack → final."""
    ack_id: str
    from_agent: str
    to_agent: str
    topic: str
    ask: str
    due: str
    priority: str = "normal"
    context: Dict[str, Any] = field(default_factory=dict)
    required_capabilities: List[str] = field(default_factory=list)

    def format_request(self) -> str:
        caps = f" | caps={','.join(self.required_capabilities)}" if self.required_capabilities else ""
        return (f"[Request] ack_id={self.ack_id} | topic={self.topic} | "
                f"ask={self.ask} | due={self.due} | priority={self.priority}{caps}")

    def format_ack(self, state: str = "confirmed", eta: str = "") -> str:
        eta_part = f" | eta={eta}" if eta else ""
        return f"[ACK] ack_id={self.ack_id} state={state}{eta_part}"

    def format_final(self, summary: str, report_file: str = "",
                     next_steps: Optional[List[str]] = None) -> str:
        parts = [f"[Final] ack_id={self.ack_id} state=final"]
        parts.append(f"summary={summary}")
        if report_file:
            parts.append(f"report={report_file}")
        if next_steps:
            parts.append(f"next=[{'; '.join(next_steps)}]")
        return " | ".join(parts)


# ---------------------------------------------------------------------------
# 2.1.3  Deliverable Layers (conclusion + evidence + action)
# ---------------------------------------------------------------------------

@dataclass
class Deliverable:
    """
    Three-layer deliverable structure.

    Conclusion: what's the answer/result (1-2 sentences)
    Evidence: data/analysis backing the conclusion
    Action: concrete next steps
    """
    conclusion: str
    evidence: List[str]
    actions: List[str]
    confidence: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_markdown(self) -> str:
        lines = []
        lines.append("## Conclusion")
        lines.append(self.conclusion)
        if self.confidence < 1.0:
            lines.append(f"\n_Confidence: {self.confidence:.0%}_")
        lines.append("\n## Evidence")
        for e in self.evidence:
            lines.append(f"- {e}")
        lines.append("\n## Actions")
        for a in self.actions:
            lines.append(f"- [ ] {a}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# 2.1.4  Single Writer Rule
# ---------------------------------------------------------------------------

class SingleWriter:
    """
    File-level write lock — prevents multi-agent write races.

    Usage:
        writer = SingleWriter("main")
        with writer.lock("/path/to/file.json"):
            # only "main" can write here
            ...
    """

    def __init__(self, owner: str):
        self.owner = owner
        self._locks: Dict[str, int] = {}

    class _LockContext:
        def __init__(self, path: str, owner: str):
            self.path = path
            self.owner = owner
            self._fd = None

        def __enter__(self):
            lock_path = self.path + ".lock"
            self._fd = open(lock_path, "w")
            fcntl.flock(self._fd, fcntl.LOCK_EX)
            self._fd.write(json.dumps({
                "owner": self.owner,
                "locked_at": datetime.now().isoformat(),
                "pid": os.getpid(),
            }))
            self._fd.flush()
            return self

        def __exit__(self, *args):
            if self._fd:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
                self._fd.close()
                lock_path = self.path + ".lock"
                try:
                    os.unlink(lock_path)
                except OSError:
                    pass

    def lock(self, path: str):
        return self._LockContext(path, self.owner)


# ---------------------------------------------------------------------------
# 2.2.2  Follow-up Bridge
# ---------------------------------------------------------------------------

@dataclass
class FollowUpItem:
    """A single follow-up action item."""
    topic: str
    priority: str
    owner: str
    status: str = "pending"
    evidence_path: str = ""
    source_task_id: str = ""
    due: str = ""

    def to_row(self) -> str:
        return (f"| {self.topic} | {self.priority} | {self.owner} | "
                f"{self.status} | {self.evidence_path} |")


class FollowUpBridge:
    """
    Converts completed tasks into next-day follow-up files.

    When a task completes, the bridge checks if it generated any follow-up
    items and writes them to shared-context/followups/YYYY-MM-DD.md.
    """

    def __init__(self, followups_dir: str):
        self.followups_dir = os.path.expanduser(followups_dir)
        os.makedirs(self.followups_dir, exist_ok=True)

    def generate_from_task(self, task_id: str, summary: str, owner: str,
                           follow_ups: List[Dict[str, str]]) -> str:
        """Generate follow-up items from a completed task."""
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        path = os.path.join(self.followups_dir, f"{tomorrow}.md")

        items = []
        for fu in follow_ups:
            items.append(FollowUpItem(
                topic=fu.get("topic", ""),
                priority=fu.get("priority", "P1"),
                owner=fu.get("owner", owner),
                source_task_id=task_id,
                evidence_path=fu.get("evidence", ""),
            ))

        header = f"# Follow-ups for {tomorrow}\n\n"
        header += "| Topic | Priority | Owner | Status | Evidence |\n"
        header += "|-------|----------|-------|--------|----------|\n"

        content = header + "\n".join(item.to_row() for item in items) + "\n"

        if os.path.exists(path):
            with open(path, "a") as f:
                f.write("\n" + "\n".join(item.to_row() for item in items) + "\n")
        else:
            with open(path, "w") as f:
                f.write(content)

        return path

    def pending_items(self, date: Optional[str] = None) -> List[str]:
        """List pending follow-up items for a date (default: today)."""
        target = date or datetime.now().strftime("%Y-%m-%d")
        path = os.path.join(self.followups_dir, f"{target}.md")
        if not os.path.exists(path):
            return []

        items = []
        with open(path) as f:
            for line in f:
                if "| pending |" in line:
                    items.append(line.strip())
        return items


# ---------------------------------------------------------------------------
# 2.4.1  Daily Reflection Pipeline
# ---------------------------------------------------------------------------

@dataclass
class ReflectionEntry:
    """A daily reflection entry that gets converted to follow-ups."""
    date: str
    what_worked: List[str]
    what_didnt: List[str]
    action_items: List[Dict[str, str]]
    author: str = ""

    def to_markdown(self) -> str:
        lines = [f"# Daily Reflection — {self.date}"]
        if self.author:
            lines.append(f"**Author**: {self.author}")
        lines.append("\n## What Worked")
        for w in self.what_worked:
            lines.append(f"- {w}")
        lines.append("\n## What Didn't")
        for w in self.what_didnt:
            lines.append(f"- {w}")
        lines.append("\n## Action Items (→ tomorrow's follow-ups)")
        for a in self.action_items:
            lines.append(f"- [{a.get('priority', 'P1')}] {a['topic']} (owner: {a.get('owner', 'TBD')})")
        return "\n".join(lines)


class ReflectionPipeline:
    """
    Daily reflection → follow-up pipeline.

    Used by the 09:05 cron job to convert yesterday's reflections
    into today's actionable follow-ups.
    """

    def __init__(self, reflections_dir: str, followups_dir: str):
        self.reflections_dir = os.path.expanduser(reflections_dir)
        self.followups_dir = os.path.expanduser(followups_dir)
        os.makedirs(self.reflections_dir, exist_ok=True)
        self.bridge = FollowUpBridge(self.followups_dir)

    def save_reflection(self, entry: ReflectionEntry) -> str:
        path = os.path.join(self.reflections_dir, f"{entry.date}-reflection.md")
        with open(path, "w") as f:
            f.write(entry.to_markdown())
        return path

    def process_reflection(self, entry: ReflectionEntry) -> str:
        """Save reflection and generate follow-ups for tomorrow."""
        self.save_reflection(entry)
        if entry.action_items:
            return self.bridge.generate_from_task(
                task_id=f"reflection-{entry.date}",
                summary=f"Daily reflection by {entry.author}",
                owner=entry.author,
                follow_ups=entry.action_items,
            )
        return ""


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

def demo_ack_protocol():
    print("=" * 60)
    print("  Demo: ACK Gate Protocol (L2 2.1.1)")
    print("=" * 60)

    gate = AckGate(timeout_seconds=3)

    req = gate.send_request("task-001", "main", "research", {"ask": "fetch AI news"})
    print(f"\n[main → research] {req.to_json()}")
    print(f"  Status: {gate.status('task-001')}")

    ack = gate.receive_ack("task-001", "research", confirmed=True)
    print(f"\n[research → main] {ack.to_json()}")
    print(f"  Status: {gate.status('task-001')}")

    gate.send_request("task-002", "main", "writing", {"ask": "draft report"})
    print(f"\n[main → writing] Sent task-002, no ACK yet...")
    print(f"  Status: {gate.status('task-002')}")

    # Simulate timeout by manually setting timestamp back
    gate._pending["task-002"].timestamp = (
        datetime.now() - timedelta(seconds=5)
    ).isoformat()
    timed_out = gate.check_timeouts()
    print(f"  Timed out: {timed_out}")
    print(f"  Status: {gate.status('task-002')}")
    print()


def demo_handoff():
    print("=" * 60)
    print("  Demo: Handoff Template (L2 2.1.2)")
    print("=" * 60)

    handoff = HandoffRequest(
        ack_id="20260312-001",
        from_agent="main",
        to_agent="research",
        topic="AI Market Analysis",
        ask="Generate weekly AI market report",
        due="18:00",
        priority="high",
        required_capabilities=["web_search", "data_analysis"],
    )

    print(f"\n1. Request: {handoff.format_request()}")
    print(f"2. ACK:     {handoff.format_ack('confirmed', eta='2 hours')}")
    print(f"3. Final:   {handoff.format_final('Report generated', 'reports/weekly-ai.md', ['Review with team', 'Publish to blog'])}")
    print()


def demo_deliverable():
    print("=" * 60)
    print("  Demo: Deliverable Layers (L2 2.1.3)")
    print("=" * 60)

    d = Deliverable(
        conclusion="GPT-4o outperforms Claude 3.5 on code generation by 12% on HumanEval.",
        evidence=[
            "HumanEval benchmark: GPT-4o 92.1% vs Claude 3.5 80.3%",
            "MBPP benchmark: GPT-4o 86.4% vs Claude 3.5 83.7%",
            "Internal eval on 50 benchmark tasks: GPT-4o 78% vs Claude 3.5 71%",
        ],
        actions=[
            "Update default model config to prefer GPT-4o for code tasks",
            "Re-run cost analysis with GPT-4o pricing",
            "Schedule team review for next Wednesday",
        ],
        confidence=0.85,
    )

    print()
    print(d.to_markdown())
    print()


def demo_followup_bridge():
    print("=" * 60)
    print("  Demo: Follow-up Bridge (L2 2.2.2)")
    print("=" * 60)

    import tempfile
    work_dir = tempfile.mkdtemp(prefix="l2-demo-")
    bridge = FollowUpBridge(os.path.join(work_dir, "followups"))

    path = bridge.generate_from_task(
        task_id="analysis-001",
        summary="Market analysis completed",
        owner="research",
        follow_ups=[
            {"topic": "Review analysis with trading team", "priority": "P0", "owner": "main"},
            {"topic": "Update trading parameters", "priority": "P1", "owner": "trading", "evidence": "reports/analysis-001.md"},
            {"topic": "Schedule follow-up with macro", "priority": "P2", "owner": "main"},
        ],
    )

    print(f"\nFollow-up file created: {path}")
    with open(path) as f:
        print(f.read())

    pending = bridge.pending_items((datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d"))
    print(f"Pending items: {len(pending)}")
    print(f"Cleanup: rm -rf {work_dir}")
    print()


def demo_reflection_pipeline():
    print("=" * 60)
    print("  Demo: Daily Reflection Pipeline (L2 2.4.1)")
    print("=" * 60)

    import tempfile
    work_dir = tempfile.mkdtemp(prefix="l2-demo-")
    pipeline = ReflectionPipeline(
        os.path.join(work_dir, "reflections"),
        os.path.join(work_dir, "followups"),
    )

    entry = ReflectionEntry(
        date=datetime.now().strftime("%Y-%m-%d"),
        author="main",
        what_worked=[
            "Task-watcher caught completion within 2 minutes",
            "ACK protocol prevented 3 duplicate sends",
        ],
        what_didnt=[
            "ainews timeout on sessions_send — treated as failure instead of ambiguous success",
            "Follow-up from yesterday not checked until afternoon",
        ],
        action_items=[
            {"topic": "Add timeout handling reminder to ainews AGENTS.md", "priority": "P0", "owner": "main"},
            {"topic": "Move follow-up check cron from 09:05 to 08:30", "priority": "P1", "owner": "butler"},
        ],
    )

    reflection_path = pipeline.save_reflection(entry)
    followup_path = pipeline.process_reflection(entry)

    print(f"\nReflection saved: {reflection_path}")
    print(f"Follow-ups generated: {followup_path}")

    with open(reflection_path) as f:
        print("\n--- Reflection ---")
        print(f.read())

    if followup_path and os.path.exists(followup_path):
        with open(followup_path) as f:
            print("--- Follow-ups ---")
            print(f.read())

    print(f"Cleanup: rm -rf {work_dir}")
    print()


if __name__ == "__main__":
    demo_ack_protocol()
    demo_handoff()
    demo_deliverable()
    demo_followup_bridge()
    demo_reflection_pipeline()

    print("=" * 60)
    print("  All L2 demos completed!")
    print("=" * 60)
    print()
    print("Next steps:")
    print("  1. Run mini-watcher demo:     cd examples/mini-watcher && python3 demo.py")
    print("  2. Read anti-patterns:         cat ANTIPATTERNS.md")
    print("  3. Read capability layers:     cat CAPABILITY_LAYERS.md")
