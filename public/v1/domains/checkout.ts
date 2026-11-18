// Buying domains (FM-590): a cart of domains is paid once through Stripe Checkout, each domain is then registered, and
// each one gets its own yearly Stripe subscription for its renewal, anchored ahead of the domain's expiry so a failed
// renewal payment can be retried (and the registrar's auto-renew turned off) before the registry renews it.
// Stripe is platform billing's client (same test-key rule on development); see README.md, "Buying domains".
import { createHash, randomBytes } from "node:crypto";

import { conflict, notFound } from "../platform/errors.js";
import { readDocument, readGlobal, upsertDocument, type JsonObject } from "../platform/storage.js";
import { stripe } from "../platform-billing/payments.js";
import { env } from "../src/config/env.js";
import type { DomainContact } from "./schemas.js";
import {
  decryptSecret,
  domainBillingConfigured,
  encryptSecret,
  freshDomainPrice,
  patchRegistration,
  registerPaidDomain,
  setRegistrarAutoRenew
} from "./service.js";
import { listRegistrations, readQuote, readRegistration, recordDomainEvent } from "./storage.js";

export const DOMAIN_CHECKOUT_COLLECTION = "domain_checkouts";
/** The renewal is charged this long before the domain expires, leaving Stripe time to retry a declined card. */
const RENEWAL_LEAD_DAYS = 30;
/** A checkout another request is fulfilling is left alone this long before it is taken over. */
const FULFILLING_STALE_MS = 5 * 60_000;

type CheckoutItem = {
  domain: string;
  quote_id: string;
  price: string;
  renewal_price: string;
  provider_registration_cost: string;
  provider_renewal_cost: string;
  provider_privacy_cost: string;
  premium: boolean;
  status?: "registered" | "refunded" | "refund_due" | "outcome_unknown";
  error?: string;
};

const clean = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const objectId = (value: unknown) => typeof value === "string" ? value : clean(asObject(value).id);
const cents = (price: unknown) => Math.round(Number.parseFloat(clean(price)) * 100);
const dollars = (amount: number) => (amount / 100).toFixed(2);
const hash = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function view(document: JsonObject): JsonObject {
  return { ...asObject(document.data), revision: Number(document.revision || 0) };
}

async function readCheckout(orgId: string, checkoutId: string) {
  const document = await readDocument(orgId, DOMAIN_CHECKOUT_COLLECTION, checkoutId).catch(() => null);
  if (!document) throw notFound("domain_checkout_not_found", "The domain checkout was not found.");
  return view(document);
}

async function saveCheckout(orgId: string, checkout: JsonObject, expectedRevision = 0) {
  const { revision: _revision, ...data } = checkout;
  const saved = await upsertDocument(orgId, DOMAIN_CHECKOUT_COLLECTION, {
    id: clean(data.id),
    data,
    metadata: { kind: "domain_checkout", status: data.status },
    ...(expectedRevision ? { expected_revision: expectedRevision } : {})
  }, { replace: true });
  return view(saved);
}

function itemsOf(checkout: JsonObject) {
  return (Array.isArray(checkout.items) ? checkout.items : []).map((item) => asObject(item) as unknown as CheckoutItem);
}

/** What the browser sees: prices and states, never registry costs, the registrant or Stripe identifiers. */
export function publicCheckout(checkout: JsonObject) {
  return {
    id: clean(checkout.id),
    status: clean(checkout.status),
    items: itemsOf(checkout).map((item) => ({
      domain: item.domain,
      price: item.price,
      renewal_price: item.renewal_price,
      privacy_price: "0.00",
      premium: item.premium === true,
      status: item.status || "",
      ...(item.error && item.status !== "registered" ? { error: item.error } : {})
    })),
    total: clean(checkout.total),
    currency: "USD",
    url: clean(checkout.status) === "open" ? clean(checkout.url) : "",
    created_at: clean(checkout.created_at),
    paid_at: clean(checkout.paid_at),
    fulfilled_at: clean(checkout.fulfilled_at)
  };
}

function returnBase() {
  const base = env.stripeBaseUrl.replace(/\/+$/, "");
  const url = new URL(base);
  if (env.dataEnvironment !== "production" && url.hostname !== "dev.1m8.ai" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw conflict("billing_return_url_invalid", "Development checkout must return to dev.1m8.ai.");
  }
  return base;
}

/**
 * Starts paying for a cart of domains. Every domain is checked and priced again; the customer's accepted total must
 * match today's prices exactly. The checkout and its exact Stripe request are saved before Stripe is called.
 */
