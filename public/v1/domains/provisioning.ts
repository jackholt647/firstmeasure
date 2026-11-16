import { env } from "../src/config/env.js";
import { createCloudflareClient, type CloudflareDnsRecord } from "./cloudflare.js";
import { domainEmailRecords, mergeProviderRecords, type DomainEmailRecord } from "./email-records.js";
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
      dmarc_policy: "none",
      records: domainEmailRecords(domain)
    }
  };
}

type CloudflareClient = ReturnType<typeof createCloudflareClient>;

/**
 * Onboard the zone for email (FM-516): Email Routing with a catch-all to the Email Worker (inbound), an Email Sending
 * domain (outbound, its DKIM key), and DMARC p=none unless the domain already has a policy. Returns the records the
 * domain should serve, with what Cloudflare issued folded in. A failure leaves email at cloudflare_onboarding_pending
 * with the error: the website records are already in place, and provisioning can be run again.
 */
async function onboardDomainEmail(cloudflare: CloudflareClient, zoneId: string, domain: string) {
  let records: DomainEmailRecord[] = domainEmailRecords(domain);
  await cloudflare.enableEmailRouting(zoneId, domain);
  await cloudflare.routeAllMailToWorker(zoneId, env.cloudflareEmailWorkerName);
  records = mergeProviderRecords(records, await cloudflare.emailRoutingDnsRecords(zoneId), "email_routing");
  const sending = await cloudflare.ensureEmailSendingDomain(zoneId, domain);
  const tag = cleanText(sending.tag || sending.id);
  if (tag) {
    const issued = await cloudflare.emailSendingDnsRecords(zoneId, tag);
    records = mergeProviderRecords(records, issued, "email_sending");
    // Sending records are normally written by Cloudflare itself; add any the zone does not have yet.
    for (const entry of issued) {
      const type = cleanText(entry.type).toUpperCase();
      if (type !== "MX" && type !== "TXT") continue;
      const content = cleanText(entry.content);
      await cloudflare.addDnsRecordIfMissing(zoneId, {
        type, name: cleanText(entry.name), content,
        ...(type === "MX" && Number.isFinite(Number(entry.priority)) ? { priority: Number(entry.priority) } : {})
      } as CloudflareDnsRecord, (existing) => cleanText(existing.content).replace(/^"|"$/g, "") === content.replace(/^"|"$/g, ""));
    }
  }
  const dmarc = records.find((record) => record.key === "dmarc");
  if (dmarc) {
    const { record } = await cloudflare.addDnsRecordIfMissing(zoneId, { type: "TXT", name: dmarc.name, content: dmarc.content },
      (existing) => /^"?v=dmarc1/i.test(cleanText(existing.content)));
    records = mergeProviderRecords(records, [record as unknown as Record<string, unknown>], "firstmate");
  }
  return { records, sending_tag: tag };
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
      infrastructure_planned_at: new Date().toISOString(),
      // Capture creates nothing: the email records are what the domain should serve, and the records check reads DNS.
      email_records: plan.email.records,
      email_provider: "cloudflare_email",
      email_configuration_status: cleanText(current.email_configuration_status) === "active" ? "active" : "records_pending"
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
  let email: { records: DomainEmailRecord[]; sending_tag: string } | null = null;
  let emailError = "";
  try {
    email = await onboardDomainEmail(cloudflare, zone.id, input.domain);
  } catch (error) {
    emailError = error instanceof Error ? error.message : String(error);
  }
  const saved = await saveRegistration(input.orgId, input.domain, {
    ...current,
    nameservers,
    infrastructure_status: "dns_pending",
    infrastructure_mode: "live",
    cloudflare_zone_id: zone.id,
    cloudflare_zone_status: zone.status,
    cloudflare_zone_created: created,
    email_configuration_status: !email ? "cloudflare_onboarding_pending" : cleanText(current.email_configuration_status) === "active" ? "active" : "records_pending",
    email_provider: "cloudflare_email",
    email_records: email?.records ?? domainEmailRecords(input.domain),
    email_sending_tag: email?.sending_tag ?? cleanText(current.email_sending_tag),
    email_provider_error: emailError,
    infrastructure_records: records,
    infrastructure_updated_at: new Date().toISOString()
  });
  await recordDomainEvent(input.orgId, "domain.infrastructure.provisioned", {
    domain: input.domain,
    actor_user_id: input.actorUserId,
    cloudflare_zone_created: created,
    email_onboarded: Boolean(email),
    ...(emailError ? { email_error: emailError } : {}),
    simulated: false
  });
  return { registration: saved, plan, simulated: false };
}
