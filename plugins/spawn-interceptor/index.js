/**
 * spawn-interceptor v3.9.0 — OpenClaw plugin for task lifecycle tracking.
 *
 * Supports multiple runtimes: subagent (primary), ACP (legacy), tmux (via subagent).
 *
 * Completion detection pipeline:
 *   L0. after_tool_call error — immediate spawn failure detection
 *   L1. subagent_ended hook — precise match by targetSessionKey
 *   L1.5. reconcileSubagentRuns — periodic sync against runs.json (catches missed L1)
 *   L2. ACP session poller — smart completion vs failure heuristics (legacy)
 *   L3. Stale reaper — marks tasks stuck > 60min as timeout
 *   L4. before_prompt_build — injects completion/stuck reports into parent turn
 *   L5. Health check — detects stuck tasks (30-60min) with tmux awareness
 *
 * Guards:
 *   - EXEC GUARD: blocks main session from exec-ing runner/claude
 *   - TIMEOUT GUARD: auto-inject timeout for slow commands (disabled: triggers obfuscation-detected)
 *   - IDEMPOTENCY GUARD: blocks duplicate task spawns
 */

import fs from "fs";
import os from "os";
import path from "path";

const SHARED_CTX = path.join(os.homedir(), ".openclaw", "shared-context");
const TASK_LOG = path.join(SHARED_CTX, "monitor-tasks", "task-log.jsonl");
const PENDING_FILE = path.join(SHARED_CTX, "monitor-tasks", ".pending-tasks.json");
const TASK_REGISTRY_FILE = path.join(SHARED_CTX, "monitor-tasks", "subagent-task-registry.json");
const ACPX_SESSIONS_DIR = path.join(os.homedir(), ".acpx", "sessions");
const ACPX_INDEX = path.join(ACPX_SESSIONS_DIR, "index.json");
const GATEWAY_LOG = path.join(os.homedir(), ".openclaw", "logs", "gateway.log");
const SUBAGENT_RUNS_FILE = path.join(os.homedir(), ".openclaw", "subagents", "runs.json");
const TMUX_SOCKET_DIR = path.join(process.env.TMPDIR || "/tmp", "clawdbot-tmux-sockets");
const TMUX_SOCKET = path.join(TMUX_SOCKET_DIR, "clawdbot.sock");
const DEFAULT_COMPLETION_SESSION = "agent:main:completion-relay";

const STALE_TIMEOUT_MS = 60 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const ACP_POLL_INTERVAL_MS = 15 * 1000;
const PROGRESS_RELAY_INTERVAL_MS = 15 * 1000;
const PROGRESS_MAX_CHARS = 300;
const SUSPECTED_FAILURE_GRACE_MS = 45 * 1000;
const CHILD_SESSION_COMPLETION_GRACE_MS = 10 * 60 * 1000;

let pendingTasks = new Map();
let reaperTimer = null;
let acpPollerTimer = null;
let progressRelayTimer = null;
let pluginLogger = null;
let pluginRuntime = null;
let pluginConfig = null;
let consumedAcpSessionIds = new Set();
let lastProgressRelayOffset = {};
let completedTasksSinceLastPrompt = new Map();

// --- Persistence ---

function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8"));
      pendingTasks = new Map(Object.entries(data));
    }
  } catch { /* start fresh */ }
}

function savePending() {
  try {
    const dir = path.dirname(PENDING_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = PENDING_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(pendingTasks), null, 2));
    fs.renameSync(tmp, PENDING_FILE);
  } catch { /* non-fatal */ }
}


function loadSubagentRuns() {
  try {
    if (!fs.existsSync(SUBAGENT_RUNS_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(SUBAGENT_RUNS_FILE, "utf-8"));
    return data?.runs || {};
  } catch {
    return {};
  }
}

function findSubagentRun(childSessionKey) {
  if (!childSessionKey) return null;
  const runs = loadSubagentRuns();
  for (const run of Object.values(runs)) {
    if (run.childSessionKey === childSessionKey) return run;
  }
  return null;
}

function listActiveTmuxSessions() {
  try {
    if (!fs.existsSync(TMUX_SOCKET)) return [];
    const { execSync } = require("child_process");
    const raw = execSync(`tmux -S "${TMUX_SOCKET}" list-sessions -F "#{session_name}" 2>/dev/null`, { timeout: 5000 }).toString().trim();
    return raw ? raw.split("\n").filter(s => s.startsWith("cc-")) : [];
  } catch {
    return [];
  }
}

function checkTmuxReportExists(label) {
  const session = `cc-${label}`;
  const reportJson = `/tmp/${session}-completion-report.json`;
  return fs.existsSync(reportJson);
}

function getTmuxTaskEvidence(task) {
  const tmuxSessions = listActiveTmuxSessions();
  if (tmuxSessions.length === 0) {
    return { hasTmux: false, anyAlive: false, reportExists: false };
  }

  const taskText = task.task || "";
  let matchedSession = null;

  // Try to match by label in task text
  const labelMatch = taskText.match(/--label\s+["']?([\w-]+)/);
  if (labelMatch) {
    const sessionName = `cc-${labelMatch[1]}`;
    if (tmuxSessions.includes(sessionName)) {
      matchedSession = sessionName;
    }
  }

  // Only match if we have a precise label match — avoid false association
  if (!matchedSession) {
    // No precise match: check if ANY cc-* report matches task timing
    // but don't associate with a random session
    return { hasTmux: false, anyAlive: tmuxSessions.length > 0, reportExists: false };
  }

  const label = matchedSession.replace(/^cc-/, "");
  const reportExists = checkTmuxReportExists(label);
  return { hasTmux: true, anyAlive: true, session: matchedSession, reportExists };
}

function genId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `tsk_${ts}_${r}`;
}

function appendLog(entry) {
  const dir = path.dirname(TASK_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(TASK_LOG, JSON.stringify(entry) + "\n");
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureParentDir(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, filePath);
}

export function loadTaskRegistry(registryFile = TASK_REGISTRY_FILE) {
  try {
    if (!fs.existsSync(registryFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveTaskRegistry(registry, registryFile = TASK_REGISTRY_FILE) {
  writeJsonAtomic(registryFile, registry || {});
}

export function terminalStatusToTaskState(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "assumed_complete") return "completed";
  if (normalized === "failed" || normalized === "timeout") return "failed";
  return normalized || "failed";
}

export function nextCallbackStatus(currentStatus, stage, state) {
  const normalizedState = String(state || "").trim().toLowerCase();
  if (!["completed", "failed", "degraded"].includes(normalizedState)) {
    throw new Error(`callback stage requires terminal task state, got ${state}`);
  }

  const transitions = {
    pending: {
      final_callback_sent: "sent",
      final_callback_failed: "failed",
    },
    sent: {
      callback_receipt_acked: "acked",
    },
  };

  const next = transitions[String(currentStatus || "").trim().toLowerCase()]?.[stage];
  if (!next) {
    throw new Error(`illegal callback transition: ${currentStatus} --${stage}--> ?`);
  }
  return next;
}

export function patchTaskRegistry(taskId, mutator, registryFile = TASK_REGISTRY_FILE) {
  if (!taskId) throw new Error("taskId is required");
  const registry = loadTaskRegistry(registryFile);
  const previous = registry[taskId] || null;
  const next = mutator(previous ? JSON.parse(JSON.stringify(previous)) : null);
  if (!next) throw new Error(`task registry mutator returned empty record for ${taskId}`);
  registry[taskId] = next;
  saveTaskRegistry(registry, registryFile);
  return next;
}

export function recordTrackedTask(task, registryFile = TASK_REGISTRY_FILE) {
  return patchTaskRegistry(task?.taskId, (previous) => ({
    task_id: task?.taskId,
    owner: task?.agentId || previous?.owner || "?",
    runtime: task?.runtime || previous?.runtime || "subagent",
    state: previous?.state || "queued",
    evidence: {
      ...(previous?.evidence || {}),
      task: task?.task || previous?.evidence?.task || "",
      requester_session_key: task?.requesterSessionKey || previous?.evidence?.requester_session_key || null,
      spawned_at: task?.spawnedAt || previous?.evidence?.spawned_at || null,
    },
    callback_status: previous?.callback_status || "pending",
  }), registryFile);
}

export function recordTaskTerminal(task, status, evidence = {}, registryFile = TASK_REGISTRY_FILE) {
  const taskState = terminalStatusToTaskState(status);
  return patchTaskRegistry(task?.taskId, (previous) => ({
    task_id: task?.taskId,
    owner: task?.agentId || previous?.owner || "?",
    runtime: task?.runtime || previous?.runtime || "subagent",
    state: taskState,
    evidence: {
      ...(previous?.evidence || {}),
      ...(evidence || {}),
      terminal_status: status,
      completed_at: (evidence && evidence.completed_at) || new Date().toISOString(),
    },
    callback_status: previous?.callback_status || "pending",
  }), registryFile);
}

export function recordTaskCallbackStage(taskId, stage, patch = {}, registryFile = TASK_REGISTRY_FILE) {
  return patchTaskRegistry(taskId, (previous) => {
    if (!previous) throw new Error(`task registry record not found for ${taskId}`);

    const nextStatus = nextCallbackStatus(previous.callback_status || "pending", stage, previous.state);
    const history = Array.isArray(previous.evidence?.callback?.history)
      ? [...previous.evidence.callback.history]
      : [];
    history.push({
      stage,
      callback_status: nextStatus,
      occurred_at: patch.occurred_at || new Date().toISOString(),
      ...(patch || {}),
    });

    return {
      ...previous,
      evidence: {
        ...(previous.evidence || {}),
        callback: {
          ...(previous.evidence?.callback || {}),
          ...patch,
          last_stage: stage,
          last_updated_at: patch.occurred_at || new Date().toISOString(),
          history,
        },
      },
      callback_status: nextStatus,
    };
  }, registryFile);
}

function relay(taskId, requesterSessionKey) {
  const relayTarget = requesterSessionKey || DEFAULT_COMPLETION_SESSION;
  return `\n\n---\n[COMPLETION RELAY — OPTIONAL]\nWhen done, call sessions_send with:\n  sessionKey: "${relayTarget}"\n  message: {"type":"acp_completion","taskId":"${taskId}","status":"completed or failed","summary":"one-sentence result"}\nThis is optional — completion is tracked automatically.\n---`;
}

function parseDiscordChannelFromSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const m = sessionKey.match(/discord:channel:(\d+)/);
  return m ? m[1] : null;
}

function extractChildSessionKey(result) {
  if (!result || typeof result !== "object") return null;

  // Format 1: result.details.childSessionKey (OpenClaw tool result format)
  if (result.details?.childSessionKey) return result.details.childSessionKey;

  // Format 2: result.content is AgentMessage array [{ type: "text", text: JSON }]
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed.childSessionKey) return parsed.childSessionKey;
        } catch { continue; }
      }
    }
  }

  // Format 3: result.content is a string (JSON)
  if (typeof result.content === "string") {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed.childSessionKey) return parsed.childSessionKey;
    } catch { /* fallthrough */ }
  }

  // Format 4: direct object
  return result.childSessionKey || result.sessionKey || null;
}

