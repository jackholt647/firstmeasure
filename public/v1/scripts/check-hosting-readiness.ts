import { isAbsolute } from "node:path";
import { resolveAny } from "node:dns/promises";

import { env } from "../src/config/env.js";

const failures: string[] = [];
const warnings: string[] = [];
const target = String(env.cloudflareWebsiteTarget || "").trim().toLowerCase().replace(/\.+$/, "");
const originHost = String(process.env.HOSTING_ORIGIN_HOST || "sites.firstmatehosting.com").trim().toLowerCase().replace(/\.+$/, "");

if (env.domainsDeliveryMode !== "live") failures.push("DOMAINS_DELIVERY_MODE must be live.");
if (!env.openSrsLiveUsername) failures.push("OPENSRS_LIVE_USERNAME is required.");
if (!env.openSrsLiveApiKey) failures.push("OPENSRS_LIVE_API_KEY is required.");
if (env.domainsEncryptionKey.length < 32) failures.push("DOMAINS_ENCRYPTION_KEY must be at least 32 characters.");
if (env.domainInfrastructureMode !== "live") failures.push("DOMAIN_INFRASTRUCTURE_MODE must be live.");
if (!env.cloudflareAccountId) failures.push("CLOUDFLARE_ACCOUNT_ID is required.");
if (!env.cloudflareApiToken) failures.push("CLOUDFLARE_API_TOKEN is required.");
if (!target) failures.push("CLOUDFLARE_WEBSITE_TARGET is required.");
if (env.emailDeliveryMode !== "live") failures.push("EMAIL_DELIVERY_MODE must be live.");
if (env.emailTestRecipientRewrite) failures.push("EMAIL_TEST_RECIPIENT_REWRITE must be false in production.");
if (!env.cloudflareAccountId) failures.push("CLOUDFLARE_ACCOUNT_ID is required.");
if (!env.cloudflareEmailWorkerUrl) failures.push("CLOUDFLARE_EMAIL_WORKER_URL is required for outbound email.");
if (!env.cloudflareEmailWorkerToken) failures.push("CLOUDFLARE_EMAIL_WORKER_TOKEN is required for outbound email.");
if (!env.emailInboundWebhookToken) failures.push("EMAIL_INBOUND_WEBHOOK_TOKEN is required for the Cloudflare Email Worker.");
if (env.emailOrganizationHourlyLimit <= 0) failures.push("EMAIL_ORGANIZATION_HOURLY_LIMIT must be greater than zero.");
if (env.emailOrganizationDailyLimit <= 0) failures.push("EMAIL_ORGANIZATION_DAILY_LIMIT must be greater than zero.");
if (!env.platformStorageRoot || !isAbsolute(env.platformStorageRoot)) failures.push("PLATFORM_STORAGE_ROOT must be an absolute persistent path.");
if (!env.messagingStorageRoot || !isAbsolute(env.messagingStorageRoot)) failures.push("MESSAGING_STORAGE_ROOT must be an absolute persistent path for inbound and reputation ledgers.");
if (env.domainsOrderTestMode) warnings.push("DOMAINS_ORDER_TEST_MODE is still enabled; purchases and management operations remain simulated.");

if (target && !target.endsWith(".cfargotunnel.com")) {
  try {
    await resolveAny(target);
  } catch {
    failures.push(`CLOUDFLARE_WEBSITE_TARGET (${target}) does not resolve in public DNS.`);
  }
}
if (target.endsWith(".cfargotunnel.com") && !/^[a-z0-9-]+\.cfargotunnel\.com$/.test(target)) {
  failures.push("CLOUDFLARE_WEBSITE_TARGET is not a valid Cloudflare Tunnel target.");
}
if (originHost) {
  try {
    await resolveAny(originHost);
  } catch {
    failures.push(`HOSTING_ORIGIN_HOST (${originHost}) does not resolve in public DNS.`);
  }
}

console.log(JSON.stringify({ ok: failures.length === 0, target, origin_host: originHost, failures, warnings }, null, 2));
if (failures.length) process.exitCode = 1;
