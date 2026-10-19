import type { PlatformAuthContext } from "../platform/auth.js";
import { hasResourcePermission } from "../workforce/department-access.js";
import { readPlanRecord, readNodeRecord } from "../work/storage.js";
import { workEventDefinition } from "../work/events.js";

type Obj = Record<string, any>;
const contexts = new WeakMap<PlatformAuthContext, {plans:Map<string,Promise<Obj|null>>;nodes:Map<string,Promise<Obj|null>>}>();
// Presentation is resolved only after the Feed source has been authorized.
// Never return scope definitions, task metadata, or arbitrary event payloads.
export async function feedEventPresentation(ctx: PlatformAuthContext, event: Obj) {
  const definition = workEventDefinition(String(event.type || ""));
  let cache=contexts.get(ctx);
  if (!cache) {cache={plans:new Map(),nodes:new Map()};contexts.set(ctx,cache);}
  const planId=String(event.plan_id || ''),nodeId=String(event.node_id || '');
  if (planId && !cache.plans.has(planId)) cache.plans.set(planId,readPlanRecord(ctx.orgId,planId));
  if (nodeId && !cache.nodes.has(nodeId)) cache.nodes.set(nodeId,readNodeRecord(ctx.orgId,nodeId));
  const [plan,node]=await Promise.all([cache.plans.get(planId) || null,cache.nodes.get(nodeId) || null]);
  const permitted = (resource: Obj | null) => resource && resource.project_id === event.project_id && hasResourcePermission(ctx, "view_projects", resource);
  return {
    description: definition.description,
    group: definition.notification.group,
    ...(permitted(plan) ? { scope_title: String(plan!.title || "") } : {}),
    ...(permitted(node) ? { node_title: String(node!.title || "") } : {})
  };
}
