import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest, notFound } from "../platform/errors.js";
import { createAccessKey, listAccessKeys, requireLibraryAdmin, requireLibraryEditor, requireLibraryEnvironment, revokeAccessKey } from "./access.js";
import { listAssets, putAsset, readAsset } from "./assets.js";
import { listLibraryKinds, libraryKind } from "./kinds.js";
import { registerAllLibraryKinds } from "./kinds/index.js";
import { libraryEntries, libraryEntry, libraryLoaded, librarySource, libraryVersion, refreshLibrary } from "./library.js";
import { captureInitialState, organizationState, restoreInitialState, setOrganizationState } from "./initial-state.js";
import { checkEntry, deleteEntry, listRevisions, readRevision, recentChanges, revertEntry, saveEntry, storeEntries } from "./writes.js";

/**
 * The config library API, mounted at /v1/config-library (docs/architecture/config-library.md, "API"). Everything but
 * asset downloads and browser-readable kinds (`/read/<kind>`) answers 404 outside the development data environment. Library routes take a signed-in editor
 * (writes need CSRF) or a coding agent's bearer key; organization routes (copies, starting state) take a signed-in
 * editor of that organization only; key routes take a signed-in platform administrator.
 */
const text = (value: unknown) => String(value ?? "").trim();
type Params = { kind?: string; id?: string; orgId?: string; revision?: string; sha256?: string; keyId?: string };
const params = (request: { params: unknown }) => request.params as Params;
const query = (request: { query: unknown }) => (request.query || {}) as Record<string, unknown>;

const summary = (entry: { kind: string; id: string; revision: number; sha256: string; title: string; updated_at: string; updated_by: string }) =>
  ({ kind: entry.kind, id: entry.id, revision: entry.revision, sha256: entry.sha256, title: entry.title, updated_at: entry.updated_at, updated_by: entry.updated_by });

const saveBody = z.object({ data: z.unknown(), expected_revision: z.number().int().min(0).optional(), note: z.string().max(2000).optional() }).strict();
const revertBody = z.object({ revision: z.number().int().min(1), expected_revision: z.number().int().min(0).optional(), note: z.string().max(2000).optional() }).strict();
const checkBody = z.object({ kind: z.string().max(60), id: z.string().max(160), data: z.unknown() }).strict();
const assetBody = z.object({ file_name: z.string().max(200).optional(), data_base64: z.string().min(4).max(8 * 1024 * 1024) }).strict();

/** A library edit is platform-wide; the editor's own organization hears it at once, other trays read GET /changes. */
async function libraryChanged(orgId: string | undefined, entry: { kind: string; id: string; revision: number }) {
  if (!orgId) return;
  const { publishRealtimeEvent } = await import("../platform/realtime.js");
  await publishRealtimeEvent({ organization_id: orgId, topic: "config_library.changed", payload: { kind: entry.kind, id: entry.id, revision: entry.revision } }).catch(() => undefined);
}

