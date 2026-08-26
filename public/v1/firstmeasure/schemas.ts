import { z } from "zod";

import { PAGE_KEYS } from "./constants.js";

const optionalString = z.string().optional();
const nullableString = z.string().nullable().optional();

export const pageKeySchema = z.enum(PAGE_KEYS);

export const pageConfigSchema = z.object({
  cover_show_prepared_for: z.boolean().optional(),
  cover_show_customer: z.boolean().optional(),
  cover_show_squares: z.boolean().optional(),
  cover_show_waste: z.boolean().optional(),
  cover_show_breakdown: z.boolean().optional(),
  cover_show_pitch: z.boolean().optional(),
  cover_show_facets: z.boolean().optional(),
  page_top_view: z.boolean().optional(),
  page_elevations: z.boolean().optional(),
  page_3d: z.boolean().optional(),
  page_pitch: z.boolean().optional(),
  page_area: z.boolean().optional(),
  page_layers: z.boolean().optional(),
  page_summary: z.boolean().optional(),
  page_materials: z.boolean().optional(),
  page_ventilation: z.boolean().optional(),
  page_gutters: z.boolean().optional(),
  page_notes: z.boolean().optional()
}).partial();

export const brandingVariantSchema = z.object({
  logo_url: optionalString,
  primary_color: optionalString,
  secondary_color: optionalString
}).partial().passthrough();

export const brandingSchema = brandingVariantSchema;

export const actorSchema = z.object({
  id: optionalString,
  email: optionalString,
  name: optionalString,
  drafter_rank: optionalString,
  roles: z.array(z.string()).optional(),
  team_id: optionalString,
  organization_id: optionalString
}).partial();

const personSchema = z.object({
  id: optionalString,
  email: optionalString,
  name: optionalString
}).partial();

const referenceSchema = z.object({
  id: optionalString
}).partial();

const residentSchema = z.object({
  name: optionalString,
  email: optionalString,
  phone: optionalString
}).partial();

const issuerSchema = z.object({
  name: optionalString,
  email: optionalString
}).partial();

const preparedForSchema = z.object({
  name: optionalString,
  company: optionalString,
  address_line_1: nullableString,
  address_line_2: nullableString,
  city: nullableString,
  state: nullableString,
  postal_code: nullableString,
  email: nullableString,
  phone: nullableString
}).partial();

const pinSchema = z.object({
  lat: z.number(),
  lng: z.number()
});

export const createProjectSchema = z.object({
  id: optionalString,
  status: optionalString,
  project_type: z.enum(["residential", "commercial", "multifamily"]).optional(),
  address: z.string().min(1),
  components: z.record(z.unknown()).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  pins: z.array(pinSchema).optional(),
  include_gutter_measurements: z.boolean().optional(),
  include_weather_report: z.boolean().optional(),
  weather_report_tier: optionalString,
  weather_report_id: optionalString,
  weather_report_pdf_url: optionalString,
  radius_meters: z.number().optional(),
  complexity: z.union([z.number(), z.string()]).optional(),
  point_value: z.number().optional(),
  is_custom_pin: z.boolean().optional(),
  is_filler: z.boolean().optional(),
  is_vip: z.boolean().optional(),
  is_expedited: z.boolean().optional(),
  report_expedite_option: optionalString,
  report_expedite_label: optionalString,
  report_due_window_start: optionalString,
  report_due_window_end: optionalString,
  report_due_window_label: optionalString,
  report_production_deadline_at: optionalString,
  report_release_hold_enabled: z.boolean().nullable().optional(),
  instant_enabled: z.boolean().optional(),
  instant_only: z.boolean().optional(),
  owner_ref: personSchema.optional(),
  organization_ref: referenceSchema.optional(),
  team_ref: referenceSchema.optional(),
  resident: residentSchema.optional(),
  issuer: issuerSchema.optional(),
  cc_emails: z.array(z.string()).optional(),
  tech_notes: z.string().nullable().optional(),
  amount_charged: z.number().optional(),
  branding_defaults: brandingSchema.optional(),
  actor: actorSchema.optional()
}).passthrough();

export const patchProjectSchema = z.record(z.unknown());

export const projectsQuerySchema = z.object({
  search: optionalString,
  statuses: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  owner_email: optionalString,
  organization_id: optionalString,
  team_id: optionalString,
  project_type: optionalString,
  has_report_pdf: z.boolean().optional(),
  include_instant_only: z.boolean().optional(),
  activity_start: optionalString,
  activity_end: optionalString,
  activity_fields: z.array(z.enum(["created", "queued", "started", "uploaded", "completed", "rejected", "cancelled", "updated"])).optional(),
  include_all: z.boolean().optional()
}).partial();

