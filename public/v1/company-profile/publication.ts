import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema } from "../platform/publication/contracts.js";
import { forbidden } from "../platform/errors.js";
import { companyProfilePatchSchema, publishedCatalog, readCompanyProfile, saveCompanyProfile } from "./profile.js";

/**
 * The company profile on the publication layer (docs/architecture/setup-steps.md): other apps, modules and agents
 * read what kind of company this is and what work it does from `company-profile.profile`, and the setup step's
 * search reads `company-profile.catalog`. Saving is `company-profile.save`, run as the person.
 */
const copy = z.object({ key: z.string(), text: z.string() }).strict();
const profileSchema = z.object({
  company_type: z.string().nullable(), company_type_label: z.string().nullable(), company_type_other: z.string().nullable(),
  industry: z.string().nullable(), crm_pack: z.string().nullable(),
  services: z.array(z.object({ id: z.string(), label: z.string(), work_kind: z.string().nullable() }).strict()),
  services_other: z.array(z.string()), work_kinds: z.array(z.string()),
  answered: z.object({ type: z.boolean(), services: z.boolean() }).strict(),
  updated_at: z.string().nullable(), revision: z.number().int()
}).strict();
const catalogSchema = z.object({
  company_types: z.array(z.object({ id: z.string(), label: copy, terms: z.array(z.string()), industry: z.string(), services: z.array(z.string()) }).strict()),
  services: z.array(z.object({ id: z.string(), label: copy, terms: z.array(z.string()), work_kind: z.string().nullable() }).strict()),
  other: z.object({ id: z.string() }).strict()
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;

/** Anyone in the organization who sees projects may read it; it holds no personal or commercial data. */
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"] };

let registered = false;
export function registerCompanyProfilePublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "company-profile", version: "1", apps: ["onboarding"], exports: {
    profile: { description: "What kind of company the organization is (its company type, industry and CRM pack) and the kinds of work it does, with the measurement schema of each. `answered` says which parts have been answered.",
      schema: json(profileSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readCompanyProfile(ctx.organizationId); return { value, revision: String(value.revision) }; } },
    catalog: { description: "The kinds of company and kinds of work a company profile can name, with their copy keys, search terms and each type's suggested services. Data that only grows.",
      schema: json(catalogSchema), schemaVersion: "1", access: readAccess,
      read: async () => ({ value: publishedCatalog() }) }
  } });
  const input = companyProfilePatchSchema;
  registerAction({ id: "company-profile.save", version: "1", domain: "organization", implementation: backendImplementationDigest(),
    description: "Save part of the company profile: the kind of company (an id from the catalog, or other with the person's words) and/or the kinds of work it does. Parts not given are kept.",
    inputSchema: json(input) as Record<string, unknown>, outputSchema: json(profileSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    validateInput: (value) => { input.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("company_profile_person", "The company profile is saved by a person.");
      return saveCompanyProfile(ctx.organizationId, value, ctx.auth.userId);
    } });
}
