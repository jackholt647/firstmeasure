import {z} from 'zod';

/** Onboarding requirements of company types and a company's onboarding record: shapes and the pure evaluation (connections/onboarding.ts saves them). */
type Obj=Record<string,unknown>;
const text=(value:unknown)=>String(value??'').trim();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/,'Use a date like 2027-04-30.');
const requirementId=z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);

export const onboardingRequirementSchema=z.object({
  id:requirementId,
  label:z.string().trim().min(1).max(120),
  /** document: a file is uploaded; date: a date is recorded (with expires, the date it lapses); check: someone ticks it. */
  kind:z.enum(['document','date','check']).default('document'),
  /** Whether the item lapses: a document's or a date's expiry decides whether it is current. */
  expires:z.boolean().default(false),
  /** A required item that is missing or expired leaves the company incomplete; an optional one never does. */
  required:z.boolean().default(true)
}).strict();
export const onboardingRequirementsSchema=z.array(onboardingRequirementSchema).max(40).superRefine((list,ctx)=>{
  const seen=new Set<string>();
  list.forEach((item,index)=>{if(seen.has(item.id))ctx.addIssue({code:'custom',path:[index,'id'],message:'Each requirement needs its own id.'});seen.add(item.id);});
});
export type OnboardingRequirement=z.infer<typeof onboardingRequirementSchema>;

const itemSchema=z.object({
  done:z.boolean().optional(),
  /** The recorded date (date requirements), or for one that expires, the date it lapses. */
  date:day.optional(),
  expires_at:day.optional(),
  note:z.string().trim().max(500).optional()
}).strict();
const documentSchema=z.object({
  media_id:z.string().trim().min(1).max(180),
  requirement_id:requirementId.optional(),
  title:z.string().trim().min(1).max(200),
  expires_at:day.optional(),
  uploaded_at:z.string().trim().max(40).optional()
}).strict();
export const onboardingSchema=z.object({
  items:z.record(requirementId,itemSchema).default({}),
  documents:z.array(documentSchema).max(200).default([])
}).strict();
export type Onboarding=z.infer<typeof onboardingSchema>;

export type OnboardingItemStatus='done'|'missing'|'optional'|'expiring'|'expired';
export type OnboardingStatus={state:'complete'|'attention'|'incomplete'|'none';items:Array<{id:string;label:string;status:OnboardingItemStatus;expires_at:string;document_ids:string[]}>};

/** The requirements of a company: those of all its company types, each once. */
export function companyRequirements(types:Array<{id:string;onboarding_requirements?:unknown}>,typeIds:string[]):OnboardingRequirement[]{
  const byId=new Map<string,OnboardingRequirement>();
  for(const type of types.filter(entry=>typeIds.includes(entry.id))){
    const parsed=onboardingRequirementsSchema.safeParse(type.onboarding_requirements||[]);
    if(parsed.success)for(const requirement of parsed.data)if(!byId.has(requirement.id))byId.set(requirement.id,requirement);
  }
  return [...byId.values()];
}

/** Where a company stands on each requirement, on a given day. Expiring is within 30 days. */
export function onboardingStatus(requirements:OnboardingRequirement[],value:unknown,today=new Date().toISOString().slice(0,10)):OnboardingStatus{
  const onboarding=onboardingSchema.safeParse(record(value)).success?onboardingSchema.parse(record(value)):{items:{},documents:[]};
  const soon=new Date(Date.parse(`${today}T00:00:00Z`)+30*86400000).toISOString().slice(0,10);
  const items=requirements.map(requirement=>{
    const item=onboarding.items[requirement.id]||{};
    const documents=onboarding.documents.filter(document=>document.requirement_id===requirement.id);
    const latest=[...documents].sort((a,b)=>text(b.expires_at||b.uploaded_at).localeCompare(text(a.expires_at||a.uploaded_at)))[0];
    const present=requirement.kind==='document'?documents.length>0:requirement.kind==='date'?!!item.date:item.done===true;
    const expiresAt=requirement.expires?text(requirement.kind==='document'?(latest?.expires_at||item.expires_at):(item.expires_at||item.date)):'';
    let status:OnboardingItemStatus=present?'done':requirement.required?'missing':'optional';
    if(present&&requirement.expires&&expiresAt){if(expiresAt<today)status='expired';else if(expiresAt<=soon)status='expiring';}
    if(present&&requirement.expires&&!expiresAt&&requirement.kind==='document')status='expiring';
    return {id:requirement.id,label:requirement.label,status,expires_at:expiresAt,document_ids:documents.map(document=>document.media_id)};
  });
  const state=!requirements.length?'none':items.some(item=>item.status==='missing'||(item.status==='expired'&&requirements.find(r=>r.id===item.id)?.required))?'incomplete':items.some(item=>item.status==='expiring'||item.status==='expired')?'attention':'complete';
  return {state,items};
}

