/* Seed a route-optimization demo day: a bench of salespeople plus a full day
 * of fixed-time sales appointments spread across the Seattle area, left
 * unassigned so the routing optimizer has real work to do.
 *
 * - Grants the scheduling role `sales_appointments` to every seeded
 *   salesperson (including an existing Sunny Seller user if present) so the
 *   routing view's assignment policy actually lists them.
 * - Creates enough salespeople to reach 10 total holders of that role.
 * - Creates 30 projects with real-ish Seattle addresses + lat/lng, each with
 *   one 2-hour appointment on the target date at a fixed start time.
 *
 * Usage (from public/v1):
 *   node --experimental-sqlite --import tsx scripts/seed-routing-demo.ts <orgId> [dateYYYY-MM-DD]
 */

import { hashPassword } from "../platform/auth.js";
import {
  addIdentityMembership,
  createIdentity,
  findIdentityByEmail,
  listDocuments,
  upsertDocument
} from "../platform/storage.js";
import { patchWorkforceUserProfile } from "../workforce/service.js";

const orgId = String(process.argv[2] || "").trim();
const dateArg = String(process.argv[3] || "2026-08-03").trim();

if (!orgId || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error("Usage: node --experimental-sqlite --import tsx scripts/seed-routing-demo.ts <orgId> [dateYYYY-MM-DD]");
  process.exit(1);
}

const [YEAR = 2026, MONTH = 8, DAY = 3] = dateArg.split("-").map(Number);

const SCHEDULING_ROLE = "sales_appointments";
const TARGET_SALESPEOPLE = 10;

const SALESPEOPLE = [
  { name: "Ava Chen", email: "ava.sales@1m8.ai" },
  { name: "Ben Ortiz", email: "ben.sales@1m8.ai" },
  { name: "Cara Singh", email: "cara.sales@1m8.ai" },
  { name: "Dev Patel", email: "dev.sales@1m8.ai" },
  { name: "Elle Novak", email: "elle.sales@1m8.ai" },
  { name: "Finn Rourke", email: "finn.sales@1m8.ai" },
  { name: "Gia Russo", email: "gia.sales@1m8.ai" },
  { name: "Hank Weber", email: "hank.sales@1m8.ai" },
  { name: "Iris Kim", email: "iris.sales@1m8.ai" },
  { name: "Jude Moreau", email: "jude.sales@1m8.ai" }
];

