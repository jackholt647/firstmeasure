import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { Generator } from "./index.js";
import { TERMINOLOGY_NAMESPACE_KIND } from "../kinds/terminology_namespace.js";

/**
 * Terminology namespaces from today's seeds: the browser catalog in platform-terminology.js (its CATALOG after the
 * `additions` and relabelling it applies), the labels the generated server contract carried where a later commit
 * changed only the contract (scope.project_tab Operations, money.project_tab Financials), and the scheduling
 * library's default event type labels the catalog lacked. The scheduling `stages` labels are not terminology: no
 * code reads them (stage titles come from scope templates), so they are left out.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const libraries = path.resolve(here, "../../../libraries");
type Term = { key: string; label: string; kind: string };
type Section = { id: string; title: string; note: string; terms: Term[] };

function runBrowserScript(file: string) {
  const window: Record<string, any> = {};
  window.window = window;
  vm.runInNewContext(readFileSync(path.join(libraries, file), "utf8"), window);
  return window;
}

export const terminologyNamespaceGenerator: Generator = {
  kind: TERMINOLOGY_NAMESPACE_KIND,
  run() {
    const catalog = structuredClone(runBrowserScript("platform-terminology/platform-terminology.js").PlatformTerminology.CATALOG) as Section[];
    const contract = JSON.parse(readFileSync(path.resolve(here, "../../platform/localization/terminology-contract.json"), "utf8")) as Record<string, { label: string; kind: string }>;
    const keys = catalog.flatMap((section) => section.terms.map((item) => `${section.id}.${item.key}`));
    const contractKeys = Object.keys(contract);
    if (JSON.stringify(keys) !== JSON.stringify(contractKeys)) throw new Error("The terminology catalog and the server contract list different keys.");
    for (const section of catalog) for (const item of section.terms) {
      const declared = contract[`${section.id}.${item.key}`]!;
      if (declared.kind !== item.kind) throw new Error(`${section.id}.${item.key} has kind ${item.kind} in the catalog and ${declared.kind} in the contract.`);
      item.label = declared.label;
    }
    const scheduling = runBrowserScript("platform-scheduling/platform-scheduling.js").PlatformScheduling.DEFAULT_MAPPINGS.labels as Record<string, Record<string, string>>;
    for (const [namespace, labels] of Object.entries(scheduling)) {
      if (namespace === "stages") continue;
      const section = catalog.find((entry) => entry.id === namespace);
      if (!section) throw new Error(`Scheduling labels name a namespace the catalog lacks: ${namespace}.`);
      for (const [key, label] of Object.entries(labels)) if (!section.terms.some((item) => item.key === key)) section.terms.push({ key, label, kind: "entity" });
    }
    return catalog.map((section, index) => ({
      id: section.id,
      data: { title: section.title, note: section.note, position: index * 10, terms: section.terms.map((item) => ({ key: item.key, label: item.label, kind: item.kind })) }
    }));
  }
};
