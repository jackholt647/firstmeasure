import contract from './terminology-contract.json' with { type: 'json' };

export type TerminologyMappings = { labels?: Record<string, Record<string, string>>; localized_labels?: Record<string, Record<string, Record<string, string>>> };
export const terminologyContract = contract;
const namespaces: Record<string, string> = { 'project-request':'projects', 'project-map':'projects', 'project-schedule':'scheduling', 'platform-scheduling':'scheduling', 'platform-schedule-view':'scheduling', 'customer-portal':'customer_portal', documents:'document_engine', docs:'documents', 'calls-runtime':'calls', measurements:'reports', firstmeasure:'reports', 'doc-editor':'document_engine', 'doc-renderer':'document_engine', 'doc-widgets':'document_engine', 'doc-workflow':'document_engine' };
const shared = new Set(['projects.project','projects.projects','contacts.contact','contacts.contacts','contacts.customer','contacts.customers','contacts.homeowner','contacts.homeowners','workforce.resource_group_singular','workforce.resource_group_plural','workforce.worker_singular','workforce.worker_plural','workforce.organization_connection_singular','workforce.organization_connection_plural','proposals.proposal','proposals.proposals','documents.document','documents.documents','photos.photo','photos.photos','receipts.receipt','receipts.receipts','money.invoice','money.invoices','equipment.equipment','materials.material','materials.materials','work.phase','work.phases','work.stage','work.stages','work.task','work.tasks','work.board','work.boards']);
const aliases: Record<string,string> = { 'crew.crew_member':'workforce.worker_singular', 'crew.crew_members':'workforce.worker_plural', 'scope.phase':'work.phase', 'scope.phases':'work.phases', 'projects.stage':'work.stage' };
// Cross-app business concepts. Ambiguous words (unit, item, status, owner,
// template, source…) deliberately remain within their owning namespace.
for(const key of ['reports.report','reports.reports','reports.measurement','scope.scope','scope.scope_item','scope.scope_items','materials.material_list','materials.material_lists','checklists.checklist','checklists.checklists','checklists.checklist_item','checklists.checklist_items','change_orders.change_order','change_orders.change_orders','contacts.primary_contact','photos.album','photos.albums','proposals.signature','customer_portal.customer_portal','payroll.payroll_batch','money.collected_payment','money.collected_payments','money.scheduled_payment','money.scheduled_payments','money.expense','money.expenses','money.expense_list','money.expense_lists','money.commission_payment','money.commission_payments','scheduling.appointment','scheduling.visit','scheduling.shift','scheduling.assignment','calls.call','calls.calls','canvassing.lead','canvassing.leads'])shared.add(key);
export function canonicalTerm(key:string) {
  if(aliases[key])return aliases[key];
  const entry=contract[key as keyof typeof contract];
  if(entry?.kind==='entity')for(const sharedKey of shared)if(contract[sharedKey as keyof typeof contract]?.label===entry.label)return sharedKey;
  return key;
}
const read = (labels: TerminologyMappings['labels'], key:string) => { const dot=key.indexOf('.'); return labels?.[key.slice(0,dot)]?.[key.slice(dot+1)]; };
const entries = Object.entries(contract) as [string,{label:string;kind:string}][];
const defaults = new Map(entries.map(([key,value])=>[key,value.label]));
const relatedKeys=new Map<string,string[]>();
for(const [key] of entries){const canonical=canonicalTerm(key);relatedKeys.set(canonical,[...(relatedKeys.get(canonical)||[]),key]);}
export function terminologyOverride(key:string, locale:string, mappings:TerminologyMappings) {
  const canonical=canonicalTerm(key);
  const related=[canonical,key,...(relatedKeys.get(canonical)||[])];
  // Empty is an explicit reset: ignore a legacy override and use the pack default.
  for(const candidate of related){
    const localized=read(mappings.localized_labels?.[locale],candidate);
    if(localized!==undefined)return localized===defaults.get(candidate)?'':localized;
  }
  if(locale.startsWith('en-')) {
    for(const candidate of related){
      const legacy=read(mappings.labels,candidate);
      if(legacy!==undefined&&legacy!==defaults.get(candidate))return legacy;
    }
  }
  return undefined;
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Compose source-owned message literals only, before ICU values are inserted.
 * Never run this on rendered DOM, user data, IDs, HTML or a formatted message.
 * Locale spellings come from that locale's terminology pack, not English regexes.
 */
export function terminologyComposer(namespace:string, locale:string, mappings:TerminologyMappings, translated:(key:string,fallback:string)=>string, html=false) {
  const local=namespaces[namespace]||namespace;
  const candidates=new Map<string,{key:string;replacement:string;whole:boolean}>();
  for(const [raw,entry] of entries) {
    const key=canonicalTerm(raw);
    if(!(shared.has(key)||raw.startsWith(local+'.')))continue;
    if(entry.kind==='navigation'||entry.kind==='action')continue;
    const override=terminologyOverride(key,locale,mappings);
    if(!override)continue;
    const original=translated(raw,entry.label);
    if(original===override)continue;
    // The first canonical declaration wins duplicate wording in one domain.
    if(!candidates.has(original.toLocaleLowerCase(locale)))candidates.set(original.toLocaleLowerCase(locale),{key,replacement:override,whole:entry.kind!=='entity'});
  }
  if(!candidates.size)return (value:string)=>value;
  const pattern=new RegExp('(?<![\\p{L}\\p{N}_])'+(locale.startsWith('en-')?'(?:(a|an)(\\s+))?':'()()')+'('+[...candidates.keys()].sort((a,b)=>b.length-a.length).map(escapePattern).join('|')+')(?![\\p{L}\\p{N}_])','giu');
  return (value:string)=>value.replace(pattern,(full,article:string|undefined,space:string|undefined,match:string)=>{
    const candidate=candidates.get(match.toLocaleLowerCase(locale))!;
    if(candidate.whole && value.trim()!==match)return full;
    let replacement=candidate.replacement;
    if(match===match.toLocaleLowerCase(locale))replacement=replacement.toLocaleLowerCase(locale);
    else if(match===match.toLocaleUpperCase(locale))replacement=replacement.toLocaleUpperCase(locale);
    let prefix='';
    if(article){
      const vowel=/^(?:[aeiou]|honest|honou?r|hour)/i.test(replacement)&&! /^(?:uni(?:t|on|form|vers)|user|use|euro|one\b)/i.test(replacement);
      prefix=vowel?'an':'a';if(article[0]===article[0]?.toUpperCase())prefix=prefix[0]!.toUpperCase()+prefix.slice(1);prefix+=space;
    }
    return prefix+(html?escapeHtml(replacement):replacement);
  });
}
