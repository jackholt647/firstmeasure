import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

import { conflict, notFound } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { env } from "../src/config/env.js";
import { createPublicSite, patchSite } from "../websites/service.js";
import { readSite } from "../websites/storage.js";
import { createOpenSrsClient, OpenSrsError, type OpenSrsRecord } from "./opensrs.js";
import { provisionDomainInfrastructure } from "./provisioning.js";
import { configureOrgDomainEmailIdentity, retireOrgDomainEmailIdentity, setOrgDomainEmailSending } from "../email/engine.js";
import { checkDomainEmailRecords as lookUpEmailRecords, checkNameservers, storedEmailRecords, systemResolver, type DnsResolver } from "./email-records.js";
import type { DomainContact } from "./schemas.js";
import {
  listRegistrations,
  newVerificationToken,
  newQuoteId,
  readQuote,
  readRegistration,
  recordDomainEvent,
  saveQuote,
  saveRegistration
} from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function amount(value: unknown) {
  const parsed = Number.parseFloat(cleanText(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizedPrice(value: unknown) {
  const parsed = amount(value);
  if (!Number.isFinite(parsed)) throw conflict("domain_price_invalid", "The registry returned an invalid domain price.");
  return parsed.toFixed(2);
}

/**
 * What a customer pays for a year of a domain (FM-590): the registry's price times the markup
 * (`DOMAINS_RETAIL_MARKUP_MULTIPLIER`, 1.5), rounded up to the next $5 (`DOMAINS_RETAIL_ROUNDING_USD`).
 * A $14 registry price is $25. WHOIS privacy is free to the customer: its registry fee is ours.
 */
export function customerDomainPrice(cost: unknown) {
  const parsed = amount(cost);
  if (!Number.isFinite(parsed) || parsed < 0) throw conflict("domain_price_invalid", "A domain price component is invalid.");
  const marked = Math.round(parsed * Math.max(1, env.domainsRetailMarkupMultiplier) * 100) / 100;
  const step = Math.max(0.01, env.domainsRetailRoundingUsd);
  return (Math.ceil(marked / step - 1e-9) * step).toFixed(2);
}

function verificationReminderAvailableAt(from = Date.now()) {
  return new Date(from + 60 * 60_000).toISOString();
}

function encryptionKey() {
  if (!env.domainsEncryptionKey || env.domainsEncryptionKey.length < 32) {
    throw conflict("domains_encryption_not_configured", "DOMAINS_ENCRYPTION_KEY must be at least 32 characters before registering domains.");
  }
  return createHash("sha256").update(env.domainsEncryptionKey).digest();
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptSecret(value: unknown) {
  const sealed = asObject(value);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(cleanText(sealed.iv), "base64url"));
  decipher.setAuthTag(Buffer.from(cleanText(sealed.tag), "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cleanText(sealed.ciphertext), "base64url")), decipher.final()]).toString("utf8");
}

function registrantCredentials(orgId: string, domain: string) {
  const username = `fm${createHash("sha256").update(`${orgId}:${domain}`).digest("hex").slice(0, 16)}`;
  const password = randomBytes(15).toString("base64url");
  return { username, password };
}

function publicRegistration(value: JsonObject) {
  const next = { ...value };
  if (!cleanText(next.default_email) && cleanText(next.from_email)) next.default_email = next.from_email;
  if (!cleanText(next.default_email_local_part) && cleanText(next.from_email_local_part)) next.default_email_local_part = next.from_email_local_part;
  if (!cleanText(next.email_configuration_status) && cleanText(next.email_sender_status)) next.email_configuration_status = next.email_sender_status;
  delete next.registrant_credentials;
  delete next.registrant_contact;
  delete next.registrant_contact_encrypted;
  delete next.provider;
  delete next.environment;
  delete next.provider_order_id;
  delete next.provider_domain_id;
  delete next.provider_registration_code;
  delete next.provider_registration_text;
  delete next.provider_error;
  delete next.provider_cost;
  delete next.provider_registration_cost;
  delete next.provider_privacy_cost;
  delete next.provider_renewal_cost;
  delete next.auth_code_encrypted;
  return next;
}

function publicQuote(value: JsonObject) {
  const quote = { ...value };
  delete quote.provider;
  delete quote.environment;
  quote.items = (Array.isArray(quote.items) ? quote.items : []).map((entry) => {
    const item = { ...asObject(entry) };
    delete item.provider_cost;
    delete item.provider_registration_cost;
    delete item.provider_privacy_cost;
    delete item.provider_renewal_cost;
    delete item.registration_price;
    return item;
  });
  return quote;
}

/** Whether domain purchases can be charged here (the same Stripe account and test-key rule as platform billing). */
export function domainBillingConfigured() {
  const secret = env.stripeSecretKey || (env.stripeTestMode ? env.stripeTestSecretKey : env.stripeLiveSecretKey);
  return Boolean(secret) && (env.dataEnvironment === "production" || (env.stripeTestMode && secret.startsWith("sk_test_")));
}

export function domainsConfiguration() {
  const username = env.domainsDeliveryMode === "live" ? env.openSrsLiveUsername : env.openSrsTestUsername;
  const apiKey = env.domainsDeliveryMode === "live" ? env.openSrsLiveApiKey : env.openSrsTestApiKey;
  return {
    service: "domain_registry",
    mode: env.domainsDeliveryMode,
    order_test_mode: env.domainsOrderTestMode,
    configured: Boolean(username && apiKey),
    username_configured: Boolean(username),
    api_key_configured: Boolean(apiKey),
    encryption_configured: env.domainsEncryptionKey.length >= 32,
    privacy_required: true,
    auto_renew_required: true,
    lock_required: true,
    // FM-590: buying a domain is paid through Stripe Checkout, its renewals by a yearly subscription.
    billing_enabled: domainBillingConfigured(),
    privacy_price: "0.00",
    supported_acquisition_types: ["register", "transfer", "existing"]
  };
}

export async function quoteDomains(orgId: string, domains: string[], _period: number, acquisitionType: "register" | "transfer" = "register") {
  const client = createOpenSrsClient();
  const unique = [...new Set(domains.map((domain) => domain.toLowerCase()))];
  const items = [];
  for (const domain of unique) {
    const lookup = acquisitionType === "register" ? await client.lookup(domain) : null;
    if (lookup && !lookup.available) {
      items.push({
        domain,
        available: false,
        status: lookup.status,
        premium: lookup.premium,
        reason: lookup.reason || lookup.responseText
      });
      continue;
    }
    // A purchase is one year, renewed yearly by its subscription (FM-590), so every quote is for one year.
    const price = await client.getPrice(domain, 1, acquisitionType === "transfer" ? "transfer" : "new");
    const registrationCost = normalizedPrice(price.price);
    const renewalCost = acquisitionType === "register" ? await renewalCostOf(client, domain, registrationCost) : registrationCost;
    items.push({
      domain,
      available: true,
      status: lookup?.status || "transferable",
      price: customerDomainPrice(registrationCost),
      renewal_price: customerDomainPrice(renewalCost),
      privacy_price: "0.00",
      provider_registration_cost: registrationCost,
      provider_renewal_cost: renewalCost,
      provider_privacy_cost: normalizedPrice(env.openSrsPrivacyPriceUsd),
      currency: "USD",
      premium: Boolean(lookup?.premium || price.premium),
      premium_group: price.premiumGroup
    });
  }
  const now = new Date();
  const quote = await saveQuote(orgId, {
    id: newQuoteId(),
    provider: "opensrs",
    environment: client.environment,
    period: 1,
    acquisition_type: acquisitionType,
    items,
    created_at: now.toISOString(),
    // Long enough to fill a cart and the registrant details; checkout prices every domain again anyway.
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString()
  });
  return publicQuote(quote);
}

/** The registry's price for a year's renewal; when it has none, the new-registration price. */
async function renewalCostOf(client: ReturnType<typeof createOpenSrsClient>, domain: string, fallback: string) {
  try {
    return normalizedPrice((await client.getPrice(domain, 1, "renewal")).price);
  } catch {
    return fallback;
  }
}

function contactForOpenSrs(contact: DomainContact): OpenSrsRecord {
  return {
    first_name: contact.first_name,
    last_name: contact.last_name,
    org_name: contact.org_name,
    address1: contact.address1,
    address2: contact.address2 || "",
    city: contact.city,
    state: contact.state,
    postal_code: contact.postal_code,
    country: contact.country,
    phone: contact.phone,
    email: contact.email
  };
}

/** A domain priced again right now: still available, and what it costs today (checkout, FM-590). */
export async function freshDomainPrice(domain: string) {
  const client = createOpenSrsClient();
  const lookup = await client.lookup(domain);
  if (!lookup.available) throw conflict("domain_no_longer_available", `${domain} is no longer available.`, { domain });
  const price = await client.getPrice(domain, 1, "new");
  const registrationCost = normalizedPrice(price.price);
  const renewalCost = await renewalCostOf(client, domain, registrationCost);
  return {
    environment: client.environment,
    premium: lookup.premium || price.premium,
    price: customerDomainPrice(registrationCost),
    renewal_price: customerDomainPrice(renewalCost),
    provider_registration_cost: registrationCost,
    provider_renewal_cost: renewalCost,
    provider_privacy_cost: normalizedPrice(env.openSrsPrivacyPriceUsd)
  };
}

/**
 * Registers a domain the customer has paid for (domains/checkout.ts, FM-590): one year, auto-renew, lock and privacy on.
 * The domain is the idempotency key: a registration already made is returned, an ambiguous one is reconciled first.
 */
export async function registerPaidDomain(input: {
  orgId: string;
  domain: string;
  contact: DomainContact;
  pricing: { price: string; renewal_price: string; provider_registration_cost: string; provider_renewal_cost: string; provider_privacy_cost: string; premium: boolean };
  billing: JsonObject;
  checkoutId: string;
  actorUserId: string;
}) {
  const prior = await readRegistration(input.orgId, input.domain);
  if (prior && ["active", "ready_to_connect", "verification_pending"].includes(cleanText(prior.status))) return { registration: publicRegistration(prior), idempotent_replay: true };
  if (prior && cleanText(prior.status) === "outcome_unknown") {
    const ownership = await createOpenSrsClient().belongsToReseller(input.domain);
    if (!ownership.belongs) {
      throw conflict("domain_registration_outcome_unknown", "The earlier registration has an ambiguous outcome and could not be reconciled safely.");
    }
    const reconciled = await saveRegistration(input.orgId, input.domain, {
      ...prior,
      status: "verification_pending",
      expires_at: ownership.expiresAt,
      reconciled_at: new Date().toISOString()
    });
    return { registration: publicRegistration(reconciled), idempotent_replay: true, reconciled: true };
  }
  if (prior && cleanText(prior.status) === "pending") throw conflict("domain_registration_in_progress", "This domain registration is already in progress.");
  if (!input.pricing.premium && amount(input.pricing.provider_registration_cost) > amount(env.openSrsMaxStandardRegistrationPriceUsd)) {
    throw conflict("domain_price_limit_exceeded", "The quoted domain price exceeds the configured standard-domain safety limit.");
  }

  const client = createOpenSrsClient();
  const common = {
    acquisition_type: "register",
    provider: "opensrs",
    environment: client.environment,
    checkout_id: input.checkoutId,
    period: 1,
    price: input.pricing.price,
    renewal_price: input.pricing.renewal_price,
    privacy_price: "0.00",
    provider_registration_cost: input.pricing.provider_registration_cost,
    provider_renewal_cost: input.pricing.provider_renewal_cost,
    provider_privacy_cost: input.pricing.provider_privacy_cost,
    currency: "USD",
    ...input.billing,
    premium: input.pricing.premium,
    privacy_enabled: true,
    auto_renew: true,
    locked: true,
    actor_user_id: input.actorUserId
  };

  if (env.domainsOrderTestMode) {
    const timestamp = new Date().toISOString();
    const simulated = await saveRegistration(input.orgId, input.domain, {
      ...common,
      status: "verification_pending",
      simulated: true,
      test_mode: true,
      registrant_verification_status: "pending",
      verification_reminder_available_at: verificationReminderAvailableAt(),
      submitted_at: timestamp,
      registered_at: timestamp,
      expires_at: oneYearFrom(timestamp),
      verification: { method: "simulated_registrant", test_mode: true }
    });
    await recordDomainEvent(input.orgId, "domain.registration.simulated", {
      domain: input.domain,
      checkout_id: input.checkoutId,
      actor_user_id: input.actorUserId,
      environment: client.environment
    });
    return { registration: publicRegistration(simulated), idempotent_replay: false, simulated: true };
  }

  const credentials = registrantCredentials(input.orgId, input.domain);
  const pending = await saveRegistration(input.orgId, input.domain, {
    ...common,
    status: "pending",
    registrant_contact_encrypted: encryptSecret(JSON.stringify(input.contact)),
    registrant_credentials: {
      username: credentials.username,
      password: encryptSecret(credentials.password)
    },
    submitted_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.registration.started", {
    domain: input.domain,
    checkout_id: input.checkoutId,
    actor_user_id: input.actorUserId,
    price: input.pricing.price,
    currency: "USD",
    environment: client.environment
  });

  try {
    const response = await client.register({
      domain: input.domain,
      period: 1,
      registrantUsername: credentials.username,
      registrantPassword: credentials.password,
      contact: contactForOpenSrs(input.contact),
      premiumPrice: input.pricing.premium ? input.pricing.provider_registration_cost : undefined
    });
    const registeredAt = new Date().toISOString();
    const saved = await saveRegistration(input.orgId, input.domain, {
      ...pending,
      status: "verification_pending",
      provider_order_id: response.orderId,
      provider_domain_id: response.domainId,
      provider_registration_code: response.registrationCode,
      provider_registration_text: response.registrationText,
      privacy_state: response.privacyState || "enabled",
      registrant_verification_status: "pending",
      verification_reminder_available_at: verificationReminderAvailableAt(),
      registered_at: registeredAt,
      expires_at: oneYearFrom(registeredAt)
    });
    await recordDomainEvent(input.orgId, "domain.registration.succeeded", {
      domain: input.domain,
      provider_order_id: response.orderId,
      provider_domain_id: response.domainId,
      actor_user_id: input.actorUserId
    });
    return { registration: publicRegistration(saved), idempotent_replay: false };
  } catch (error) {
    const providerError = error instanceof OpenSrsError ? error : null;
    const status = providerError?.outcomeUnknown ? "outcome_unknown" : "failed";
    await saveRegistration(input.orgId, input.domain, {
      ...pending,
      status,
      provider_error: {
        response_code: providerError?.responseCode || "",
        response_text: providerError?.responseText || (error instanceof Error ? error.message : "Registration failed")
      },
      failed_at: new Date().toISOString()
    });
    await recordDomainEvent(input.orgId, `domain.registration.${status}`, {
      domain: input.domain,
      checkout_id: input.checkoutId,
      actor_user_id: input.actorUserId,
      response_code: providerError?.responseCode || ""
    });
    if (status === "outcome_unknown") {
      throw conflict("domain_registration_outcome_unknown", "The registry may have accepted the registration, but the response was ambiguous. The next retry will reconcile ownership before doing anything billable.");
    }
    throw error;
  }
}

function oneYearFrom(iso: string) {
  const date = new Date(iso);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

/** A saved registration with fields merged in, for the checkout and its renewals (domains/checkout.ts). */
export async function patchRegistration(orgId: string, domain: string, patch: JsonObject) {
  const current = await readRegistration(orgId, domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  return publicRegistration(await saveRegistration(orgId, domain, { ...current, ...patch }));
}

/** Turns the registrar's own auto-renew on or off; a test-mode registration only records it. */
export async function setRegistrarAutoRenew(domain: string, enabled: boolean) {
  if (env.domainsOrderTestMode) return { simulated: true };
  await createOpenSrsClient().setAutoRenew(domain, enabled);
  return { simulated: false };
}

export async function organizationDomains(orgId: string) {
  const registrations = await listRegistrations(orgId);
  return await Promise.all(registrations.map(async (registration) => {
    const websiteId = cleanText(registration.website_id);
    const website = websiteId ? await readSite(orgId, websiteId).catch(() => null) : null;
    return {
      ...publicRegistration(registration),
      website: website ? {
        id: cleanText(website.id),
        name: cleanText(website.name) || "Website",
        status: cleanText(website.status) || "draft"
      } : null
    };
  }));
}

function ensureRegistrarManaged(registration: JsonObject) {
  if (cleanText(registration.acquisition_type) === "existing") {
    throw conflict("domain_managed_externally", "This domain remains at its current registrar. Change registrar settings there, or transfer it to FirstMate first.");
  }
}

export async function updateDomainManagement(input: {
  orgId: string;
  domain: string;
  autoRenew?: boolean;
  locked?: boolean;
  nameservers?: string[];
  actorUserId: string;
}) {
  const current = await readRegistration(input.orgId, input.domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  ensureRegistrarManaged(current);
  // A bought domain renews through its own subscription (FM-590): stop or resume that first, so the registrar never
  // renews a domain whose renewal isn't being paid.
  const subscription = input.autoRenew !== undefined && input.autoRenew !== current.auto_renew && cleanText(asObject(current.subscription).subscription_id)
    ? await (await import("./checkout.js")).setDomainSubscriptionRenewal(current, input.autoRenew)
    : null;
  const client = createOpenSrsClient();
  if (!env.domainsOrderTestMode) {
    if (input.autoRenew !== undefined && input.autoRenew !== current.auto_renew) {
      await client.setAutoRenew(input.domain, input.autoRenew);
    }
    if (input.locked !== undefined && input.locked !== current.locked) {
      await client.setDomainLock(input.domain, input.locked);
    }
    if (input.nameservers) await client.updateNameservers(input.domain, input.nameservers);
  }
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    ...(input.autoRenew === undefined ? {} : { auto_renew: input.autoRenew }),
    ...(subscription ? { subscription } : {}),
    ...(input.locked === undefined ? {} : { locked: input.locked }),
    ...(input.nameservers ? { nameservers: [...new Set(input.nameservers)] } : {}),
    management_simulated: env.domainsOrderTestMode,
    management_updated_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.management.updated", {
    domain: input.domain,
    actor_user_id: input.actorUserId,
    changed: [
      ...(input.autoRenew === undefined ? [] : ["auto_renew"]),
      ...(input.locked === undefined ? [] : ["locked"]),
      ...(input.nameservers ? ["nameservers"] : [])
    ],
    simulated: env.domainsOrderTestMode
  });
  return publicRegistration(saved);
}

export async function requestDomainTransferOut(input: {
  orgId: string;
  domain: string;
  actorUserId: string;
}) {
  const current = await readRegistration(input.orgId, input.domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  ensureRegistrarManaged(current);
  const client = createOpenSrsClient();
  if (!env.domainsOrderTestMode) {
    if (current.locked !== false) await client.setDomainLock(input.domain, false);
    await client.sendTransferAuthCode(input.domain);
  }
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    locked: false,
    transfer_out_requested_at: new Date().toISOString(),
    transfer_out_simulated: env.domainsOrderTestMode
  });
  await recordDomainEvent(input.orgId, "domain.transfer_out.requested", {
    domain: input.domain,
    actor_user_id: input.actorUserId,
    simulated: env.domainsOrderTestMode
  });
  return publicRegistration(saved);
}

export async function disconnectDomainFromFirstMate(input: {
  orgId: string;
  domain: string;
  context: PlatformAuthContext;
}) {
  const current = await readRegistration(input.orgId, input.domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  const websiteId = cleanText(current.website_id);
  if (websiteId) {
    const website = await readSite(input.orgId, websiteId).catch(() => null);
    if (website) {
      const settings = asObject(website.settings);
      const domains = (Array.isArray(settings.domains) ? settings.domains : [])
        .map(cleanText).filter((domain) => domain && domain !== input.domain);
      await patchSite(input.orgId, websiteId, {
        settings: {
          ...settings,
          domains,
          primary_domain: cleanText(settings.primary_domain) === input.domain ? (domains[0] || "") : settings.primary_domain
        }
      }, input.context);
    }
  }
  // Mail stops sending from (and arriving at) a disconnected domain; FirstMate Mail takes over.
  await retireOrgDomainEmailIdentity(input.orgId, input.domain);
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    website_id: "",
    status: current.verified_at ? "ready_to_connect" : current.status,
    email_configuration_status: cleanText(current.email_configuration_status) === "active" ? "records_pending" : current.email_configuration_status,
    resources_disconnected_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.resources.disconnected", {
    domain: input.domain,
    website_id: websiteId,
    actor_user_id: input.context.userId
  });
  return publicRegistration(saved);
}

export async function transferQuotedDomain(input: {
  orgId: string;
  quoteId: string;
  domain: string;
  authCode: string;
  contact: DomainContact;
  acceptPrice: string;
  allowPremium: boolean;
  actorUserId: string;
}) {
  const quote = await readQuote(input.orgId, input.quoteId);
  if (!quote) throw notFound("domain_quote_not_found", "The domain quote was not found.");
  if (Date.parse(cleanText(quote.expires_at)) <= Date.now()) throw conflict("domain_quote_expired", "The domain quote has expired. Request a new quote.");
  if (cleanText(quote.environment) !== env.domainsDeliveryMode) throw conflict("domain_environment_changed", "The domain service mode changed. Request a new quote.");
  if (cleanText(quote.acquisition_type) !== "transfer") throw conflict("domain_quote_wrong_type", "This quote cannot be used for a transfer.");
  const item = (Array.isArray(quote.items) ? quote.items : []).map(asObject)
    .find((candidate) => cleanText(candidate.domain) === input.domain);
  if (!item?.available) throw conflict("domain_transfer_not_quoted", "The selected transfer was not quoted.");
  const quotedPrice = normalizedPrice(item.price);
  if (normalizedPrice(input.acceptPrice) !== quotedPrice) throw conflict("domain_price_not_accepted", "The accepted price does not match the quote.");
  if (item.premium === true && !input.allowPremium) throw conflict("premium_domain_confirmation_required", "Premium domains require explicit confirmation.");

  const prior = await readRegistration(input.orgId, input.domain);
  if (prior && ["transfer_pending", "verification_pending", "ready_to_connect", "active"].includes(cleanText(prior.status))) {
    return { registration: publicRegistration(prior), idempotent_replay: true };
  }
  if (prior && cleanText(prior.status) === "pending") throw conflict("domain_transfer_in_progress", "This transfer is already in progress.");

  const client = createOpenSrsClient();
  const fresh = await client.getPrice(input.domain, 1, "transfer");
  const providerRegistrationCost = normalizedPrice(fresh.price);
  const providerPrivacyCost = normalizedPrice(env.openSrsPrivacyPriceUsd);
  const currentPrice = customerDomainPrice(providerRegistrationCost);
  if (currentPrice !== quotedPrice) {
    throw conflict("domain_price_changed", "The transfer price changed. Request and accept a new quote.", {
      quoted_price: quotedPrice,
      current_price: currentPrice,
      currency: "USD"
    });
  }
  if (env.domainsOrderTestMode) {
    const timestamp = new Date().toISOString();
    const simulated = await saveRegistration(input.orgId, input.domain, {
      acquisition_type: "transfer",
      provider: "opensrs",
      environment: client.environment,
      status: "verification_pending",
      simulated: true,
      test_mode: true,
      registrant_verification_status: "pending",
      verification_reminder_available_at: verificationReminderAvailableAt(),
      quote_id: input.quoteId,
      period: 1,
      price: currentPrice,
      provider_registration_cost: providerRegistrationCost,
      provider_privacy_cost: providerPrivacyCost,
      currency: "USD",
      billing_status: "simulated",
      billing_collected: false,
      premium: item.premium === true,
      privacy_enabled: true,
      auto_renew: true,
      locked: true,
      actor_user_id: input.actorUserId,
      submitted_at: timestamp,
      transfer_started_at: timestamp,
      verification: { method: "simulated_registrant", test_mode: true }
    });
    await recordDomainEvent(input.orgId, "domain.transfer.simulated", {
      domain: input.domain,
      quote_id: input.quoteId,
      actor_user_id: input.actorUserId,
      environment: client.environment
    });
    return { registration: publicRegistration(simulated), idempotent_replay: false, simulated: true };
  }
  const credentials = registrantCredentials(input.orgId, input.domain);
  const pending = await saveRegistration(input.orgId, input.domain, {
    acquisition_type: "transfer",
    provider: "opensrs",
    environment: client.environment,
    status: "pending",
    quote_id: input.quoteId,
    period: 1,
    price: currentPrice,
    provider_registration_cost: providerRegistrationCost,
    provider_privacy_cost: providerPrivacyCost,
    currency: "USD",
    billing_status: "deferred",
    billing_collected: false,
    premium: item.premium === true,
    privacy_enabled: true,
    auto_renew: true,
    locked: true,
    registrant_contact_encrypted: encryptSecret(JSON.stringify(input.contact)),
    auth_code_encrypted: encryptSecret(input.authCode),
    registrant_credentials: { username: credentials.username, password: encryptSecret(credentials.password) },
    actor_user_id: input.actorUserId,
    submitted_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.transfer.started", { domain: input.domain, actor_user_id: input.actorUserId });
  try {
    const response = await client.transfer({
      domain: input.domain,
      authCode: input.authCode,
      registrantUsername: credentials.username,
      registrantPassword: credentials.password,
      contact: contactForOpenSrs(input.contact),
      premiumPrice: item.premium === true ? providerRegistrationCost : undefined
    });
    const saved = await saveRegistration(input.orgId, input.domain, {
      ...pending,
      status: "transfer_pending",
      provider_order_id: response.orderId,
      provider_transfer_id: response.transferId,
      provider_domain_id: response.domainId,
      privacy_state: response.privacyState || "enabling",
      registrant_verification_status: "pending",
      verification_reminder_available_at: verificationReminderAvailableAt(),
      transfer_started_at: new Date().toISOString()
    });
    await recordDomainEvent(input.orgId, "domain.transfer.submitted", { domain: input.domain, actor_user_id: input.actorUserId });
    return { registration: publicRegistration(saved), idempotent_replay: false };
  } catch (error) {
    const providerError = error instanceof OpenSrsError ? error : null;
    const status = providerError?.outcomeUnknown ? "outcome_unknown" : "failed";
    await saveRegistration(input.orgId, input.domain, {
      ...pending,
      status,
      provider_error: {
        response_code: providerError?.responseCode || "",
        response_text: providerError?.responseText || (error instanceof Error ? error.message : "Transfer failed")
      },
      failed_at: new Date().toISOString()
    });
    throw error;
  }
}

export async function connectExistingDomain(input: { orgId: string; domain: string; actorUserId: string }) {
  const prior = await readRegistration(input.orgId, input.domain);
  if (prior) return { registration: publicRegistration(prior), idempotent_replay: true };
  const token = newVerificationToken();
  const saved = await saveRegistration(input.orgId, input.domain, {
    acquisition_type: "existing",
    status: "dns_verification_pending",
    verification: {
      method: "dns_txt",
      host: `_firstmate-verification.${input.domain}`,
      value: token
    },
    billing_status: "not_required",
    actor_user_id: input.actorUserId,
    submitted_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.connection.started", { domain: input.domain, actor_user_id: input.actorUserId });
  return { registration: publicRegistration(saved), idempotent_replay: false };
}

export async function refreshDomainVerification(orgId: string, domain: string) {
  const current = await readRegistration(orgId, domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  if (current.simulated === true && !current.verified_at) {
    const saved = await saveRegistration(orgId, domain, {
      ...current,
      registrant_verification_status: "verified",
      status: current.website_id ? "active" : "ready_to_connect",
      verified_at: new Date().toISOString(),
      test_verification_completed_at: new Date().toISOString()
    });
    await recordDomainEvent(orgId, "domain.verification.simulated", { domain });
    return publicRegistration(saved);
  }
  const acquisitionType = cleanText(current.acquisition_type || "register");
  if (acquisitionType === "existing") {
    const verification = asObject(current.verification);
    let verified = false;
    try {
      const records = await resolveTxt(cleanText(verification.host));
      verified = records.some((parts) => parts.join("") === cleanText(verification.value));
    } catch {
      verified = false;
    }
    if (!verified) return publicRegistration(current);
    const saved = await saveRegistration(orgId, domain, {
      ...current,
      status: current.website_id ? "active" : "ready_to_connect",
      verified_at: new Date().toISOString()
    });
    await recordDomainEvent(orgId, "domain.connection.verified", { domain });
    return publicRegistration(saved);
  }
  const result = await createOpenSrsClient().registrantVerificationStatus(domain);
  const pending = cleanText(result.status).toLowerCase() === "verifying";
  const saved = await saveRegistration(orgId, domain, {
    ...current,
    registrant_verification_status: pending ? "pending" : "verified",
    status: pending ? cleanText(current.status) : (current.website_id ? "active" : "ready_to_connect"),
    ...(pending ? {} : { verified_at: new Date().toISOString() })
  });
  return publicRegistration(saved);
}

export async function resendDomainVerification(orgId: string, domain: string) {
  const current = await readRegistration(orgId, domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  if (current.verified_at || ["ready_to_connect", "active"].includes(cleanText(current.status))) {
    throw conflict("domain_already_verified", "This domain is already verified.");
  }
  if (cleanText(current.acquisition_type) === "existing") {
    throw conflict("dns_verification_has_no_email", "This domain is verified with a DNS record, so there is no verification email.");
  }
  const availableAt = Date.parse(cleanText(current.verification_reminder_available_at));
  if (Number.isFinite(availableAt) && availableAt > Date.now()) {
    throw conflict("verification_reminder_not_ready", "A verification reminder becomes available one hour after registration.");
  }
  if (current.simulated === true) {
    const saved = await saveRegistration(orgId, domain, { ...current, verification_email_sent_at: new Date().toISOString(), verification_reminder_simulated: true });
    return publicRegistration(saved);
  }
  await createOpenSrsClient().sendRegistrantVerificationEmail(domain);
  const saved = await saveRegistration(orgId, domain, { ...current, verification_email_sent_at: new Date().toISOString() });
  return publicRegistration(saved);
}

export async function attachDomainResources(input: {
  orgId: string;
  domain: string;
  website: { mode: "existing"; id: string } | { mode: "create"; name: string } | { mode: "none" };
  defaultEmailLocalPart: string;
  context: PlatformAuthContext;
}) {
  const current = await readRegistration(input.orgId, input.domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");

  let websiteId = "";
  let website: JsonObject | null = null;
  if (input.website.mode === "existing") {
    website = await readSite(input.orgId, input.website.id);
    websiteId = input.website.id;
  } else if (input.website.mode === "create") {
    website = await createPublicSite(input.orgId, input.website.name, input.context);
    websiteId = cleanText(website.id);
  }
  if (website && websiteId) {
    const settings = asObject(website.settings);
    const domains = Array.isArray(settings.domains) ? settings.domains.map(cleanText).filter(Boolean) : [];
    const defaultEmail = `${input.defaultEmailLocalPart}@${input.domain}`;
    await patchSite(input.orgId, websiteId, {
      settings: {
        ...settings,
        primary_domain: input.domain,
        domains: [...new Set([input.domain, ...domains])],
        default_email: {
          ...asObject(settings.default_email),
          local_part: input.defaultEmailLocalPart,
          address: defaultEmail,
          status: "pending_provider_setup"
        }
      }
    }, input.context);
  }
  const defaultEmail = `${input.defaultEmailLocalPart}@${input.domain}`;
  const verified = Boolean(current.verified_at) || ["ready_to_connect", "active"].includes(cleanText(current.status));
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    website_id: websiteId || cleanText(current.website_id),
    default_email_local_part: input.defaultEmailLocalPart,
    default_email: defaultEmail,
    // A domain whose email already works keeps it while its address changes; the check below confirms it.
    email_configuration_status: cleanText(current.email_configuration_status) === "active" ? "active" : "pending_provider_setup",
    status: verified && (websiteId || input.website.mode === "none") ? "active" : cleanText(current.status),
    resources_connected_at: new Date().toISOString()
  });
  await configureOrgDomainEmailIdentity({
    organizationId: input.orgId,
    branchId: input.context.branchId || "default",
    domain: input.domain,
    localPart: input.defaultEmailLocalPart,
    verified
  });
  await recordDomainEvent(input.orgId, "domain.resources.connected", {
    domain: input.domain,
    website_id: websiteId,
    default_email: defaultEmail,
    actor_user_id: input.context.userId
  });
  const infrastructure = await provisionDomainInfrastructure({
    orgId: input.orgId,
    domain: input.domain,
    actorUserId: input.context.userId
  });
  // Records already in place (a domain moving to a new address, or a simulated one) make email ready at once.
  const checked = verified ? await checkDomainEmail(input.orgId, input.domain).catch(() => null) : null;
  return {
    registration: checked?.registration ?? publicRegistration(infrastructure.registration),
    website_id: websiteId,
    default_email: defaultEmail,
    infrastructure: { simulated: infrastructure.simulated, plan: infrastructure.plan }
  };
}

/**
 * Check the domain's email records in public DNS (FM-516) and, for a domain that stays at its registrar, that it is
 * pointed at the zone's nameservers. When every record is found the domain's email is active: its address becomes the
 * default sender. A domain whose records go missing falls back to FirstMate Mail until they are back. A simulated
 * domain (bought in registry test mode) has nothing in DNS, so its records are taken as found, as its verification is.
 */
export async function checkDomainEmail(orgId: string, domain: string, options: { resolver?: DnsResolver } = {}) {
  const current = await readRegistration(orgId, domain);
  if (!current) throw notFound("domain_not_found", "The domain was not found.");
  const at = (value: unknown) => Date.parse(cleanText(value)) || 0;
  if (!cleanText(current.default_email) || at(current.resources_disconnected_at) > at(current.resources_connected_at)) {
    throw conflict("domain_email_not_set", "Choose this domain's email address first.");
  }
  const verified = Boolean(current.verified_at) || ["ready_to_connect", "active"].includes(cleanText(current.status));
  if (!verified) throw conflict("domain_not_verified", "Verify that you own this domain before checking its email records.");
  const resolver = options.resolver ?? systemResolver;
  const simulated = current.simulated === true;
  const expected = storedEmailRecords(current, domain);
  const records = simulated
    ? expected.map((record) => ({ ...record, status: "found" as const, found: [record.content].filter(Boolean) }))
    : await lookUpEmailRecords(expected, resolver);
  const assigned = Array.isArray(current.nameservers) ? current.nameservers.map(cleanText).filter(Boolean) : [];
  // Only a Cloudflare zone's nameservers are something to point at; a capture-mode domain has none.
  const nameservers = cleanText(current.cloudflare_zone_id) && assigned.length
    ? simulated ? { expected: assigned, found: assigned, status: "found" as const } : await checkNameservers(domain, assigned, resolver)
    : null;
  const ready = records.every((record) => record.status === "found") && (!nameservers || nameservers.status === "found");
  const wasActive = cleanText(current.email_configuration_status) === "active";
  const now = new Date().toISOString();
  const saved = await saveRegistration(orgId, domain, {
    ...current,
    email_records: expected,
    email_records_check: { checked_at: now, ready, simulated, records, nameservers } as unknown as JsonObject,
    email_configuration_status: ready ? "active" : wasActive ? "records_pending" : (cleanText(current.email_configuration_status) || "records_pending"),
    ...(ready && !wasActive ? { email_configured_at: now } : {})
  });
  // Always: the identity's state follows the latest check, whatever an earlier attach left.
  await setOrgDomainEmailSending(orgId, domain, ready);
  if (ready !== wasActive) {
    await recordDomainEvent(orgId, ready ? "domain.email.active" : "domain.email.records_missing", {
      domain,
      missing: records.filter((record) => record.status !== "found").map((record) => record.key),
      simulated
    });
  }
  return { registration: publicRegistration(saved), ready, records, nameservers, checked_at: now };
}

export async function provisionExistingDomainInfrastructure(input: {
  orgId: string;
  domain: string;
  actorUserId: string;
}) {
  const result = await provisionDomainInfrastructure(input);
  return { ...result, registration: publicRegistration(result.registration) };
}
