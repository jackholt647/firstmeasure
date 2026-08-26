import assert from "node:assert/strict";
import test from "node:test";

import { customerDashboardRowMatches } from "../internal/api.js";

test("customer dashboard email filter matches users and organization contacts", () => {
  const row = {
    id: "org_example",
    name: "Example Roofing",
    contact: { email: "billing@example.test" },
    users: [
      { name: "Customer Admin", email: "admin@example.test" }
    ]
  };

  assert.equal(customerDashboardRowMatches(row, { email: "ADMIN@EXAMPLE" }, ""), true);
  assert.equal(customerDashboardRowMatches(row, { email: "billing@example" }, ""), true);
  assert.equal(customerDashboardRowMatches(row, { email: "missing@example.test" }, ""), false);
});
