import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../measure/internal/portal_scripts/manager_review.js", import.meta.url), "utf8");
const wireSource = source.slice(source.indexOf("  function wireUIOnce(){"), source.indexOf("  // ==================== INIT"));

for (const canReview of [false, true]) {
  test(`QA Quality wires both workspaces when blind permission is ${canReview}`, () => {
    const elements = new Map<string, { onclick?: () => void; addEventListener: (event: string, listener: () => void) => void }>();
    let workspace = "";
    const context = vm.createContext({
      uiWired: false,
      document: { getElementById(id: string) {
        if (id === "mraReviewTab" && !canReview) return null;
        if (!elements.has(id)) elements.set(id, { addEventListener(_event, listener) { this.onclick = listener; } });
        return elements.get(id);
      } },
      window: { addEventListener() {} },
      handleKeyDown() {},
      switchWorkspace(name: string) { workspace = name; }
    });
    vm.runInContext(wireSource + "\nwireUIOnce();", context);
    elements.get("mraResultsTab")?.onclick?.();
    assert.equal(workspace, "results");
    if (canReview) {
      elements.get("mraReviewTab")?.onclick?.();
      assert.equal(workspace, "review");
    }
  });
}

test("rapid QA Quality tab revisits reuse one load and retain a response received offscreen", async () => {
  const loadSource = source.slice(source.indexOf("  async function loadAllData("), source.indexOf("  // ==================== SLIDES"));
  let requests = 0;
  let resolveRequest: (value: unknown) => void = () => {};
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const context = vm.createContext({
    document: { getElementById: () => ({ innerHTML: "" }) },
    apiPost: () => { requests++; return response; },
    localDate: () => "2026-09-09", deriveTechs() {}, renderTechList() {}, esc: String
  });
  vm.runInContext("let queueLoadPromise=null,queueLoadedAt=0,loadSeq=0,inView=false,allProjects=[],dailySample={};\n" + loadSource, context);
  const first = vm.runInContext("loadAllData()", context);
  const revisit = vm.runInContext("loadAllData()", context);
  assert.equal(requests, 1);
  resolveRequest({ success: true, projects: [{ id: "kept-result" }], sample: {} });
  await Promise.all([first, revisit]);
  assert.equal(vm.runInContext("allProjects[0].id", context), "kept-result");
  await vm.runInContext("inView=true;loadAllData()", context);
  assert.equal(requests, 1, "a rapid return should render the retained result");
  await vm.runInContext("loadAllData(true)", context);
  assert.equal(requests, 2, "explicit Refresh bypasses the short revisit cache");
});
