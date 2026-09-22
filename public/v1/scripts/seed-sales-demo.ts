/* Seed a demo salesperson (user, role, capabilities, appointments, follow-ups)
 * into an organization so the sales field app can be exercised end to end.
 *
 * Usage (from public/v1):
 *   node --experimental-sqlite --import tsx scripts/seed-sales-demo.ts <orgId> [email] [password]
 */

import { hashPassword } from "../platform/auth.js";
import {
  addIdentityMembership,
  createIdentity,
  findIdentityByEmail,
  listDocuments,
  upsertDocument
} from "../platform/storage.js";
import { effectiveCapabilities, saveCapabilityValues } from "../platform/capabilities.js";
import { patchWorkforceUserProfile } from "../workforce/service.js";
import { initializeAccessRoles } from "../workforce/access.js";
import { listPersonaTemplates } from "../workforce/persona_templates.js";
import { createFollowUpTodo } from "../work/followups.js";

const orgId = String(process.argv[2] || "").trim();
const email = String(process.argv[3] || "sales.demo@1m8.ai").trim().toLowerCase();
const password = String(process.argv[4] || "sunny-sells-2026").trim();

if (!orgId) {
  console.error("Usage: node --experimental-sqlite --import tsx scripts/seed-sales-demo.ts <orgId> [email] [password]");
  process.exit(1);
}

