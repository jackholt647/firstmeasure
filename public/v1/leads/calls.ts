import { createHash } from "node:crypto";
import { findExactMatches } from "../contacts/records.js";
import { readIntakeRouting } from "../scopes/router.js";
import { receiveLead } from "./receive.js";

// A missed call or voicemail that matched no project (docs/architecture/opportunities.md):
// the branch's `call_leads` setting says whether it arrives as a lead. A number no contact
// has is a new lead by default; a known contact's call is only logged by default.

const text = (value: unknown) => String(value ?? "").trim();

export async function leadFromMissedCall(orgId: string, call: { id: string; branch_id?: string; customer_number?: string; project_id?: string; metadata?: Record<string, unknown> }) {
  const none = { project_id: "", contact_id: "" };
  if (text(call.project_id)) return { project_id: text(call.project_id), contact_id: "" };
  const number = text(call.customer_number);
  if (!number) return none;
  const branchId = text(call.branch_id) || "default";
  const settings = (await readIntakeRouting(orgId, branchId)).call_leads;
  const known = (await findExactMatches(orgId, { phone: number })).length > 0;
  if ((known ? settings.known_contacts : settings.unknown_numbers) !== "new_lead") return none;
  const projectId = `project_lead_call_${createHash("sha256").update(`${orgId}:${call.id}`).digest("hex").slice(0, 32)}`;
  const voicemail = !!(call.metadata && typeof call.metadata.voicemail === "object" && (call.metadata.voicemail as Record<string, unknown>).started);
  try {
    const lead = await receiveLead(orgId, {
      branch_id: branchId,
      project_id: projectId,
      source: { kind: "missed_call", provider: "Phone", call_id: call.id, voicemail },
      contacts: [{ phone: number, phones: [number] }],
      title: `${voicemail ? "Voicemail" : "Missed call"} from ${number}`,
      notification: { title: voicemail ? "New voicemail lead" : "Missed call from a new number", source: "missed_call_lead" }
    });
    return { project_id: projectId, contact_id: text(lead.contacts[0]?.id) };
  } catch (error) {
    // A retry after the lead was made reuses it.
    if ((error as { code?: string })?.code !== "document_exists") throw error;
  }
  return { project_id: projectId, contact_id: "" };
}
