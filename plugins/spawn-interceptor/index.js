/**
 * spawn-interceptor v3.4.0 — OpenClaw plugin for ACP task tracking + notification.
 *
 * Based on v2.5.2 from github.com/lanyasheng/openclaw-multiagent-framework
 *
 * v3.4.0: Fix progress relay only sending once. Split readProgress into full
 *   (for completion notifications) vs incremental (for periodic relay). Full
 *   reads entire transcript without offset tracking. Also filter "Started ..."
 *   from incremental relay to avoid sending useless start messages.
 * v3.3.0: Fix completion report truncation + include transcript in completion.
 * v3.2.0: Transcript fallback for Issue #45205.
 *   - OpenClaw's parentStreamRelay has a known bug (#45205): ACP child runs in
 *     a gateway subprocess, so onAgentEvent events never cross the process boundary.
 *     The relay only emits synthetic start/stall notices, no assistant_delta.
 *   - PR #45739 proposes a gateway fallback (chat.history + agent.wait) but is
 *     not yet merged as of 2026.3.13.
 *   - Our workaround: when acp-stream.jsonl has no real output (only start/stall),
 *     read the child's transcript file (.jsonl) directly to get assistant output.
 *     This is the same data PR #45739's chat.history would return, but via file.
 *
 * Hooks:
 *   - before_tool_call: inject streamTo="parent" + taskId relay into sessions_spawn
 *   - after_tool_call: link task to ACP session key + capture streamLogPath
 *   - subagent_spawning/spawned: enrich task with Discord context
 *   - subagent_ended: detect completion (L1)
 *   - before_prompt_build: inject completion report into agent's next turn
 *
 * Background:
 *   - Progress relay (15s tick, adaptive rate): read acp-stream.jsonl, send progress to Discord
 *   - ACP session poller: detect closed sessions as completion (L2)
 *   - Stale reaper: timeout tasks stuck > 30min (L3)
 *   - ACPX zombie cleanup: close dead acpx sessions
 */

import fs from "fs";
import os from "os";
import path from "path";

const SHARED_CTX = path.join(os.homedir(), ".openclaw", "shared-context");
const TASK_LOG = path.join(SHARED_CTX, "monitor-tasks", "task-log.jsonl");
const PENDING_FILE = path.join(SHARED_CTX, "monitor-tasks", ".pending-tasks.json");
const ACPX_SESSIONS_DIR = path.join(os.homedir(), ".acpx", "sessions");
const ACPX_INDEX = path.join(ACPX_SESSIONS_DIR, "index.json");

const STALE_TIMEOUT_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const ACP_POLL_INTERVAL_MS = 15 * 1000;
const PROGRESS_RELAY_INTERVAL_MS = 15 * 1000;



let pendingTasks = new Map();
let reaperTimer = null;
let acpPollerTimer = null;
let progressRelayTimer = null;
let pluginLogger = null;
let pluginRuntime = null;
let pluginConfig = null;
let consumedAcpSessionIds = new Set();
let completedTasksSinceLastPrompt = [];
let lastProgressReadOffset = {};
let lastRelaySentAt = {};

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
  const relayTarget = requesterSessionKey || "agent:main:completion-relay";
  return `\n\n---\n[COMPLETION RELAY — OPTIONAL]\nWhen done, call sessions_send with:\n  sessionKey: "${relayTarget}"\n  message: {"type":"acp_completion","taskId":"${taskId}","status":"completed or failed","summary":"one-sentence result"}\nThis is optional — completion is tracked automatically.\n---`;
}

function parseDiscordChannelFromSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const m = sessionKey.match(/discord:channel:(\d+)/);
  return m ? m[1] : null;
}

function extractChildSessionKey(result) {
  if (!result || typeof result !== "object") return null;
  if (result.details?.childSessionKey) return result.details.childSessionKey;
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
  if (typeof result.content === "string") {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed.childSessionKey) return parsed.childSessionKey;
    } catch { /* fallthrough */ }
  }
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

// --- Progress relay (safety net for native parentStreamRelay) ---
// Strategy: try acp-stream.jsonl first (native relay output), then fallback
// to reading the child transcript file directly (workaround for Issue #45205
// where cross-process events don't reach parentStreamRelay).

