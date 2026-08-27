import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const nodeA = process.env.CLUSTER_NODE_A_URL || "http://127.0.0.1:3211";
const nodeB = process.env.CLUSTER_NODE_B_URL || "http://127.0.0.1:3212";
const loadBalancer = process.env.CLUSTER_LB_URL || "http://127.0.0.1:8088";

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

for (const [name, base] of [["node A", nodeA], ["node B", nodeB], ["load balancer", loadBalancer]]) {
  const { response, body } = await jsonRequest(base, "/v1/health/ready");
  assert.equal(response.status, 200, `${name} readiness failed: ${JSON.stringify(body)}`);
}

const portal = await fetch(`${loadBalancer}/portal/`);
assert.ok(portal.status < 500, `PHP portal returned HTTP ${portal.status}`);
assert.match(await portal.text(), /FirstMeasure|FirstMate|Sign In|Log In/i, "PHP portal did not render recognizable application content");

const nonce = randomBytes(5).toString("hex");
const registration = await jsonRequest(nodeA, "/v1/platform/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: `cluster-${nonce}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Cluster Acceptance",
    phone: `+1 555 ${nonce.slice(0, 3).replace(/[a-f]/g, "2")} ${nonce.slice(3, 7).replace(/[a-f]/g, "3")}`
  })
});
assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
const setCookies = typeof registration.response.headers.getSetCookie === "function"
  ? registration.response.headers.getSetCookie()
  : [registration.response.headers.get("set-cookie") || ""];
const cookie = setCookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
assert.ok(cookie.includes("fm_platform_session="), "registration did not return a session cookie");

const throughB = await jsonRequest(nodeB, "/v1/platform/auth/session", { headers: { cookie } });
assert.equal(throughB.response.status, 200, JSON.stringify(throughB.body));
assert.equal(throughB.body.authenticated, true);
assert.equal(throughB.body.identity.email, `cluster-${nonce}@example.test`);
const orgId = String(throughB.body.organization.id);
const csrf = String(throughB.body.csrf_token || "");
assert.ok(csrf);

const form = new FormData();
form.append("file", new Blob([`shared-object-${nonce}`], { type: "text/plain" }), "cluster.txt");
form.append("owner_type", "organization");
form.append("owner_id", orgId);
form.append("slot", "cluster-acceptance");
form.append("collection", "cluster-tests");
form.append("thumbnails", "false");
const uploaded = await jsonRequest(nodeB, `/v1/platform/organizations/${encodeURIComponent(orgId)}/media`, {
  method: "POST",
  headers: { cookie, "x-platform-csrf": csrf },
  body: form
});
assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
const mediaId = String(uploaded.body.media.id);

const downloaded = await fetch(`${nodeA}/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/file`, { headers: { cookie } });
assert.equal(downloaded.status, 200);
assert.equal(await downloaded.text(), `shared-object-${nonce}`);

const lbIdentities = new Set();
for (let index = 0; index < 12; index += 1) {
  const result = await jsonRequest(loadBalancer, "/v1/health/live", { headers: { connection: "close" } });
  assert.equal(result.response.status, 200);
  lbIdentities.add(String(result.body.instance_id || ""));
}
assert.ok(lbIdentities.size >= 2, `load balancer did not exercise both web nodes: ${[...lbIdentities].join(", ")}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  session_created_on: "local-web-a",
  session_read_on: "local-web-b",
  object_uploaded_on: "local-web-b",
  object_read_on: "local-web-a",
  php_portal_status: portal.status,
  load_balancer_instances_observed: [...lbIdentities]
}, null, 2)}\n`);
