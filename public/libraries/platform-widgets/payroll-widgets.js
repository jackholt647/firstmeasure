/* Payroll leaf views shared by the payroll workspace, agents and dashboards. */
(function(global){
 'use strict';
 const views=['upcoming','timesheets','contractors','exports','history','settings'];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=(v,c='USD')=>{try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c}).format(Number(v||0)/100);}catch{return `${Number(v||0)/100} ${c}`;}};
 for(const view of views)global.FirstMateWidgets.attachRenderer('payroll.'+view,'1',async(root,{config,context,reference,state,visible})=>{
   if(!global.FirstMatePayroll?.mountView)throw Error('The payroll view bundle is unavailable.');
   const instance=global.FirstMatePayroll.mountView({...context,root,roots:{main:root},orgId:reference.target.organizationId,instanceId:'payroll-widget-'+global.crypto.randomUUID(),params:{...state,...config,standalone:view,widget:true}});
   instance.setActive?.(visible);
   const updated=()=>{if(visible)instance.refresh?.();};global.addEventListener('fm:payroll:updated',updated);
   return {setVisible(value){visible=value;instance.setActive?.(value);},serialize(){return instance.serialize?.()||{};},destroy(){global.removeEventListener('fm:payroll:updated',updated);instance.destroy();}};
 });
 const extra={ledger:'records',commissions:'records',earnings:'earnings',my_earnings:'my_earnings',project_payees:'project_payees',batch:'batch'};
 for(const [name,exportName]of Object.entries(extra))global.FirstMateWidgets.attachRenderer('payroll.'+name,'1',(root,{config,reference,state,visible})=>{
   let alive=true,generation=0,rows=[],search=state.search||'';
   const source={provider:'payroll',export:exportName,target:{...reference.target},args:{...(config.from?{from:config.from}:{}),...(config.through?{through:config.through}:{}),...(config.include_projected!==undefined?{include_projected:config.include_projected}:{})}};
   if(name==='commissions')source.args.kind='commission';
   if(name==='batch')source.target.id=config.batch_id;
   if(name==='earnings')source.args.payees=config.payee_id?[{type:config.payee_type||'organization_user',id:config.payee_id}]:[];
   root.innerHTML=`<section style="border:1px solid #e4e7ec;border-radius:12px;padding:16px;min-width:0" aria-label="Payroll ${esc(name.replaceAll('_',' '))}"><header style="display:flex;align-items:center;gap:12px"><strong style="flex:1">${esc(name==='my_earnings'?'My earnings':name==='project_payees'?'Project payees':name[0].toUpperCase()+name.slice(1).replaceAll('_',' '))}</strong><button type="button" data-refresh aria-label="Refresh payroll">↻</button></header><input type="search" aria-label="Search payroll" placeholder="Search" value="${esc(search)}" style="width:100%;margin:12px 0;padding:8px;border:1px solid #d0d5dd;border-radius:8px"><div data-status role="status"></div><div data-rows style="overflow:auto"></div></section>`;
   const status=root.querySelector('[data-status]'),body=root.querySelector('[data-rows]'),input=root.querySelector('input');
   function table(headers,values){return `<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr>${headers.map(h=>`<th style="text-align:left;padding:8px;border-bottom:1px solid #e4e7ec">${esc(h)}</th>`).join('')}</tr></thead><tbody>${values.map(row=>`<tr>${row.map(v=>`<td style="padding:8px;border-bottom:1px solid #f2f4f7">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
   function draw(){const shown=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(search.toLowerCase()));
    if(name==='earnings'||name==='my_earnings')body.innerHTML=shown.map(r=>`<article style="margin:12px 0"><strong>${esc(r.subject?.name||r.subject?.id)}</strong>${table(['Projected','Owed','In payroll','Paid'],[[money(r.totals.projected_cents,r.currency),money(r.totals.owed_cents,r.currency),money(r.totals.in_payroll_cents,r.currency),money(r.totals.paid_cents,r.currency)]])}${table(['Project','Projected','Owed','Paid'],r.projects.map(p=>[p.title,money(p.totals.projected_cents,p.currency),money(p.totals.owed_cents,p.currency),money(p.totals.paid_cents,p.currency)]))}${table(['Pay date','Status','Amount'],r.payments.map(p=>[p.pay_date,p.status,money(p.amount_cents,p.currency)]))}</article>`).join('');
    else if(name==='project_payees')body.innerHTML=table(['Role','Recipients'],shown.map(r=>[r.label||r.role_key,r.payees.map(p=>p.name||p.id).join(', ')]));
    else if(name==='batch')body.innerHTML=table(['Payee','Status','Gross','Deduction','Net','Reference'],shown.map(r=>[r.payee.name||r.payee.id,r.status,money(r.gross_cents,r.currency),money(r.deduction_cents,r.currency),money(r.net_cents,r.currency),r.payment_reference]));
    else body.innerHTML=table(['Payee','Project','Kind','State','Amount','Remaining','Eligible'],shown.map(r=>[r.payee.name||r.payee.id,r.project_title||r.project_id,r.kind,r.state,money(r.amount_cents,r.currency),money(r.remaining_cents,r.currency),r.eligible_at]));
    if(!shown.length)body.textContent='No matching payroll records.';
   }
   async function refresh(){const token=++generation;status.textContent='Loading…';try{
    if(name==='earnings'&&!config.payee_id)throw Error('Choose a payee_id to display earnings.');if(name==='batch'&&!config.batch_id)throw Error('Choose a batch_id to display the run.');
    const result=await global.PlatformAPI.publication.read(reference.target.organizationId,source);if(!alive||token!==generation)return;
    if(result.status!=='ready')throw Error(result.message||'Payroll is unavailable.');
    const value=result.value;rows=(name==='earnings'||name==='my_earnings')?value.earnings:name==='batch'?value.items.map(item=>({...item,currency:value.currency})):value;
    status.textContent=value.truncated?'Showing a limited report. Narrow the dates to review all earnings.':result.provenance?.possiblyTruncated?'Showing a limited ledger. Use the published list operation for all rows.':'';draw();
   }catch(error){if(alive&&token===generation){rows=[];body.replaceChildren();status.textContent=error.message||'Payroll is unavailable.';}}}
   input.oninput=()=>{search=input.value;draw();};root.querySelector('[data-refresh]').onclick=refresh;
   const updated=()=>{if(visible)void refresh();};global.addEventListener('fm:payroll:updated',updated);const timer=setInterval(()=>{if(visible&&!document.hidden)void refresh();},30000);void refresh();
   return {setVisible(value){const previous=visible;visible=value;if(value&&!previous)void refresh();},serialize(){return {search};},destroy(){alive=false;generation++;clearInterval(timer);global.removeEventListener('fm:payroll:updated',updated);root.replaceChildren();}};
 });
})(window);
