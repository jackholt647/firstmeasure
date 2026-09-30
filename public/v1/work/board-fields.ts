import type { JsonObject } from "./storage.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { canReadField } from "../custom_fields/records.js";

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];

/** The board's scope owns discovery; stored project values do not add columns. */
export function boardFieldCatalog(definition: JsonObject, ctx?: PublicationContext): JsonObject[] {
  const fields: JsonObject[] = [];
  const visible = (field: JsonObject) => field.enabled !== false && canReadField(ctx || { auth:null } as PublicationContext, field);
  const add = (field: JsonObject, source: string) => {
    const path = String(field.path || field.key || field.id || "").trim();
    if (!path || !visible(field)) return;
    const key = `${source}:${path}`;
    if (fields.some(entry => entry.key === key)) return;
    fields.push({ key, path, source, label:String(field.label || field.name || path), type:String(field.type || "text"), width:"minmax(0,1fr)" });
    const nested = (schema: JsonObject, parent: string, label: string) => {
      for (const [name, value] of Object.entries(object(schema.properties))) {
        const child = object(value), childPath = `${parent}.${name}`;
        fields.push({ key:`${source}:${childPath}`, path:childPath, source, label:`${label} · ${String(child.title || name)}`, type:String(child.format || child.type || "text"), width:"minmax(0,1fr)" });
        nested(child, childPath, `${label} · ${String(child.title || name)}`);
      }
    };
    nested(object(field.schema), path, String(field.label || field.name || path));
  };
  const custom = object(definition.custom_fields || definition.project_custom_fields);
  for (const field of array(custom.fields || custom.definitions)) add(field, "custom");
  for (const field of array(definition.fields)) add(field, "scope");
  // Only explicit report integration references qualify, never the board name,
  // a project's historical order, or a general measurement dataset reference.
  const usesReports = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(usesReports);
    if (!value || typeof value !== "object") return false;
    const entry = object(value);
    if (entry.enabled === false) return false;
    if ([entry.app, entry.app_id, entry.provider].some(v => ["firstmeasure", "firstmeasure-reports"].includes(String(v || "")))) return true;
    if (/^(firstmeasure\.|measurement\.report\.)/.test(String(entry.automation || entry.action || entry.event || ""))) return true;
    if (/^project\.(measurement_project|measurement_report)(\.|$)/.test(String(entry.ref || ""))) return true;
    return Object.entries(entry).some(([key, child]) => key.startsWith("measurement.report.") || usesReports(child));
  };
  if (usesReports(definition)) {
    fields.push({ key:"measurement_status", label:"Measurement report status", type:"text", source:"measurement", width:"minmax(0,160px)" },
      { key:"measurement_submitted_at", label:"Measurement report submitted date", type:"datetime", source:"measurement", width:"minmax(0,190px)" });
  }
  return fields;
}
