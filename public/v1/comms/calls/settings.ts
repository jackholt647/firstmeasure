import { z } from "zod";
import { badRequest, conflict } from "../../platform/errors.js";
import { resource, saveResource, text, object, resources, type Json } from "./storage.js";

const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const voiceSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  timezone:z.string().max(100).default("America/Los_Angeles").refine(v=>{try{new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}},"Choose a valid timezone"),
  business_hours:z.array(z.object({day:z.number().int().min(0).max(6),open:time,close:time})).max(14).default([1,2,3,4,5].map(day=>({day,open:"08:00",close:"17:00"}))),
  holidays:z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]),
  routing:z.enum(["longest_idle","sequential"]).default("longest_idle"),
  agent_user_ids:z.array(z.string().min(1).max(180)).max(100).default([]),
  greeting:z.string().max(1500).default("Thank you for calling. Please hold while we connect you."),
  voicemail_greeting:z.string().max(1500).default("We are unavailable right now. Please leave your name, number, and a message after the tone."),
  fallback:z.enum(["voicemail","forward"]).default("voicemail"),
  overflow_number:z.string().max(30).default(""),
  max_wait_seconds:z.number().int().min(10).max(600).default(60),
  ring_seconds:z.number().int().min(10).max(60).default(25),
  wrap_up_seconds:z.number().int().min(0).max(300).default(30),
  max_concurrent_calls:z.number().int().min(1).max(25).default(3),
  max_call_minutes:z.number().int().min(1).max(180).default(60),
  daily_call_limit:z.number().int().min(1).max(10000).default(250),
  daily_spend_limit:z.string().regex(/^\d{1,4}\.\d{2}$/).default("25.00"),
  allowed_country_prefixes:z.array(z.string().regex(/^\+[1-9]\d{0,3}$/)).min(1).max(30).default(["+1"]),
  allowed_destination_countries:z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(30).default(["US","CA"]),
  recording_enabled:z.boolean().default(false),
  transcription_enabled:z.boolean().default(false),
  recording_retention_days:z.number().int().min(1).max(365).default(30),
  disclosure:z.string().max(1500).default("With your permission, we would like to record and transcribe this call to keep accurate notes. Is that okay?"),
  emergency_policy_confirmed:z.boolean().default(false),
  service_location:z.string().max(1000).default(""),
  recording_policy_confirmed:z.boolean().default(false),
  ai_summaries_enabled:z.boolean().default(false),
  revision:z.number().int().min(0).optional()
});
export type VoiceSettings=z.infer<typeof voiceSettingsSchema>;
export async function voiceSettings(orgId:string):Promise<VoiceSettings>{return voiceSettingsSchema.parse((await resource(orgId,"settings"))||{});}
export async function updateVoiceSettings(orgId:string,input:unknown){
  const settings=(await validateVoiceSettings(orgId,input));
  return (await saveResource(orgId,"settings","default",settings,"",settings.revision));
}
export async function validateVoiceSettings(orgId:string,input:unknown){
  const settings=voiceSettingsSchema.parse(input);
  if(settings.enabled&&(!settings.emergency_policy_confirmed||!settings.service_location.trim()))throw badRequest("service_setup_required","Complete the service location and emergency calling setup before activating voice.");
  if((settings.recording_enabled||settings.transcription_enabled)&&!settings.recording_policy_confirmed)throw badRequest("recording_policy_required","Configure and confirm your recording consent policy before enabling capture.");
  if(settings.transcription_enabled&&!settings.recording_enabled)throw badRequest("recording_required","Enable consent-controlled recording before enabling call transcription.");
  if(settings.fallback==="forward"&&!/^\+[1-9]\d{7,14}$/.test(settings.overflow_number))throw badRequest("overflow_number_required","Enter a valid international overflow number.");
  if(settings.business_hours.some(h=>h.close<=h.open))throw badRequest("business_hours_invalid","Each business-hours interval must close after it opens. Split overnight intervals across two days.");
  if(settings.enabled&&!(await resources(orgId,"number")).some(n=>n.status==="active"))throw conflict("voice_number_required","Connect and verify a business number before activating voice.");
  if(settings.fallback==='forward'&&!settings.allowed_country_prefixes.some(prefix=>settings.overflow_number.startsWith(prefix)))throw badRequest('overflow_destination_forbidden','The forwarding number must be in an allowed calling region.');
  if(settings.fallback==='forward'&&(await resources(orgId,'number')).some(number=>number.phone_number===settings.overflow_number))throw badRequest('overflow_route_loop','Choose an external forwarding number, not a FirstMate business line.');
  return settings;
}
export function businessOpen(settings:VoiceSettings,date=new Date()) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:settings.timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(date);
  const p=Object.fromEntries(parts.map(v=>[v.type,v.value]));
  if(settings.holidays.includes(`${p.year}-${p.month}-${p.day}`))return false;
  const weekday=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday||"");
  const local=`${p.hour}:${p.minute}`;
  return settings.business_hours.some(h=>h.day===weekday&&local>=h.open&&local<h.close);
}
export function normalizePhone(value:unknown) {
  const raw=text(value);const compact=raw.replace(/[\s().-]/g,"");
  if(/^\+[1-9]\d{7,14}$/.test(compact))return compact;
  if(/^\d{10}$/.test(compact))return `+1${compact}`;
  if(/^1\d{10}$/.test(compact))return `+${compact}`;
  throw badRequest("phone_invalid","Enter a valid phone number with its country code.");
}
export function diagnosticVerdict(input:Json){
  const permission=text(input.microphone);const ice=text(input.connectivity);const provider=text(input.provider_verdict);
  if(permission==="denied"||provider==="permission_denied")return {verdict:"blocked",reason:"Microphone permission is required."};
  if(permission!=="ready"||ice!=="ready"||["blocked","inconclusive"].includes(provider))return {verdict:"blocked",reason:"Complete the microphone and network checks before calling."};
  const metrics=object(input.metrics);const rtt=Number(metrics.rtt_ms),jitter=Number(metrics.jitter_ms),loss=Number(metrics.packet_loss_percent);
  if(![rtt,jitter,loss].every(n=>Number.isFinite(n)&&n>=0))return {verdict:"inconclusive",reason:"The network test did not return enough measurements. Retry the test."};
  if(rtt>400||jitter>50||loss>3)return {verdict:"blocked",reason:"Your network may not carry a reliable call. Retry or use your external phone."};
  if(rtt>=200||jitter>=30||loss>=1||provider==="degraded")return {verdict:"degraded",reason:"Audio may be unstable. A wired connection or headset may help."};
  return {verdict:"ready",reason:"Microphone and network checks passed."};
}
