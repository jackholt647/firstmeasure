import type { PlatformAuthContext } from "../platform/auth.js";
import { sendEngineEmail } from "./engine.js";

type Json = Record<string, unknown>;

function clean(value: unknown) { return String(value ?? "").trim(); }
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }

export type OrganizationTransactionalEmailInput = {
  organizationId: string;
  branchId?: string;
  to: string | Array<{ address: string; name?: string; type?: "to" | "cc" | "bcc" }>;
  subject: string;
  textBody: string;
  htmlBody?: string;
  purpose?: "customer_care" | "transactional" | "appointment" | "project_update" | "billing" | "account_notification" | "delivery_notification";
  projectId?: string;
  context?: Json;
  source?: Json;
  tags?: string[];
  metadata?: Json;
  idempotencyKey?: string;
  attachments?: Array<{ name: string; contentType: string; content: Uint8Array | string }>;
};

/** Customer-facing organization mail. Never use this for FirstMate account/auth mail. */
export async function sendOrganizationTransactionalEmail(
  input: OrganizationTransactionalEmailInput,
  ctx?: Partial<PlatformAuthContext>
) {
  const recipients = typeof input.to === "string"
    ? [{ address: clean(input.to) }]
    : input.to.map((recipient) => ({ ...recipient, address: clean(recipient.address) }));
  const result = await sendEngineEmail(input.organizationId, {
    branch_id: clean(input.branchId || "default") || "default",
    recipients,
    subject: input.subject,
    text: input.textBody,
    html: input.htmlBody,
    purpose: input.purpose || "transactional",
    tags: input.tags,
    attachments: input.attachments?.map((attachment) => ({
      name: attachment.name,
      content_type: attachment.contentType,
      content: attachment.content
    })),
    context: { ...(input.projectId ? { project_id: input.projectId } : {}), ...object(input.context) },
    source: { type: "system", ...object(input.source) },
    metadata: { ...object(input.metadata), purpose: input.purpose || "transactional", tags: input.tags || [] },
    idempotency_key: input.idempotencyKey
  }, ctx);
  const message = object(result.message);
  const ok = clean(message.status) !== "failed";
  return { ok, success: ok, message, result };
}
