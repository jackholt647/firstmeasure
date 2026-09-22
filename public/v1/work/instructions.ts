// Work/scheduling app — published agent instructions. Imported for side
// effect from work/api.ts so any AI agent (assistant, comms) can discover how
// to schedule correctly, including org-specific availability derived from the
// branch scheduling settings.

import { registerAgentInstructions } from "../platform/agent_instructions.js";
import { readBranchModule } from "../platform/storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

registerAgentInstructions({
  id: "work.scheduling",
  title: "Scheduling project events",
  order: 20,
  instructions: async ({ organizationId, branchId }) => {
    let hoursLine = "Sales appointment hours are not configured for this branch; treat normal business hours (8:00–18:00 local) as the default window.";
    try {
      const module = await readBranchModule(organizationId, branchId, "scheduling");
      const availability = asObject(asObject(asObject(module).data).availability);
      const start = cleanText(availability.sales_appointment_start_time);
      const end = cleanText(availability.sales_appointment_end_time);
      if (start && end) {
        hoursLine = `Sales appointments for this branch may only be booked between ${start} and ${end} (branch local time).`;
      }
    } catch {
      // Defaults line stands.
    }
    return [
      "Project events (appointments, installs, inspections) live on the project and are created or moved with the scheduling tools.",
      hoursLine,
      "Before scheduling or rescheduling: check the project's existing events for the requested day to avoid double-booking the customer, and keep events of different types (e.g. a sales appointment and a site measure) from overlapping.",
      "Sales appointments need someone in a sales role available; if assignment data is unavailable to you, schedule the event unassigned and say so rather than guessing an assignee.",
      "When a customer asks to move an appointment, reschedule the EXISTING event (keep its type, duration, and assignees) instead of creating a duplicate. Confirm the new time back to the customer in plain language including the date, time, and what the appointment is for."
    ].join("\n");
  }
});

registerAgentInstructions({
  id: "work.tasks",
  title: "Tasks and project stages",
  order: 25,
  instructions: [
    "Projects move through data-driven stages (scope templates). Stage transitions and to-dos are work nodes; completing or skipping a node can trigger automations (notifications, messages, material orders).",
    "Only transition a stage or complete a task when the underlying thing has actually happened. If a customer message implies work happened (e.g. \"the crew just left\"), report it rather than transitioning stages yourself unless you were explicitly asked."
  ].join("\n")
});
