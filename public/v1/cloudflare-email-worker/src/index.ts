import PostalMime from "postal-mime";

type InboundQueueMessage = {
  objectKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: string;
};

// Wrangler generates all non-secret bindings in Env. Secrets intentionally do
// not live in wrangler.jsonc, so this intersection records the runtime secret.
type WorkerEnv = Env & {
  FIRSTMATE_INBOUND_WEBHOOK_TOKEN: string;
  FIRSTMATE_OUTBOUND_API_TOKEN: string;
};

type OutboundPayload = EmailMessageBuilder;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function parsedAddress(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const entry = value as { address?: unknown; name?: unknown };
  const address = clean(entry.address).toLowerCase();
  if (!address) return null;
  const name = clean(entry.name);
  return { address, ...(name ? { name } : {}) };
}

function bounded(value: unknown, max: number) {
  return clean(value).slice(0, max);
}

function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/outbound") {
      return Response.json({ success: false, error: "not_found" }, { status: 404 });
    }
    if (!env.FIRSTMATE_OUTBOUND_API_TOKEN || bearerToken(request) !== env.FIRSTMATE_OUTBOUND_API_TOKEN) {
      return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
    }
    try {
      const payload = await request.json() as OutboundPayload;
      const result = await env.EMAIL.send(payload);
      return Response.json({ success: true, messageId: result.messageId });
    } catch (error) {
      console.error(JSON.stringify({ event: "outbound_email_failed", error: error instanceof Error ? error.message : String(error) }));
      return Response.json({ success: false, error: "cloudflare_email_send_failed" }, { status: 502 });
    }
  },

  async email(message, env): Promise<void> {
    const objectKey = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
    await env.RAW_EMAIL.put(objectKey, message.raw, {
      customMetadata: {
        envelopeFrom: message.from.slice(0, 500),
        envelopeTo: message.to.slice(0, 500)
      }
    });
    try {
      await env.INBOUND_EMAIL_QUEUE.send({
        objectKey,
        envelopeFrom: message.from,
        envelopeTo: message.to,
        receivedAt: new Date().toISOString()
      } satisfies InboundQueueMessage);
    } catch (error) {
      await env.RAW_EMAIL.delete(objectKey);
      throw error;
    }
  },

  async queue(batch, env): Promise<void> {
    for (const queued of batch.messages) {
      try {
        const item = queued.body as InboundQueueMessage;
        const stored = await env.RAW_EMAIL.get(item.objectKey);
        if (!stored) throw new Error("raw_email_not_found");
        const parsed = await PostalMime.parse(await stored.arrayBuffer());
        const from = parsedAddress(parsed.from) ?? { address: item.envelopeFrom.toLowerCase() };
        const parsedRecipients = [...(parsed.to ?? []), ...(parsed.cc ?? [])]
          .map(parsedAddress)
          .filter((value): value is NonNullable<typeof value> => value !== null);
        const recipients = [{ address: item.envelopeTo.toLowerCase() }, ...parsedRecipients]
          .filter((value, index, all) => all.findIndex((candidate) => candidate.address === value.address) === index)
          .slice(0, 50);
        const referencesHeader = clean(parsed.headers?.find((header) => header.key.toLowerCase() === "references")?.value);
        const payload = {
          provider: "cloudflare_email",
          provider_event_id: item.objectKey,
          from,
          to: recipients,
          subject: bounded(parsed.subject, 998),
          text: bounded(parsed.text, 500_000),
          html: bounded(parsed.html, 1_000_000),
          headers: {
            message_id: bounded(parsed.messageId, 500),
            in_reply_to: bounded(parsed.inReplyTo, 500),
            references: referencesHeader.split(/\s+/).filter(Boolean).slice(-50)
          },
          occurred_at: item.receivedAt,
          metadata: { cloudflare: { r2_object_key: item.objectKey } }
        };
        const response = await fetch(env.FIRSTMATE_INBOUND_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.FIRSTMATE_INBOUND_WEBHOOK_TOKEN}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`firstmate_inbound_http_${response.status}`);
        await env.RAW_EMAIL.delete(item.objectKey);
        queued.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "inbound_email_failed", queueMessageId: queued.id, error: error instanceof Error ? error.message : String(error) }));
        queued.retry();
      }
    }
  }
} satisfies ExportedHandler<WorkerEnv, InboundQueueMessage>;
