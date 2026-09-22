import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";

test("code reports API exposes source metadata", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/code-reports/sources" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.ok(body.sources.some((source: { id: string }) => source.id === "usgs-designmaps"));
    assert.ok(body.sources.some((source: { id: string }) => source.id === "fema-nfhl"));
  } finally {
    await app.close();
  }
});
