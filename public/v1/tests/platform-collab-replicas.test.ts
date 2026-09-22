import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("document revisions, presence and live edits work across two independent API replicas", { skip: !process.env.TEST_POSTGRES_URL, timeout: 30000 }, async t => {
  const org = `collab_${randomUUID()}`;
  const children: ChildProcess[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let counter = 0;
  t.after(() => { for (const child of children) { if (child.connected) child.disconnect(); child.kill(); } });
  async function start() {
    const child = fork("tests/helpers/collab-replica.ts", [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL!,
        POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", TEST_COLLAB_ORG: org } });
    children.push(child);
    let errors = "";
    child.stderr!.on("data", data => { errors += String(data); });
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      child.on("message", (message: any) => {
        if (message.ready) { resolve(message.address); return; }
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
      });
      child.on("error", reject);
      child.on("exit", code => { if (code) reject(new Error(`Replica exited: ${errors}`)); });
    });
    return { child, port: address.port, call: (operation: string, data: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++counter; pending.set(id, { resolve, reject }); child.send({ id, operation, ...data });
    }) };
  }
  const [a, b] = await Promise.all([start(), start()]);
  const writes = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).call("append", { actor: `actor_${i}`, revision: 0 })));
  assert.equal(writes.filter(result => result.ok).length, 1);
  assert.equal(writes.filter(result => result.stale && result.revision === 1).length, 15);
  const alice = await a.call("presence", { actor: "alice" });
  const bob = await b.call("presence", { actor: "bob" });
  assert.ok(bob.some((entry: any) => entry.actor.id === "alice"));
  assert.notEqual(alice.find((entry: any) => entry.actor.id === "alice").color, bob.find((entry: any) => entry.actor.id === "bob").color);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`http://127.0.0.1:${a.port}/stream`, { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let frames = "";
  while (!frames.includes("event: hello")) frames += new TextDecoder().decode((await reader.read()).value);
  assert.match(frames, /"revision":1/);
  await b.call("append", { actor: "bob", revision: 1 });
  while (!frames.includes("event: commands")) frames += new TextDecoder().decode((await reader.read()).value);
  assert.match(frames, /"revision":2/);
  assert.match(frames, /Shared edit/);
  await reader.cancel();
  a.child.kill();
  const restarted = await start();
  const hello = await restarted.call("hello");
  assert.equal(hello.revision, 2);
  assert.ok(hello.presence.some((entry: any) => entry.actor.id === "bob"));
});
