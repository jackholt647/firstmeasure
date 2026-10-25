/**
 * The PHP half of docs/architecture/request-security.md: PHP's service
 * signature verifies with Node's verifier, the PHP helpers refuse what they
 * should (tests/request-security-php.test.php), and the nginx templates keep
 * their deny rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";
import { rememberRawBody, verifyServiceSignature } from "../platform/security/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../..");
const deployRoot = path.resolve(publicRoot, "../deploy/digitalocean");
const binary = spawnSync("php", ["-r", "echo PHP_BINARY;"], { encoding: "utf8" }).stdout.trim();
const extensions = process.platform === "win32" && binary ? ["-d", `extension_dir=${path.join(path.dirname(binary), "ext")}`, "-d", "extension=curl"] : [];
const secret = "php-node-signature-test-secret";

function phpSign(method: string, url: string, actor: string, body: string | null, multipart = false) {
  const script = [
    "ini_set('log_errors','0');",
    `require ${JSON.stringify(path.join(publicRoot, "includes/node_api.php").replace(/\\/g, "/"))};`,
    "$in = json_decode(stream_get_contents(STDIN), true);",
    "echo json_encode(fm_node_signature_headers($in['method'], $in['url'], $in['actor'], $in['body'], $in['multipart']));"
  ].join(" ");
  const result = spawnSync(binary, [...extensions, "-r", script], {
    input: JSON.stringify({ method, url, actor, body, multipart }),
    encoding: "utf8",
    env: { ...process.env, FIRSTMEASURE_NODE_SIGNING_SECRET: secret, PROVIDER_KEYS_PATH: path.join(here, "missing-provider-keys.json") }
  });
  assert.equal(result.status, 0, result.stderr);
  const headers: Record<string, string> = {};
  for (const line of JSON.parse(result.stdout) as string[]) {
    const index = line.indexOf(": ");
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 2);
  }
  return headers;
}

function fakeRequest(method: string, url: string, headers: Record<string, string>, body?: string) {
  const request = { method, url, headers } as unknown as FastifyRequest;
  if (body != null) rememberRawBody(request, Buffer.from(body));
  return request;
}

test("a PHP-signed request verifies with Node's verifier, and only as sent", { skip: !binary && "PHP CLI is not installed" }, () => {
  const get = phpSign("GET", "https://app.1m8.ai/v1/internal/users/staff%40example.test?team=a&x=1", "Staff@Example.test", null);
  assert.equal(verifyServiceSignature(fakeRequest("GET", "/v1/internal/users/staff%40example.test?team=a&x=1", get), secret), "staff@example.test");
  assert.equal(verifyServiceSignature(fakeRequest("GET", "/v1/internal/users/other%40example.test?team=a&x=1", get), secret), null, "path is bound");
  assert.equal(verifyServiceSignature(fakeRequest("GET", "/v1/internal/users/staff%40example.test?team=b&x=1", get), secret), null, "query is bound");
  assert.equal(verifyServiceSignature(fakeRequest("GET", "/v1/internal/users/staff%40example.test?team=a&x=1", get), "another-secret"), null);

  const body = JSON.stringify({ amount: 7, reason: "QA rejection refund" });
  const post = phpSign("POST", "http://10.124.16.12/v1/internal/organizations/org_1/credits/adjust", "system", body);
  const postHeaders = { ...post, "content-type": "application/json" };
  assert.equal(verifyServiceSignature(fakeRequest("POST", "/v1/internal/organizations/org_1/credits/adjust", postHeaders, body), secret), "system");
  assert.equal(verifyServiceSignature(fakeRequest("POST", "/v1/internal/organizations/org_1/credits/adjust", postHeaders, body.replace("7", "700")), secret), null, "body is bound");

  const upload = phpSign("POST", "http://127.0.0.1:3111/v1/firstmeasure/projects/abc/artifacts", "staff@example.test", null, true);
  assert.equal(upload["x-fm-service-body-sha256"], "UNSIGNED-PAYLOAD");
  assert.equal(verifyServiceSignature(fakeRequest("POST", "/v1/firstmeasure/projects/abc/artifacts", { ...upload, "content-type": "multipart/form-data; boundary=x" }), secret), "staff@example.test");
  assert.equal(verifyServiceSignature(fakeRequest("POST", "/v1/firstmeasure/projects/abc/artifacts", { ...upload, "content-type": "application/json" }, "{}"), secret), null, "only multipart may be unsigned");
});

test("PHP request-security helpers refuse what they should", { skip: !binary && "PHP CLI is not installed" }, () => {
  const result = spawnSync(binary, [...extensions, path.join(here, "request-security-php.test.php")], { encoding: "utf8", env: { ...process.env, FIRSTMEASURE_API_BASE: "", FIRSTMEASURE_NODE_BASE_URL: "" } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /request-security PHP checks passed/);
});

test("PHP never sends X-Internal-User identity or turns TLS verification off", () => {
  const files = [
    "includes/node_api.php", "measure/internal/backend_login.php", "measure/internal/index.php", "measure/internal/editor.php",
    "measure/internal/data_agent.php", "measure/internal/tutorial_audit.php", "measure/internal/_tutorial_access.php",
    "measure/internal/firstmeasure_node.php", "measure/internal/top_view_reroll_proxy.php", "measure/internal/server.php",
    "portal/session_bootstrap.php", "portal/stripe_webhook.php", "portal/stripe_create_checkout.php", "portal/image_proxy.php"
  ];
  for (const file of files) {
    const source = readFileSync(path.join(publicRoot, file), "utf8");
    assert.doesNotMatch(source, /X-Internal-User-/i, file);
    assert.doesNotMatch(source, /CURLOPT_SSL_VERIFY(PEER|HOST)\s*=>\s*(false|0)\b|'verify_peer(_name)?'\s*=>\s*false/, file);
    assert.doesNotMatch(source, /CURLOPT_FOLLOWLOCATION\s*=>\s*true|'follow_location'\s*=>\s*1/, file);
  }
});

test("every staff entry point under /measure/internal uses the Node-verified staff gate", () => {
  for (const file of ["index.php", "editor.php", "data_agent.php", "full_house.php", "project_resources.php", "top_view_reroll_proxy.php", "tutorial_audit.php", "tutorial_sources.php", "exterior_ai.php", "apple_endpoint.php", "backend_login.php"]) {
    const source = readFileSync(path.join(publicRoot, "measure/internal", file), "utf8");
    assert.match(source, /_staff_session\.php/, file);
    assert.doesNotMatch(source, /^\s*session_start\(\);/m, `${file} starts its session through the secure helper`);
    assert.match(source, /fm_internal_require_staff|fm_staff_session_resolve|fm_staff_refresh_from_node/, file);
  }
  assert.ok(!readFileSync(path.join(publicRoot, "measure/internal/backend_login.php"), "utf8").includes("session_regenerate_id(true);\n    $_SESSION['is_impersonating'] = true;\n    $_SESSION['impersonating_from_email'] = $adminEmail;\n    $_SESSION['impersonating_from_name'] = (string)($admin['name']"), "impersonation is Node's mark");
});

test("nginx templates refuse unknown hosts, retired code and dotfiles", () => {
  for (const name of ["nginx-web.conf.template", "nginx-legacy.conf", "nginx-development-web.conf", "nginx-development-legacy.conf"]) {
    const config = readFileSync(path.join(deployRoot, name), "utf8");
    assert.match(config, /listen 80 default_server;\s*\n\s*server_name _;[\s\S]*?location \/ \{ return 444; \}/, `${name}: default server closes unknown hosts`);
    assert.equal((config.match(/default_server/g) ?? []).length, 1, `${name}: one default server`);
    assert.match(config, /location ~ \(\^\|\/\)unused\/ \{ return 404; \}/, `${name}: unused/`);
    assert.match(config, /location ~ \/\\\.\(\?!well-known\/\) \{ return 404; \}/, `${name}: dotfiles`);
    assert.match(config, /\(bak\|orig/, `${name}: backups`);
    assert.match(config, /add_header X-Content-Type-Options nosniff always;/, `${name}: nosniff`);
    const named = config.slice(config.indexOf("location / { return 444; }"));
    const unusedDeny = named.indexOf("unused/ { return 404; }");
    const php = named.indexOf("location ~ \\.php$ {\n        try_files");
    assert.ok(unusedDeny > 0 && php > unusedDeny, `${name}: deny rules come before the PHP handler`);
  }
  for (const name of ["nginx-web.conf.template", "nginx-legacy.conf"]) {
    const config = readFileSync(path.join(deployRoot, name), "utf8");
    for (const tool of ["api.php", "ide.php", "add_user.php"]) assert.match(config, new RegExp(`location = /${tool.replace(".", "\\.")} \\{ return 404; \\}`), `${name}: production denies ${tool}`);
  }
});
