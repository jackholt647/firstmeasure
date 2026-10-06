import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scopeItemPriceResult } from "../proposals/scope.js";
import { evaluateQuantityFormula, generatePieceScope, normalizeScopeMeasurements } from "../pricebook/scope-generation.js";

const record = (value: unknown) => value as Record<string, any>;
const catalog = JSON.parse(readFileSync(new URL("../../libraries/pricebook/default-pricebook.json", import.meta.url), "utf8"));
const measurements = { roofSquares: 29.6, wastePercent: 10, eavesLf: 197.25, rakesLf: 208.6, ridgesLf: 93.4, hipsLf: 0, valleyLf: 16.2 };
const refId = (item: Record<string, any>) => String(item.pricebook_ref?.item_id || "");

test("quantity formulas evaluate tokens with precedence, waste and missing measurements as zero", () => {
  const tokens = (...parts: Array<[string, string]>) => ({ tokens: parts.map(([type, value]) => ({ type, value })) });
  assert.equal(evaluateQuantityFormula(tokens(["measurement", "eavesLf"], ["operator", "+"], ["measurement", "rakesLf"]), { eavesLf: 197.25, rakesLf: 208.6 }), 405.85);
  assert.equal(evaluateQuantityFormula(tokens(["paren", "("], ["number", "2"], ["operator", "+"], ["number", "4"], ["paren", ")"], ["operator", "/"], ["number", "4"], ["operator", "+"], ["measurement", "missing"]), {}), 1.5);
  assert.equal(evaluateQuantityFormula({ ...tokens(["measurement", "shingleSquares"]), includeWaste: true }, { shingleSquares: 29.6, wastePercent: 10 }), 32.56);
  assert.equal(evaluateQuantityFormula(tokens(["number", "1"], ["operator", "/"], ["number", "0"]), {}), 0, "division by zero yields zero");
  assert.equal(evaluateQuantityFormula(tokens(["operator", "*"], ["number", "3"]), {}), 0, "a malformed formula yields zero");
});

test("a bare roof total counts as shingle area and is not rounded", () => {
  const normalized = normalizeScopeMeasurements(measurements);
  assert.equal(normalized.roofSquares, 29.6);
  assert.equal(normalized.shingleSquares, 29.6);
  assert.equal(normalizeScopeMeasurements({ pitch4to6Squares: 20.4, pitch6to8Squares: 8.2, flatRoofSquares: 1, roofSquares: 29.6 }).shingleSquares, 28.6);
});

test("roof replacement scope prices from measurements and groups interchangeable products", () => {
  const root = record(generatePieceScope(catalog, "roof_replacement", measurements));
  const children = root.children as Array<Record<string, any>>;
  assert.equal(refId(root), "roof_replacement");

  const starter = children.find((child) => refId(child) === "starter")!;
  assert.equal(starter.quantity, "405.85", "starter follows measured eaves + rakes without rounding");
  assert.equal(starter.included, true);

  const groups = new Map<string, Array<Record<string, any>>>();
  for (const child of children) {
    if (child.selection?.mode !== "choice") continue;
    groups.set(child.selection.group_id, [...(groups.get(child.selection.group_id) || []), child]);
  }
  assert.deepEqual([...groups.keys()].sort(), ["leak_barrier_profile", "shingle_profile", "underlayment_profile"]);
  for (const [group, options] of groups) {
    assert.equal(options.filter((option) => option.selection.selected === true).length, 1, `${group} prices exactly one option`);
    assert.ok(options.every((option) => option.included === false), `${group} options carry their own price`);
    assert.ok(options.some((option) => option.selection.selectable_by.includes("customer")), `${group} offers the customer a choice`);
  }
  const shingle = groups.get("shingle_profile")!.find((option) => option.selection.selected)!;
  assert.equal(refId(shingle), "gaf_hd");
  assert.equal(shingle.quantity, "32.56", "29.6 squares plus 10% waste");

  // The total is the sum of the selected lines, by the document pricing rule.
  const selectedSum = children.reduce((sum, child) => sum + scopeItemPriceResult(child).amount_cents, 0);
  assert.equal(scopeItemPriceResult(root).amount_cents, selectedSum);
  assert.ok(selectedSum > 0);
});

test("unsupported pieces and missing assemblies fail explicitly", () => {
  assert.throws(() => generatePieceScope(catalog, "kitchen_remodel", measurements), /not available/);
  assert.throws(() => generatePieceScope({ items: [] }, "roof_replacement", measurements), /assembly/);
});
