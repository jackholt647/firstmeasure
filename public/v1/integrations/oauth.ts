import { createHash, randomBytes } from "node:crypto";
import type { PlatformAuthContext } from "../platform/auth.js";
import { conflict, forbidden } from "../platform/errors.js";
import { connection, definition, manage } from "./service.js";
import { secrets, storeCredentials, authIdentity } from "./credentials.js";
import { id, save, read, db } from "./storage.js";
import { requestExternal, safeUrl } from "./transport.js";
import type { Connector } from "./contracts.js";
export async function beginOAuth(
  ctx: PlatformAuthContext,
  key: string,
  redirectUri: string,
) {
  manage(ctx);
  const c = await connection(ctx, key),
    d = await definition(ctx.orgId, c, c.draftVersion);
  if (d.auth.kind !== "oauth2")
    throw conflict("oauth_unavailable", "This connection does not use OAuth.");
  const credentials = await secrets(ctx.orgId, key, d);
  const state = id("oauth"),
    verifier = randomBytes(32).toString("base64url");
  // The verifier is not an account secret, but it is never returned to the model.
  await save(
    ctx.orgId,
    "oauth",
    state,
    {
      user: ctx.userId,
      connection: key,
      version: c.draftVersion,
      identity: authIdentity(d),
      verifier,
      redirectUri,
      expiresAt: Date.now() + 600000,
      used: false,
    },
    0,
  );
  const { url } = await safeUrl(d.auth.authorizationUrl!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", d.auth.scopes.join(" "));
  return { url: url.href };
}
export async function completeOAuth(
  ctx: PlatformAuthContext,
  state: string,
  code: string,
) {
  manage(ctx);
  const claimed = await db().transaction(async () => {
    const s = await read(ctx.orgId, "oauth", state);
    if (!s || s.user !== ctx.userId || s.used || s.expiresAt < Date.now())
      throw forbidden(
        "oauth_state",
        "OAuth request expired or is already used.",
      );
    await save(ctx.orgId, "oauth", state, { ...s, used: true }, s.revision);
    return s;
  }, state);
  const c = await connection(ctx, claimed.connection),
    d = await definition(ctx.orgId, c, claimed.version);
  if (c.draftVersion !== claimed.version)
    throw conflict(
      "oauth_changed",
      "Connection changed. Start authorization again.",
    );
  const credentials = await secrets(ctx.orgId, c.id, d);
  const response = await requestExternal(d.auth.tokenUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: claimed.redirectUri,
      code_verifier: claimed.verifier,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }).toString(),
  });
  if (response.status !== 200)
    throw conflict(
      "oauth_exchange",
      "The provider rejected authorization. Start again.",
    );
  const result = JSON.parse(response.body);
  if (typeof result.access_token !== "string")
    throw conflict(
      "oauth_exchange",
      "The provider did not return an access token.",
    );
  await storeCredentials(ctx.orgId, c.id, d, {
    ...credentials,
    accessToken: result.access_token,
    refreshToken: result.refresh_token || "",
    expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000,
  });
  return { connected: true };
}
export async function refreshOAuthCredentials(
  ctx: PlatformAuthContext,
  key: string,
  d: Connector,
) {
  const outcome = await db().transaction(async () => {
    const existing = await secrets(ctx.orgId, key, d);
    if (Number(existing.expiresAt) > Date.now() + 60000) return existing;
    if (!existing.refreshToken || existing.refreshUncertain)
      throw conflict(
        "oauth_reconnect",
        "Reconnect this account to renew authorization.",
      );
    const uncertain = { ...existing, refreshUncertain: true };
    await storeCredentials(ctx.orgId, key, d, uncertain);
    try {
      const response = await requestExternal(d.auth.tokenUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: existing.refreshToken,
          client_id: existing.clientId,
          client_secret: existing.clientSecret,
        }).toString(),
      });
      if (response.status !== 200) return uncertain;
      const result = JSON.parse(response.body);
      if (typeof result.access_token !== "string") return uncertain;
      const updated = {
        ...existing,
        accessToken: result.access_token,
        refreshToken: result.refresh_token || existing.refreshToken,
        expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000,
        refreshUncertain: false,
      };
      await storeCredentials(ctx.orgId, key, d, updated);
      return updated;
    } catch {
      return uncertain;
    }
  }, `oauth-refresh:${ctx.orgId}:${key}`);
  if (outcome.refreshUncertain)
    throw conflict(
      "oauth_reconnect",
      "Authorization renewal has an uncertain outcome. Reconnect this account.",
    );
  return outcome;
}