function localIso(dayOffset: number, hour: number, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function localDate(dayOffset: number) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function salesAppointment(id: string, userId: string, dayOffset: number, hour: number, minute = 0, notes = "") {
  return {
    id,
    /* No explicit `kind`: eventKind() short-circuits on it, and "appointment"
     * is not a schedule category, so the routing view would hide the event.
     * The category derives from event_type_default_id instead. */
    event_type_default_id: "sales_appointment",
    status: "scheduled",
    assigned_user_ids: [userId],
    start_at: localIso(dayOffset, hour, minute),
    end_at: localIso(dayOffset, hour + 1, minute),
    all_day: false,
    schedule_granularity: "time",
    duration_minutes: 60,
    ...(notes ? { notes } : {})
  };
}

async function main() {
  // 1. Roles + persona templates present (seeds the salesperson role/template).
  initializeAccessRoles(orgId);
  const templates = listPersonaTemplates(orgId);
  if (!templates.some((template) => template.id === "salesperson")) {
    throw new Error("salesperson factory template did not seed");
  }
  console.log(`✔ access roles + persona templates seeded (${templates.length} templates)`);

  // 2. Capabilities the sales tabs depend on.
  const effective = await effectiveCapabilities(orgId);
  const values = (effective as { values?: Record<string, unknown> }).values
    ?? (effective as Record<string, unknown>);
  const needed = ["apps.sales", "apps.payroll", "payroll.self_service_earnings", "platform.scheduling"];
  const enable: Record<string, boolean> = {};
  for (const key of needed) {
    const entry = (values as Record<string, unknown>)[key];
    const on = entry === true || (entry && typeof entry === "object" && (entry as Record<string, unknown>).value === true);
    if (!on) enable[key] = true;
  }
  if (Object.keys(enable).length) {
    await saveCapabilityValues(orgId, enable);
    console.log(`✔ enabled capabilities: ${Object.keys(enable).join(", ")}`);
  } else {
    console.log("✔ capabilities already enabled");
  }

  // 3. Identity + org user.
  let identityId = "";
  try {
    const existing = await findIdentityByEmail(email);
    identityId = String(existing.id || "");
    console.log(`✔ identity already exists (${identityId})`);
  } catch {
    const identity = await createIdentity({
      email,
      password_hash: await hashPassword(password),
      password_algo: "bcrypt",
      name: "Sunny Seller",
      status: "active",
      metadata: { source: "seed_sales_demo" }
    });
    identityId = String(identity.id || "");
    console.log(`✔ identity created (${identityId})`);
  }

  const users = await listDocuments(orgId, "users");
  const existingUser = users.find((doc) => String((doc.data as Record<string, unknown>)?.email || "").toLowerCase() === email);
  let userId = existingUser ? String(existingUser.id) : "";
  if (!userId) {
    const document = await upsertDocument(orgId, "users", {
      data: {
        identity_id: identityId,
        email,
        name: "Sunny Seller",
        phone: "",
        role: "viewer",
        roles: [],
        status: "active",
        org_permissions: { level: "viewer", items: {} },
        org_permission_level: "viewer",
        permissions: { view_projects: true, view_reports: true },
        account_type: "customer",
        team_id: "default",
        branch_id: "default"
      },
      metadata: { kind: "organization_user", identity_id: identityId, source: "seed_sales_demo" }
    }, { replace: true });
    userId = String(document.id);
    console.log(`✔ org user created (${userId})`);
  } else {
    console.log(`✔ org user already exists (${userId})`);
  }
  await addIdentityMembership(identityId, orgId, userId, "viewer");

  // 4. Salesperson persona on the field application.
  await patchWorkforceUserProfile(orgId, userId, {
    access_role_ids: ["salesperson"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "salesperson", permissions: {} }
    }
  });
  console.log("✔ salesperson role + field access applied");

  // 5. Demo projects with sales appointments (today, past, upcoming).
  const projects: Array<{ id: string; title: string; address: string; contact: [string, string, string]; events: Record<string, unknown>[] }> = [
    {
      id: "sales_demo_henderson",
      title: "Henderson Roof Replacement",
      address: "412 Maple Street, Springfield",
      contact: ["Paula Henderson", "555-0181", "paula.henderson@example.com"],
      events: [salesAppointment("sales_demo_appt_1", userId, 0, 10, 0, "Full replacement estimate. Bring shingle samples.")]
    },
    {
      id: "sales_demo_alvarez",
      title: "Alvarez Siding & Gutters",
      address: "88 Oak Avenue, Springfield",
      contact: ["Marco Alvarez", "555-0134", "marco.alvarez@example.com"],
      events: [salesAppointment("sales_demo_appt_2", userId, 0, 14, 30, "Second visit — ready to talk numbers.")]
    },
    {
      id: "sales_demo_whitfield",
      title: "Whitfield Storm Damage",
      address: "23 Birch Lane, Springfield",
      contact: ["Dana Whitfield", "555-0117", "dana.whitfield@example.com"],
      events: [salesAppointment("sales_demo_appt_3", userId, -1, 11, 0, "Insurance adjuster meeting.")]
    },
    {
      id: "sales_demo_okafor",
      title: "Okafor Window Package",
      address: "301 Pine Court, Springfield",
      contact: ["Chidi Okafor", "555-0163", "chidi.okafor@example.com"],
      events: [salesAppointment("sales_demo_appt_4", userId, -5, 15, 0)]
    },
    {
      id: "sales_demo_bennett",
      title: "Bennett Deck & Pergola",
      address: "77 Cedar Drive, Springfield",
      contact: ["Riley Bennett", "555-0148", "riley.bennett@example.com"],
      events: [salesAppointment("sales_demo_appt_5", userId, 2, 9, 30, "First visit — measure and qualify.")]
    }
  ];
  for (const project of projects) {
    await upsertDocument(orgId, "projects", {
      id: project.id,
      data: {
        branch_id: "default",
        title: project.title,
        address: project.address,
        contacts: [{
          id: `${project.id}_customer`,
          name: project.contact[0],
          phone: project.contact[1],
          email: project.contact[2],
          primary: true
        }],
        events: project.events
      },
      metadata: { kind: "platform_project", branch_id: "default", source: "seed_sales_demo" }
    }, { replace: true });
  }
  console.log(`✔ ${projects.length} demo projects with sales appointments seeded`);

  // 6. Follow-ups: two personal (one overdue), one unclaimed for the role.
  await createFollowUpTodo(orgId, {
    source_key: "seed_sales_demo:followup_whitfield",
    project_id: "sales_demo_whitfield",
    title: "Call Dana Whitfield about financing options",
    due_at: localDate(0),
    channel: "call",
    origin: "sales_app",
    assigned_user_ids: [userId]
  });
  await createFollowUpTodo(orgId, {
    source_key: "seed_sales_demo:followup_okafor",
    project_id: "sales_demo_okafor",
    title: "Send the Okafors the updated window proposal",
    due_at: localDate(-2),
    channel: "email",
    origin: "sales_app",
    assigned_user_ids: [userId]
  });
  await createFollowUpTodo(orgId, {
    source_key: "seed_sales_demo:followup_unclaimed",
    project_id: "sales_demo_bennett",
    title: "New web lead — reach out to the Bennetts",
    due_at: localDate(1),
    channel: "call",
    origin: "pipeline",
    assigned_role_ids: ["salesperson"]
  });
  console.log("✔ 3 follow-ups seeded (2 personal, 1 unclaimed)");

  console.log("");
  console.log("Done. Log in with:");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  org:      ${orgId}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
