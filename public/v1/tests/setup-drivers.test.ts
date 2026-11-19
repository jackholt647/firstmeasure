import assert from "node:assert/strict";
import test from "node:test";
import { opensOf } from "../development/setup-drivers.js";

// What drives setup (development/setup-drivers.ts): a page that only opens one other setup (`options.card`) makes its
// setup a launcher, which the diagram shows on the setup it opens rather than as a second setup (GP-59: the Operations
// tab's Equipment Setup tag was a second "Equipment" beside "Set up your equipment").
test("a page names the setups it opens; one card on its own is a launcher", () => {
  const setups = [
    { id: "suppliers", experience: "operations.suppliers.setup" },
    { id: "equipment", experience: "equipment.setup", appId: "portal.equipment" },
    { id: "workforce", minutes: 5 }
  ];
  assert.deepEqual(opensOf({ id: "ready", options: { setups } }), { opens: ["operations.suppliers.setup", "equipment.setup"], only: false });
  assert.deepEqual(opensOf({ id: "equipment", options: { card: "equipment", setups } }), { opens: ["equipment.setup"], only: true });
  // A card that names no setup opens nothing the diagram can show, so it is not a launcher.
  assert.deepEqual(opensOf({ id: "workforce", options: { card: "workforce", setups } }), { opens: [], only: false });
  assert.deepEqual(opensOf({ id: "tour", selector: ".x" }), { opens: [], only: false });
});
