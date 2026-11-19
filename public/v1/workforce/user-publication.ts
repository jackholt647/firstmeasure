import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest, forbidden } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { readDocument } from "../platform/storage.js";
import { env } from "../src/config/env.js";

/**
 * Adding a person to the organization and inviting them, on the publication layer (GP-66), for setups that add people
 * where they are needed (the workforce setup's "New crew member" and its invite to the crew app). They run the same
 * writers as People's Invite and Resend invitation (`createPlatformOrgUser`, `sendPlatformOrgUserInvite`), as the
 * person, with People's permission and branch rules. A person added here starts as People adds one (viewer, invited)
 * and is not emailed until they are invited; joining a group gives them that group type's roles.
 */
const text = (value: unknown) => String(value ?? "").trim();
const PEOPLE = "manage_company_users|manage_users";
const addInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  phone: z.string().trim().max(40).optional()
}).strict();
const inviteInput = z.object({ user_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
const person = (document: Record<string, unknown>) => { const data = (document.data || {}) as Record<string, unknown>; return { id: text(document.id), name: text(data.name) || text(data.email), email: text(data.email).toLowerCase(), status: text(data.status) || "active" }; };

let registered = false;
export function registerWorkforceUserPublication() {
  if (registered) return;
  registered = true;
  registerAction({ id: "workforce.users.add", version: "1", domain: "workforce", implementation: backendImplementationDigest(),
    description: "Add a person to the organization by name and email, as People's Invite does, without emailing them yet: they start as a viewer, invited. Joining a group gives them its type's roles. Invite them with workforce.users.invite.",
    inputSchema: json(addInput), outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: [PEOPLE] },
    effect: "write", executionKinds: ["api", "agent"], idempotency: "required",
    validateInput: (value) => { addInput.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("workforce_users_person", "People are added by a person.");
      const input = addInput.parse(value);
      const body = { data: { name: input.name, email: input.email, phone: input.phone || "", role: "viewer", status: "invited", permissions: {}, account_type: "customer" } };
      await (await import("./branch-guards.js")).guardUserCollection(ctx.auth, "create", "", body);
      const api = await import("../platform/api.js");
      const document = await api.createPlatformOrgUser(ctx.organizationId, body);
      api.invalidatePlatformSearchCache(ctx.organizationId);
      return { user: person(document as Record<string, unknown>) };
    } });
  registerAction({ id: "workforce.users.invite", version: "1", domain: "workforce", implementation: backendImplementationDigest(),
    description: "Email people of the organization their invitation to FirstMate (the app), as People's Resend invitation does: a link to set up their sign-in, or to sign in when they already have one. Someone without an email is reported, not invited.",
    inputSchema: json(inviteInput), outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: [PEOPLE] },
    effect: "write", executionKinds: ["api", "agent"], idempotency: "required",
    validateInput: (value) => { inviteInput.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("workforce_users_person", "People are invited by a person.");
      const input = inviteInput.parse(value);
      const guards = await import("./branch-guards.js"), api = await import("../platform/api.js");
      const invites: { user_id: string; ok: boolean; existing_account?: boolean; error?: string }[] = [];
      for (const userId of [...new Set(input.user_ids)]) {
        const document = await readDocument(ctx.organizationId, "users", userId).catch(() => null);
        if (!document) throw badRequest("workforce_user_not_found", `There is nobody called ${userId} in this organization.`);
        await guards.guardUserCollection(ctx.auth, "write", userId);
        if (!person(document as Record<string, unknown>).email) { invites.push({ user_id: userId, ok: false, error: "no_email" }); continue; }
        // The link goes to the site people use, as an invite sent from People does.
        const sent = await api.sendPlatformOrgUserInvite(ctx.organizationId, document, { headers: { origin: env.publicBaseUrl } }, text(ctx.auth.identity?.email).toLowerCase());
        invites.push({ user_id: userId, ok: sent.ok, existing_account: sent.existing_account, ...(sent.ok ? {} : { error: text(sent.error) || "not_sent" }) });
      }
      return { invites, sent: invites.filter((row) => row.ok).length };
    } });
}
