import type { FastifyPluginAsync } from "fastify";
import { PlatformError } from "../../platform/errors.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { ensureCallList, listCallLists, removeCallListEntry, upsertCallListEntry } from "./call_lists.js";
import { createCall, queues as communicationsQueues, readEntry as readCallEntry } from "../../comms/calls/service.js";
import { digest, text as callText, object as callObject } from "../../comms/calls/storage.js";
import * as customerCalls from "../../comms/calls/storage.js";
import { processOneJob } from "../../comms/calls/worker.js";
function asObject(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function param(value: unknown, key: string) { return String(asObject(value)[key] || ""); }
/** Platform routes retain legacy URLs but run on shared storage on every web replica. */
export const registerPlatformCallListApi: FastifyPluginAsync = async app => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message });
    request.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error" });
  });
  app.addHook("preHandler", async request => {
    const administrative = request.method !== "GET" && !/(queue|disposition)$/.test(request.routeOptions.url || "");
    await requirePlatformAuth(request, { orgId: param(request.params, "orgId"), csrf: request.method !== "GET", capability: "apps.comms",
      permission: administrative ? "manage_communications|manage_company_settings" : "view_comms|view_projects|manage_projects|manage_company_settings" });
  });
  app.get("/organizations/:orgId/call-lists", async (request) => (await listCallLists(param(request.params, "orgId"))));

  app.post("/organizations/:orgId/call-lists", async (request, reply) => {
    const callList = await ensureCallList(param(request.params, "orgId"), asObject(request.body));
    reply.code(201);
    return { ok: true, success: true, call_list: callList };
  });

  app.post("/organizations/:orgId/call-lists/queue", async (request) => communicationsQueues(await requirePlatformAuth(request,{orgId:param(request.params,'orgId')})));

  app.post("/organizations/:orgId/call-lists/:listKey/entries", async (request, reply) => {
    const entry = await upsertCallListEntry(param(request.params, "orgId"), param(request.params, "listKey"), asObject(request.body));
    reply.code(201);
    return { ok: true, success: true, entry };
  });

  app.delete("/organizations/:orgId/call-lists/:listKey/entries/:entryId", async (request) => (await removeCallListEntry(param(request.params, "orgId"), { entry_id: param(request.params, "entryId") })));

  app.post("/organizations/:orgId/call-list-entries/:entryId/disposition", async (request, reply) => {
    const ctx=await requirePlatformAuth(request,{orgId:param(request.params,'orgId'),csrf:true,permission:'make_calls|send_comms|manage_projects|manage_company_settings'});
    const body=asObject(request.body),entryId=param(request.params,'entryId');
    if(body.disposition==='skipped'){await readCallEntry(ctx,entryId);return {ok:true,success:true,skipped:true};}
    const operation=callText(body.operation_id)||`legacy:${digest({entryId,body,actor:ctx.userId})}`;
    const call=await createCall(ctx,{entry_id:entryId,operation_id:operation,mode:'external'});
    await customerCalls.transaction(async ()=>{
      const legacy={...body,actor_user_id:ctx.userId,actor_email:callText(ctx.user.email||ctx.identity.email),actor_name:callText(ctx.user.name||ctx.identity.name),branch_id:call.branch_id};
      const op=await customerCalls.operation(ctx.orgId,'legacy-wrap',operation,call.id,legacy);
      if(op.existing)return;
      await customerCalls.patchCall(ctx.orgId,call.id,{state:'ended',ended_at:customerCalls.now(),notes:callText(body.note_text),wrap_up_state:'processing_effects'});
      await customerCalls.enqueue(ctx.orgId,call.id,'wrap_up',{operation_id:op.id,legacy_disposition:legacy},`${op.id}:effects`);
      await customerCalls.releaseClaims(ctx.orgId,call.id);
    });
    await processOneJob(`legacy:${request.id}`,'background',call.id);
    const current=await customerCalls.readCall(ctx.orgId,call.id),response=callObject(current.metadata.legacy_response);
    const failed=(await customerCalls.jobs(ctx.orgId,call.id)).find(job=>job.state==='failed');
    if(failed)throw new PlatformError('call_outcome_invalid',400,callText(failed.error));
    reply.code(current.wrap_up_state==='saved'?201:202);
    return {ok:true,success:true,...response,call:current};
  });

};