export async function createDomainCheckout(input: {
  orgId: string;
  items: Array<{ quote_id: string; domain: string }>;
  contact: DomainContact;
  acceptTotal: string;
  allowPremium: boolean;
  actorUserId: string;
}) {
  if (!domainBillingConfigured()) throw conflict("domain_billing_unavailable", "Domain purchases are not available here yet.");
  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  for (const entry of input.items) {
    const domain = entry.domain.toLowerCase();
    if (seen.has(domain)) continue;
    seen.add(domain);
    const quote = await readQuote(input.orgId, entry.quote_id);
    if (!quote) throw notFound("domain_quote_not_found", "The domain quote was not found. Search again.");
    if (Date.parse(clean(quote.expires_at)) <= Date.now()) throw conflict("domain_quote_expired", "Prices have expired. Search again.");
    if (clean(quote.environment) !== env.domainsDeliveryMode) throw conflict("domain_environment_changed", "The domain service mode changed. Search again.");
    if (clean(quote.acquisition_type || "register") !== "register") throw conflict("domain_quote_wrong_type", "This quote cannot be used for a new registration.");
    const quoted = (Array.isArray(quote.items) ? quote.items : []).map(asObject).find((candidate) => clean(candidate.domain) === domain);
    if (!quoted || quoted.available !== true) throw conflict("domain_not_quoted_available", `${domain} was not quoted as available.`);
    const existing = await readRegistration(input.orgId, domain);
    if (existing && !["failed", "refunded"].includes(clean(existing.status))) throw conflict("domain_already_added", `${domain} is already one of your domains.`);
    const fresh = await freshDomainPrice(domain);
    if (fresh.price !== clean(quoted.price) || fresh.renewal_price !== clean(quoted.renewal_price)) {
      throw conflict("domain_price_changed", `The price of ${domain} changed. Search again to see today's price.`, {
        domain, quoted_price: clean(quoted.price), current_price: fresh.price, currency: "USD"
      });
    }
    if (fresh.premium && !input.allowPremium) throw conflict("premium_domain_confirmation_required", `${domain} is a premium domain and needs your confirmation.`);
    if (!fresh.premium && Number(fresh.provider_registration_cost) > Number(env.openSrsMaxStandardRegistrationPriceUsd)) {
      throw conflict("domain_price_limit_exceeded", `${domain} costs more than a standard domain can.`);
    }
    items.push({
      domain,
      quote_id: entry.quote_id,
      price: fresh.price,
      renewal_price: fresh.renewal_price,
      provider_registration_cost: fresh.provider_registration_cost,
      provider_renewal_cost: fresh.provider_renewal_cost,
      provider_privacy_cost: fresh.provider_privacy_cost,
      premium: fresh.premium
    });
  }
  if (!items.length) throw conflict("domain_checkout_empty", "Add a domain first.");
  const totalCents = items.reduce((sum, item) => sum + cents(item.price), 0);
  if (cents(input.acceptTotal) !== totalCents) {
    throw conflict("domain_price_not_accepted", "The total changed. Review the new total and try again.", { total: dollars(totalCents), currency: "USD" });
  }

  const id = `domain_checkout_${randomBytes(12).toString("hex")}`;
  const base = returnBase();
  const back = `${base}/index.php?tab=company_settings&sub=domains&domain_checkout=${encodeURIComponent(id)}`;
  const customer = clean(asObject(asObject(asObject((await readGlobal(input.orgId)).data).billing).stripe).customer_id);
  const fields: Record<string, string> = {
    mode: "payment",
    success_url: back,
    cancel_url: `${back}&domain_checkout_cancelled=1`,
    client_reference_id: id,
    "metadata[billing_kind]": "domain_checkout",
    "metadata[organization_id]": input.orgId,
    "metadata[checkout_id]": id,
    // The card is kept for the domains' yearly renewals.
    "payment_intent_data[setup_future_usage]": "off_session",
    "payment_intent_data[description]": `Domains: ${items.map((item) => item.domain).join(", ")}`,
    "payment_intent_data[metadata][billing_kind]": "domain_checkout",
    "payment_intent_data[metadata][organization_id]": input.orgId,
    "payment_intent_data[metadata][checkout_id]": id
  };
  if (customer) fields.customer = customer;
  else fields.customer_creation = "always";
  items.forEach((item, index) => {
    fields[`line_items[${index}][quantity]`] = "1";
    fields[`line_items[${index}][price_data][currency]`] = "usd";
    fields[`line_items[${index}][price_data][unit_amount]`] = String(cents(item.price));
    fields[`line_items[${index}][price_data][product_data][name]`] = `${item.domain} · 1 year`;
    fields[`line_items[${index}][price_data][product_data][description]`] = `Domain registration with free privacy. Renews yearly at $${item.renewal_price} until you turn renewal off.`;
  });
  const now = new Date().toISOString();
  let checkout = await saveCheckout(input.orgId, {
    id,
    status: "open",
    environment: env.domainsDeliveryMode,
    stripe_livemode: !env.stripeTestMode,
    items: items as unknown as JsonObject[],
    total: dollars(totalCents),
    total_cents: totalCents,
    currency: "USD",
    contact_encrypted: encryptSecret(JSON.stringify(input.contact)),
    actor_user_id: input.actorUserId,
    stripe_fields: fields,
    created_at: now
  });
  const session = await stripe("POST", "checkout/sessions", fields, `domain-checkout-${id}`);
  checkout = await saveCheckout(input.orgId, { ...checkout, session_id: clean(session.id), url: clean(session.url) });
  await recordDomainEvent(input.orgId, "domain.checkout.started", {
    domain: items.map((item) => item.domain).join(","),
    checkout_id: id,
    total: dollars(totalCents),
    actor_user_id: input.actorUserId
  });
  return publicCheckout(checkout);
}

