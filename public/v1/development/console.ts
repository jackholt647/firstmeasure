import fs from "node:fs";
import path from "node:path";

import type { PlatformAuthContext } from "../platform/auth.js";
import { notFound, forbidden } from "../platform/errors.js";
import { liveAssetsDir } from "../platform/live_assets.js";
import { readOrganization, type JsonObject } from "../platform/storage.js";
import { guidedDevAccess, guidedDevEnvironment } from "../guided-experiences/dev.js";
import { findInstanceByOrg } from "../signup-sandbox/service.js";
import { requireDevelopmentOrganization } from "./synthetic-data.js";

/**
 * The dev console (docs/architecture/dev-console.md): who sees the tray and which of its sections apply here.
 * The audience is the development tools audience as guided experiences decide it: development data environment
 * only, then a platform administrator or a sandbox organization's settings managers. Everyone else, and production
 * whoever asks, gets 404 or 403 and no tray.
 */
export async function devConsoleAccess(ctx: PlatformAuthContext) {
  const access = await guidedDevAccess(ctx);
  if (!access.editor) {
    if (!guidedDevEnvironment()) throw notFound("not_found", "Not found.");
    throw forbidden("dev_console_denied", "The dev console is for the development tools audience.");
  }
  const sandbox = await requireDevelopmentOrganization(ctx).then(() => true, () => false);
  const run = await findInstanceByOrg(String(ctx.orgId)).catch(() => null);
  const org = await readOrganization(ctx.orgId).catch(() => null) as JsonObject | null;
  return {
    ok: true,
    admin: access.admin,
    organization: { id: String(ctx.orgId), name: String(org?.name ?? ""), sandbox },
    sections: {
      test_run: !!run,
      synthetic_data: sandbox,
      software_layers: sandbox,
      guided: true,
      live: !!liveAssetsDir()
    }
  };
}

/**
 * What the live layer serves now (docs/architecture/live-layer.md), with the checkout that put each file there and
 * the recent retirements. Read from the receiver's manifest; nothing here writes.
 */
export async function devConsoleLive(ctx: PlatformAuthContext) {
  await devConsoleAccess(ctx);
  const dir = liveAssetsDir();
  let manifest: JsonObject = {};
  if (dir) { try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as JsonObject; } catch { manifest = {}; } }
  const files = Object.entries((manifest.files ?? {}) as Record<string, JsonObject>)
    .map(([file, entry]) => ({ path: file, sha: String(entry?.sha ?? ""), source: String(entry?.source ?? ""), at: Number(entry?.at) || null }));
  const retired = Object.entries((manifest.retired ?? {}) as Record<string, JsonObject>)
    .map(([file, entry]) => ({ path: file, reason: String(entry?.reason ?? ""), gen: Number(entry?.gen) || 0 }))
    .sort((a, b) => b.gen - a.gen)
    .slice(0, 20);
  return { ok: true, gen: Number(manifest.gen) || 0, at: String(manifest.at ?? ""), files, retired };
}
