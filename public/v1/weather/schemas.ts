import { z } from "zod";

export const weatherTierSchema = z.enum(["history", "reviewed", "complex", "comprehensive"]);

const optionalString = z.string().trim().min(1).optional();

export const propertySchema = z.object({
  address: optionalString,
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional()
}).refine((value) => value.address || (value.lat != null && value.lon != null), {
  message: "address or lat/lon is required"
});

export const weatherReportRequestSchema = z.object({
  tier: weatherTierSchema.default("history"),
  property: propertySchema,
  claim_reference: optionalString,
  customer_name: optionalString,
  date_of_loss: optionalString,
  start_date: optionalString,
  end_date: optionalString,
  peril: z.enum(["hail", "wind", "tornado", "all"]).default("hail"),
  radius_miles: z.number().positive().max(50).optional(),
  persist: z.boolean().default(true),
  include_ai_summary: z.boolean().default(false),
  source_timeout_ms: z.number().int().positive().max(120_000).optional()
}).refine((value) => {
  if (value.tier === "history" || value.tier === "comprehensive") return true;
  return Boolean(value.date_of_loss);
}, {
  message: "reviewed/complex require date_of_loss"
});

export const weatherDataRequestSchema = z.object({
  property: propertySchema,
  start_date: z.string().trim().min(1),
  end_date: z.string().trim().min(1),
  radius_miles: z.number().positive().max(50).default(10),
  datasets: z.array(z.enum(["nx3hail", "plsr", "warn", "nx3structure", "nx3meso", "nx3tvs", "iem_lsr", "iem_warning"])).default(["nx3hail", "plsr", "warn", "iem_lsr", "iem_warning"]),
  source_timeout_ms: z.number().int().positive().max(120_000).optional()
});

export type WeatherTier = z.infer<typeof weatherTierSchema>;
export type WeatherReportRequest = z.infer<typeof weatherReportRequestSchema>;
export type WeatherDataRequest = z.infer<typeof weatherDataRequestSchema>;