export async function domainCheckout(orgId: string, checkoutId: string) {
  return publicCheckout(await readCheckout(orgId, checkoutId));
}

function verifySession(orgId: string, checkout: JsonObject, session: JsonObject) {
  const metadata = asObject(session.metadata);
  if (session.livemode !== !env.stripeTestMode) throw conflict("billing_payment_mode_mismatch", "The payment was made in the other Stripe mode.");
  if (metadata.billing_kind !== "domain_checkout" || metadata.organization_id !== orgId || metadata.checkout_id !== checkout.id
    || Number(session.amount_total) !== Number(checkout.total_cents) || clean(session.currency) !== "usd") {
    throw conflict("billing_payment_mismatch", "The payment does not match this domain checkout.");
  }
}

/**
 * Looks the payment up and, once it is paid, registers every domain and starts its renewal. Safe to call any number of
 * times, from the browser and from Stripe's webhook at once: one caller claims the work, every step is idempotent, and
 * a domain the registry refuses after payment is refunded.
 */
export async function refreshDomainCheckout(orgId: string, checkoutId: string, actor: string) {
  let checkout = await readCheckout(orgId, checkoutId);
  const status = clean(checkout.status);
  if (["fulfilled", "expired"].includes(status) || !clean(checkout.session_id)) return publicCheckout(checkout);
  if (status === "fulfilling" && Date.now() - Date.parse(clean(checkout.claimed_at)) < FULFILLING_STALE_MS) return publicCheckout(checkout);

  const session = asObject(await stripe("GET", `checkout/sessions/${encodeURIComponent(clean(checkout.session_id))}?expand[]=payment_intent`));
  verifySession(orgId, checkout, session);
  if (status === "open" && clean(session.status) === "expired") {
    return publicCheckout(await saveCheckout(orgId, { ...checkout, status: "expired", url: "" }, Number(checkout.revision)));
  }
  if (clean(session.payment_status) !== "paid") return publicCheckout(checkout);

  const intent = asObject(session.payment_intent);
  try {
    checkout = await saveCheckout(orgId, {
      ...checkout,
      status: "fulfilling",
      claimed_at: new Date().toISOString(),
      paid_at: clean(checkout.paid_at) || new Date().toISOString(),
      payment_intent_id: objectId(session.payment_intent),
      payment_method_id: objectId(intent.payment_method),
      customer_id: objectId(session.customer) || objectId(intent.customer)
    }, Number(checkout.revision));
  } catch (error) {
    if ((error as { code?: string }).code === "revision_conflict") return publicCheckout(await readCheckout(orgId, checkoutId));
    throw error;
  }
  if (status === "open") {
    await recordDomainEvent(orgId, "domain.checkout.paid", { domain: itemsOf(checkout).map((item) => item.domain).join(","), checkout_id: checkoutId, total: clean(checkout.total), actor_user_id: actor });
  }

  const contact = JSON.parse(decryptSecret(checkout.contact_encrypted)) as DomainContact;
  const items = itemsOf(checkout);
  for (const item of items) {
    if (item.status === "refunded" || item.status === "refund_due") continue;
    if (item.status !== "registered") {
      try {
        await registerPaidDomain({
          orgId,
          domain: item.domain,
          contact,
          pricing: item,
          checkoutId,
          actorUserId: clean(checkout.actor_user_id) || actor,
          billing: {
            billing_status: "paid",
            billing_collected: true,
            payment_provider: "stripe",
            payment_id: clean(checkout.payment_intent_id)
          }
        });
        item.status = "registered";
        delete item.error;
      } catch (error) {
        const code = clean((error as { code?: string }).code);
        // Ambiguous at the registry: the next refresh reconciles ownership before anything else.
        if (code === "domain_registration_outcome_unknown" || code === "domain_registration_in_progress") {
          item.status = "outcome_unknown";
          continue;
        }
        item.error = error instanceof Error ? error.message : "The registry refused this domain.";
        item.status = await refundItem(orgId, checkout, item) ? "refunded" : "refund_due";
        continue;
      }
    }
    // A renewal that could not be set up yet is retried on the next refresh; the registration stands.
    try {
      await startRenewal(orgId, checkout, item, asObject(await readRegistration(orgId, item.domain)));
      delete item.error;
    } catch {
      item.error = "renewal_pending";
    }
  }
  const finished = items.every((item) => ["registered", "refunded", "refund_due"].includes(item.status || "") && item.error !== "renewal_pending");
  checkout = await saveCheckout(orgId, {
    ...checkout,
    items: items as unknown as JsonObject[],
    status: finished ? "fulfilled" : "paid",
    ...(finished ? { fulfilled_at: new Date().toISOString() } : {})
  });
  return publicCheckout(checkout);
}

