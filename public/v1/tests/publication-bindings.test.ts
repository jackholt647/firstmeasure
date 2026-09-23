import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlatformAuthContext } from "../platform/auth.js";
import type { DataBinding, PublicationContext } from "../platform/publication/contracts.js";

let root: string;
let bindings: typeof import("../platform/publication/bindings.js");
let providers: typeof import("../platform/publication/providers.js");
let actions: typeof import("../platform/publication/actions.js");
const auth = { orgId: "org", userId: "user", permissions: { view_projects: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as unknown as PlatformAuthContext;
const ctx: PublicationContext = { organizationId: "org", auth, executionKind: "module", mode: "evaluate" };
const target = { scope: "project" as const, organizationId: "org", projectId: "project" };
let value = { hours: 3, rate: 100 }, revision = 1, reads = 0;
const ref = { provider: "binding-test", export: "cube", target };
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publication-bindings-"));
  process.env.PLATFORM_STORAGE_ROOT = root;
  process.env.NODE_ENV = "test";
  bindings = await import("../platform/publication/bindings.js");
  providers = await import("../platform/publication/providers.js");
  actions = await import("../platform/publication/actions.js");
  providers.registerDataProvider({ id: ref.provider, version: "1", apps: [], exports: { cube: {
    description: "Test source", schemaVersion: "1", schema: { type: "object" },
    access: { scopes: ["project"], permissions: ["view_projects"] },
    read: async () => { reads++; return { value: { ...value }, revision: String(revision) }; }
  } } });
});
after(async () => { await bindings.closeBindingStoreForTests(); await actions.closeActionDatabase(); await rm(root, { recursive: true, force: true }); });
test("consumer frozen imports retain values, source identity and revision; live follows source", async () => {
  const frozen: DataBinding = { kind: "data", policy: "frozen", source: ref };
  const first = await bindings.resolveDataBinding(ctx, "estimate", "cube", frozen);
  value = { hours: 5, rate: 120 }; revision++;
  assert.deepEqual(await bindings.resolveDataBinding(ctx, "estimate", "cube", frozen), first);
  const live = await bindings.resolveDataBinding(ctx, "estimate", "other", { ...frozen, policy: "live" });
  assert.equal(live.status, "ready");
  if (live.status === "ready") { assert.equal((live.value as typeof value).hours, 5); assert.equal(live.source.revision, "2"); }
  assert.equal(first.status, "ready");
  if (first.status === "ready") { assert.equal(first.source.provider, ref.provider); assert.equal(first.source.revision, "1"); }
  const denied = { ...ctx, auth: { ...auth, permissions: { view_projects: false } } };
  await assert.rejects(bindings.resolveDataBinding(denied, "estimate", "cube", frozen), /not permitted/);
});
test("one evaluation resolves related live field bindings from one source read", async () => {
  const base = { kind: "data" as const, policy: "live" as const };
  const session = bindings.createBindingSession(ctx, "workflow", {
    hours: { ...base, source: { ...ref, path: "/hours" } }, rate: { ...base, source: { ...ref, path: "/rate" } }
  });
  const before = reads;
  assert.equal(await session.read("hours"), 5);
  value = { hours: 10, rate: 200 }; revision++;
  assert.equal(await session.read("rate"), 120);
  assert.equal(reads - before, 1);
  await assert.rejects(session.read("undeclared"), /not declared/);
  assert.equal(Object.keys(session.manifest()).length, 2);
});
test("simultaneous captures converge on one durable snapshot", async () => {
  const definition: DataBinding = { kind: "data", policy: "frozen", source: ref };
  const results = await Promise.all(Array.from({ length: 8 }, () => bindings.resolveDataBinding(ctx, "parallel", "cube", definition)));
  for (const result of results) assert.deepEqual(result, results[0]);
});
test("frozen filtered fields recheck captured subjects for other users and revoked membership", async () => {
  const allowed = new Map([["user", new Set(["private-channel"])], ["other", new Set<string>()]]);
  providers.registerDataProvider({ id: "binding-audience", version: "1", apps: [], exports: { rows: {
    description: "Audience-filtered rows", schemaVersion: "1", schema: { type: "array" },
    access: { scopes: ["project"], permissions: ["view_projects"] },
    read: async () => ({ value: [{ id: "private-channel", name: "Private" }], provenance: { subjectIds: ["private-channel"] } }),
    authorizeSnapshot: async (principal, _ref, result) => {
      const subjects = result.provenance.subjectIds as string[];
      if (subjects.some(id => !allowed.get(principal.auth!.userId)?.has(id))) throw new Error("Captured subject access revoked");
    }
  } } });
  const binding: DataBinding = { kind: "data", policy: "frozen", source: { provider: "binding-audience", export: "rows", target, path: "/0/name" } };
  assert.equal((await bindings.resolveDataBinding(ctx, "shared", "private", binding)).status, "ready");
  await assert.rejects(bindings.resolveDataBinding({ ...ctx, auth: { ...auth, userId: "other" } }, "shared", "private", binding), /revoked/);
  allowed.get("user")!.clear();
  await assert.rejects(bindings.resolveDataBinding(ctx, "shared", "private", binding), /revoked/);
});
test("frozen action binding retains the selected implementation while live resolves newest", async () => {
  const action = (version: string) => actions.registerAction({ id: "binding.calculate", version, implementation: `test-${version}`, domain: "test", description: "Compute", inputSchema: { type: "object" }, outputSchema: { type: "string" }, effect: "compute", idempotency: "none", executionKinds: ["module"], policy: { scopes: ["project"], permissions: ["view_projects"] }, execute: () => version });
  action("1");
  const frozen = { kind: "action" as const, policy: "frozen" as const, action: { action: "binding.calculate", target } };
  assert.equal((await bindings.invokeActionBinding(ctx, "estimate", "formula", frozen, {})).value, "1");
  action("2");
  assert.equal((await bindings.invokeActionBinding(ctx, "estimate", "formula", frozen, {})).value, "1");
  assert.equal((await bindings.invokeActionBinding(ctx, "estimate", "formula", { ...frozen, policy: "live" }, {})).value, "2");
});
