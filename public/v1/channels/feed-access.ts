import type { PlatformAuthContext } from "../platform/auth.js";
import type { MessageRow } from "./storage.js";

// Only the Feed API can grant access to an individually reauthorized root.
// Ordinary Channels routes never receive this request-local grant.
const grants = new WeakMap<PlatformAuthContext, string>();
export function grantFeedRoot(ctx: PlatformAuthContext, rootId: string) { grants.set(ctx, rootId); }
export function hasFeedGrant(ctx: PlatformAuthContext) { return grants.has(ctx); }
export function feedMessageGranted(ctx: PlatformAuthContext, message: MessageRow) {
  return grants.get(ctx) === (message.parent_id || message.id);
}
