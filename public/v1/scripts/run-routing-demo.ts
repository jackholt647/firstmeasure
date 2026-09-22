/* Dry-run (or apply) the day-routing optimizer from the CLI and print the
 * per-salesperson routes. Companion to seed-routing-demo.ts.
 *
 * Usage (from public/v1):
 *   node --experimental-sqlite --import tsx scripts/run-routing-demo.ts <orgId> [dateYYYY-MM-DD] [event_type_id] [--apply]
 */

import { optimizeDayRouting } from "../routing/service.js";

const orgId = String(process.argv[2] || "").trim();
const date = String(process.argv[3] || "2026-08-03").trim();
const eventTypeId = String(process.argv[4] || "sales_appointment").trim();
const apply = process.argv.includes("--apply");

if (!orgId) {
  console.error("Usage: node --experimental-sqlite --import tsx scripts/run-routing-demo.ts <orgId> [date] [event_type_id] [--apply]");
  process.exit(1);
}

function clock(iso: string) {
  const value = new Date(iso);
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

async function main() {
  const result = await optimizeDayRouting(orgId, { event_type_id: eventTypeId, date, apply });
  console.log(`Routing ${eventTypeId} on ${date} — ${result.subjects.length} subjects, total travel ${result.total_travel_minutes} min`);
  console.log(`Travel sources: ${JSON.stringify(result.travel_sources)}  ${apply ? `APPLIED ${result.applied_count} assignments` : "(dry run)"}`);
  console.log("");
  for (const route of result.routes) {
    console.log(`${route.subject_name} — ${route.stops.length} stops, ${route.travel_minutes} min travel`);
    for (const stop of route.stops) {
      const leg = stop.travel_from_previous_minutes ? ` (+${stop.travel_from_previous_minutes} min drive)` : "";
      console.log(`  ${stop.sequence}. ${clock(stop.start_at)}-${clock(stop.end_at)}  ${stop.project_title}${leg}`);
    }
  }
  if (result.unassigned.length) {
    console.log("");
    console.log("Unassigned:");
    for (const entry of result.unassigned) console.log(`  - ${entry.project_title || entry.event_id}: ${entry.reason}`);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("Routing run failed:", error);
  process.exit(1);
});
