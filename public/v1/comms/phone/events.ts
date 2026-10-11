import {phoneEventEnvelope} from './event-contracts.js';
/** Called only by the durable customer-call worker. Stable event keys survive a
 * crash after Work commits but before the call job acknowledges delivery. */
export async function publishPhoneEvent(organizationId:string,eventId:string,input:unknown){
 const event=phoneEventEnvelope.parse(input);
 const {emitWorkEvent}=await import('../../work/engine.js');
 return emitWorkEvent({organization_id:organizationId,branch_id:event.payload.branch_id,project_id:event.payload.project_id,type:event.type,payload:event.payload,
 context:{phone_resource_id:event.payload.resource_id,department_ids:event.payload.department_ids},idempotency_key:`phone:${eventId}`},{process:'background'});
}
