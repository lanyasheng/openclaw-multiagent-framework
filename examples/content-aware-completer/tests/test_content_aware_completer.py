#!/usr/bin/env python3
"""
Tests for Content-Aware Task Completer

Tests cover:
    - Tier 1 strong evidence detection
    - Historical file rejection
    - Empty file rejection
    - Idempotent writes
    - UTC timezone safety
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from content_aware_completer import (
    COMPLETION_KEYWORDS,
    MIN_CONTENT_SIZE,
    CompletionDecision,
    ContentAwareCompleter,
    TaskEvidence,
)


class TestTaskEvidence(unittest.TestCase):
    """Test TaskEvidence dataclass."""

    def test_basic_creation(self):
        """Test basic TaskEvidence creation."""
        evidence = TaskEvidence(task_id="tsk_123", agent_id="test-agent")
        self.assertEqual(evidence.task_id, "tsk_123")
        self.assertEqual(evidence.agent_id, "test-agent")
        self.assertFalse(evidence.has_stream_closed)
        self.assertFalse(evidence.has_content_output)
        self.assertEqual(evidence.content_size, 0)
        self.assertEqual(evidence.completion_keywords_found, [])
        self.assertEqual(evidence.output_files, [])

    def test_to_dict(self):
        """Test TaskEvidence serialization."""
        evidence = TaskEvidence(
            task_id="tsk_123",
            agent_id="test-agent",
            has_stream_closed=True,
            has_content_output=True,
            content_size=100,
            completion_keywords_found=["completed", "finished"],
            output_files=["/path/to/file.txt"],
            collected_at="2026-03-13T10:00:00+00:00",
        )

        data = evidence.to_dict()
        self.assertEqual(data["taskId"], "tsk_123")
        self.assertEqual(data["agentId"], "test-agent")
        self.assertTrue(data["hasStreamClosed"])
        self.assertTrue(data["hasContentOutput"])
        self.assertEqual(data["contentSize"], 100)
        self.assertEqual(data["completionKeywordsFound"], ["completed", "finished"])
        self.assertEqual(data["outputFiles"], ["/path/to/file.txt"])


class TestCompletionDecision(unittest.TestCase):
    """Test CompletionDecision dataclass."""

    def test_basic_creation(self):
        """Test basic CompletionDecision creation."""
        evidence = TaskEvidence(task_id="tsk_123", agent_id="test-agent")
        decision = CompletionDecision(
            task_id="tsk_123",
            should_complete=True,
            reason="Test reason",
            evidence=evidence,
            confidence="high",
        )
        self.assertEqual(decision.task_id, "tsk_123")
        self.assertTrue(decision.should_complete)
        self.assertEqual(decision.reason, "Test reason")
        self.assertEqual(decision.confidence, "high")


class TestContentAwareCompleter(unittest.TestCase):
    """Test ContentAwareCompleter functionality."""

    def setUp(self):
        """Set up test environment with temp directories."""
        self.temp_dir = tempfile.mkdtemp()
        self.task_log_path = Path(self.temp_dir) / "task-log.jsonl"
        self.agent_outputs_dir = Path(self.temp_dir) / "agent-outputs"
        self.stream_logs_dir = Path(self.temp_dir) / "acp-sessions"

        self.agent_outputs_dir.mkdir(exist_ok=True)
        self.stream_logs_dir.mkdir(exist_ok=True)

        self.completer = ContentAwareCompleter(
            task_log_path=self.task_log_path,
            agent_outputs_dir=self.agent_outputs_dir,
            stream_logs_dir=self.stream_logs_dir,
        )

    def tearDown(self):
        """Clean up temp directory."""
        import shutil

        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_task_log_entry(self, task_id, status="spawning", agent_id="test-agent"):
        """Helper to create a task log entry."""
        entry = {
            "taskId": task_id,
            "agentId": agent_id,
            "status": status,
            "runtime": "acp",
            "spawnedAt": datetime.now(timezone.utc).isoformat(),
        }
        return entry

    def _write_task_log(self, entries):
        """Helper to write entries to task log."""
        self.task_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.task_log_path, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry) + "\n")

    def test_parse_empty_task_log(self):
        """Test parsing empty/non-existent task log."""
        tasks = self.completer._parse_task_log()
        self.assertEqual(tasks, [])

    def test_parse_task_log(self):
        """Test parsing task log with entries."""
        entries = [
            self._create_task_log_entry("tsk_001"),
            self._create_task_log_entry("tsk_002"),
        ]
        self._write_task_log(entries)

        tasks = self.completer._parse_task_log()
        self.assertEqual(len(tasks), 2)
        self.assertEqual(tasks[0]["taskId"], "tsk_001")
        self.assertEqual(tasks[1]["taskId"], "tsk_002")

    def test_get_pending_tasks(self):
        """Test filtering pending tasks."""
        entries = [
            self._create_task_log_entry("tsk_001", "spawning"),
            self._create_task_log_entry("tsk_002", "completed"),
            self._create_task_log_entry("tsk_003", "in_progress"),
        ]
        self._write_task_log(entries)

        pending = self.completer._get_pending_tasks()
        task_ids = [t["taskId"] for t in pending]
        self.assertIn("tsk_001", task_ids)
        self.assertIn("tsk_003", task_ids)
        self.assertNotIn("tsk_002", task_ids)

    def test_check_stream_closed_no_session(self):
        """Test checking stream closed when no session exists."""
        result = self.completer._check_stream_closed("tsk_123")
        self.assertFalse(result)

    def test_check_stream_closed_with_index(self):
        """Test checking stream closed via index.json."""
        # Create index.json with closed session
        index_data = {
            "sessions": {
                "sess_tsk_123": {
                    "closed": True,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
            }
        }
        with open(self.stream_logs_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        result = self.completer._check_stream_closed("tsk_123")
        self.assertTrue(result)

    def test_find_output_files(self):
        """Test finding output files."""
        # Create test output file
        output_file = self.agent_outputs_dir / "tsk_123_output.txt"
        output_file.write_text("Task completed successfully")

        files = self.completer._find_output_files("tsk_123", "test-agent")
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0][0], output_file)
        self.assertEqual(files[0][1], len("Task completed successfully"))

    def test_find_output_files_empty_directory(self):
        """Test finding files in empty directory."""
        files = self.completer._find_output_files("tsk_123", "test-agent")
        self.assertEqual(files, [])

    def test_analyze_content_with_keywords(self):
        """Test content analysis with completion keywords."""
        content = "Task has been completed and finished successfully"
        has_evidence, keywords = self.completer._analyze_content(content)
        self.assertTrue(has_evidence)
        self.assertIn("completed", keywords)
        self.assertIn("finished", keywords)

    def test_analyze_content_without_keywords(self):
        """Test content analysis without completion keywords."""
        content = "Task is still running, please wait"
        has_evidence, keywords = self.completer._analyze_content(content)
        self.assertFalse(has_evidence)
        self.assertEqual(keywords, [])

    def test_is_historical_file(self):
        """Test historical file detection."""
        # Create a file with old timestamp
        old_file = self.agent_outputs_dir / "old_output.txt"
        old_file.write_text("Old content")

        # Manually set file timestamp to 10 minutes ago
        old_time = (datetime.now(timezone.utc) - timedelta(minutes=10)).timestamp()
        os.utime(old_file, (old_time, old_time))

        task_time = datetime.now(timezone.utc).isoformat()
        is_historical = self.completer._is_historical_file(old_file, task_time)
        self.assertTrue(is_historical)

    def test_is_not_historical_file(self):
        """Test non-historical file detection."""
        # Create a new file
        new_file = self.agent_outputs_dir / "new_output.txt"
        new_file.write_text("New content")

        task_time = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        is_historical = self.completer._is_historical_file(new_file, task_time)
        self.assertFalse(is_historical)

    def test_collect_evidence_no_stream_no_content(self):
        """Test evidence collection with no stream and no content."""
        task = self._create_task_log_entry("tsk_123")
        evidence = self.completer.collect_evidence(task)

        self.assertEqual(evidence.task_id, "tsk_123")
        self.assertFalse(evidence.has_stream_closed)
        self.assertFalse(evidence.has_content_output)
        self.assertEqual(evidence.content_size, 0)

    def test_make_completion_decision_tier1(self):
        """Test Tier 1 completion decision (strong evidence)."""
        # Create task and simulate closed stream + content
        task = self._create_task_log_entry("tsk_123")

        # Create output file
        output_file = self.agent_outputs_dir / "tsk_123_output.txt"
        output_file.write_text("Task completed successfully")

        # Create closed session
        index_data = {
            "sessions": {
                "sess_tsk_123": {
                    "closed": True,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
            }
        }
        with open(self.stream_logs_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        decision = self.completer.make_completion_decision(task)

        self.assertTrue(decision.should_complete)
        self.assertEqual(decision.confidence, "high")
        self.assertIn("Tier 1", decision.reason)

    def test_make_completion_decision_tier2(self):
        """Test Tier 2 completion decision (stream closed, no content)."""
        task = self._create_task_log_entry("tsk_123")

        # Create closed session but no content
        index_data = {
            "sessions": {
                "sess_tsk_123": {
                    "closed": True,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
            }
        }
        with open(self.stream_logs_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        decision = self.completer.make_completion_decision(task)

        self.assertFalse(decision.should_complete)
        self.assertEqual(decision.confidence, "medium")
        self.assertIn("Tier 2", decision.reason)

    def test_make_completion_decision_tier3(self):
        """Test Tier 3 completion decision (content, no stream closed)."""
        task = self._create_task_log_entry("tsk_123")

        # Create output file but no closed session
        output_file = self.agent_outputs_dir / "tsk_123_output.txt"
        output_file.write_text("Task completed successfully")

        decision = self.completer.make_completion_decision(task)

        self.assertFalse(decision.should_complete)
        self.assertEqual(decision.confidence, "low")
        self.assertIn("Tier 3", decision.reason)

    def test_make_completion_decision_tier4(self):
        """Test Tier 4 completion decision (no evidence)."""
        task = self._create_task_log_entry("tsk_123")

        decision = self.completer.make_completion_decision(task)

        self.assertFalse(decision.should_complete)
        self.assertEqual(decision.confidence, "low")
        self.assertIn("Tier 4", decision.reason)

    def test_update_task_log_idempotent(self):
        """Test idempotent task log updates."""
        evidence = TaskEvidence(task_id="tsk_123", agent_id="test-agent")
        decision = CompletionDecision(
            task_id="tsk_123",
            should_complete=True,
            reason="Test",
            evidence=evidence,
            confidence="high",
        )

        # First update
        result1 = self.completer.update_task_log(decision)
        self.assertTrue(result1)

        # Second update should be idempotent
        result2 = self.completer.update_task_log(decision)
        self.assertTrue(result2)

        # Check only one entry in log
        with open(self.task_log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        self.assertEqual(len(lines), 1)

    def test_empty_file_rejection(self):
        """Test that empty files are rejected."""
        task = self._create_task_log_entry("tsk_123")

        # Create empty file
        empty_file = self.agent_outputs_dir / "tsk_123_output.txt"
        empty_file.write_text("")  # Empty content

        # Create closed session
        index_data = {
            "sessions": {
                "sess_tsk_123": {
                    "closed": True,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
            }
        }
        with open(self.stream_logs_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        evidence = self.completer.collect_evidence(task)
        # Empty file should be rejected
        self.assertEqual(evidence.content_size, 0)
        self.assertFalse(evidence.has_content_output)

    def test_small_file_rejection(self):
        """Test that files below MIN_CONTENT_SIZE are rejected."""
        task = self._create_task_log_entry("tsk_123")

        # Create small file below threshold
        small_file = self.agent_outputs_dir / "tsk_123_output.txt"
        small_file.write_text("x" * (MIN_CONTENT_SIZE - 1))

        evidence = self.completer.collect_evidence(task)
        self.assertEqual(evidence.content_size, 0)  # Should be rejected

    def test_utc_timestamp(self):
        """Test that timestamps are in UTC."""
        utc_now = self.completer._now_utc()
        parsed = datetime.fromisoformat(utc_now)
        self.assertIsNotNone(parsed.tzinfo)


class TestIntegration(unittest.TestCase):
    """Integration tests."""

    def setUp(self):
        """Set up test environment."""
        self.temp_dir = tempfile.mkdtemp()
        self.task_log_path = Path(self.temp_dir) / "task-log.jsonl"
        self.agent_outputs_dir = Path(self.temp_dir) / "agent-outputs"
        self.stream_logs_dir = Path(self.temp_dir) / "acp-sessions"

        self.agent_outputs_dir.mkdir(exist_ok=True)
        self.stream_logs_dir.mkdir(exist_ok=True)

        self.completer = ContentAwareCompleter(
            task_log_path=self.task_log_path,
            agent_outputs_dir=self.agent_outputs_dir,
            stream_logs_dir=self.stream_logs_dir,
        )

    def tearDown(self):
        """Clean up."""
        import shutil

        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_full_workflow_tier1_completion(self):
        """Test full Tier 1 completion workflow."""
        # 1. Create task log with spawning task
        task_id = "tsk_test_001"
        task = {
            "taskId": task_id,
            "agentId": "test-agent",
            "status": "spawning",
            "runtime": "acp",
            "spawnedAt": datetime.now(timezone.utc).isoformat(),
        }

        self.task_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.task_log_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(task) + "\n")

        # 2. Create output file with completion evidence
        output_file = self.agent_outputs_dir / f"{task_id}_output.txt"
        output_file.write_text("Task completed successfully. All deliverables finished.")

        # 3. Mark session as closed
        index_data = {
            "sessions": {
                f"sess_{task_id}": {
                    "closed": True,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
            }
        }
        with open(self.stream_logs_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        # 4. Process pending tasks
        decisions = self.completer.process_pending_tasks()

        # 5. Verify completion
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertTrue(decision.should_complete)
        self.assertEqual(decision.confidence, "high")
        self.assertEqual(decision.task_id, task_id)

        # 6. Verify task log updated
        with open(self.task_log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        self.assertEqual(len(lines), 2)  # Original + completion entry

        completion_entry = json.loads(lines[1])
        self.assertEqual(completion_entry["taskId"], task_id)
        self.assertEqual(completion_entry["status"], "completed")
        self.assertEqual(completion_entry["completionSource"], "content_aware_completer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
