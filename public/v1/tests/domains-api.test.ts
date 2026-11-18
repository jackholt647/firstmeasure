import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function successXml(attributes: string, responseCode = "200", responseText = "Command Successful") {
  return `<?xml version="1.0"?><OPS_envelope><body><data_block><dt_assoc><item key="protocol">XCP</item><item key="action">REPLY</item><item key="object">DOMAIN</item><item key="is_success">1</item><item key="response_code">${responseCode}</item><item key="response_text">${responseText}</item><item key="attributes"><dt_assoc>${attributes}</dt_assoc></item></dt_assoc></data_block></body></OPS_envelope>`;
}

function xmlItem(key: string, value: string) {
  return `<item key="${key}">${value}</item>`;
}

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const sessionCookie = readCookie(response.headers["set-cookie"], "fm_platform_session");
    const csrfCookie = readCookie(response.headers["set-cookie"], "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ");
      csrf = decodeURIComponent(csrfCookie.split("=")[1] || csrf);
    }
    return { response, body: response.body ? JSON.parse(response.body) : null };
  };
  return { request };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-domains-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMATE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.DOMAINS_DELIVERY_MODE = "test";
  process.env.DOMAINS_ORDER_TEST_MODE = "false";
  process.env.OPENSRS_TEST_USERNAME = "reseller";
  process.env.OPENSRS_TEST_API_KEY = "test-api-key";
  process.env.DOMAINS_ENCRYPTION_KEY = "test-domain-encryption-key-at-least-32-characters";
  process.env.STRIPE_TEST_MODE = "1";
  process.env.STRIPE_TEST_SECRET_KEY = "sk_test_domains_fixture";
  process.env.STRIPE_BASE_URL = "http://localhost/portal";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

