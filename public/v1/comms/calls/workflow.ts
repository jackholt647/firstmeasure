import { z } from "zod";
import type { PlatformAuthContext } from "../../platform/auth.js";
import { forbidden, conflict } from "../../platform/errors.js";
import { readDocument } from "../../platform/storage.js";
import { readConversationRecord } from "../../messaging/communications_storage.js";
import { manageCalls, requireCallAccess, projectContext } from "./service.js";
import { workflow } from "./activity.js";
import * as s from "./storage.js";

const schema=z.object({kind:z.enum(['conversation','call']),source_id:z.string().min(1).max(180),revision:z.number().int().nonnegative(),
  action:z.enum(['assign','resolve','reopen','snooze','unsnooze','read']),owner_user_id:z.string().max(180).default(''),snoozed_until:z.string().max(100).default('')});
export async function changeConversationWorkflow(ctx:PlatformAuthContext,input:unknown){
  const body=schema.parse(input);
  if(body.kind==='call')requireCallAccess(ctx,(await s.readCall(ctx.orgId,body.source_id)),body.action!=='read');
  else{const source=(await readConversationRecord(ctx.orgId,body.source_id));if(!manageCalls(ctx)&&s.text(source.branch_id||'default')!==(ctx.branchId||'default'))throw forbidden('conversation_branch_forbidden','This conversation belongs to another branch.');await projectContext(ctx,s.text(source.project_id));}
  if(body.action==='assign'&&body.owner_user_id){
    if(body.owner_user_id!==ctx.userId&&!manageCalls(ctx))throw forbidden('assignment_forbidden','A manager must assign conversations to other staff.');
    await readDocument(ctx.orgId,'users',body.owner_user_id);
  }
  if(body.action==='snooze'&&(!Number.isFinite(Date.parse(body.snoozed_until))||Date.parse(body.snoozed_until)<=Date.now()))throw conflict('snooze_date_invalid','Choose a future time.');
  return (await s.transaction(async db=>{
    const current=(await workflow(ctx.orgId,body.kind,body.source_id));
    if(body.action==='read'){
      (await db.prepare("INSERT INTO customer_communication_read_markers(organization_id,user_id,kind,source_id,read_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,user_id,kind,source_id) DO UPDATE SET read_at=excluded.read_at")
        .run(ctx.orgId,ctx.userId,body.kind,body.source_id,s.now()));return current;
    }
    if(current.revision!==body.revision)throw conflict('conversation_revision_conflict','This conversation changed. Refresh before editing it.');
    if(current.owner_user_id&&current.owner_user_id!==ctx.userId&&!manageCalls(ctx))throw forbidden('conversation_owner_required','Only the owner or a manager can change this conversation.');
    const next={...current,status:body.action==='resolve'?'closed':body.action==='reopen'?'open':current.status,
      owner_user_id:body.action==='assign'?body.owner_user_id:current.owner_user_id,snoozed_until:body.action==='snooze'?body.snoozed_until:['resolve','reopen','unsnooze'].includes(body.action)?'':current.snoozed_until,revision:Number(current.revision)+1};
    (await db.prepare("INSERT INTO customer_communication_workflow(organization_id,kind,source_id,owner_user_id,status,snoozed_until,revision,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,kind,source_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,status=excluded.status,snoozed_until=excluded.snoozed_until,revision=excluded.revision,updated_at=excluded.updated_at")
      .run(ctx.orgId,body.kind,body.source_id,s.text(next.owner_user_id),s.text(next.status),s.text(next.snoozed_until),next.revision,s.now()));
    (await s.appendEvent(ctx.orgId,body.kind==='call'?body.source_id:'',`communication.workflow.${body.action}`,{source_id:body.source_id,actor_user_id:ctx.userId,owner_user_id:next.owner_user_id}));return next;
  }));
}
