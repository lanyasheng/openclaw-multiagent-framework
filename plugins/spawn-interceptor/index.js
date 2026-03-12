/**
 * spawn-interceptor — OpenClaw plugin for automatic ACP task tracking.
 *
 * Uses two hooks:
 *   1. before_tool_call: intercepts sessions_spawn to inject completion relay
 *   2. subagent_ended: logs completion when sub-agents finish
 *
 * Install: copy to ~/.openclaw/plugins/spawn-interceptor/
 * Config:  add "spawn-interceptor" to plugins.allow in openclaw.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SHARED_CTX = path.join(os.homedir(), '.openclaw', 'shared-context');
const TASK_LOG = path.join(SHARED_CTX, 'monitor-tasks', 'task-log.jsonl');
const COMPLETION_SESSION = 'agent:main:completion-relay';

function genId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `tsk_${ts}_${r}`;
}

function log(entry) {
  const dir = path.dirname(TASK_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(TASK_LOG, JSON.stringify(entry) + '\n');
}

function relay(taskId) {
  return `

---
[COMPLETION RELAY]
When ALL work is done, execute sessions_send with:
  sessionKey: "${COMPLETION_SESSION}"
  message: JSON with fields:
    type: "acp_completion"
    taskId: "${taskId}"
    status: "completed" or "failed"
    summary: one-sentence result
---`;
}

module.exports = {
  hooks: {
    before_tool_call(event, ctx) {
      if (event.toolName !== 'sessions_spawn') return;

      const p = event.params || {};
      const id = genId();
      const rt = p.runtime || 'subagent';

      log({
        taskId: id,
        agentId: ctx.agentId || '?',
        sessionKey: ctx.sessionKey || '',
        runtime: rt,
        task: String(p.task || '').slice(0, 200),
        spawnedAt: new Date().toISOString(),
        status: 'spawning'
      });

      if (rt === 'acp' && p.task) {
        return { params: { ...p, task: p.task + relay(id) } };
      }
    },

    subagent_ended(event, ctx) {
      log({
        event: 'subagent_ended',
        childSessionKey: event.childSessionKey || '?',
        agentId: ctx.agentId || '?',
        endedAt: new Date().toISOString()
      });
    }
  }
};
