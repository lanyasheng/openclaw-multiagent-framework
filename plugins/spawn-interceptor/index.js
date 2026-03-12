/**
 * spawn-interceptor — OpenClaw plugin for automatic ACP task tracking.
 *
 * Hooks:
 *   before_tool_call: intercepts sessions_spawn to inject completion relay
 *   subagent_ended: logs when sub-agents finish
 *
 * Install: openclaw plugins install --link ~/.openclaw/plugins/spawn-interceptor
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
  return `\n\n---\n[COMPLETION RELAY]\nWhen ALL work is done, execute sessions_send with:\n  sessionKey: "${COMPLETION_SESSION}"\n  message: JSON with fields:\n    type: "acp_completion"\n    taskId: "${taskId}"\n    status: "completed" or "failed"\n    summary: one-sentence result\n---`;
}

module.exports = {
  id: 'spawn-interceptor',
  name: 'Spawn Interceptor',
  description: 'Auto-tracks sessions_spawn and injects ACP completion relay',
  version: '1.0.0',

  register(api) {
    api.logger.info('spawn-interceptor: registering hooks');

    api.on('before_tool_call', (event, ctx) => {
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
        api.logger.info(`spawn-interceptor: injecting relay for task ${id} (acp)`);
        return { params: { ...p, task: p.task + relay(id) } };
      }
    });

    api.on('subagent_ended', (event, ctx) => {
      log({
        event: 'subagent_ended',
        targetSessionKey: event.targetSessionKey || '?',
        targetKind: event.targetKind || 'unknown',
        reason: event.reason || '',
        outcome: event.outcome || '',
        agentId: ctx.runId || '?',
        endedAt: new Date().toISOString()
      });
      api.logger.info(`spawn-interceptor: subagent ended (${event.targetSessionKey}, ${event.reason})`);
    });

    api.logger.info('spawn-interceptor: hooks registered');
  }
};
