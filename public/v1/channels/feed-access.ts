import type { PlatformAuthContext } from "../platform/auth.js";
import type { MessageRow } from "./storage.js";

// Only the Feed API can grant access to an individually reauthorized root.
// Ordinary Channels routes never receive this request-local grant.
const grants = new WeakMap<PlatformAuthContext, Set<string>>();
export function grantFeedRoot(ctx: PlatformAuthContext, rootId: string) {
  let roots = grants.get(ctx);
  if (!roots) { roots = new Set(); grants.set(ctx, roots); }
  roots.add(rootId);
}
export function hasFeedGrant(ctx: PlatformAuthContext) { return grants.has(ctx); }
export function feedMessageGranted(ctx: PlatformAuthContext, message: MessageRow) {
  return grants.get(ctx)?.has(message.parent_id || message.id) === true;
}
