import { randomUUID } from "node:crypto";
import type { JsonObject } from "../platform/storage.js";
import { badRequest } from "../platform/errors.js";
import { buildScopeEventMap, eventWords } from "./event-map.js";

type Pointer = (string | number)[];
const obj = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const arr = (v: unknown): JsonObject[] => Array.isArray(v) ? v.map(obj) : [];
const str = (v: unknown) => String(v ?? "").trim();
const key = (path: Pointer) => path.map(String).join("/");
export const SCOPE_ARTIFACT_TYPES = ["todos", "checklists", "documents", "materials", "events", "notifications", "communications", "resources", "fields", "calls", "transitions", "workflows", "portal", "payments", "other"];
const editable: Record<string, string[]> = {
  todos:["title", "description", "message", "priority", "due_offset_minutes", "assigned_role_ids", "assigned_user_ids", "assigned_resource_group_ids", "depends_on", "show_in_todo_list"],
  checklists:["title", "description", "kind", "audience", "crew_editable", "items", "customer_access", "assignment_policy"],
  documents:["title", "template_id", "document_type", "workflow_id", "deliver", "params"],
  materials:["title", "color", "selector", "order_source_ids", "items"],
  resources:["title", "color", "items", "compensation", "controls", "selector"],
  events:["title", "event_type_default_id", "kind", "enabled", "rule", "depends_on", "confirmation", "customer_scheduling"],
  notifications:["title", "body", "defaults", "kind", "target_role_ids", "target_user_ids", "celebration", "frontend_action"],
  communications:["to", "subject", "text", "html", "recipients"],
  fields:["label", "description", "required", "enabled", "default_value", "default_from", "ui"],
  calls:["title", "list", "priority"], transitions:["template_id", "instance_key"], payments:[], other:[]
};
export type ScopeArtifact = {
  id:string; type:string; title:string; description:string; config:JsonObject; source_path:Pointer | null;
  editable_fields:string[]; origin:string; timing:string; enabled:boolean; node_id:string;
  triggers:JsonObject[]; rule_ids:string[]; notes:string[]; related_ids:string[];
  edit_targets?: { id:string; location:string; path:Pointer; config:JsonObject }[];
};

