import { badRequest, conflict, notFound } from '../../platform/errors.js';
import { normalizePhone, voiceSettings } from './settings.js';
import * as s from './storage.js';
import { object, text, type CustomerCall, type Json } from './storage.js';

export const conferenceLimit = 6;
export const participantActive = (p: Json) => ['ringing','connecting','connected','uncertain','leaving'].includes(text(p.state));
export async function participants(orgId: string, callId: string) {
  const rows=await s.database().prepare("SELECT id FROM customer_voice_resources WHERE organization_id=? AND kind='conference_participant' AND json_extract(data_json,'$.call_id')=?", "SELECT id FROM customer_voice_resources WHERE organization_id=? AND kind='conference_participant' AND data_json::jsonb->>'call_id'=?").all(orgId,callId);
  return Promise.all(rows.map(async row => (await s.resource(orgId,'conference_participant',text(object(row).id)))!));
}
export async function participantForLeg(orgId: string, callId: string, leg: Json | null) {
  if (!leg || leg.role !== 'participant') return null;
  const data = object(leg.data);
  return (await participants(orgId, callId)).find(p => p.id === data.participant_id || p.job_id === data.operation_id) || null;
}
export async function activeConferenceForUser(orgId: string, userId: string) {
  const endpoint = await s.resource(orgId, 'endpoint', userId);
  if (!text(endpoint?.offered_call_id)) return null;
  const call = await s.readCall(orgId, text(endpoint?.offered_call_id)).catch(() => null);
  if (!call || s.terminal.has(call.state)) return null;
  return (await participants(orgId, call.id)).find(p => p.user_id === userId && participantActive(p)) || null;
}
export async function conferenceOccupancy(call: CustomerCall) {
  const current=await participants(call.organization_id,call.id), legs=await s.legs(call.organization_id,call.id);
  const guests=current.filter(p=>participantActive(p)||legs.some(l=>l.state!=='ended'&&object(l.data).participant_id===p.id)).length;
  const pending=await s.database().prepare("SELECT id,data_json FROM customer_voice_resources WHERE organization_id=? AND kind='supervision' AND json_extract(data_json,'$.call_id')=?", "SELECT id,data_json FROM customer_voice_resources WHERE organization_id=? AND kind='supervision' AND data_json::jsonb->>'call_id'=?").all(call.organization_id,call.id);
  const supervisors=pending.map(row=>object({...object(JSON.parse(text(object(row).data_json))),id:object(row).id})).filter(p=>['dialing','joining','active','updating','leaving','uncertain'].includes(text(p.state))&&!legs.some(l=>l.state!=='ended'&&object(l.data).supervision_id===p.id)).length;
  return guests+supervisors+legs.filter(l=>l.role!=='participant'&&l.state!=='ended').length;
}
export async function observeParticipant(call: CustomerCall, p: Json, leg: Json | null, type: string) {
  for(const row of await s.database().prepare("SELECT id,payload_json FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND state='uncertain'").all(call.organization_id,call.id)){
    const job=object(row), intent=object(JSON.parse(text(job.payload_json)));
    const dial=intent.path==='dial'&&intent.participant_id===p.id&&object(leg?.data).operation_id===job.id;
    const command=intent.control_id===leg?.control_id&&((intent.path==='conference_join'&&['conference.participant.joined','call.hangup'].includes(type))||(intent.path==='hangup'&&type==='call.hangup'));
    if(dial||command)await s.database().prepare("UPDATE customer_call_jobs SET state='completed',error='',updated_at=? WHERE organization_id=? AND id=? AND state='uncertain'").run(s.now(),call.organization_id,text(job.id));
  }
}
export async function updateParticipant(orgId: string, callId: string, id: string, patch: Json) {
  return s.transaction(async () => {
    const p = await s.resource(orgId, 'conference_participant', id);
    if (!p || p.call_id !== callId) throw notFound('participant_not_found', 'This participant is unavailable.');
    // A late answer or provider response must not resurrect a canceled invitation.
    if (!participantActive(p) && patch.state && patch.state !== p.state) return p;
    const next = await s.saveResource(orgId, 'conference_participant', id, {...p, ...patch});
    if (patch.state && patch.state !== p.state) await s.appendEvent(orgId, callId, `communication.call.participant.${patch.state}`, {participant_id:id, name:p.name, phone:p.phone, user_id:p.user_id});
    if (!participantActive(next) && text(p.user_id)) {
      const endpoint = await s.resource(orgId, 'endpoint', text(p.user_id));
      if (endpoint?.offered_call_id === callId) await s.saveResource(orgId, 'endpoint', text(p.user_id), {...endpoint, offered_call_id:'', availability:'unavailable'});
    }
    return next;
  });
}
export async function inviteParticipant(call: CustomerCall, actorId: string, input: Json, operationId: string) {
  if (!['connected','held'].includes(call.state) || !text(call.metadata.conference_id)) throw conflict('conference_not_ready', 'Connect the call before adding someone.');
  if (['dialing','consulting'].includes(text(object(call.metadata.transfer).state))) throw conflict('transfer_in_progress', 'Finish or cancel the transfer before adding someone.');
  const settings = await voiceSettings(call.organization_id);
  if (!settings.enabled) throw conflict('voice_disabled', 'Phone calling is disabled.');
  const userId = text(input.target_user_id), phone = input.target_phone ? normalizePhone(input.target_phone) : '';
  if (!!userId === !!phone) throw badRequest('participant_target_required', 'Choose a teammate or enter one phone number.');
  const current = await participants(call.organization_id, call.id), legs = await s.legs(call.organization_id, call.id);
  const occupied = current.filter(p => participantActive(p) || legs.some(l => l.state !== 'ended' && object(l.data).participant_id === p.id));
  if (await conferenceOccupancy(call) >= conferenceLimit) throw conflict('conference_full', `This call supports ${conferenceLimit} people, including you.`);
  if (occupied.some(p => userId ? p.user_id === userId : p.phone === phone)) throw conflict('participant_already_added', 'This person is already on the call or being called.');
  let endpoint: Json | null = null;
  if (userId) {
    if (userId === actorId || userId === call.owner_user_id) throw badRequest('participant_self', 'You are already on the call.');
    endpoint = await s.resource(call.organization_id, 'endpoint', userId);
    if (!endpoint || endpoint.registered !== true || endpoint.availability !== 'available' || text(endpoint.branch_id || 'default') !== call.branch_id || text(endpoint.heartbeat_at) < new Date(Date.now()-45000).toISOString() || !text(endpoint.sip_username)) throw conflict('participant_unavailable', 'Choose an available teammate in this branch.');
  } else {
    await validateParticipantNumber(call, phone);
    if ([call.customer_number, call.business_number].includes(phone) || (await s.resources(call.organization_id,'number')).some(n => n.phone_number === phone)) throw conflict('participant_already_added', 'Choose a different number, or add your teammate by name.');
  }
  const app = await s.resource(call.organization_id, 'application');
  if (!app?.provider_id) throw conflict('phone_not_ready', 'The phone connection is unavailable.');
  const id = s.id('cp', `${call.id}:${operationId}`);
  const p = await s.saveResource(call.organization_id, 'conference_participant', id, {call_id:call.id, user_id:userId, phone, name:userId ? text(endpoint?.name) || 'Teammate' : text(input.target_name) || phone, state:'ringing', invited_by:actorId, invited_at:s.now()});
  if (endpoint) await s.saveResource(call.organization_id, 'endpoint', userId, {...endpoint, offered_call_id:call.id, availability:'busy', last_call_at:s.now()});
  const jobId = await s.enqueue(call.organization_id, call.id, 'provider', {path:'dial', role:'participant', participant_id:id, payload:{connection_id:app.provider_id, to:userId ? `sip:${text(endpoint?.sip_username)}@sip.telnyx.com` : phone, from:call.business_number, timeout_secs:settings.ring_seconds, time_limit_secs:settings.max_call_minutes*60, custom_headers:[{name:'X-FirstMate-Call',value:call.id}]}}, `${operationId}:participant`);
  await s.saveResource(call.organization_id,'conference_participant',id,{...p,job_id:jobId});
  await s.appendEvent(call.organization_id,call.id,'communication.call.participant.invited',{participant_id:id,name:p.name,phone,user_id:userId,actor_user_id:actorId},operationId);
}
export async function validateParticipantNumber(call: CustomerCall, phone: string) {
  const settings = await voiceSettings(call.organization_id);
  if (!settings.allowed_country_prefixes.some(prefix => phone.startsWith(prefix)) || /^\+1(900|976)/.test(phone)) throw badRequest('destination_not_allowed','This destination is outside your enabled calling regions.');
  if (await s.resource(call.organization_id,'suppression',phone)) throw conflict('number_suppressed','This contact has requested no phone calls.');
}
export async function removeParticipant(call: CustomerCall, id: string, operationId: string, state = 'removed') {
  const p = (await participants(call.organization_id,call.id)).find(p => p.id === id);
  if (!p) throw notFound('participant_not_found','This participant is unavailable.');
  await updateParticipant(call.organization_id,call.id,id,{state,ended_at:s.now()});
  for (const leg of await s.legs(call.organization_id,call.id)) {
    if (leg.state !== 'ended' && (object(leg.data).participant_id === id || object(leg.data).operation_id === p.job_id)) await s.enqueue(call.organization_id,call.id,'provider',{path:'hangup',control_id:leg.control_id,payload:{}},`${operationId}:${leg.id}`);
  }
}
export async function finishParticipants(call: CustomerCall) {
  for (const p of await participants(call.organization_id,call.id)) if (participantActive(p)) await updateParticipant(call.organization_id,call.id,p.id,{state:'left',ended_at:s.now()});
}
export function publicParticipants(items: Json[]) {
  return items.map(p => ({id:p.id,user_id:p.user_id,name:p.name,phone:p.phone,state:p.state,invited_at:p.invited_at,joined_at:p.joined_at,ended_at:p.ended_at,error:p.error}));
}