function extractStreamLogPath(result) {
  if (!result || typeof result !== "object") return null;
  if (result.details?.streamLogPath) return result.details.streamLogPath;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed.streamLogPath) return parsed.streamLogPath;
        } catch { continue; }
      }
    }
  }
  return result.streamLogPath || null;
}

// --- Retry wrapper for Discord API calls ---

async function sendWithRetry(target, text, opts, maxRetries = 3) {
  if (!pluginRuntime?.channel?.discord?.sendMessageDiscord) return false;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await pluginRuntime.channel.discord.sendMessageDiscord(String(target), text, opts);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        pluginLogger?.warn(`spawn-interceptor: Discord send failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err?.message}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  pluginLogger?.warn(`spawn-interceptor: Discord send exhausted ${maxRetries + 1} attempts: ${lastErr?.message}`);
  return false;
}

// --- Notification helpers ---

async function notifyDiscord(_task, _status, _summary) {
  // Disabled — completion delivery uses prompt injection (L4) + parent wake
}

export function getCompletionQueueKey(sessionKey, fallback = DEFAULT_COMPLETION_SESSION) {
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : fallback;
}

export function enqueueCompletedTask(queueMap, task, status, completedAt = new Date().toISOString()) {
  const queueKey = getCompletionQueueKey(task?.requesterSessionKey);
  const bucket = queueMap.get(queueKey) || [];
  bucket.push({
    taskId: task?.taskId,
    status,
    childSessionKey: task?.acpSessionKey || task?.spawnedSessionKey || null,
    task: (task?.task || "").slice(0, 100),
    completedAt,
  });
  queueMap.set(queueKey, bucket);
  return queueKey;
}

export function consumeCompletedTasksForSession(queueMap, sessionKey) {
  const queueKey = getCompletionQueueKey(sessionKey);
  const tasks = queueMap.get(queueKey) || [];
  if (tasks.length > 0) {
    queueMap.delete(queueKey);
  }
  return tasks;
}

export function buildCompletionInjection(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const lines = tasks.map(t => {
    const s = t.status === "completed" || t.status === "assumed_complete" ? "✅"
      : t.status === "timeout" ? "⏰"
      : t.status === "possibly_stuck" ? "⚠️"
      : "❌";
    return `${s} [${t.taskId}] ${t.task}`;
  });

  const hasTimeout = tasks.some(t => t.status === "timeout");
  const hasCompleted = tasks.some(t => t.status === "completed" || t.status === "assumed_complete");
  
  let guidance = "If you have follow-up tasks to dispatch, please continue. Otherwise, report the results to the user.";
  const hasStuck = tasks.some(t => t.status === "possibly_stuck");
  if (hasTimeout || hasStuck) {
    const rules = [];
    if (hasStuck) rules.push("- ⚠️ tasks: POSSIBLY STUCK — task has been running for 60+ min with no progress. Notify user immediately and ask: investigate, cancel, or keep waiting?");
    if (hasTimeout) rules.push("- ⏰ tasks: TIMED OUT — Report status to user. Do NOT auto-retry. Ask user whether to retry, skip, or investigate.");
    if (hasCompleted) rules.push("- ✅ tasks: Process normally and continue workflow.");
    rules.push("- If all tasks timed out/stuck and user is not active, just log status and wait.");
    guidance = `TASK STATUS HANDLING RULES:\n${rules.join("\n")}`;
  }
  
  return `\n\n[SYSTEM — ACP Task Completion Report]\nThe following ACP tasks have completed since your last turn:\n${lines.join("\n")}\n\n${guidance}\n[END REPORT]`;
}

export function isIgnorableSystemProgress(text) {
  if (typeof text !== "string") return true;
  const normalized = text.trim();
  if (!normalized) return true;
  return normalized.startsWith("Started ") || normalized.includes("has produced no output for");
}

export function resolveTranscriptPath(streamLogPath) {
  if (!streamLogPath || typeof streamLogPath !== "string") return null;
  const transcriptPath = streamLogPath.replace(/\.acp-stream\.jsonl$/, ".jsonl");
  if (transcriptPath === streamLogPath) return null;
  return fs.existsSync(transcriptPath) ? transcriptPath : null;
}

export function readProgressFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const buf = fs.readFileSync(transcriptPath, "utf-8");
    const lines = buf.split("\n").filter(Boolean);
    const chunks = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg || msg.role !== "assistant") continue;
        const content = msg.content;
        if (typeof content === "string" && content.trim()) {
          chunks.push(content.trim());
          continue;
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
              chunks.push(block.text.trim());
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (chunks.length === 0) return null;
    const combined = chunks.join("\n").trim();
    return combined || null;
  } catch {
    return null;
  }
}

export function readCompletionEvidence(task, acpSessionKey) {
  const transcriptPath = resolveTranscriptPath(task?.streamLogPath);
  const transcriptText = transcriptPath ? readProgressFromTranscript(transcriptPath) : null;
  if (transcriptText) {
    return {
      summary: transcriptText,
      hasMeaningfulOutput: true,
      source: "transcript",
    };
  }

  const streamText = readLatestProgress(acpSessionKey, task?.streamLogPath);
  if (!streamText) {
    return {
      summary: "",
      hasMeaningfulOutput: false,
      source: "none",
    };
  }

  return {
    summary: streamText,
    hasMeaningfulOutput: !isIgnorableSystemProgress(streamText),
    source: isIgnorableSystemProgress(streamText) ? "system" : "stream",
  };
}

export function classifyClosedAcpSession({
  spawnTs,
  now = Date.now(),
  lastUsed,
  created,
  progress,
  hasMeaningfulOutput,
  childSessionActive = false,
  minFailureAgeMs = SUSPECTED_FAILURE_GRACE_MS,
  minChildSessionCompletionAgeMs = CHILD_SESSION_COMPLETION_GRACE_MS,
}) {
  const taskAge = Math.max(0, now - spawnTs);
  const wasNeverUsed = Boolean(lastUsed && created && lastUsed === created);
  const tooShort = taskAge < 120_000;
  const hasNoOutput = hasMeaningfulOutput === undefined
    ? (!progress || progress.length < 20)
    : !hasMeaningfulOutput;
  const shouldDeferCompletion = childSessionActive && hasNoOutput && taskAge < minChildSessionCompletionAgeMs;
  const isSuspectedFailure = !childSessionActive && (wasNeverUsed || tooShort) && hasNoOutput;
  const shouldDeferFailure = isSuspectedFailure && taskAge < minFailureAgeMs;
  const failureReason = isSuspectedFailure
    ? `suspected failure: wasNeverUsed=${wasNeverUsed}, tooShort=${tooShort}, hasNoOutput=${hasNoOutput}`
    : null;

  return {
    taskAge,
    wasNeverUsed,
    tooShort,
    hasNoOutput,
    isSuspectedFailure,
    shouldDeferFailure,
    shouldDeferCompletion,
    failureReason,
    finalStatus: isSuspectedFailure ? "failed" : "completed",
  };
}

async function onTaskCompleted(task, status, summary) {
  await notifyDiscord(task, status, summary || "").catch(() => {});

  try {
    const queueKey = enqueueCompletedTask(completedTasksSinceLastPrompt, task, status);
    pluginLogger?.info(`spawn-interceptor: queued completion ${task.taskId} (status=${status}) for prompt injection, session=${queueKey}`);

    if (task?.runtime === "subagent") {
      recordTaskCallbackStage(task.taskId, "final_callback_sent", {
        summary: summary || "completion queued for parent delivery",
        queue_key: queueKey,
      });
    }

    // Actively trigger parent agent's new turn to pick up prompt injection
    const parentSessionKey = task.requesterSessionKey;
    pluginLogger?.info(`spawn-interceptor: parent wake: parentKey=${parentSessionKey || "NONE"}`);
    if (parentSessionKey) {
      wakeParentSession(task, status, summary || "");
    }
  } catch (err) {
    if (task?.runtime === "subagent") {
      try {
        recordTaskCallbackStage(task.taskId, "final_callback_failed", {
          summary: summary || "completion delivery failed",
          error: err?.message || String(err),
        });
      } catch {}
    }
    throw err;
  }
}

// --- Parent wake ---

async function wakeParentSession(task, status, summary) {
  const parentSessionKey = task.requesterSessionKey;
  if (!parentSessionKey) return;

  const emoji = status === "completed" || status === "assumed_complete" ? "✅" : status === "failed" ? "❌" : "⏰";
  const shortSummary = (summary || "").slice(0, 300);
  const msg = `${emoji} ACP task ${task.taskId} finished (${status}).${shortSummary ? " Summary: " + shortSummary : ""}`;

  // Strategy 1: pluginRuntime.subagent.run (only works within gateway request context)
  if (pluginRuntime?.subagent?.run) {
    try {
      const r = await pluginRuntime.subagent.run({
        sessionKey: parentSessionKey,
        message: msg,
        deliver: true,
      });
      pluginLogger?.info(`spawn-interceptor: woke parent via subagent.run (runId=${r?.runId})`);
      return;
    } catch (err) {
      pluginLogger?.info(`spawn-interceptor: subagent.run unavailable (${err?.message}), falling back to CLI`);
    }
  }

  // Strategy 2: openclaw agent CLI with --session-id (works outside request context)
  // Resolve the correct Discord channel from parentSessionKey to avoid routing to the default channel.
  try {
    const { exec } = require("child_process");
    const escapedMsg = msg.replace(/'/g, "'\\''");
    const channelId = parseDiscordChannelFromSessionKey(parentSessionKey);
    const channelArg = channelId ? `--to 'channel:${channelId}' --channel discord` : "--channel discord";
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.npm-global/bin:$PATH"; openclaw agent --session-id '${parentSessionKey}' --message '${escapedMsg}' --deliver ${channelArg} 2>&1`;
    exec(cmd, { timeout: 60000, env: { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.HOME || "") + "/.npm-global/bin:" + (process.env.PATH || "") } }, (err, stdout) => {
      if (err) {
        pluginLogger?.warn(`spawn-interceptor: CLI parent wake failed: ${err.message}${stdout ? " stdout=" + stdout.slice(0, 200) : ""}`);
      } else {
        pluginLogger?.info(`spawn-interceptor: woke parent via CLI (sessionId=${parentSessionKey}, channel=${channelId || "default"})`);
      }
    });
  } catch (err) {
    pluginLogger?.warn(`spawn-interceptor: CLI exec failed: ${err?.message}`);
  }
}