// Catalogs are projections only. Each editable item points into the original
// definition, so the artifact view and automation view cannot diverge.
export function buildScopeArtifactMap(definition: JsonObject, rules: JsonObject[] = [], portalPages: JsonObject[] = []) {
  const map = buildScopeEventMap(definition, rules);
  const allConnections:JsonObject[] = map.events.flatMap((event) => event.connections.map((c) => ({ ...c, event:event.name, event_label:event.label })));
  const primary = allConnections.filter((c) => !c.potential);
  const artifacts: ScopeArtifact[] = [];
  const nodes = new Map<string, { node:JsonObject; path:Pointer; location:string }>();
  const nodeWalk = (values: unknown, path:Pointer, parents:string[]) => arr(values).forEach((node, i) => {
    const pointer = [...path, i];
    nodes.set(str(node.id), { node, path:pointer, location:[...parents, str(node.title)].join(" / ") });
    nodeWalk(node.children, [...pointer, "children"], [...parents, str(node.title)]);
  });
  nodeWalk(obj(definition.work_plan).root_nodes, ["work_plan", "root_nodes"], []);
  const triggersFor = (ids:string[]) => allConnections.filter((c) => ids.includes(str(c.canonical_id))).map((c) => ({
    event:c.event, label:c.event_label, rule_id:c.id, canonical_id:c.canonical_id, when:c.when, conditions:c.conditions, input:c.input, location:c.location,
    enabled:c.enabled, source:c.source, potential:c.potential === true
  }));
  const add = (type:string, config:JsonObject, path:Pointer | null, extra:Partial<ScopeArtifact> = {}) => {
    const artifact:ScopeArtifact = { id:`${type}:${path ? key(path) : artifacts.length}`, type,
      title:str(config.title || config.label || config.name || config.id) || eventWords(type), description:str(config.description || config.message || config.body),
      config, source_path:path, editable_fields:path ? editable[type] || [] : [], origin:"Scope definition", timing:"Defined by this scope",
      enabled:config.enabled !== false, node_id:"", triggers:[], rule_ids:[], notes:[], related_ids:[], ...extra };
    artifact.rule_ids = [...artifact.rule_ids];
    artifact.related_ids = [...artifact.related_ids];
    artifact.notes = [...artifact.notes];
    artifact.triggers = triggersFor(artifact.rule_ids);
    artifacts.push(artifact);
    return artifact;
  };
  const setup = (automation:string) => primary.filter((c) => c.automation === automation && c.source !== "Organization rule").map((c) => str(c.canonical_id));
  const resourceRules = [...setup("materials.initializeFromScope.v1"), ...setup("scopes.reconcileProjectResources.v1")];
  for (const [id, { node, path, location }] of nodes) {
    if (node.actionable !== true && node.show_in_todo_list !== true) continue;
    const depends = Array.isArray(node.depends_on) ? node.depends_on.map((id) => nodes.get(str(id))?.node.title || id) : [];
    add("todos", node, path, { node_id:id, origin:"Preset work item", editable_fields:editable.todos!.filter(field => field !== "message"), timing:depends.length ? `Available after ${depends.join(", ")}` : "Created with the scope; becomes available when its parent stage is active",
      rule_ids:primary.filter((c) => c.node_id === id).map((c) => str(c.canonical_id)), notes:[location, ...(node.show_in_todo_list === false ? ["Hidden from the daily to-do list; retained here because it is workflow work."] : [])] });
  }
  arr(definition.checklists).forEach((list, i) => add("checklists", list, ["checklists", i], { timing:"Initialized when the scope starts; checklist items are created together", rule_ids:setup("checklists.initializeFromScope.v1") }));
  // Runtime gives resources precedence over the legacy materials block.
  const resourceKey = Object.keys(obj(definition.resources)).length ? "resources" : "materials";
  const resources = obj(definition[resourceKey]);
  arr(resources.lists).forEach((list, i) => {
    const path:Pointer = [resourceKey, "lists", i];
    const type = str(list.resource_type || "material");
    const resource = add(type === "material" ? "materials" : "resources", list, path, {
      timing:"Generated from the signed scope's items and measurements; reconciled at configured milestones", rule_ids:resourceRules,
      enabled:resources.enabled !== false, notes:[`Resource type: ${type}`, `Matching policy: ${str(resources.assignment || "first_match")}`, "Quantities depend on the project's selected items and measurements."]
    });
    const schedule = obj(list.schedule);
    if (Object.keys(schedule).length) {
      const calendar = add("events", schedule, [...path, "schedule"], { title:str(schedule.title || list.title), origin:"Resource schedule", node_id:str(schedule.source_node_template_id),
        enabled:resources.enabled !== false && schedule.enabled === true,
        timing:"Added as an unscheduled calendar requirement when this resource list is generated", rule_ids:resourceRules,
        notes:["Dates are chosen in project scheduling; this is a workflow sequence, not booked dates.", ...(type === "equipment" ? ["Requires the organization's equipment scheduling capability."] : [])] });
      calendar.related_ids.push(resource.id); resource.related_ids.push(calendar.id);
    }
  });
  const fieldKey = definition.custom_fields ? "custom_fields" : "project_custom_fields";
  const fieldConfig = obj(definition[fieldKey]);
  const fieldsKey = Array.isArray(fieldConfig.fields) ? "fields" : "definitions";
  arr(fieldConfig[fieldsKey]).forEach((field, i) => add("fields", field, [fieldKey, fieldsKey, i], { title:str(field.label || field.path), timing:"Added to the project when the scope starts; defaults fill empty values", rule_ids:setup("customFields.initializeFromScope.v1") }));
  if (Object.keys(obj(obj(definition.communications).email_forwarding)).length) add("communications", obj(obj(definition.communications).email_forwarding), ["communications", "email_forwarding"], {
    title:"Project email forwarding", timing:"Configured when the scope starts", editable_fields:["enabled", "target", "priority"], rule_ids:setup("customFields.initializeFromScope.v1")
  });
  const visit = obj(obj(definition.metadata).visit_workflow);
  if (Object.keys(visit).length) {
    const workflow = add("workflows", visit, ["metadata", "visit_workflow"], { editable_fields:["title", "enabled", "steps"], origin:"Guided field visit", timing:"Available on the configured appointment types", notes:[`Appointment types: ${Array.isArray(visit.event_types) ? visit.event_types.join(", ") : "Defined by visit settings"}`] });
    arr(visit.steps).forEach((step, i) => {
      const notify = obj(obj(step.action).notify);
      if (Object.keys(notify).length) {
        const message = add("communications", notify, ["metadata", "visit_workflow", "steps", i, "action", "notify"], {
          title:`${str(step.title)} message`, origin:"Visit step", editable_fields:["message", "channel"], timing:`When someone chooses “${str(obj(step.action).label || step.title)}” during the visit`,
          enabled:visit.enabled !== false, notes:["Invoked by the field visit action, rather than a work-engine event binding.", ...(step.when ? [`Step condition: ${JSON.stringify(step.when)}`] : [])]
        });
        message.related_ids.push(workflow.id); workflow.related_ids.push(message.id);
      }
    });
  }
  const documents = new Map<string, ScopeArtifact>();
  const document = (reference:string, referenceType:string, connection:JsonObject, config:JsonObject = {}, path:Pointer | null = null) => {
    if (!reference) return;
    const id = `documents:${referenceType}:${reference}`;
    let artifact = documents.get(id);
    if (!artifact) {
      artifact = add("documents", { [referenceType]:reference, ...config }, path, { id, title:str(config.title) || eventWords(reference.replace(/^tpl_/, "")), node_id:str(connection.node_id), origin:"Referenced document", timing:"Used only at the linked workflow steps", rule_ids:[], notes:[`${eventWords(referenceType)}: ${reference}`, ...(reference.includes("{{") ? ["The exact document is resolved from project data at runtime."] : [])] });
      documents.set(id, artifact);
    } else if (path && !artifact.source_path) { artifact.source_path = path; artifact.config = { [referenceType]:reference, ...config }; artifact.editable_fields = editable.documents!; artifact.title = str(config.title) || artifact.title; }
    if (path) {
      artifact.edit_targets ||= [];
      artifact.edit_targets.push({ id:str(connection.canonical_id), location:str(connection.location), path, config });
    }
    const ruleId = str(connection.canonical_id);
    if (ruleId && !artifact.rule_ids.includes(ruleId)) artifact.rule_ids.push(ruleId);
    return artifact;
  };
  const knownSetup = new Set(["materials.initializeFromScope.v1", "checklists.initializeFromScope.v1", "customFields.initializeFromScope.v1", "scopes.reconcileProjectResources.v1"]);
  for (const connection of primary) {
    const input = obj(connection.input);
    const path = Array.isArray(connection.source_path) ? [...connection.source_path, "input"] as Pointer : null;
    const automation = str(connection.automation);
    const extras:Partial<ScopeArtifact> = { origin:str(connection.source), timing:str(connection.when), node_id:str(connection.node_id), rule_ids:[str(connection.canonical_id)], enabled:connection.enabled !== false };
    // Shared org policy is shown in Automations, but is not evidence that this
    // scope explicitly uses every document or artifact in that policy.
    if (connection.source === "Organization rule") continue;
    if (automation === "work.createTodo.v1") {
      const todo = add("todos", input, path, { ...extras, origin:"Created by automation", notes:[str(connection.label)] });
      todo.editable_fields = editable.todos!.filter((field) => !["depends_on", "show_in_todo_list", "description"].includes(field));
    } else if (automation === "documents.issue.v1" || automation === "completion.request.v1") {
      const templateId = str(input.template_id) || (automation === "completion.request.v1" ? "tpl_roofing_completion_certificate" : "");
      document(templateId || str(input.document_type), templateId ? "template_id" : "document_type", connection, input, path);
    } else if (automation === "scheduling.createRequirements.v1") {
      arr(input.requirements).forEach((item, i) => add("events", item, path ? [...path, "requirements", i] : null, extras));
    } else if (automation.startsWith("scheduling.create")) {
      add("events", input, path, { ...extras, title:str(input.title) || eventWords(input.event_type_default_id || "Project work"), notes:[automation === "scheduling.createPerStructure.v1" ? "Creates one calendar requirement per structure in the signed scope." : "Creates an unscheduled requirement; dates are assigned later."] });
    } else if (automation === "notification.create.v1") add("notifications", input, path, extras);
    else if (automation.startsWith("communications.send")) add("communications", input, path, { ...extras, title:str(input.subject) || (automation.includes("Sms") ? "Text message" : "Email"), notes:[automation] });
    else if (automation === "crm.callLists.add.v1") add("calls", input, path, { ...extras, title:str(obj(input.list).title || input.title || input.list_key), notes:["Completing the linked work item can remove its call-queue entry."] });
    else if (automation === "crm.callLists.remove.v1") add("calls", input, path, { ...extras, title:"Remove pending call", editable_fields:[], notes:["Removes the call associated with this work item."] });
    else if (automation.startsWith("scopes.activate")) add("transitions", input, path, { ...extras, title:input.template_id ? `Activate ${eventWords(input.template_id)}` : "Activate signed proposal scopes", notes:["The activated scope has its own artifacts and workflow."] });
    else if (automation === "project.patch.v1") add("fields", input, path, { ...extras, title:"Update project fields", editable_fields:["values"], description:"Writes these project values when the linked rule runs." });
    else if (automation.startsWith("payroll.") || automation.startsWith("payments.")) add("payments", input, null, { ...extras, title:str(connection.label), description:str(connection.description), notes:["Commission settings remain editable in Commissions."] });
    else if (automation === "punchlist.request.v1") add("checklists", input, path, { ...extras, title:str(input.title) || "Customer punch list", editable_fields:["title", "description", "config", "labels"], notes:["Items are supplied by the customer after the request; they are not preset checklist items."] });
    else if (automation === "feedback.requestReview.v1") add("communications", input, path, { ...extras, title:"Customer feedback request", editable_fields:["channels", "message"], notes:["Uses organization feedback settings for delivery and review destinations."] });
    else if (automation && !knownSetup.has(automation)) add("other", input, path, { ...extras, title:str(connection.label), description:str(connection.description), editable_fields:[], notes:[automation, "This function can have runtime-dependent effects. Its outputs are not inferred from arbitrary code."] });

    if (str(connection.event).startsWith("document.")) for (const [field, value] of Object.entries(obj(connection.conditions))) {
      const type = field.split(".").pop();
      if (["template_id", "document_type", "document_id"].includes(type || "")) for (const reference of Array.isArray(value) ? value : [value]) document(str(reference), type!, connection);
    }
    const calendarType = obj(connection.conditions)["payload.event_type_default_id"];
    for (const type of Array.isArray(calendarType) ? calendarType : [calendarType]) if (type) {
      const existing = artifacts.filter((artifact) => artifact.type === "events" && artifact.config.event_type_default_id === type);
      if (existing.length) existing.forEach((artifact) => { if (!artifact.rule_ids.includes(str(connection.canonical_id))) artifact.rule_ids.push(str(connection.canonical_id)); });
      else add("events", { event_type_default_id:type }, null, { ...extras, title:eventWords(type), origin:"Referenced calendar event", timing:"This scope reacts to this event type; it does not declare how the event is created", notes:["Reference only. This entry does not create an appointment."] });
    }
  }
  // Match document references in to-do metadata and template-authored frontend
  // actions, without treating an unrelated scope template ID as a document.
  for (const artifact of artifacts.filter((a) => a.type === "todos")) {
    const scan = (value:unknown) => {
      if (Array.isArray(value)) { value.forEach(scan); return; }
      const object = obj(value);
      for (const [field, ref] of Object.entries(object)) {
        if (["document_template_id", "document_id", "document_type"].includes(field) && typeof ref === "string") {
          const doc = document(ref, field === "document_template_id" ? "template_id" : field, { node_id:artifact.node_id });
          if (doc) { doc.related_ids.push(artifact.id); artifact.related_ids.push(doc.id); }
        } else if (ref && typeof ref === "object") scan(ref);
      }
    };
    scan(artifact.config.metadata);
  }
  // Customer Portal is a projection across artifacts and inbound page references.
  // Its entries link to the canonical settings instead of maintaining a second copy.
  for (const source of [...artifacts]) {
    let config:JsonObject | null = null;
    let enabled = source.enabled;
    let timing = source.timing;
    if (source.type === "checklists") {
      const requestedPunch = primary.some(c => c.automation === "punchlist.request.v1" && source.rule_ids.includes(str(c.canonical_id)));
      const access = requestedPunch ? { visible:true, can_complete:true, ...obj(source.config.customer_access) } : obj(source.config.customer_access);
      config = { portal_kind:"checklist", access, source_view:"checklists" };
      enabled = enabled && access.visible === true;
      timing = access.visible === true ? source.timing : "Hidden from customers until customer visibility is enabled";
    } else if (source.type === "documents") {
      config = { portal_kind:"document", document:source.config, source_view:"documents" };
      timing = source.config.deliver === "portal" ? "Delivered to the customer portal when the linked issuance rule runs" : "Referenced by this scope; portal availability depends on document delivery and workflow settings";
    } else if (source.type === "events" && Object.keys(obj(source.config.customer_scheduling)).length) {
      config = { portal_kind:"scheduling", policy:source.config.customer_scheduling, source_view:"events" };
      timing = "Appointment-specific customer scheduling policy overrides scope defaults";
    }
    if (config) {
      const entry=add("portal", config, null, { id:`portal:${source.id}`, title:source.title, origin:"Customer access", enabled, timing, rule_ids:source.rule_ids, related_ids:[source.id], notes:source.notes });
      source.related_ids.push(entry.id);
    }
  }
  add("portal", { portal_kind:"scheduling", policy:obj(definition.customer_scheduling), source_view:"scheduling" }, null, {
    id:"portal:scheduling-defaults", title:"Customer appointment changes", origin:"Scope defaults",
    timing:"Applied to appointments associated with this scope; appointment settings can override these defaults",
    notes:["Organization capabilities and scheduling settings also apply. Missing values inherit the scheduling defaults."]
  });
  arr(visit.steps).forEach((step,i)=>arr(step.actions).forEach((action,j)=>{
    if (obj(action.effect).kind !== "send_workflow_to_portal") return;
    const workflow=artifacts.find(a=>a.type==="workflows");
    add("portal", { portal_kind:"handoff", source_view:"workflows", effect:action.effect, conditions:step.when || {}, step:step.title }, null, {
      id:`portal:visit:${i}:${j}`, title:str(action.label) || "Send workflow to customer portal", origin:"Visit action",
      timing:`When a field user chooses this action in “${str(step.title)}”`, enabled:visit.enabled !== false,
      related_ids:workflow ? [workflow.id] : []
    });
  }));
  for (const page of portalPages) {
    const audience=obj(page.audience);
    if (!Array.isArray(audience.scope_template_ids) || !audience.scope_template_ids.includes(definition.id)) continue;
    add("portal", { portal_kind:"page", page_id:page.id, site_id:page.website_id, audience, published_version:page.published_version, in_navigation:obj(page.nav).header === true, path:page.path || page.slug }, null, {
      id:`portal:page:${page.id}`, title:str(page.title || page.name || page.slug || page.id), origin:"Portal page targeting",
      enabled:page.enabled === true && Number(page.published_version) > 0 && page.site_active !== false,
      timing:audience.match === "all" ? "Shown when this scope and every other configured audience dimension match" : "This scope satisfies the page audience; other audience dimensions can also qualify a project",
      notes:["This rule lives on the portal page. Published and enabled pages appear for matching projects; this is not a live customer preview."]
    });
  }
  for (const artifact of artifacts) {
    // Follow an external transition into the lifecycle binding that creates
    // an artifact (e.g. delivery received -> work item completed -> to-do).
    const causes = primary.filter(c => artifact.rule_ids.includes(str(c.canonical_id)) && c.kind === "action");
    for (const cause of causes) for (const upstream of primary.filter(c => c.kind === "transition" && c.node_id === cause.node_id && c.next_event === cause.event)) {
      if (!artifact.rule_ids.includes(str(upstream.canonical_id))) artifact.rule_ids.push(str(upstream.canonical_id));
    }
    artifact.triggers = triggersFor(artifact.rule_ids);
    if (artifact.origin !== "Preset work item" && artifact.triggers.length && artifact.triggers.every(t => !t.enabled)) artifact.enabled = false;
  }
  for (const artifact of artifacts) {
    artifact.related_ids = [...new Set([...artifact.related_ids, ...artifacts.filter((other) => other.id !== artifact.id && (
      artifact.rule_ids.some((id) => other.rule_ids.includes(id)) || artifact.node_id && artifact.node_id !== "plan" && other.node_id === artifact.node_id
    )).map((other) => other.id)])];
  }
  for (const event of map.events) for (const connection of event.connections) {
    connection.artifacts = artifacts.filter((a) => a.rule_ids.includes(str(connection.canonical_id))).map((a) => ({ id:a.id, type:a.type, title:a.title }));
  }
  return { ...map, artifacts, counts:Object.fromEntries(SCOPE_ARTIFACT_TYPES.map((type) => [type, artifacts.filter((a) => a.type === type).length])) };
}

