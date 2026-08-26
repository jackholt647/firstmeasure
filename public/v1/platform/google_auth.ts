import { OAuth2Client } from "google-auth-library";

import { env } from "../src/config/env.js";
import { PlatformError, unauthorized } from "./errors.js";

export type GoogleIdentityClaims = {
  sub: string;
  email: string;
  emailVerified: true;
  name: string;
  picture: string;
  hostedDomain: string;
};

export type GoogleIdTokenVerifier = (credential: string, audience: string) => Promise<unknown>;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const defaultVerifier: GoogleIdTokenVerifier = async (credential, audience) => {
  const ticket = await new OAuth2Client().verifyIdToken({ idToken: credential, audience });
  return ticket.getPayload() || {};
};

export async function verifyGoogleCredential(
  credentialValue: unknown,
  verifier: GoogleIdTokenVerifier = defaultVerifier
): Promise<GoogleIdentityClaims> {
  const audience = env.googleAuthClientId.trim();
  if (!audience) {
    throw new PlatformError("google_auth_not_configured", 503, "Google sign-in is not configured.");
  }

  const credential = String(credentialValue ?? "").trim();
  if (!credential) throw unauthorized("google_credential_required", "A Google credential is required.");

  let payload: Record<string, unknown>;
  try {
    payload = asObject(await verifier(credential, audience));
  } catch {
    throw unauthorized("invalid_google_credential", "Google could not verify this sign-in.");
  }

  const sub = String(payload.sub ?? "").trim();
  const email = String(payload.email ?? "").trim().toLowerCase();
  if (!sub || !email || payload.email_verified !== true) {
    throw unauthorized("unverified_google_email", "Google did not provide a verified email address.");
  }

  return {
    sub,
    email,
    emailVerified: true,
    name: String(payload.name ?? "").trim(),
    picture: String(payload.picture ?? "").trim(),
    hostedDomain: String(payload.hd ?? "").trim().toLowerCase()
  };
}
