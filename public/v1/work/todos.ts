import type { PlatformAuthContext } from "../platform/auth.js";
import { createWorkPlan, patchWorkNode } from "./service.js";
import { createFollowUpTodo } from "./followups.js";
function asArray(value: unknown) { return Array.isArray(value) ? value : []; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function cleanText(value: unknown) { return String(value ?? "").trim(); }
// Accepts either an explicit contact_refs array or flat contact_* fields and
// returns the normalized metadata.contact_refs entries stored on the node.
function normalizeTodoContactRefs(body: Record<string, unknown>) {
  const raw = asArray(body.contact_refs).map(asObject);
  const flat = {
    contact_id: cleanText(body.contact_id),
    name: cleanText(body.contact_name),
    email: cleanText(body.contact_email).toLowerCase(),
    phone: cleanText(body.contact_phone)
  };
  if (flat.contact_id || flat.name || flat.email || flat.phone) raw.unshift(flat);
  const seen = new Set<string>();
  const refs: Record<string, string>[] = [];
  for (const entry of raw) {
    const ref = {
      contact_id: cleanText(entry.contact_id || entry.id),
      name: cleanText(entry.name),
      email: cleanText(entry.email).toLowerCase(),
      phone: cleanText(entry.phone)
    };
    if (!ref.contact_id && !ref.name && !ref.email && !ref.phone) continue;
    const key = ref.contact_id || `${ref.email}|${ref.phone}|${ref.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.slice(0, 8);
}

export async function createTodo(orgId: string, body: Record<string, unknown>, ctx: PlatformAuthContext) {
    const projectId = String(body.project_id || (Array.isArray(body.project_ids) ? body.project_ids[0] : "") || "").trim();
    const id = String(body.id || `manual_todo_${Date.now().toString(36)}`).trim();
    const contactRefs = normalizeTodoContactRefs(body);
    if (String(body.kind || "").trim() === "follow_up") {
      const result = await createFollowUpTodo(orgId, {
        ...body,
        id,
        project_id: projectId,
        branch_id: String(body.branch_id || ctx.branchId || "default"),
        assigned_user_ids: Array.isArray(body.assigned_user_ids) ? body.assigned_user_ids : [ctx.userId]
      });
      return { created: result.created, todo: result.node, plan: result.plan };
    }
    const result = await createWorkPlan({
      organization_id: orgId,
      branch_id: String(body.branch_id || ctx.branchId || "default"),
      project_id: projectId,
      source_type: "manual_todo",
      source_id: id,
      source_key: `manual_todo:${id}`,
      title: String(body.title || "To-do"),
      root_nodes: [{
        id: "task",
        title: String(body.title || "To-do"),
        description: String(body.body || body.description || ""),
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        // New to-dos default to unassigned ("everybody" on the desktop);
        // callers opt into user or role assignment explicitly.
        assigned_user_ids: Array.isArray(body.assigned_user_ids) ? body.assigned_user_ids : [],
        assigned_role_ids: Array.isArray(body.assigned_role_ids) ? body.assigned_role_ids : [],
        assigned_resource_group_ids: Array.isArray(body.assigned_resource_group_ids) ? body.assigned_resource_group_ids : [],
        priority: Math.max(0, Math.round(Number(body.priority) || 0)),
        // A dated to-do notifies its assignees (or the creator) when it comes
        // due; undated to-dos stay purely presentational.
        automation_bindings: body.due_at ? {
          onDue: [{
            id: "due_notification",
            automation: "notification.create.v1",
            input: {
              id: `notification_due_${id}`,
              title: `To-do due: ${String(body.title || "To-do")}`,
              body: String(body.body || body.description || ""),
              kind: "todo_due",
              push: true,
              target_user_ids: (Array.isArray(body.assigned_user_ids) && body.assigned_user_ids.length
                ? body.assigned_user_ids
                : [ctx.userId]).map(String).filter(Boolean)
            }
          }]
        } : {},
        metadata: {
          kind: String(body.kind || "manual"),
          frontend_action: body.frontend_action || { kind: "manual" },
          payload: body.payload || {},
          project_title: body.project_title || body.context_title || "",
          project_address: body.project_address || body.context_address || "",
          ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
          ...(contactRefs.length ? { contact_refs: contactRefs } : {})
        },
        ...(body.due_at ? { due_offset_minutes: Math.round((Date.parse(String(body.due_at)) - Date.now()) / 60_000) } : {})
      }]
    });
    let todo = result.tree.root_nodes[0];
    if(todo && body.due_at)todo = (await patchWorkNode(orgId, String(todo.id), {due_at:String(body.due_at)})) || todo;
    return { created: result.created, todo, plan: result.plan };
}