/* 30 Seattle-area stops: address, approximate coordinates, and a customer. */
const STOPS: Array<[string, number, number, string]> = [
  ["2044 NW Market St, Seattle, WA 98107", 47.6687, -122.3846, "Ballard Bungalow Re-roof"],
  ["3601 Fremont Ave N, Seattle, WA 98103", 47.6510, -122.3499, "Fremont Craftsman Estimate"],
  ["1625 Queen Anne Ave N, Seattle, WA 98109", 47.6336, -122.3565, "Queen Anne Gutter Package"],
  ["1400 E Pine St, Seattle, WA 98122", 47.6152, -122.3130, "Capitol Hill Townhome Roof"],
  ["4517 California Ave SW, Seattle, WA 98116", 47.5615, -122.3870, "West Seattle Skylight Consult"],
  ["2821 Beacon Ave S, Seattle, WA 98144", 47.5785, -122.3110, "Beacon Hill Storm Repair"],
  ["4860 Rainier Ave S, Seattle, WA 98118", 47.5599, -122.2853, "Columbia City Siding Visit"],
  ["9061 Rainier Ave S, Seattle, WA 98118", 47.5216, -122.2700, "Rainier Beach Full Replacement"],
  ["17500 Midvale Ave N, Shoreline, WA 98133", 47.7564, -122.3440, "Shoreline Rambler Estimate"],
  ["12345 Lake City Way NE, Seattle, WA 98125", 47.7168, -122.2920, "Lake City Duplex Roof"],
  ["401 NE Northgate Way, Seattle, WA 98125", 47.7079, -122.3244, "Northgate Insurance Walkthrough"],
  ["8500 Greenwood Ave N, Seattle, WA 98103", 47.6910, -122.3550, "Greenwood Solar-Ready Consult"],
  ["4416 Wallingford Ave N, Seattle, WA 98103", 47.6608, -122.3357, "Wallingford Cedar Shake Quote"],
  ["4326 University Way NE, Seattle, WA 98105", 47.6604, -122.3131, "U District Rental Inspection"],
  ["6520 Ravenna Ave NE, Seattle, WA 98115", 47.6760, -122.3010, "Ravenna Moss Treatment Quote"],
  ["3213 W McGraw St, Seattle, WA 98199", 47.6402, -122.3990, "Magnolia View Home Estimate"],
  ["5501 Airport Way S, Seattle, WA 98108", 47.5530, -122.3200, "Georgetown Warehouse Roof"],
  ["9616 16th Ave SW, Seattle, WA 98106", 47.5150, -122.3550, "White Center Repair Visit"],
  ["621 SW 152nd St, Burien, WA 98166", 47.4700, -122.3460, "Burien Ranch House Quote"],
  ["233 Burnett Ave S, Renton, WA 98057", 47.4790, -122.2070, "Renton Split-Level Estimate"],
  ["10500 NE 8th St, Bellevue, WA 98004", 47.6170, -122.1950, "Bellevue Executive Home"],
  ["220 Kirkland Ave, Kirkland, WA 98033", 47.6760, -122.2080, "Kirkland Waterfront Consult"],
  ["16150 NE 85th St, Redmond, WA 98052", 47.6790, -122.1240, "Redmond Tech Exec Roof"],
  ["7605 SE 27th St, Mercer Island, WA 98040", 47.5870, -122.2350, "Mercer Island Estimate"],
  ["18305 Bothell Way NE, Bothell, WA 98011", 47.7600, -122.2050, "Bothell New-Build Punch"],
  ["121 5th Ave N, Edmonds, WA 98020", 47.8110, -122.3770, "Edmonds Victorian Quote"],
  ["19100 44th Ave W, Lynnwood, WA 98036", 47.8210, -122.2920, "Lynnwood Storm Damage"],
  ["6728 NE 181st St, Kenmore, WA 98028", 47.7570, -122.2440, "Kenmore Lakeside Consult"],
  ["775 NW Gilman Blvd, Issaquah, WA 98027", 47.5400, -122.0640, "Issaquah Foothills Estimate"],
  ["17401 Southcenter Pkwy, Tukwila, WA 98188", 47.4620, -122.2570, "Tukwila Commercial Bid"]
];

/* Staggered, messy start times — the realistic case: customers pick specific
 * times, so starts land every ~15 minutes (with jitter) from 8:00 to ~15:25.
 * With 2-hour appointments that means up to 8 overlap at once, so the
 * optimizer has to weigh chaining feasibility AND travel, not just travel.
 * The (i * 7) % 30 permutation decouples start time from geography so nearby
 * stops don't get conveniently adjacent times. */
const START_MINUTES = Array.from({ length: 30 }, (_, slot) => 480 + slot * 15 + ((slot * 7) % 3) * 5);
const startMinutesFor = (index: number) => START_MINUTES[(index * 7) % START_MINUTES.length]!;

function isoAtMinutes(totalMinutes: number) {
  return new Date(YEAR, MONTH - 1, DAY, Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0).toISOString();
}

async function ensureSalesperson(person: { name: string; email: string }, index: number) {
  const email = person.email.toLowerCase();
  let identityId = "";
  try {
    const existing = await findIdentityByEmail(email);
    identityId = String(existing.id || "");
  } catch {
    const identity = await createIdentity({
      email,
      password_hash: await hashPassword(`route-demo-${index + 1}-2026`),
      password_algo: "bcrypt",
      name: person.name,
      status: "active",
      metadata: { source: "seed_routing_demo" }
    });
    identityId = String(identity.id || "");
  }
  const users = await listDocuments(orgId, "users");
  const existingUser = users.find((doc) => String((doc.data as Record<string, unknown>)?.email || "").toLowerCase() === email);
  let userId = existingUser ? String(existingUser.id) : "";
  if (!userId) {
    const document = await upsertDocument(orgId, "users", {
      data: {
        identity_id: identityId,
        email,
        name: person.name,
        phone: "",
        role: "viewer",
        roles: [SCHEDULING_ROLE],
        status: "active",
        org_permissions: { level: "viewer", items: {} },
        org_permission_level: "viewer",
        permissions: { view_projects: true, view_reports: true },
        account_type: "customer",
        team_id: "default",
        branch_id: "default"
      },
      metadata: { kind: "organization_user", identity_id: identityId, source: "seed_routing_demo" }
    }, { replace: true });
    userId = String(document.id);
  }
  await addIdentityMembership(identityId, orgId, userId, "viewer");
  await patchWorkforceUserProfile(orgId, userId, {
    access_role_ids: ["salesperson"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "salesperson", permissions: {} }
    }
  });
  return userId;
}

