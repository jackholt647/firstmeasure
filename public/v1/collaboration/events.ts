import { registerWorkEvents } from "../work/events.js";
import { emitWorkEvent } from "../work/engine.js";
import { collaborationStore, getRecord, withOrganizationLocks } from "./storage.js";
import { privacy, connectionBetween } from "./service.js";

const names=["privacy.changed","audience.updated","invitation.created","invitation.revoked","connection.requested","connection.accepted","connection.active","connection.suspended","connection.blocked","connection.ended","relationship.updated","share.created","share.accepted","share.revoked","project.updated","message.posted","photo.uploaded","note.created","document.signed","document.responded","engagement.proposed","engagement.scheduled","engagement.accepted","engagement.declined","engagement.completed","engagement.canceled","partner_document.added","payment.reported","invoice.paid","schedule.updated","work.updated"];
export function registerCollaborationEvents(){
  registerWorkEvents(names.map(name=>({name:`collaboration.${name}`,description:`External collaboration: ${name.replaceAll("."," ")}`,visibility:"system" as const,notification:{group:"organization" as const,source:"organization" as const,tab:"general" as const},payload:{record_id:"Opaque collaboration record reference",revision:"Record revision at the time of the event"}})));
}

/** At-least-once delivery to the existing idempotent workflow event ledger.
 * Events carry references only; workflow reads must use current authorization. */
export async function drainCollaborationEvents(limit=100){
  const db=collaborationStore();
  const rows=await db.prepare("SELECT id,organization_id FROM collaboration_outbox WHERE delivered=0 ORDER BY id LIMIT ?").all(limit);
  for(const row of rows){
    try{
      await withOrganizationLocks([String(row.organization_id)],async()=>{
        const pending=await db.prepare("SELECT * FROM collaboration_outbox WHERE id=? AND delivered=0").get(String(row.id));
        if(!pending)return;
        const payload=JSON.parse(String(pending.payload_json)),record=await getRecord(payload.record_id);
        const recipient=String(row.organization_id),isOwner=record.owner_org_id===recipient;
        if(isOwner&&["collaboration.message.posted","collaboration.note.created"].includes(String(pending.event_type))){
          const messageId=String(payload.message_id||payload.note_id||"");
          if(messageId)await (await import("../channels/service.js")).publishStoredMessage(recipient,messageId);
        }
        const policy=(await privacy(recipient)).policy;
        const connection=record.recipient_org_id?await connectionBetween(record.owner_org_id,record.recipient_org_id):null;
        // Do not newly publish counterpart activity after collaboration was disabled.
        const ownerPolicy=await privacy(record.owner_org_id);
        const visible=isOwner||policy.enabled&&policy.receive_shares&&ownerPolicy.policy.enabled&&ownerPolicy.policy.send_shares&&
          (connection?.status==="active"||String(pending.event_type).startsWith("collaboration.connection."));
        if(visible)await emitWorkEvent({organization_id:recipient,type:String(pending.event_type),idempotency_key:`collaboration:${row.id}`,payload:{record_id:record.id,revision:payload.revision}},{process:false});
        await db.prepare("UPDATE collaboration_outbox SET delivered=1,attempts=attempts+1,last_error='' WHERE id=?").run(String(row.id));
      });
    }catch{
      await db.prepare("UPDATE collaboration_outbox SET attempts=attempts+1,last_error='Delivery failed; retry pending' WHERE id=?").run(String(row.id));
    }
  }
}
