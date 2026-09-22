import { ensureLeadImportSettings } from "../email/api.js";
import { listDocuments, listOrganizations, readBranchModule } from "../platform/storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

let migrated = 0;
let unchanged = 0;
let failed = 0;

for (const organization of await listOrganizations()) {
  const organizationId = cleanText(organization.id);
  if (!organizationId) continue;
  const branches = await listDocuments(organizationId, "branch").catch(() => []);
  for (const branch of branches) {
    const branchId = cleanText(branch.id) || "default";
    try {
      const existing = await readBranchModule(organizationId, branchId, "lead_import");
      const before = cleanText((existing.data as Record<string, unknown> | undefined)?.inbound_email).toLowerCase();
      if (!before) continue;
      const { data } = await ensureLeadImportSettings(organizationId, branchId);
      const after = cleanText(data.inbound_email).toLowerCase();
      if (before === after) unchanged += 1;
      else migrated += 1;
    } catch (error) {
      failed += 1;
      console.error(`Unable to migrate ${organizationId}/${branchId}:`, error instanceof Error ? error.message : error);
    }
  }
}

console.log(JSON.stringify({ ok: failed === 0, migrated, unchanged, failed }));
if (failed) process.exitCode = 1;
