import type { JsonObject } from "../../platform/storage.js";

// Legacy proposal links no longer collect signatures (customers sign through
// Documents). Payment tests still need a signed proposal's receivables, so
// they mark the sent snapshot signed the way the old signature step did and
// mint its receivables through the same path a real signature takes.

/** Marks the proposal snapshot behind a public link signed and creates its receivables. */
export async function signLegacyProposalForTest(publicToken: string, signerName = "Customer") {
  const { findPublicProposalSnapshot } = await import("../../proposals/storage.js");
  const storage = await import("../../platform/storage.js");
  const { ensureReceivablesForSignedProposal } = await import("../../payments/storage.js");
  const { orgId, snapshot } = await findPublicProposalSnapshot(publicToken);
  const now = new Date().toISOString();
  const data: JsonObject = {
    ...snapshot,
    status: "signed",
    signed_at: now,
    customer_signed_at: now,
    signer_name: signerName,
    delivery: { ...((snapshot.delivery as JsonObject) || {}), state: "signed", signed_at: now }
  };
  await storage.upsertDocument(orgId, "proposal_snapshots", {
    id: String(snapshot.id),
    data,
    metadata: { kind: "proposal_snapshot", proposal_id: String(snapshot.proposal_id), public_token: publicToken }
  }, { replace: true });
  await ensureReceivablesForSignedProposal(orgId, String(snapshot.proposal_id), String(snapshot.id), { signed_at: now });
  return { ok: true, orgId, snapshot: data };
}
