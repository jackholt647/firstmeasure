import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { backgroundAuthContext, requireCapability, type PlatformAuthContext } from '../../platform/auth.js';
import { conflict, forbidden, PlatformError } from '../../platform/errors.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { requireVoiceEnvironment, voiceClient, voiceWebhookUrl } from '../../telephony/telnyx.js';
import { callDepartmentResource, requireCallAccess } from './service.js';
import { voiceSettings } from './settings.js';
import { providerCommand, withEndpointLease } from './voice.js';
import * as s from './storage.js';
import { text, object, type Json, type CustomerCall } from './storage.js';

export const supervisionPermissions = { monitor: 'listen_calls', whisper: 'whisper_calls', barge: 'barge_calls', takeover: 'takeover_calls' } as const;
type Mode = keyof typeof supervisionPermissions;
const live = new Set(['dialing', 'joining', 'active', 'updating', 'leaving', 'uncertain']);
export const supervisionSchema = z.object({ operation_id: z.string().min(8).max(180), mode: z.enum(['monitor', 'whisper', 'barge', 'takeover', 'leave']) });
async function sessions(orgId: string, callId = '', userId = '', activeOnly = false) {
  const db = s.database(), field = (name: string) => db.isPostgres ? `data_json::jsonb->>'${name}'` : `json_extract(data_json,'$.${name}')`;
  const values: string[] = [orgId];
  const where = ["organization_id=?", "kind='supervision'"];
  if (callId) { where.push(`${field('call_id')}=?`); values.push(callId); }
  if (userId) { where.push(`${field('user_id')}=?`); values.push(userId); }
  if (activeOnly) where.push(`${field('state')} IN ('dialing','joining','active','updating','leaving','uncertain')`);
  const rows = await db.prepare(`SELECT id FROM customer_voice_resources WHERE ${where.join(' AND ')} ORDER BY ${field('created_at')} DESC LIMIT 100`).all(...values);
  return (await Promise.all(rows.map(row => s.resource(orgId, 'supervision', text(object(row).id))))).filter((v): v is NonNullable<typeof v> => !!v);
}
async function ownSession(orgId: string, callId: string, userId: string) {
  const rows = await sessions(orgId, callId, userId); return rows.find(v => live.has(text(v.state))) || rows[0] || null;
}
async function save(session: Json, patch: Json) { return s.saveResource(text(session.organization_id), 'supervision', text(session.id), {...session, ...patch}); }
export async function activeSupervisionCallId(orgId: string, userId: string) {
  for (const row of await sessions(orgId, '', userId, true)) if (!s.terminal.has((await s.readCall(orgId, text(row.call_id))).state)) return text(row.call_id);
  return '';
}
export async function supervisionView(ctx: PlatformAuthContext, call: CustomerCall) {
  requireCallAccess(ctx, call);
  const row = await ownSession(ctx.orgId, call.id, ctx.userId);
  return { session: row ? { id: row.id, user_id: row.user_id, call_id: row.call_id, mode: row.mode, state: row.state, joined_at: row.joined_at || '', created_at: row.created_at } : null,
    permissions: Object.fromEntries(Object.entries(supervisionPermissions).map(([mode, permission]) => [mode, hasResourcePermission(ctx, permission, callDepartmentResource(call)) && (mode !== 'takeover' || hasResourcePermission(ctx, 'make_calls', callDepartmentResource(call)))])) };
}
function authorize(ctx: PlatformAuthContext, call: CustomerCall, mode: Mode) {
  requireCallAccess(ctx, call);
  if (!hasResourcePermission(ctx, supervisionPermissions[mode], callDepartmentResource(call))) throw forbidden('supervision_forbidden', 'You do not have permission for this supervision mode on this call.');
  if (mode === 'takeover' && !hasResourcePermission(ctx, 'make_calls', callDepartmentResource(call))) throw forbidden('supervision_takeover_forbidden', 'Taking over also requires permission to make and control calls.');
}
async function currentAuthority(session: Json, call: CustomerCall) {
  const ctx = await backgroundAuthContext(call.organization_id, text(session.user_id));
  await requireCapability(ctx, 'apps.comms'); authorize(ctx, call, session.mode as Mode);
  if (session.effective_mode && session.effective_mode !== session.mode) authorize(ctx, call, session.effective_mode as Mode);
  return ctx;
}
async function queue(session: Json, path: string, key: string) {
  return s.enqueue(text(session.organization_id), text(session.call_id), 'provider', {path: `supervisor_${path}`, session_id: session.id, generation: session.generation}, `supervision:${session.id}:${key}`);
}
async function stop(session: Json, reason = 'ended') {
  const updated = await save(session, {state: reason, ended_at: s.now()});
  const endpoint = await s.resource(text(session.organization_id), 'endpoint', text(session.user_id));
  if (endpoint?.supervision_id === session.id) await s.saveResource(text(session.organization_id), 'endpoint', text(session.user_id), {...endpoint, supervision_id: '', availability: 'unavailable'});
  return updated;
}