function readProgressFromStreamLog(streamLogPath, sessionId) {
  try {
    if (!fs.existsSync(streamLogPath)) return null;
    const stat = fs.statSync(streamLogPath);
    const readFrom = lastProgressReadOffset[sessionId] || 0;
    if (stat.size <= readFrom) return null;

    const fd = fs.openSync(streamLogPath, "r");
    const readLen = Math.min(stat.size - readFrom, 50000);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readFrom);
    fs.closeSync(fd);
    lastProgressReadOffset[sessionId] = stat.size;

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    const chunks = [];
    let isDone = false;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.kind === "system_event" && msg.text) {
          chunks.push(msg.text);
          if (msg.contextKey?.endsWith(":done")) isDone = true;
        } else if (msg.kind === "assistant_delta" && msg.delta) {
          chunks.push(msg.delta);
        }
      } catch { continue; }
    }

    if (chunks.length === 0) return null;
    const combined = chunks.join("").trim();
    if (!combined) return null;
    return { text: combined, isDone };
  } catch { return null; }
}

function resolveTranscriptPath(streamLogPath) {
  if (!streamLogPath) return null;
  const transcriptPath = streamLogPath.replace(/\.acp-stream\.jsonl$/, ".jsonl");
  if (transcriptPath === streamLogPath) return null;
  return fs.existsSync(transcriptPath) ? transcriptPath : null;
}

function readProgressFromTranscript(transcriptPath, sessionId) {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    const offsetKey = "transcript:" + sessionId;
    const readFrom = lastProgressReadOffset[offsetKey] || 0;
    if (stat.size <= readFrom) return null;

    const fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size - readFrom, 50000);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readFrom);
    fs.closeSync(fd);
    lastProgressReadOffset[offsetKey] = stat.size;

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    const chunks = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg || msg.role !== "assistant") continue;
        const content = msg.content;
        if (typeof content === "string") {
          chunks.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) chunks.push(block.text);
          }
        }
      } catch { continue; }
    }

    if (chunks.length === 0) return null;
    const combined = chunks.join("\n").trim();
    if (!combined) return null;
    return { text: combined, isDone: false };
  } catch { return null; }
}

function readProgressFull(task, taskId) {
  if (!task.streamLogPath) return null;
  const transcriptPath = resolveTranscriptPath(task.streamLogPath);
  if (transcriptPath) {
    try {
      if (!fs.existsSync(transcriptPath)) return null;
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
          if (typeof content === "string") chunks.push(content);
          else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) chunks.push(block.text);
            }
          }
        } catch { continue; }
      }
      if (chunks.length === 0) return null;
      const combined = chunks.join("\n").trim();
      if (!combined) return null;
      return { text: combined, isDone: false };
    } catch { return null; }
  }
  return null;
}

function readProgressIncremental(task, taskId) {
  if (task.streamLogPath) {
    const streamResult = readProgressFromStreamLog(task.streamLogPath, taskId);
    if (streamResult) {
      if (streamResult.text.includes("has produced no output for")
          || streamResult.text.startsWith("Started ")) {
        pluginLogger?.info(`spawn-interceptor: L1 filtered (${streamResult.text.slice(0, 60)}...), fallback to L2`);
      } else {
        return streamResult;
      }
    }
  }
  if (task.streamLogPath) {
    const transcriptPath = resolveTranscriptPath(task.streamLogPath);
    if (transcriptPath) {
      const transcriptResult = readProgressFromTranscript(transcriptPath, taskId);
      if (transcriptResult) {
        pluginLogger?.info(`spawn-interceptor: L2 transcript fallback success, ${transcriptResult.text.length} chars`);
        return transcriptResult;
      } else {
        pluginLogger?.info(`spawn-interceptor: L2 transcript fallback - no new content`);
      }
    }
  }
  return null;
}

