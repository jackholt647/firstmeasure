import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";

// docs/architecture/realtime.md: a page holds ONE long-lived connection to the
// platform. These tests hold that line from both ends.

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../..");

async function files(dir: string, keep: (file: string) => boolean, skip: (dir: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip(full)) found.push(...await files(full, keep, skip)); }
    else if (keep(full)) found.push(full);
  }
  return found;
}
const relative = (file: string) => path.relative(publicRoot, file).replaceAll("\\", "/");

test("no browser code opens a long-lived connection of its own", async () => {
  // The one client that may. Third-party calling code signals over its own socket only while a call is up.
  const allowed = new Set(["libraries/platform-realtime/platform-realtime.js"]);
  const vendored = (file: string) => /\/vendor\/|livekit|\.min\.js$/.test(file);
  const offenders: string[] = [];
  for (const root of ["libraries", "portal", "customer_portal", "apps", "sites"]) {
    for (const file of await files(path.join(publicRoot, root), f => /\.(js|mjs|html|php)$/.test(f), d => /node_modules|[\\/]dev-previews?$/.test(d))) {
      const name = relative(file);
      if (allowed.has(name) || vendored(name)) continue;
      if (/new\s+(EventSource|WebSocket)\s*\(/.test(await readFile(file, "utf8"))) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], "Use PlatformRealtime.subscribe / watchChannel instead of a new connection. See docs/architecture/realtime.md.");
});

test("the server streams to browsers from the hub and its two legacy wrappers only", async () => {
  const allowed = new Set(["v1/platform/realtime.ts", "v1/platform/presence.ts", "v1/documents/collab/service.ts"]);
  const offenders: string[] = [];
  for (const file of await files(path.join(publicRoot, "v1"), f => f.endsWith(".ts") && !f.endsWith(".d.ts"), d => /node_modules|[\\/](dist|tests|cloudflare-email-worker)$/.test(d))) {
    const name = relative(file);
    if (!allowed.has(name) && /text\/event-stream/.test(await readFile(file, "utf8"))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "Register a channel kind with registerRealtimeChannelKind instead of a new streaming endpoint. See docs/architecture/realtime.md.");
});

test("one stream carries platform events, presence and document collaboration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "single-stream-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  for (const key of ["PLATFORM", "CHANNELS", "CRM", "DOCUMENTS", "FIRSTMEASURE", "PRICEBOOK", "MESSAGING", "INTERNAL", "CALLS"]) process.env[`${key}_STORAGE_ROOT`] = path.join(root, key);
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "FIRSTMEASURE", "index.sqlite");
  const { buildApp } = await import("../src/app.js");
  const { upsertDocument } = await import("../platform/storage.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { publishRealtimeEvent, realtimeDiagnostics } = await import("../platform/realtime.js");
  const { presenceRoster } = await import("../platform/presence.js");
  const { saveDocumentInstance } = await import("../documents/storage.js");
  const { resetCollabForTests } = await import("../documents/collab/service.js");
  const app = await buildApp();
  // An open stream would keep the server from closing; a failed assertion must still let go of it.
  const controller = new AbortController();
  try {
    const registration = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
      phone: nextTestPhone(), email: "stream@example.test", password: "correct horse battery staple", name: "Bill", company: "Stream test", organization_id: "org_single_stream"
    } });
    assert.equal(registration.statusCode, 201, registration.body);
    const org = String(registration.json().organization.id);
    await enableExpandedPlatformFixture(org);
    await (await operatorFixtureClient(app, org)).request("PUT", `/v1/platform/organizations/${org}/capabilities`, { values: { "platform.documents": true } });
    const cookies = registration.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies || ""]).map(value => value.split(";")[0]).join("; ");
    const csrf = decodeURIComponent(cookie.split("; ").find(value => value.startsWith("fm_platform_session_csrf="))!.split("=")[1]!);
    await upsertDocument(org, "projects", { id: "project_stream", data: { title: "Stream" } });
    await saveDocumentInstance(org, "doc_stream", { id: "doc_stream", organization_id: org, project_id: "project_stream", document_type: "proposal", title: "Stream", status: "draft", params: {}, overrides: [] } as never);

    const stream = `/v1/platform/organizations/${org}/events/stream`;
    assert.equal((await app.inject({ method: "GET", url: `${stream}?watch=presence:online` })).statusCode, 401, "the stream is never anonymous");

    await app.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const watch = ["presence:online", "presence:project:project_stream", "collab:doc_stream", "collab:doc_missing", "presence:project:project_missing", "bogus:1"];
    const response = await fetch(`${origin}${stream}?${watch.map(name => `watch=${encodeURIComponent(name)}`).join("&")}`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    // Frames as they arrive: { type: "platform" | "channel", ... }.
    const frames: Array<Record<string, any>> = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          for (let at = buffered.indexOf("\n\n"); at >= 0; at = buffered.indexOf("\n\n")) {
            const block = buffered.slice(0, at); buffered = buffered.slice(at + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (type && data) frames.push({ type, ...JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();
    const until = async (found: () => unknown, what: string) => {
      for (let waited = 0; waited < 8000; waited += 50) { if (found()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.fail(`timed out waiting for ${what}; frames: ${JSON.stringify(frames).slice(0, 1500)}`);
    };
    const channel = (name: string, event: string) => frames.find(frame => frame.type === "channel" && frame.channel === name && frame.event === event);

    await until(() => channel("presence:online", "presence") && channel("presence:project:project_stream", "presence") && channel("collab:doc_stream", "hello")
      && channel("collab:doc_missing", "error") && channel("presence:project:project_missing", "error") && channel("bogus:1", "error"), "every channel to answer");
    assert.match(channel("presence:online", "session")!.data.session_id, /^[0-9a-f-]{36}$/, "online presence gets its session for activity reports");
    assert.equal(channel("presence:online", "presence")!.data[0].name, "Bill");
    assert.equal(channel("presence:project:project_stream", "presence")!.data[0].name, "Bill");
    assert.equal(channel("collab:doc_stream", "hello")!.data.revision, 0);
    assert.equal(channel("collab:doc_stream", "hello")!.data.presence[0].actor.name, "Bill");
    // A channel that is refused says so on the stream; the connection and the other channels carry on.
    assert.equal(channel("bogus:1", "error")!.data.code, "unknown_channel");
    assert.equal(channel("collab:doc_missing", "error")!.data.code, "document_not_found");
    assert.equal(realtimeDiagnostics().find(entry => entry.organization_id === org)!.connections, 1, "one connection holds all of it");

    // Platform events arrive on the same connection...
    await publishRealtimeEvent({ organization_id: org, topic: "test.ping", payload: { n: 1 } });
    await until(() => frames.find(frame => frame.type === "platform" && frame.topic === "test.ping"), "the platform event");
    // ...and so does another collaborator's edit.
    const sent = await app.inject({ method: "POST", url: "/v1/documents/doc_stream/collab/commands", headers: { cookie, "x-platform-csrf": csrf }, payload: { base_revision: 0, commands: [{ type: "noop" }] } });
    assert.equal(sent.statusCode, 200, sent.body);
    await until(() => channel("collab:doc_stream", "commands"), "the command batch");
    assert.equal(channel("collab:doc_stream", "commands")!.data.revision, 1);

    // Closing the one connection is what removes this page from every roster.
    assert.equal((await presenceRoster(org, "project:project_stream")).length, 1);
    controller.abort(); await pump;
    await until(() => !realtimeDiagnostics().some(entry => entry.organization_id === org && entry.connections > 0), "the connection to close");
    for (let waited = 0; waited < 4000 && (await presenceRoster(org, "project:project_stream")).length; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await presenceRoster(org, "project:project_stream")).length, 0, "viewer gone with the connection");
    assert.equal((await presenceRoster(org, "online")).length, 0, "offline with the connection");
  } finally {
    controller.abort();
    await app.close();
    await resetCollabForTests().catch(() => undefined);
    await closePlatformFixtureStores();
    await closeSqlStoresForTests();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
