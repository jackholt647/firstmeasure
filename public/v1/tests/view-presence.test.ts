import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("presence is scoped, deduplicates tabs, streams changes, and expires disconnected sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "view-presence-"));
  process.env.PLATFORM_STORAGE_ROOT = directory;
  const { attachPresence, presenceRoster } = await import("../platform/presence.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const sockets: EventEmitter[] = [];
  async function join(orgId: string, scope: string, userId: string) {
    const raw = new EventEmitter() as any;
    const frames: string[] = [];
    raw.writeHead = () => {};
    raw.write = (frame: string) => frames.push(frame);
    raw.end = () => {};
    sockets.push(raw);
    await attachPresence({ headers: {}, raw: { socket: { setTimeout() {}, setNoDelay() {} } } } as any,
      { raw, hijack() {} } as any, { orgId, scope, userId, name: userId, authorize: async () => {} });
    return { raw, frames };
  }
  try {
    const first = await join("a", "project:1", "Bill");
    const second = await join("a", "project:1", "Bill");
    await join("a", "project:2", "Other project");
    await join("b", "project:1", "Other org");
    assert.deepEqual((await presenceRoster("a", "project:1")).map(row => ({ ...row })), [{ user_id: "Bill", name: "Bill" }]);
    assert.equal((await presenceRoster("a", "online")).length, 2);
    await join("a", "project:1", "Sam");
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.match(first.frames.at(-1)!, /Sam/);
    first.raw.emit("close");
    assert.equal((await presenceRoster("a", "project:1")).length, 2, "closing one tab leaves the other tab present");
    second.raw.emit("close");
    assert.deepEqual((await presenceRoster("a", "project:1")).map(row => ({ ...row })), [{ user_id: "Sam", name: "Sam" }]);
    const now = Date.now;
    try {
      Date.now = () => now() + 31_000;
      assert.deepEqual(await presenceRoster("a", "online"), [], "a lost server's sessions expire");
    } finally { Date.now = now; }
  } finally {
    for (const socket of sockets) socket.emit("close");
    await closeSqlStoresForTests();
    await rm(directory, { recursive: true, force: true });
  }
});