export const orderInstantSchema = createProjectSchema.extend({
  process_async: z.boolean().optional()
}).passthrough();

export const statusUpdateSchema = z.object({
  status: z.string().min(1),
  pdf_sync_job_id: optionalString,
  pdf_sync_revision: optionalString,
  actor: actorSchema.optional()
});

export const jsonDocumentSchema = z.record(z.unknown()).or(z.array(z.unknown())).or(z.string()).or(z.number()).or(z.boolean()).or(z.null());

export const artifactJsonUploadSchema = z.object({
  file_name: z.string().min(1),
  content_base64: z.string().optional(),
  content_text: z.string().optional(),
  content_type: optionalString
}).refine((value) => value.content_base64 || value.content_text !== undefined, {
  message: "content_base64 or content_text is required"
});

export const pageRequestSchema = z.object({
  key: pageKeySchema,
  page_number: z.number().int().positive().optional(),
  show_page_number: z.boolean().optional()
});

export const renderReportSchema = z.object({
  page_config: pageConfigSchema.optional(),
  branding: brandingSchema.optional(),
  prepared_for: preparedForSchema.optional(),
  pages: z.array(pageRequestSchema).optional(),
  page: pageRequestSchema.optional(),
  output_slot: z.enum(["main", "summary"]).optional(),
  persist_files: z.boolean().optional(),
  update_status: z.boolean().optional(),
  actor: actorSchema.optional()
}).passthrough();

export const instantPdfRenderSchema = z.object({
  branding: brandingSchema.optional(),
  prepared_for: preparedForSchema.optional(),
  show_prepared_for: z.boolean().optional(),
  file_name: optionalString,
  actor: actorSchema.optional()
}).passthrough();

export const pdfOutputSchema = z.object({
  slot: z.enum(["main", "summary"]).optional(),
  mode: z.enum(["full", "summary"]).optional(),
  file_name: optionalString,
  cover_title: optionalString,
  page_config: pageConfigSchema.optional(),
  branding: brandingSchema.optional(),
  prepared_for: preparedForSchema.optional(),
  apply_branding_to_full: z.boolean().optional(),
  use_project_organization_branding: z.boolean().optional(),
  clear_branding_overrides: z.boolean().optional(),
  persist: z.boolean().optional(),
  update_status: z.boolean().optional(),
  snapshot_patch: jsonDocumentSchema.optional(),
  pdf_config_patch: pageConfigSchema.optional()
}).passthrough();

export const pdfBatchSchema = z.object({
  source: z.enum(["saved", "inline"]).optional(),
  snapshot: jsonDocumentSchema.optional(),
  persist_files: z.boolean().optional(),
  update_status: z.boolean().optional(),
  outputs: z.array(pdfOutputSchema).optional(),
  actor: actorSchema.optional()
}).passthrough();

export const xmlAssembleSchema = z.object({
  source: optionalString,
  format: optionalString,
  options: z.record(z.unknown()).optional(),
  persist_files: z.boolean().optional(),
  actor: actorSchema.optional()
}).passthrough();

export const queueActorSchema = actorSchema.refine((value) => Boolean(value.email || value.id), {
  message: "actor.email or actor.id is required"
});

export const queueStatusSchema = z.object({
  actor: queueActorSchema,
  queue_mode: z.enum(["disabled", "all", "new_only", "corrections_only"]).optional()
}).passthrough();

export const queueClaimNextSchema = z.object({
  actor: queueActorSchema,
  queue_mode: z.enum(["disabled", "all", "new_only", "corrections_only"]).optional(),
  allow_reserved: z.boolean().optional(),
  allow_filler: z.boolean().optional(),
  preferred_complexity: z.array(z.union([z.number(), z.string()])).optional(),
  team_id: optionalString
}).passthrough();

export const queueReserveSchema = z.object({
  actor: queueActorSchema.optional(),
  reserved_for: queueActorSchema,
  notes: nullableString
}).passthrough();

export const queueReleaseSchema = z.object({
  actor: queueActorSchema.optional(),
  notes: nullableString
}).passthrough();

export const queueOverviewSchema = z.object({
  statuses: z.array(z.string()).optional(),
  team_id: optionalString,
  include_completed: z.boolean().optional()
}).passthrough();

export const appleKeySetSchema = z.object({
  key: optionalString,
  url: optionalString,
  tile_version: z.coerce.number().int().positive().max(999999999).optional(),
  actor: actorSchema.optional()
}).refine((value) => Boolean(value.key || value.url || value.tile_version), {
  message: "key, url, or tile_version is required"
});
