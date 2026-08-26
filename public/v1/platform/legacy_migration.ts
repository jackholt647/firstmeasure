import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type MigrationMode = "dry-run" | "fresh" | "validate";

export type MigrationOptions = {
  sourceRoot: string;
  targetRoot: string;
  mode: MigrationMode;
  confirmFresh?: boolean;
};

type JsonObject = Record<string, unknown>;

type LegacyUser = {
  path: string;
  file: string;
  data: JsonObject;
  email: string;
  id: string;
  orgId: string;
};

type LegacyOrg = {
  path: string;
  id: string;
  data: JsonObject;
};

type MigrationIssue = {
  level: "warning" | "error";
  code: string;
  message: string;
  path?: string;
};

type ExpectedState = {
  organizations: Map<string, JsonObject>;
  globals: Map<string, JsonObject>;
  branches: Map<string, JsonObject>;
  identities: Map<string, JsonObject>;
  emailIndexes: Map<string, JsonObject>;
  orgUsers: Map<string, Map<string, JsonObject>>;
  source: {
    users: LegacyUser[];
    organizations: LegacyOrg[];
    badUserFiles: number;
    badOrgFiles: number;
  };
  issues: MigrationIssue[];
};

export type MigrationReport = {
  mode: MigrationMode;
  sourceRoot: string;
  targetRoot: string;
  ok: boolean;
  counts: Record<string, number>;
  issues: MigrationIssue[];
  validation?: {
    checked: number;
    failed: number;
    failures: string[];
  };
};

const SCHEMA_VERSION = 1;
const INTERNAL_ORG_ID = "legacy_internal";

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return cleanText(value).toLowerCase();
}

