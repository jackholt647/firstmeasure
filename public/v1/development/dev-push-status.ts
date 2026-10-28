import fs from "node:fs";
import path from "node:path";

import { env } from "../src/config/env.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { registerRealtimeChannelKind, type RealtimeChannelSend } from "../platform/realtime.js";

/**
 * The dev push router's status for the dev console (docs/architecture/dev-console.md, docs/architecture/dev-lanes.md).
 * The router rewrites one JSON file on dev web on every state change (temp file and rename). A page watching
 * `dev-push` on the platform stream gets the document once (`status`) and again whenever it changes. Development
 * only, the dev console's audience only; nothing here writes.
 */

const POLL_MS = 1000;

/** The status file, or "" where there is none. Never on production. */
export function devPushStatusFile() {
  if (env.isProduction || env.dataEnvironment !== "development") return "";
  return String(process.env.FIRSTMEASURE_DEV_PUSH_STATUS ?? "/opt/firstmeasure/dev-push/status.json").trim();
}

function read(file: string) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}
function parse(text: string): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const listeners = new Set<RealtimeChannelSend>();
let lastText = "";
let stopWatching: (() => void) | null = null;

function startWatching(file: string) {
  lastText = read(file);
  const refresh = () => {
    const text = read(file);
    if (text === lastText) return;
    lastText = text;
    const status = parse(text);
    // A half-written or missing file sends nothing; the next complete write does.
    if (status) for (const send of listeners) send("status", status);
  };
  // The rename is seen at once by fs.watch on the folder; the poll covers a folder created later and file systems
  // without events.
  let watcher: fs.FSWatcher | null = null;
  const watch = () => {
    if (watcher) return;
    try { watcher = fs.watch(path.dirname(file), (_event, name) => { if (!name || String(name) === path.basename(file)) refresh(); }); watcher.on("error", () => { watcher?.close(); watcher = null; }); }
    catch { watcher = null; }
  };
  watch();
  const poll = setInterval(() => { watch(); refresh(); }, POLL_MS);
  poll.unref?.();
  return () => { clearInterval(poll); watcher?.close(); watcher = null; };
}

/** `watch=dev-push` on the platform stream, for the dev console's audience on development. */
export function registerDevPushChannel() {
  const file = devPushStatusFile();
  if (!file) return;
  registerRealtimeChannelKind("dev-push", async (request, { orgId }) => {
    const ctx = await requirePlatformAuth(request, { orgId });
    const { devConsoleAccess } = await import("./console.js");
    await devConsoleAccess(ctx);
    return (send) => {
      if (!listeners.size) stopWatching = startWatching(file);
      listeners.add(send);
      send("status", parse(lastText) ?? { v: 1, unavailable: true });
      return () => {
        listeners.delete(send);
        if (!listeners.size) { stopWatching?.(); stopWatching = null; }
      };
    };
  });
}
