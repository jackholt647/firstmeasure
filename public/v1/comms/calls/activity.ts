import { commsMessageView } from "../service.js";
import { listCalls, readCall, database, object, text, type CustomerCall, type Json } from "./storage.js";

export function callActivity(call:CustomerCall){
  return commsMessageView({id:call.id,conversation_id:call.id,channel:"call",direction:call.direction,status:call.state,
    subject:text(call.metadata.purpose)||"Customer call",text_body:call.notes||text(call.result.disposition)||call.state,
    sender:{name:call.customer_name,phone:call.customer_number},recipients:[],tags:[],project_id:call.project_id,contact_id:call.contact_id,
    created_at:call.created_at,updated_at:call.updated_at,metadata:{call_id:call.id,mode:call.mode,wrap_up_state:call.wrap_up_state,result:call.result},source:{type:"user"}});
}
export async function callActivityRows(orgId:string,filters:Json={}){return (await listCalls(orgId,filters)).calls.map(callActivity);}
export async function workflow(orgId:string,kind:string,sourceId:string,fallback:Json={}):Promise<Json & {status:string;owner_user_id:string;snoozed_until:string;revision:number}>{
  if(kind==='call'){const call=(await readCall(orgId,sourceId));fallback={owner_user_id:call.owner_user_id,status:call.wrap_up_state==='saved'?'closed':'open',...fallback};}
  const row=object((await database().prepare("SELECT * FROM customer_communication_workflow WHERE organization_id=? AND kind=? AND source_id=?").get(orgId,kind,sourceId)));
  return {status:"open",owner_user_id:"",snoozed_until:"",revision:0,...fallback,...row};
}
export async function incomingWorkflow(orgId:string,kind:string,sourceId:string,inboundAt:string,userId='',fallback:Json={}){
  let flow=(await workflow(orgId,kind,sourceId,fallback));
  if(inboundAt&&text(flow.updated_at)&&inboundAt>text(flow.updated_at)&&(flow.status==='closed'||text(flow.snoozed_until))){
    (await database().prepare("UPDATE customer_communication_workflow SET status='open',snoozed_until='',revision=revision+1,updated_at=? WHERE organization_id=? AND kind=? AND source_id=? AND revision=?")
      .run(inboundAt,orgId,kind,sourceId,flow.revision));flow=(await workflow(orgId,kind,sourceId,fallback));
  }
  const marker=userId?object((await database().prepare("SELECT read_at FROM customer_communication_read_markers WHERE organization_id=? AND user_id=? AND kind=? AND source_id=?").get(orgId,userId,kind,sourceId))):{};
  return {...flow,unread_count:userId&&inboundAt&&inboundAt>text(marker.read_at)?1:0};
}
export async function callInbox(orgId:string,filters:Json={}){
  return (await Promise.all((await listCalls(orgId,filters)).calls.map(async call=>{
    const flow=(await incomingWorkflow(orgId,"call",call.id,call.direction==='inbound'?call.created_at:'',text(filters.user_id)));
    return {id:call.id,channel:"call",subject:text(call.metadata.purpose)||"Customer call",project_id:call.project_id,project_title:"",contact_name:call.customer_name,
      contact_address:call.customer_number,last_message:callActivity(call),last_message_at:call.created_at,...flow};
  }))).filter(row=>!text(filters.status)||row.status===filters.status);
}
