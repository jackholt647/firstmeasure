import { APP_OFFERS, offeredAppIds } from './offers.js';
import { capabilityDefaultValues, capabilityValuesForUser, flattenGroupedValues, resolveCapabilities } from '../capabilities.js';
import { forbidden, notFound } from '../errors.js';
import { mutateGlobal, readGlobal, type JsonObject } from '../storage.js';
import type { PlatformAuthContext } from '../auth.js';

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/** The activation policy is intentionally separate from permissions inside the app. */
export function mayStartOfferedApp(ctx: PlatformAuthContext, appId: string) {
  return ctx.appEntitlements.some(app => app.id === appId && app.allowed && !app.restricted);
}

export async function startOfferedApp(ctx: PlatformAuthContext, appId: string) {
  const id = offeredAppIds([appId])[0];
  if (!id) throw notFound('app_offer_not_found', 'This app has no welcome offer.');
  if (!mayStartOfferedApp(ctx, id)) throw forbidden('app_offer_denied', 'This app is not available in your app experience.');
  const snapshot = object((await readGlobal(ctx.orgId)).data);
  const configuredFlags = object(snapshot.app_flags || snapshot.feature_flags);
  const ceiling = resolveCapabilities(await capabilityValuesForUser(ctx.orgId, ctx.userId,
    { ...capabilityDefaultValues(), ...flattenGroupedValues(configuredFlags) }, true)).effectiveByKey;
  if (!APP_OFFERS[id].some(key => ceiling[key] === true)) throw forbidden('app_offer_unavailable', 'This app is no longer offered by your organization.');
  // Membership, commercial eligibility and rollout were resolved from this request's verified session.
  // Recheck configured switches under the write lock; accepting an offer never changes those switches.
  await mutateGlobal(ctx.orgId, current => {
    const data = object(current.data);
    if (JSON.stringify(object(data.app_flags || data.feature_flags)) !== JSON.stringify(configuredFlags)) throw forbidden('app_offer_changed', 'The app offer changed. Open the tab again to continue.');
    const pending = offeredAppIds(data.app_offers);
    if (!pending.includes(id)) return { data: {} }; // Another person may already have started it.
    if (!ctx.appEntitlements.some(app => app.id === id && app.offered)) throw forbidden('app_offer_changed', 'The app offer changed. Open the tab again to continue.');
    return { data: { app_offers: pending.filter(value => value !== id), app_activations: {
      ...object(data.app_activations), [id]: { started_at: new Date().toISOString(), user_id: ctx.userId }
    } } };
  });
  return { ok: true, app_id: id };
}