export function patchScopeArtifact(definition:JsonObject, artifactId:string, changes:JsonObject, usageId?:string) {
  const artifact = buildScopeArtifactMap(definition).artifacts.find((item) => item.id === artifactId);
  if (!artifact?.source_path || !artifact.editable_fields.length) throw badRequest("scope_artifact_read_only", "This artifact is derived. Edit its source rule or scope settings.");
  if (!Object.keys(changes).length || Object.keys(changes).some((field) => !artifact.editable_fields.includes(field))) throw badRequest("invalid_artifact_field", "Only this artifact's editable fields may be changed.");
  validateArtifactValues(changes);
  const usage = usageId ? artifact.edit_targets?.find(item => item.id === usageId) : null;
  if (usageId && !usage) throw badRequest("invalid_document_usage", "This document invocation no longer exists.");
  const clone = JSON.parse(JSON.stringify(definition)) as JsonObject;
  let target: any = clone;
  for (const segment of usage?.path || artifact.source_path) target = target[segment];
  for (const [field, value] of Object.entries(changes)) target[field] = value;
  return clone;
}

export function createScopeArtifact(definition:JsonObject, type:string, config:JsonObject, trigger:JsonObject) {
  validateArtifactValues(config);
  if (trigger.conditions != null && (!trigger.conditions || typeof trigger.conditions !== "object" || Array.isArray(trigger.conditions))) throw badRequest("invalid_artifact_conditions", "Conditions must be a JSON object of field comparisons.");
  if (["todos", "checklists", "events", "notifications"].includes(type) && !str(config.title)) throw badRequest("artifact_title_required", "Give this artifact a title.");
  if (type === "documents" && !str(config.template_id || config.document_type)) throw badRequest("document_reference_required", "Choose a document template ID or type.");
  if (type === "events" && !str(config.event_type_default_id)) throw badRequest("calendar_type_required", "Choose a calendar event type.");
  if (type === "transitions" && !str(config.template_id)) throw badRequest("scope_reference_required", "Choose a scope template ID.");
  if (type === "calls" && !str(obj(config.list).key || config.list_key)) throw badRequest("call_queue_key_required", "Give the call queue a stable key.");
  const clone = JSON.parse(JSON.stringify(definition)) as JsonObject;
  const plan = obj(clone.work_plan);
  const id = `scope_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (type === "checklists") {
    clone.checklists = [...arr(clone.checklists), { title:"New checklist", kind:"todo", audience:"crew", items:[], ...config, id }];
    return clone;
  }
  const action:Record<string,string> = { todos:"work.createTodo.v1", documents:"documents.issue.v1", events:"scheduling.createRequirement.v1", notifications:"notification.create.v1", communications:"communications.sendEmail.v1", calls:"crm.callLists.add.v1", transitions:"scopes.activateTemplate.v1" };
  if (!action[type]) throw badRequest("unsupported_artifact_creation", "Create this kind through its scope definition.");
  const hook = str(trigger.hook || "onStarted");
  if (!["onStarted", "onReady", "onCompleted", "onSkipped", "onCanceled", "onTimer"].includes(hook)) throw badRequest("invalid_artifact_trigger", "Choose a supported lifecycle trigger.");
  let target = plan;
  const nodeId = str(trigger.node_id);
  if (nodeId && nodeId !== "plan") {
    let found:JsonObject | undefined;
    const find = (values:unknown) => arr(values).forEach((node) => { if (node.id === nodeId) found = node; find(node.children); });
    find(plan.root_nodes);
    if (!found) throw badRequest("invalid_artifact_node", "The work item no longer exists.");
    target = found;
  } else if (!["onStarted", "onCompleted"].includes(hook)) throw badRequest("invalid_artifact_trigger", "Choose scope start or completion, or select a work item.");
  target.automation_bindings = { ...obj(target.automation_bindings), [hook]:[...arr(obj(target.automation_bindings)[hook]), { id, automation:action[type], input:config, conditions:obj(trigger.conditions) }] };
  return clone;
}

function validateArtifactValues(values:JsonObject) {
  if(values.defaults!==undefined){const defaults=obj(values.defaults);if(Object.keys(defaults).some(k=>!["in_app","push"].includes(k)||typeof defaults[k]!=="boolean"))throw badRequest("invalid_notification_defaults","Notification defaults must be in_app and push booleans.");}
  for (const [field, value] of Object.entries(values)) {
    if (["title", "label"].includes(field) && (typeof value !== "string" || !value.trim() || value.length > 300)) throw badRequest("invalid_artifact_title", "Titles must contain 1–300 characters.");
    if (["priority", "due_offset_minutes"].includes(field) && (!Number.isInteger(value) || Number(value) < 0)) throw badRequest("invalid_artifact_number", `${eventWords(field)} must be a non-negative whole number.`);
    if (["assigned_role_ids", "assigned_user_ids", "assigned_resource_group_ids", "target_role_ids", "target_user_ids", "depends_on", "order_source_ids", "items"].includes(field) && !Array.isArray(value)) throw badRequest("invalid_artifact_list", `${eventWords(field)} must be a list.`);
    if (["enabled", "required", "show_in_todo_list", "crew_editable"].includes(field) && typeof value !== "boolean") throw badRequest("invalid_artifact_boolean", `${eventWords(field)} must be on or off.`);
    if (["params", "selector", "rule", "values", "ui", "default_from", "compensation", "controls", "customer_access", "customer_scheduling", "confirmation", "assignment_policy", "celebration", "defaults", "frontend_action", "list", "target", "config", "labels"].includes(field) && (!value || typeof value !== "object" || Array.isArray(value))) throw badRequest("invalid_artifact_object", `${eventWords(field)} must be a JSON object.`);
  }
}
