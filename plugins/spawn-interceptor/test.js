/**
 * spawn-interceptor unit tests
 *
 * Tests core logic functions in isolation using mock filesystem.
 * Run: node --experimental-vm-modules spawn-interceptor-test.js
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-interceptor-test-"));
const cleanup = () => fs.rmSync(TEMP_DIR, { recursive: true, force: true });
process.on("exit", cleanup);

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

// ─── Helper: write test files ───

function writeStreamLog(dir, events) {
  const fp = path.join(dir, "test.acp-stream.jsonl");
  const lines = events.map(e => JSON.stringify(e));
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

function writeTranscript(dir, messages) {
  const fp = path.join(dir, "test.jsonl");
  const lines = messages.map(m => JSON.stringify({ type: "message", message: m }));
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

// ─── Import the module and extract internals for testing ───
// We need to test internal functions, so we'll re-implement them inline
// (since the module is tightly coupled to OpenClaw plugin runtime).

// Re-create the core logic functions for unit testing:

let lastProgressReadOffset = {};

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
  let streamFiltered = false;
  if (task.streamLogPath) {
    const streamResult = readProgressFromStreamLog(task.streamLogPath, taskId);
    if (streamResult) {
      if (streamResult.text.includes("has produced no output for")) {
        streamFiltered = true;
      } else if (streamResult.text.startsWith("Started ")) {
        // filtered, fallback to L2
      } else {
        return streamResult;
      }
    }
  }
  if (task.streamLogPath) {
    const transcriptPath = resolveTranscriptPath(task.streamLogPath);
    if (transcriptPath) {
      const transcriptResult = readProgressFromTranscript(transcriptPath, taskId);
      if (transcriptResult) return transcriptResult;
    }
  }
  if (streamFiltered) {
    const age = Math.round((Date.now() - new Date(task.spawnedAt).getTime()) / 1000);
    return { text: `⏳ 任务执行中 (已运行 ${age}s，等待 AI 输出...)`, isDone: false };
  }
  return null;
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

function parseDiscordChannelFromSessionKey(sessionKey) {
  if (!sessionKey) return null;
  const m = sessionKey.match(/discord:channel:(\d+)/);
  return m ? m[1] : null;
}

function genId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `tsk_${ts}_${r}`;
}

// ─── Tests ───

console.log("\n🧪 spawn-interceptor unit tests\n");

// === readProgressFromStreamLog ===

console.log("── readProgressFromStreamLog ──");

test("returns null when file does not exist", () => {
  lastProgressReadOffset = {};
  const r = readProgressFromStreamLog("/nonexistent/path.jsonl", "s1");
  assert.strictEqual(r, null);
});

test("reads assistant_delta from stream log", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t1");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeStreamLog(dir, [
    { kind: "assistant_delta", delta: "Hello " },
    { kind: "assistant_delta", delta: "World" },
  ]);
  const r = readProgressFromStreamLog(fp, "s1");
  assert.deepStrictEqual(r, { text: "Hello World", isDone: false });
});

test("detects done via contextKey", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t2");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeStreamLog(dir, [
    { kind: "system_event", text: "Task completed", contextKey: "abc:done" },
  ]);
  const r = readProgressFromStreamLog(fp, "s2");
  assert.deepStrictEqual(r, { text: "Task completed", isDone: true });
});

test("incremental offset: second read returns null if no new data", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t3");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeStreamLog(dir, [
    { kind: "assistant_delta", delta: "First" },
  ]);
  readProgressFromStreamLog(fp, "s3");
  const r2 = readProgressFromStreamLog(fp, "s3");
  assert.strictEqual(r2, null);
});

test("incremental offset: reads new data after append", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t4");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeStreamLog(dir, [
    { kind: "assistant_delta", delta: "First" },
  ]);
  readProgressFromStreamLog(fp, "s4");
  fs.appendFileSync(fp, JSON.stringify({ kind: "assistant_delta", delta: "Second" }) + "\n");
  const r2 = readProgressFromStreamLog(fp, "s4");
  assert.deepStrictEqual(r2, { text: "Second", isDone: false });
});

test("skips malformed JSON lines", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t5");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "test.acp-stream.jsonl");
  fs.writeFileSync(fp, 'bad json\n{"kind":"assistant_delta","delta":"ok"}\n');
  const r = readProgressFromStreamLog(fp, "s5");
  assert.deepStrictEqual(r, { text: "ok", isDone: false });
});

test("returns null when only system_event with no text", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t5b");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeStreamLog(dir, [
    { kind: "system_event" },
    { kind: "other_kind", text: "ignored" },
  ]);
  const r = readProgressFromStreamLog(fp, "s5b");
  assert.strictEqual(r, null);
});

// === readProgressFromTranscript ===

console.log("── readProgressFromTranscript ──");

test("reads assistant messages from transcript", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t6");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeTranscript(dir, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Response 1" },
    { role: "assistant", content: [{ type: "text", text: "Response 2" }] },
  ]);
  const r = readProgressFromTranscript(fp, "s6");
  assert.deepStrictEqual(r, { text: "Response 1\nResponse 2", isDone: false });
});

test("skips non-assistant messages", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t7");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeTranscript(dir, [
    { role: "user", content: "Hello" },
    { role: "system", content: "System msg" },
  ]);
  const r = readProgressFromTranscript(fp, "s7");
  assert.strictEqual(r, null);
});

test("incremental read from transcript", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t8");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeTranscript(dir, [
    { role: "assistant", content: "Part 1" },
  ]);
  const r1 = readProgressFromTranscript(fp, "s8");
  assert.deepStrictEqual(r1, { text: "Part 1", isDone: false });

  fs.appendFileSync(fp, JSON.stringify({ type: "message", message: { role: "assistant", content: "Part 2" } }) + "\n");
  const r2 = readProgressFromTranscript(fp, "s8");
  assert.deepStrictEqual(r2, { text: "Part 2", isDone: false });
});

test("handles mixed content types in transcript", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t8b");
  fs.mkdirSync(dir, { recursive: true });
  const fp = writeTranscript(dir, [
    { role: "assistant", content: [
      { type: "text", text: "text block" },
      { type: "tool_use", id: "t1" },
      { type: "text", text: "another text" },
    ]},
  ]);
  const r = readProgressFromTranscript(fp, "s8b");
  assert.deepStrictEqual(r, { text: "text block\nanother text", isDone: false });
});

// === readProgressFull ===

console.log("── readProgressFull ──");

test("reads full transcript regardless of offset", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t9");
  fs.mkdirSync(dir, { recursive: true });
  const streamLogPath = writeStreamLog(dir, [
    { kind: "system_event", text: "Started" },
  ]);
  const transcriptPath = writeTranscript(dir, [
    { role: "assistant", content: "Full content here" },
  ]);

  // Simulate that incremental reads already happened
  readProgressFromStreamLog(streamLogPath, "s9");
  readProgressFromTranscript(path.join(dir, "test.jsonl"), "s9");

  const task = { streamLogPath };
  const r = readProgressFull(task, "s9");
  assert.deepStrictEqual(r, { text: "Full content here", isDone: false });
});

test("readProgressFull returns null when no transcript exists", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t10");
  fs.mkdirSync(dir, { recursive: true });
  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  fs.writeFileSync(streamLogPath, JSON.stringify({ kind: "system_event", text: "Started" }) + "\n");
  // No transcript file

  const task = { streamLogPath };
  const r = readProgressFull(task, "s10");
  assert.strictEqual(r, null);
});

test("readProgressFull returns null when streamLogPath is null", () => {
  const r = readProgressFull({}, "s11");
  assert.strictEqual(r, null);
});

test("readProgressFull reads multiple assistant messages", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t12");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [{ kind: "system_event", text: "Started" }]);
  writeTranscript(dir, [
    { role: "user", content: "query" },
    { role: "assistant", content: "## START\nStep 1" },
    { role: "assistant", content: "## DONE\nAll steps complete" },
  ]);

  const task = { streamLogPath: path.join(dir, "test.acp-stream.jsonl") };
  const r = readProgressFull(task, "s12");
  assert.ok(r.text.includes("START"));
  assert.ok(r.text.includes("DONE"));
  assert.ok(r.text.includes("Step 1"));
  assert.ok(r.text.includes("All steps complete"));
});

// === readProgressIncremental ===

console.log("── readProgressIncremental ──");

test("filters 'Started ...' messages from L1, falls back to L2", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t13");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [
    { kind: "system_event", text: "Started claude session abc. Streaming..." },
  ]);
  writeTranscript(dir, [
    { role: "assistant", content: "Real progress content" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r = readProgressIncremental(task, "s13");
  assert.deepStrictEqual(r, { text: "Real progress content", isDone: false });
});

test("filters 'no output for 60s' messages from L1", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t14");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [
    { kind: "system_event", text: "claude has produced no output for 60s. It may be waiting." },
  ]);
  writeTranscript(dir, [
    { role: "assistant", content: "Actual output" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r = readProgressIncremental(task, "s14");
  assert.deepStrictEqual(r, { text: "Actual output", isDone: false });
});

test("passes through real assistant_delta from L1 (no fallback needed)", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t15");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [
    { kind: "assistant_delta", delta: "Real delta output" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r = readProgressIncremental(task, "s15");
  assert.deepStrictEqual(r, { text: "Real delta output", isDone: false });
});

test("returns null when both L1 and L2 have no content", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t16");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [
    { kind: "system_event", text: "Started session." },
  ]);
  writeTranscript(dir, [
    { role: "user", content: "query only" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r = readProgressIncremental(task, "s16");
  assert.strictEqual(r, null);
});

test("incremental L2: second call reads only new transcript content", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "t17");
  fs.mkdirSync(dir, { recursive: true });
  writeStreamLog(dir, [
    { kind: "system_event", text: "Started session." },
  ]);
  writeTranscript(dir, [
    { role: "assistant", content: "First batch" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r1 = readProgressIncremental(task, "s17");
  assert.deepStrictEqual(r1, { text: "First batch", isDone: false });

  // Append more transcript content
  const transcriptPath = path.join(dir, "test.jsonl");
  fs.appendFileSync(transcriptPath, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "Second batch" },
  }) + "\n");

  const r2 = readProgressIncremental(task, "s17");
  assert.deepStrictEqual(r2, { text: "Second batch", isDone: false });
});

// === extractChildSessionKey ===

console.log("── extractChildSessionKey ──");

test("extracts from details.childSessionKey", () => {
  const r = extractChildSessionKey({ details: { childSessionKey: "abc:123" } });
  assert.strictEqual(r, "abc:123");
});

test("extracts from content array text block", () => {
  const r = extractChildSessionKey({
    content: [{ type: "text", text: JSON.stringify({ childSessionKey: "xyz:456" }) }],
  });
  assert.strictEqual(r, "xyz:456");
});

test("extracts from string content", () => {
  const r = extractChildSessionKey({
    content: JSON.stringify({ childSessionKey: "str:789" }),
  });
  assert.strictEqual(r, "str:789");
});

test("falls back to result.childSessionKey", () => {
  const r = extractChildSessionKey({ childSessionKey: "fallback:key" });
  assert.strictEqual(r, "fallback:key");
});

test("returns null for invalid input", () => {
  assert.strictEqual(extractChildSessionKey(null), null);
  assert.strictEqual(extractChildSessionKey({}), null);
  assert.strictEqual(extractChildSessionKey("string"), null);
});

// === extractStreamLogPath ===

console.log("── extractStreamLogPath ──");

test("extracts from details.streamLogPath", () => {
  const r = extractStreamLogPath({ details: { streamLogPath: "/path/to/log.jsonl" } });
  assert.strictEqual(r, "/path/to/log.jsonl");
});

test("extracts from content array text block", () => {
  const r = extractStreamLogPath({
    content: [{ type: "text", text: JSON.stringify({ streamLogPath: "/path/stream.jsonl" }) }],
  });
  assert.strictEqual(r, "/path/stream.jsonl");
});

test("falls back to result.streamLogPath", () => {
  const r = extractStreamLogPath({ streamLogPath: "/fallback/path.jsonl" });
  assert.strictEqual(r, "/fallback/path.jsonl");
});

test("returns null for invalid input", () => {
  assert.strictEqual(extractStreamLogPath(null), null);
  assert.strictEqual(extractStreamLogPath({}), null);
});

// === parseDiscordChannelFromSessionKey ===

console.log("── parseDiscordChannelFromSessionKey ──");

test("extracts channel ID from session key", () => {
  const r = parseDiscordChannelFromSessionKey("discord:channel:123456789");
  assert.strictEqual(r, "123456789");
});

test("returns null for non-discord session key", () => {
  assert.strictEqual(parseDiscordChannelFromSessionKey("agent:main"), null);
  assert.strictEqual(parseDiscordChannelFromSessionKey(null), null);
  assert.strictEqual(parseDiscordChannelFromSessionKey(""), null);
});

// === resolveTranscriptPath ===

console.log("── resolveTranscriptPath ──");

test("converts acp-stream path to transcript path", () => {
  const dir = path.join(TEMP_DIR, "t20");
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(transcriptPath, "{}");
  const streamLogPath = path.join(dir, "session.acp-stream.jsonl");

  const r = resolveTranscriptPath(streamLogPath);
  assert.strictEqual(r, transcriptPath);
});

test("returns null when transcript file does not exist", () => {
  const r = resolveTranscriptPath("/nonexistent/session.acp-stream.jsonl");
  assert.strictEqual(r, null);
});

test("returns null for non-acp-stream path", () => {
  const r = resolveTranscriptPath("/some/regular.jsonl");
  assert.strictEqual(r, null);
});

test("returns null for null input", () => {
  assert.strictEqual(resolveTranscriptPath(null), null);
});

// === genId ===

console.log("── genId ──");

test("generates ID with tsk_ prefix and correct format", () => {
  const id = genId();
  assert.ok(id.startsWith("tsk_"), `Expected tsk_ prefix, got: ${id}`);
  assert.ok(id.length > 20, `Expected length > 20, got: ${id.length}`);
  const parts = id.split("_");
  assert.strictEqual(parts.length, 3);
});

test("generates unique IDs", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(genId());
  assert.strictEqual(ids.size, 100);
});

// === End-to-end scenario tests ===

console.log("── Scenario: typical ACP task lifecycle ──");

test("E2E: relay sees 'Started' → filters → fallback to transcript → sends progress", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "e2e1");
  fs.mkdirSync(dir, { recursive: true });

  // Phase 1: stream log only has "Started"
  writeStreamLog(dir, [
    { kind: "system_event", text: "Started claude session abc. Streaming progress..." },
  ]);
  // Transcript is empty (only user message)
  writeTranscript(dir, [
    { role: "user", content: "Do something" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };
  const r1 = readProgressIncremental(task, "e2e1");
  assert.strictEqual(r1, null, "Should return null when only Started msg and no transcript output");

  // Phase 2: transcript now has assistant output
  const transcriptPath = path.join(dir, "test.jsonl");
  fs.appendFileSync(transcriptPath, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "STEP1_DONE - Step 1 complete" },
  }) + "\n");

  const r2 = readProgressIncremental(task, "e2e1");
  assert.deepStrictEqual(r2, { text: "STEP1_DONE - Step 1 complete", isDone: false });

  // Phase 3: more transcript output
  fs.appendFileSync(transcriptPath, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "STEP2_DONE - Step 2 complete" },
  }) + "\n");

  const r3 = readProgressIncremental(task, "e2e1");
  assert.deepStrictEqual(r3, { text: "STEP2_DONE - Step 2 complete", isDone: false });
});

test("E2E: completion uses readProgressFull to get all output", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "e2e2");
  fs.mkdirSync(dir, { recursive: true });

  writeStreamLog(dir, [
    { kind: "system_event", text: "Started claude session." },
    { kind: "system_event", text: "claude has produced no output for 60s." },
  ]);
  writeTranscript(dir, [
    { role: "user", content: "Do the task" },
    { role: "assistant", content: "## START\nBeginning..." },
    { role: "assistant", content: "## DONE\nTask completed successfully" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };

  // Simulate several incremental reads that already happened
  readProgressIncremental(task, "e2e2");
  readProgressIncremental(task, "e2e2");

  // Now completion: should read FULL transcript
  const full = readProgressFull(task, "e2e2");
  assert.ok(full, "readProgressFull should return content");
  assert.ok(full.text.includes("START"), "Should include START");
  assert.ok(full.text.includes("DONE"), "Should include DONE");
  assert.ok(full.text.includes("Task completed successfully"), "Should include final content");
});

test("E2E: 'no output for 60s' stream message + no transcript → heartbeat", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "e2e3");
  fs.mkdirSync(dir, { recursive: true });

  writeStreamLog(dir, [
    { kind: "system_event", text: "Started claude session abc." },
    { kind: "system_event", text: "claude has produced no output for 60s. Waiting for input." },
  ]);
  writeTranscript(dir, [
    { role: "user", content: "Do something" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath, spawnedAt: new Date(Date.now() - 90000).toISOString() };
  const r = readProgressIncremental(task, "e2e3");
  assert.ok(r, "Should return heartbeat when stream shows stall but no transcript output");
  assert.ok(r.text.includes("任务执行中"), "Heartbeat should contain status message");
  assert.strictEqual(r.isDone, false);
});

test("E2E: rapid task completion within single relay interval", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "e2e4");
  fs.mkdirSync(dir, { recursive: true });

  writeStreamLog(dir, [
    { kind: "system_event", text: "Started claude session." },
  ]);
  writeTranscript(dir, [
    { role: "user", content: "Quick task" },
    { role: "assistant", content: "Done in 5 seconds!" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };

  // No incremental reads happened (task completed before first relay tick)
  const full = readProgressFull(task, "e2e4");
  assert.ok(full, "readProgressFull should return content even without prior reads");
  assert.strictEqual(full.text, "Done in 5 seconds!");
});

test("E2E: readProgressFull is idempotent (can be called multiple times)", () => {
  lastProgressReadOffset = {};
  const dir = path.join(TEMP_DIR, "e2e5");
  fs.mkdirSync(dir, { recursive: true });

  writeStreamLog(dir, [{ kind: "system_event", text: "Started." }]);
  writeTranscript(dir, [
    { role: "assistant", content: "Complete output" },
  ]);

  const streamLogPath = path.join(dir, "test.acp-stream.jsonl");
  const task = { streamLogPath };

  const r1 = readProgressFull(task, "e2e5");
  const r2 = readProgressFull(task, "e2e5");
  assert.deepStrictEqual(r1, r2, "readProgressFull should be idempotent");
});

// ─── Summary ───

console.log("\n" + results.join("\n"));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

if (failed > 0) process.exit(1);