/** Human intent is durable before any provider request. Provider uncertainty is never redialled. */
export async function superviseCall(ctx: PlatformAuthContext, callId: string, input: unknown) {
  const body = supervisionSchema.parse(input); const original = requireCallAccess(ctx, await s.readCall(ctx.orgId, callId));
  await requireCapability(ctx, 'apps.comms');
  if (body.mode !== 'leave') authorize(ctx, original, body.mode);
  await withEndpointLease(ctx.orgId, ctx.userId, () => s.transaction(async () => {
    const call = await s.readCall(ctx.orgId, callId);
    const op = await s.operation(ctx.orgId, 'supervision', body.operation_id, callId, {...body, actor: ctx.userId});
    if (op.existing) return;
    let session = await ownSession(ctx.orgId, callId, ctx.userId);
    if (body.mode === 'leave') {
      if (session && live.has(text(session.state))) {
        session = await save(session, {state: 'leaving', generation: randomUUID()});
        if (session.control_id) await providerCommand(call, text(session.control_id), 'hangup', {}, `${op.id}:leave`);
        else await stop(session);
      }
    } else {
      requireVoiceEnvironment();
      if (call.mode !== 'browser' || !call.connected_at || s.terminal.has(call.state) || !call.metadata.conference_id) throw conflict('supervision_call_not_live', 'Choose a connected browser call.');
      if (call.owner_user_id === ctx.userId) throw conflict('supervision_own_call', 'You already own this call.');
      if (['dialing','consulting'].includes(text(object(call.metadata.transfer).state))) throw conflict('supervision_transfer_busy', 'Finish the current transfer before supervising this call.');
      const endpoint = await s.resource(ctx.orgId, 'endpoint', ctx.userId);
      if (!endpoint?.registered || !endpoint.sip_username || text(endpoint.session_id) !== ctx.sessionId || (endpoint.credential_expires_at && text(endpoint.credential_expires_at) <= s.now()) || text(endpoint.heartbeat_at) < new Date(Date.now()-45_000).toISOString()) throw conflict('supervision_endpoint_required', 'Connect your browser phone before joining this call.');
      if (session && live.has(text(session.state))) {
        if (session.state !== 'active') throw conflict('supervision_busy', 'Wait for the current supervision operation to finish.');
        session = await save(session, {mode: body.mode, state: 'updating', generation: randomUUID()});
        await queue(session, 'update', op.id);
      } else {
        if ((await s.jobs(ctx.orgId,callId)).some(job => job.state === 'uncertain')) throw conflict('supervision_reconciliation_required', 'A previous provider operation has an unknown result. Reconcile the call before joining again.');
        if ((await s.listCalls(ctx.orgId, {owner_user_id: ctx.userId, active: true})).total || await activeSupervisionCallId(ctx.orgId, ctx.userId)) throw conflict('supervision_phone_busy', 'Finish your current call before joining another.');
        if ((await sessions(ctx.orgId, callId)).filter(v => live.has(text(v.state))).length >= 3) throw conflict('supervision_full', 'This call already has the maximum number of supervisors.');
        const id = randomUUID();
        session = await s.saveResource(ctx.orgId, 'supervision', id, {organization_id: ctx.orgId, call_id: callId, user_id: ctx.userId, mode: body.mode, state: 'dialing', created_at: s.now(), generation: randomUUID(), sip_username: endpoint.sip_username, device_id: endpoint.device_id});
        await s.saveResource(ctx.orgId, 'endpoint', ctx.userId, {...endpoint, availability: 'busy', supervision_id: id});
        await queue(session, 'dial', op.id);
      }
    }
    await s.appendEvent(ctx.orgId, callId, 'communication.call.supervision_requested', {actor_user_id: ctx.userId, mode: body.mode}, op.id);
    await s.finishOperation(ctx.orgId, op.id, {call_id: callId, session_id: session?.id || ''});
  }));
  const call = await s.readCall(ctx.orgId, callId); return {call, supervision: await supervisionView(ctx, call)};
}