/** Refunds one domain of a paid checkout (the registry refused it). False when Stripe could not be reached. */
async function refundItem(orgId: string, checkout: JsonObject, item: CheckoutItem) {
  try {
    await stripe("POST", "refunds", {
      payment_intent: clean(checkout.payment_intent_id),
      amount: String(cents(item.price)),
      reason: "requested_by_customer",
      "metadata[billing_kind]": "domain_checkout",
      "metadata[organization_id]": orgId,
      "metadata[checkout_id]": clean(checkout.id),
      "metadata[domain]": item.domain
    }, `domain-refund-${hash(orgId, clean(checkout.id), item.domain)}`);
    await recordDomainEvent(orgId, "domain.checkout.refunded", { domain: item.domain, checkout_id: clean(checkout.id), amount: item.price });
    return true;
  } catch (error) {
    await recordDomainEvent(orgId, "domain.checkout.refund_due", { domain: item.domain, checkout_id: clean(checkout.id), amount: item.price, error: error instanceof Error ? error.message : "refund failed" });
    return false;
  }
}

/** The domain's yearly renewal: its own subscription on the card just used, first charged ahead of expiry. */
async function startRenewal(orgId: string, checkout: JsonObject, item: CheckoutItem, registration: JsonObject) {
  if (clean(asObject(registration.subscription).subscription_id)) return;
  const customer = clean(checkout.customer_id);
  const paymentMethod = clean(checkout.payment_method_id);
  if (!customer || !paymentMethod) throw conflict("domain_renewal_card_missing", "The payment did not keep a card for renewals.");
  const key = hash(orgId, item.domain, clean(checkout.id));
  const expires = Date.parse(clean(registration.expires_at)) || Date.now() + 365 * 86_400_000;
  const anchor = Math.max(Math.floor(Date.now() / 1000) + 86_400, Math.floor((expires - RENEWAL_LEAD_DAYS * 86_400_000) / 1000));
  const product = await stripe("POST", "products", {
    name: `Domain renewal · ${item.domain}`,
    "metadata[billing_kind]": "domain_subscription",
    "metadata[organization_id]": orgId,
    "metadata[domain]": item.domain
  }, `domain-product-${key}`);
  const subscription = await stripe("POST", "subscriptions", {
    customer,
    default_payment_method: paymentMethod,
    description: `Yearly renewal of ${item.domain}`,
    "items[0][quantity]": "1",
    "items[0][price_data][currency]": "usd",
    "items[0][price_data][product]": clean(product.id),
    "items[0][price_data][unit_amount]": String(cents(item.renewal_price)),
    "items[0][price_data][recurring][interval]": "year",
    // Nothing is charged now (the first year was just paid); the first renewal is charged at the anchor.
    billing_cycle_anchor: String(anchor),
    proration_behavior: "none",
    "metadata[billing_kind]": "domain_subscription",
    "metadata[organization_id]": orgId,
    "metadata[domain]": item.domain,
    "metadata[checkout_id]": clean(checkout.id)
  }, `domain-renewal-${key}`);
  if (subscription.livemode !== !env.stripeTestMode) throw conflict("billing_payment_mode_mismatch");
  await patchRegistration(orgId, item.domain, {
    renewal_billing: "subscription",
    subscription: subscriptionState(subscription, anchor)
  });
}

