/**
 * Org-wide "attention" banner platform.
 *
 * A prioritized feed of banner entries that render on three surfaces
 * (topbar bar, sidebar card, pinned notification row). Entries come from two
 * places, merged on read:
 *
 *  - Computed sources: other modules call registerAttentionSource(key, fn)
 *    at boot; the resolver runs on every GET and returns entries derived from
 *    live state (e.g. payments onboarding). Nothing is stored.
 *  - Stored/manual entries: org collection "attention_banners" with CRUD
 *    guarded by the org-settings permission, so support/admin tooling can
 *    inject banner sets per org.
 *
 * Per-user dismissal mirrors the notifications user-doc pattern:
 * users/:id data.attention_state[entryId] = { seen_at, dismissed_at }.
 * Dismissal is only honored on surfaces the entry marks dismissible; the
 * "notification" surface is never dismissible.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requirePlatformAuth } from "./auth.js";
import { badRequest, notFound } from "./errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "./storage.js";

export const ATTENTION_COLLECTION = "attention_banners";
const ATTENTION_WRITE_PERMISSION = "manage_company_settings";
export const ATTENTION_SURFACES = ["topbar", "sidebar", "notification"] as const;
export type AttentionSurface = (typeof ATTENTION_SURFACES)[number];
const ATTENTION_TONES = ["orange", "primary", "danger", "neutral"] as const;
const ATTENTION_STATES = ["active", "waiting", "done"] as const;

const objectBodySchema = z.object({}).passthrough();

type AttentionSourceContext = {
  userId: string;
  branchId: string;
  demo: boolean;
};

export type AttentionSourceResolver = (
  orgId: string,
  ctx: AttentionSourceContext
) => Promise<JsonObject[] | null | undefined> | JsonObject[] | null | undefined;

const attentionSources = new Map<string, AttentionSourceResolver>();

export function registerAttentionSource(sourceKey: string, resolver: AttentionSourceResolver) {
  const key = cleanText(sourceKey);
  if (!key) throw new Error("registerAttentionSource requires a source key.");
  attentionSources.set(key, resolver);
}

export function unregisterAttentionSource(sourceKey: string) {
  attentionSources.delete(cleanText(sourceKey));
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function attentionIdFromParts(...parts: unknown[]) {
  const raw = parts.map((part) => cleanText(part)).filter(Boolean).join("_");
  return `attention_${raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || Date.now().toString(36)}`;
}

function normalizeSurfaces(value: unknown): AttentionSurface[] {
  const raw = Array.isArray(value) ? value : [value];
  const surfaces = raw
    .map((entry) => cleanText(entry).toLowerCase())
    .filter((entry): entry is AttentionSurface => (ATTENTION_SURFACES as readonly string[]).includes(entry));
  return [...new Set(surfaces)];
}

function normalizeTone(value: unknown) {
  const tone = cleanText(value).toLowerCase();
  return (ATTENTION_TONES as readonly string[]).includes(tone) ? tone : "orange";
}

function normalizeState(value: unknown) {
  const state = cleanText(value).toLowerCase();
  return (ATTENTION_STATES as readonly string[]).includes(state) ? state : "active";
}

function normalizeDismissible(value: unknown) {
  const input = asObject(value);
  return {
    topbar: input.topbar === true,
    sidebar: input.sidebar === true,
    // Pinned notification rows can never be dismissed.
    notification: false
  };
}

export function normalizeAttentionEntry(input: JsonObject) {
  const now = new Date().toISOString();
  const source = cleanText(input.source) || "manual";
  const key = cleanText(input.key);
  const id = cleanText(input.id) || attentionIdFromParts(source, key || input.title || Date.now().toString(36));
  const surfaces = normalizeSurfaces(input.surfaces);
  const priority = Number(input.priority);
  return {
    id,
    source,
    key,
    priority: Number.isFinite(priority) ? priority : 0,
    surfaces: surfaces.length ? surfaces : [...ATTENTION_SURFACES],
    title: cleanText(input.title) || "Attention",
    body: cleanText(input.body || input.message),
    cta_label: cleanText(input.cta_label || input.ctaLabel),
    tone: normalizeTone(input.tone),
    frontend_action: asObject(input.frontend_action || input.frontendAction),
    state: normalizeState(input.state),
    dismissible: normalizeDismissible(input.dismissible),
    expires_at: cleanText(input.expires_at || input.expiresAt),
    created_at: cleanText(input.created_at) || now,
    updated_at: now
  };
}

export type AttentionEntry = ReturnType<typeof normalizeAttentionEntry>;

function attentionEntryExpired(entry: AttentionEntry) {
  if (!entry.expires_at) return false;
  const date = new Date(entry.expires_at);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

async function setUserAttentionState(orgId: string, userId: string, entryId: string, patch: JsonObject) {
  const userDoc = await readDocument(orgId, "users", userId);
  const data = asObject(userDoc.data);
  const states = asObject(data.attention_state);
  const current = asObject(states[entryId]);
  const now = new Date().toISOString();
  const stateTimestamp = (flag: string, timestamp: string) => {
    const hasFlag = Object.prototype.hasOwnProperty.call(patch, flag);
    const hasTimestamp = Object.prototype.hasOwnProperty.call(patch, timestamp);
    if ((hasFlag && patch[flag] === false) || (hasTimestamp && !cleanText(patch[timestamp]))) return undefined;
    if ((hasFlag && patch[flag]) || (hasTimestamp && cleanText(patch[timestamp]))) {
      return cleanText(patch[timestamp] || current[timestamp] || now);
    }
    return current[timestamp];
  };
  const next = {
    ...current,
    seen_at: stateTimestamp("seen", "seen_at"),
    dismissed_at: stateTimestamp("dismissed", "dismissed_at"),
    updated_at: now
  };
  await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      ...data,
      attention_state: {
        ...states,
        [entryId]: next
      }
    },
    metadata: userDoc.metadata
  }, { replace: true });
  return next;
}

function visibleSurfacesFor(entry: AttentionEntry, userState: JsonObject): AttentionSurface[] {
  const dismissedAt = cleanText(userState.dismissed_at);
  return entry.surfaces.filter((surface) => {
    if (!dismissedAt) return true;
    // Dismissal only hides the surfaces the entry marks dismissible.
    return entry.dismissible[surface] !== true;
  });
}

async function computedAttentionEntries(orgId: string, ctx: AttentionSourceContext) {
  const entries: AttentionEntry[] = [];
  for (const [sourceKey, resolver] of attentionSources) {
    try {
      const produced = await resolver(orgId, ctx);
      for (const raw of Array.isArray(produced) ? produced : []) {
        entries.push(normalizeAttentionEntry({ ...asObject(raw), source: cleanText(asObject(raw).source) || sourceKey }));
      }
    } catch {
      // A broken source must never take the whole feed down.
    }
  }
  return entries;
}

export async function listAttentionEntries(
  orgId: string,
  userId: string,
  options: { includeDismissed?: boolean; branchId?: string; demo?: boolean } = {}
) {
  const ctx: AttentionSourceContext = {
    userId,
    branchId: cleanText(options.branchId) || "default",
    demo: options.demo === true
  };
  const [userDoc, storedDocs, computed] = await Promise.all([
    readDocument(orgId, "users", userId),
    listDocuments(orgId, ATTENTION_COLLECTION),
    computedAttentionEntries(orgId, ctx)
  ]);
  const states = asObject(asObject(userDoc.data).attention_state);
  const stored = storedDocs.map((doc) => normalizeAttentionEntry({ ...asObject(doc.data), id: cleanText(asObject(doc.data).id) || cleanText(doc.id) }));
  const merged = [...computed, ...stored]
    .filter((entry) => entry.state !== "done")
    .filter((entry) => !attentionEntryExpired(entry));
  // Later entries with the same id never shadow computed ones silently; first wins.
  const seen = new Set<string>();
  const unique = merged.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  const entries = unique
    .map((entry) => {
      const userState = asObject(states[entry.id]);
      return {
        ...entry,
        user_state: userState,
        visible_surfaces: visibleSurfacesFor(entry, userState)
      };
    })
    .filter((entry) => options.includeDismissed || entry.visible_surfaces.length > 0)
    .sort((a, b) => b.priority - a.priority || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id));
  return {
    entries,
    active_count: entries.length,
    unseen_count: entries.filter((entry) => !cleanText(entry.user_state.seen_at)).length
  };
}

function parseBooleanFlag(value: unknown) {
  const text = cleanText(value).toLowerCase();
  return text === "1" || text === "true" || text === "yes" || value === true;
}

// --- built-in demo source ----------------------------------------------------
// Active only outside production AND when the request explicitly asks with
// ?demo=1. Exercises the computed-source seam without leaking into real orgs.
registerAttentionSource("demo", (_orgId, ctx) => {
  if (!ctx.demo || process.env.NODE_ENV === "production") return [];
  return [{
    id: "attention_demo_source",
    key: "demo_banner",
    priority: 5,
    surfaces: ["topbar", "sidebar", "notification"],
    title: "Demo attention banner",
    body: "This computed entry only appears in development with ?demo=1.",
    cta_label: "Open settings",
    tone: "neutral",
    frontend_action: { route: { tab: "company_settings" } },
    state: "active",
    dismissible: { topbar: true, sidebar: true }
  }];
});

export async function registerAttentionRoutes(app: FastifyInstance) {
  app.get("/organizations/:orgId/attention", async (request) => {
    const orgId = cleanText((request.params as JsonObject).orgId);
    const ctx = await requirePlatformAuth(request, { orgId });
    const query = asObject(request.query);
    const result = await listAttentionEntries(orgId, ctx.userId, {
      includeDismissed: parseBooleanFlag(query.include_dismissed),
      branchId: cleanText(query.branch_id || query.branchId || ctx.branchId || "default"),
      demo: parseBooleanFlag(query.demo)
    });
    return { ok: true, ...result };
  });

  app.patch("/organizations/:orgId/attention/:entryId/user-state", async (request) => {
    const orgId = cleanText((request.params as JsonObject).orgId);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const entryId = cleanText((request.params as JsonObject).entryId);
    if (!entryId) throw badRequest("invalid_attention_entry", "An attention entry id is required.");
    const state = await setUserAttentionState(orgId, ctx.userId, entryId, objectBodySchema.parse(request.body ?? {}));
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/attention-banners", async (request, reply) => {
    const orgId = cleanText((request.params as JsonObject).orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: ATTENTION_WRITE_PERMISSION });
    const entry = normalizeAttentionEntry(objectBodySchema.parse(request.body ?? {}));
    const saved = await upsertDocument(orgId, ATTENTION_COLLECTION, {
      id: entry.id,
      data: entry,
      metadata: { kind: "attention_banner", source: entry.source }
    }, { replace: true });
    reply.code(201);
    return { ok: true, entry, document: saved };
  });

  app.patch("/organizations/:orgId/attention-banners/:bannerId", async (request) => {
    const orgId = cleanText((request.params as JsonObject).orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: ATTENTION_WRITE_PERMISSION });
    const bannerId = cleanText((request.params as JsonObject).bannerId);
    const existing = await readDocument(orgId, ATTENTION_COLLECTION, bannerId).catch(() => null);
    if (!existing) throw notFound("attention_banner_not_found", "No stored attention banner with that id.");
    const patch = objectBodySchema.parse(request.body ?? {});
    const entry = normalizeAttentionEntry({ ...asObject(existing.data), ...patch, id: bannerId });
    const saved = await upsertDocument(orgId, ATTENTION_COLLECTION, {
      id: bannerId,
      data: entry,
      metadata: existing.metadata
    }, { replace: true });
    return { ok: true, entry, document: saved };
  });

  app.delete("/organizations/:orgId/attention-banners/:bannerId", async (request) => {
    const orgId = cleanText((request.params as JsonObject).orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: ATTENTION_WRITE_PERMISSION });
    const bannerId = cleanText((request.params as JsonObject).bannerId);
    await deleteDocument(orgId, ATTENTION_COLLECTION, bannerId);
    return { ok: true, deleted: bannerId };
  });
}
