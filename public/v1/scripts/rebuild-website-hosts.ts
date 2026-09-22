import { listOrganizations } from "../platform/storage.js";
import { listSites, rebuildDomainHostRegistry } from "../websites/storage.js";

function clean(value: unknown) { return String(value ?? "").trim(); }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const entries: Array<{ domains: unknown[]; org_id: string; site_id: string }> = [];
const organizations = await listOrganizations();
for (const organization of organizations) {
  const orgId = clean(object(organization).id);
  if (!orgId) continue;
  for (const site of await listSites(orgId)) {
    if (clean(site.status) !== "active" || clean(site.site_kind) !== "public") continue;
    const settings = object(site.settings);
    const domains = Array.isArray(settings.domains) ? settings.domains : Array.isArray(site.domains) ? site.domains : [];
    entries.push({ domains, org_id: orgId, site_id: clean(site.id) });
  }
}

const hostnames = await rebuildDomainHostRegistry(entries);
console.log(JSON.stringify({ ok: true, active_public_sites: entries.length, registered_hostname_aliases: hostnames }, null, 2));