async function registerPlatformUser(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const result = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `domain-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Domain Owner",
    company: "Domain Test",
    organization_id: `org_domain_${suffix}`
  });
  await enableExpandedPlatformFixture(result.body.organization.id);
  assert.equal(result.response.statusCode, 201, result.response.body);
  return result.body.organization.id as string;
}

test("OpenSRS XML client signs requests and decodes lookup, price, and registration", async () => {
  const { createOpenSrsClient, openSrsSignature } = await import("../domains/opensrs.js");
  const requests: Array<{ body: string; signature: string }> = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    const headers = new Headers(init?.headers);
    requests.push({ body, signature: headers.get("x-signature") || "" });
    if (body.includes("<item key=\"action\">LOOKUP</item>")) {
      return new Response(successXml(xmlItem("status", "available"), "210", "Domain available"), { status: 200 });
    }
    if (body.includes("<item key=\"action\">GET_PRICE</item>")) {
      return new Response(successXml(xmlItem("price", "14.50")), { status: 200 });
    }
    return new Response(successXml(
      xmlItem("id", "order-123") +
      xmlItem("domain_id", "domain-456") +
      xmlItem("registration_code", "200") +
      xmlItem("registration_text", "Domain successfully registered. Whois Privacy successfully enabled.")
    ), { status: 200 });
  }) as typeof fetch;
  const client = createOpenSrsClient({
    username: "reseller",
    apiKey: "secret",
    environment: "test",
    endpoint: "https://example.test",
    fetchImpl
  });
  assert.equal((await client.lookup("example.com")).available, true);
  assert.equal((await client.getPrice("example.com")).price, "14.50");
  const registration = await client.register({
    domain: "example.com",
    period: 1,
    registrantUsername: "customer123",
    registrantPassword: "password1234",
    contact: {
      first_name: "Test",
      last_name: "Owner",
      org_name: "Test Inc",
      address1: "1 Main St",
      city: "Seattle",
      state: "WA",
      postal_code: "98101",
      country: "US",
      phone: "+12065550100",
      email: "owner@example.test"
    }
  });
  assert.equal(registration.orderId, "order-123");
  assert.match(requests[2]?.body || "", /<item key="f_whois_privacy">1<\/item>/);
  assert.match(requests[2]?.body || "", /<item key="f_lock_domain">1<\/item>/);
  assert.match(requests[2]?.body || "", /<item key="auto_renew">1<\/item>/);
  await client.setAutoRenew("example.com", false);
  await client.setDomainLock("example.com", false);
  await client.updateNameservers("example.com", ["abby.ns.cloudflare.com", "mark.ns.cloudflare.com"]);
  await client.sendTransferAuthCode("example.com");
  assert.match(requests[3]?.body || "", /<item key="data">expire_action<\/item>/);
  assert.match(requests[4]?.body || "", /<item key="lock_state">0<\/item>/);
  assert.match(requests[5]?.body || "", /<item key="action">ADVANCED_UPDATE_NAMESERVERS<\/item>/);
  assert.match(requests[5]?.body || "", /<item key="0">abby\.ns\.cloudflare\.com<\/item>/);
  assert.match(requests[6]?.body || "", /<item key="action">SEND_AUTHCODE<\/item>/);
  for (const request of requests) assert.equal(request.signature, openSrsSignature(request.body, "secret"));
});

test("domains config is authenticated and never exposes the upstream provider or secrets", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/domains/config" });
  assert.equal(anonymous.statusCode, 401);
  const client = createSessionClient();
  await registerPlatformUser(client);
  const result = await client.request("GET", "/v1/domains/config");
  assert.equal(result.response.statusCode, 200, result.response.body);
  assert.equal(result.body.service, "domain_registry");
  assert.equal(result.body.mode, "test");
  assert.equal(result.body.order_test_mode, false);
  assert.equal(result.body.privacy_required, true);
  assert.equal(result.body.privacy_price, "0.00");
  assert.equal(result.body.billing_enabled, true);
  assert.equal(Object.hasOwn(result.body, "provider"), false);
  assert.equal(Object.hasOwn(result.body, "api_key"), false);
});

test("checkout request requires legal contact, an accepted total, and attestation; there is no unpaid registration", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const result = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, {
    items: [{ quote_id: "missing", domain: "example.com" }],
    accept_total: "25.00",
    attestation: true
  });
  assert.equal(result.response.statusCode, 400, result.response.body);
  assert.equal(result.body.error, "invalid_request");
  assert.ok(Array.isArray(result.body.details.issues));
  assert.ok(result.body.details.issues.length > 0);
  const unpaid = await client.request("POST", `/v1/domains/organizations/${orgId}/registrations`, {});
  assert.equal(unpaid.response.statusCode, 404, unpaid.response.body);
});

test("a customer pays 1.5 times the registry price, rounded up to the next $5 (FM-590)", async () => {
  const { customerDomainPrice } = await import("../domains/service.js");
  assert.equal(customerDomainPrice("14.00"), "25.00");
  assert.equal(customerDomainPrice("10.00"), "15.00");
  assert.equal(customerDomainPrice("10.01"), "20.00");
  assert.equal(customerDomainPrice("8.99"), "15.00");
  assert.equal(customerDomainPrice("0"), "0.00");
});

test("existing domains enter DNS verification without a registrar order", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const connected = await client.request("POST", `/v1/domains/organizations/${orgId}/connections`, {
    domain: "existing-example.com",
    attestation: true
  });
  assert.equal(connected.response.statusCode, 201, connected.response.body);
  assert.equal(connected.body.registration.acquisition_type, "existing");
  assert.equal(connected.body.registration.status, "dns_verification_pending");
  assert.equal(connected.body.registration.verification.host, "_firstmate-verification.existing-example.com");
  assert.ok(connected.body.registration.verification.value);
  assert.equal(Object.hasOwn(connected.body.registration, "provider"), false);

  const listed = await client.request("GET", `/v1/domains/organizations/${orgId}`);
  assert.equal(listed.response.statusCode, 200, listed.response.body);
  assert.equal(listed.body.domains.length, 1);
  assert.equal(listed.body.domains[0].domain, "existing-example.com");

  const attached = await client.request("POST", `/v1/domains/organizations/${orgId}/domains/existing-example.com/resources`, {
    website: { mode: "create", name: "Domain Pipeline Website" },
    default_email_local_part: "info"
  });
  assert.equal(attached.response.statusCode, 200, attached.response.body);
  assert.match(attached.body.website_id, /^site_/);
  assert.equal(attached.body.registration.website_id, attached.body.website_id);
  assert.equal(attached.body.default_email, "info@existing-example.com");
  assert.equal(attached.body.registration.default_email, attached.body.default_email);
  assert.equal(attached.body.registration.status, "dns_verification_pending");
  assert.equal(attached.body.infrastructure.simulated, true);
  assert.equal(attached.body.registration.infrastructure_status, "planned");
  assert.equal(attached.body.infrastructure.plan.email.provider, "cloudflare_email");
  assert.equal(attached.body.infrastructure.plan.email.inbound_routing, "cloudflare_email_worker");
  const { readSite } = await import("../websites/storage.js");
  const savedSite = await readSite(orgId, attached.body.website_id);
  assert.equal((savedSite.settings as any).primary_domain, "existing-example.com");
  assert.equal((savedSite.settings as any).default_email.address, "info@existing-example.com");
  assert.equal((savedSite.settings as any).default_email.status, "pending_provider_setup");
  const mapped = await client.request("GET", `/v1/domains/organizations/${orgId}`);
  assert.equal(mapped.body.domains[0].website.name, "Domain Pipeline Website");
});

test("Cloudflare client reuses zones and upserts DNS records without exposing the token", async () => {
  const { createCloudflareClient } = await import("../domains/cloudflare.js");
  const calls: Array<{ url: string; method: string; auth: string; body: string }> = [];
  const responses = [
    { success: true, result: [{ id: "zone-1", name: "example.com", status: "pending", name_servers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] }] },
    { success: true, result: [] },
    { success: true, result: { id: "record-1", type: "CNAME", name: "www.example.com", content: "sites.example.net" } }
  ];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      auth: headers.get("authorization") || "",
      body: String(init?.body || "")
    });
    return Response.json(responses.shift(), { status: 200 });
  }) as typeof fetch;
  const client = createCloudflareClient({
    accountId: "account-1",
    apiToken: "private-token",
    apiBaseUrl: "https://cloudflare.example/v4",
    fetchImpl
  });
  const ensured = await client.ensureZone("example.com");
  assert.equal(ensured.created, false);
  await client.upsertDnsRecord("zone-1", {
    type: "CNAME",
    name: "www.example.com",
    content: "sites.example.net",
    proxied: true
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.auth, "Bearer private-token");
  assert.match(calls[0]!.url, /account\.id=account-1/);
  assert.equal(calls[2]!.method, "POST");
  assert.match(calls[2]!.body, /"proxied":true/);
  assert.equal(JSON.stringify(ensured).includes("private-token"), false);
});

test("quotes return retail pricing and never expose provider costs", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<item key=\"action\">LOOKUP</item>")) {
      return new Response(successXml(
        xmlItem("status", "available"),
        "210",
        "Domain available"
      ), { status: 200 });
    }
    if (body.includes("<item key=\"action\">GET_PRICE</item>")) {
      return new Response(successXml(xmlItem("price", body.includes(">RENEWAL<") || body.includes(">renewal<") ? "14.00" : "10.00")), { status: 200 });
    }
    throw new Error("Unexpected registry request in quote test");
  }) as typeof fetch;
  try {
    const result = await client.request("POST", `/v1/domains/organizations/${orgId}/quotes`, {
      domains: ["price-example.com"],
      period: 1,
      acquisition_type: "register"
    });
    assert.equal(result.response.statusCode, 201, result.response.body);
    const item = result.body.quote.items[0];
    assert.equal(item.price, "15.00");
    assert.equal(item.renewal_price, "25.00");
    assert.equal(item.privacy_price, "0.00");
    assert.equal(Object.hasOwn(item, "provider_renewal_cost"), false);
    assert.equal(Object.hasOwn(item, "provider_registration_cost"), false);
    assert.equal(Object.hasOwn(item, "provider_privacy_cost"), false);
    assert.equal(Object.hasOwn(item, "registration_price"), false);
    assert.equal(Object.hasOwn(result.body.quote, "provider"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const testContact = {
  first_name: "Test",
  last_name: "Owner",
  org_name: "Test Inc",
  address1: "1 Main St",
  city: "Seattle",
  state: "WA",
  postal_code: "98101",
  country: "US",
  phone: "+12065550100",
  email: "owner@example.test"
};

/** OpenSRS (order test mode: lookups and prices only) plus a small Stripe that remembers what it was asked. */
function fakeProviders(options: { taken?: string[] } = {}) {
  const registry: string[] = [];
  const stripeCalls: Array<{ method: string; route: string; fields: URLSearchParams; key: string }> = [];
  const subscriptions = new Map<string, any>();
  const control = { paid: false };
  let session: any = null;
  let counter = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method || "GET";
    if (target.startsWith("https://api.stripe.com/v1/")) {
      const route = target.slice("https://api.stripe.com/v1/".length);
      const fields = new URLSearchParams(String(init?.body || ""));
      stripeCalls.push({ method, route, fields, key: new Headers(init?.headers).get("idempotency-key") || "" });
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "POST" && route === "checkout/sessions") {
        let total = 0;
        for (let index = 0; fields.has(`line_items[${index}][quantity]`); index += 1) total += Number(fields.get(`line_items[${index}][price_data][unit_amount]`));
        const metadata = Object.fromEntries([...fields].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value]));
        session = { id: "cs_test_domains", url: "https://checkout.stripe.com/c/pay/cs_test_domains", livemode: false, currency: "usd", amount_total: total, metadata };
        return json({ ...session, status: "open", payment_status: "unpaid" });
      }
      if (method === "GET" && route.startsWith("checkout/sessions/")) {
        return json(control.paid
          ? { ...session, status: "complete", payment_status: "paid", customer: "cus_test", payment_intent: { id: "pi_test", payment_method: "pm_test", customer: "cus_test" } }
          : { ...session, status: "open", payment_status: "unpaid" });
      }
      if (method === "POST" && route === "products") return json({ id: `prod_${++counter}`, livemode: false });
      if (method === "POST" && route === "subscriptions") {
        const metadata = Object.fromEntries([...fields].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value]));
        const anchor = Number(fields.get("billing_cycle_anchor"));
        const subscription = { id: `sub_${++counter}`, object: "subscription", livemode: false, status: "active", cancel_at_period_end: false, billing_cycle_anchor: anchor, metadata, items: { data: [{ current_period_end: anchor }] } };
        subscriptions.set(subscription.id, subscription);
        return json(subscription);
      }
      if (route.startsWith("subscriptions/")) {
        const subscription = subscriptions.get(decodeURIComponent(route.slice("subscriptions/".length)));
        if (method === "POST" && fields.has("cancel_at_period_end")) subscription.cancel_at_period_end = fields.get("cancel_at_period_end") === "true";
        return json(subscription);
      }
      if (method === "POST" && route === "refunds") return json({ id: "re_test", amount: Number(fields.get("amount")) });
      throw new Error(`Unexpected Stripe request ${method} ${route}`);
    }
    const body = String(init?.body || "");
    registry.push(body);
    const domain = body.match(/<item key="domain">([^<]+)<\/item>/)?.[1] || "";
    if (body.includes("<item key=\"action\">LOOKUP</item>")) {
      return new Response(options.taken?.includes(domain)
        ? successXml(xmlItem("status", "taken"), "211", "Domain taken")
        : successXml(xmlItem("status", "available"), "210", "Domain available"), { status: 200 });
    }
    if (body.includes("<item key=\"action\">GET_PRICE</item>")) {
      return new Response(successXml(xmlItem("price", "14.00")), { status: 200 });
    }
    throw new Error("Order test mode attempted an unexpected registry request");
  }) as typeof fetch;
  return { fetchImpl, registry, stripeCalls, subscriptions, control, session: () => session };
}

test("a cart of domains is paid once, registered, and renewed yearly by a subscription each (FM-590)", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const originalFetch = globalThis.fetch;
  const { env } = await import("../src/config/env.js");
  const mutableEnv = env as unknown as { domainsOrderTestMode: boolean };
  const originalOrderTestMode = env.domainsOrderTestMode;
  mutableEnv.domainsOrderTestMode = true;
  const fake = fakeProviders();
  globalThis.fetch = fake.fetchImpl;
  try {
    const first = await client.request("POST", `/v1/domains/organizations/${orgId}/quotes`, { domains: ["cart-one-example.com"], acquisition_type: "register" });
    const second = await client.request("POST", `/v1/domains/organizations/${orgId}/quotes`, { domains: ["cart-two-example.com"], acquisition_type: "register" });
    assert.equal(first.response.statusCode, 201, first.response.body);
    assert.equal(first.body.quote.items[0].price, "25.00");
    const items = [
      { quote_id: first.body.quote.id, domain: "cart-one-example.com" },
      { quote_id: second.body.quote.id, domain: "cart-two-example.com" }
    ];
    const wrongTotal = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, { items, contact: testContact, accept_total: "25.00", attestation: true });
    assert.equal(wrongTotal.response.statusCode, 409, wrongTotal.response.body);
    assert.equal(wrongTotal.body.error, "domain_price_not_accepted");

    const started = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, { items, contact: testContact, accept_total: "50.00", attestation: true });
    assert.equal(started.response.statusCode, 201, started.response.body);
    const checkout = started.body.checkout;
    assert.equal(checkout.status, "open");
    assert.equal(checkout.total, "50.00");
    assert.equal(checkout.url, "https://checkout.stripe.com/c/pay/cs_test_domains");
    assert.equal(JSON.stringify(checkout).includes("provider_"), false);
    assert.equal(JSON.stringify(checkout).includes("Seattle"), false);
    const created = fake.stripeCalls.find((call) => call.route === "checkout/sessions")!;
    assert.equal(created.fields.get("mode"), "payment");
    assert.equal(created.fields.get("payment_intent_data[setup_future_usage]"), "off_session");
    assert.equal(created.fields.get("payment_method_types[0]"), "card");
    assert.equal(created.fields.get("line_items[0][price_data][unit_amount]"), "2500");
    assert.equal(created.fields.get("line_items[1][price_data][unit_amount]"), "2500");
    assert.equal(created.fields.get("metadata[billing_kind]"), "domain_checkout");
    assert.equal(created.key, `domain-checkout-${checkout.id}`);

    // Not paid yet: nothing is registered.
    const waiting = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts/${checkout.id}/refresh`, {});
    assert.equal(waiting.body.checkout.status, "open");
    assert.equal((await client.request("GET", `/v1/domains/organizations/${orgId}`)).body.domains.length, 0);

    fake.control.paid = true;
    const paid = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts/${checkout.id}/refresh`, {});
    assert.equal(paid.response.statusCode, 200, paid.response.body);
    assert.equal(paid.body.checkout.status, "fulfilled");
    assert.deepEqual(paid.body.checkout.items.map((item: any) => item.status), ["registered", "registered"]);
    const listed = (await client.request("GET", `/v1/domains/organizations/${orgId}`)).body.domains;
    assert.equal(listed.length, 2);
    for (const domain of listed) {
      assert.equal(domain.billing_status, "paid");
      assert.equal(domain.billing_collected, true);
      assert.equal(domain.price, "25.00");
      assert.equal(domain.privacy_enabled, true);
      assert.equal(domain.privacy_price, "0.00");
      assert.equal(domain.auto_renew, true);
      assert.equal(domain.subscription.provider, "stripe");
      assert.equal(domain.subscription.status, "active");
      // The renewal is charged a month before the domain expires.
      const lead = Date.parse(domain.expires_at) - Date.parse(domain.subscription.renews_at);
      assert.ok(Math.abs(lead - 30 * 86_400_000) < 2 * 86_400_000, `renews ${domain.subscription.renews_at}, expires ${domain.expires_at}`);
      assert.equal(Object.hasOwn(domain, "provider_registration_cost"), false);
    }
    const created2 = fake.stripeCalls.filter((call) => call.method === "POST" && call.route === "subscriptions");
    assert.equal(created2.length, 2);
    assert.equal(created2[0]!.fields.get("items[0][price_data][recurring][interval]"), "year");
    assert.equal(created2[0]!.fields.get("items[0][price_data][unit_amount]"), "2500");
    assert.equal(created2[0]!.fields.get("default_payment_method"), "pm_test");
    assert.equal(created2[0]!.fields.get("proration_behavior"), "none");
    assert.equal(fake.registry.some((body) => /<item key="action">sw_register<\/item>/i.test(body)), false);

    // Refreshing again (the webhook and the browser both do) changes nothing and charges nothing.
    const again = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts/${checkout.id}/refresh`, {});
    assert.equal(again.body.checkout.status, "fulfilled");
    assert.equal(fake.stripeCalls.filter((call) => call.route === "subscriptions").length, 2);

    // Renewal off stops the subscription at the end of the paid year; on resumes it.
    const off = await client.request("PATCH", `/v1/domains/organizations/${orgId}/domains/cart-one-example.com/management`, { auto_renew: false });
    assert.equal(off.response.statusCode, 200, off.response.body);
    assert.equal(off.body.registration.auto_renew, false);
    assert.equal(off.body.registration.subscription.cancel_at_period_end, true);
    const on = await client.request("PATCH", `/v1/domains/organizations/${orgId}/domains/cart-one-example.com/management`, { auto_renew: true });
    assert.equal(on.body.registration.subscription.cancel_at_period_end, false);

    // A subscription Stripe cancels (unpaid renewal) turns the domain's renewal off, through the webhook.
    const subscriptionId = listed.find((domain: any) => domain.domain === "cart-two-example.com").subscription.subscription_id;
    fake.subscriptions.get(subscriptionId).status = "canceled";
    const { domainStripeWebhook } = await import("../domains/checkout.js");
    assert.equal(await domainStripeWebhook({ data: { object: fake.subscriptions.get(subscriptionId) } }), true);
    assert.equal(await domainStripeWebhook({ data: { object: { object: "checkout.session", metadata: { billing_kind: "credit_topup" } } } }), false);
    const ended = (await client.request("GET", `/v1/domains/organizations/${orgId}`)).body.domains.find((domain: any) => domain.domain === "cart-two-example.com");
    assert.equal(ended.auto_renew, false);
    assert.equal(ended.billing_status, "renewal_ended");
    const revive = await client.request("PATCH", `/v1/domains/organizations/${orgId}/domains/cart-two-example.com/management`, { auto_renew: true });
    assert.equal(revive.response.statusCode, 409, revive.response.body);
    assert.equal(revive.body.error, "domain_renewal_ended");

    // A domain already bought can't go in another cart.
    const repeat = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, { items: [items[0]], contact: testContact, accept_total: "25.00", attestation: true });
    assert.equal(repeat.response.statusCode, 409, repeat.response.body);
    assert.equal(repeat.body.error, "domain_already_added");
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.domainsOrderTestMode = originalOrderTestMode;
  }
});

