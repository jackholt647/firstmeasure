import { z } from "zod";

export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_SNAPSHOT_SCHEMA_VERSION = 1;

export const proposalStatusSchema = z.enum(["draft", "sent", "viewed", "signed", "archived", "void"]);
export const proposalSnapshotReasonSchema = z.enum(["manual", "send", "sign", "pdf", "archive"]);

export const jsonObjectSchema = z.object({}).passthrough();

const idSchema = z.string().trim().min(1).max(160);
const optionalIdSchema = z.string().trim().max(160).optional();

export const proposalMediaReferenceSchema = jsonObjectSchema.extend({
  media_id: z.string().trim().optional(),
  mediaId: z.string().trim().optional(),
  variant: z.string().trim().optional(),
  source: z.enum(["project", "proposal", "snapshot", "external"]).optional(),
  role: z.string().trim().optional(),
  markup_layer_id: z.string().trim().optional(),
  frozen_markup_layer_id: z.string().trim().optional()
}).passthrough();

export const proposalContactSchema = jsonObjectSchema.extend({
  id: z.string().trim().optional(),
  role: z.string().trim().optional(),
  name: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  source: z.string().trim().optional()
}).passthrough();

export const proposalBindingSchema = jsonObjectSchema.extend({
  refresh_until_status: proposalStatusSchema.optional().default("sent"),
  project_fields: z.array(z.string()).optional()
}).passthrough();

export const proposalResourcesSchema = jsonObjectSchema.extend({
  project_photo_refs: z.array(proposalMediaReferenceSchema).optional(),
  proposal_image_refs: z.array(proposalMediaReferenceSchema).optional(),
  pdf_refs: z.array(proposalMediaReferenceSchema).optional(),
  markup_refs: z.array(jsonObjectSchema).optional()
}).passthrough();

export const proposalEditableSchema = jsonObjectSchema.extend({
  schema_version: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  theme: jsonObjectSchema.optional(),
  pages: z.array(jsonObjectSchema).optional(),
  pricing: jsonObjectSchema.optional(),
  measurements: jsonObjectSchema.optional(),
  payment: jsonObjectSchema.optional(),
  signatures: jsonObjectSchema.optional(),
  variables: jsonObjectSchema.optional(),
  resources: proposalResourcesSchema.optional(),
  bindings: proposalBindingSchema.optional()
}).passthrough();

export const proposalDeliverySchema = jsonObjectSchema.extend({
  state: z.enum(["not_sent", "sent", "viewed", "signed", "void"]).optional(),
  send_count: z.number().int().min(0).optional(),
  sent_at: z.string().trim().optional(),
  first_viewed_at: z.string().trim().optional(),
  last_viewed_at: z.string().trim().optional(),
  signed_at: z.string().trim().optional(),
  current_snapshot_id: z.string().trim().optional(),
  current_public_token: z.string().trim().optional(),
  recipients: z.array(proposalContactSchema).optional(),
  include_pdf: z.boolean().optional(),
  include_portal: z.boolean().optional()
}).passthrough();

export const createProposalSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  branch_id: z.string().trim().optional(),
  title: z.string().trim().optional(),
  contacts: z.array(proposalContactSchema).optional(),
  editable: proposalEditableSchema.optional(),
  resources: proposalResourcesSchema.optional(),
  source_proposal: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchProposalSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  status: proposalStatusSchema.optional(),
  contacts: z.array(proposalContactSchema).optional(),
  editable: proposalEditableSchema.optional(),
  resources: proposalResourcesSchema.optional(),
  delivery: proposalDeliverySchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createSnapshotSchema = jsonObjectSchema.extend({
  reason: proposalSnapshotReasonSchema.optional(),
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  html: z.string().optional(),
  document_html: z.string().optional(),
  freeze_markup: z.boolean().optional(),
  generate_pdf: z.boolean().optional(),
  delivery: proposalDeliverySchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const sendProposalSchema = createSnapshotSchema.extend({
  recipients: z.array(proposalContactSchema).optional(),
  include_pdf: z.boolean().optional(),
  include_portal: z.boolean().optional(),
  message: z.string().optional()
}).passthrough();

export const generatePdfSchema = jsonObjectSchema.extend({
  snapshot_id: z.string().trim().optional(),
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  store: z.boolean().optional()
}).passthrough();

export const publicProposalEventSchema = jsonObjectSchema.extend({
  type: z.string().trim().optional(),
  session_id: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const duplicateProposalSchema = jsonObjectSchema.extend({
  title: z.string().trim().optional(),
  project_id: z.string().trim().optional(),
  branch_id: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const archiveProposalSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  reason: z.string().trim().optional(),
  void_public_link: z.boolean().optional()
}).passthrough();

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalEditable = z.infer<typeof proposalEditableSchema>;
export type ProposalDelivery = z.infer<typeof proposalDeliverySchema>;
export type ProposalMediaReference = z.infer<typeof proposalMediaReferenceSchema>;
