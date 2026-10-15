import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { readMaterialsLedger, materialsCommand } from "./calculus.js";
import { ensureMaterialListScheduleEvent, retireUnscheduledWholeListEvent, scopeDeliveryParts } from './storage.js';
import { z } from 'zod';
import { conflict, notFound } from '../platform/errors.js';

export function registerCalculusApi(app: FastifyInstance) {
  const route = "/organizations/:orgId/projects/:projectId/calculus";
  app.get(route, async request => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const auth = await requirePlatformAuth(request, { orgId, permission: "view_materials" });
    return { ledger: await readMaterialsLedger(userPublicationContext(auth, { projectId }), projectId) };
  });
  app.post(`${route}/commands`, async request => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const auth = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    return materialsCommand(userPublicationContext(auth, { projectId }), projectId, request.body);
  });
  app.post(`${route}/sets/:setId/schedule`, async request => {
    const {orgId,projectId,setId}=request.params as {orgId:string;projectId:string;setId:string};
    const auth=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_projects'});
    const ctx=userPublicationContext(auth,{projectId});
    const input=z.object({expected_revision:z.number().int().nonnegative(),event:z.record(z.unknown()).optional()}).strict().parse(request.body);
    const ledger=await readMaterialsLedger(ctx,projectId), set=ledger.sets.find(s=>s.id===setId);
    if(!set)throw notFound('material_set_missing','Material set not found.');
    if(set.revision!==input.expected_revision)throw conflict('material_set_revision','Materials changed. Refresh before scheduling.');
    const projected={...set.presentation,id:set.id,project_id:projectId,title:set.title,resource_type:'material',origin:set.origin,definition:{key:(set as {definition?:{key?:string}}).definition?.key},current_items:set.lines,status:set.lines.length&&set.lines.every(l=>l.balance.outstanding===0)?'ordered':'planning'};
    // A set whose scope delivers in parts (dry-in, then shingles) is one delivery per part, each placed in the job;
    // its single delivery is taken off once split, if it was never scheduled (docs/architecture/schedule-events.md).
    const parts=await scopeDeliveryParts(orgId,projectId,projected,set.lines as unknown as Record<string,unknown>[]);
    if(parts.length){
      const events=[];
      for(const part of parts)events.push(await ensureMaterialListScheduleEvent(orgId,set.id,{part_id:part.part_id,schedule:part.schedule,event:{...(input.event||{}),title:part.title,list_part_id:part.part_id,...(part.schedule.kind?{kind:part.schedule.kind}:{}),...(part.schedule.icon?{icon:part.schedule.icon}:{})}},{...projected,scope_piece_id:part.scope_piece_id,scope_template_id:part.scope_template_id}));
      await retireUnscheduledWholeListEvent(orgId,projectId,set.id);
      return {event:events[0],events,parts:parts.map(part=>({part_id:part.part_id,title:part.title,line_ids:part.line_ids}))};
    }
    const event=await ensureMaterialListScheduleEvent(orgId,set.id,{event:input.event},projected);
    return {event};
  });
}