// --- Progress relay ---

export function findStreamFileForSessionEntries(entries, acpSessionKey, sessionsDir = ACPX_SESSIONS_DIR, logger = pluginLogger) {
  const openEntries = entries.filter(entry => !entry.closed);
  const closedEntries = entries.filter(entry => entry.closed);

  for (const [groupLabel, group] of [["open", openEntries], ["closed", closedEntries]]) {
    for (const entry of group) {
      const fp = path.join(sessionsDir, entry.file || "");
      try {
        const detail = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (detail.name === acpSessionKey) {
          const streamFile = path.join(sessionsDir, entry.acpxRecordId + ".stream.ndjson");
          const exists = fs.existsSync(streamFile);
          logger?.info(`spawn-interceptor: findStreamFile MATCH name=${acpSessionKey}, rid=${entry.acpxRecordId}, state=${groupLabel}, stream=${exists}`);
          return exists ? streamFile : null;
        }
      } catch {
        continue;
      }
    }
  }

  logger?.info(`spawn-interceptor: findStreamFile no match for ${acpSessionKey} in ${openEntries.length} open / ${closedEntries.length} closed entries`);
  return null;
}

function findStreamFile(acpSessionKey) {
  try {
    if (!fs.existsSync(ACPX_INDEX)) {
      pluginLogger?.info("spawn-interceptor: findStreamFile - ACPX_INDEX does not exist");
      return null;
    }
    const index = JSON.parse(fs.readFileSync(ACPX_INDEX, "utf-8"));
    const entries = index.entries || [];
    return findStreamFileForSessionEntries(entries, acpSessionKey, ACPX_SESSIONS_DIR, pluginLogger);
  } catch (err) {
    pluginLogger?.warn(`spawn-interceptor: findStreamFile error: ${err?.message}`);
  }
  return null;
}

function readLatestProgress(acpSessionKey, streamLogPath) {
  // Priority 1: OpenClaw's own ACP stream log (from sessions_spawn result)
  if (streamLogPath && fs.existsSync(streamLogPath)) {
    return readProgressFromStream(streamLogPath, acpSessionKey);
  }
  // Priority 2: acpx session's stream.ndjson
  const acpxStream = findStreamFile(acpSessionKey);
  if (acpxStream) {
    return readProgressFromStream(acpxStream, acpSessionKey);
  }
  // Priority 3: gateway.log agent:nested
  return readProgressFromGatewayLog(acpSessionKey);
}

