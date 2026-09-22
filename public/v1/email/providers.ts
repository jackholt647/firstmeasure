// Provider-neutral FirstMate Mail delivery. Capture mode never leaves the
// process; test/live call the private endpoint on FirstMate's Cloudflare
// Email Worker, which sends through a native Email Sending binding.

import { env } from "../src/config/env.js";

export type OutboundEmail = {
  organization_id: string;
  branch_id: string;
  message_id: string;
  rfc_message_id: string;
  in_reply_to?: string;
  references?: string[];
  from: { address: string; name?: string; reply_to?: string };
  to: Array<{ address: string; name?: string; type?: string }>;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ name: string; content_type: string; content: Uint8Array | string }>;
  tenant_id?: string;
};

export type EmailSendResult = {
  accepted: boolean;
  provider: string;
  provider_message_id: string;
  transport_mode: "capture" | "test" | "live";
  recipient_rewritten?: boolean;
  error?: string;
};

export interface EmailProvider {
  readonly id: string;
  send(email: OutboundEmail): Promise<EmailSendResult>;
}

type CloudflareSendResponse = { success?: boolean; messageId?: string; error?: string };

function addressDomain(address: string) {
  return address.trim().toLowerCase().split("@").pop() ?? "";
}

function isAtOrBelowDomain(address: string, domain: string) {
  const actual = addressDomain(address);
  const expected = domain.trim().toLowerCase();
  return Boolean(expected) && (actual === expected || actual.endsWith(`.${expected}`));
}

export function rewriteFirstMateTestRecipients(email: OutboundEmail) {
  const sourceDomain = env.firstmateMailDomain.trim().toLowerCase();
  const targetDomain = env.emailTestRecipientDomain.trim().toLowerCase();
  const rewriteEnabled = env.emailDeliveryMode === "test"
    || (env.emailTestRecipientRewrite && addressDomain(email.from.address) === sourceDomain);
  if (!rewriteEnabled) return { recipients: email.to, rewritten: false };
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(targetDomain)) {
    throw new Error("email_test_recipient_domain_invalid");
  }

  let rewritten = false;
  const seen = new Set<string>();
  const recipients = email.to.flatMap((recipient) => {
    const original = recipient.address.trim().toLowerCase();
    const separator = original.lastIndexOf("@");
    if (separator <= 0) throw new Error("email_test_recipient_invalid");
    const address = isAtOrBelowDomain(original, targetDomain) ? original : `${original.slice(0, separator)}@${targetDomain}`;
    if (address !== original) rewritten = true;
    if (seen.has(address)) return [];
    seen.add(address);
    return [{ ...recipient, address }];
  });
  return { recipients, rewritten };
}

function apiAddress(address: string, name?: string) {
  return name ? { email: address, name } : address;
}

function base64Content(content: Uint8Array | string) {
  return typeof content === "string" ? content : Buffer.from(content).toString("base64");
}

export const mockEmailProvider: EmailProvider = {
  id: "firstmate_mail_mock",
  async send(email) {
    return { accepted: true, provider: "firstmate_mail_mock", provider_message_id: `mockmail_${email.message_id}`, transport_mode: "capture" };
  }
};

export function createCloudflareEmailProvider(fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    id: "cloudflare_email",
    async send(email) {
      const transportMode = env.emailDeliveryMode === "test" ? "test" : "live";
      if (!env.cloudflareEmailWorkerUrl || !env.cloudflareEmailWorkerToken) {
        return { accepted: false, provider: "cloudflare_email", provider_message_id: "", transport_mode: transportMode, error: "cloudflare_email_not_configured" };
      }
      if (!email.tenant_id) {
        return { accepted: false, provider: "cloudflare_email", provider_message_id: "", transport_mode: transportMode, error: "email_tenant_required" };
      }
      let gated: ReturnType<typeof rewriteFirstMateTestRecipients>;
      try {
        gated = rewriteFirstMateTestRecipients(email);
      } catch (error) {
        return { accepted: false, provider: "cloudflare_email", provider_message_id: "", transport_mode: transportMode, error: error instanceof Error ? error.message : "email_test_recipient_gate_failed" };
      }
      const byType = (type: string) => gated.recipients.filter((recipient) => (recipient.type || "to") === type).map((recipient) => apiAddress(recipient.address, recipient.name));
      const payload = {
        from: apiAddress(email.from.address, email.from.name),
        to: byType("to"),
        ...(byType("cc").length ? { cc: byType("cc") } : {}),
        ...(byType("bcc").length ? { bcc: byType("bcc") } : {}),
        ...(email.from.reply_to ? { reply_to: email.from.reply_to } : {}),
        subject: email.subject,
        ...(email.text ? { text: email.text } : {}),
        ...(email.html ? { html: email.html } : {}),
        headers: {
          "X-FirstMate-Organization-ID": email.organization_id,
          "X-FirstMate-Message-ID": email.message_id,
          ...(email.in_reply_to ? { "In-Reply-To": email.in_reply_to } : {}),
          ...(email.references?.length ? { References: email.references.join(" ") } : {})
        },
        ...(email.attachments?.length ? { attachments: email.attachments.map((attachment) => ({ content: base64Content(attachment.content), filename: attachment.name, type: attachment.content_type, disposition: "attachment" })) } : {})
      };
      try {
        const response = await fetchImpl(env.cloudflareEmailWorkerUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${env.cloudflareEmailWorkerToken}`, "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await response.json().catch(() => null) as CloudflareSendResponse | null;
        const accepted = response.ok && body?.success === true;
        return {
          accepted,
          provider: "cloudflare_email",
          provider_message_id: accepted ? (body?.messageId || `cfmail_${email.message_id}`) : "",
          transport_mode: transportMode,
          recipient_rewritten: gated.rewritten,
          ...(!accepted ? { error: body?.error || `cloudflare_email_http_${response.status}` } : {})
        };
      } catch (error) {
        return { accepted: false, provider: "cloudflare_email", provider_message_id: "", transport_mode: transportMode, error: error instanceof Error ? error.message : "cloudflare_email_send_failed" };
      }
    }
  };
}

export const cloudflareEmailProvider = createCloudflareEmailProvider();

export function activeEmailProvider(): EmailProvider {
  return env.emailDeliveryMode === "capture" ? mockEmailProvider : cloudflareEmailProvider;
}
