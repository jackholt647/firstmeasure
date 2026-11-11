import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../firstmeasure/api.ts", import.meta.url), "utf8");

// FM-386: the first technician's claim must not start the reordered project's drafting timer.
test("reordering a rejected project clears the earlier claim's start and assignment", async () => {
  const code = source.slice(
    source.indexOf("async function reopenRejectedProjectForReorder("),
    source.indexOf("async function findPreviousReportImportCandidate(")
  );
  assert.ok(code.length > 0, "reopenRejectedProjectForReorder found in api.ts");
  const existing = {
    id: "fixture",
    status: "rejected",
    project_type: "residential",
    address: "128 N Dallas Ave",
    rejection_reason: "wrong_structure_type",
    work_history: [
      { event: "claimed_new", ts: "2026-11-10T21:05:36.711Z" },
      { event: "credit_refunded", ts: "2026-11-10T21:08:40.462Z" }
    ],
    workflow: {
      assigned_to: { email: "first@example.com" },
      assigned_at: "2026-11-10T21:05:36.711Z",
      history: [{ event: "claimed_new", ts: "2026-11-10T21:05:36.711Z" }]
    },
    timestamps: {
      created_at: "2026-11-10 21:05:29",
      started_at: "2026-11-10T21:05:36.711Z",
      rejected_at: "2026-11-10 21:08:40"
    }
  };
  let patch: any = null;
  const ctx = vm.createContext({
    readManifest: async () => structuredClone(existing),
    patchManifest: async (_id: string, value: any) => { patch = value; return value; },
    resolveOrderReportPreferences: async () => ({}),
    asRecord: (x: any) => x && typeof x === "object" && !Array.isArray(x) ? x : {},
    toSqlDateString: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
    badRequest: (code: string) => new Error(code),
    Date, String, Boolean, Array
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  await vm.runInContext("reopenRejectedProjectForReorder('fixture', { project_type: 'commercial' }, {})", ctx);

  assert.equal(patch.status, "queued");
  assert.equal(patch.timestamps.started_at, null);
  assert.equal(patch.timestamps.created_at, "2026-11-10 21:05:29");
  assert.equal(patch.workflow.assigned_to, null);
  assert.equal(patch.workflow.assigned_at, null);
  assert.equal(patch.work_history.at(-1).event, "reordered_rejected_project");
  assert.match(patch.work_history.at(-1).ts, /Z$/, "the reset point the editor reads carries its time zone");
});
