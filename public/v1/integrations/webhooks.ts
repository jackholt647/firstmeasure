import { createHmac, timingSafeEqual } from "node:crypto";
import { forbidden, badRequest } from "../platform/errors.js";
import { backgroundAuthContext } from "../platform/auth.js";
import { read, db } from "./storage.js";
import { definition } from "./service.js";
import { secrets } from "./credentials.js";
import { at, object, type Obj } from "./contracts.js";
import { redact } from "./transport.js";
import { contentHash } from "../platform/publication/validation.js";
import { emitWorkEvent } from "../work/engine.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";

export async function receiveWebhook(
  org: string,
  key: string,
  body: string,
  headers: Obj,
) {
  if (!await isCapabilityEnabled(org, "platform.connections"))
    throw forbidden("webhook_unavailable", "Webhook unavailable.");
  const c = await read(org, "connection", key);
  if (!c?.enabled)
    throw forbidden("webhook_unavailable", "Webhook unavailable.");
  const d = await definition(org, c),
    config = d.webhook;
  if (!config) throw forbidden("webhook_unavailable", "Webhook unavailable.");
  const credential = await secrets(org, key, d);
  const supplied = String(
    headers[config.signatureHeader.toLowerCase()] || "",
  ).replace(/^sha256=/, "");
  const expected = createHmac(
    "sha256",
    String(credential[config.secretField] || ""),
  )
    .update(body)
    .digest();
  const signature = Buffer.from(supplied, "hex");
  if (
    !credential[config.secretField] ||
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw forbidden("webhook_signature", "Webhook signature is invalid.");
  let payload: Obj;
  try {
    payload = object(JSON.parse(body));
  } catch {
    throw badRequest("webhook_payload", "Expected a JSON event.");
  }
  const eventId = at(payload, config.eventIdPath),
    type = at(payload, config.eventTypePath);
  if (
    typeof eventId !== "string" ||
    !eventId ||
    eventId.length > 300 ||
    !config.allowedEvents.includes(type)
  )
    throw badRequest(
      "webhook_event",
      "Unknown event type or missing event ID.",
    );
  // Authenticate the connection's current author before publishing any business event.
  await backgroundAuthContext(org, c.owner);
  const projectId = config.projectIdPath
    ? String(at(payload, config.projectIdPath) || "")
    : "";
  if (projectId)
    await (
      await import("../platform/storage.js")
    ).readDocument(org, "projects", projectId);
  const eventKey = `connection-webhook:${contentHash({ org, key, eventId })}`;
  await emitWorkEvent({
    organization_id: org,
    branch_id: "default",
    project_id: projectId,
    type: `external.${key}.${type}`,
    payload: redact(payload, credential),
    context: { connection_id: key },
    idempotency_key: eventKey,
  });
  return { accepted: true };
}