async function relayProgress() {
  if (!pluginRuntime?.channel?.discord?.sendMessageDiscord) return;
  loadPending();

  const acpTasks = [...pendingTasks.entries()].filter(
    ([, t]) => t.runtime === "acp" && (t.streamLogPath || t.acpSessionKey)
  );
  if (acpTasks.length === 0) return;

  pluginLogger?.info(`spawn-interceptor: relayProgress checking ${acpTasks.length} ACP task(s)`);

  const now = Date.now();

  for (const [taskId, task] of acpTasks) {
    const rawTarget = task.discordThreadId || task.discordChannelId;
    if (!rawTarget) continue;
    const target = String(rawTarget).match(/^\d+$/) ? `channel:${rawTarget}` : String(rawTarget);

    // Adaptive relay: shorter intervals for fresh tasks, longer for long-running
    const taskAge = now - new Date(task.spawnedAt).getTime();
    const lastSent = lastRelaySentAt[taskId] || 0;
    const sinceLastSent = now - lastSent;
    let minInterval;
    if (taskAge < 2 * 60 * 1000) {
      minInterval = 0; // first 2 min: send every tick
    } else if (taskAge < 10 * 60 * 1000) {
      minInterval = 60 * 1000; // 2-10 min: every 60s
    } else {
      minInterval = 5 * 60 * 1000; // 10+ min: every 5 min
    }
    if (lastSent > 0 && sinceLastSent < minInterval) continue;

    pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - reading progress (age=${Math.round(taskAge/1000)}s, interval=${Math.round(minInterval/1000)}s)`);
    const progress = readProgressIncremental(task, taskId);
    if (!progress) {
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} - no incremental progress found`);
      continue;
    }

    try {
      const emoji = progress.isDone ? "✅" : "🔄";
      const label = progress.isDone ? "ACP 任务完成" : "ACP 进度";
      const header = `${emoji} **${label}** (${taskId.slice(-8)})`;
      const text = `${header}\n${progress.text}`;
      await pluginRuntime.channel.discord.sendMessageDiscord(target, text, {
        cfg: pluginConfig,
        accountId: task.discordAccountId || undefined,
      });
      lastRelaySentAt[taskId] = now;
      pluginLogger?.info(`spawn-interceptor: relayProgress ${taskId} sent to ${target}`);
    } catch (err) {
      pluginLogger?.warn(`spawn-interceptor: relayProgress failed for ${taskId}: ${err?.message}`);
    }
  }
}

// --- Notification helpers ---

async function notifyDiscord(task, status, summary) {
  if (!pluginRuntime?.channel?.discord?.sendMessageDiscord) return;
  const rawTarget = task.discordThreadId || task.discordChannelId;
  if (!rawTarget) return;
  const target = String(rawTarget).match(/^\d+$/) ? `channel:${rawTarget}` : String(rawTarget);

  const emoji = status === "completed" ? "✅" : status === "timeout" ? "⏰" : status === "assumed_complete" ? "✅" : "❌";
  const label = status === "completed" ? "完成" : status === "assumed_complete" ? "完成" : "结束";
  const taskDesc = (task.task || "").slice(0, 200);
  const elapsed = task.spawnedAt
    ? Math.round((Date.now() - new Date(task.spawnedAt).getTime()) / 1000)
    : "?";
  const summaryBlock = summary ? `\n${summary}` : "";
  const text = `${emoji} **ACP 任务${label}** (${elapsed}s)\n> ${taskDesc}${summaryBlock}`;

  try {
    await pluginRuntime.channel.discord.sendMessageDiscord(String(target), text, {
      cfg: pluginConfig,
      accountId: task.discordAccountId || undefined,
    });
    pluginLogger?.info(`spawn-interceptor: Discord notify sent to ${target} for task ${task.taskId}`);
  } catch (err) {
    pluginLogger?.warn(`spawn-interceptor: Discord notify failed: ${err?.message}`);
  }
}

async function onTaskCompleted(task, status, summary) {
  await notifyDiscord(task, status, summary || "").catch(() => {});
  completedTasksSinceLastPrompt.push({
    taskId: task.taskId,
    status,
    task: (task.task || "").slice(0, 100),
    completedAt: new Date().toISOString(),
  });
  pluginLogger?.info(`spawn-interceptor: queued completion ${task.taskId} (status=${status}) for prompt injection`);
}

// --- Stale reaper ---

function reapStaleTasks() {
  const now = Date.now();
  let reaped = 0;

  for (const [taskId, task] of [...pendingTasks.entries()]) {
    const spawnedAt = new Date(task.spawnedAt).getTime();
    if (now - spawnedAt > STALE_TIMEOUT_MS) {
      const progress = readProgressFull(task, taskId);
      const summary = progress?.text || "";
      pendingTasks.delete(taskId);
      appendLog({
        taskId, agentId: task.agentId, sessionKey: task.sessionKey,
        runtime: task.runtime, task: task.task, spawnedAt: task.spawnedAt,
        status: "timeout", completedAt: new Date().toISOString(),
        completionSource: "stale_reaper",
        reason: `no completion detected within ${STALE_TIMEOUT_MS / 60000}min`,
      });
      onTaskCompleted(task, "timeout", summary).catch(() => {});
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

// --- ACP session poller (L2 completion detection) ---

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
            name: detail.name || fileName,
            file: fileName,
            closed: !!detail.closed_at,
            createdAt: detail.created_at || detail.createdAt,
            lastUsedAt: detail.last_used_at || detail.lastUsedAt,
            acpxRecordId: detail.id || fileName.replace(/\.json$/, ""),
          });
        } catch { continue; }
      }
    }
    return entries;
  } catch { return null; }
}