/** The phone tray can answer or dismiss its own supervisor leg, never somebody else's call. */
export async function supervisionCallControl(ctx: PlatformAuthContext, call: CustomerCall, body: Json) {
  if (!['accept','decline','hangup'].includes(text(body.action)) || call.owner_user_id === ctx.userId) return false;
  const session = await ownSession(ctx.orgId, call.id, ctx.userId);
  if (!session || !live.has(text(session.state))) return false;
  if (body.action === 'accept') authorize(ctx, call, session.mode as Mode);
  if (!session.control_id) { if (body.action === 'accept') throw conflict('supervision_connecting', 'Your supervisor phone is still connecting.'); await superviseCall(ctx, call.id, {operation_id: body.operation_id, mode: 'leave'}); return true; }
  await s.transaction(async () => {
    const op = await s.operation(ctx.orgId, 'supervision-control', text(body.operation_id), call.id, {...body, actor: ctx.userId});
    if (op.existing) return;
    if (body.action !== 'accept') await save(session, {state: 'leaving', generation: randomUUID()});
    await providerCommand(call, text(session.control_id), body.action === 'accept' ? 'answer' : 'hangup', {}, op.id);
    await s.finishOperation(ctx.orgId, op.id, {call_id: call.id});
  }); return true;
}

function participantPayload(session: Json, agentId: string) {
  return {call_control_id: session.control_id, supervisor_role: session.mode === 'takeover' ? 'barge' : session.mode,
    ...(session.mode === 'whisper' ? {whisper_call_control_ids: [agentId]} : {})};
}
export async function completeSupervisionTakeover(session: Json, call: CustomerCall) {
  if (!session.joined_at || session.mode !== 'takeover' || session.state === 'taken_over') return;
  await currentAuthority(session, call);
  await s.transaction(async db => {
    const durable = await s.resource(call.organization_id, 'supervision', text(session.id));
    if (!durable || durable.call_id !== call.id || durable.user_id !== session.user_id || durable.generation !== session.generation || durable.mode !== 'takeover' || durable.state !== 'active' || !durable.joined_at) return;
    session = durable;
    call = await s.readCall(call.organization_id, call.id);
    const leg = await s.legByControl(text(session.control_id));
    if (s.terminal.has(call.state) || leg?.state === 'ended' || leg?.role !== 'supervisor') return;
    const previousOwner = call.owner_user_id;
    const agents = (await s.legs(call.organization_id, call.id)).filter(v => v.role === 'agent' && v.state !== 'ended');
    await db.prepare("UPDATE customer_call_legs SET role='transferred_agent' WHERE organization_id=? AND call_id=? AND role='agent'").run(call.organization_id, call.id);
    await db.prepare("UPDATE customer_call_legs SET role='agent' WHERE organization_id=? AND call_id=? AND control_id=?").run(call.organization_id, call.id, text(session.control_id));
    await s.patchCall(call.organization_id, call.id, {owner_user_id: text(session.user_id)});
    await save(session, {state: 'taken_over', previous_owner_user_id: previousOwner});
    const priorEndpoint = await s.resource(call.organization_id, 'endpoint', previousOwner);
    if (priorEndpoint) await s.saveResource(call.organization_id, 'endpoint', previousOwner, {...priorEndpoint, availability: 'unavailable'});
    const endpoint = await s.resource(call.organization_id, 'endpoint', text(session.user_id));
    if (endpoint) await s.saveResource(call.organization_id, 'endpoint', text(session.user_id), {...endpoint, supervision_id: '', availability: 'busy'});
    // A whisper is private to its original agent. End it on ownership change;
    // the supervisor can explicitly rejoin to coach the new call owner.
    for (const other of await sessions(call.organization_id, call.id)) if (other.id !== session.id && other.mode === 'whisper' && live.has(text(other.state))) {
      await stop(other);
      if (other.control_id) await providerCommand(call, text(other.control_id), 'hangup', {}, `takeover-whisper:${session.id}:${other.id}`);
    }
    for (const agent of agents) await providerCommand(call, text(agent.control_id), 'hangup', {}, `takeover:${session.id}:${agent.id}`);
    if (call.state === 'held') { const customer = (await s.legs(call.organization_id, call.id)).find(v => v.role === 'customer' && v.state !== 'ended'); if (customer) await providerCommand(call, text(customer.control_id), 'conference_unhold', {}, `takeover:${session.id}:resume`); }
    await s.appendEvent(call.organization_id, call.id, 'communication.call.taken_over', {actor_user_id: session.user_id, previous_owner_user_id: previousOwner}, `takeover:${session.id}`);
  });
}

