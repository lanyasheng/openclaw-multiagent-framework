/**
 * spawn-interceptor v3.7.0 — OpenClaw plugin for ACP task tracking + notification.
 *
 * Based on v2.5.2 from github.com/lanyasheng/openclaw-multiagent-framework
 *
 * Completion detection (5-layer pipeline):
 *   L0. after_tool_call error — immediate spawn failure detection
 *   L1. subagent_ended hook — precise match by targetSessionKey
 *   L2. ACP session poller — smart completion vs failure heuristics
 *   L3. Stale reaper — marks tasks stuck > 30min as timeout
 *   L4. before_prompt_build — injects completion reports into parent turn
 *
 * v3.7.0 changes:
 *   - sendWithRetry: exponential backoff retry for all Discord API calls
 *   - L0: detect ACP_SESSION_INIT_FAILED in after_tool_call immediately
 *   - L2 smart poller: distinguish real completions from GC-closed failures
 *   - Active parent wake via pluginRuntime.subagent.run() on task completion
 */

import fs from "fs";
import os from "os";
import path from "path";

const SHARED_CTX = path.join(os.homedir(), ".openclaw", "shared-context");
const TASK_LOG = path.join(SHARED_CTX, "monitor-tasks", "task-log.jsonl");
const PENDING_FILE = path.join(SHARED_CTX, "monitor-tasks", ".pending-tasks.json");
const ACPX_SESSIONS_DIR = path.join(os.homedir(), ".acpx", "sessions");
const ACPX_INDEX = path.join(ACPX_SESSIONS_DIR, "index.json");
const GATEWAY_LOG = path.join(os.homedir(), ".openclaw", "logs", "gateway.log");
const DEFAULT_COMPLETION_SESSION = "agent:main:completion-relay";

const STALE_TIMEOUT_MS = 30 * 60 * 1000;
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

async function notifyDiscord(task, status, summary) {
  const rawTarget = task.discordThreadId || task.discordChannelId;
  if (!rawTarget) return;
  const target = String(rawTarget).match(/^\d+$/) ? `channel:${rawTarget}` : String(rawTarget);

  const emoji = status === "completed" ? "✅" : status === "timeout" ? "⏰" : status === "assumed_complete" ? "✅" : status === "failed" ? "❌" : "🔍";
  const label = status === "completed" || status === "assumed_complete" ? "完成" : status === "failed" ? "失败" : "结束";
  const taskDesc = (task.task || "").slice(0, 200);
  const elapsed = task.spawnedAt
    ? Math.round((Date.now() - new Date(task.spawnedAt).getTime()) / 1000)
    : "?";
  const summaryBlock = summary ? `\n📋 ${summary}` : "";
  const text = `${emoji} **ACP 任务${label}** (${elapsed}s)\n> ${taskDesc}${summaryBlock}`;

  const ok = await sendWithRetry(target, text, {
    cfg: pluginConfig,
    accountId: task.discordAccountId || undefined,
  });
  if (ok) {
    pluginLogger?.info(`spawn-interceptor: Discord notify sent to ${target} for task ${task.taskId}`);
  }
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
    const s = t.status === "completed" ? "✅" : t.status === "timeout" ? "⏰" : "❌";
    return `${s} [${t.taskId}] ${t.task}`;
  });

  return `\n\n[SYSTEM — ACP Task Completion Report]\nThe following ACP tasks have completed since your last turn:\n${lines.join("\n")}\n\nIf you have follow-up tasks to dispatch, please continue. Otherwise, report the results to the user.\n[END REPORT]`;
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

  const queueKey = enqueueCompletedTask(completedTasksSinceLastPrompt, task, status);
  pluginLogger?.info(`spawn-interceptor: queued completion ${task.taskId} (status=${status}) for prompt injection, session=${queueKey}`);

  // Actively trigger parent agent's new turn to pick up prompt injection
  const parentSessionKey = task.requesterSessionKey;
  pluginLogger?.info(`spawn-interceptor: parent wake: parentKey=${parentSessionKey || "NONE"}`);
  if (parentSessionKey) {
    wakeParentSession(task, status, summary || "");
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

  const acpTasks = [...pendingTasks.entries()].filter(([, t]) => t.runtime === "acp");
  if (acpTasks.length === 0) return;

  pluginLogger?.info(`spawn-interceptor: relayProgress checking ${acpTasks.length} ACP task(s)`);

  for (const [taskId, task] of acpTasks) {
    const rawTarget = task.discordThreadId || task.discordChannelId;
    if (!rawTarget) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - no discord target`);
      continue;
    }
    const target = String(rawTarget).match(/^\d+$/) ? `channel:${rawTarget}` : String(rawTarget);

    const acpSessionId = task.acpSessionKey;
    if (!acpSessionId) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - no acpSessionKey yet`);
      continue;
    }

    pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - reading progress for ${acpSessionId}, streamLog=${task.streamLogPath || "none"}`);
    const progress = readLatestProgress(acpSessionId, task.streamLogPath);
    if (!progress) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - no progress found`);
      continue;
    }

    const text = `🔄 **ACP 进度** (${taskId.slice(-8)})\n> ${progress.slice(0, 200)}`;
    pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - sending to ${target}, len=${progress.length}`);
    const ok = await sendWithRetry(target, text, {
      cfg: pluginConfig,
      accountId: task.discordAccountId || undefined,
    }, 2);
    if (ok) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - sent OK`);
    }
  }
}