function pollAcpSessions() {
  loadPending();

  const acpTasks = [...pendingTasks.entries()].filter(
    ([, t]) => t.runtime === "acp" && (t.status === "spawning" || t.status === "running")
  );
  if (acpTasks.length === 0) return;

  const entries = loadAcpxEntries();
  if (!entries) return;

  for (const [taskId, task] of acpTasks) {
    const acpSessionKey = task.acpSessionKey;
    if (!acpSessionKey) continue;

    for (const entry of entries) {
      if (consumedAcpSessionIds.has(entry.acpxRecordId)) continue;

      const fp = path.join(ACPX_SESSIONS_DIR, entry.file || "");
      let detail;
      try { detail = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { continue; }

      if (detail.name !== acpSessionKey) continue;

      if (entry.closed || detail.closed_at) {
        consumedAcpSessionIds.add(entry.acpxRecordId);

        const progress = readProgressFull(task, taskId);
        const summary = progress?.text || "";

        pendingTasks.delete(taskId);
        savePending();

        appendLog({
          taskId, agentId: task.agentId, sessionKey: task.sessionKey,
          runtime: task.runtime, task: task.task, spawnedAt: task.spawnedAt,
          status: "assumed_complete", completedAt: new Date().toISOString(),
          completionSource: "acp_poller",
          acpSessionKey,
        });
        onTaskCompleted(task, "assumed_complete", summary).catch(() => {});
        pluginLogger?.info(`spawn-interceptor: ${taskId} → assumed_complete (acp_poller, session closed, pending=${pendingTasks.size})`);
        break;
      }
    }
  }
}

// --- Plugin export ---

const spawnInterceptorPlugin = {
  name: "spawn-interceptor",
  version: "3.4.0",

  register(api) {
    pluginLogger = api.logger;
    pluginRuntime = api.runtime;
    pluginConfig = api.config;

    loadPending();

    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (acpPollerTimer) { clearInterval(acpPollerTimer); acpPollerTimer = null; }
    if (progressRelayTimer) { clearInterval(progressRelayTimer); progressRelayTimer = null; }

    reaperTimer = setInterval(reapStaleTasks, REAPER_INTERVAL_MS);
    acpPollerTimer = setInterval(pollAcpSessions, ACP_POLL_INTERVAL_MS);
    progressRelayTimer = setInterval(() => relayProgress().catch(() => {}), PROGRESS_RELAY_INTERVAL_MS);

    // Hook 0: before_prompt_build — inject completed ACP task info
    api.on("before_prompt_build", (event, ctx) => {
      if (completedTasksSinceLastPrompt.length === 0) return;

      const tasks = completedTasksSinceLastPrompt.splice(0);
      const lines = tasks.map(t => {
        const s = t.status === "completed" ? "✅" : t.status === "timeout" ? "⏰" : "❌";
        return `${s} [${t.taskId}] ${t.task}`;
      });

      const injection = `\n\n[SYSTEM — ACP Task Completion Report]\nThe following ACP tasks have completed since your last turn:\n${lines.join("\n")}\n\nIf you have follow-up tasks to dispatch, please continue. Otherwise, report the results to the user.\n[END REPORT]`;

      api.logger.info(`spawn-interceptor: injected ${tasks.length} completed task(s) into prompt`);
      return { prependContext: injection };
    });

    // Hook 1: before_tool_call — inject streamTo="parent" + taskId relay
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
        discordChannelId,
        requesterSessionKey: ctx.sessionKey || null,
      };

      appendLog(taskEntry);
      pendingTasks.set(id, taskEntry);
      savePending();

      api.logger.info(`spawn-interceptor: tracked ${id} (runtime=${rt}, discord=${discordChannelId || "none"}, pending=${pendingTasks.size})`);

      if (rt === "acp" && p.task) {
        const nextParams = { ...p, task: p.task + relay(id, ctx.sessionKey) };
        if (nextParams.streamTo == null) nextParams.streamTo = "parent";
        return { params: nextParams };
      }
    });

    // Hook 2: subagent_spawning — capture Discord context
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

        if (origin.discordThreadId) task.discordThreadId = origin.discordThreadId;
        if (origin.discordAccountId) task.discordAccountId = origin.discordAccountId;
        if (origin.acpSessionKey) task.acpSessionKey = origin.acpSessionKey;
        if (origin.discordChannelId && !task.discordChannelId) task.discordChannelId = origin.discordChannelId;
        if (ctx.requesterSessionKey) task.requesterSessionKey = ctx.requesterSessionKey;

        pendingTasks.set(taskId, task);
        savePending();

        const target = task.discordThreadId || task.discordChannelId || "webchat";
        api.logger.info(`spawn-interceptor: enriched ${taskId} → thread=${target}, acp=${task.acpSessionKey || "?"}`);
        break;
      }
    });

    // Hook 2.5: subagent_spawned — precise session key binding
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
        if (ctx.requesterSessionKey && !task.requesterSessionKey) task.requesterSessionKey = ctx.requesterSessionKey;

        const requester = event.requester || {};
        if (requester.threadId && !task.discordThreadId) task.discordThreadId = String(requester.threadId);
        if (requester.accountId && !task.discordAccountId) task.discordAccountId = requester.accountId;

        pendingTasks.set(taskId, task);
        savePending();
        api.logger.info(`spawn-interceptor: linked ${taskId} → acpSession=${childKey} (via subagent_spawned)`);
        break;
      }
    });

    // Hook 2.6: after_tool_call — extract ACP session key from sessions_spawn result (PRIMARY for ACP)
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName !== "sessions_spawn") return;

      const result = event.result;
      const childSessionKey = extractChildSessionKey(result);
      if (!childSessionKey) return;

      const streamLogPath = extractStreamLogPath(result);
      const taskParam = String(event.params?.task || "");
      const taskIdMatch = taskParam.match(/taskId":"(tsk_\w+)"/);

      function linkTask(task, taskId, method) {
        task.acpSessionKey = childSessionKey;
        task.status = "running";
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
        const subagentTasks = [...pendingTasks.entries()].filter(([, t]) => t.runtime === "subagent");
        if (subagentTasks.length === 1) {
          [matchedTaskId, matchedTask] = subagentTasks[0];
        }
      }

      const completionStatus = outcome === "ok" || reason === "subagent-complete" ? "completed" : "failed";

      if (matchedTaskId && matchedTask) {
        const progress = readProgressFull(matchedTask, matchedTaskId);
        const summary = progress?.text || "";
        pendingTasks.delete(matchedTaskId);
        savePending();
        appendLog({
          taskId: matchedTaskId, agentId: matchedTask.agentId, sessionKey: matchedTask.sessionKey,
          runtime: matchedTask.runtime, task: matchedTask.task, spawnedAt: matchedTask.spawnedAt,
          status: completionStatus, completedAt: endedAt, completionSource: "subagent_ended_hook",
          reason, outcome, targetSessionKey: targetKey,
        });
        onTaskCompleted(matchedTask, completionStatus, summary).catch(() => {});
        api.logger.info(`spawn-interceptor: ${matchedTaskId} → ${completionStatus} (subagent_ended, pending=${pendingTasks.size})`);
      } else {
        appendLog({
          event: "subagent_ended", targetSessionKey: targetKey,
          targetKind: event.targetKind || "unknown", reason, outcome,
          agentId: ctx.runId || "?", endedAt, matchedTask: false,
        });
        api.logger.info(`spawn-interceptor: subagent ended (${targetKey}, ${reason}) — no pending match`);
      }
    });

    api.logger.info(`spawn-interceptor v${spawnInterceptorPlugin.version}: registered (native relay + transcript fallback). Poller=${ACP_POLL_INTERVAL_MS / 1000}s, Progress=${PROGRESS_RELAY_INTERVAL_MS / 1000}s, Reaper=${REAPER_INTERVAL_MS / 1000}s`);
  },

  unregister() {
    if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
    if (acpPollerTimer) { clearInterval(acpPollerTimer); acpPollerTimer = null; }
    if (progressRelayTimer) { clearInterval(progressRelayTimer); progressRelayTimer = null; }
    consumedAcpSessionIds.clear();
    lastProgressReadOffset = {};
    lastRelaySentAt = {};
    pluginLogger = null;
    pluginRuntime = null;
    pluginConfig = null;
  },
};

export default spawnInterceptorPlugin;