/** Provider jobs reload both human authority and the server-owned target. */
export async function executeSupervision(job: Json, payload: Json): Promise<Json> {
  let session = await s.resource(text(job.organization_id), 'supervision', text(payload.session_id));
  if (!session || session.call_id !== job.call_id || session.generation !== payload.generation || !live.has(text(session.state))) return {canceled: true};
  let call = await s.readCall(text(job.organization_id), text(job.call_id));
  if (s.terminal.has(call.state)) { await stop(session); return {canceled: true}; }
  await currentAuthority(session, call);
  const commandId = text(job.id), action = text(payload.path);
  const agent = (await s.legs(call.organization_id, call.id)).find(v => v.role === 'agent' && v.state !== 'ended');
  if (!agent) throw conflict('supervision_agent_unavailable', 'The original caller is no longer connected.');
  if (action === 'supervisor_dial') {
    const settings = await voiceSettings(call.organization_id), app = await s.resource(call.organization_id, 'application');
    const endpoint = await s.resource(call.organization_id, 'endpoint', text(session.user_id));
    if (!settings.enabled || !app?.provider_id || !endpoint?.registered || endpoint.device_id !== session.device_id || text(endpoint.heartbeat_at) < new Date(Date.now()-45_000).toISOString()) throw conflict('supervision_endpoint_unavailable', 'Your browser phone is no longer connected.');
    const result = await voiceClient().dial({connection_id: app.provider_id, to: `sip:${text(session.sip_username)}@sip.telnyx.com`, from: call.business_number, webhook_url: voiceWebhookUrl(), command_id: commandId,
      timeout_secs: settings.ring_seconds, time_limit_secs: settings.max_call_minutes*60, custom_headers: [{name: 'X-FirstMate-Call', value: call.id}],
      client_state: Buffer.from(JSON.stringify({call_id: call.id, role: 'supervisor', supervision_id: session.id, operation_id: commandId})).toString('base64')});
    if (!result.call_control_id) throw new Error('Provider did not return the supervisor call ID.');
    await s.saveLeg(call.organization_id, call.id, 'supervisor', {...result, supervision_id: session.id, operation_id: commandId, state: 'initiated'}, '0000-01-01T00:00:00.000Z');
    session = (await s.resource(call.organization_id, 'supervision', text(session.id)))!;
    session = await save(session, {control_id: result.call_control_id});
    call = await s.readCall(call.organization_id, call.id);
    if (!live.has(text(session.state)) || session.state === 'leaving' || s.terminal.has(call.state)) await providerCommand(call, text(result.call_control_id), 'hangup', {}, `supervisor-late:${session.id}`);
    return result;
  }
  const leg = await s.legByControl(text(session.control_id));
  if (!leg || leg.state === 'ended' || leg.role !== 'supervisor') { await stop(session); return {canceled: true}; }
  if (action === 'supervisor_activate') { await completeSupervisionTakeover(session, call); return {ok: true}; }
  const command = action === 'supervisor_join' ? 'join' : 'update';
  if (!text(call.metadata.conference_id)) throw conflict('supervision_conference_unavailable', 'The call conference is no longer available.');
  if (session.mode === 'whisper') session = await save(session, {whisper_target_control_id: agent.control_id});
  const result = await voiceClient().conference(text(call.metadata.conference_id), command, {...participantPayload(session, text(agent.control_id)), command_id: commandId,
    ...(command === 'join' ? {beep_enabled: 'never', end_conference_on_exit: false} : {})});
  session = (await s.resource(call.organization_id, 'supervision', text(session.id)))!;
  if (session.generation !== payload.generation || session.state === 'leaving' || !live.has(text(session.state))) return result;
  if (command === 'update') { session = await save(session, {state: 'active', effective_mode: session.mode}); await completeSupervisionTakeover(session, await s.readCall(call.organization_id, call.id)); }
  return result;
}

