import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { WorkAutomationContext } from "../work/registry.js";

test("scope code uses declared providers and frozen code, and replays execution without repeating effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-code-"));
  process.env.NODE_ENV = "test"; process.env.PLATFORM_STORAGE_ROOT = root;
  const { createOrganization, upsertDocument } = await import("../platform/storage.js");
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  const { registerWorkAutomation } = await import("../work/registry.js");
  const { executeScopeCode } = await import("../work/automations/code.js");
  const org = "scope_code_org", project = "project";
  await createOrganization({ id: org, name: "Scope test" });
  await upsertDocument(org, "projects", { id: project, data: {} });
  let calls = 0;
  registerDataProvider({ id: "scope-test", version: "1", apps: [], exports: { amount: { schema: { type: "number" }, schemaVersion: "1", description: "test", access: { scopes: ["project"], permissions: [], systemKinds: ["work"] }, read: async () => ({ value: 12 }) } } });
  registerWorkAutomation("scope-test.effect", () => { calls++; return { calls }; }, { inputSchema: { type: "object" }, effect: "write" });
  const context = { event: { organization_id: org, project_id: project }, project: { id: project }, plan: { id: "plan" }, node: { id: "node" }, scope: {}, proposal: {}, now: new Date().toISOString(), idempotencyKey: "run1", data: {}, services: {} } as unknown as WorkAutomationContext;
  const target = { scope: "project", organizationId: org, projectId: project };
  const program = { id: "estimate", source: "const amount = await api.data.read('amount'); await api.actions.invoke('effect', {}); return {outputs:{amount}};", mode: "command", policy: "frozen", inputs: {}, inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"], additionalProperties: false }, bindings: {
    amount: { kind: "data", policy: "live", source: { provider: "scope-test", export: "amount", target } },
    effect: { kind: "action", policy: "frozen", action: { action: "scope-test.effect", target } }
  } };
  try {
    assert.deepEqual(await executeScopeCode(context, program), { amount: 12 });
    assert.deepEqual(await executeScopeCode(context, program), { amount: 12 });
    assert.equal(calls, 1);
    assert.deepEqual(await executeScopeCode({ ...context, idempotencyKey: "run2" }, { ...program, source: "throw new Error('new code must not replace frozen code')" }), { amount: 12 });
    assert.equal(calls, 2);
    await assert.rejects(executeScopeCode({ ...context, idempotencyKey: "evaluate" }, { ...program, id: "evaluation", mode: "evaluate" }), /Evaluation cannot|Effects|command/);
    await assert.rejects(executeScopeCode({ ...context, idempotencyKey: "scalar" }, {
      ...program, id: "scalar", mode: "evaluate", source: "return {outputs:42};", outputSchema: { type: "number" }, bindings: {}
    }), /object of named outputs/);
  } finally {
    await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
    await rm(root, { recursive: true, force: true });
  }
});
