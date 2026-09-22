import { ensureCallListDatabase, getCallListDatabase } from '../../internal/crm/call_lists.js';
import { withLeadDb } from '../../internal/crm/leads.js';
import { getChannelsDatabase } from '../../channels/storage.js';
import { getWorkDatabase } from '../../work/storage.js';
import { listDocuments } from '../../platform/storage.js';
import * as s from './storage.js';
import { object,text,type Json } from './storage.js';

const parse=(value:unknown)=>{try{return object(JSON.parse(text(value)||'{}'));}catch{return {};}};
const timestamp=(value:unknown)=>{const date=new Date(typeof value==='number'?(value<1e12?value*1000:value):text(value));return Number.isFinite(date.getTime())?date.toISOString():'';};
/** Additive backfill only: no dialing, Work events, new follow-ups, or legacy deletion. */
export async function migrateLegacyCalls(orgId:string,apply=false){
  await ensureCallListDatabase();
  const projects=new Map((await listDocuments(orgId,'projects')).map(p=>[p.id,object(p.data)]));
  const users=(await listDocuments(orgId,'users')).map(u=>({id:u.id,...object(u.data)} as Json));
  const candidates=new Map<string,Json>();let skipped=0;
  const add=(key:string,data:Json)=>{if(!key||data.disposition==='skipped'){skipped++;return;}candidates.set(key,{...candidates.get(key),...Object.fromEntries(Object.entries(data).filter(([,v])=>v!==''&&v!==undefined))});};
  const sharedEntries = await getCallListDatabase().prepare('SELECT * FROM crm_call_list_entries WHERE organization_id=? AND result_json<>?').all(orgId,'{}');
  // Legacy compatibility snapshots may still contain historical outcomes. Read
  // them additively when present; new installs only have the shared store.
  const legacyEntries = withLeadDb(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_call_list_entries'").get()
    ? db.prepare('SELECT * FROM crm_call_list_entries WHERE organization_id=? AND result_json<>?').all(orgId,'{}') : []);
  const entries = [...legacyEntries, ...sharedEntries].map(object);
  for(const entry of entries){const result=parse(entry.result_json),payload=parse(entry.payload_json);add(text(result.call_id||result.id),{...result,entry_id:entry.id,project_id:entry.project_id,customer_name:payload.name||payload.contact_name,customer_number:payload.phone,at:result.created_at||entry.completed_at,source:'call_list_result'});}
  for(const row of (await getWorkDatabase().prepare("SELECT * FROM work_events WHERE organization_id=? AND type='call.completed'").all(orgId)).map(object)){
    const payload=parse(row.payload_json),context=parse(row.context_json);add(text(payload.call_id),{...payload,project_id:row.project_id,branch_id:row.branch_id,customer_name:payload.contact_name,customer_number:payload.phone,owner_user_id:context.actor_user_id,at:row.created_at,source:'work_call_completed'});
  }
  for(const row of (await getChannelsDatabase().prepare("SELECT m.*,c.project_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.organization_id=? AND m.deleted_at IS NULL AND json_extract(m.metadata_json,'$.call.id') IS NOT NULL", "SELECT m.*,c.project_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.organization_id=? AND m.deleted_at IS NULL AND m.metadata_json::jsonb #>> '{call,id}' IS NOT NULL").all(orgId)).map(object)){
    const call=object(parse(row.metadata_json).call);add(text(call.id),{...call,project_id:row.project_id,notes:row.text,owner_user_id:row.author_id,at:call.created_at||row.created_at,source:'channel_call_note',note_id:row.id});
  }
  const leadRows=withLeadDb(db=>db.prepare(`SELECT d.*,l.lead_name AS full_name,l.phone FROM lead_dial_events d JOIN lead_memberships l ON l.id=d.lead_id WHERE l.organization_id=?`).all(orgId)).map(object);
  for(const row of leadRows){const context=parse(row.context_json);if(!text(context.call_disposition||context.disposition)){skipped++;continue;}
    const notes=withLeadDb(db=>db.prepare('SELECT note_text FROM lead_notes WHERE lead_id=? AND dial_event_id=? ORDER BY created_at').all(text(row.lead_id),text(row.id))).map(n=>text(object(n).note_text)).join('\n\n');
    add(`lead:${text(row.id)}`,{disposition:context.call_disposition||context.disposition,outcome:context.outcome,customer_name:row.full_name,customer_number:row.phone,owner_email:row.owner_email,at:row.dialed_at||row.created_at,notes,source:'legacy_lead_dial',lead_id:row.lead_id});
  }
  let existing=0,imported=0,eligible=0;const conflicts:Array<{source_id:string;reason:string}>=[];
  for(const [key,item] of candidates){const canonical=s.id('call',`${orgId}:legacy:${key}`);
    if((await s.database().prepare('SELECT id FROM customer_calls WHERE organization_id=? AND id IN (?,?)').get(orgId,key,canonical))){existing++;continue;}
    const at=timestamp(item.at),projectId=text(item.project_id),project=projects.get(projectId);
    if(!at||(projectId&&!project)){conflicts.push({source_id:key,reason:!at?'Missing historical date':'Project is unavailable'});continue;}
    eligible++;if(!apply)continue;
    (await s.transaction(async ()=>{
      const owner=text(item.owner_user_id)||text(users.find(u=>text(u.email).toLowerCase()===text(item.owner_email).toLowerCase())?.id);
      const call=(await s.insertCall({id:canonical,organization_id:orgId,branch_id:text(project?.branch_id||item.branch_id)||'default',project_id:projectId,owner_user_id:owner,mode:'external',direction:'outbound',state:'ended',
        customer_name:text(item.customer_name),customer_number:text(item.customer_number),entry_id:text(item.entry_id),created_at:at,metadata:{legacy:{source_id:key,source:item.source,note_id:item.note_id,lead_id:item.lead_id},duration_unknown:true}}));
      (await s.patchCall(orgId,call.id,{notes:text(item.notes),ended_at:at,wrap_up_state:'saved',result:{disposition:text(item.disposition),legacy_outcome:text(item.outcome),next_action:'none'}}));
      (await s.appendEvent(orgId,call.id,'communication.call.imported',{source:item.source,source_id:key},`legacy:${key}`));
    }));imported++;
  }
  return {mode:apply?'apply':'dry_run',organization_id:orgId,candidates:candidates.size,eligible,existing,imported,skipped,conflicts};
}