function safeId(value: unknown, fallback: string) {
  const cleaned = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function identityIdForEmail(email: string) {
  return `identity_${hash(email).slice(0, 16)}`;
}

function userIdForLegacyUser(user: JsonObject, email: string) {
  return safeId(user.id, `user_${hash(email).slice(0, 16)}`);
}

function emailIndexFileName(email: string) {
  return `${hash(email)}.json`;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function statusFromLegacyUser(user: JsonObject) {
  if (boolValue(user.deleted)) return "deleted";
  if (boolValue(user.disabled)) return "disabled";
  if (user.is_verified === false) return "pending";
  return "active";
}

function accountType(user: JsonObject) {
  return cleanText(user.account_type).toLowerCase() || "employee";
}

function permissionsForUser(user: JsonObject) {
  const acct = accountType(user);
  if (acct === "customer") {
    const orgPerms = asObject(user.org_permissions);
    const level = cleanText(orgPerms.level) || "viewer";
    const items = asObject(orgPerms.items);
    if (level === "super_admin") return { "*": true };
    return items;
  }
  return asObject(user.permissions);
}

function roleForUser(user: JsonObject) {
  const acct = accountType(user);
  if (acct === "customer") {
    const level = cleanText(asObject(user.org_permissions).level) || "viewer";
    return level === "super_admin" ? "owner" : level;
  }
  return cleanText(user.role) || "user";
}

function publicLegacyUserSnapshot(user: JsonObject) {
  const snapshot = { ...user };
  delete snapshot.password_hash;
  delete snapshot.otp;
  delete snapshot.password_reset;
  return snapshot;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<JsonObject> {
  const content = await readFile(filePath, "utf8");
  if (!content.trim()) throw new Error("empty_json_file");
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json_not_object");
  return parsed as JsonObject;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listLegacyUsers(sourceRoot: string, issues: MigrationIssue[]) {
  const usersDir = path.join(sourceRoot, "users");
  const users: LegacyUser[] = [];
  let badUserFiles = 0;
  if (!(await pathExists(usersDir))) {
    issues.push({ level: "error", code: "missing_users_dir", message: `Legacy users directory not found: ${usersDir}` });
    return { users, badUserFiles };
  }
  for (const entry of await readdir(usersDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(usersDir, entry.name);
    try {
      const data = await readJsonFile(filePath);
      const email = normalizeEmail(data.email || entry.name.replace(/\.json$/i, ""));
      if (!email || !email.includes("@")) {
        issues.push({ level: "warning", code: "bad_user_email", message: `Skipping user with invalid email: ${entry.name}`, path: filePath });
        badUserFiles += 1;
        continue;
      }
      users.push({
        path: filePath,
        file: entry.name,
        data,
        email,
        id: userIdForLegacyUser(data, email),
        orgId: safeId(data.organization_id, INTERNAL_ORG_ID)
      });
    } catch (error) {
      badUserFiles += 1;
      issues.push({ level: "warning", code: "bad_user_json", message: `Could not read user JSON: ${(error as Error).message}`, path: filePath });
    }
  }
  return { users, badUserFiles };
}

async function listLegacyOrganizations(sourceRoot: string, issues: MigrationIssue[]) {
  const orgsDir = path.join(sourceRoot, "organizations");
  const organizations: LegacyOrg[] = [];
  let badOrgFiles = 0;
  if (!(await pathExists(orgsDir))) {
    issues.push({ level: "error", code: "missing_organizations_dir", message: `Legacy organizations directory not found: ${orgsDir}` });
    return { organizations, badOrgFiles };
  }
  for (const entry of await readdir(orgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = safeId(entry.name, "");
    if (!id) continue;
    const manifestPath = path.join(orgsDir, entry.name, "manifest.json");
    try {
      const data = await readJsonFile(manifestPath);
      organizations.push({ path: manifestPath, id, data: { ...data, id } });
    } catch (error) {
      badOrgFiles += 1;
      issues.push({ level: "warning", code: "bad_org_json", message: `Could not read org manifest: ${(error as Error).message}`, path: manifestPath });
    }
  }
  return { organizations, badOrgFiles };
}

function buildOrgManifest(org: LegacyOrg, generatedAt: string): JsonObject {
  const data = org.data;
  return {
    schema_version: SCHEMA_VERSION,
    id: org.id,
    name: cleanText(data.name) || "Untitled Organization",
    status: boolValue(data.disabled) ? "disabled" : "active",
    metadata: {
      source: "legacy_measure_internal",
      migrated_at: generatedAt,
      legacy_path: org.path,
      legacy_created_by_user_id: data.created_by_user_id ?? null,
      legacy_created_by_email: data.created_by_email ?? null,
      legacy_users: asArray(data.users),
      legacy_users_meta: asObject(data.users_meta),
      legacy_snapshot: data
    },
    revision: 1,
    created_at: cleanText(data.created_at) || generatedAt,
    updated_at: cleanText(data.updated_at_utc) || generatedAt
  };
}

function buildInternalOrg(generatedAt: string): JsonObject {
  return {
    schema_version: SCHEMA_VERSION,
    id: INTERNAL_ORG_ID,
    name: "FirstMate Internal",
    status: "active",
    metadata: {
      source: "legacy_measure_internal",
      generated_for_unassigned_users: true,
      migrated_at: generatedAt
    },
    revision: 1,
    created_at: generatedAt,
    updated_at: generatedAt
  };
}

function buildGlobal(orgId: string, org: JsonObject, generatedAt: string): JsonObject {
  return {
    schema_version: SCHEMA_VERSION,
    id: "global",
    organization_id: orgId,
    collection: "global",
    data: {
      credits_balance: numberValue(org.credits_balance),
      credits_ledger: asArray(org.credits_ledger),
      billing: asObject(org.billing),
      offers: asObject(org.offers),
      claimed_deals: asObject(org.claimed_deals),
      attribution: asObject(org.attribution),
      onboarding_completed: org.onboarding_completed ?? false,
      onboarding_completed_at: org.onboarding_completed_at ?? null,
      onboarding_meta: asObject(org.onboarding_meta),
      assigned_sales_email: org.assigned_sales_email ?? null,
      assigned_sales_name: org.assigned_sales_name ?? null,
      paired_lead_ids: asArray(org.paired_lead_ids),
      paired_primary_lead_id: org.paired_primary_lead_id ?? null,
      paired_at: org.paired_at ?? null,
      commission_bonus_owner_map: asObject(org.commission_bonus_owner_map),
      legacy_org_snapshot: org
    },
    metadata: {
      source: "legacy_measure_internal",
      migrated_at: generatedAt
    },
    revision: 1,
    created_at: cleanText(org.created_at) || generatedAt,
    updated_at: cleanText(org.updated_at_utc) || generatedAt
  };
}

function buildBranch(orgId: string, org: JsonObject, generatedAt: string): JsonObject {
  const branding = asObject(org.branding);
  const contact = asObject(org.contact);
  return {
    schema_version: SCHEMA_VERSION,
    id: "default",
    organization_id: orgId,
    collection: "branch",
    data: {
      name: cleanText(org.name) || "Default Branch",
      status: "active",
      contact: {
        email: cleanText(contact.email),
        phone: cleanText(contact.phone),
        address: cleanText(contact.address)
      },
      branding,
      report_settings: asObject(org.report_settings),
      is_test: boolValue(org.is_test),
      modules: {}
    },
    metadata: {
      kind: "branch",
      source: "legacy_measure_internal",
      migrated_at: generatedAt
    },
    revision: 1,
    created_at: cleanText(org.created_at) || generatedAt,
    updated_at: cleanText(org.updated_at_utc) || generatedAt
  };
}

function buildIdentity(user: LegacyUser, generatedAt: string): JsonObject {
  const status = statusFromLegacyUser(user.data);
  const identityId = identityIdForEmail(user.email);
  return {
    schema_version: SCHEMA_VERSION,
    id: identityId,
    email: user.email,
    email_normalized: user.email,
    password_hash: cleanText(user.data.password_hash),
    password_algo: "php-password-hash",
    name: cleanText(user.data.name),
    phone: cleanText(user.data.phone),
    status: status === "deleted" ? "disabled" : status,
    memberships: [
      {
        organization_id: user.orgId,
        user_id: user.id,
        role: roleForUser(user.data),
        status,
        added_at: cleanText(user.data.created_at) || generatedAt
      }
    ],
    metadata: {
      source: "legacy_measure_internal",
      migrated_at: generatedAt,
      legacy_path: user.path,
      legacy_account_type: accountType(user.data),
      legacy_user_id: user.data.id ?? null
    },
    revision: 1,
    created_at: cleanText(user.data.created_at) || generatedAt,
    updated_at: generatedAt,
    last_login_at: null
  };
}

function buildEmailIndex(user: LegacyUser, generatedAt: string): JsonObject {
  return {
    schema_version: SCHEMA_VERSION,
    email: user.email,
    identity_id: identityIdForEmail(user.email),
    created_at: generatedAt,
    updated_at: generatedAt
  };
}

function buildOrgUser(user: LegacyUser, generatedAt: string): JsonObject {
  const data = user.data;
  const userData: JsonObject = {
    identity_id: identityIdForEmail(user.email),
    email: user.email,
    name: cleanText(data.name),
    phone: cleanText(data.phone),
    company: cleanText(data.company),
    role: roleForUser(data),
    roles: Array.isArray(data.roles) ? data.roles : [],
    status: statusFromLegacyUser(data),
    permissions: permissionsForUser(data),
    account_type: accountType(data),
    team_id: cleanText(data.team_id) || "default",
    branch_id: cleanText(data.branch_id) || "default",
    queue_mode: cleanText(data.queue_mode) || "disabled",
    complexity_preference: cleanText(data.complexity_preference) || "all",
    drafter_rank: cleanText(data.drafter_rank) || "junior",
    shift_schedule: asObject(data.shift_schedule),
    shift_rate: numberValue(data.shift_rate, 0),
    org_permissions: asObject(data.org_permissions),
    org_permissions_by_org: asObject(data.org_permissions_by_org),
    training_complete: boolValue(data.training_complete),
    is_admin: boolValue(data.is_admin),
    profile: {
      avatar_media_id: null,
      profile_photo: data.profile_photo ?? null
    },
    stats: {
      projects_ordered: asArray(data.projects).length,
      commissions_earned: numberValue(data.commissions_earned, 0)
    },
    projects: asArray(data.projects),
    credits_balance: numberValue(data.credits_balance),
    credits_ledger: asArray(data.credits_ledger),
    attribution: asObject(data.attribution),
    seen_tutorial: boolValue(data.seen_tutorial),
    failed_attempts: numberValue(data.failed_attempts),
    metadata: {
      legacy_snapshot: publicLegacyUserSnapshot(data)
    }
  };

  return {
    schema_version: SCHEMA_VERSION,
    id: user.id,
    organization_id: user.orgId,
    collection: "users",
    data: userData,
    metadata: {
      kind: "organization_user",
      source: "legacy_measure_internal",
      migrated_at: generatedAt,
      legacy_path: user.path,
      identity_id: identityIdForEmail(user.email)
    },
    revision: 1,
    created_at: cleanText(data.created_at) || generatedAt,
    updated_at: generatedAt
  };
}

async function buildExpectedState(options: MigrationOptions): Promise<ExpectedState> {
  const issues: MigrationIssue[] = [];
  const sourceRoot = path.resolve(options.sourceRoot);
  const generatedAt = nowIso();
  const { users, badUserFiles } = await listLegacyUsers(sourceRoot, issues);
  const { organizations, badOrgFiles } = await listLegacyOrganizations(sourceRoot, issues);

  const orgMap = new Map<string, LegacyOrg>();
  for (const org of organizations) orgMap.set(org.id, org);

  const expected: ExpectedState = {
    organizations: new Map(),
    globals: new Map(),
    branches: new Map(),
    identities: new Map(),
    emailIndexes: new Map(),
    orgUsers: new Map(),
    source: { users, organizations, badUserFiles, badOrgFiles },
    issues
  };

  for (const org of organizations) {
    expected.organizations.set(org.id, buildOrgManifest(org, generatedAt));
    expected.globals.set(org.id, buildGlobal(org.id, org.data, generatedAt));
    expected.branches.set(org.id, buildBranch(org.id, org.data, generatedAt));
  }

  const needsInternalOrg = users.some((user) => user.orgId === INTERNAL_ORG_ID);
  if (needsInternalOrg && !expected.organizations.has(INTERNAL_ORG_ID)) {
    expected.organizations.set(INTERNAL_ORG_ID, buildInternalOrg(generatedAt));
    expected.globals.set(INTERNAL_ORG_ID, buildGlobal(INTERNAL_ORG_ID, {}, generatedAt));
    expected.branches.set(INTERNAL_ORG_ID, buildBranch(INTERNAL_ORG_ID, { name: "FirstMate Internal" }, generatedAt));
    expected.issues.push({
      level: "warning",
      code: "generated_internal_org",
      message: `Created ${INTERNAL_ORG_ID} for legacy users without organization_id.`
    });
  }

  for (const user of users) {
    const orgUsers = expected.orgUsers.get(user.orgId) ?? new Map<string, JsonObject>();
    let migratedUser = user;
    if (orgUsers.has(migratedUser.id)) {
      const replacementId = safeId(`user_${hash(migratedUser.email).slice(0, 16)}`, `user_${expected.identities.size + 1}`);
      expected.issues.push({
        level: "warning",
        code: "duplicate_org_user_id",
        message: `Legacy user id ${migratedUser.id} already exists in org ${migratedUser.orgId}; migrated ${migratedUser.email} as ${replacementId}.`,
        path: migratedUser.path
      });
      migratedUser = { ...migratedUser, id: replacementId };
    }

    if (user.orgId !== INTERNAL_ORG_ID && !orgMap.has(user.orgId)) {
      expected.organizations.set(user.orgId, {
        schema_version: SCHEMA_VERSION,
        id: user.orgId,
        name: `Recovered Legacy Organization ${user.orgId}`,
        status: "active",
        metadata: {
          source: "legacy_measure_internal",
          generated_for_missing_user_org: true,
          migrated_at: generatedAt
        },
        revision: 1,
        created_at: generatedAt,
        updated_at: generatedAt
      });
      expected.globals.set(user.orgId, buildGlobal(user.orgId, {}, generatedAt));
      expected.branches.set(user.orgId, buildBranch(user.orgId, { name: `Recovered Legacy Organization ${user.orgId}` }, generatedAt));
      expected.issues.push({
        level: "warning",
        code: "generated_missing_org",
        message: `Created placeholder org ${user.orgId} for user ${user.email}.`
      });
    }

    const identityId = identityIdForEmail(migratedUser.email);
    if (expected.identities.has(identityId)) {
      expected.issues.push({
        level: "warning",
        code: "duplicate_identity",
        message: `Duplicate identity email encountered; keeping first record for ${migratedUser.email}.`,
        path: migratedUser.path
      });
      continue;
    }
    expected.identities.set(identityId, buildIdentity(migratedUser, generatedAt));
    expected.emailIndexes.set(emailIndexFileName(migratedUser.email), buildEmailIndex(migratedUser, generatedAt));
    if (!expected.orgUsers.has(migratedUser.orgId)) expected.orgUsers.set(migratedUser.orgId, new Map());
    expected.orgUsers.get(migratedUser.orgId)?.set(migratedUser.id, buildOrgUser(migratedUser, generatedAt));
  }

  return expected;
}

async function writeExpected(targetRoot: string, expected: ExpectedState) {
  await mkdir(targetRoot, { recursive: true });
  for (const [orgId, organization] of expected.organizations) {
    await writeJson(path.join(targetRoot, "organizations", orgId, "manifest.json"), organization);
    await writeJson(path.join(targetRoot, "organizations", orgId, "global.json"), expected.globals.get(orgId) ?? buildGlobal(orgId, {}, nowIso()));
    await writeJson(path.join(targetRoot, "organizations", orgId, "branch", "default.json"), expected.branches.get(orgId) ?? buildBranch(orgId, {}, nowIso()));
    for (const collection of ["users", "projects", "notifications", "action_items", "media", "branch_data"]) {
      await mkdir(path.join(targetRoot, "organizations", orgId, collection), { recursive: true });
    }
  }

  for (const [identityId, identity] of expected.identities) {
    await writeJson(path.join(targetRoot, "identities", `${identityId}.json`), identity);
  }
  for (const [fileName, index] of expected.emailIndexes) {
    await writeJson(path.join(targetRoot, "auth_index", "email", fileName), index);
  }
  for (const [orgId, users] of expected.orgUsers) {
    for (const [userId, user] of users) {
      await writeJson(path.join(targetRoot, "organizations", orgId, "users", `${userId}.json`), user);
    }
  }
  await mkdir(path.join(targetRoot, "sessions"), { recursive: true });
}

async function readTargetJson(filePath: string, failures: string[]) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    failures.push(`${filePath}: ${(error as Error).message}`);
    return null;
  }
}

function compareField(label: string, actual: unknown, expected: unknown, failures: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function validateExpected(targetRoot: string, expected: ExpectedState) {
  const failures: string[] = [];
  let checked = 0;

  for (const [orgId, organization] of expected.organizations) {
    checked += 1;
    const actual = await readTargetJson(path.join(targetRoot, "organizations", orgId, "manifest.json"), failures);
    if (actual) {
      compareField(`org ${orgId} id`, actual.id, organization.id, failures);
      compareField(`org ${orgId} name`, actual.name, organization.name, failures);
    }
    const global = await readTargetJson(path.join(targetRoot, "organizations", orgId, "global.json"), failures);
    const expectedGlobal = expected.globals.get(orgId);
    if (global && expectedGlobal) {
      compareField(`org ${orgId} credits_balance`, asObject(global.data).credits_balance, asObject(expectedGlobal.data).credits_balance, failures);
      compareField(`org ${orgId} credits_ledger_length`, asArray(asObject(global.data).credits_ledger).length, asArray(asObject(expectedGlobal.data).credits_ledger).length, failures);
    }
  }

  for (const [identityId, identity] of expected.identities) {
    checked += 1;
    const actual = await readTargetJson(path.join(targetRoot, "identities", `${identityId}.json`), failures);
    if (actual) {
      compareField(`identity ${identityId} email`, actual.email, identity.email, failures);
      compareField(`identity ${identityId} password_hash`, actual.password_hash, identity.password_hash, failures);
      compareField(`identity ${identityId} memberships`, asArray(actual.memberships).length, asArray(identity.memberships).length, failures);
    }
  }

  for (const [orgId, users] of expected.orgUsers) {
    for (const [userId, user] of users) {
      checked += 1;
      const actual = await readTargetJson(path.join(targetRoot, "organizations", orgId, "users", `${userId}.json`), failures);
      if (actual) {
        const actualData = asObject(actual.data);
        const expectedData = asObject(user.data);
        compareField(`user ${userId} email`, actualData.email, expectedData.email, failures);
        compareField(`user ${userId} role`, actualData.role, expectedData.role, failures);
        compareField(`user ${userId} permissions`, actualData.permissions, expectedData.permissions, failures);
        compareField(`user ${userId} status`, actualData.status, expectedData.status, failures);
      }
    }
  }

  return { checked, failed: failures.length, failures };
}

function countExpected(expected: ExpectedState) {
  let orgUserCount = 0;
  for (const users of expected.orgUsers.values()) orgUserCount += users.size;
  return {
    legacy_users_read: expected.source.users.length,
    legacy_orgs_read: expected.source.organizations.length,
    bad_user_files: expected.source.badUserFiles,
    bad_org_files: expected.source.badOrgFiles,
    platform_orgs_expected: expected.organizations.size,
    platform_identities_expected: expected.identities.size,
    platform_org_users_expected: orgUserCount,
    platform_email_indexes_expected: expected.emailIndexes.size,
    warnings: expected.issues.filter((issue) => issue.level === "warning").length,
    errors: expected.issues.filter((issue) => issue.level === "error").length
  };
}

export async function runLegacyPlatformMigration(options: MigrationOptions): Promise<MigrationReport> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const expected = await buildExpectedState({ ...options, sourceRoot, targetRoot });
  const counts = countExpected(expected);

  if (options.mode === "fresh") {
    if (!options.confirmFresh) {
      expected.issues.push({
        level: "error",
        code: "fresh_requires_confirmation",
        message: "Fresh migration deletes the target root and requires --confirm-fresh."
      });
    } else {
      await rm(targetRoot, { recursive: true, force: true });
      await writeExpected(targetRoot, expected);
    }
  }

  let validation: MigrationReport["validation"];
  if (options.mode === "validate" || options.mode === "fresh") {
    validation = await validateExpected(targetRoot, expected);
  }

  const issues = expected.issues;
  const ok = issues.every((issue) => issue.level !== "error") && (!validation || validation.failed === 0);
  return {
    mode: options.mode,
    sourceRoot,
    targetRoot,
    ok,
    counts: {
      ...counts,
      warnings: issues.filter((issue) => issue.level === "warning").length,
      errors: issues.filter((issue) => issue.level === "error").length
    },
    issues,
    validation
  };
}
