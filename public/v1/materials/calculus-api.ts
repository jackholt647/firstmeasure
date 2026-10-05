import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { readMaterialsLedger, materialsCommand } from "./calculus.js";
import { ensureMaterialListScheduleEvent } from './storage.js';
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
    const event=await ensureMaterialListScheduleEvent(orgId,set.id,{event:input.event},{...set.presentation,id:set.id,project_id:projectId,title:set.title,resource_type:'material',current_items:set.lines,status:set.lines.length&&set.lines.every(l=>l.balance.outstanding===0)?'ordered':'planning'});
    return {event};
  });
}
