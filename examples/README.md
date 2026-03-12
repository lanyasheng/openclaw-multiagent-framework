# Examples

This directory contains reference implementations demonstrating the OpenClaw Agent Protocol concepts.

## Files

### `protocol_messages.py`
Message format implementation per AGENT_PROTOCOL.md.

**Demonstrates:**
- Agent identity format (`agent:<name>:<transport>:<channel>`)
- Message envelope structure
- Handoff message creation (Section 4)
- Status update messages (Section 5)
- ACK message handling (Section 4.2)
- Message parsing and validation

**Run:**
```bash
python3 examples/protocol_messages.py
```

### `task_state_machine.py`
Task lifecycle state machine per AGENT_PROTOCOL.md Section 5.

**Demonstrates:**
- Task state transitions (PENDING → ACKNOWLEDGED → IN_PROGRESS → COMPLETED)
- State validation (prevents invalid transitions)
- Status file persistence (JSON format)
- Watcher notification format
- History tracking
- Terminal states (COMPLETED, FAILED, CANCELLED)

**Run:**
```bash
python3 examples/task_state_machine.py
```

## Integration Guide

### Protocol Messages

```python
from examples.protocol_messages import (
    AgentIdentity,
    HandoffContext,
    create_handoff_message,
    parse_inbound_message,
)

# Create agents
sender = AgentIdentity("trading", "discord", "trading-room")
receiver = AgentIdentity("macro", "discord", "macro-room")

# Create handoff
context = HandoffContext(
    reason="Need macro analysis",
    priority="high",
    required_capabilities=["economic_calendar"]
)

msg = create_handoff_message(
    from_agent=sender,
    to_agent=receiver,
    task_id="task_001",
    task_description="Analyze FOMC impact",
    context=context,
)

# Parse incoming
parsed = parse_inbound_message(raw_json)
```

### State Machine

```python
from examples.task_state_machine import TaskStateMachine, TaskState

# Initialize
task = TaskStateMachine("task_001", "trading")

# Transitions
task.transition_to(TaskState.ACKNOWLEDGED, "Task accepted")
task.mark_started("Fetching data...")
task.mark_completed(report_file="report.md")

# Check history
for t in task.record.history:
    print(f"{t.from_state} -> {t.to_state}")
```

## Environment Variables

Examples use these environment variables (with defaults):

- `OPENCLAW_STATUS_DIR`: Status file location
  - Default: `./shared-context/job-status`
- `OPENCLAW_NOTIFICATION_DIR`: Watcher notification directory
  - Default: `./shared-context/monitor-tasks/notifications`

## Notes

- Examples are **reference implementations**, not production code
- Adapt paths and transport mechanisms to your environment
- See AGENT_PROTOCOL.md for full specification
- See ARCHITECTURE.md for system design
