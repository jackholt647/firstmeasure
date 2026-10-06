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
  let payload: Obj;
  try { payload = object(JSON.parse(body)); } catch { throw badRequest("webhook_payload", "Expected a JSON event."); }
  const supplied = String(
    headers[config.signatureHeader.toLowerCase()] || "",
  ).replace(/^sha256=/, "");
  const expected = config.verification === "hmac_sha256" ? createHmac(
    "sha256",
    String(credential[config.secretField] || ""),
  )
    .update(body)
    .digest() : Buffer.from(String(credential[config.secretField]||""));
  const token = config.verification === "body_token" ? at(payload,config.tokenPath) : headers[config.signatureHeader.toLowerCase()];
  const signature = config.verification === "hmac_sha256" ? Buffer.from(supplied, "hex") : Buffer.from(typeof token==="string"?token:"");
  if (
    !credential[config.secretField] ||
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw forbidden("webhook_signature", "Webhook signature is invalid.");
  const eventId = at(payload, config.eventIdPath),
    type = at(payload, config.eventTypePath) || config.defaultEvent;
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
  const auth = await backgroundAuthContext(org, c.owner);
  const safePayload=redact(payload,credential);
  if(d.leadImport?.mode==="webhook"){
    if(at(payload,config.testPath)===true)return {accepted:true,test:true};
    // Import precedes the event acknowledgement. A redelivery recovers event publication without repeating lead effects.
    const intake=await (await import('./lead-intake.js')).receiveConnectionLead(auth,key,d,safePayload,String(eventId));
    if(!intake.accepted)return intake;
  }
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
    payload: safePayload,
    context: { connection_id: key },
    idempotency_key: eventKey,
  });
  return { accepted: true };
}