// --- Stale reaper ---

function reapStaleTasks() {
  const now = Date.now();
  let reaped = 0;

  for (const [taskId, task] of [...pendingTasks.entries()]) {
    const spawnedAt = new Date(task.spawnedAt).getTime();
    if (now - spawnedAt > STALE_TIMEOUT_MS) {
      const progress = readLatestProgress(task.acpSessionKey, task.streamLogPath);
      pendingTasks.delete(taskId);
      appendLog({
        taskId,
        agentId: task.agentId,
        sessionKey: task.sessionKey,
        requesterSessionKey: task.requesterSessionKey,
        runtime: task.runtime,
        task: task.task,
        spawnedAt: task.spawnedAt,
        status: "timeout",
        completedAt: new Date().toISOString(),
        completionSource: "stale_reaper",
        reason: `no completion detected within ${STALE_TIMEOUT_MS / 60000}min`,
      });
      onTaskCompleted(task, "timeout", progress || "").catch(() => {});
      reaped++;
    }
  }

  if (reaped > 0) {
    savePending();
    pluginLogger?.info(`spawn-interceptor: reaped ${reaped} stale task(s), ${pendingTasks.size} still pending`);
  }

  cleanupAcpxZombies();
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
  version: "3.7.0",

  register(api) {
    pluginLogger = api.logger;
    pluginRuntime = api.runtime;
    pluginConfig = api.config;

    api.logger.info("spawn-interceptor v3.7.0: registering (retry + L0 spawn failure + smart poller + parent wake + progress relay)");

    loadPending();
    if (pendingTasks.size > 0) {
      api.logger.info(`spawn-interceptor: restored ${pendingTasks.size} pending task(s) from disk`);
      reapStaleTasks();
      pollAcpSessions();
    }

    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (acpPollerTimer) { clearInterval(acpPollerTimer); acpPollerTimer = null; }
    if (progressRelayTimer) { clearInterval(progressRelayTimer); progressRelayTimer = null; }

    reaperTimer = setInterval(reapStaleTasks, REAPER_INTERVAL_MS);
    acpPollerTimer = setInterval(pollAcpSessions, ACP_POLL_INTERVAL_MS);
    progressRelayTimer = setInterval(() => relayProgress().catch(() => {}), PROGRESS_RELAY_INTERVAL_MS);

    // Hook 0: before_prompt_build — inject completed ACP task info into the matching parent session only
    api.on("before_prompt_build", (event, ctx) => {
      const tasks = consumeCompletedTasksForSession(completedTasksSinceLastPrompt, ctx.sessionKey);
      if (tasks.length === 0) return;

      const injection = buildCompletionInjection(tasks);
      if (!injection) return;

      api.logger.info(`spawn-interceptor: injected ${tasks.length} completed task(s) into prompt for ${getCompletionQueueKey(ctx.sessionKey)}`);
      return { prependContext: injection };
    });

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

      appendLog(taskEntry);
      pendingTasks.set(id, taskEntry);
      savePending();

      api.logger.info(`spawn-interceptor: tracked ${id} (runtime=${rt}, discord=${discordChannelId || "none"}, pending=${pendingTasks.size})`);

      // Immediate start notification to Discord
      if (rt === "acp" && discordChannelId) {
        const target = `channel:${discordChannelId}`;
        const taskDesc = String(p.task || "").slice(0, 150);
        sendWithRetry(target, `🚀 **ACP 任务开始** (${id.slice(-8)})\n> ${taskDesc}`, {
          cfg: pluginConfig,
        }, 2).then(ok => {
          if (ok) api.logger.info(`spawn-interceptor: start notify sent for ${id}`);
        }).catch(() => {});
      }

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

    api.logger.info(`spawn-interceptor v3.7.0: all hooks registered. Poller=${ACP_POLL_INTERVAL_MS / 1000}s, Progress=${PROGRESS_RELAY_INTERVAL_MS / 1000}s, ZombieCleanup=every ${REAPER_INTERVAL_MS / 1000}s`);
  },

  unregister() {
    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
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
