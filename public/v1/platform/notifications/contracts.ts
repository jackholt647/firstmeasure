import { z } from 'zod';
export const methods = ['in_app','push','email','sms','celebration','toast','audio','customer_portal'] as const;
export type Method = typeof methods[number];
export const methodSchema = z.enum(methods);
export const decisionSchema = z.object({ decision:z.enum(['send','suppress','defer']), until:z.string().datetime().optional(), bypass_quiet:z.boolean().optional() }).strict();
export type Decision = z.infer<typeof decisionSchema>;
export type Plan = Partial<Record<Method,Decision>>;
export const filterSchema = z.object({ path:z.string().regex(/^[a-zA-Z0-9_.]+$/).max(160), op:z.enum(['eq','in','contains','gt','gte','lt','lte']), value:z.union([z.string().max(500),z.number().finite(),z.boolean(),z.array(z.string().max(100)).max(50)]) }).strict();
export const bindingSchema = z.object({
  source:z.object({provider:z.string().max(100),export:z.string().max(100),target:z.object({scope:z.enum(['global','organization','project']),organizationId:z.string().optional(),projectId:z.string().optional(),branchId:z.string().optional(),id:z.string().optional()}).strict(),args:z.record(z.unknown()).optional(),path:z.string().optional(),version:z.string().optional()}).strict(),
  type:z.enum(['number','string','boolean','object','array']), required:z.literal(true).default(true)
}).strict();
export const ruleSchema = z.object({
  id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), revision:z.number().int().nonnegative().default(0), enabled:z.boolean().default(true),
  priority:z.number().int().min(0).max(1000).default(100),
  intent:z.string().min(1).max(8000), event:z.string().min(1).max(120), filters:z.array(filterSchema).max(20).default([]),
  notification_key:z.string().max(150).optional(), scope_template_id:z.string().max(150).optional(),
  source:z.string().min(1).max(32000), bindings:z.record(bindingSchema).default({}),
  exports:z.record(z.enum(['number','string','boolean','object','array'])).default({}),
  methods:z.array(methodSchema).min(1).max(8), bypass_quiet:z.boolean().default(false),
  quiet_exempt_methods:z.array(methodSchema).max(8).default([]),
  subscribe:z.boolean().default(false), title:z.string().max(140).default('Notification'), body:z.string().max(1000).default(''),
  group:z.object({path:z.string().regex(/^[a-zA-Z0-9_.]+$/), alert:z.enum(['every','first','digest']), window_seconds:z.number().int().min(1).max(86400)}).strict().optional()
}).strict();
export type NotificationRule = z.infer<typeof ruleSchema>;
export const quietSchema=z.object({enabled:z.boolean(),timezone:z.string().max(100),start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),methods:z.array(methodSchema).max(8)}).strict();
export type QuietHours=z.infer<typeof quietSchema>;
export function atPath(value:unknown,path:string):unknown { return path.split('.').reduce<unknown>((v,k)=>v && typeof v==='object' && !['__proto__','constructor','prototype'].includes(k) && Object.hasOwn(v,k) ? (v as Record<string,unknown>)[k] : undefined,value); }
export function matchesFilters(filters:NotificationRule['filters'],event:Record<string,unknown>):boolean {
  return filters.every(f=>{const actual=atPath(event,f.path);switch(f.op){
    case 'eq':return actual===f.value;
    case 'contains':return Array.isArray(actual)&&actual.includes(f.value);
    case 'in':return Array.isArray(f.value)&&f.value.includes(actual as string);
    case 'gt':return typeof actual==='number'&&typeof f.value==='number'&&actual>f.value;
    case 'gte':return typeof actual==='number'&&typeof f.value==='number'&&actual>=f.value;
    case 'lt':return typeof actual==='number'&&typeof f.value==='number'&&actual<f.value;
    case 'lte':return typeof actual==='number'&&typeof f.value==='number'&&actual<=f.value;
  }});
}
/** UTC minute search respects overnight windows and DST without inventing wall-clock offsets. */
export function quietUntil(q:QuietHours|undefined,now=new Date()):string|undefined {
  if(!q?.enabled || q.start===q.end)return;
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:q.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const inside=(date:Date)=>{const t=formatter.format(date);return q.start<q.end?t>=q.start&&t<q.end:t>=q.start||t<q.end;};
  if(!inside(now))return;
  for(let i=1;i<=1500;i++){const next=new Date(Math.floor(now.getTime()/60000)*60000+i*60000);if(!inside(next))return next.toISOString();}
  throw Error('Quiet hours could not be resolved');
}
