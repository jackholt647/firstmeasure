import { z } from "zod";
export const meters = [
  { id:"sms.outbound_segments", label:"Outgoing SMS segments", unit:"segments", aggregation:"sum" },
  { id:"sms.inbound_segments", label:"Incoming SMS segments", unit:"segments", aggregation:"sum" },
  { id:"agents.runs", label:"Agent runs", unit:"runs", aggregation:"sum" },
  { id:"agents.input_tokens", label:"Agent input tokens", unit:"tokens", aggregation:"sum" },
  { id:"agents.output_tokens", label:"Agent output tokens", unit:"tokens", aggregation:"sum" },
  { id:"chat.input_tokens", label:"Live chat input tokens", unit:"tokens", aggregation:"sum" },
  { id:"chat.output_tokens", label:"Live chat output tokens", unit:"tokens", aggregation:"sum" },
  { id:"storage.bytes", label:"Average stored media", unit:"bytes / month", aggregation:"gauge" }
] as const;
const integer = z.number().int().min(0).max(1_000_000_000_000);
export const rateSchema = z.object({ meter:z.enum(meters.map(m => m.id) as [string,...string[]]), included:integer.default(0), unit_quantity:integer.min(1).default(1), unit_price_micros:integer.default(0) }).strict();
export const priceSchema = z.object({
  product_id:z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/), name:z.string().trim().min(1).max(100),
  plan_key:z.string().regex(/^[a-z0-9_-]{1,40}$/).default("default"),
  highlights:z.array(z.string().trim().min(1).max(240)).max(12).default([]),
  allowances:z.object({sms_messages:integer.optional(),storage_bytes:z.number().int().min(0).max(1_000_000_000_000_000).optional()}).strict().default({}),
  placeholder:z.boolean().default(false),
  description:z.string().trim().max(1000).default(""), capability_key:z.string().max(120),
  monthly_cents:integer.max(100_000_000).default(0), currency:z.literal("USD").default("USD"),
  rates:z.array(rateSchema).max(12).default([]), require_subscription:z.boolean().default(true)
}).strict();
export type Price = z.infer<typeof priceSchema> & { id:string; version:number; published:boolean; created_at:string; actor:string };
export type Subscription = { id:string; product_id:string; price:Price; starts_at:string; ends_at:string|null; actor:string; request_key:string;
  stripe_subscription_id?:string; stripe_item_id?:string; paid_through?:string; period_start?:string; payment_status?:string };
export type Account = { enforce:boolean; automatic_collection?:boolean; created_at:string; updated_at:string; actor:string };
export type Line = { subscription_id:string; product_id:string; price_id:string; label:string; meter:string|null; quantity:string; included:number; amount_cents:number };
export type Invoice = { id:string; period:string; currency:"USD"; lines:Line[]; total_cents:number; status:"open"|"paid"|"void"; created_at:string; actor:string; payment_id?:string; checkout_id?:string; checkout_url?:string; paid_at?:string; amount_paid_cents?:number; amount_remaining_cents?:number };
export function monthBounds(month:string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Use a YYYY-MM billing period.");
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
  return { start:start.toISOString(), end:end.toISOString(), milliseconds:end.getTime()-start.getTime() };
}
export function roundRatio(n:bigint, d:bigint) { return Number((n + d/2n)/d); }
