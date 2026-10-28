import assert from "node:assert/strict";
import test from "node:test";

// The config library kinds of guided experiences, tab promos and app welcomes (config-library/kinds/): the checked-in
// snapshot passes its own checks, and a broken edit is refused for what it names.
process.env.CONFIG_LIBRARY_SOURCE = "snapshot";
const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
const { checkEntry } = await import("../config-library/writes.js");
const { libraryEntries, libraryCopy } = await import("../config-library/library.js");
const { libraryKind } = await import("../config-library/kinds.js");
registerAllLibraryKinds();
const errors = (kind: string, id: string, data: unknown) => checkEntry(kind, id, data, null).errors.join(" ");

test("every snapshot entry of these kinds passes its kind's checks", () => {
  const counts: Record<string, number> = {};
  for (const kind of ["guided_experience", "guided_tab_faqs", "setup_step", "tab_promo", "app_welcome"]) {
    for (const entry of libraryEntries(kind)) assert.equal(errors(kind, entry.id, structuredClone(entry.data)), "", `${kind}/${entry.id}`);
    counts[kind] = libraryEntries(kind).length;
  }
  assert.deepEqual(counts, { guided_experience: 11, guided_tab_faqs: 7, setup_step: 2, tab_promo: 1, app_welcome: 8 });
});

test("guided_experience: sources, actions, capabilities, setup steps and other experiences must exist", () => {
  const setup = libraryCopy<any>("guided_experience", "materials.pricebook_setup.roofing")!;
  assert.match(errors("guided_experience", "other.id", setup), /not the entry's id/);
  assert.match(errors("guided_experience", setup.id, { ...setup, steps: setup.steps.map((step: any, i: number) => (i ? step : { ...step, source: "no.such_source" })) }), /guided source no\.such_source is not registered/);
  assert.match(errors("guided_experience", setup.id, { ...setup, completion: { ...setup.completion, action: { id: "no.such.action", target: "organization", input: {} } } }), /not a published action/);
  assert.match(errors("guided_experience", setup.id, { ...setup, eligibility: { ...setup.eligibility, capabilities: ["platform.nope"] } }), /not a registered capability/);
  assert.match(errors("guided_experience", setup.id, { ...setup, completion: { ...setup.completion, then: [{ play: "no.such_tour" }] } }), /not an experience/);
  const operations = libraryCopy<any>("guided_experience", "operations.setup")!;
  assert.match(errors("guided_experience", operations.id, { ...operations, requires: ["company.nope"] }), /not a setup step/);
  assert.match(errors("guided_experience", "setup_step.company.type", { ...operations, id: "setup_step.company.type" }), /played from setup steps/);
  assert.match(errors("guided_experience", setup.id, { ...setup, kind: "overlay" }), /does not suit/, "the experience schema still holds");
});

test("setup_step: its export and action are published, its requirements exist and never go in a circle", () => {
  const type = libraryCopy<any>("setup_step", "company.type")!;
  assert.match(errors("setup_step", "company.type", { ...type, satisfied: { provider: "company-profile", export: "nope" } }), /not a published export/);
  assert.match(errors("setup_step", "company.type", { ...type, writes: { action: "no.such.action" } }), /not a published action/);
  assert.match(errors("setup_step", "company.type", { ...type, requires: ["company.services"] }), /circle/);
  assert.match(errors("setup_step", "company.type", { ...type, requires: ["company.nope"] }), /not a setup step/);
});

test("guided_copy: a library string, never copy an entry already holds", () => {
  assert.equal(errors("guided_copy", "gx_ui_back", { text: "Back" }), "");
  assert.match(errors("guided_copy", "gx_mps_makers_title", { text: "Brands" }), /edit it there/);
  assert.match(errors("guided_copy", "gx_ui_back", { text: "<b>Back</b>" }), /plain text/);
  assert.match(errors("guided_copy", "not_a_key", { text: "Back" }), /not a valid/);
});

test("tab_promo and app_welcome: capabilities, assets and offered apps", () => {
  const promo = libraryCopy<any>("tab_promo", "materials_promo")!;
  assert.match(errors("tab_promo", "materials_promo", { ...promo, flag: "platform.nope" }), /not a registered capability/);
  assert.match(errors("tab_promo", "materials_promo", { ...promo, content: { ...promo.content, images: [{ ...promo.content.images[0], src: "/libraries/x.png" }, promo.content.images[1]] } }), /library asset/);
  assert.equal(libraryKind("tab_promo")!.browser, true, "pages read promos directly");
  assert.deepEqual(libraryKind("tab_promo")!.assetsOf!(promo).length, 2);
  const welcome = libraryCopy<any>("app_welcome", "project.money")!;
  assert.match(errors("app_welcome", "project.nope", welcome), /not an offered app/);
  assert.match(errors("app_welcome", "project.money", { ...welcome, setup: "platform.nope" }), /not a registered capability/);
  assert.match(errors("app_welcome", "project.money", { ...welcome, theme: "rainbow" }), /theme/);
});
