import type { JsonObject } from "../../platform/storage.js";
import { FMDocModel } from "../schemas.js";

/**
 * Server halves of document widgets. A resolver turns document data (params,
 * project, payments, media...) into the frozen `data` payload the client
 * renderer consumes. Resolvers run at snapshot creation and on-demand render;
 * results are keyed by node id.
 *
 * Contract: resolvers that lack data return null. They must never throw — the
 * runner also guards so a failing resolver degrades to null data.
 */
export type DocumentWidgetServices = {
  pricebook: JsonObject;
  payments: {
    listProjectObligations: (orgId: string, projectId: string) => Promise<JsonObject[]>;
    listProjectPayments: (orgId: string, projectId: string) => Promise<JsonObject[]>;
  };
  media: {
    readMediaMetadata: (orgId: string, mediaId: string) => Promise<JsonObject>;
    fileUrl: (orgId: string, mediaId: string, variant?: string) => string;
    /** Raw file access — used by static/PDF renders to inline small images as data URIs. */
    readMediaFile: (orgId: string, mediaId: string, variant?: string) => Promise<{ contentType: string; bytes: Buffer }>;
  };
  platform: {
    readDocument: (orgId: string, collection: string, documentId: string) => Promise<JsonObject>;
    listDocuments: (orgId: string, collection: string) => Promise<JsonObject[]>;
  };
};

/**
 * Customer-portal hosting context. Present ONLY when the definition is being
 * resolved for a customer portal render — absent for documents, PDFs, and
 * public marketing sites.
 *
 * `portal.*` widget resolvers require it and MUST return null when it is
 * missing (per the "resolvers that lack data return null" rule above), so a
 * portal widget dropped onto a public page degrades to its placeholder instead
 * of erroring or leaking project data onto a public site.
 *
 * Contract: docs/customer-portal-v2-spec.md §4.2.
 */
export type WidgetPortalContext = {
  portal_uuid: string;
  project_id: string;
  contact_id: string;
  preview: boolean;
  /** Resolved PortalSettings (platform/portal_settings.ts). Read-only here. */
  settings: JsonObject;
};

export type WidgetResolveContext = {
  organizationId: string;
  document: JsonObject;
  params: JsonObject;
  project: JsonObject | null;
  snapshot?: JsonObject | null;
  /** "static" when resolving for print/PDF (inline data URIs), "interactive" for live portal renders. */
  target?: "static" | "interactive";
  /** Set only for customer-portal renders; see WidgetPortalContext. */
  portal?: WidgetPortalContext | null;
  services: DocumentWidgetServices;
};

export type DocumentWidgetResolver = (ctx: WidgetResolveContext, config: JsonObject) => Promise<unknown>;

type ResolverEntry = {
  id: string;
  resolver: DocumentWidgetResolver;
  metadata: JsonObject;
};

const registry = new Map<string, ResolverEntry>();

export function registerDocumentWidgetResolver(id: string, resolver: DocumentWidgetResolver, metadata: JsonObject = {}) {
  const cleaned = String(id || "").trim().toLowerCase();
  if (!cleaned) throw new Error("registerDocumentWidgetResolver requires a widget id.");
  registry.set(cleaned, { id: cleaned, resolver, metadata });
}

export function documentWidgetResolver(id: string): DocumentWidgetResolver | null {
  return registry.get(String(id || "").trim().toLowerCase())?.resolver || null;
}

export function listDocumentWidgetResolvers(): Array<{ id: string } & JsonObject> {
  return [...registry.values()].map((entry) => ({ id: entry.id, ...entry.metadata }));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

/**
 * Resolve widget data for every widget node in an already binding-resolved
 * document. Unknown widget ids and resolver failures produce null entries so
 * the renderer can fall back to placeholders; nothing here ever throws.
 */
export async function resolveDocumentWidgetData(resolvedDefinition: JsonObject, ctx: WidgetResolveContext) {
  const data: Record<string, unknown> = {};
  const refs = FMDocModel.widgetRefs(resolvedDefinition);
  for (const ref of refs) {
    const entry = registry.get(ref.id);
    if (!entry) {
      data[ref.node_id] = null;
      continue;
    }
    const found = findNode(resolvedDefinition, ref.node_id);
    const config = asObject(asObject(asObject(found).props).config);
    try {
      const resolved = await entry.resolver(ctx, config);
      data[ref.node_id] = resolved === undefined ? null : resolved;
    } catch {
      data[ref.node_id] = null;
    }
  }
  return data;
}

function findNode(doc: JsonObject, nodeId: string): JsonObject | null {
  let found: JsonObject | null = null;
  const visit = (node: unknown) => {
    if (found || !node || typeof node !== "object" || Array.isArray(node)) return;
    const item = node as JsonObject;
    if (String(item.id || "") === nodeId) {
      found = item;
      return;
    }
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  if (doc.kind === "view") visit(doc.root);
  else for (const page of Array.isArray(doc.pages) ? doc.pages : []) {
    const children = asObject(page).children;
    if (Array.isArray(children)) children.forEach(visit);
  }
  return found;
}
