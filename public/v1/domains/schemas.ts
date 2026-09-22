import { z } from "zod";

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const domainNameSchema = z.string().trim().toLowerCase().max(253).regex(domainPattern, "Enter a valid ASCII domain name.");

export const domainContactSchema = z.object({
  first_name: z.string().trim().min(1).max(64),
  last_name: z.string().trim().min(1).max(64),
  org_name: z.string().trim().max(128).optional().default(""),
  address1: z.string().trim().min(1).max(128),
  address2: z.string().trim().max(128).optional().default(""),
  city: z.string().trim().min(1).max(64),
  state: z.string().trim().min(1).max(64),
  postal_code: z.string().trim().min(1).max(24),
  country: z.string().trim().toUpperCase().length(2),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use an E.164 phone number such as +12065550100."),
  email: z.string().trim().toLowerCase().email().max(254)
});

export const quoteDomainsSchema = z.object({
  domains: z.array(domainNameSchema).min(1).max(20),
  period: z.number().int().min(1).max(10).default(1),
  acquisition_type: z.enum(["register", "transfer"]).optional().default("register")
});

export const registerDomainSchema = z.object({
  quote_id: z.string().trim().min(1).max(128),
  domain: domainNameSchema,
  contact: domainContactSchema,
  accept_price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
  attestation: z.literal(true),
  allow_premium: z.boolean().optional().default(false)
});

export const transferDomainSchema = z.object({
  quote_id: z.string().trim().min(1).max(128),
  domain: domainNameSchema,
  auth_code: z.string().trim().min(1).max(256),
  contact: domainContactSchema,
  accept_price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
  attestation: z.literal(true),
  allow_premium: z.boolean().optional().default(false)
});

export const connectExistingDomainSchema = z.object({
  domain: domainNameSchema,
  attestation: z.literal(true)
});

const emailLocalPartSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, "Use letters, numbers, periods, underscores, or hyphens.");

export const attachDomainResourcesSchema = z.object({
  website: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("existing"), id: z.string().trim().min(1).max(160) }),
    z.object({ mode: z.literal("create"), name: z.string().trim().min(1).max(200) })
  ]),
  default_email_local_part: emailLocalPartSchema.optional(),
  // Accepted temporarily so an already-open onboarding modal can finish after deployment.
  from_email_local_part: emailLocalPartSchema.optional()
}).transform((value) => ({
  website: value.website,
  default_email_local_part: value.default_email_local_part ?? value.from_email_local_part ?? "info"
}));

export const updateDomainManagementSchema = z.object({
  auto_renew: z.boolean().optional(),
  locked: z.boolean().optional(),
  nameservers: z.array(
    z.string().trim().toLowerCase()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a valid nameserver hostname.")
  ).min(2).max(13).optional()
}).refine((value) => value.auto_renew !== undefined || value.locked !== undefined || value.nameservers !== undefined, {
  message: "Choose at least one domain setting to update."
});

export const domainActionConfirmationSchema = z.object({
  attestation: z.literal(true)
});

export type DomainContact = z.infer<typeof domainContactSchema>;
