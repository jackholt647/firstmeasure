import {
  deleteIdentitySessions,
  findIdentityByEmail,
  listDocuments,
  patchIdentity,
  readOrganization,
  upsertDocument
} from "../../platform/storage.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? text(process.argv[index + 1]) : "";
}

const email = option("--email").toLowerCase();
const targetOrgId = option("--target-org");
const sourceOrgId = option("--source-org");
const confirmed = process.argv.includes("--confirm");

if (!email || !targetOrgId) {
  throw new Error("Usage: tsx src/scripts/platform_relink_identity.ts --email <email> --target-org <org_id> [--source-org <org_id>] [--confirm]");
}
if (sourceOrgId && sourceOrgId === targetOrgId) {
  throw new Error("--source-org and --target-org must be different organizations.");
}

const identity = await findIdentityByEmail(email);
const targetOrganization = await readOrganization(targetOrgId);
const targetUsers = await listDocuments(targetOrgId, "users");
const matchingTargetUsers = targetUsers.filter((document) => {
  const data = asObject(document.data);
  return text(data.identity_id) === text(identity.id) || text(data.email).toLowerCase() === email;
});
if (matchingTargetUsers.length > 1) {
  throw new Error(`Target organization has ${matchingTargetUsers.length} matching users; resolve that ambiguity manually.`);
}

const memberships = Array.isArray(identity.memberships) ? identity.memberships.map(asObject) : [];
const sourceMembership = sourceOrgId
  ? memberships.find((membership) => text(membership.organization_id) === sourceOrgId)
  : undefined;
const sourceUser = sourceMembership
  ? await listDocuments(sourceOrgId, "users")
      .then((users) => users.find((document) => text(document.id) === text(sourceMembership.user_id)) || null)
      .catch(() => null)
  : null;
const existingTargetUser = matchingTargetUsers[0] || null;
const sourceData = asObject(sourceUser?.data);
const targetData = asObject(existingTargetUser?.data);
const userId = text(existingTargetUser?.id)
  || `user_${text(identity.id).replace(/^identity_/, "")}`;
if (!existingTargetUser && targetUsers.some((document) => text(document.id) === userId)) {
  throw new Error(`Target user id '${userId}' is already used by a different account.`);
}
const role = text(targetData.role || sourceData.role || sourceMembership?.role || "owner") || "owner";

const plan = {
  dry_run: !confirmed,
  identity_id: identity.id,
  email,
  source_org_id: sourceOrgId || null,
  target_org_id: targetOrganization.id,
  target_org_name: targetOrganization.name,
  target_user_id: userId,
  target_user_exists: Boolean(existingTargetUser),
  current_memberships: memberships.map((membership) => ({
    organization_id: membership.organization_id,
    user_id: membership.user_id,
    role: membership.role,
    status: membership.status
  }))
};

if (!confirmed) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const user = await upsertDocument(targetOrgId, "users", {
  id: userId,
  data: {
    ...sourceData,
    ...targetData,
    identity_id: identity.id,
    email,
    role,
    status: text(targetData.status || sourceData.status || "active") || "active",
    permissions: targetData.permissions || sourceData.permissions || { "*": true }
  },
  metadata: {
    ...asObject(sourceUser?.metadata),
    ...asObject(existingTargetUser?.metadata),
    kind: "organization_user",
    identity_id: identity.id
  },
  ...(existingTargetUser ? { expected_revision: existingTargetUser.revision } : {})
}, { replace: true });

const retainedMemberships = memberships.filter((membership) => {
  const orgId = text(membership.organization_id);
  return orgId !== targetOrgId && (!sourceOrgId || orgId !== sourceOrgId);
});
retainedMemberships.push({
  organization_id: targetOrgId,
  user_id: user.id,
  role,
  status: "active",
  added_at: new Date().toISOString()
});
const updatedIdentity = await patchIdentity(text(identity.id), {
  expected_revision: identity.revision,
  memberships: retainedMemberships,
  metadata: {
    repaired_at: new Date().toISOString(),
    repaired_from_organization_id: sourceOrgId || null,
    repaired_to_organization_id: targetOrgId
  }
});
const deletedSessions = await deleteIdentitySessions(text(identity.id));

console.log(JSON.stringify({
  ...plan,
  dry_run: false,
  identity_revision: updatedIdentity.revision,
  deleted_sessions: deletedSessions,
  note: "The source organization was preserved. Verify the repaired login before archiving or deleting it."
}, null, 2));
