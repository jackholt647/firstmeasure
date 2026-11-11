/**
 * Offline routes (docs/architecture/offline.md). Registered at /v1/platform/offline.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ASSET_BUDGET_BYTES, ASSET_RULES, offlineAssetSet } from "./assets.js";
import { offlineEnabledFor, sessionPerson } from "./switch.js";

function matchesEtag(request: FastifyRequest, etag: string) {
  const header = String(request.headers["if-none-match"] ?? "").trim();
  if (!header) return false;
  // NGINX weakens the tag of an answer it compresses, so compare the opaque part.
  const opaque = (value: string) => value.trim().replace(/^W\//, "");
  return header === "*" || header.split(",").some((value) => opaque(value) === opaque(etag));
}

export async function registerOfflineApi(app: FastifyInstance) {
  const warned = new Set<string>();

  app.get("/assets", {
    config: { access: { public: "A list of static browser file paths and their hashes; the files are already served to anyone. The session, when there is one, only decides `enabled`." } }
  }, async (request, reply) => {
    const [set, enabled] = await Promise.all([offlineAssetSet(), sessionPerson(request).then(offlineEnabledFor)]);
    if (set.bytes > ASSET_BUDGET_BYTES && !warned.has(set.release)) {
      warned.add(set.release);
      request.log.warn({ release: set.release, bytes: set.bytes, budget: ASSET_BUDGET_BYTES }, "The offline asset set is over its size budget.");
    }
    // Weak: `generated_at` is this process's, so two web nodes send different bytes for the same list.
    const tag = createHash("sha256").update(JSON.stringify([set.release, set.digest, ASSET_RULES.shells, ASSET_RULES.external, enabled])).digest("base64url").slice(0, 27);
    const etag = `W/"${tag}"`;
    reply.header("ETag", etag);
    // Always revalidated, never shared: `enabled` is the caller's.
    reply.header("Cache-Control", "private, no-cache");
    if (matchesEtag(request, etag)) return reply.code(304).send();
    return {
      enabled,
      release: set.release,
      generated_at: set.generated_at,
      files: set.files,
      shells: ASSET_RULES.shells,
      external: ASSET_RULES.external
    };
  });
}
