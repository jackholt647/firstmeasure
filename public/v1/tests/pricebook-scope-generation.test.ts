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
  assert.equal(starter.base_quantity, 405.85, "the formula value keeps the measured decimals");
  assert.equal(starter.quantity, "406", "lengths round up to whole feet");
  assert.deepEqual(starter.quantity_adjustments, [], "starter takes no waste");
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
  assert.equal(shingle.base_quantity, 29.6);
  assert.deepEqual(shingle.quantity_adjustments.map((entry: any) => [entry.id, entry.operation, entry.value]), [["waste", "percent", 10]]);
  assert.deepEqual(shingle.quantity_rounding, { mode: "up", decimals: 0 });
  assert.equal(shingle.quantity, "33", "29.6 squares plus 10% waste is 32.56, bought as 33");
  assert.deepEqual(root.quantity_modifiers.map((modifier: any) => [modifier.id, modifier.variable, modifier.value]), [["waste", "wastePercent", 10]]);

  // The total is the sum of the selected lines, by the document pricing rule.
  const selectedSum = children.reduce((sum, child) => sum + scopeItemPriceResult(child).amount_cents, 0);
  assert.equal(scopeItemPriceResult(root).amount_cents, selectedSum);
  assert.ok(selectedSum > 0);
});

test("a price book can declare its own modifiers and per-item rounding", () => {
  const custom = {
    ...catalog,
    quantity_modifiers: [{ id: "overage", label: "Overage", operation: "add", value: 2, applies_to: { item_ids: ["starter"] } }],
    items: catalog.items.map((item: any) => item.id === "starter" ? { ...item, quantity_rounding: { mode: "nearest", decimals: 1 } } : item)
  };
  const root = record(generatePieceScope(custom, "roof_replacement", measurements));
  const starter = (root.children as Array<Record<string, any>>).find((child) => refId(child) === "starter")!;
  assert.equal(starter.quantity, "407.9", "405.85 + 2, to one decimal");
  assert.equal(starter.quantity_adjustments[0].badge, "O");
  const shingle = (root.children as Array<Record<string, any>>).find((child) => refId(child) === "gaf_hd")!;
  assert.equal(shingle.quantity, "30", "waste no longer applies once the book declares its own modifiers");
});

test("unsupported pieces and missing assemblies fail explicitly", () => {
  assert.throws(() => generatePieceScope(catalog, "kitchen_remodel", measurements), /not available/);
  assert.throws(() => generatePieceScope({ items: [] }, "roof_replacement", measurements), /assembly/);
});

test("the bundled template offers the GAF lines, more by search, with colors and a finish on the line", async () => {
  const { DEFAULT_PRICEBOOK_TEMPLATE } = await import("../pricebook/default_template.js");
  const { choiceGroupCandidates } = await import("../pricebook/scope-generation.js");
  const book = DEFAULT_PRICEBOOK_TEMPLATE.catalog;
  const root = record(generatePieceScope(book, "roof_replacement", measurements));
  const shingles = (root.children as Array<Record<string, any>>).filter((child) => child.selection?.group_id === "shingle_profile");
  assert.deepEqual(shingles.map(refId), ["gaf_ns", "gaf_hd", "gaf_uhdz"], "a new proposal starts with the three GAF lines");
  assert.equal(shingles.filter((line) => line.selection.selected).map(refId).join(), "gaf_hd");
  assert.ok(!(root.children as Array<Record<string, any>>).some((child) => child.selection?.group_id === "underlayment_profile"), "one underlayment is a line, not a choice");

  const hdz = shingles.find((line) => refId(line) === "gaf_hd")!;
  assert.deepEqual(hdz.variant_dimensions.map((dimension: any) => [dimension.id, dimension.kind, dimension.values.length]), [["color", "color", 8], ["finish", "option", 2]]);
  assert.deepEqual(hdz.selected_variants, { color: "charcoal", finish: "standard" });
  assert.equal(hdz.variant_base_price, 398);
  assert.equal(hdz.variant_offered.color.length, 8, "every color is offered until some are switched off");
  const cool = hdz.variant_dimensions[1].values.find((value: any) => value.id === "cool");
  assert.deepEqual(cool.adjustment, { operation: "add", value: 38 });
  assert.ok(cool.excludes.color.includes("charcoal"), "the reflective finish rules out colors it is not made in");
  assert.match(hdz.variant_dimensions[0].values[0].hex, /^#[0-9a-f]{6}$/);

  const candidates = choiceGroupCandidates(book, "roof_replacement", "piece_roof_replacement:shingle_profile", measurements).map(record);
  assert.deepEqual(candidates.map(refId).sort(), ["gaf_hd", "gaf_ns", "gaf_uhdz", "laminated_shingles", "malarkey_vista", "owens_duration", "three_tab_shingles"]);
  assert.ok(candidates.every((line) => line.selection.mode === "choice" && line.selection.selected === false && line.quantity === "33"));
  assert.ok(!candidates.some((line) => ["starter", "underlayment", "ridge_cap"].includes(refId(line))), "only shingles, though the category holds more");
  assert.throws(() => choiceGroupCandidates(book, "roof_replacement", "gutters", measurements), /not a choice group/);
});
