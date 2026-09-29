/** Bounded backend decisions. Handlers may read/propose only; effects belong to the caller. */
import { createHash, randomUUID } from 'node:crypto';
import { getAgentsDatabase } from './storage.js';
import { backgroundAuthContext, type PlatformAuthContext } from '../platform/auth.js';
import { validateJson, jsonClone } from '../platform/publication/validation.js';
import type { JsonSchema } from '../platform/publication/contracts.js';

type Json = Record<string, unknown>;
export type BackgroundOutcome = { status: 'resolved' | 'use_default'; value?: Json; reason?: string };
export type BackgroundHandler = {
  inputSchema: JsonSchema; resultSchema: JsonSchema; timeoutMs: number;
  execute(input: Json, context: { auth: PlatformAuthContext; signal: AbortSignal; deadline: number; audit: Json; assertActive(): void }): Promise<BackgroundOutcome>;
};
const handlers = new Map<string, BackgroundHandler>();
export function registerBackgroundTask(kind: string, handler: BackgroundHandler) {
  if (handlers.has(kind)) throw Error('Duplicate background task: ' + kind);
  handlers.set(kind, handler);
}
export async function runBackgroundTask(kind: string, request: { organizationId: string; userId: string; key: string; input: Json }): Promise<BackgroundOutcome & { taskId: string }> {
  const handler = handlers.get(kind);
  if (!handler) throw Error('Unknown background task: ' + kind);
  validateJson(handler.inputSchema, request.input, 'background task input');
  const input = jsonClone(request.input), db = getAgentsDatabase();
  const id = createHash('sha256').update(JSON.stringify([request.organizationId, request.userId, kind, request.key])).digest('hex');
  const now = Date.now(), deadline = now + Math.min(30000, Math.max(50, handler.timeoutMs));
  const token = randomUUID();
  const inserted = await db.prepare(`INSERT INTO agent_background_tasks(id,organization_id,kind,principal_id,state,token,deadline_at,input_json,created_at)
    VALUES(?,?,?,?,'running',?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, request.organizationId, kind, request.userId, token, new Date(deadline).toISOString(), JSON.stringify(input), new Date(now).toISOString());
  const fallback = (reason: string): BackgroundOutcome & { taskId: string } => ({ status: 'use_default', reason, taskId: id });
  if (!inserted.changes) {
    const row = await db.prepare('SELECT state,result_json,deadline_at FROM agent_background_tasks WHERE id=? AND organization_id=? AND principal_id=?').get(id, request.organizationId, request.userId);
    if (row?.state === 'completed') return { ...JSON.parse(String(row.result_json)), taskId: id };
    if (row && String(row.deadline_at) <= new Date().toISOString()) await db.prepare("UPDATE agent_background_tasks SET state='fallback',error='Worker interrupted or deadline elapsed',finished_at=? WHERE id=? AND state='running' AND deadline_at<=?").run(new Date().toISOString(), id, new Date().toISOString());
    // Joining callers never hold delivery hostage to another worker.
    return fallback('An equivalent task is running or previously fell back.');
  }
  const controller = new AbortController(), audit: Json = {};
  const assertActive = () => { controller.signal.throwIfAborted(); if (Date.now() >= deadline) throw Error('Background task deadline elapsed'); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: BackgroundOutcome;
  try {
    result = await Promise.race([
      (async () => {
        const auth = await backgroundAuthContext(request.organizationId, request.userId);
        assertActive();
        const outcome = await handler.execute(input, { auth, signal: controller.signal, deadline, audit, assertActive });
        assertActive();
        if (outcome.status === 'resolved') validateJson(handler.resultSchema, outcome.value, 'background task result');
        else if (outcome.status !== 'use_default') throw Error('Background tasks cannot request user input');
        return jsonClone(outcome);
      })(),
      new Promise<BackgroundOutcome>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'use_default', reason: 'Background task deadline elapsed' }); }, Math.max(1, deadline - Date.now())); })
    ]);
  } catch (error) { result = { status: 'use_default', reason: error instanceof Error ? error.message : 'Background task failed' }; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
  const saved = await db.prepare("UPDATE agent_background_tasks SET state=?,result_json=?,audit_json=?,error=?,finished_at=? WHERE id=? AND token=? AND state='running'")
    .run(result.status === 'resolved' ? 'completed' : 'fallback', JSON.stringify(result), JSON.stringify(jsonClone(audit)), String(result.reason || '').slice(0, 1000), new Date().toISOString(), id, token);
  if (!saved.changes) return fallback('Task ownership expired before its result was accepted.');
  return { ...result, taskId: id };
}
