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
