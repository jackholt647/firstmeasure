import { readAuthSession } from "../../platform/storage.js";
import { voiceClient, voiceMode } from "../../telephony/telnyx.js";
import { processVoiceEvent } from "./worker.js";
import { providerCommand,withEndpointLease } from "./voice.js";
import * as s from "./storage.js";
import { object,text,type Json } from "./storage.js";

/** Reconciliation only accepts provider evidence; an uncertain dial is never replayed. */
export async function reconcileCall(orgId:string,callId:string){
  if(voiceMode()!=='live')return {checked:false,reason:'Server voice is disabled.'};
  let call=(await s.readCall(orgId,callId));const observations:Json[]=[];
  for(const leg of (await s.legs(orgId,callId)).filter(l=>l.state!=='ended')){
    const remote=await voiceClient().readCall(text(leg.control_id));observations.push({leg_id:leg.id,is_alive:remote.is_alive});
    if(remote.is_alive===false)await processVoiceEvent({data:{id:s.id('reconcile',`${leg.id}:${text(remote.end_time)}`),event_type:'call.hangup',occurred_at:text(remote.end_time)||s.now(),payload:{call_control_id:leg.control_id,hangup_cause:text(remote.hangup_cause)||'NORMAL_CLEARING'}}});
  }
  call=(await s.readCall(orgId,callId));const legs=(await s.legs(orgId,callId));
  const uncertain=(await s.database().prepare("SELECT * FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND state='uncertain'").all(orgId,callId));
  for(const row of uncertain){const job=object(row),payload=object(JSON.parse(text(job.payload_json))),command=text(payload.path);
    const proved=command==='dial'?legs.some(l=>object(l.data).operation_id===job.id):command==='conference_create'?!!call.metadata.conference_id:command==='hangup'?legs.some(l=>l.control_id===payload.control_id&&l.state==='ended'):false;
    if(proved)(await s.database().prepare("UPDATE customer_call_jobs SET state='completed',error='',lease_owner='',lease_until='',updated_at=? WHERE id=? AND state='uncertain'").run(s.now(),text(job.id)));
  }
  const jobs=(await s.jobs(orgId,callId)),pending=jobs.some(j=>['pending','running','uncertain'].includes(text(j.state)));
  if(!legs.length&&!pending&&jobs.some(j=>j.state==='failed')){(await s.patchCall(orgId,callId,{state:'failed',ended_at:s.now(),wrap_up_state:'needs_wrap_up'}));(await s.releaseClaims(orgId,callId));}
  if(!jobs.some(j=>j.state==='uncertain'||j.state==='failed')){call=(await s.readCall(orgId,callId));if(call.metadata.provider_error)(await s.patchCall(orgId,callId,{metadata:{...call.metadata,provider_error:null}}));}
  (await s.appendEvent(orgId,callId,'communication.call.reconciled',{observations}));return {checked:true,observations,operations:(await s.jobs(orgId,callId))};
}
export async function maintainVoiceSessions(){
  if(voiceMode()!=='live')return;
  const rows=(await s.database().prepare("SELECT organization_id,id FROM customer_calls WHERE mode IN ('browser','diagnostic') AND state NOT IN ('ended','canceled','failed','busy','no_answer','rejected') AND updated_at<? ORDER BY updated_at LIMIT 10")
    .all(new Date(Date.now()-30000).toISOString()));
  for(const row of rows){const orgId=text(object(row).organization_id),callId=text(object(row).id);let call=(await s.readCall(orgId,callId));
    await reconcileCall(orgId,callId).catch(()=>{});call=(await s.readCall(orgId,callId));if(s.terminal.has(call.state))continue;
    if(call.owner_user_id){const endpoint=(await s.resource(orgId,'endpoint',call.owner_user_id));const fresh=endpoint&&text(endpoint.heartbeat_at)>new Date(Date.now()-60000).toISOString();
      const session=fresh?await readAuthSession(text(endpoint.session_id)).catch(()=>null):null;
      if(!session){for(const leg of (await s.legs(orgId,callId)).filter(l=>l.state!=='ended'))(await providerCommand(call,text(leg.control_id),'hangup',{},`owner-disconnected:${leg.id}`));
        (await s.patchCall(orgId,callId,{metadata:{...call.metadata,provider_error:{state:'disconnecting',message:'The staff phone disconnected. Ending the call.'}}}));}
    }
  }
  const endpoints=(await s.database().prepare("SELECT organization_id,id,provider_id,data_json FROM customer_voice_resources WHERE kind='endpoint' AND (json_extract(data_json,'$.heartbeat_at')<? OR json_extract(data_json,'$.credential_expires_at')<?) LIMIT 10", "SELECT organization_id,id,provider_id,data_json FROM customer_voice_resources WHERE kind='endpoint' AND (data_json::jsonb #>> '{heartbeat_at}'<? OR data_json::jsonb #>> '{credential_expires_at}'<?) LIMIT 10")
    .all(new Date(Date.now()-86400000).toISOString(),s.now()));
  for(const row of endpoints){const endpoint=object(row),orgId=text(endpoint.organization_id),userId=text(endpoint.id);
    if((await s.listCalls(orgId,{owner_user_id:userId,active:true,include_diagnostics:true})).total)continue;
    try{await withEndpointLease(orgId,userId,async()=>{
      const current=object((await s.database().prepare("SELECT data_json FROM customer_voice_resources WHERE organization_id=? AND kind='endpoint' AND id=?").get(orgId,userId)));
      if(current.data_json!==endpoint.data_json||(await s.listCalls(orgId,{owner_user_id:userId,active:true,include_diagnostics:true})).total)return;
      if(endpoint.provider_id)await voiceClient().revokeCredential(text(endpoint.provider_id));
      (await s.database().prepare("DELETE FROM customer_voice_resources WHERE organization_id=? AND kind='endpoint' AND id=? AND data_json=?").run(orgId,userId,text(endpoint.data_json)));
    });
    }catch{/* Leave the endpoint discoverable for the next maintenance pass. */}
  }
}