/** A supervisor leaving never terminates the customer's or agent's leg. */
export async function supervisionEvent(call: CustomerCall, type: string, payload: Json, state: Json, known: Json | null): Promise<boolean> {
  if (text(known?.role || state.role) !== 'supervisor') return false;
  const controlId = text(payload.call_control_id);
  const sessionId = text(state.supervision_id || object(known?.data).supervision_id);
  let session = sessionId ? await s.resource(call.organization_id, 'supervision', sessionId) : (await sessions(call.organization_id, call.id)).find(v => v.control_id === controlId);
  if (!session || session.call_id !== call.id) { if (controlId && type === 'call.answered') await providerCommand(call, controlId, 'hangup', {}, `unknown-supervisor:${controlId}`); return true; }
  session = await save(session, {control_id: controlId || session.control_id});
  // A signed correlated webhook proves the paid dial happened; it is safe to
  // release the uncertainty barrier without ever repeating the dial request.
  const operationId = text(state.operation_id || object(known?.data).operation_id);
  if (operationId) {
    const row = object(await s.database().prepare("SELECT payload_json FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND id=? AND state='uncertain'").get(call.organization_id,call.id,operationId));
    let intent: Json = {}; try { intent = object(JSON.parse(text(row.payload_json))); } catch { /* No pending correlated operation. */ }
    if (intent.path === 'supervisor_dial' && intent.session_id === session.id) {
      await s.database().prepare("UPDATE customer_call_jobs SET state='completed',error='',updated_at=? WHERE organization_id=? AND id=? AND state='uncertain'").run(s.now(),call.organization_id,operationId);
      if (session.state === 'uncertain') session = await save(session,{state:'dialing'});
    }
  }
  if (['call.hangup','conference.participant.left'].includes(type)) {
    await stop(session);
    if (type === 'conference.participant.left' && controlId) await providerCommand(call,controlId,'hangup',{},`supervision-left:${session.id}`);
    if (type === 'call.hangup') {
      // An ended leg cannot retain a conference mode. Clear only its own
      // uncertain join/update barrier so the customer's controls can continue.
      // Unknown paid dials still require their exact operation correlation above.
      for (const row of await s.database().prepare("SELECT id,payload_json FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND state='uncertain'").all(call.organization_id,call.id)) {
        const job=object(row), intent=object(JSON.parse(text(job.payload_json)));
        if (intent.session_id === session.id && ['supervisor_join','supervisor_update'].includes(text(intent.path))) await s.database().prepare("UPDATE customer_call_jobs SET state='completed',response_json=?,error='',updated_at=? WHERE organization_id=? AND id=? AND state='uncertain'").run(JSON.stringify({canceled:true,reason:'supervisor_leg_ended'}),s.now(),call.organization_id,text(job.id));
      }
    }
    return true;
  }
  if (['call.initiated','call.answered','conference.participant.joined'].includes(type) && (!live.has(text(session.state)) || session.state === 'leaving' || s.terminal.has(call.state))) {
    if (controlId) await providerCommand(call, controlId, 'hangup', {}, `late-supervisor:${controlId}`); return true;
  }
  if (type === 'call.answered') { if (known?.state === 'ended') return true; if (!session.joined_at) { session = await save(session, {state: 'joining'}); await queue(session, 'join', `join:${session.generation}`); } }
  if (type === 'conference.participant.joined') {
    // Duplicate join delivery must not commit a later, still-pending mode change.
    if (session.joined_at) return true;
    for (const row of await s.database().prepare("SELECT id,payload_json FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND state='uncertain'").all(call.organization_id,call.id)) {
      const job = object(row), intent = object(JSON.parse(text(job.payload_json)));
      if (intent.path === 'supervisor_join' && intent.session_id === session.id && intent.generation === session.generation) await s.database().prepare("UPDATE customer_call_jobs SET state='completed',error='',updated_at=? WHERE organization_id=? AND id=? AND state='uncertain'").run(s.now(),call.organization_id,text(job.id));
    }
    session = await save(session, {state: 'active', effective_mode: session.mode, joined_at: session.joined_at || s.now()});
    if (session.mode === 'takeover') await queue(session, 'activate', `activate:${session.generation}`);
  }
  return true;
}

