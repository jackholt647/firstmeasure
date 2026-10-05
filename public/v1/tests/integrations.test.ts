import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomBytes, createHmac } from "node:crypto";
import {
  nextTestPhone,
  enableExpandedPlatformFixture,
  closePlatformFixtureStores,
} from "./helpers/platform-fixture.js";
let app: any,
  root: string,
  server: http.Server,
  origin: string,
  headers: any,
  org: string,
  ctx: any,
  c: any,
  d: any;
let onSlowRequest: () => void = () => {};
let releaseSlow: () => void = () => {};
let slowGate: Promise<void> = Promise.resolve();
let deltaRound = 0;
const checkpoints: string[] = [];
let refreshes = 0,
  failRefresh = false;
let writes = 0,
  failPage = false,
  rows = [
    { id: "a", amount: "12.50", unexpected: { nested: true } },
    { id: "b", amount: null },
  ];
const token = 'private-test-token-"with-quotes';
const url = (suffix: string) =>
  `/v1/integrations/organizations/${org}${suffix}`;
async function request(method: string, suffix: string, payload?: any) {
  return app.inject({ method, url: url(suffix), headers, payload });
}
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "integrations-"));
  if (process.env.TEST_POSTGRES_URL)
    Object.assign(process.env, {
      FIRSTMATE_ENV: "test",
      FIRSTMEASURE_DATABASE_MODE: "postgres",
      DATABASE_URL: process.env.TEST_POSTGRES_URL,
      POSTGRES_AUTO_MIGRATE: "true",
      FIRSTMEASURE_ARTIFACT_STORAGE: "local",
    });
  Object.assign(process.env, {
    NODE_ENV: "test",
    PLATFORM_HEARTBEAT_DISABLED: "1",
    WORK_SCHEDULER_DISABLED: "1",
    CUSTOMER_CALL_WORKER_DISABLED: "1",
    FIRSTMEASURE_JOB_WORKERS: "0",
    V1_LOG_LEVEL: "error",
    CONNECTIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OPENAI_API_KEY: "mock-key",
  });
  for (const key of [
    "PLATFORM",
    "MESSAGING",
    "CHANNELS",
    "CRM",
    "FIRSTMEASURE",
    "PRICEBOOK",
  ])
    process.env[`${key}_STORAGE_ROOT`] = path.join(root, key.toLowerCase());
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(
    root,
    "firstmeasure",
    "index.sqlite",
  );
  server = http.createServer(async (req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url === "/slow") {
      onSlowRequest();
      await slowGate;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ items: [{ id: "slow-record" }] }));
      return;
    }
    if (req.url === "/oauth/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const values = new URLSearchParams(body);
      if (values.get("grant_type") === "refresh_token") {
        refreshes++;
        if (failRefresh) {
          req.socket.destroy();
          return;
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          access_token: token,
          refresh_token: "rotating-refresh",
          expires_in: 3600,
        }),
      );
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end("secret error body");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/changes")) {
      checkpoints.push(
        new URL(req.url, origin).searchParams.get("since") || "",
      );
      res.end(
        JSON.stringify(
          deltaRound++ === 0
            ? { items: [{ id: "a" }, { id: "b" }], checkpoint: "watermark-1" }
            : {
                items: [
                  { id: "a", deleted: true },
                  { id: "c", strange: 7 },
                ],
                checkpoint: "watermark-2",
              },
        ),
      );
      return;
    }
    if (req.url?.startsWith("/records")) {
      if (req.url.includes("cursor=page2")) {
        if (failPage) {
          res.writeHead(503);
          res.end("not available");
        } else res.end(JSON.stringify({ items: rows.slice(1), next: null }));
      } else
        res.end(
          JSON.stringify({
            items: rows.slice(0, 1),
            next: rows.length > 1 ? "page2" : null,
          }),
        );
      return;
    }
    if (req.url === "/echo") {
      res.end(JSON.stringify({ token, unusual: ["a", 3, null] }));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/private" });
      res.end();
      return;
    }
    if (req.url === "/create" && req.method === "POST") {
      writes++;
      let body = "";
      for await (const chunk of req) body += chunk;
      res.end(JSON.stringify({ id: "created-" + writes, ...JSON.parse(body) }));
      return;
    }
    if (req.url === "/uncertain") {
      writes++;
      req.socket.destroy();
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  (await import("../integrations/transport.js")).allowFixtureOrigin(origin);
  app = await (await import("../src/app.js")).buildApp();
  await app.ready();
  const registered = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: {
      phone: nextTestPhone(),
      email: "integrations@example.test",
      password: "correct horse battery staple",
      name: "Connections Owner",
      company: "Connections Test",
      organization_id: "integration_test",
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  org = registered.json().organization.id;
  const cookies = (
    Array.isArray(registered.headers["set-cookie"])
      ? registered.headers["set-cookie"]
      : [registered.headers["set-cookie"]]
  ).map((s: string) => s.split(";")[0]!);
  headers = {
    cookie: cookies.join("; "),
    "x-csrf-token": decodeURIComponent(
      cookies
        .find((s: string) => s.startsWith("fm_platform_session_csrf="))!
        .split("=")[1]!,
    ),
  };
  await enableExpandedPlatformFixture(org);
  const users = await (
    await import("../platform/storage.js")
  ).listDocuments(org, "users");
  ctx = await (
    await import("../platform/auth.js")
  ).backgroundAuthContext(org, users[0]!.id);
  assert.equal(
    (await import("../integrations/storage.js")).db().isPostgres,
    Boolean(process.env.TEST_POSTGRES_URL),
  );
  d = {
    name: "Messy supplier",
    baseUrl: origin,
    auth: { kind: "bearer" },
    credentialFields: [{ key: "token", label: "API key" }],
    operations: [
      {
        id: "records",
        title: "Read records",
        effect: "read",
        request: { path: "/records", query: { cursor: "{{cursor}}" } },
      },
      {
        id: "echo",
        title: "Read an inconsistent response",
        effect: "read",
        request: { path: "/echo" },
      },
      {
        id: "redirect",
        title: "Redirect attempt",
        effect: "read",
        request: { path: "/redirect" },
      },
      {
        id: "create",
        title: "Create record",
        effect: "write",
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        request: {
          method: "POST",
          path: "/create",
          body: { name: "{{name}}" },
        },
      },
      {
        id: "uncertain",
        title: "Uncertain write",
        effect: "write",
        request: { method: "POST", path: "/uncertain" },
      },
    ],
    resources: [
      {
        id: "records",
        title: "Supplier records",
        operation: "records",
        itemsPath: "items",
        cursorPath: "next",
        schema: {
          type: "object",
          required: ["id"],
          additionalProperties: true,
        },
      },
    ],
  };
});
after(async () => {
  await app?.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStores();
  if (process.env.TEST_POSTGRES_URL)
    await (await import("../src/database/postgres.js")).closePostgresPools();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

test("native credential collection binds user, request, destination and configuration; no plaintext storage", async () => {
  const unauth = await app.inject({ method: "GET", url: url("/connections") });
  assert.equal(unauth.statusCode, 401);
  const noCsrf = await app.inject({
    method: "POST",
    url: url("/connections"),
    headers: { cookie: headers.cookie },
    payload: { definition: d },
  });
  assert.equal(noCsrf.statusCode, 403);
  const created = await request("POST", "/connections", { definition: d });
  assert.equal(created.statusCode, 200, created.body);
  c = created.json().connection;
  const form = (
    await request("POST", `/connections/${c.id}/credentials`, {})
  ).json().request;
  const creds = await import("../integrations/credentials.js");
  await assert.rejects(() =>
    creds.credentialRequest(org, "another-user", form.id),
  );
  assert.equal(
    (
      await request("POST", `/credential-requests/${form.id}`, {
        values: { token },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request("POST", `/credential-requests/${form.id}`, {
        values: { token },
      })
    ).statusCode,
    403,
  );
  const store = await import("../integrations/storage.js");
  const encrypted = await store
    .db()
    .prepare(
      "SELECT encrypted_json FROM integration_secrets WHERE organization_id=?",
    )
    .get(org);
  assert.ok(encrypted);
  assert.ok(!String(encrypted.encrypted_json).includes("private-test-token"));
  const detail = await request("GET", `/connections/${c.id}`);
  assert.ok(!detail.body.includes("private-test-token"));
  const sample = await request("POST", `/connections/${c.id}/preview`, {
    operation: "echo",
  });
  assert.equal(sample.statusCode, 200, sample.body);
  assert.equal(sample.json().sample.token, "[redacted]");
  assert.equal(
    (
      await request("POST", `/connections/${c.id}/preview`, {
        operation: "create",
        input: { name: "Forbidden probe" },
      })
    ).statusCode,
    403,
  );
  assert.equal(writes, 0);
  const enabled = await request("POST", `/connections/${c.id}/activate`, {
    expectedRevision: c.revision,
    operations: d.operations.map((o: any) => o.id),
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  c = enabled.json().connection;
});
test("dynamic publication is discoverable, flexible, paginated and tenant-authorized", async () => {
  const catalog = await app.inject({
    method: "GET",
    url: `/v1/publication/organizations/${org}/catalog`,
    headers,
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.ok(
    catalog.json().providers.some((p: any) => p.id === `external.${c.id}`),
  );
  assert.ok(
    catalog.json().actions.some((a: any) => a.id === `external.${c.id}.create`),
  );
  const sync = await request("POST", `/connections/${c.id}/sync`, {
    resource: "records",
  });
  assert.equal(sync.statusCode, 200, sync.body);
  assert.equal(sync.json().result.value.complete, true);
  const { readPublishedData, listPublishedData } = await import(
    "../platform/publication/providers.js"
  );
  const { userPublicationContext } = await import(
    "../platform/publication/context.js"
  );
  const context = userPublicationContext(ctx),
    source = {
      provider: `external.${c.id}`,
      export: "records",
      target: { scope: "organization" as const, organizationId: org },
    };
  const data = await readPublishedData(context, source);
  assert.equal(data.status, "ready");
  if (data.status === "ready") assert.deepEqual(data.value, rows);
  const page = await listPublishedData(context, source, { limit: 1 });
  assert.equal(page.status, "ready");
  if (page.status === "ready") {
    assert.equal(page.items.length, 1);
    const second = await listPublishedData(context, source, {
      limit: 1,
      cursor: page.nextCursor,
    });
    assert.equal(second.status, "ready");
    if (second.status === "ready") assert.deepEqual(second.items, [rows[1]]);
  }
  const denied = await readPublishedData(context, {
    ...source,
    target: { ...source.target, organizationId: "other-tenant" },
  });
  assert.equal(denied.status, "denied");
  const outsider = {
    ...ctx,
    userId: "outsider",
    permissions: {},
    accessProfile: { ...ctx.accessProfile, effective_permissions: {} },
  };
  await assert.rejects(() =>
    import("../integrations/service.js").then((s) =>
      s.connection(outsider, c.id, "records"),
    ),
  );
});
test("snapshot failures retain complete results; recovery and deletions publish new revisions", async () => {
  const { read } = await import("../integrations/storage.js");
  const old = await read(org, "resource", `${c.id}:records`);
  failPage = true;
  assert.equal(
    (
      await request("POST", `/connections/${c.id}/sync`, {
        resource: "records",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await read(org, "resource", `${c.id}:records`))!.generation,
    old!.generation,
  );
  failPage = false;
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const resumed = await request("POST", `/connections/${c.id}/sync`, {
    resource: "records",
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().result.ran, true);
  rows = [{ id: "a", amount: "18", unexpected: { nested: false } }];
  assert.equal(
    (
      await request("POST", `/connections/${c.id}/sync`, {
        resource: "records",
      })
    ).statusCode,
    200,
  );
  const { userPublicationContext } = await import(
    "../platform/publication/context.js"
  );
  const { readPublishedData } = await import(
    "../platform/publication/providers.js"
  );
  const source = {
    provider: `external.${c.id}`,
    export: "records",
    target: { scope: "organization" as const, organizationId: org },
  };
  const latest = await readPublishedData(userPublicationContext(ctx), source);
  assert.equal(latest.status, "ready");
  if (latest.status === "ready") assert.deepEqual(latest.value, rows);
  const historical = await readPublishedData(userPublicationContext(ctx), {
    ...source,
    revision: old!.generation,
  });
  assert.equal(historical.status, "ready");
  if (historical.status === "ready")
    assert.equal((historical.value as any[]).length, 2);
});
test("external writes use durable receipts, reject changed requests, and never replay uncertain outcomes", async () => {
  const { invokeAction } = await import("../platform/publication/actions.js"),
    { userPublicationContext } = await import(
      "../platform/publication/context.js"
    );
  const context = userPublicationContext(ctx, { mode: "command" }),
    target = { scope: "organization" as const, organizationId: org };
  const ref = { action: `external.${c.id}.create`, target };
  const first = await invokeAction(
    context,
    ref,
    { name: "New job" },
    { idempotencyKey: "one" },
  );
  const second = await invokeAction(
    context,
    ref,
    { name: "New job" },
    { idempotencyKey: "one" },
  );
  assert.equal(writes, 1);
  assert.equal(second.receipt.replayed, true);
  assert.deepEqual(first.value, second.value);
  await assert.rejects(() =>
    invokeAction(
      context,
      ref,
      { name: "Different" },
      { idempotencyKey: "one" },
    ),
  );
  const uncertain = { action: `external.${c.id}.uncertain`, target };
  await assert.rejects(() =>
    invokeAction(context, uncertain, {}, { idempotencyKey: "uncertain" }),
  );
  const count = writes;
  await assert.rejects(() =>
    invokeAction(context, uncertain, {}, { idempotencyKey: "uncertain" }),
  );
  assert.equal(writes, count);
});
test("organization events run versioned code with connection bindings and deduplicate delivery", async () => {
  const jobs = await import("../integrations/jobs.js");
  const rule = await jobs.saveAutomation(ctx, {
    title: "Create after signature",
    description: "Create a supplier project when either proposal is signed.",
    enabled: true,
    events: ["document.signed", "proposal.signed"],
    source:
      'const result = await api.actions.invoke("create", {name: inputs.event.payload.name}); return {outputs:{externalId:result.id}};',
    bindings: {
      create: {
        kind: "action",
        policy: "live",
        action: {
          action: `external.${c.id}.create`,
          target: { scope: "organization", organizationId: org },
        },
      },
    },
  });
  const event = {
    id: "signed-event",
    type: "document.signed",
    organization_id: org,
    payload: { name: "Signed project" },
  };
  await jobs.enqueueConnectionEvent(event);
  await jobs.enqueueConnectionEvent(event);
  const before = writes;
  await jobs.integrationTick();
  await jobs.integrationTick();
  assert.equal(writes, before + 1);
  const detail = (await request("GET", `/connections/${c.id}`)).json();
  assert.equal(detail.automations[0].id, rule.id);
  assert.ok(
    detail.runs.some(
      (r: any) => r.kind === "automation" && r.state === "succeeded",
    ),
  );
});
test("outbound requests block private networks, redirect escapes, and cross-origin operation paths", async () => {
  const { safeUrl, publicAddress } = await import(
    "../integrations/transport.js"
  );
  assert.equal(publicAddress("127.0.0.1"), false);
  assert.equal(publicAddress("::ffff:127.0.0.1"), false);
  for (const address of [
    "2001::1",
    "2002:7f00:1::",
    "168.63.129.16",
    "fc00::1",
  ])
    assert.equal(publicAddress(address), false);
  for (const address of ["8.8.8.8", "2001:4860:4860::8888"])
    assert.equal(publicAddress(address), true);
  await assert.rejects(() =>
    safeUrl("https://169.254.169.254/latest/meta-data"),
  );
  await assert.rejects(() => safeUrl("https://user:password@example.com/"));
  assert.equal(
    (
      await request("POST", `/connections/${c.id}/preview`, {
        operation: "redirect",
      })
    ).statusCode,
    400,
  );
  const { saveConnection, execute } = await import(
    "../integrations/service.js"
  );
  const newer = await saveConnection(ctx, {
    id: c.id,
    expectedRevision: c.revision,
    definition: {
      ...d,
      operations: [
        {
          id: "escape",
          title: "Escape",
          effect: "read",
          request: { path: "https://other.example/private" },
        },
      ],
      resources: [],
    },
  });
  c = newer;
  await assert.rejects(
    () => execute(ctx, c.id, "escape", {}, { preview: true }),
    /destination/,
  );
});
test("assistant opens the same private connection conversation and emits only a secure credential request", async () => {
  const { connectionTools, ensureConnectionConversation } = await import(
    "../integrations/assistant.js"
  );
  const a = await ensureConnectionConversation(ctx, c.id),
    b = await ensureConnectionConversation(ctx, c.id);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.id, b.id);
  assert.equal(a.agent_id, "assistant");
  assert.equal(a.created_by_user_id, ctx.userId);
  const run = {
    orgId: org,
    userId: ctx.userId,
    ctx,
    settings: {},
    scratch: {},
    renders: [],
  } as any;
  const result = await connectionTools
    .find((t) => t.name === "connections_credentials")!
    .execute(run, { connectionId: c.id });
  assert.equal(run.renders[0].type, "connection_credentials");
  assert.ok(!JSON.stringify({ result, renders: run.renders }).includes(token));
  const { connectionContext } = await import("../integrations/assistant.js");
  assert.match(
    await connectionContext(ctx, `connection:${c.id}`),
    /Settings → Connections/,
  );
});

test("connector upgrades, rollback and paused frozen reads honor the current version and permission", async () => {
  const service = await import("../integrations/service.js"),
    pub = await import("../integrations/publication.js");
  c = await service.saveConnection(ctx, {
    id: c.id,
    expectedRevision: c.revision,
    definition: d,
  });
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
  );
  await Promise.all([
    pub.loadConnectionPublications(org),
    pub.loadConnectionPublications(org),
  ]);
  const original = c.activeVersion;
  const retained=(await (await import("../integrations/storage.js")).read(org,"resource",`${c.id}:records`))!.generation;
  c = await service.saveConnection(ctx, {
    id: c.id,
    expectedRevision: c.revision,
    definition: { ...d, notes: "Updated mapping" },
  });
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
  );
  await pub.loadConnectionPublications(org);
  const { userPublicationContext } = await import(
    "../platform/publication/context.js"
  );
  const { readPublishedData } = await import(
    "../platform/publication/providers.js"
  );
  const source = {
    provider: `external.${c.id}`,
    export: "records",
    target: { scope: "organization" as const, organizationId: org },
  };
  assert.equal(
    (await readPublishedData(userPublicationContext(ctx), source)).status,
    "pending",
  );
  assert.equal(
    (
      await readPublishedData(userPublicationContext(ctx), {
        ...source,
        version: original,
      })
    ).status,
    "denied",
  );
  await (await import('../integrations/jobs.js')).syncResource(ctx,c.id,'records');
  c = await service.saveConnection(ctx, {
    id: c.id,
    expectedRevision: c.revision,
    definition: d,
  });
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
  );
  assert.equal((await readPublishedData(userPublicationContext(ctx),{...source,revision:retained})).status,'ready');
  assert.equal((await readPublishedData(userPublicationContext(ctx),source)).status,'pending');
  await (await import('../integrations/jobs.js')).syncResource(ctx,c.id,'records');
  assert.equal(
    (await readPublishedData(userPublicationContext(ctx), source)).status,
    "ready",
  );
  c = await service.pause(ctx, c.id, c.revision);
  assert.equal(
    (await readPublishedData(userPublicationContext(ctx), source)).status,
    "denied",
  );
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
  );
});

test("reusable packages install an isolated disabled account, and guidance remains independent", async () => {
  const library = await import("../integrations/library.js");
  const pkg = await library.savePackage(ctx, {
    connectionId: c.id,
    name: "Supplier reusable connector",
  });
  const found = await library.searchLibrary(org, "Supplier reusable");
  assert.equal(found[0]!.connector, pkg.connector);
  const installed = await library.installPackage(ctx, pkg.connector);
  assert.notEqual(installed.id, c.id);
  assert.equal(installed.enabled, false);
  assert.deepEqual(installed.grants, {});
  assert.equal(
    await (
      await import("../integrations/credentials.js")
    ).hasCredentials(org, installed.id),
    false,
  );
  await assert.rejects(() =>
    library.installPackage({ ...ctx, orgId: "different-org" }, pkg.connector),
  );
  assert.equal(
    (await library.searchLibrary(org, "CompanyCam"))[0]!.connector,
    null,
  );
});

test("OAuth uses PKCE, binds state to its actor, rotates refresh once and preserves uncertain refresh outcomes", async () => {
  const service = await import("../integrations/service.js"),
    credentials = await import("../integrations/credentials.js"),
    oauth = await import("../integrations/oauth.js");
  const raw = {
    ...d,
    name: "OAuth supplier",
    auth: {
      kind: "oauth2",
      authorizationUrl: origin + "/oauth/authorize",
      tokenUrl: origin + "/oauth/token",
    },
    credentialFields: [
      { key: "clientId", label: "Client ID", secret: false },
      { key: "clientSecret", label: "Client secret" },
    ],
  };
  const account = await service.saveConnection(ctx, { definition: raw }),
    definition = await service.definition(org, account, account.draftVersion);
  await credentials.storeCredentials(org, account.id, definition, {
    clientId: "mock-client",
    clientSecret: "mock-secret",
  });
  const started = await oauth.beginOAuth(
      ctx,
      account.id,
      "https://portal.example/callback",
    ),
    link = new URL(started.url),
    state = link.searchParams.get("state")!;
  assert.equal(link.searchParams.get("code_challenge_method"), "S256");
  assert.ok(link.searchParams.get("code_challenge"));
  assert.ok(!started.url.includes("mock-secret"));
  await assert.rejects(() =>
    oauth.completeOAuth({ ...ctx, userId: "wrong-user" }, state, "auth-code"),
  );
  await oauth.completeOAuth(ctx, state, "auth-code");
  await assert.rejects(() => oauth.completeOAuth(ctx, state, "auth-code"));
  const active = await service.activate(ctx, account.id, account.revision, [
    "echo",
  ]);
  const expired = {
    ...(await credentials.secrets(org, account.id, definition)),
    expiresAt: 0,
  };
  await credentials.storeCredentials(org, account.id, definition, expired);
  const before = refreshes;
  await Promise.all([
    service.execute(ctx, account.id, "echo", {}),
    service.execute(ctx, account.id, "echo", {}),
  ]);
  assert.equal(refreshes, before + 1);
  await credentials.storeCredentials(org, account.id, definition, expired);
  failRefresh = true;
  await assert.rejects(() => service.execute(ctx, account.id, "echo", {}));
  const count = refreshes;
  await assert.rejects(() => service.execute(ctx, account.id, "echo", {}));
  assert.equal(refreshes, count);
  failRefresh = false;
  await service.pause(ctx, account.id, active.revision);
});

test("signed webhooks authenticate raw bytes, deduplicate, restrict event namespaces and redact payloads", async () => {
  const service = await import("../integrations/service.js"),
    credentials = await import("../integrations/credentials.js");
  const secret = "webhook-test-secret";
  const raw = {
    ...d,
    name: "Webhook supplier",
    credentialFields: [
      ...d.credentialFields,
      { key: "webhookSecret", label: "Webhook secret" },
    ],
    webhook: {
      secretField: "webhookSecret",
      allowedEvents: ["project.created"],
    },
  };
  let account = await service.saveConnection(ctx, { definition: raw });
  const definition = await service.definition(
    org,
    account,
    account.draftVersion,
  );
  await credentials.storeCredentials(org, account.id, definition, {
    token,
    webhookSecret: secret,
  });
  account = await service.activate(ctx, account.id, account.revision, [
    "records",
  ]);
  const endpoint = `/v1/integrations/webhooks/${org}/${account.id}`,
    body = JSON.stringify({ id: "event-1", type: "project.created", token });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const send = (payload: string, sig: string) =>
    app.inject({
      method: "POST",
      url: endpoint,
      payload,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
    });
  assert.equal((await send(body, "bad")).statusCode, 403);
  for (let i = 0; i < 2; i++) {
    const response = await send(body, signature);
    assert.equal(response.statusCode, 200, response.body);
  }
  const store = await import("../work/storage.js");
  const events = await store.listEventRecords(org, { limit: 200 });
  const matching = events.filter(
    (e: any) => e.type === `external.${account.id}.project.created`,
  );
  assert.equal(matching.length, 1);
  assert.equal((matching[0]!.payload as any).token, "[redacted]");
  const forged = JSON.stringify({ id: "event-2", type: "document.signed" });
  assert.equal(
    (
      await send(
        forged,
        createHmac("sha256", secret).update(forged).digest("hex"),
      )
    ).statusCode,
    400,
  );
  account = await service.pause(ctx, account.id, account.revision);
  assert.equal((await send(body, signature)).statusCode, 403);
});

function mockModel(script: any[]) {
  const original = globalThis.fetch,
    calls: any[] = [];
  let index = 0;
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body || "{}")));
    return new Response(
      JSON.stringify(script[Math.min(index++, script.length - 1)]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}
const toolCall = (name: string, args: any, id: string) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: id,
});
const message = (text: string) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});

test("the real shared assistant routes setup tools, secure chat widgets and a bounded dummy API preview", async () => {
  const thread = await (
    await import("../integrations/assistant.js")
  ).ensureConnectionConversation(ctx, c.id);
  assert.ok(thread);
  const mocked = mockModel([
    { output: [toolCall("connections_search", { query: "custom" }, "search")] },
    {
      output: [
        toolCall(
          "connections_credentials",
          { connectionId: c.id },
          "credentials",
        ),
      ],
    },
    {
      output: [
        toolCall(
          "connections_preview",
          { connectionId: c.id, operation: "echo", input: {} },
          "preview",
        ),
      ],
    },
    {
      output: [
        toolCall(
          "report_result",
          {
            status: "success",
            summary:
              "The read test passed. Credentials can be replaced in the secure form.",
          },
          "report",
        ),
      ],
    },
    {
      output: [
        message(
          "The read test passed. Credentials can be replaced in the secure form.",
        ),
      ],
    },
  ]);
  try {
    const reply = await app.inject({
      method: "POST",
      url: `/v1/assistant/organizations/${org}/threads/${thread.id}/messages`,
      headers,
      payload: {
        message:
          "Open the secure credential form and test the existing connection with a read only request.",
      },
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const result = reply.json();
    assert.equal(result.status, "success", reply.body);
    assert.equal(result.renders[0].type, "connection_credentials");
    const prompt = JSON.stringify(mocked.calls);
    assert.match(prompt, /Settings → Connections/);
    assert.ok(!prompt.includes(token));
    assert.ok(!reply.body.includes(token));
    assert.ok(
      result.assistant_message.data.trace.some(
        (t: any) => t.tool === "connections_preview",
      ),
    );
  } finally {
    mocked.restore();
  }
});

test("usage indexing tracks source changes and AI descriptions group rules without changing executable definitions", async () => {
  const usage = await import("../integrations/usage.js"),
    storage = await import("../integrations/storage.js");
  const binding = {
    kind: "data",
    policy: "live",
    source: {
      provider: `external.${c.id}`,
      export: "records",
      target: { scope: "organization", organizationId: org },
    },
  };
  await usage.indexConnectionUses(org, "test-module", {
    title: "Proposal total",
    bindings: { supplier: binding },
  });
  assert.equal((await usage.connectionUses(org, c.id)).length, 1);
  const detail = await (
    await import("../integrations/assistant.js")
  ).inspectConnection(ctx, c.id);
  const ids = detail.uses.map((u: any) => u.id);
  const groups = [
    {
      description:
        "Creates a supplier project after either proposal is signed; proposal totals also read supplier records.",
      ruleIds: ids,
    },
  ];
  const mocked = mockModel([
    { output: [toolCall("submit_descriptions", { groups }, "describe")] },
    { output: [message("Done.")] },
  ]);
  try {
    await (
      await import("../integrations/summaries.js")
    ).summarizeConnectionUses(org, c.id);
    const summary = await storage.read(org, "summary", c.id);
    assert.deepEqual(summary!.groups, groups);
    const count = mocked.calls.length;
    await (
      await import("../integrations/summaries.js")
    ).summarizeConnectionUses(org, c.id);
    assert.equal(mocked.calls.length, count, "unchanged summaries use cache");
    assert.equal(
      (await storage.list(org, "automation")).length,
      detail.automations.length,
    );
  } finally {
    mocked.restore();
  }
  await usage.indexConnectionUses(org, "test-module", {
    title: "Disconnected",
  });
  assert.equal((await usage.connectionUses(org, c.id)).length, 0);
});

test("incremental imports keep checkpoints separate from pagination and apply deletions atomically", async () => {
  const service = await import("../integrations/service.js"),
    jobs = await import("../integrations/jobs.js"),
    store = await import("../integrations/storage.js"),
    creds = await import("../integrations/credentials.js");
  let account = await service.saveConnection(ctx, {
    definition: {
      ...d,
      name: "Incremental provider",
      operations: [
        {
          id: "changes",
          title: "Changed records",
          effect: "read",
          request: { path: "/changes", query: { since: "{{since}}" } },
        },
      ],
      resources: [
        {
          id: "changes",
          title: "Incremental records",
          operation: "changes",
          itemsPath: "items",
          syncMode: "incremental",
          checkpointPath: "checkpoint",
          checkpointInput: "since",
          deletedPath: "deleted",
        },
      ],
    },
  });
  const definition = await service.definition(org, account);
  await creds.storeCredentials(org, account.id, definition, { token });
  account = await service.activate(ctx, account.id, account.revision, [
    "changes",
  ]);
  await jobs.syncResource(ctx, account.id, "changes");
  const old = await store.read(org, "resource", `${account.id}:changes`);
  await jobs.syncResource(ctx, account.id, "changes");
  const head = await store.read(org, "resource", `${account.id}:changes`);
  assert.equal(head!.checkpoint, "watermark-2");
  assert.equal(head!.count, 2);
  assert.deepEqual(checkpoints, ["", "watermark-1"]);
  const current = await service.readResource(ctx, account.id, "changes");
  assert.deepEqual((current as any).value, [
    { id: "b" },
    { id: "c", strange: 7 },
  ]);
  const prior = await service.readResource(
    ctx,
    account.id,
    "changes",
    {},
    old!.generation,
  );
  assert.deepEqual((prior as any).value, [{ id: "a" }, { id: "b" }]);
  const changes = await store
    .db()
    .prepare("SELECT * FROM integration_changes WHERE connection_id=?")
    .all(account.id);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((r) => r.delivered_at));
});

test("write-only grants cannot read data, and document authoring indexes declared connection uses", async () => {
  const service = await import("../integrations/service.js");
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
    { writer: { write: ["create"] } },
  );
  const writer = {
    ...ctx,
    userId: "writer",
    permissions: {},
    accessProfile: { ...ctx.accessProfile, effective_permissions: {} },
  };
  await service.connection(writer, c.id);
  await service.connection(writer, c.id, "create", "write");
  await assert.rejects(() =>
    service.connection(writer, c.id, "records", "read"),
  );
  const storage = await import("../documents/modules/storage.js"),
    usage = await import("../integrations/usage.js");
  const binding = {
    kind: "data",
    policy: "live",
    source: {
      provider: `external.${c.id}`,
      export: "records",
      target: { scope: "organization", organizationId: org },
    },
  };
  await storage.saveRecord(org, storage.MODULES, "connection-usage-test", {
    title: "Document consumer",
    bindings: { records: binding },
  });
  assert.equal((await usage.connectionUses(org, c.id)).length, 1);
  await storage.saveRecord(org, storage.MODULES, "connection-usage-test", {
    title: "Document consumer",
    bindings: {},
  });
  assert.equal((await usage.connectionUses(org, c.id)).length, 0);
  c = await service.activate(
    ctx,
    c.id,
    c.revision,
    d.operations.map((op: any) => op.id),
  );
});

test("slow synchronization does not block event automations and background sync resumes independently", async () => {
  const service = await import("../integrations/service.js"),
    jobs = await import("../integrations/jobs.js");
  let account = await service.saveConnection(ctx, {
    definition: {
      name: "Slow provider",
      baseUrl: origin,
      auth: { kind: "none" },
      operations: [
        {
          id: "slow",
          title: "Read slowly",
          effect: "read",
          request: { path: "/slow" },
        },
      ],
      resources: [
        {
          id: "records",
          title: "Slow records",
          operation: "slow",
          itemsPath: "items",
        },
      ],
    },
  });
  account = await service.activate(ctx, account.id, account.revision, ["slow"]);
  const started = new Promise<void>((resolve) => (onSlowRequest = resolve));
  slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
  const syncing = jobs.integrationSyncTick();
  try {
    await started;
    const before = writes;
    await jobs.enqueueConnectionEvent({
      id: "event-while-syncing",
      type: "document.signed",
      organization_id: org,
      payload: { name: "Fast automation" },
    });
    await jobs.integrationTick();
    assert.equal(
      writes,
      before + 1,
      "event job completes while provider response remains blocked",
    );
  } finally {
    releaseSlow();
    await syncing;
  }
  const result = await service.readResource(ctx, account.id, "records");
  assert.deepEqual((result as any).value, [{ id: "slow-record" }]);
  await service.pause(ctx, account.id, account.revision);
});

test("organization automation usage inherits its trigger, conditions and plain-language title", async () => {
  const rules = await import("../work/rules.js"),
    usage = await import("../integrations/usage.js");
  await rules.saveAutomationRules(org, "default", {
    rules: [
      {
        id: "external-dependency",
        title: "Upload the completed proposal",
        event: "document.signed",
        conditions: { "payload.document_source": "proposals" },
        automation: "scope.code.run.v1",
        input: {
          source: "return {outputs:{}};",
          bindings: {
            supplier: {
              kind: "action",
              policy: "live",
              action: {
                action: `external.${c.id}.create`,
                target: { scope: "organization", organizationId: org },
              },
            },
          },
        },
      },
    ],
  });
  const uses = await usage.connectionUses(org, c.id);
  assert.ok(
    uses.some(
      (u) =>
        u.title === "Upload the completed proposal" &&
        u.events.includes("document.signed") &&
        u.conditions["payload.document_source"] === "proposals",
    ),
  );
  await rules.saveAutomationRules(org, "default", { rules: [] });
  assert.equal((await usage.connectionUses(org, c.id)).length, 0);
});
