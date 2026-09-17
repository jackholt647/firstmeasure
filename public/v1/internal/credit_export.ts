type Row = Record<string, any>;
const object = (v: any): Row => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const money = (v: any): number | null => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)*100)/100 : null;
const first = (...values: any[]) => values.map(money).find(v => v !== null) ?? null;

// Keep one exported row per stored transaction. Never invent a historical
// cash/bonus split when the ledger does not contain enough evidence.
export function creditExportRow(org: Row, entryInput: any, ordinal: number) {
 const e=object(entryInput), m=object(e.meta);
 const delta=first(e.delta,e.amount,e.credit_delta,e.value);
 const reason=String(e.reason ?? e.type ?? e.event ?? '');
 const r=reason.toLowerCase();
 const purchase=['stripe_checkout_paid','stripe_checkout_completed','stripe_payment_succeeded','stripe_manual_fulfill','credit_purchase','credits_purchase','credits_loaded'].includes(r);
 const auto=/auto_?top_?up/.test(r);
 const category=/refund|reversal|reversed/.test(r)||r==='rejection_no_coverage'||r==='order_submit_api_failed'?'refund_or_reversal':auto?'automatic_top_up':purchase?'purchase':/bonus|promo|match|coupon_redeem/.test(r)?'promotional_credit':(delta??0)<0?'charge_or_adjustment':'manual_or_other_credit';
 let paid:number|null=null, bonus:number|null=null, split='not_recorded';
 if (delta!==null && delta>0 && (purchase || auto)) {
  paid=first(m.paid_dollars,m.paidDollars,m.amount_paid_dollars,m.charged_dollars,e.paid_dollars,e.amount_paid_dollars,auto?m.topup_dollars:null);
  bonus=first(m.bonus_dollars,m.bonusDollars,e.bonus_dollars);
  const cents=first(m.amount_total,m.amountTotal,e.amount_total,m.amount_cents);
  if(paid===null && cents!==null && (!m.currency || String(m.currency).toLowerCase()==='usd')) paid=money(cents/100);
  if(paid===null && bonus!==null) paid=money(delta-bonus);
  if(bonus===null && paid!==null) bonus=money(delta-paid);
  if(paid===null && auto){paid=delta;bonus=0;split='automatic_top_up';}
  if(paid!==null && bonus!==null) {
   split=paid>=0 && bonus>=0 && Math.abs(paid+bonus-delta)<0.005 ? 'recorded_or_reconciled' : 'inconsistent_metadata';
  }
 } else if(delta!==null && delta>0 && category==='promotional_credit'){paid=0;bonus=delta;split='promotional_credit';}
 else if((delta!==null && delta<0) || category==='refund_or_reversal') split='not_applicable_to_credit_pool_movement';
 return {
  organization_id:String(org.id),organization_name:String(org.name??org.id),organization_is_test:!!(org.is_test??object(org.metadata).is_test),
  ledger_ordinal:ordinal,transaction_id:e.id??e.transaction_id??'',timestamp:e.ts??e.created_at??e.timestamp??'',
  category,reason,delta_dollars:delta,paid_dollars:paid,bonus_dollars:bonus,paid_bonus_basis:split,
  balance_after_dollars:first(e.balance_after,e.balance),unit:e.unit??'usd_dollars',
  by_email:e.by_email??'',applied_for_user_email:e.applied_for_user_email??'',
  project_id:e.project_id??e.folder??m.project_id??m.folder??'',address:e.address??m.address??'',
  checkout_session_id:m.stripe_checkout_session_id??m.session_id??'',payment_intent_id:m.payment_intent_id??'',
  offer_id:m.offer_id??'',source:m.source??'',note:e.note??m.note??m.notes??'',
 };
}

export function creditExportPage(orgs: Row[], ledgers: Map<string, any[]>, after: string, offset: number, hasMoreOrgs: boolean) {
 const rows:Row[]=[];
 for(const org of orgs){
  const ledger=ledgers.get(String(org.id))??[];
  const start=String(org.id)===after?offset:0;
  for(let i=start;i<ledger.length;i++){
   if(rows.length===500)return {rows,next_cursor:{org_id:String(org.id),offset:i,resume:true},complete:false};
   rows.push(creditExportRow(org,ledger[i],i+1));
  }
 }
 return {rows,next_cursor:hasMoreOrgs?{org_id:String(orgs.at(-1)!.id),offset:0}:null,complete:!hasMoreOrgs};
}
