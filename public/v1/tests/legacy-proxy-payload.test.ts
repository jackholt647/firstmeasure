import httpProxy from "@fastify/http-proxy";
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { legacyProxyReplyOptions } from "../src/app.js";

test("cluster proxy forwards parsed URL-encoded legacy actions without a 500", async (t) => {
  const upstream = Fastify();
  upstream.post("/v1/internal/legacy-action", async (request) => ({
    ok: true,
    content_type: request.headers["content-type"],
    body: request.body
  }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => upstream.close());

  const address = upstream.server.address();
  assert.ok(address && typeof address === "object");

  const proxy = Fastify();
  proxy.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  await proxy.register(httpProxy, {
    upstream: `http://127.0.0.1:${address.port}`,
    prefix: "/v1/internal",
    rewritePrefix: "/v1/internal",
    handler: (request, reply, destination, options) =>
      reply.from(destination, legacyProxyReplyOptions(request, options))
  });
  t.after(async () => proxy.close());

  const response = await proxy.inject({
    method: "POST",
    url: "/v1/internal/legacy-action",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "action=admin_adjust_org_credits&org_id=org_test&amount=100"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    content_type: "application/json",
    body: {
      action: "admin_adjust_org_credits",
      org_id: "org_test",
      amount: "100"
    }
  });
});
