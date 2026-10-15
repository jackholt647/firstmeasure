import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { badRequest, PlatformError } from "../platform/errors.js";

// Scope categories (docs/architecture/opportunities.md). An organization's own
// catalog of labels for its scope templates; a template carries zero or more.
// `sales` is built in: the platform reads one fact from it (a plan whose
// template has it is an opportunity), so it can be renamed but not removed or
// disabled. Everything else is the organization's to define.

export const SALES_CATEGORY = "sales";
export const SCOPE_CATEGORIES_MODULE = "scope_categories";
const DEFAULTS = [
  { id: SALES_CATEGORY, label: "Sales", builtin: true },
  { id: "production", label: "Production" }
];

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export type ScopeCategory = { id: string; label: string; enabled: boolean; builtin: boolean };

export function normalizeScopeCategories(value: unknown): { version: 1; categories: ScopeCategory[] } {
  const input = object(value), seen = new Set<string>();
  const source: JsonObject[] = Array.isArray(input.categories) ? input.categories.map(object) : DEFAULTS;
  const categories: ScopeCategory[] = [];
  for (const row of source) {
    const id = text(row.id), label = text(row.label);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !label || label.length > 80 || seen.has(id)) throw badRequest("scope_category_invalid", "Categories need unique stable ids and labels of up to 80 characters.");
    seen.add(id);
    categories.push({ id, label, enabled: id === SALES_CATEGORY || row.enabled !== false, builtin: id === SALES_CATEGORY });
  }
  if (!seen.has(SALES_CATEGORY)) categories.unshift({ id: SALES_CATEGORY, label: "Sales", enabled: true, builtin: true });
  if (categories.length > 100) throw badRequest("scope_categories_limit", "Use at most 100 scope categories.");
  return { version: 1, categories };
}

export async function readScopeCategories(orgId: string) {
  try { return normalizeScopeCategories((await readBranchModule(orgId, "default", SCOPE_CATEGORIES_MODULE)).data); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404 || (error as { code?: string })?.code === "ENOENT") return normalizeScopeCategories({}); throw error; }
}

export async function saveScopeCategories(orgId: string, input: unknown) {
  const next = normalizeScopeCategories(input);
  await saveBranchModule(orgId, "default", SCOPE_CATEGORIES_MODULE, { data: next }, { replace: true });
  return next;
}

/** A template's categories. Older definitions said `kind`; it is read once and dropped on save. */
export function templateCategoryIds(definition: unknown): string[] {
  const value = object(definition);
  if (Array.isArray(value.category_ids)) return [...new Set(value.category_ids.map(text).filter(Boolean))];
  const kind = text(value.kind);
  return kind === "pipeline" || kind === "sales" ? [SALES_CATEGORY] : kind === "production" ? ["production"] : [];
}

export function isSalesTemplate(definition: unknown) { return templateCategoryIds(definition).includes(SALES_CATEGORY); }

/** A definition in its current shape: `category_ids`, no `kind`. */
export function withCategoryIds<T extends JsonObject>(definition: T): T {
  const { kind: _kind, ...rest } = definition;
  return { ...rest, category_ids: templateCategoryIds(definition) } as unknown as T;
}

/** New category ids on a template must be in the catalog and enabled; ids it already had may stay. */
export async function assertTemplateCategories(orgId: string, next: string[], previous: string[] = []) {
  const catalog = await readScopeCategories(orgId);
  const enabled = new Set(catalog.categories.filter(c => c.enabled).map(c => c.id));
  const unknown = next.filter(id => !previous.includes(id) && !enabled.has(id));
  if (unknown.length) throw badRequest("scope_category_unavailable", `Choose scope categories from the catalog (${unknown.join(", ")}).`);
}
