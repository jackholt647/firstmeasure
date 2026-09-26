import { readBranchModule, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { badRequest, forbidden, conflict, PlatformError } from "../platform/errors.js";
import { hasPermission } from "../platform/auth.js";
import { contentHash, jsonClone } from "../platform/publication/validation.js";
import type { PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { empty, fieldPath, fieldSchema, getValue, normalizeDefinitions, object, putValue, validateField, validatePattern, calculateFormula, type FieldEntity } from "./contracts.js";

export const valueKeys = ["custom_field_values", "custom_fields", "contact_custom_field_values"];
export async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch (e) { if ((e instanceof PlatformError && e.statusCode === 404) || (e as any)?.code === "ENOENT") return null; throw e; }
}
export async function definitions(orgId: string, branchId: string, entity: FieldEntity, record: JsonObject = {}) {
  const module = await optional(() => readBranchModule(orgId, entity === "organization" ? "default" : branchId, "custom_fields"));
  const fields = [...(Array.isArray(module?.data.fields) ? module.data.fields : []), ...(Array.isArray(module?.data.retired_fields) ? module.data.retired_fields : [])].map(object).filter(f => (f.entity || "project") === entity);
  const instance = entity === "project" ? object(record.custom_field_schema) : {};
  const combined = new Map(fields.map(f => [String(f.path || f.key), f]));
  for (const raw of Array.isArray(instance.fields) ? instance.fields : []) {
    const f = object(raw), path = String(f.path || f.key), prior = combined.get(path);
    if (prior && prior.type !== f.type) throw badRequest("custom_field_conflict", `Conflicting definition for ${path}.`);
    combined.set(path, { ...prior, ...f, entity });
  }
  // Older integrations stored variables before defining fields. Publish those
  // values in place with an inferred read-only contract; do not create records.
  const infer = (values:JsonObject, prefix = "") => {
    for (const [key,value] of Object.entries(values)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if ([...combined.keys()].some(p => p === path || path.startsWith(p + "."))) continue;
      if (value && typeof value === "object" && !Array.isArray(value) && [...combined.keys()].some(p => p.startsWith(path + "."))) infer(object(value),path);
      else combined.set(path,{entity,path,key:path,type:typeof value === "number" ? Number.isInteger(value) ? "integer" : "number" : typeof value === "boolean" ? "boolean" : typeof value === "string" ? "text" : "json",read_only:true,inferred:true,label:path});
    }
  };
  infer(valuesOf(record,entity));
  return normalizeDefinitions([...combined.values()]);
}
export function valuesOf(record: JsonObject, entity: FieldEntity): JsonObject {
  return object(entity === "contact" ? record.contact_custom_field_values || record.custom_field_values || record.custom_fields : record.custom_field_values || record.custom_fields);
}
export function applyValues(record: JsonObject, entity: FieldEntity, values: JsonObject) {
  return { ...record, custom_field_values:values, ...(entity === "contact" ? { contact_custom_field_values:values } : { custom_fields:values }) };
}

export async function prepareStoredFields(orgId:string, collection:string, incoming:JsonObject, previous:JsonObject = {}):Promise<JsonObject> {
  const entity:FieldEntity = collection === "projects" ? "project" : collection === "customers" ? "contact" : "organization";
  let data = {...incoming};
  if (collection === "projects" && Array.isArray(data.contacts)) {
    const old = Array.isArray(previous.contacts) ? previous.contacts.map(object) : [];
    data.contacts = await Promise.all(data.contacts.map(async raw => {
      const c = object(raw), prior = old.find(v => String(v.id || v.contact_id) === String(c.id || c.contact_id)) || {};
      return prepareStoredFields(orgId,"customers",c,{...prior,branch_id:data.branch_id || previous.branch_id || "default"});
    }));
  }
  const keys = entity === "contact" ? ["custom_field_values","contact_custom_field_values","custom_fields"] : ["custom_field_values","custom_fields"];
  const key = keys.find(k => Object.hasOwn(data,k));
  if (!key) return data;
  const patch = jsonClone(object(data[key])), before = valuesOf(previous,entity);
  const merge = (a:JsonObject,b:JsonObject):JsonObject => {
    const result = {...a};
    for (const [k,v] of Object.entries(b)) result[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(object(a[k]),object(v)) : v;
    return result;
  };
  const merged = merge(before,patch);
  const fields = await definitions(orgId,String(data.branch_id || previous.branch_id || "default"),entity,previous);
  for (const f of fields) { const value = getValue(patch,String(f.path)); if (value !== undefined) putValue(merged,String(f.path),value); }
  return applyValues(data,entity,merged);
}
export function applies(field: JsonObject, record: JsonObject): boolean {
  if (field.entity !== "project" || field.scope_mode !== "selected") return true;
  const tokens = [record.project_type, record.scope_template_id, record.scope_template_key, ...[record.scope,record.project_scope].flatMap(v => [object(v).id,object(v).key,object(v).name]), ...(Array.isArray(record.scopes) ? record.scopes.flatMap(v => [object(v).id,object(v).key,object(v).name]) : [])].map(v => String(v || "").toLowerCase());
  for (const scope of [record.scope,record.project_scope].map(object)) for (const rows of [scope.pieces,scope.root_items]) for (const raw of Array.isArray(rows) ? rows : []) for (const key of ["id","key","name","template_id","template_key","template_name","scope_template_id","scope_template_name"]) tokens.push(String(object(raw)[key] || "").toLowerCase());
  return (Array.isArray(field.scopes) ? field.scopes : []).some(v => tokens.includes(String(v).toLowerCase()));
}
export function canReadField(ctx: PublicationContext, f: JsonObject) {
  const permission = String(f.read_permission || (f.private === true ? "manage_company_settings" : ""));
  return !permission || !!ctx.auth && hasPermission(ctx.auth, permission);
}
export function assertFieldWrite(ctx: PublicationContext, f: JsonObject) {
  if (!canReadField(ctx, f) || f.read_only === true || f.type === "formula" || f.enabled === false || (f.write_permission && (!ctx.auth || !hasPermission(ctx.auth, String(f.write_permission))))) throw forbidden("custom_field_write_denied", `Field ${f.path} is not writable in this context.`);
}
export async function readFieldRecord(ctx: PublicationContext, target: TargetRef, entity: FieldEntity) {
  let id = entity === "project" ? target.projectId : entity === "organization" ? "values" : target.id;
  if (!id) throw badRequest("custom_field_target", "A record identity is required.");
  if (entity === "project" && target.id && target.id !== id) throw forbidden("custom_field_target", "Project identity does not match the target.");
  if (entity === "organization" && target.id && ![ctx.organizationId,"values"].includes(target.id)) throw forbidden("custom_field_target", "Organization identity does not match the target.");
  const embedded = entity === "contact" && target.scope === "project";
  const collection = entity === "project" || embedded ? "projects" : entity === "contact" ? "customers" : "organization_custom_fields";
  const row = entity === "organization" ? await optional(() => readDocument(ctx.organizationId, collection, id!)) : await readDocument(ctx.organizationId, collection, embedded ? target.projectId! : id);
  const parent = object(row?.data);
  const contacts = Array.isArray(parent.contacts) ? parent.contacts.map(object) : [];
  const contact = embedded ? contacts.find(c => String(c.id || c.contact_id) === id) : undefined;
  if (embedded && !contact) throw forbidden("custom_field_contact","Contact does not belong to this project.");
  const primaryContact = parent.workflow_state === "contact_only" && (parent.primary_contact_id === id || String(contacts[0]?.id || contacts[0]?.contact_id) === id);
  const record = embedded ? { ...contact, ...(primaryContact ? { custom_field_values:{...object(parent.contact_custom_field_values),...object(contact?.custom_field_values)}, contact_custom_field_values:{...object(parent.contact_custom_field_values),...object(contact?.custom_field_values)} } : {}), branch_id:parent.branch_id } : parent;
  const branch = entity === "organization" ? "default" : String(record.branch_id || target.branchId || ctx.branchId || "default");
  if (target.branchId && record.branch_id && target.branchId !== record.branch_id) throw forbidden("custom_field_branch", "Field target does not match the record branch.");
  const fields = await definitions(ctx.organizationId, branch, entity, record);
  return { id, collection, row, record, fields, branch, embedded, parent };
}
// Called by storage on every project/contact/organization-field write, including
// Work services. Unchanged legacy values do not block unrelated record edits.
export async function validateStoredFields(orgId: string, collection: string, incoming: JsonObject, previous: JsonObject = {}, replace = false) {
  if (collection === "projects" && Array.isArray(incoming.contacts)) {
    const oldContacts = Array.isArray(previous.contacts) ? previous.contacts.map(object) : [];
    for (const raw of incoming.contacts) {
      const contact = object(raw), old = oldContacts.find(c => String(c.id || c.contact_id) === String(contact.id || contact.contact_id)) || {};
      await validateStoredFields(orgId,"customers",{...contact,branch_id:incoming.branch_id || previous.branch_id || "default"},old,true);
    }
  }
  const entity: FieldEntity = collection === "projects" ? "project" : collection === "customers" ? "contact" : "organization";
  if (!valueKeys.some(k => k in incoming) && !("custom_field_schema" in incoming)) return;
  const next = replace ? incoming : { ...previous, ...incoming };
  const fields = await definitions(orgId, String(next.branch_id || previous.branch_id || "default"), entity, next);
  const values = valuesOf(next, entity), before = valuesOf(previous, entity);
  jsonClone(values);
  for (const f of fields) {
    if (!applies(f, next)) continue;
    const v = getValue(values,String(f.path)), old = getValue(before,String(f.path));
    if (JSON.stringify(v) === JSON.stringify(old) && Object.keys(previous).length) continue;
    validateField(f,v); await validatePattern(f,v);
  }
}
export async function readFields(ctx: PublicationContext, target: TargetRef, entity: FieldEntity, path?: string, contractOnly = false) {
  const state = await readFieldRecord(ctx,target,entity);
  const fields = state.fields.filter(f => applies(f,state.record));
  const selected = path ? fields.filter(f => f.path === fieldPath(path)) : fields.filter(f => canReadField(ctx,f));
  if (path && selected.length && !canReadField(ctx,selected[0]!)) throw forbidden("custom_field_read_denied","This field is private in the current context.");
  const values: JsonObject = {}, stored = valuesOf(state.record,entity);
  const dependencies = new Set<string>();
  const resolve = (path:string, seen = new Set<string>()):unknown => {
    if (seen.has(path) || seen.size > 32) throw badRequest("custom_field_formula_cycle","Custom field formulas contain a cycle or exceed the dependency limit.");
    const f = fields.find(f => f.path === path);
    if (!f) throw badRequest("custom_field_formula_missing",`Unknown formula field ${path}.`);
    if (!canReadField(ctx,f)) throw forbidden("custom_field_read_denied","A formula input is private in this context.");
    dependencies.add(path);
    if (f.type === "formula") return calculateFormula(String(f.formula || "0"),p => resolve(p,new Set([...seen,path])));
    const value = getValue(stored,path);
    return value === undefined && !empty(f.default_value) ? f.default_value : value;
  };
  for (const f of selected) {
    if (contractOnly) { dependencies.add(String(f.path)); continue; }
    const v = resolve(String(f.path));
    if (v !== undefined) putValue(values,String(f.path),v);
  }
  return { ...state, values, dependencies:[...dependencies], visible:selected, revision:contentHash({ revision:state.row?.revision || 0, fields, values }), contract:selected.map(f => ({ ...f, schema:fieldSchema(f), writable:f.read_only !== true && f.type !== "formula" && f.enabled !== false && (!f.write_permission || !!ctx.auth && hasPermission(ctx.auth,String(f.write_permission))) })) };
}

/** Legacy HTTP saves use the same field write restrictions as action calls. */
export async function authorizeRecordFieldMutation(ctx: PublicationContext, collection: string, id: string, body: JsonObject) {
  if (!["projects","customers"].includes(collection)) return;
  const incoming = object(body.data);
  if (!valueKeys.some(k => k in incoming) && !("custom_field_schema" in incoming) && !Array.isArray(incoming.contacts)) return;
  const row = id ? await optional(() => readDocument(ctx.organizationId,collection,id)) : null;
  const previous = object(row?.data), entity = collection === "projects" ? "project" : "contact";
  if (collection === "projects" && Array.isArray(incoming.contacts)) {
    const oldContacts = Array.isArray(previous.contacts) ? previous.contacts.map(object) : [];
    for (const raw of incoming.contacts) {
      const c = object(raw), old = oldContacts.find(o => String(o.id || o.contact_id) === String(c.id || c.contact_id)) || {};
      const contactFields = await definitions(ctx.organizationId,String(previous.branch_id || incoming.branch_id || "default"),"contact",old);
      for (const f of contactFields) {
        const value = getValue(valuesOf(c,"contact"),String(f.path));
        if (value !== undefined && JSON.stringify(value) !== JSON.stringify(getValue(valuesOf(old,"contact"),String(f.path)))) assertFieldWrite(ctx,f);
      }
    }
  }
  if ("custom_field_schema" in incoming && JSON.stringify(incoming.custom_field_schema) !== JSON.stringify(previous.custom_field_schema) && (!ctx.auth || !hasPermission(ctx.auth,"manage_company_settings"))) throw forbidden("custom_field_schema_denied","Changing field definitions requires company settings permission.");
  const fields = await definitions(ctx.organizationId,String(previous.branch_id || incoming.branch_id || ctx.branchId || "default"),entity,previous);
  const next = valuesOf(incoming,entity), before = valuesOf(previous,entity);
  for (const f of fields) {
    const v = getValue(next,String(f.path));
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(getValue(before,String(f.path)))) assertFieldWrite(ctx,f);
  }
}
export async function writeFields(ctx: PublicationContext, target: TargetRef, entity: FieldEntity, input: Record<string,unknown>) {
  const state = await readFieldRecord(ctx,target,entity);
  if (Number(input.expectedRevision) !== (state.row?.revision || 0)) throw conflict("revision_conflict","Custom field record revision does not match.");
  const changes = object(input.values);
  const values = jsonClone(valuesOf(state.record,entity));
  for (const [path,value] of Object.entries(changes)) {
    const f = state.fields.find(f => f.path === fieldPath(path) && applies(f,state.record));
    if (!f) throw badRequest("custom_field_unknown", `Unknown field ${path}.`);
    assertFieldWrite(ctx,f); validateField(f,value); await validatePattern(f,value); putValue(values,path,value);
  }
  if (entity === "project") await (await import("./service.js")).validateProjectCustomFieldValues(ctx.organizationId,state.branch,applyValues(state.record,entity,values),state.record);
  let data:JsonObject = applyValues(state.record,entity,values);
  if (state.embedded) {
    data = {...state.parent, contacts:(state.parent.contacts as unknown[]).map(raw => String(object(raw).id || object(raw).contact_id) === state.id ? applyValues(object(raw),"contact",values) : raw)};
    if (state.parent.workflow_state === "contact_only" && (state.parent.primary_contact_id === state.id || object((state.parent.contacts as unknown[])[0]).id === state.id)) data.contact_custom_field_values = values;
  }
  const saved = await upsertDocument(ctx.organizationId,state.collection,{ id:state.embedded ? target.projectId : state.id, expected_revision:Number(input.expectedRevision), data, metadata:state.row?.metadata || {} },{ replace:true, ...(!state.row ? {createOnly:true} : {}) });
  return { id:saved.id, revision:saved.revision };
}
