import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("historical QA Quality queue entries hydrate manifests without editor artifacts", async () => {
  const source = await readFile(new URL("../internal/api.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async function managerReviewData("), source.indexOf("function managerReviewAggregate("));
  const script = ts.transpileModule(method, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sampleDate = "2026-09-09";
  const sample = { id: sampleDate, data: { sample_date: sampleDate, entries: [{ project_id: "old-sample" }] } };
  const rejectedBacklog = { id: "2026-09-08", data: { sample_date: "2026-09-08", entries: [{ project_id: "rejected-old" }, { project_id: "no-coverage-old" }] } };
  let manifestReads = 0, artifactBundleReads = 0, sampleWrites = 0, failHydration = false;
  const context = vm.createContext({
    requireManagerReviewResultsAccess: async () => {}, requireManagerReviewAccess: async () => {},
    managerReviewSettings: async () => ({ daily_target: 1 }), managerReviewSampleDate: () => sampleDate,
    managerReviewQueryProjects: async () => [], listInternalDocuments: async () => [sample, rejectedBacklog],
    managerReviewDatesAfter: () => [],
    managerReviewDocumentData: (value: { data?: unknown } | undefined) => value?.data || {},
    managerReviewText: (...values: unknown[]) => values.find((value) => String(value ?? "").trim()) || "",
    managerReviewAuditRecord: () => null, managerReviewStratifiedCandidates: () => [],
    managerReviewSampleEntry: (value: unknown) => value, managerReviewProjectRow: (value: unknown) => value,
    asObject: (value: unknown) => value || {}, saveInternalDocument: async () => { sampleWrites++; return sample; },
    readIndexedProjectManifestsByIds: async (ids: string[]) => {
      manifestReads++;
      if (failHydration) throw new Error("transient database connection failure");
      return ids.map((id) => ({ id, status: id === "rejected-old" ? "rejected" : id === "no-coverage-old" ? "rejected_no_coverage" : "completed" }));
    },
    getProjectDetail: async () => { artifactBundleReads++; throw new Error("editor artifact storage unavailable"); }
  });
  vm.runInContext(script, context);
  const result = await vm.runInContext("managerReviewData({}, {}, false)", context);
  assert.equal(manifestReads, 1, "all historical IDs use a single bulk reader");
  assert.equal(artifactBundleReads, 0);
  assert.equal(result.projects[0].id, "old-sample");
  assert.equal(result.projects.length, 1, "rejected carry-over assignments must not reappear");
  assert.equal(rejectedBacklog.data.entries.length, 2, "historical sample records are retained");
  const writesBeforeFailure = sampleWrites;
  failHydration = true;
  await assert.rejects(vm.runInContext("managerReviewData({}, {}, false)", context), /transient database connection failure/);
  assert.equal(sampleWrites, writesBeforeFailure, "a transient hydration failure must never rewrite the daily sample");
});