export async function registerConfigLibraryApi(app: FastifyInstance) {
  registerAllLibraryKinds();

  // Assets are content-addressed and public (marketing images and template artwork): served everywhere, from the
  // store in development and from the snapshot elsewhere.
  app.get("/assets/:sha256", async (request, reply) => {
    const asset = await readAsset(text(params(request).sha256));
    reply.header("Cache-Control", "public, max-age=31536000, immutable").header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.type(asset.content_type).send(asset.bytes);
  });

  // Kinds pages read directly (`browser: true`): every current entry, to anyone, everywhere. A short cache in
  // development keeps an edit visible on the next load; the version is the library's change counter.
  app.get("/read/:kind", async (request, reply) => {
    const kind = libraryKind(text(params(request).kind));
    if (!kind?.browser) throw notFound("config_library_kind_unknown", "No such readable kind.");
    await refreshLibrary();
    reply.header("Cache-Control", librarySource() === "store" ? "public, max-age=2" : "public, max-age=300");
    return { ok: true, kind: kind.kind, source: libraryLoaded(), version: libraryVersion(), entries: libraryEntries(kind.kind).map((entry) => ({ id: entry.id, revision: entry.revision, title: entry.title, data: entry.data })) };
  });

  app.get("/kinds", async (request) => {
    await requireLibraryEditor(request);
    await refreshLibrary();
    return { ok: true, source: librarySource(), kinds: listLibraryKinds().map((kind) => ({
      kind: kind.kind, title: kind.title, description: kind.description, append_only: !!kind.appendOnly, org_copies: !!kind.orgCopies,
      count: libraryEntries(kind.kind).length, schema: zodToJsonSchema(kind.schema, { target: "jsonSchema7", $refStrategy: "none" })
    })) };
  });
  app.get("/entries", async (request) => {
    await requireLibraryEditor(request);
    await refreshLibrary();
    const q = query(request), kind = text(q.kind), search = text(q.q).toLowerCase();
    const kinds = kind ? [kind] : listLibraryKinds().map((item) => item.kind);
    const entries = kinds.flatMap((name) => libraryEntries(name)).filter((entry) => !search || entry.id.toLowerCase().includes(search) || entry.title.toLowerCase().includes(search));
    return { ok: true, entries: entries.map(summary) };
  });
  app.get("/entries/:kind/:id", async (request) => {
    await requireLibraryEditor(request);
    await refreshLibrary();
    const { kind, id } = params(request);
    const entry = libraryEntry(text(kind), text(id));
    if (!entry) throw notFound("config_library_entry_missing", `${kind}/${id} does not exist.`);
    return { ok: true, entry };
  });
  app.put("/entries/:kind/:id", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const caller = await requireLibraryEditor(request, { csrf: true });
    const { kind, id } = params(request);
    const body = saveBody.parse(request.body ?? {});
    const result = await saveEntry({ kind: text(kind), id: text(id), data: body.data, expected_revision: body.expected_revision, note: body.note }, caller.author);
    request.log.info({ config_library: `${kind}/${id}`, revision: result.entry.revision, changed: result.changed, author: caller.author.id }, "Config library entry saved");
    if (result.changed) await libraryChanged(caller.ctx?.orgId, result.entry);
    return { ok: true, changed: result.changed, entry: result.entry };
  });
  app.delete("/entries/:kind/:id", async (request) => {
    const caller = await requireLibraryEditor(request, { csrf: true });
    const { kind, id } = params(request);
    const q = query(request);
    const result = await deleteEntry({ kind: text(kind), id: text(id), expected_revision: q.expected_revision === undefined ? undefined : Number(q.expected_revision), note: text(q.note) }, caller.author);
    request.log.info({ config_library: `${kind}/${id}`, author: caller.author.id }, "Config library entry deleted");
    if (result.changed) await libraryChanged(caller.ctx?.orgId, { kind: text(kind), id: text(id), revision: 0 });
    return { ok: true, ...result };
  });
  app.get("/entries/:kind/:id/revisions", async (request) => {
    await requireLibraryEditor(request);
    const { kind, id } = params(request);
    return { ok: true, revisions: await listRevisions(text(kind), text(id)) };
  });
  app.get("/entries/:kind/:id/revisions/:revision", async (request) => {
    await requireLibraryEditor(request);
    const { kind, id, revision } = params(request);
    return { ok: true, revision: await readRevision(text(kind), text(id), Number(revision)) };
  });
  app.post("/entries/:kind/:id/revert", async (request) => {
    const caller = await requireLibraryEditor(request, { csrf: true });
    const { kind, id } = params(request);
    const body = revertBody.parse(request.body ?? {});
    const result = await revertEntry({ kind: text(kind), id: text(id), ...body }, caller.author);
    if (result.entry) await libraryChanged(caller.ctx?.orgId, result.entry);
    return { ok: true, ...result };
  });
  /** Checks an entry against its kind and the running code without saving it. */
  app.post("/check", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    await requireLibraryEditor(request, { csrf: true });
    const body = checkBody.parse(request.body ?? {});
    const checked = checkEntry(body.kind, body.id, body.data);
    return { ok: checked.errors.length === 0, errors: checked.errors };
  });
  /** Slow checks a kind offers (rendering, running a module), only when asked: never on save. */
  app.post("/deep-check", async (request) => {
    await requireLibraryEditor(request, { csrf: true });
    const body = z.object({ kind: z.string().max(60), id: z.string().max(160).optional() }).strict().parse(request.body ?? {});
    const kind = libraryKind(body.kind);
    if (!kind) throw notFound("config_library_kind_unknown", `There is no config library kind called ${body.kind}.`);
    if (!kind.deepCheck) return { ok: true, available: false, results: [] };
    await refreshLibrary();
    const entries = body.id ? [libraryEntry(kind.kind, body.id)].filter((entry) => !!entry) : libraryEntries(kind.kind);
    const results = [];
    for (const entry of entries) results.push({ id: entry!.id, revision: entry!.revision, errors: await kind.deepCheck(entry!.data, entry!.id).catch((error) => [`The check failed: ${(error as Error).message}`]) });
    return { ok: results.every((result) => !result.errors.length), available: true, results };
  });
  app.get("/changes", async (request) => {
    await requireLibraryEditor(request);
    const q = query(request);
    return { ok: true, changes: await recentChanges(Number(q.limit || 100), text(q.kind)) };
  });
  /** The whole library as stored, for `scripts/config-library-snapshot.ts` (the checked-in snapshot). */
  app.get("/export", async (request, reply) => {
    await requireLibraryEditor(request);
    reply.header("Cache-Control", "private, no-store");
    const { storeAssets } = await import("./assets.js");
    return { ok: true, entries: await storeEntries(), assets: (await storeAssets()).map((asset) => ({ sha256: asset.sha256, content_type: asset.content_type, file_name: asset.file_name, data_base64: asset.bytes.toString("base64") })) };
  });

  app.get("/assets", async (request) => {
    await requireLibraryEditor(request);
    return { ok: true, assets: await listAssets() };
  });
  app.post("/assets", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
    const caller = await requireLibraryEditor(request, { csrf: true });
    const body = assetBody.parse(request.body ?? {});
    return { ok: true, asset: await putAsset({ bytes: Buffer.from(body.data_base64, "base64"), file_name: body.file_name }, caller.author) };
  });

  // An agent machine fetches its own key, proving itself with its listed SSH key (enroll.ts). The key is the response
  // body (text/plain) and nothing else: never logged, never shown. Development only.
  app.post("/keys/enroll", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    requireLibraryEnvironment();
    const body = z.object({ machine: z.string().max(80), timestamp: z.number().int(), nonce: z.string().max(64), signature: z.string().max(8000) }).strict().parse(request.body ?? {});
    const signature = /BEGIN SSH SIGNATURE/.test(body.signature) ? body.signature : Buffer.from(body.signature, "base64").toString("utf8");
    const created = await (await import("./enroll.js")).enrollMachine({ ...body, signature });
    request.log.info({ config_library_key: created.id, machine: created.name }, "Config library key enrolled for an agent machine");
    reply.header("Cache-Control", "no-store").header("X-Config-Library-Key-Id", created.id).header("X-Config-Library-Key-Expires", new Date(created.expires_at).toISOString());
    return reply.type("text/plain; charset=utf-8").send(created.key);
  });

  // Access keys for coding agents: a signed-in platform administrator only.
  app.get("/keys", async (request) => {
    await requireLibraryAdmin(request);
    return { ok: true, keys: await listAccessKeys() };
  });
  app.post("/keys", async (request) => {
    const caller = await requireLibraryAdmin(request, true);
    const body = z.object({ name: z.string().min(1).max(120), days: z.number().int().min(1).max(365).optional() }).strict().parse(request.body ?? {});
    const created = await createAccessKey({ name: body.name, createdBy: caller.author.id, days: body.days });
    request.log.info({ config_library_key: created.id, name: created.name, by: caller.author.id }, "Config library access key created");
    return { ok: true, key: created.key, access_key: { ...created, key: undefined } };
  });
  app.delete("/keys/:keyId", async (request) => {
    const caller = await requireLibraryAdmin(request, true);
    const revoked = await revokeAccessKey(text(params(request).keyId), caller.author.id);
    if (!revoked) throw notFound("config_library_key_missing", "No such active key.");
    return { ok: true };
  });

  // An organization's copies of library entries: how each stands, and reset to the library.
  app.get("/organizations/:orgId/copies", async (request) => {
    const { orgId } = params(request);
    await requireLibraryEditor(request, { orgId, keys: false });
    await refreshLibrary();
    const kindName = text(query(request).kind);
    const kinds = listLibraryKinds().filter((kind) => kind.orgCopies && (!kindName || kind.kind === kindName));
    const copies = [];
    for (const kind of kinds) {
      for (const status of await kind.orgCopies!.status(text(orgId))) copies.push({ kind: kind.kind, ...status });
    }
    return { ok: true, copies };
  });
  app.post("/organizations/:orgId/copies/:kind/:id/reset", async (request) => {
    const { orgId, kind, id } = params(request);
    const caller = await requireLibraryEditor(request, { orgId, csrf: true, keys: false });
    const definition = libraryKind(text(kind));
    if (!definition?.orgCopies) throw badRequest("config_library_no_copies", `Organizations do not keep copies of ${kind}.`);
    if (!libraryEntry(definition.kind, text(id))) throw notFound("config_library_entry_missing", `${kind}/${id} does not exist.`);
    const result = await definition.orgCopies.reset(caller.ctx!, text(id));
    request.log.info({ config_library: `${kind}/${id}`, organization_id: orgId, by: caller.author.id }, "Organization copy reset to the library");
    return { ok: true, result, status: (await definition.orgCopies.status(text(orgId), [text(id)]))[0] || null };
  });

  // A sandbox test organization's flags and settings, its starting state, and restore. Open trays hear
  // `org_state.changed` on the platform event stream.
  const stateChanged = async (orgId: string, changed: number) => {
    const { publishRealtimeEvent } = await import("../platform/realtime.js");
    await publishRealtimeEvent({ organization_id: orgId, topic: "org_state.changed", payload: { changed_count: changed } }).catch(() => undefined);
  };
  app.get("/organizations/:orgId/state", async (request) => {
    const { orgId } = params(request);
    await requireLibraryEditor(request, { orgId, keys: false });
    return { ok: true, ...(await organizationState(text(orgId))) };
  });
  app.patch("/organizations/:orgId/state", async (request) => {
    const { orgId } = params(request);
    const caller = await requireLibraryEditor(request, { orgId, csrf: true, keys: false });
    const body = z.object({ path: z.string().min(3).max(200), value: z.unknown() }).strict().parse(request.body ?? {});
    const state = await setOrganizationState(text(orgId), body.path, body.value ?? null);
    request.log.info({ organization_id: orgId, path: body.path, by: caller.author.id }, "Test organization state changed");
    await stateChanged(text(orgId), state.changed.length);
    return { ok: true, ...state };
  });
  app.post("/organizations/:orgId/state/restore", async (request) => {
    const { orgId } = params(request);
    const caller = await requireLibraryEditor(request, { orgId, csrf: true, keys: false });
    const body = z.object({ paths: z.array(z.string().min(3).max(200)).max(500).optional() }).strict().parse(request.body ?? {});
    const result = await restoreInitialState(text(orgId), caller.author.id, body.paths);
    request.log.info({ organization_id: orgId, by: caller.author.id, paths: body.paths?.length ?? "all" }, "Test organization restored to its starting state");
    await stateChanged(text(orgId), result.changed.length);
    return { ok: true, ...result };
  });
  app.post("/organizations/:orgId/state/capture", async (request) => {
    const { orgId } = params(request);
    const caller = await requireLibraryEditor(request, { orgId, csrf: true, keys: false });
    await captureInitialState(text(orgId), caller.author.id);
    await stateChanged(text(orgId), 0);
    return { ok: true, ...(await organizationState(text(orgId))) };
  });
}

