import { z } from "zod";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError, badRequest, conflict } from "../platform/errors.js";
import { COMPANY_TYPES, OTHER_COMPANY_TYPE, SERVICES, companyType, serviceOf } from "./catalog.js";

/**
 * The organization's company profile: what kind of company it is and the kinds of work it does
 * (docs/architecture/setup-steps.md). Stored once for the organization in the default branch's `company_profile`
 * module; written only through `saveCompanyProfile` (the `company-profile.save` action), read through the
 * `company-profile` provider. Whether a setup step is answered is read from here, never from configuration.
 */
export const COMPANY_PROFILE_MODULE = "company_profile";

const words = z.string().trim().max(120).transform((value) => value.replace(/[<>]/g, ""));
/** A partial answer: a step saves only its own part, and the rest of the profile stays. */
export const companyProfilePatchSchema = z.object({
  company_type: z.string().trim().max(60).optional(),
  company_type_other: words.optional(),
  services: z.array(z.string().trim().max(60)).max(60).optional(),
  services_other: z.array(words).max(20).optional(),
  expected_revision: z.number().int().min(0).optional()
}).strict();
export type CompanyProfilePatch = z.infer<typeof companyProfilePatchSchema>;

export type CompanyProfile = {
  company_type: string | null; company_type_label: string | null; company_type_other: string | null;
  industry: string | null; crm_pack: string | null;
  services: { id: string; label: string; work_kind: string | null }[];
  services_other: string[];
  /** Measurement schema ids of the services picked, for scopes and measurements that bind to a kind of work. */
  work_kinds: string[];
  /** Whether each part has been answered: what setup steps read to know they are satisfied. */
  answered: { type: boolean; services: boolean };
  updated_at: string | null;
  revision: number;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown) => Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];

/** Stored data to the published profile. Unknown ids (an entry removed by hand) are dropped, never shown. */
export function profileFrom(data: Record<string, unknown>, revision = 0, updatedAt: string | null = null): CompanyProfile {
  const typeId = String(data.company_type || "");
  const type = companyType(typeId);
  const other = typeId === OTHER_COMPANY_TYPE ? String(data.company_type_other || "").trim() || null : null;
  const services = [...new Set(strings(data.services))].map(serviceOf).filter((entry) => !!entry).map((entry) => ({ id: entry!.id, label: entry!.label.text, work_kind: entry!.work_kind || null }));
  const servicesOther = [...new Set(strings(data.services_other))].slice(0, 20);
  return {
    company_type: type ? type.id : other ? OTHER_COMPANY_TYPE : null,
    company_type_label: type ? type.label.text : other,
    company_type_other: other,
    industry: type ? type.industry : null,
    crm_pack: type ? type.crm_pack : other ? "general" : null,
    services, services_other: servicesOther,
    work_kinds: [...new Set(services.map((entry) => entry.work_kind as string | null).filter((kind): kind is string => !!kind))],
    answered: { type: !!type || !!other, services: services.length + servicesOther.length > 0 },
    updated_at: updatedAt,
    revision
  };
}

async function stored(orgId: string) {
  try { return await readBranchModule(orgId, "default", COMPANY_PROFILE_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}

export async function readCompanyProfile(orgId: string): Promise<CompanyProfile> {
  const current = await stored(orgId);
  return profileFrom(object(current?.data), Number(current?.revision || 0), current ? String(current.updated_at || "") || null : null);
}

/** Saves one part of the profile. Ids must be in the catalog; "other" needs the person's words. */
export async function saveCompanyProfile(orgId: string, input: unknown, userId: string): Promise<CompanyProfile> {
  const patch = companyProfilePatchSchema.parse(input);
  const current = await stored(orgId);
  const revision = Number(current?.revision || 0);
  if (patch.expected_revision !== undefined && patch.expected_revision !== revision) throw conflict("company_profile_revision", "The company profile changed. Reload and try again.");
  const next: JsonObject = { ...object(current?.data) } as JsonObject;
  if (patch.company_type !== undefined) {
    const id = patch.company_type;
    if (id !== OTHER_COMPANY_TYPE && !companyType(id)) throw badRequest("company_type_unknown", "Choose a kind of company from the list, or Other.");
    if (id === OTHER_COMPANY_TYPE && !patch.company_type_other) throw badRequest("company_type_other_required", "Say what kind of company you are.");
    next.company_type = id;
    next.company_type_other = id === OTHER_COMPANY_TYPE ? patch.company_type_other! : "";
  }
  if (patch.services !== undefined) {
    const unknown = patch.services.filter((id) => !serviceOf(id));
    if (unknown.length) throw badRequest("company_service_unknown", `${unknown.join(", ")} is not a kind of work in the list.`);
    next.services = [...new Set(patch.services)];
  }
  if (patch.services_other !== undefined) next.services_other = [...new Set(patch.services_other.filter(Boolean))];
  next.updated_by = userId;
  const saved = await saveBranchModule(orgId, "default", COMPANY_PROFILE_MODULE, { data: next, expected_revision: revision }, { replace: true });
  return profileFrom(object(saved.data), Number(saved.revision || 0), String(saved.updated_at || "") || null);
}

/** The catalog as published: copy keys with their English, search terms, and each type's suggested services. */
export function publishedCatalog() {
  return {
    company_types: COMPANY_TYPES.map((entry) => ({ id: entry.id, label: entry.label, terms: [...entry.terms], industry: entry.industry, services: [...entry.services] })),
    services: SERVICES.map((entry) => ({ id: entry.id, label: entry.label, terms: [...entry.terms], work_kind: entry.work_kind || null })),
    other: { id: OTHER_COMPANY_TYPE }
  };
}