function readProgressFromStream(streamFile, sessionId) {
  try {
    const stat = fs.statSync(streamFile);
    const readFrom = lastProgressRelayOffset[sessionId] || Math.max(0, stat.size - 30000);
    if (stat.size <= readFrom) return null;
    const fd = fs.openSync(streamFile, "r");
    const readLen = Math.min(stat.size - readFrom, 30000);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readFrom);
    fs.closeSync(fd);
    lastProgressRelayOffset[sessionId] = stat.size;

    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter(Boolean);

    const textChunks = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        // Format 1: acpx stream.ndjson (JSON-RPC)
        const update = msg?.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
          textChunks.push(update.content.text);
          continue;
        }

        // Format 2: OpenClaw acp-stream.jsonl
        if (msg.kind === "system_event" && msg.text) {
          textChunks.push(msg.text);
          continue;
        }
        if (msg.kind === "assistant_delta" && msg.delta) {
          textChunks.push(msg.delta);
          continue;
        }
      } catch { continue; }
    }

    if (textChunks.length === 0) return null;

    let combined = textChunks.slice(-5).join("").trim();
    if (combined.length > PROGRESS_MAX_CHARS) {
      combined = combined.slice(-PROGRESS_MAX_CHARS);
    }
    return combined || null;
  } catch { return null; }
}

function readProgressFromGatewayLog(sessionId) {
  try {
    if (!fs.existsSync(GATEWAY_LOG)) return null;
    const stat = fs.statSync(GATEWAY_LOG);
    const readFrom = lastProgressRelayOffset[sessionId] || Math.max(0, stat.size - 50000);
    if (stat.size <= readFrom) return null;
    const fd = fs.openSync(GATEWAY_LOG, "r");
    const readLen = Math.min(stat.size - readFrom, 50000);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readFrom);
    fs.closeSync(fd);
    lastProgressRelayOffset[sessionId] = stat.size;

    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter(l => l.includes("agent:nested") && l.includes(sessionId));
    if (lines.length === 0) return null;

    const last = lines[lines.length - 1];
    const match = last.match(/channel=\w+\s+(.*)/);
    if (!match) return null;

    let content = match[1].trim();
    if (content.length > PROGRESS_MAX_CHARS) {
      content = content.slice(0, PROGRESS_MAX_CHARS) + "…";
    }
    return content;
  } catch { return null; }
}

async function relayProgress() {
  if (!pluginRuntime?.channel?.discord?.sendMessageDiscord) return;

  loadPending();

  const trackableTasks = [...pendingTasks.entries()].filter(([, t]) => t.runtime === "acp" || t.runtime === "subagent");
  if (trackableTasks.length === 0) return;

  for (const [taskId, task] of trackableTasks) {
    const rawTarget = task.discordThreadId || task.discordChannelId;
    if (!rawTarget) {
      continue;
    }
    const target = String(rawTarget).match(/^\d+$/) ? `channel:${rawTarget}` : String(rawTarget);

    const acpSessionId = task.acpSessionKey;
    if (!acpSessionId) {
      continue;
    }

    pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - reading progress for ${acpSessionId}, streamLog=${task.streamLogPath || "none"}`);
    const progress = readLatestProgress(acpSessionId, task.streamLogPath);
    if (!progress) {
      continue;
    }

    // Progress relay to Discord — DISABLED
    // const text = `🔄 **ACP 进度** (${taskId.slice(-8)})\n> ${progress.slice(0, 200)}`;
    // Progress available but Discord relay disabled
    const ok = false;
    if (ok) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - sent OK`);
    }
  }
}

// --- Stale reaper ---


const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
let healthCheckTimer = null;

function healthCheckPendingTasks() {
  if (pendingTasks.size === 0) return;
  
  const now = Date.now();
  const warnings = [];
  
  for (const [taskId, task] of pendingTasks.entries()) {
    const ageMs = now - new Date(task.spawnedAt).getTime();
    const ageMin = Math.round(ageMs / 60000);
    
    // Warning thresholds
    if (ageMin >= 30 && ageMin < 60) {
      // Task running for 60-120 min — check for signs of life
      // For subagent runtime: check runs.json + tmux evidence
      let hasProgress = false;
      if (task.runtime === "subagent" || task.acpSessionKey?.includes(":subagent:")) {
        const run = findSubagentRun(task.acpSessionKey);
        if (run?.endedAt) {
          continue; // Already ended, reconcile will handle it
        }
        if (run && !run.endedAt && run.startedAt) {
          // Check tmux for deeper insight
          const tmux = getTmuxTaskEvidence(task);
          if (tmux.hasTmux) {
            if (tmux.reportExists) {
              hasProgress = true; // tmux report exists, task likely done
            } else if (tmux.anyAlive) {
              hasProgress = true; // tmux session alive, still working
            } else {
              hasProgress = false; // tmux dead, no report — stuck
              pluginLogger?.info(`spawn-interceptor: health — ${taskId} subagent running but tmux dead/no-report, marking as stuck`);
            }
          } else {
            hasProgress = true; // No tmux at all — pure subagent, treat as active
          }
        }
      } else {
        const progress = readLatestProgress(task.acpSessionKey, task.streamLogPath);
        hasProgress = progress && progress.length > 20;
      }
      if (!hasProgress) {
        warnings.push({
          taskId,
          ageMin,
          status: "possibly_stuck",
          message: `Task ${taskId} has been pending for ${ageMin}min with no progress. May be stuck.`,
        });
      }
    } else if (ageMin >= 60) {
      // Will be reaped by stale_reaper, no need to warn separately
    }
  }
  
  if (warnings.length > 0) {
    // Write health warnings to a file for observability
    const warningPath = path.join(SHARED_CTX, "monitor-tasks", "health-warnings.json");
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        pendingCount: pendingTasks.size,
        warnings,
      };
      writeJsonAtomic(warningPath, payload);
      pluginLogger?.info(`spawn-interceptor: health check found ${warnings.length} warning(s), written to ${warningPath}`);
    } catch {}
    
    // Actively inject stuck warning into parent session's next prompt
    for (const w of warnings) {
      const task = [...pendingTasks.values()].find(t => t.taskId === w.taskId);
      if (task?.requesterSessionKey) {
        const queueKey = getCompletionQueueKey(task.requesterSessionKey);
        const bucket = completedTasksSinceLastPrompt.get(queueKey) || [];
        // Only inject if not already warned for this task
        const alreadyWarned = bucket.some(b => b.taskId === w.taskId && b.status === "possibly_stuck");
        if (!alreadyWarned) {
          bucket.push({
            taskId: w.taskId,
            status: "possibly_stuck",
            task: (task.task || "").slice(0, 200),
            completedAt: new Date().toISOString(),
          });
          completedTasksSinceLastPrompt.set(queueKey, bucket);
          pluginLogger?.info(`spawn-interceptor: queued stuck warning for ${w.taskId} into prompt injection queue`);
        }
      }
    }
  }
}


