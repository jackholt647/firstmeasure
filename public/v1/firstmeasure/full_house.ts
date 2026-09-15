import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../src/config/env.js';
import { FirstMeasureError } from './errors.js';

// The reserved ID namespace makes the privacy boundary durable, even when an
// old client overwrites metadata. The manifest flag is set only at submission.
export const FULL_HOUSE_PREFIX = 'fullhouse_';
export const isFullHouseId = (id: unknown) => String(id ?? '').trim().toLowerCase().startsWith(FULL_HOUSE_PREFIX);
export const fullHouseContext = new AsyncLocalStorage<{ request: FastifyRequest; allowed: boolean }>();

export function fullHouseEnabled() {
  return process.env.FIRSTMEASURE_FULL_HOUSE_ENABLED === '1';
}
export function fullHouseAllowedEmail(email: string) {
  return fullHouseEnabled() && String(process.env.FIRSTMEASURE_FULL_HOUSE_EMAILS ?? '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean).includes(email.trim().toLowerCase());
}
function forbidden() {
  return new FirstMeasureError('project_not_found', 404, 'Project not found.');
}
export function assertFullHouseProjectAccess(id: unknown) {
  const context = fullHouseContext.getStore();
  if (isFullHouseId(id) && context && !context.allowed) throw forbidden();
}
export function assertFullHouseNotDeliverable(id: unknown) {
  if (isFullHouseId(id)) throw new FirstMeasureError('internal_project_only', 403, 'Full-house measurements are internal drafts and cannot enter QA, billing or customer delivery.');
}

export async function authorizeFullHouseRequest(request: FastifyRequest): Promise<string | null> {
  if (!fullHouseEnabled()) return null;
  let email = '';
  const signedEmail = String(request.headers['x-full-house-user'] ?? '').trim().toLowerCase();
  const timestamp = String(request.headers['x-full-house-time'] ?? '');
  const signature = String(request.headers['x-full-house-signature'] ?? '');
  const secret = env.firstMeasureInternalApiSecret;
  if (signedEmail && secret && /^\d{10}$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 180) {
    const expected = createHmac('sha256', secret).update(`${signedEmail}\n${timestamp}`).digest('hex');
    if (/^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) email = signedEmail;
  }
  if (!email) {
    const { requirePlatformAuth } = await import('../platform/auth.js');
    try {
      const auth = await requirePlatformAuth(request, { csrf: !['GET', 'HEAD'].includes(request.method) });
      email = String(auth.identity.email ?? '').trim().toLowerCase();
    } catch { return null; }
  }
  if (!fullHouseAllowedEmail(email)) return null;
  const { readInternalUser } = await import('../internal/storage.js');
  const user = await readInternalUser(email).catch(() => null);
  if (!user || user.disabled === true || !['active', 'enabled'].includes(String(user.status ?? '').toLowerCase())) return null;
  return email;
}

export function installFullHouseAccess(app: FastifyInstance) {
  app.addHook('onRequest', (request, _reply, done) => {
    fullHouseContext.run({ request, allowed: false }, done);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.toLowerCase().includes(FULL_HOUSE_PREFIX) || request.url.includes('/internal-exteriors')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.addHook('preHandler', async (request, reply) => {
    const context = fullHouseContext.getStore();
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const route = decodeURIComponent(request.url.split('?')[0] ?? '');
    const specialRoute = route.includes('/internal-exteriors');
    const privateProject = route.toLowerCase().includes(FULL_HOUSE_PREFIX)
      || ['id', 'project_id', 'folder', 'source_project_id', 'reorder_project_id'].some(key => isFullHouseId(body[key]));
    if (!specialRoute && !privateProject) return;
    const email = await authorizeFullHouseRequest(request);
    if (!email || !context) throw forbidden();
    context.allowed = true;
    reply.header('Cache-Control', 'private, no-store');
    // Only editing/storage/imagery operations are available for internal drafts.
    if (privateProject && !specialRoute) {
      const match = route.match(/\/v1\/firstmeasure\/projects\/(fullhouse_[a-f0-9]{32})(?:\/(.*))?$/);
      const suffix = match?.[2] ?? '';
      const readable = request.method === 'GET' || request.method === 'HEAD';
      const allowedWrite = /^(editor\/(save|presence)|app-metadata|pdf-state|branding-defaults|artifacts|google-3d\/capture|process\/(imagery|insights)|mask\/ensure|pdfs\/preview)$/.test(suffix);
      if (!match || (!readable && !allowedWrite)) assertFullHouseNotDeliverable(FULL_HOUSE_PREFIX);
    }
  });
}