async function main() {
  /* 1. Make sure existing salesperson-shaped users hold the scheduling role
   * the sales_appointment assignment policy filters on. */
  const users = await listDocuments(orgId, "users");
  let roleHolders = 0;
  for (const document of users) {
    const data = (document.data || {}) as Record<string, unknown>;
    const roles = Array.isArray(data.roles) ? data.roles.map(String) : [];
    const accessRoles = Array.isArray(data.access_role_ids) ? data.access_role_ids.map(String) : [];
    const isAdmin = ["owner", "admin", "super_admin"].includes(String(data.role || "").toLowerCase());
    if (isAdmin) continue; // admins are not salespeople; leave them alone
    if (roles.includes(SCHEDULING_ROLE)) {
      roleHolders += 1;
      continue;
    }
    if (accessRoles.includes("salesperson")) {
      await upsertDocument(orgId, "users", {
        id: String(document.id),
        data: { roles: [...roles, SCHEDULING_ROLE] },
        metadata: { routing_demo_role_fix: new Date().toISOString() }
      }, { replace: false });
      roleHolders += 1;
      console.log(`✔ granted ${SCHEDULING_ROLE} to existing user ${data.name || data.email || document.id}`);
    }
  }

  /* 2. Top up to the target headcount with new salespeople. */
  for (let i = 0; i < SALESPEOPLE.length && roleHolders < TARGET_SALESPEOPLE; i += 1) {
    const person = SALESPEOPLE[i]!;
    const existing = await listDocuments(orgId, "users");
    if (existing.some((doc) => String((doc.data as Record<string, unknown>)?.email || "").toLowerCase() === person.email)) continue;
    const userId = await ensureSalesperson(person, i);
    roleHolders += 1;
    console.log(`✔ salesperson ${person.name} (${person.email}) → ${userId}`);
  }
  console.log(`✔ ${roleHolders} non-admin salespeople now hold the ${SCHEDULING_ROLE} scheduling role`);

  /* 3. 30 projects, one fixed-time 2-hour appointment each, unassigned. */
  for (let i = 0; i < STOPS.length; i += 1) {
    const [address, lat, lng, title] = STOPS[i]!;
    const startMinutes = startMinutesFor(i);
    const projectId = `routing_demo_${String(i + 1).padStart(2, "0")}`;
    const contactName = title.split(" ").slice(0, 1)[0] + " Customer";
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: {
        branch_id: "default",
        title,
        address,
        lat,
        lng,
        contacts: [{
          id: `${projectId}_customer`,
          name: contactName,
          phone: `555-02${String(10 + i)}`,
          email: `${projectId}@example.com`,
          primary: true
        }],
        /* No `kind` field: eventKind() short-circuits on an explicit kind, and
         * "appointment" is not a schedule category — the routing view would
         * bucket the event as "other" and hide it. Let it derive from the
         * event type id instead. */
        events: [{
          id: `${projectId}_appt`,
          event_type_default_id: "sales_appointment",
          status: "scheduled",
          assigned_user_ids: [],
          assigned_users: [],
          assigned_user_id: "",
          assigned_user_name: "",
          start_at: isoAtMinutes(startMinutes),
          end_at: isoAtMinutes(startMinutes + 120),
          all_day: false,
          schedule_granularity: "time",
          duration_minutes: 120,
          notes: `Routing demo stop ${i + 1} — ${address}`
        }]
      },
      metadata: { kind: "platform_project", branch_id: "default", source: "seed_routing_demo" }
    }, { replace: true });
  }
  console.log(`✔ ${STOPS.length} projects with unassigned 2h appointments on ${dateArg} (staggered starts 8:00–15:25)`);
  console.log("");
  console.log("Next: POST /v1/platform/organizations/" + orgId + "/routing/optimize");
  console.log(`  { "event_type_id": "sales_appointment", "date": "${dateArg}", "apply": true }`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
