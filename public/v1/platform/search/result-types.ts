/**
 * What the global search (the top bar search) may offer
 * (docs/architecture/app-experience.md, "Global search").
 *
 * Each source of results declares what it needs: the organization switches
 * (capabilities) it belongs to, and, when its results open an app, that app.
 * A source is offered only when its capabilities are on for the organization
 * and its app is offered to this person here: the app's switch is on, the
 * person has it in their app experience, and the organization has not placed
 * it out of the apps menu (`hidden` or `settings`). A source whose results
 * need data to be worth searching also declares that (`available`).
 *
 * Nothing here grants anything: an offered source still runs behind its own
 * routes' permission and resource checks. This only removes what the
 * organization does not have.
 */
import { appDefinition } from "../app-experience/registry.js";
import { rawAppPlacements } from "../app_flags.js";
import { hasAppAccess, hasPermission, type PlatformAuthContext } from "../auth.js";
import { effectiveCapabilities } from "../capabilities.js";

/** The result types the search box shows as filters. */
export type SearchResultType = "project" | "contact" | "equipment" | "event" | "document" | "scope" | "channel" | "setting" | "user";

export type SearchSourceContext = { ctx: PlatformAuthContext; orgId: string; branchId: string };

export type SearchSource = {
  /** The browser provider that fills this source; project and contact come from `/search`. */
  id: string;
  type: SearchResultType;
  /** Organization switches, all of which must be on. */
  capabilities?: string[];
  /** The registry app its results open, which must be offered here. */
  app?: string;
  /** A data rule: whether there is anything here worth searching. */
  available?: (input: SearchSourceContext) => Promise<boolean>;
};

/** Scope templates are worth searching only where scopes are chosen: more than one is switched on. */
async function scopeTemplatesChosen({ ctx, orgId, branchId }: SearchSourceContext) {
  // Scope results open Settings > Project Scopes, which needs this permission.
  if (!hasPermission(ctx, "manage_company_settings")) return false;
  const { listScopeTemplates } = await import("../../scopes/storage.js");
  const enabled = await listScopeTemplates(orgId, branchId).catch(() => []);
  return enabled.length > 1;
}

export const SEARCH_SOURCES: readonly SearchSource[] = Object.freeze([
  { id: "project", type: "project", capabilities: ["apps.projects"] },
  { id: "contact", type: "contact", capabilities: ["platform.contacts"] },
  { id: "equipment", type: "equipment", capabilities: ["apps.equipment"], app: "portal.equipment" },
  { id: "event", type: "event", capabilities: ["platform.scheduling"], app: "portal.scheduling" },
  { id: "invoice", type: "document", capabilities: ["money.invoices"], app: "portal.invoices" },
  { id: "receipt", type: "document", capabilities: ["crew.receipts"], app: "portal.receipts" },
  { id: "document", type: "document", capabilities: ["documents.templates_studio"], app: "documents.studio" },
  { id: "scope", type: "scope", capabilities: ["platform.expanded_access", "apps.projects"], available: scopeTemplatesChosen },
  { id: "channel", type: "channel", capabilities: ["apps.channels"], app: "portal.channels" },
  { id: "setting", type: "setting" },
  { id: "user", type: "user", capabilities: ["platform.photos_feed"], app: "portal.photos_feed" }
]);

/** Placements that keep a portal tab out of the apps menu and the left column. */
const NOT_OFFERED_PLACEMENTS = new Set(["hidden", "settings"]);

export async function offeredSearchSources(ctx: PlatformAuthContext, options: { branchId?: string } = {}) {
  const orgId = ctx.orgId;
  const branchId = String(options.branchId || ctx.branchId || "default").trim() || "default";
  const [resolution, placements] = await Promise.all([
    ctx.capabilities ? Promise.resolve(ctx.capabilities) : effectiveCapabilities(orgId, ctx.userId),
    rawAppPlacements(orgId).catch(() => ({} as Record<string, string>))
  ]);
  const on = (key: string) => resolution.effectiveByKey[key] === true;
  const appOffered = (appId: string) => {
    const app = appDefinition(appId);
    if (!app) return false;
    if (app.capabilities.length && !app.capabilities.some(on)) return false;
    if (NOT_OFFERED_PLACEMENTS.has(String((placements as Record<string, string>)[appId] || ""))) return false;
    return hasAppAccess(ctx, appId);
  };
  const checks = await Promise.all(SEARCH_SOURCES.map(async (source) => {
    if (!(source.capabilities || []).every(on)) return false;
    if (source.app && !appOffered(source.app)) return false;
    if (source.available && !(await source.available({ ctx, orgId, branchId }).catch(() => false))) return false;
    return true;
  }));
  const sources = SEARCH_SOURCES.filter((_source, index) => checks[index]);
  return {
    sources: sources.map((source) => source.id),
    types: Array.from(new Set(sources.map((source) => source.type)))
  };
}