function subscriptionState(subscription: JsonObject, fallbackAnchor = 0) {
  const item = asObject((Array.isArray(asObject(subscription.items).data) ? asObject(subscription.items).data as unknown[] : [])[0]);
  const periodEnd = Number(item.current_period_end || subscription.billing_cycle_anchor || fallbackAnchor || 0);
  return {
    provider: "stripe",
    subscription_id: clean(subscription.id),
    status: clean(subscription.status),
    cancel_at_period_end: subscription.cancel_at_period_end === true,
    renews_at: periodEnd ? iso(periodEnd) : ""
  };
}

const ENDED = ["canceled", "unpaid", "incomplete_expired"];

/**
 * Brings one domain's renewal in line with its subscription (webhooks, and after a toggle): a subscription that ended,
 * or will end at its period, turns the registrar's auto-renew off so the registry never renews an unpaid domain.
 */
export async function reconcileDomainSubscription(orgId: string, subscriptionId: string) {
  const registrations = (await listRegistrations(orgId)).filter((entry) => clean(asObject(entry.subscription).subscription_id) === subscriptionId);
  if (!registrations.length) return [];
  const subscription = asObject(await stripe("GET", `subscriptions/${encodeURIComponent(subscriptionId)}`));
  const metadata = asObject(subscription.metadata);
  if (subscription.livemode !== !env.stripeTestMode || metadata.billing_kind !== "domain_subscription" || metadata.organization_id !== orgId) {
    throw conflict("billing_subscription_mismatch", "The subscription does not belong to this organization's domains.");
  }
  const state = subscriptionState(subscription);
  const renews = !ENDED.includes(state.status) && !state.cancel_at_period_end;
  const updated = [];
  for (const registration of registrations) {
    const domain = clean(registration.domain);
    if (registration.auto_renew !== renews && registration.simulated !== true) await setRegistrarAutoRenew(domain, renews);
    updated.push(await patchRegistration(orgId, domain, {
      subscription: state,
      auto_renew: renews,
      billing_status: state.status === "past_due" ? "past_due" : ENDED.includes(state.status) ? "renewal_ended" : "paid"
    }));
  }
  return updated;
}

/**
 * Turning a bought domain's auto-renew off or on (Settings › Domains › Manage) stops or resumes its subscription at the
 * end of the paid year. Returns the subscription state for the registration to save.
 */
export async function setDomainSubscriptionRenewal(registration: JsonObject, enabled: boolean) {
  const subscriptionId = clean(asObject(registration.subscription).subscription_id);
  const current = asObject(await stripe("GET", `subscriptions/${encodeURIComponent(subscriptionId)}`));
  if (enabled && ENDED.includes(clean(current.status))) {
    throw conflict("domain_renewal_ended", "This domain's renewal has ended, so it can't be turned back on here.");
  }
  if (ENDED.includes(clean(current.status))) return subscriptionState(current);
  const updated = await stripe("POST", `subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: enabled ? "false" : "true" });
  return subscriptionState(updated);
}

/** Stripe events for domain checkouts and renewals, after the webhook proxy has verified the signature and mode. */
export async function domainStripeWebhook(event: JsonObject) {
  const object = asObject(asObject(event.data).object);
  const metadata = asObject(object.metadata);
  if (metadata.billing_kind === "domain_checkout") {
    const orgId = clean(metadata.organization_id), checkoutId = clean(metadata.checkout_id);
    if (orgId && checkoutId) await refreshDomainCheckout(orgId, checkoutId, "stripe-webhook").catch((error) => {
      if ((error as { code?: string }).code !== "domain_checkout_not_found") throw error;
    });
    return true;
  }
  const details = asObject(asObject(object.parent).subscription_details);
  const subscriptionMetadata = metadata.billing_kind === "domain_subscription" ? metadata : asObject(details.metadata);
  if (subscriptionMetadata.billing_kind !== "domain_subscription") return false;
  const orgId = clean(subscriptionMetadata.organization_id);
  const subscriptionId = clean(object.object) === "subscription" ? clean(object.id) : objectId(details.subscription) || objectId(object.subscription);
  if (orgId && subscriptionId) await reconcileDomainSubscription(orgId, subscriptionId);
  return true;
}
