import { env } from "../src/config/env.js";
import { createCloudflareClient, type CloudflareDnsRecord } from "./cloudflare.js";
import { createOpenSrsClient } from "./opensrs.js";
import { readRegistration, recordDomainEvent, saveRegistration } from "./storage.js";
import { ensureEmailTenant } from "../email/tenants.js";

function cleanText(value: unknown) { return String(value ?? "").trim(); }

export function domainInfrastructurePlan(domain: string) {
  return {
    mode: env.domainInfrastructureMode,
    domain,
    cloudflare: {
      create_zone: true,
      delegate_nameservers_at_registrar: true,
      proxy_website_records: true,
      keep_email_records_dns_only: true
    },
    email: {
      provider: "cloudflare_email",
      identity: domain,
      sending_onboarding: "cloudflare_email_service",
      inbound_routing: "cloudflare_email_worker",
      dmarc_policy: "none"
    }
  };
}

export async function provisionDomainInfrastructure(input: { orgId: string; domain: string; actorUserId: string }) {
  const current = await readRegistration(input.orgId, input.domain);
  if (!current) throw new Error("Domain registration was not found.");
  const plan = domainInfrastructurePlan(input.domain);

  if (env.domainInfrastructureMode !== "live") {
    const simulated = await saveRegistration(input.orgId, input.domain, {
      ...current,
      infrastructure_status: "planned",
      infrastructure_mode: "capture",
      infrastructure_plan: plan,
      infrastructure_planned_at: new Date().toISOString()
    });
    await recordDomainEvent(input.orgId, "domain.infrastructure.planned", {
      domain: input.domain,
      actor_user_id: input.actorUserId,
      simulated: true
    });
    return { registration: simulated, plan, simulated: true };
  }

  const websiteTarget = cleanText(env.cloudflareWebsiteTarget).toLowerCase().replace(/\.+$/, "");
  if (cleanText(current.website_id) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(websiteTarget)) {
    throw new Error("CLOUDFLARE_WEBSITE_TARGET must be a valid hostname before provisioning a website domain.");
  }
  const cloudflare = createCloudflareClient();
  const { zone, created } = await cloudflare.ensureZone(input.domain);
  const nameservers = Array.isArray(zone.name_servers) ? zone.name_servers.map(cleanText).filter(Boolean) : [];
  if (nameservers.length < 2) throw new Error("Cloudflare did not return the assigned nameservers.");

  await ensureEmailTenant({ organizationId: input.orgId, identityDomains: [env.firstmateMailDomain, input.domain] });
  const records: CloudflareDnsRecord[] = [];
  if (websiteTarget) {
    await cloudflare.upsertWebsiteCname(zone.id, input.domain, websiteTarget);
    await cloudflare.upsertWebsiteCname(zone.id, `www.${input.domain}`, websiteTarget);
    records.push(
      { type: "CNAME", name: input.domain, content: websiteTarget, proxied: true },
      { type: "CNAME", name: `www.${input.domain}`, content: websiteTarget, proxied: true }
    );
  }

  if (cleanText(current.acquisition_type) !== "existing" && !env.domainsOrderTestMode) {
    await createOpenSrsClient().updateNameservers(input.domain, nameservers);
  }
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    nameservers,
    infrastructure_status: "dns_pending",
    infrastructure_mode: "live",
    cloudflare_zone_id: zone.id,
    cloudflare_zone_status: zone.status,
    cloudflare_zone_created: created,
    email_configuration_status: "cloudflare_onboarding_pending",
    email_provider: "cloudflare_email",
    infrastructure_records: records,
    infrastructure_updated_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.infrastructure.provisioned", {
    domain: input.domain,
    actor_user_id: input.actorUserId,
    cloudflare_zone_created: created,
    simulated: false
  });
  return { registration: saved, plan, simulated: false };
}