export async function supervisionFailed(job: Json, payload: Json, uncertain: boolean) {
  const session = await s.resource(text(job.organization_id), 'supervision', text(payload.session_id));
  if (!session || session.generation !== payload.generation || !live.has(text(session.state))) return;
  if (uncertain) {
    await save(session, {state: 'uncertain'});
    // We cannot assume a requested quieter mode actually replaced a live barge.
    // A hangup is safe even behind the uncertainty barrier and is never a redial.
    if (payload.path === 'supervisor_update' && session.control_id) await providerCommand(await s.readCall(text(job.organization_id),text(job.call_id)),text(session.control_id),'hangup',{},`supervision-uncertain-update:${job.id}`);
    return;
  }
  await stop(session, 'failed');
  if (session.control_id) await providerCommand(await s.readCall(text(job.organization_id), text(job.call_id)), text(session.control_id), 'hangup', {}, `supervision-failed:${job.id}`);
}

/** Revocation or browser loss ends only supervision; ordinary callers stay connected. */
export async function maintainSupervisionSessions() {
  const rows = await s.database().prepare("SELECT organization_id,id FROM customer_voice_resources WHERE kind='supervision' AND json_extract(data_json,'$.state') IN ('dialing','joining','active','updating','leaving','uncertain') ORDER BY updated_at LIMIT 50", "SELECT organization_id,id FROM customer_voice_resources WHERE kind='supervision' AND data_json::jsonb->>'state' IN ('dialing','joining','active','updating','leaving','uncertain') ORDER BY updated_at LIMIT 50").all();
  for (const row of rows) {
    let session = await s.resource(text(object(row).organization_id), 'supervision', text(object(row).id)); if (!session) continue;
    const call = await s.readCall(text(session.organization_id), text(session.call_id));
    const endpoint = await s.resource(call.organization_id, 'endpoint', text(session.user_id));
    let end = s.terminal.has(call.state) || !endpoint?.registered || text(endpoint.heartbeat_at) < new Date(Date.now()-60_000).toISOString();
    if (!end && session.mode === 'whisper' && session.whisper_target_control_id) {
      const target = await s.legByControl(text(session.whisper_target_control_id)); end = !target || target.role !== 'agent' || target.state === 'ended';
    }
    if (!end) try { await currentAuthority(session, call); } catch(error) {
      if (error instanceof PlatformError && [401,403,404].includes(error.statusCode)) end = true; else throw error;
    }
    if (end) {
      session = await stop(session);
      if (session.control_id) await providerCommand(call, text(session.control_id), 'hangup', {}, `supervision-maintenance:${session.id}`);
    } else await save(session, {}); // Fair sweep order for organizations with many supervisors.
  }
}
