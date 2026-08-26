import { z } from "zod";

const optionalString = z.string().trim().min(1).optional();

export const codeReportPropertySchema = z.object({
  address: optionalString,
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional()
}).refine((value) => value.address || (value.lat != null && value.lon != null), {
  message: "address or lat/lon is required"
});

export const codeReportRequestSchema = z.object({
  property: codeReportPropertySchema,
  firstmeasure_project_id: optionalString,
  claim_reference: optionalString,
  customer_name: optionalString,
  contractor_name: optionalString,
  roof_covering: z.enum(["asphalt_shingle"]).default("asphalt_shingle"),
  eave_overhang_inches: z.number().min(0).max(48).default(12),
  shingle_product_wind_rating: z.string().trim().min(1).default("ASTM D7158 Class H / ASTM D3161 Class F or better"),
  reference_code: z.enum(["ASCE7-22", "ASCE7-16", "ASCE7-10"]).default("ASCE7-22"),
  risk_category: z.enum(["I", "II", "III", "IV"]).default("II"),
  site_class: z.enum(["A", "B", "C", "D", "E"]).default("D"),
  persist: z.boolean().default(true),
  source_timeout_ms: z.number().int().positive().max(120_000).optional()
});

export type CodeReportRequest = z.infer<typeof codeReportRequestSchema>;
