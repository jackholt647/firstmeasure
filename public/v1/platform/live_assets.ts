import fs from "node:fs";
import path from "node:path";

import { env } from "../src/config/env.js";
import { requirePlatformAuth } from "./auth.js";
import { registerRealtimeChannelKind, type RealtimeChannelSend } from "./realtime.js";

/**
 * The live layer (docs/architecture/live-layer.md). On development only, browser files written to
 * `<dir>/public` are served by NGINX ahead of the release, and `<dir>/manifest.json` lists them. A
 * page watching `live-assets` on the platform stream gets the list once (`hello`) and then every
 * change (`changed`), and swaps those files in (libraries/live-assets/live-assets.js). Nothing here
 * writes: the receiver on the web host (tools/live-layer/fm-live-receive.py) owns the folder.
 *
 * The channel also says which platform release this host serves (`release` in `hello`, and a `release` frame
 * when `fm-release activate` switches `current`), so an open dev page reloads onto a new release. A browser-only
 * release keeps the server running (`activate --keep-server`), so the server's own RELEASE_ID cannot tell.
 */

export type LiveManifest = {
  gen: number;
  files: Record<string, { sha: string }>;
  /** Files that left the layer at `gen` and why: "released" (the release now has the same bytes or the router merged them in), "parked" (the release changed under it; kept for the router), "reverted"; older manifests may say "conflict". */
  retired?: Record<string, { reason: string; gen: number }>;
};
export type LiveChange = { path: string; sha: string | null };

const EMPTY: LiveManifest = { gen: 0, files: {} };
const POLL_MS = 1000;

/** The live layer's folder, or "" where there is none. Never on production. */
export function liveAssetsDir() {
  if (env.isProduction || env.dataEnvironment !== "development") return "";
  return String(process.env.FIRSTMEASURE_LIVE_ASSETS_DIR ?? "/opt/firstmeasure/live").trim();
}

export function parseLiveManifest(text: string): LiveManifest {
  try {
    const value = JSON.parse(text) as Partial<LiveManifest>;
    const files: LiveManifest["files"] = {};
    for (const [file, entry] of Object.entries(value?.files ?? {})) if (typeof entry?.sha === "string") files[file] = { sha: entry.sha };
    return { gen: Number(value?.gen) || 0, files, retired: value?.retired && typeof value.retired === "object" ? value.retired : {} };
  } catch { return EMPTY; }
}

/**
 * What a page must apply going from one manifest to the next: files added or rewritten, and files that left
 * the layer (sha null, the page gets the release's copy again). One that left because the release now has
 * the same bytes changes nothing in the page.
 */
export function liveChanges(before: LiveManifest, after: LiveManifest): LiveChange[] {
  const changes: LiveChange[] = [];
  for (const [file, entry] of Object.entries(after.files)) if (before.files[file]?.sha !== entry.sha) changes.push({ path: file, sha: entry.sha });
  for (const file of Object.keys(before.files)) {
    if (after.files[file] || after.retired?.[file]?.reason === "released") continue;
    changes.push({ path: file, sha: null });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** The release this host serves: the directory `current` points at (`fm-release`), else the server's own id. */
export function servedRelease(link = String(process.env.FIRSTMEASURE_CURRENT_RELEASE_LINK ?? "/opt/firstmeasure/current").trim()) {
  try { return path.basename(fs.realpathSync(link)); } catch { return env.releaseId; }
}

const listeners = new Set<RealtimeChannelSend>();
let release = "";
let current: LiveManifest = EMPTY;
let lastText = "";
let stopWatching: (() => void) | null = null;

function readManifest(dir: string) {
  try { return fs.readFileSync(path.join(dir, "manifest.json"), "utf8"); } catch { return ""; }
}

function refresh(dir: string) {
  const text = readManifest(dir);
  if (text === lastText) return;
  lastText = text;
  const next = text ? parseLiveManifest(text) : EMPTY;
  const changes = liveChanges(current, next);
  current = next;
  if (changes.length) for (const send of listeners) send("changed", { gen: next.gen, files: changes });
}

function refreshRelease() {
  const next = servedRelease();
  if (next === release) return;
  release = next;
  for (const send of listeners) send("release", { release });
}

function startWatching(dir: string) {
  release = servedRelease();
  lastText = readManifest(dir);
  current = lastText ? parseLiveManifest(lastText) : EMPTY;
  // The receiver replaces manifest.json by rename, which fs.watch on the folder sees at once; the poll covers
  // a folder created after start and file systems without events.
  let watcher: fs.FSWatcher | null = null;
  const watch = () => {
    if (watcher) return;
    try { watcher = fs.watch(dir, (_event, name) => { if (!name || String(name) === "manifest.json") refresh(dir); }); watcher.on("error", () => { watcher?.close(); watcher = null; }); }
    catch { watcher = null; }
  };
  watch();
  const poll = setInterval(() => { watch(); refresh(dir); refreshRelease(); }, POLL_MS);
  poll.unref?.();
  return () => { clearInterval(poll); watcher?.close(); };
}

/** `watch=live-assets` on the platform stream. Any signed-in member of the organization may watch it on development. */
export function registerLiveAssetsChannel() {
  const dir = liveAssetsDir();
  if (!dir) return;
  registerRealtimeChannelKind("live-assets", async (request, { orgId }) => {
    await requirePlatformAuth(request, { orgId });
    return (send) => {
      if (!listeners.size) stopWatching = startWatching(dir);
      listeners.add(send);
      send("hello", { gen: current.gen, release, files: Object.fromEntries(Object.entries(current.files).map(([file, entry]) => [file, entry.sha])) });
      return () => {
        listeners.delete(send);
        if (!listeners.size) { stopWatching?.(); stopWatching = null; }
      };
    };
  });
}