function isRunnerStillActive(task) {
  // For subagent runtime: check runs.json + tmux session status
  if (task.runtime === "subagent" || task.acpSessionKey?.includes(":subagent:")) {
    const run = findSubagentRun(task.acpSessionKey);
    if (!run) return false;
    if (run.endedAt) return false;
    if (run.startedAt) {
      // Subagent is running — also check if it has a tmux task that's still alive
      const ageMs = Date.now() - run.startedAt;
      if (ageMs > 20 * 60 * 1000) {
        // For long-running subagents, check tmux evidence
        const tmux = getTmuxTaskEvidence(task);
        if (tmux.hasTmux && !tmux.anyAlive && !tmux.reportExists) {
          pluginLogger?.info(`spawn-interceptor: subagent ${task.taskId} running for ${Math.round(ageMs / 60000)}min but tmux session is dead with no report — not truly active`);
          return false;
        }
      }
      return true;
    }
    return false;
  }

  // Legacy ACP runtime: check status.json
  try {
    const runDir = task.runDir || task.streamLogPath?.replace(/\/[^/]+$/, "");
    if (!runDir) return false;
    const statusPath = path.join(runDir, "status.json");
    if (!fs.existsSync(statusPath)) return false;
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const state = status.state || "";
    if (state === "running" || state === "started") {
      const heartbeat = status.heartbeatAt || status.lastActivity;
      if (heartbeat) {
        const hbAge = Date.now() - new Date(heartbeat).getTime();
        return hbAge < 10 * 60 * 1000;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}


function reconcileSubagentRuns() {
  const subagentPending = [...pendingTasks.entries()].filter(
    ([, t]) => t.runtime === "subagent" || t.acpSessionKey?.includes(":subagent:")
  );
  if (subagentPending.length === 0) return;

  const runs = loadSubagentRuns();
  const runsByChildKey = new Map();
  for (const run of Object.values(runs)) {
    if (run.childSessionKey) runsByChildKey.set(run.childSessionKey, run);
  }
  let reconciled = 0;

  for (const [taskId, task] of subagentPending) {
    const childKey = task.acpSessionKey;
    if (!childKey) continue;

    const run = runsByChildKey.get(childKey) || null;
    if (!run) {
      // No run record — if task is old enough, it was likely from a previous gateway session
      const age = Date.now() - new Date(task.spawnedAt).getTime();
      if (age > 30 * 60 * 1000) {
        pluginLogger?.info(`spawn-interceptor: reconcile — ${taskId} has no run record and is ${Math.round(age / 60000)}min old, marking as lost`);
        pendingTasks.delete(taskId);
        appendLog({
          taskId, agentId: task.agentId, sessionKey: task.sessionKey,
          requesterSessionKey: task.requesterSessionKey,
          runtime: task.runtime, task: task.task, spawnedAt: task.spawnedAt,
          status: "failed", completedAt: new Date().toISOString(),
          completionSource: "reconcile_no_run",
          reason: "no matching run record found in subagents/runs.json",
        });
        onTaskCompleted(task, "failed", "Task lost — no run record found (possibly pre-restart)").catch(() => {});
        reconciled++;
      }
      continue;
    }

    if (run.endedAt) {
      // Run already ended but pending task wasn't cleaned up (subagent_ended hook missed)
      const outcome = run.outcome;
      const status = (outcome?.status === "ok" || run.endedReason === "subagent-complete") ? "completed" : "failed";
      const summary = run.frozenResultText ? String(run.frozenResultText).slice(0, 500) : "";

      pluginLogger?.info(`spawn-interceptor: reconcile — ${taskId} run already ended (outcome=${JSON.stringify(outcome)}, reason=${run.endedReason}), marking as ${status}`);
      pendingTasks.delete(taskId);
      appendLog({
        taskId, agentId: task.agentId, sessionKey: task.sessionKey,
        requesterSessionKey: task.requesterSessionKey,
        runtime: task.runtime, task: task.task, spawnedAt: task.spawnedAt,
        status, completedAt: new Date(run.endedAt).toISOString(),
        completionSource: "reconcile_runs_json",
        reason: `run ended: ${run.endedReason || "unknown"}`,
        outcome: JSON.stringify(outcome),
      });
      if (task.runtime === "subagent") {
        try {
          recordTaskTerminal(task, status, {
            completion_source: "reconcile_runs_json",
            completed_at: new Date(run.endedAt).toISOString(),
            reason: run.endedReason || "unknown",
            child_session_key: childKey,
          });
        } catch {}
      }
      onTaskCompleted(task, status, summary).catch(() => {});
      reconciled++;
    }
  }

  if (reconciled > 0) {
    savePending();
    pluginLogger?.info(`spawn-interceptor: reconciled ${reconciled} subagent task(s), ${pendingTasks.size} still pending`);
  }
}

function reapStaleTasks() {
  const now = Date.now();
  let reaped = 0;

  for (const [taskId, task] of [...pendingTasks.entries()]) {
    const spawnedAt = new Date(task.spawnedAt).getTime();
    if (now - spawnedAt > STALE_TIMEOUT_MS) {
      // P1a: Check runner status.json before reaping — task may still be running
      if (isRunnerStillActive(task)) {
        pluginLogger?.info(`spawn-interceptor: ${taskId} past stale timeout but runner still active, skipping reap`);
        continue;
      }
      const progress = readLatestProgress(task.acpSessionKey, task.streamLogPath);
      const taskAgeMin = Math.round((now - spawnedAt) / 60000);
      
      // Classify timeout type for better downstream handling
      let timeoutType = "stale_no_signal";
      let timeoutAction = "timeout";
      if (progress && progress.length > 50) {
        timeoutType = "stale_had_progress";
        timeoutAction = "timeout";
      }
      
      pendingTasks.delete(taskId);
      appendLog({
        taskId,
        agentId: task.agentId,
        sessionKey: task.sessionKey,
        requesterSessionKey: task.requesterSessionKey,
        runtime: task.runtime,
        task: task.task,
        spawnedAt: task.spawnedAt,
        status: timeoutAction,
        completedAt: new Date().toISOString(),
        completionSource: "stale_reaper",
        timeoutType,
        reason: `no completion detected within ${taskAgeMin}min (type=${timeoutType})`,
      });
      onTaskCompleted(task, timeoutAction, progress ? `[Last progress] ${progress.slice(0, 300)}` : "No progress detected").catch(() => {});
      reaped++;
    }
  }

  if (reaped > 0) {
    savePending();
    pluginLogger?.info(`spawn-interceptor: reaped ${reaped} stale task(s), ${pendingTasks.size} still pending`);
  }

  cleanupAcpxZombies();
  gcConsumedSessionIds();
  rotateTaskLog();
}

function gcConsumedSessionIds() {
  if (consumedAcpSessionIds.size > 500) {
    const excess = consumedAcpSessionIds.size - 200;
    const iter = consumedAcpSessionIds.values();
    for (let i = 0; i < excess; i++) {
      consumedAcpSessionIds.delete(iter.next().value);
    }
    pluginLogger?.info(`spawn-interceptor: GC'd ${excess} consumed ACP session IDs, ${consumedAcpSessionIds.size} remaining`);
  }
}

const MAX_TASK_LOG_BYTES = 2 * 1024 * 1024; // 2MB
let lastLogRotateCheck = 0;

function rotateTaskLog() {
  const now = Date.now();
  if (now - lastLogRotateCheck < 60 * 60 * 1000) return; // Check at most once per hour
  lastLogRotateCheck = now;

  try {
    if (!fs.existsSync(TASK_LOG)) return;
    const stat = fs.statSync(TASK_LOG);
    if (stat.size > MAX_TASK_LOG_BYTES) {
      const archivePath = TASK_LOG + `.${new Date().toISOString().slice(0, 10)}.bak`;
      fs.renameSync(TASK_LOG, archivePath);
      pluginLogger?.info(`spawn-interceptor: rotated task-log (${Math.round(stat.size / 1024)}KB) → ${archivePath}`);
    }
  } catch {}
}

// --- ACPX zombie cleanup ---

function cleanupAcpxZombies() {
  try {
    if (!fs.existsSync(ACPX_INDEX)) return;
    const index = JSON.parse(fs.readFileSync(ACPX_INDEX, "utf-8"));
    const entries = index.entries || [];
    const openEntries = entries.filter(e => !e.closed);
    if (openEntries.length === 0) return;

    let alivePids;
    try {
      const { execSync } = require("child_process");
      const raw = execSync("pgrep -x claude", { timeout: 3000 }).toString().trim();
      alivePids = new Set(raw.split("\n").filter(Boolean));
    } catch {
      alivePids = new Set();
    }

    let cleaned = 0;
    const now = new Date().toISOString();

    for (const entry of openEntries) {
      const fp = path.join(ACPX_SESSIONS_DIR, entry.file || "");
      let detail;
      try { detail = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { continue; }

      const pid = detail.pid;
      if (pid && alivePids.has(String(pid))) continue;

      detail.closed_at = now;
      detail.close_reason = "zombie_auto_cleanup";
      try { fs.writeFileSync(fp, JSON.stringify(detail, null, 2)); } catch { continue; }

      entry.closed = true;
      entry.lastUsedAt = now;
      cleaned++;
    }

    if (cleaned > 0) {
      fs.writeFileSync(ACPX_INDEX, JSON.stringify(index, null, 2));
      pluginLogger?.info(`spawn-interceptor: acpx zombie cleanup: closed ${cleaned} dead session(s), ${openEntries.length - cleaned} still open`);
    }
  } catch (err) {
    pluginLogger?.warn(`spawn-interceptor: acpx zombie cleanup failed: ${err?.message}`);
  }
}

// --- ACP session poller ---

function loadAcpxEntries() {
  try {
    if (!fs.existsSync(ACPX_INDEX)) return null;
    const index = JSON.parse(fs.readFileSync(ACPX_INDEX, "utf-8"));
    let entries = index.entries || [];
    if (entries.length === 0 && Array.isArray(index.files) && index.files.length > 0) {
      for (const fileName of index.files) {
        try {
          const fp = path.join(ACPX_SESSIONS_DIR, fileName);
          if (!fs.existsSync(fp)) continue;
          const detail = JSON.parse(fs.readFileSync(fp, "utf-8"));
          entries.push({
            file: fileName,
            acpxRecordId: detail.session_id || fileName.replace(".json", ""),
            closed: !!detail.closed_at,
            lastUsedAt: detail.last_used_at || detail.created_at,
            name: detail.name,
          });
        } catch { /* skip corrupted files */ }
      }
    }
    return entries;
  } catch { return null; }
}

function pollAcpSessions() {
  loadPending();
  const acpPending = [...pendingTasks.entries()].filter(([, t]) => t.runtime === "acp");
  if (acpPending.length === 0) return;

  const entries = loadAcpxEntries();
  if (!entries || entries.length === 0) return;

  const TIME_MATCH_WINDOW_MS = 60 * 1000;
  const BATCH_CLEANUP_AGE_MS = 2 * 60 * 1000;
  let completed = 0;

  const closedSessions = entries.filter(e => e.closed);
  const openSessions = entries.filter(e => !e.closed);

  for (const [taskId, task] of acpPending) {
    const spawnTs = new Date(task.spawnedAt).getTime();
    let matched = false;

    for (const session of closedSessions) {
      if (consumedAcpSessionIds.has(session.acpxRecordId)) continue;

      let sessionDetail = null;
      try {
        const fp = path.join(ACPX_SESSIONS_DIR, session.file);
        if (fs.existsSync(fp)) {
          sessionDetail = JSON.parse(fs.readFileSync(fp, "utf-8"));
        }
      } catch { /* skip */ }

      const sessionCreatedAt = sessionDetail
        ? new Date(sessionDetail.created_at).getTime()
        : new Date(session.lastUsedAt).getTime();
      const timeDiff = sessionCreatedAt - spawnTs;

      // Guard: reject sessions that were closed BEFORE the task was spawned.
      // After a Gateway restart, old closed sessions can time-match new tasks
      // because acpx reuses session names; checking closed_at prevents false positives.
      const closedAtRaw = sessionDetail?.closed_at || session.lastUsedAt;
      if (closedAtRaw) {
        const closedAtTs = new Date(closedAtRaw).getTime();
        if (closedAtTs < spawnTs) continue;
      }

      if (timeDiff >= -2000 && timeDiff < TIME_MATCH_WINDOW_MS) {
        const closedAt = sessionDetail?.closed_at || session.lastUsedAt || new Date().toISOString();
        const sessionName = sessionDetail?.name || session.name || "?";

        // Smart completion vs failure detection
        const lastUsed = sessionDetail?.last_used_at || sessionDetail?.lastUsedAt;
        const created = sessionDetail?.created_at || sessionDetail?.createdAt;
        const evidence = readCompletionEvidence(task, task.acpSessionKey || sessionName);
        const classification = classifyClosedAcpSession({
          spawnTs,
          now: Date.now(),
          lastUsed,
          created,
          progress: evidence.summary,
          hasMeaningfulOutput: evidence.hasMeaningfulOutput,
          childSessionActive: Boolean(task.acpSessionKey || task.streamLogPath),
        });

        if (classification.shouldDeferCompletion) {
          pluginLogger?.info(`spawn-interceptor: ACP task ${taskId} deferring completion until child output appears (age=${Math.round(classification.taskAge / 1000)}s, session=${session.acpxRecordId})`);
          continue;
        }

        if (classification.shouldDeferFailure) {
          pluginLogger?.info(`spawn-interceptor: ACP task ${taskId} deferring suspected failure (age=${Math.round(classification.taskAge / 1000)}s, session=${session.acpxRecordId})`);
          continue;
        }

        pendingTasks.delete(taskId);
        consumedAcpSessionIds.add(session.acpxRecordId);
        appendLog({
          taskId,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          requesterSessionKey: task.requesterSessionKey,
          runtime: task.runtime,
          task: task.task,
          spawnedAt: task.spawnedAt,
          status: classification.finalStatus,
          completedAt: closedAt,
          completionSource: "acp_session_poller",
          acpxSession: session.acpxRecordId,
          acpxSessionName: sessionName,
          reason: classification.failureReason || `acpx session closed (time match: ${Math.round(timeDiff / 1000)}s)`,
        });
        const summary = classification.isSuspectedFailure
          ? `❌ 任务可能未正常执行 (${classification.failureReason})`
          : (evidence.summary || sessionName);
        onTaskCompleted(task, classification.finalStatus, summary).catch(() => {});

        matched = true;
        completed++;
        pluginLogger?.info(`spawn-interceptor: ACP task ${taskId} → ${classification.finalStatus} (acpx session ${session.acpxRecordId} closed, match=${Math.round(timeDiff / 1000)}s${classification.isSuspectedFailure ? ", SUSPECTED FAILURE" : ""})`);
        break;
      }
    }

    if (!matched && !task.acpSessionKey) {
      for (const session of openSessions) {
        if (consumedAcpSessionIds.has(session.acpxRecordId)) continue;
        let sessionDetail = null;
        try {
          const fp = path.join(ACPX_SESSIONS_DIR, session.file);
          if (fs.existsSync(fp)) sessionDetail = JSON.parse(fs.readFileSync(fp, "utf-8"));
        } catch { /* skip */ }

        const sessionCreatedAt = sessionDetail
          ? new Date(sessionDetail.created_at).getTime()
          : new Date(session.lastUsedAt).getTime();
        const timeDiff = sessionCreatedAt - spawnTs;

        if (timeDiff >= -2000 && timeDiff < TIME_MATCH_WINDOW_MS) {
          const sessionName = sessionDetail?.name || session.name || "?";
          task.acpSessionKey = sessionName;
          pendingTasks.set(taskId, task);
          savePending();
          pluginLogger?.info(`spawn-interceptor: linked ${taskId} → acpSession=${sessionName} (open, match=${Math.round(timeDiff / 1000)}s)`);
          break;
        }
      }
    }

    if (!matched) {
      const age = Date.now() - spawnTs;
      if (age > BATCH_CLEANUP_AGE_MS && openSessions.length === 0) {
        const evidence = readCompletionEvidence(task, task.acpSessionKey);
        if ((task.acpSessionKey || task.streamLogPath) && !evidence.hasMeaningfulOutput && age < CHILD_SESSION_COMPLETION_GRACE_MS) {
          pluginLogger?.info(`spawn-interceptor: ACP task ${taskId} keeping pending after parent close (age=${Math.round(age / 1000)}s, awaiting child output)`);
          continue;
        }

        const finalStatus = evidence.hasMeaningfulOutput ? "assumed_complete" : "failed";

        pendingTasks.delete(taskId);
        appendLog({
          taskId,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          requesterSessionKey: task.requesterSessionKey,
          runtime: task.runtime,
          task: task.task,
          spawnedAt: task.spawnedAt,
          status: finalStatus,
          completedAt: new Date().toISOString(),
          completionSource: "acp_session_poller",
          reason: `no open ACP sessions remain (task age: ${Math.round(age / 1000)}s, hasOutput=${evidence.hasMeaningfulOutput})`,
        });
        const summary = evidence.hasMeaningfulOutput
          ? (evidence.summary || "")
          : "❌ 任务可能未正常启动（无输出内容）";
        onTaskCompleted(task, finalStatus, summary).catch(() => {});
        completed++;
        pluginLogger?.info(`spawn-interceptor: ACP task ${taskId} → ${finalStatus} (no open ACP sessions, age=${Math.round(age / 1000)}s)`);
      }
    }
  }

  if (completed > 0) {
    savePending();
    pluginLogger?.info(`spawn-interceptor: ACP poller completed ${completed} task(s), ${pendingTasks.size} still pending`);
  }
}

// --- Plugin definition ---

const spawnInterceptorPlugin = {
  id: "spawn-interceptor",
  name: "Spawn Interceptor",
  description: "ACP task tracking with completion notification and progress relay",
  version: "3.9.0",

  register(api) {
    pluginLogger = api.logger;
    pluginRuntime = api.runtime;
    pluginConfig = api.config;

    api.logger.info("spawn-interceptor v3.9.0: registering (runs.json + tmux awareness + reconcile + health check)");

    loadPending();
    if (pendingTasks.size > 0) {
      api.logger.info(`spawn-interceptor: restored ${pendingTasks.size} pending task(s) from disk`);
      reconcileSubagentRuns();
      reapStaleTasks();
      pollAcpSessions();
    }

    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (acpPollerTimer) { clearInterval(acpPollerTimer); acpPollerTimer = null; }
    if (progressRelayTimer) { clearInterval(progressRelayTimer); progressRelayTimer = null; }

    reaperTimer = setInterval(() => { reconcileSubagentRuns(); reapStaleTasks(); }, REAPER_INTERVAL_MS);
    healthCheckTimer = setInterval(healthCheckPendingTasks, HEALTH_CHECK_INTERVAL_MS);
    acpPollerTimer = setInterval(pollAcpSessions, ACP_POLL_INTERVAL_MS);
    progressRelayTimer = setInterval(() => relayProgress().catch(() => {}), PROGRESS_RELAY_INTERVAL_MS);

    // Hook 0: before_prompt_build — inject completed ACP task info into the matching parent session only
    api.on("before_prompt_build", (event, ctx) => {
      const tasks = consumeCompletedTasksForSession(completedTasksSinceLastPrompt, ctx.sessionKey);
      if (tasks.length === 0) return;

      const injection = buildCompletionInjection(tasks);
      if (!injection) return;

      const registry = loadTaskRegistry();
      for (const task of tasks) {
        const runtime = registry?.[task.taskId]?.runtime;
        if (runtime !== "subagent") continue;
        try {
          recordTaskCallbackStage(task.taskId, "callback_receipt_acked", {
            summary: "completion injected into parent prompt",
            receipt_session_key: ctx.sessionKey || null,
          });
        } catch (err) {
          api.logger.warn(`spawn-interceptor: callback ack patch failed for ${task.taskId}: ${err?.message || err}`);
        }
      }

      api.logger.info(`spawn-interceptor: injected ${tasks.length} completed task(s) into prompt for ${getCompletionQueueKey(ctx.sessionKey)}`);
      return { prependContext: injection };
    });

    // Hook 0.5: before_tool_call — EXEC GUARD: prevent main session from exec-ing runner/claude
    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "exec") return;

      const sessionKey = ctx.sessionKey || "";
      // Only guard main agent sessions (agent:main:discord:channel:XXX)
      if (!sessionKey.startsWith("agent:main:")) return;

      const command = (event.params?.command || "").toLowerCase();
      const dangerPatterns = [
        "subagent_claude_runner",
        "run_subagent_claude_v1",
        "runner.js",
        /claude.*--print/,
        /claude.*--permission-mode/,
      ];

      const isBlocked = dangerPatterns.some(p => {
        if (p instanceof RegExp) return p.test(command);
        return command.includes(p);
      });

      if (!isBlocked) return;

      api.logger.warn(`spawn-interceptor: EXEC GUARD blocked long-running exec in main session: ${command.slice(0, 100)}`);

      return {
        block: true,
        blockReason: [
          "Executing runner/claude directly in the main session is forbidden.",
          "This blocks the session and prevents responding to user messages.",
          "",
          "Use sessions_spawn(runtime=\"subagent\") instead:",
          '  sessions_spawn({ runtime: "subagent", task: "<your task>", cwd: "<dir>" })',
          "",
          "The subagent will exec the runner internally. subagent_ended fires on completion.",
        ].join("\n"),
      };
    });

    // Hook 0.6: TIMEOUT GUARD — DISABLED
    // Previously injected `perl -e 'alarm ...'` wrapper around slow commands,
    // but OpenClaw's security system flags this as obfuscation-detected and rejects it.
    // Slow command timeout is now the agent's responsibility via prompt guidance.

    // Hook 1: before_tool_call — inject relay + parse Discord origin from sessionKey
    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      const p = event.params || {};
      const id = genId();
      const rt = p.runtime || "subagent";

      const discordChannelId = parseDiscordChannelFromSessionKey(ctx.sessionKey);

      const taskEntry = {
        taskId: id,
        agentId: ctx.agentId || "?",
        sessionKey: ctx.sessionKey || "",
        runtime: rt,
        task: String(p.task || "").slice(0, 200),
        spawnedAt: new Date().toISOString(),
        status: "spawning",
        discordChannelId: discordChannelId,
        requesterSessionKey: ctx.sessionKey || null,
      };

      // Idempotency guard — block before tracking to avoid orphan entries
      const taskHash = String(p.task || "").slice(0, 100).trim();
      if (taskHash) {
        for (const [existingId, existingTask] of pendingTasks.entries()) {
          const existingHash = String(existingTask.task || "").slice(0, 100).trim();
          const existingAge = Date.now() - new Date(existingTask.spawnedAt).getTime();
          if (existingHash === taskHash && existingAge < STALE_TIMEOUT_MS && existingTask.status === "spawning") {
            pluginLogger?.info(`spawn-interceptor: IDEMPOTENCY GUARD — duplicate task detected: ${id} matches existing ${existingId} (age=${Math.round(existingAge/1000)}s)`);
            return {
              block: true,
              blockReason: `Duplicate task blocked: identical task ${existingId} is already pending (spawned ${Math.round(existingAge/60000)}min ago). Wait for it to complete or timeout before retrying.`,
            };
          }
        }
      }

      appendLog(taskEntry);
      pendingTasks.set(id, taskEntry);
      savePending();
      if (rt === "subagent") {
        recordTrackedTask(taskEntry);
      }

      api.logger.info(`spawn-interceptor: tracked ${id} (runtime=${rt}, discord=${discordChannelId || "none"}, pending=${pendingTasks.size})`);



      if (rt === "acp" && p.task) {
        const nextParams = { ...p, task: p.task + relay(id, ctx.sessionKey) }; if (nextParams.streamTo == null) nextParams.streamTo = "parent"; return { params: nextParams };
      }
    });

    // Hook 2: subagent_spawning — capture requester origin (Discord thread/channel)
    api.on("subagent_spawning", (event, ctx) => {
      const childKey = event.childSessionKey;
      if (!childKey) return;

      const requester = event.requester || {};
      const origin = {
        discordThreadId: requester.threadId ? String(requester.threadId) : null,
        discordAccountId: requester.accountId || null,
        acpSessionKey: childKey,
      };

      if (requester.to && !origin.discordThreadId) {
        origin.discordChannelId = String(requester.to);
      }

      for (const [taskId, task] of pendingTasks.entries()) {
        if (task.status !== "spawning") continue;
        if (task.runtime !== "acp" && task.runtime !== "subagent") continue;
        const age = Date.now() - new Date(task.spawnedAt).getTime();
        if (age > 30000) continue;

        const merged = { ...task };
        if (origin.discordThreadId) merged.discordThreadId = origin.discordThreadId;
        if (origin.discordAccountId) merged.discordAccountId = origin.discordAccountId;
        if (origin.acpSessionKey) merged.acpSessionKey = origin.acpSessionKey;
        if (origin.discordChannelId && !merged.discordChannelId) {
          merged.discordChannelId = origin.discordChannelId;
        }
        if (ctx.requesterSessionKey) merged.requesterSessionKey = ctx.requesterSessionKey;

        pendingTasks.set(taskId, merged);
        savePending();

        const target = merged.discordThreadId || merged.discordChannelId || "webchat";
        api.logger.info(`spawn-interceptor: enriched ${taskId} → thread=${target}, acp=${merged.acpSessionKey || "?"}`);
        break;
      }
    });

    // Hook 2.5: subagent_spawned — precise ACP session key binding (fires AFTER session is created)
    api.on("subagent_spawned", (event, ctx) => {
      const childKey = event.childSessionKey;
      if (!childKey) return;

      for (const [taskId, task] of pendingTasks.entries()) {
        if (task.acpSessionKey === childKey) break;
        if (task.status !== "spawning") continue;
        if (task.runtime !== "acp" && task.runtime !== "subagent") continue;
        const age = Date.now() - new Date(task.spawnedAt).getTime();
        if (age > 60000) continue;

        task.acpSessionKey = childKey;
        if (event.runId) task.acpRunId = event.runId;
        if (ctx.requesterSessionKey && !task.requesterSessionKey) {
          task.requesterSessionKey = ctx.requesterSessionKey;
        }

        const requester = event.requester || {};
        if (requester.threadId && !task.discordThreadId) {
          task.discordThreadId = String(requester.threadId);
        }
        if (requester.accountId && !task.discordAccountId) {
          task.discordAccountId = requester.accountId;
        }

        pendingTasks.set(taskId, task);
        savePending();
        api.logger.info(`spawn-interceptor: linked ${taskId} → acpSession=${childKey} (via subagent_spawned, runId=${event.runId || "?"})`);
        break;
      }
    });

    // Hook 2.6: after_tool_call — extract ACP session key OR detect spawn failure (PRIMARY for ACP)
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      // L0: Detect spawn failures immediately
      if (event.error) {
        const taskParam = String(event.params?.task || "");
        const taskIdMatch = taskParam.match(/taskId":"(tsk_\w+)"/);
        if (taskIdMatch) {
          const taskId = taskIdMatch[1];
          const task = pendingTasks.get(taskId);
          if (task) {
            api.logger.warn(`spawn-interceptor: ${taskId} spawn FAILED: ${event.error}`);
            pendingTasks.delete(taskId);
            savePending();
            appendLog({
              taskId, agentId: task.agentId, sessionKey: task.sessionKey,
              requesterSessionKey: task.requesterSessionKey,
              runtime: task.runtime, task: task.task, spawnedAt: task.spawnedAt,
              status: "failed", completedAt: new Date().toISOString(),
              completionSource: "after_tool_call_error",
              error: String(event.error).slice(0, 500),
            });
            onTaskCompleted(task, "failed", `❌ ACP spawn failed: ${String(event.error).slice(0, 300)}`).catch(() => {});
            return;
          }
        }
        api.logger.warn(`spawn-interceptor: sessions_spawn error (no matching task): ${event.error}`);
        return;
      }

      const result = event.result;
      const childSessionKey = extractChildSessionKey(result);
      if (!childSessionKey) return;

      const streamLogPath = extractStreamLogPath(result);

      const taskParam = String(event.params?.task || "");
      const taskIdMatch = taskParam.match(/taskId":"(tsk_\w+)"/);

      function linkTask(task, taskId, method) {
        task.acpSessionKey = childSessionKey;
        if (streamLogPath) task.streamLogPath = streamLogPath;
        pendingTasks.set(taskId, task);
        savePending();
        api.logger.info(`spawn-interceptor: linked ${taskId} → acpSession=${childSessionKey}, streamLog=${streamLogPath || "none"} (via after_tool_call, ${method})`);
      }

      if (taskIdMatch) {
        const taskId = taskIdMatch[1];
        const task = pendingTasks.get(taskId);
        if (task && !task.acpSessionKey) {
          linkTask(task, taskId, "exact taskId match");
          return;
        }
      }

      for (const [taskId, task] of pendingTasks.entries()) {
        if (task.acpSessionKey) continue;
        if (task.status !== "spawning") continue;
        const age = Date.now() - new Date(task.spawnedAt).getTime();
        if (age > 60000) continue;

        linkTask(task, taskId, "recency match");
        break;
      }
    });

    // Hook 3: subagent_ended — detect completion
    api.on("subagent_ended", (event, ctx) => {
      const targetKey = event.targetSessionKey || "";
      const reason = event.reason || "";
      const outcome = event.outcome || "";
      const endedAt = new Date().toISOString();

      let matchedTaskId = null;
      let matchedTask = null;

      for (const [taskId, task] of pendingTasks.entries()) {
        if (targetKey && task.acpSessionKey === targetKey) {
          matchedTaskId = taskId;
          matchedTask = task;
          break;
        }
        if (task.runtime === "subagent" && targetKey && task.spawnedSessionKey === targetKey) {
          matchedTaskId = taskId;
          matchedTask = task;
          break;
        }
      }

      if (!matchedTaskId) {
        const subagentTasks = [...pendingTasks.entries()].filter(
          ([, t]) => t.runtime === "subagent",
        );
        if (subagentTasks.length === 1) {
          [matchedTaskId, matchedTask] = subagentTasks[0];
        }
      }

      const completionStatus =
        outcome === "ok" || reason === "subagent-complete" ? "completed" : "failed";

      if (matchedTaskId && matchedTask) {
        pendingTasks.delete(matchedTaskId);
        savePending();

        appendLog({
          taskId: matchedTaskId,
          agentId: matchedTask.agentId,
          sessionKey: matchedTask.sessionKey,
          runtime: matchedTask.runtime,
          task: matchedTask.task,
          spawnedAt: matchedTask.spawnedAt,
          status: completionStatus,
          completedAt: endedAt,
          completionSource: "subagent_ended_hook",
          reason,
          outcome,
          targetSessionKey: targetKey,
        });
        if (matchedTask.runtime === "subagent") {
          try {
            recordTaskTerminal(matchedTask, completionStatus, {
              completion_source: "subagent_ended_hook",
              completed_at: endedAt,
              reason,
              outcome,
              child_session_key: targetKey || matchedTask.spawnedSessionKey || null,
            });
          } catch (err) {
            api.logger.warn(`spawn-interceptor: terminal patch failed for ${matchedTaskId}: ${err?.message || err}`);
          }
        }
        onTaskCompleted(matchedTask, completionStatus).catch(() => {});
        api.logger.info(`spawn-interceptor: ${matchedTaskId} → ${completionStatus} (subagent_ended, pending=${pendingTasks.size})`);
      } else {
        appendLog({
          event: "subagent_ended",
          targetSessionKey: targetKey,
          targetKind: event.targetKind || "unknown",
          reason,
          outcome,
          agentId: ctx.runId || "?",
          endedAt,
          matchedTask: false,
        });
        api.logger.info(`spawn-interceptor: subagent ended (${targetKey}, ${reason}) — no pending match`);
      }
    });

    api.logger.info(`spawn-interceptor v3.9.0: all hooks registered. Poller=${ACP_POLL_INTERVAL_MS / 1000}s, Progress=${PROGRESS_RELAY_INTERVAL_MS / 1000}s, ZombieCleanup=every ${REAPER_INTERVAL_MS / 1000}s`);
  },

  unregister() {
    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (acpPollerTimer) { clearInterval(acpPollerTimer); acpPollerTimer = null; }
    if (progressRelayTimer) { clearInterval(progressRelayTimer); progressRelayTimer = null; }
    consumedAcpSessionIds.clear();
    lastProgressRelayOffset = {};
    completedTasksSinceLastPrompt = new Map();
    pluginLogger = null;
    pluginRuntime = null;
    pluginConfig = null;
  },
};

export default spawnInterceptorPlugin;