test("a domain taken between search and checkout is refused before payment (FM-590)", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const originalFetch = globalThis.fetch;
  const fake = fakeProviders();
  globalThis.fetch = fake.fetchImpl;
  try {
    const quote = await client.request("POST", `/v1/domains/organizations/${orgId}/quotes`, { domains: ["race-example.com"], acquisition_type: "register" });
    globalThis.fetch = fakeProviders({ taken: ["race-example.com"] }).fetchImpl;
    const refused = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, {
      items: [{ quote_id: quote.body.quote.id, domain: "race-example.com" }], contact: testContact, accept_total: "25.00", attestation: true
    });
    assert.equal(refused.response.statusCode, 409, refused.response.body);
    assert.equal(refused.body.error, "domain_no_longer_available");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order test mode keeps verification and management simulated for a bought domain", async () => {
  const client = createSessionClient();
  const orgId = await registerPlatformUser(client);
  const originalFetch = globalThis.fetch;
  const { env } = await import("../src/config/env.js");
  const mutableEnv = env as unknown as { domainsOrderTestMode: boolean };
  const originalOrderTestMode = env.domainsOrderTestMode;
  mutableEnv.domainsOrderTestMode = true;
  const fake = fakeProviders();
  globalThis.fetch = fake.fetchImpl;
  try {
    const quote = await client.request("POST", `/v1/domains/organizations/${orgId}/quotes`, { domains: ["simulated-registration-example.com"], acquisition_type: "register" });
    const invalidPhone = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, {
      items: [{ quote_id: quote.body.quote.id, domain: "simulated-registration-example.com" }],
      contact: { ...testContact, phone: "(206) 555-0100" }, accept_total: "25.00", attestation: true
    });
    assert.equal(invalidPhone.response.statusCode, 400, invalidPhone.response.body);
    assert.match(invalidPhone.body.message, /Phone: Use an E\.164 phone number/);
    assert.deepEqual(invalidPhone.body.details.issues[0].path, ["contact", "phone"]);
    const started = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts`, {
      items: [{ quote_id: quote.body.quote.id, domain: "simulated-registration-example.com" }], contact: testContact, accept_total: "25.00", attestation: true
    });
    fake.control.paid = true;
    const paid = await client.request("POST", `/v1/domains/organizations/${orgId}/checkouts/${started.body.checkout.id}/refresh`, {});
    assert.equal(paid.body.checkout.status, "fulfilled");
    const registration = (await client.request("GET", `/v1/domains/organizations/${orgId}`)).body.domains[0];
    assert.equal(registration.simulated, true);
    assert.equal(registration.status, "verification_pending");
    assert.equal(registration.verified_at, undefined);
    const earlyReminder = await client.request("POST", `/v1/domains/organizations/${orgId}/domains/simulated-registration-example.com/verification/resend`, {});
    assert.equal(earlyReminder.response.statusCode, 409, earlyReminder.response.body);
    assert.equal(earlyReminder.body.error, "verification_reminder_not_ready");
    const verified = await client.request("POST", `/v1/domains/organizations/${orgId}/domains/simulated-registration-example.com/verification/check`, {});
    assert.equal(verified.response.statusCode, 200, verified.response.body);
    assert.equal(verified.body.registration.status, "ready_to_connect");
    assert.ok(verified.body.registration.verified_at);
    const managed = await client.request("PATCH", `/v1/domains/organizations/${orgId}/domains/simulated-registration-example.com/management`, {
      locked: false,
      nameservers: ["abby.ns.cloudflare.com", "mark.ns.cloudflare.com"]
    });
    assert.equal(managed.response.statusCode, 200, managed.response.body);
    assert.equal(managed.body.registration.locked, false);
    assert.deepEqual(managed.body.registration.nameservers, ["abby.ns.cloudflare.com", "mark.ns.cloudflare.com"]);
    const transferOut = await client.request("POST", `/v1/domains/organizations/${orgId}/domains/simulated-registration-example.com/transfer-out`, {
      attestation: true
    });
    assert.equal(transferOut.response.statusCode, 200, transferOut.response.body);
    assert.equal(transferOut.body.registration.transfer_out_simulated, true);
    assert.equal(fake.registry.some((body) => /<item key="action">sw_register<\/item>/i.test(body)), false);
  } finally {
    globalThis.fetch = originalFetch;
    mutableEnv.domainsOrderTestMode = originalOrderTestMode;
  }
});
