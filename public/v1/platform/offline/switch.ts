/**
 * Whether offline is on (docs/architecture/offline.md#asset-manifest, `enabled`).
 *
 * Two switches, either of which turns it off:
 * - `OFFLINE_ENABLED=0` on the host: off for everyone this host serves.
 * - the `platform.offline` flag (docs/architecture/feature-flags.md): an
 *   organization switch, so the flag console sets it for one organization, by
 *   percentage, or Off for everyone, and a change is read within 15 seconds
 *   with no release. Like every platform feature it needs expanded access.
 */
import type { FastifyRequest } from "fastify";
import { effectiveCapabilities } from "../capabilities.js";
import { readFlagRollouts } from "../flag-rollouts.js";
import { requestPrincipal } from "../security/principal.js";

export const OFFLINE_FLAG = "platform.offline";

export function offlineHostEnabled() {
  return String(process.env.OFFLINE_ENABLED ?? "").trim() !== "0";
}

/**
 * For a signed-in person: their organization's flag, as they get it. For nobody
 * in particular (a device whose session ran out still checks for updates): on
 * unless the flag is Off for everyone, so that device keeps its code and its
 * queued changes until someone signs in. No page registers the service worker
 * without a session.
 */
export async function offlineEnabledFor(who: { orgId: string; userId: string } | null) {
  if (!offlineHostEnabled()) return false;
  if (who) return (await effectiveCapabilities(who.orgId, who.userId)).effectiveByKey[OFFLINE_FLAG] === true;
  return (await readFlagRollouts())[OFFLINE_FLAG]?.killed !== true;
}

/** The session's person, or null for any other caller. Identity comes only from the session. */
export async function sessionPerson(request: FastifyRequest) {
  const principal = await requestPrincipal(request).catch(() => null);
  const auth = principal && (principal.kind === "customer" || principal.kind === "staff") ? principal.auth : null;
  return auth?.orgId && auth.userId ? { orgId: String(auth.orgId), userId: String(auth.userId) } : null;
}
