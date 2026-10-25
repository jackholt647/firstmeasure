/**
 * Service credentials (docs/architecture/request-security.md#service-calls).
 *
 * In process: `serviceInject` hands the injected request the caller's own
 * principal through a per-process token and a one-use handle. The token is
 * random per process and never leaves it, so no network request can present
 * one.
 *
 * PHP: a request signed with the internal secret over method, path and query,
 * time, actor and the body's SHA-256.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, InjectOptions } from "fastify";
import type { Principal } from "./principal.js";

const PROCESS_TOKEN = randomBytes(32).toString("base64url");
const PROCESS_TOKEN_HEADER = "x-fm-process-token";
const PROCESS_HANDLE_HEADER = "x-fm-process-principal";
const handles = new Map<string, { principal: Principal; expires: number }>();

export const SERVICE_SIGNATURE_HEADERS = {
  time: "x-fm-service-time",
  actor: "x-fm-service-actor",
  bodySha256: "x-fm-service-body-sha256",
  signature: "x-fm-service-signature"
} as const;
export const SERVICE_SIGNATURE_WINDOW_SECONDS = 120;
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return String(Array.isArray(value) ? value[0] : value ?? "").trim();
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Inject a request into this app as `principal`: the caller's own principal
 * when the call acts for the current request, or `systemPrincipal()` for
 * unattended work. The handle is single-use and expires after a minute.
 */
export async function serviceInject(app: FastifyInstance, principal: Principal, options: InjectOptions) {
  const handle = randomBytes(18).toString("base64url");
  handles.set(handle, { principal, expires: Date.now() + 60_000 });
  try {
    return await app.inject({
      ...options,
      headers: { ...(options.headers ?? {}), [PROCESS_TOKEN_HEADER]: PROCESS_TOKEN, [PROCESS_HANDLE_HEADER]: handle }
    });
  } finally {
    handles.delete(handle);
  }
}

let rootApp: FastifyInstance | null = null;

/** Called once by buildApp so modules without an app reference can make in-process calls. */
export function setServiceApp(app: FastifyInstance) {
  rootApp = app;
}

/** `serviceInject` on the running app (for modules that have no app reference). */
export async function serviceRequest(principal: Principal, options: InjectOptions) {
  if (!rootApp) throw new Error("The service app is not ready.");
  return await serviceInject(rootApp, principal, options);
}

/** The principal an in-process call carries, or null when it carries none or a forged one. */
export function processPrincipal(request: FastifyRequest): Principal | null {
  const token = header(request, PROCESS_TOKEN_HEADER);
  if (!token) return null;
  if (!safeEqual(token, PROCESS_TOKEN)) return null;
  const handle = header(request, PROCESS_HANDLE_HEADER);
  const entry = handles.get(handle);
  if (!entry || entry.expires < Date.now()) return null;
  handles.delete(handle);
  return entry.principal;
}

/** Whether a request presents process-token headers at all (forged ones are refused, not ignored). */
export function presentsProcessToken(request: FastifyRequest) {
  return Boolean(header(request, PROCESS_TOKEN_HEADER) || header(request, PROCESS_HANDLE_HEADER));
}

export function serviceSignaturePayload(input: { method: string; url: string; time: string; actor: string; bodySha256: string }) {
  return ["v1", input.method.toUpperCase(), input.url, input.time, input.actor, input.bodySha256].join("\n");
}

export function signServiceRequest(secret: string, input: { method: string; url: string; actor: string; body?: string | Buffer | null; time?: number }) {
  const time = String(input.time ?? Math.floor(Date.now() / 1000));
  const bodySha256 = input.body == null ? createHash("sha256").update("").digest("hex") : createHash("sha256").update(input.body).digest("hex");
  const signature = createHmac("sha256", secret).update(serviceSignaturePayload({ method: input.method, url: input.url, time, actor: input.actor, bodySha256 })).digest("hex");
  return {
    [SERVICE_SIGNATURE_HEADERS.time]: time,
    [SERVICE_SIGNATURE_HEADERS.actor]: input.actor,
    [SERVICE_SIGNATURE_HEADERS.bodySha256]: bodySha256,
    [SERVICE_SIGNATURE_HEADERS.signature]: signature
  };
}

export function presentsServiceSignature(request: FastifyRequest) {
  return Boolean(header(request, SERVICE_SIGNATURE_HEADERS.signature));
}

const rawBodies = new WeakMap<FastifyRequest, Buffer>();
export function rememberRawBody(request: FastifyRequest, body: Buffer) {
  rawBodies.set(request, body);
}

/**
 * The verified actor of a signed PHP request ("system" or a lower-case
 * email), or null. A wrong signature, stale time or mismatched body is null.
 */
export function verifyServiceSignature(request: FastifyRequest, secret: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return null;
  const time = header(request, SERVICE_SIGNATURE_HEADERS.time);
  const actor = header(request, SERVICE_SIGNATURE_HEADERS.actor).toLowerCase();
  const bodySha256 = header(request, SERVICE_SIGNATURE_HEADERS.bodySha256).toLowerCase();
  const signature = header(request, SERVICE_SIGNATURE_HEADERS.signature).toLowerCase();
  if (!/^\d{10}$/.test(time) || Math.abs(nowSeconds - Number(time)) > SERVICE_SIGNATURE_WINDOW_SECONDS) return null;
  if (!actor || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (bodySha256 !== UNSIGNED_PAYLOAD.toLowerCase() && !/^[a-f0-9]{64}$/.test(bodySha256)) return null;
  const expected = createHmac("sha256", secret).update(serviceSignaturePayload({
    method: request.method, url: request.url, time, actor, bodySha256: bodySha256 === UNSIGNED_PAYLOAD.toLowerCase() ? UNSIGNED_PAYLOAD : bodySha256
  })).digest("hex");
  if (!safeEqual(signature, expected)) return null;
  const contentType = header(request, "content-type").toLowerCase();
  const multipart = contentType.startsWith("multipart/");
  if (bodySha256 === UNSIGNED_PAYLOAD.toLowerCase()) {
    // Only streamed uploads may leave the body unsigned; the path, time and actor still are.
    if (!multipart) return null;
  } else {
    const raw = rawBodies.get(request) ?? Buffer.alloc(0);
    if (!safeEqual(createHash("sha256").update(raw).digest("hex"), bodySha256)) return null;
  }
  return actor;
}

/** Content types whose raw bytes are kept so a signed request's body can be checked. */
export function capturesRawBody(request: FastifyRequest) {
  if (!presentsServiceSignature(request)) return false;
  return !header(request, "content-type").toLowerCase().startsWith("multipart/");
}
