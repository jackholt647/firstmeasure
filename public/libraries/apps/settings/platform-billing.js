(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=c=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(c)/100);
  const date=v=>v?new Date(v).toLocaleString():'—';
  const priceText=p=>`${money(p.monthly_cents)} / month${p.rates.length?' + usage':''}`;
  const apiFor=org=>(path='',method='GET',body)=>root.PlatformAPI.request(`${root.PlatformAPI.baseUrl().replace(/\/platform\/?$/,'/platform-billing')}/organizations/${encodeURIComponent(org)}${path}`,{method,body});
  function configured(group,flag){
    const flags=root.PlatformAPI?.appFlags;
    return flags?.has?.('platform','expanded_access')===true && (flags.current?.()?.available?.[group]?.[flag]===true || flags.has?.(group,flag)===true);
  }
  function stripeUrl(value){
    const url=new URL(value);
    if(url.protocol!=='https:'||!['checkout.stripe.com','invoice.stripe.com','pay.stripe.com'].includes(url.hostname))throw new Error('Unexpected checkout URL.');
    return url.href;
  }
  function isEnabled(options={}){
    const flags=root.PlatformAPI?.appFlags;
    const has=options.has||((group,flag)=>flags?.has?.(group,flag)===true);
    const definitions=options.definitions||flags?.current?.()?.definitions||root.Portal?.appFlags?.current?.()?.definitions||[];
    return has('platform','expanded_access') && has('platform','platform_billing') && definitions.some(d=>
      d.type==='boolean' && d.key!=='platform.platform_billing' && d.key!=='platform.expanded_access' &&
      d.requires?.includes('platform.expanded_access') && (has(d.group,d.flag)||configured(d.group,d.flag)));
  }
  async function review(options){
    styles();const api=apiFor(options.orgId);
    const wrapper=document.createElement('div');wrapper.className='pb';wrapper.setAttribute('data-settings-autosave','off');
    const dialog=document.createElement('dialog');wrapper.appendChild(dialog);document.body.appendChild(wrapper);
    dialog.innerHTML='<h3>Review subscription</h3><p role="status">Loading your totals…</p><button data-back>Back</button>';dialog.showModal();
    return new Promise(resolve=>{
      let busy=false;const close=value=>{wrapper.remove();resolve(value);};
      dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)close(false);});
      dialog.querySelector('[data-back]').onclick=()=>close(false);
      void api('/subscription-quotes','POST',{price_id:options.priceId}).then(({quote:q})=>{
        if(!wrapper.isConnected)return;
        dialog.innerHTML=`<h3>Add ${esc(q.price.name)}</h3><p>${esc(q.price.description)}</p>
          <div class="pb-card">${q.items.map(item=>`<div class="pb-row"><span>${esc(item.name)} ${item.added?'<span class="pb-tag green">Adding</span>':''}</span><strong>${money(item.monthly_cents)} / mo</strong></div>`).join('')}</div>
          <div class="pb-row"><span>Current monthly total</span><span>${money(q.current_monthly_cents)}</span></div>
          <div class="pb-row"><strong>New monthly total</strong><strong>${money(q.new_monthly_cents)}</strong></div>
          <hr style="border:0;border-top:1px solid #eaecf0;margin:16px 0">
          ${q.credit_cents?`<div class="pb-row"><span>Account credit applied</span><span>−${money(q.credit_cents)}</span></div>`:''}
          <div class="pb-row"><h3>Due today</h3><h3>${money(q.due_now_cents)}</h3></div>
          <p>${q.subscription_id?`For this add-on through ${esc(new Date(q.renewal_at).toLocaleDateString())}. Today’s charge covers this add-on only.`:q.price.monthly_cents?'Your first month, charged at checkout. Renews monthly from today.':'No subscription payment is due today.'}</p>
          ${q.price.rates.length?`<details><summary>Included usage & additional charges</summary>${q.price.rates.map(r=>`<p>${esc(r.meter)}: ${esc(r.included.toLocaleString())} included; ${esc('$'+(r.unit_price_micros/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,''))} per ${esc(r.unit_quantity.toLocaleString())}.</p>`).join('')}<p>Usage is billed separately after each calendar month.</p></details>`:''}
          <p><small>Renews until cancelled. ${q.subscription_id?'Confirming charges your saved payment method.':'Payment is handled securely by Stripe.'}</small></p>
          <div role="status" aria-live="polite" class="pb-status"></div><div class="pb-actions"><button data-back>Back</button><button class="primary" data-accept>${q.subscription_id&&q.due_now_cents?'Pay '+money(q.due_now_cents)+' & add':q.price.monthly_cents?'Continue to checkout':'Confirm & add'}</button></div>`;
        dialog.querySelector('[data-back]').onclick=()=>close(false);
        dialog.querySelector('[data-accept]').onclick=async()=>{
          if(busy)return;busy=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
          try{const result=await api('/subscription-checkouts','POST',{quote_id:q.id,accept_terms:true});
            if(result.paid){await root.PlatformAPI.appFlags?.load?.(options.orgId,{refresh:true});close(true);return;}
            if(result.url){root.location.assign(stripeUrl(result.url));return;}
            throw new Error('Payment is processing. Check its status in Billing.');
          }catch(error){dialog.querySelector('[role=status]').textContent=error.message||'Could not complete checkout.';}
          finally{busy=false;if(wrapper.isConnected)dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
        };
      }).catch(error=>{if(wrapper.isConnected)dialog.querySelector('[role=status]').textContent=error.message||'Could not load checkout.';});
    });
  }
  // Reusable entry point for app setup. Adding a catalog product automatically
  // gives that capability the same review and payment flow.
  async function setup(host,options){
    if(!isEnabled())return false;
    if(options.canView===false){
      if(options.capabilityKeys.every(key=>root.PlatformAPI.appFlags.has(...key.split('.'))))return false;
      host.innerHTML='<div class="cs-note">Ask a billing administrator to add this subscription before continuing setup.</div>';return true;
    }
    const data=await apiFor(options.orgId)();
    const latest=new Map();for(const p of data.prices)if(p.published&&(!latest.has(p.product_id)||latest.get(p.product_id).version<p.version))latest.set(p.product_id,p);
    const required=[...latest.values()].find(p=>options.capabilityKeys.includes(p.capability_key)&&p.require_subscription&&(p.monthly_cents||p.rates.some(r=>r.unit_price_micros))&&!data.subscriptions.some(s=>s.product_id===p.product_id&&(!s.ends_at||s.ends_at>new Date().toISOString())&&(!s.stripe_subscription_id||(s.paid_through||'')>new Date().toISOString())));
    if(!required)return false;
    styles();host.innerHTML=`<div class="pb" data-settings-autosave="off"><div class="pb-card"><h3>${esc(required.name)}</h3><p>${esc(required.description)}</p><strong>${esc(priceText(required))}</strong><p>Review your updated subscription to continue setup.</p><div class="pb-actions">${data.can_manage?'<button class="primary" data-setup-checkout>Review & add</button>':'<span>Ask a billing administrator to add this subscription.</span>'}</div><div class="pb-status" role="status"></div></div></div>`;
    host.querySelector('[data-setup-checkout]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{if(await review({orgId:options.orgId,priceId:required.id}))await options.onReady?.();}finally{if(host.isConnected)host.querySelector('[data-setup-checkout]')?.removeAttribute('disabled');}});
    return true;
  }
  function styles(){
    if(document.getElementById('platform-billing-css'))return;
    const style=document.createElement('style');style.id='platform-billing-css';style.textContent=`
      .pb{color:#182230;font-family:inherit;font-size:13px;line-height:1.5;max-width:1240px;margin:auto}.pb *{box-sizing:border-box;font-family:inherit}.pb h2,.pb h3,.pb h4{margin:0 0 6px}.pb p{margin:4px 0 14px;color:#667085}.pb-head,.pb-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.pb-head{margin-bottom:20px}.pb nav{display:flex;gap:6px;flex-wrap:wrap;margin:20px 0}.pb button{border:1px solid #d0d5dd;border-radius:8px;background:white;color:#344054;padding:9px 13px;font:600 12px inherit;cursor:pointer}.pb button.active,.pb button.primary{background:#182230;color:white;border-color:#182230}.pb button:disabled{opacity:.45;cursor:default}.pb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.pb-card{border:1px solid #e4e7ec;background:#fff;border-radius:12px;padding:20px;margin-bottom:14px}.pb-card strong.total{display:block;font-size:28px;letter-spacing:-.03em}.pb small{color:#667085}.pb-tag{display:inline-block;border-radius:20px;padding:3px 9px;background:#f2f4f7;font-size:11px}.pb-tag.green{background:#ecfdf3;color:#067647}.pb-table{overflow:auto}.pb table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.pb th{color:#667085;font-weight:600;background:#f9fafb}.pb td,.pb th{padding:12px;border-bottom:1px solid #eaecf0;vertical-align:top}.pb label{display:grid;gap:5px;font-size:12px;color:#475467}.pb input,.pb select,.pb textarea{width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:7px;background:white;color:#182230;font:inherit}.pb input[type=checkbox]{width:auto}.pb-form{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pb-wide{grid-column:1/-1}.pb-rate{display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:8px;margin:12px 0;align-items:end}.pb-empty{padding:36px;text-align:center;border:1px dashed #d0d5dd;border-radius:12px;color:#667085}.pb-status{min-height:22px;color:#b42318}.pb-note{padding:12px 16px;border-radius:9px;background:#f8fafc;margin-bottom:14px}.pb dialog{border:1px solid #d0d5dd;border-radius:14px;max-width:600px;width:calc(100% - 24px);padding:24px}.pb dialog::backdrop{background:#10182888}.pb details{margin-top:12px}.pb summary{cursor:pointer;font-weight:600}.pb-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.pb progress{width:100%;accent-color:#344054}@media(max-width:700px){.pb-grid,.pb-form{grid-template-columns:1fr}.pb-rate{grid-template-columns:1fr 1fr}.pb-rate label:first-child{grid-column:1/-1}.pb-card{padding:15px}.pb-head h2{font-size:20px}}
    `;document.head.appendChild(style);
  }
  async function mount(host,options={}){
    if(!host)return;styles();
    const token={};host._billingMount=token;
    let data,view='overview',period=new Date().toISOString().slice(0,7),busy=false;
    let org=options.orgId;
    const api=(path='',method='GET',body)=>root.PlatformAPI.request(`${root.PlatformAPI.baseUrl().replace(/\/platform\/?$/,'/platform-billing')}/organizations/${encodeURIComponent(org)}${path}`,{method,body});
    const active=()=>host.isConnected&&host._billingMount===token;
    async function load(){data=await api(`?period=${period}`);if(active())render();}
    async function act(operation){if(busy)return;busy=true;host.querySelectorAll('button').forEach(b=>b.disabled=true);try{await operation();await load();}catch(e){if(active()){render();host.querySelector('.pb-status').textContent=e.message||'Could not save billing changes.';}}finally{busy=false;}}
    function rates(p){return p.rates.map(r=>`<div>${esc(data.meters.find(m=>m.id===r.meter)?.label||r.meter)}: ${esc(r.included.toLocaleString())} included; $${esc((r.unit_price_micros/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,''))} per ${esc(r.unit_quantity.toLocaleString())}</div>`).join('');}
    function lines(items){return `<div class="pb-table"><table><thead><tr><th>Charge</th><th>Measured quantity</th><th>Included</th><th>Amount</th></tr></thead><tbody>${items.map(l=>`<tr><td>${esc(l.label)}<br><small>${esc(l.price_id)}</small></td><td>${esc(l.quantity)}</td><td>${esc(l.included)}</td><td>${money(l.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`;}
    function render(){
      const latest=new Map();for(const p of data.prices)if(p.published && (!latest.has(p.product_id)||latest.get(p.product_id).version<p.version))latest.set(p.product_id,p);
      const subscriptions=data.subscriptions.filter(s=>!s.ends_at||s.ends_at>new Date().toISOString());
      host.innerHTML=`<div class="pb" data-settings-autosave="off"><header class="pb-head"><div><h2>Subscriptions & usage</h2><p>Subscriptions, usage and storage for your organization.</p></div><button data-refresh>Refresh usage & payments</button></header>
        <div class="pb-status" role="status" aria-live="polite"></div>
        ${(data.purchases||[]).map(p=>`<div class="pb-note pb-row"><span>${esc(p.name)} · Payment pending</span><div class="pb-actions"><button data-resume="${esc(p.id)}">Resume checkout</button><button data-abandon="${esc(p.id)}">Cancel checkout</button></div></div>`).join('')}
        <nav aria-label="Billing views">${[['overview','Overview'],['subscriptions','Subscriptions'],['invoices','Invoices'],...(data.operator?[['catalog','Pricing catalog'],['account','Account controls']]:[])].map(([id,label])=>`<button data-view="${id}" class="${view===id?'active':''}">${label}</button>`).join('')}</nav>
        ${view==='overview'?`<div class="pb-row"><h3>Current charges</h3><label>Billing month<input type="month" data-period value="${period}"></label></div><p>Monthly subscriptions renew until cancelled. Subscription fees are paid in advance. Usage is invoiced after each UTC calendar month.</p>
        <div class="pb-grid"><div class="pb-card"><small>Estimated charges to date</small><strong class="total">${money(data.estimate.total_cents)}</strong><small>${esc(period)} · before tax</small></div><div class="pb-card"><small>Monthly subscription</small><strong class="total">${money(subscriptions.filter(s=>!s.ends_at).reduce((total,s)=>total+s.price.monthly_cents,0))}</strong><small>${subscriptions.length} subscriptions · usage billed separately</small></div><div class="pb-card"><small>Stored media</small><strong class="total">${data.storage?(Number(data.storage.quantity)/1073741824).toFixed(2)+' GiB':'Not measured'}</strong><small>${data.storage?'Measured '+esc(date(data.storage.occurred_at)):'Enable monitoring to start storage snapshots.'}</small></div></div>
        <div class="pb-note">${data.sync?`Usage updated ${esc(date(data.sync.at))}${data.sync.error?' · '+esc(data.sync.error):data.sync.complete?'':' · Catch-up in progress'}`:'Usage collection begins when monitoring or a subscription is activated.'} Storage charges use the time-weighted average of retained media, including generated renditions.</div>
        ${data.estimate.lines.length?`<div class="pb-card">${lines(data.estimate.lines)}</div>`:'<div class="pb-empty">No platform charges for this period. Features without a published paid price remain free.</div>'}
        ${data.late_usage.length?'<div class="pb-note">Additional usage arrived after this invoice closed. An operator can review an adjustment; the issued invoice stays fixed.</div>':''}`:''}
        ${view==='subscriptions'?`<h3>Your subscriptions</h3><p>Activating a subscription accepts its listed monthly and usage prices. Cancelling preserves access through the paid period.</p>${data.subscriptions.map(s=>`<div class="pb-card pb-row"><div><h4>${esc(s.price.name)}</h4><div>${esc(priceText(s.price))} <span class="pb-tag">${esc(s.price.id)}</span></div><small>Started ${esc(date(s.starts_at))}${s.ends_at?' · Ends '+esc(date(s.ends_at)):''}</small>${rates(s.price)}</div>${!s.ends_at?`<button data-cancel="${esc(s.id)}">Cancel renewal</button>`:''}</div>`).join('')||'<div class="pb-empty">No subscriptions yet.</div>'}<h3>Available subscriptions</h3>${[...latest.values()].filter(p=>p.published).map(p=>`<div class="pb-card pb-row"><div><h4>${esc(p.name)}</h4><p>${esc(p.description)}</p><strong>${esc(priceText(p))}</strong>${rates(p)}</div><button data-subscribe="${esc(p.id)}" ${subscriptions.some(s=>s.product_id===p.product_id)?'disabled':''}>Review & add</button></div>`).join('')||'<p>No paid products have been published.</p>'}`:''}
        ${view==='invoices'?`<h3>Invoices</h3><p>Subscription payments appear below. Usage invoices close 72 hours after month end.</p>${(data.recurring_invoices||[]).sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(i=>`<div class="pb-card"><div class="pb-row"><div><h4>Subscription · ${esc(new Date(i.created_at).toLocaleDateString())}</h4><span class="pb-tag ${i.status==='paid'?'green':''}">${esc(i.status)}</span></div><strong>${money(i.total_cents)}</strong>${i.url?`<button data-native-invoice="${esc(i.url)}">${i.status==='open'?'Complete payment':'View receipt'}</button>`:''}</div><details><summary>View charges</summary>${i.lines.map(l=>`<div class="pb-row"><span>${esc(l.label)}</span><strong>${money(l.amount_cents)}</strong></div>`).join('')}</details></div>`).join('')}${data.invoices.map(i=>`<div class="pb-card"><div class="pb-row"><div><h4>${esc(i.period)}</h4><span class="pb-tag ${i.status==='paid'?'green':''}">${esc(i.status)}</span></div><strong>${money(i.total_cents)}</strong>${i.status==='open'?`<button class="primary" data-pay="${esc(i.id)}">Pay invoice</button>`:''}</div><details><summary>View charges</summary>${lines(i.lines)}</details></div>`).join('')||'<div class="pb-empty">Your issued invoices will appear here.</div>'}`:''}
        ${view==='catalog'?`<h3>Pricing catalog</h3><p>Connect any eligible app or feature to a price. Publish a new version to offer new prices; existing subscriptions retain their accepted version.</p>${data.prices.map(p=>`<div class="pb-card pb-row"><div><h4>${esc(p.name)} <span class="pb-tag">v${p.version} · ${p.published?'Published':'Draft'}</span></h4><small>${esc(p.capability_key)}</small><div>${esc(priceText(p))}</div>${rates(p)}</div>${!p.published?`<button data-publish="${esc(p.id)}">Publish price</button>`:''}</div>`).join('')}
        <form class="pb-card" data-price-form><h3>Create a price version</h3><div class="pb-form"><label>Product ID<input name="product_id" required pattern="[a-z][a-z0-9_-]{1,63}" placeholder="agents"></label><label>Display name<input name="name" required maxlength="100" placeholder="AI agents"></label><label class="pb-wide">Feature or app<select name="capability_key">${data.capabilities.map(c=>`<option value="${esc(c.key)}">${esc(c.label)} · ${esc(c.key)}</option>`).join('')}</select></label><label>Description<textarea name="description" maxlength="1000"></textarea></label><label>Monthly price (USD)<input name="monthly" type="number" min="0" max="1000000" step="0.01" value="0" required></label><label class="pb-wide"><span><input type="checkbox" name="require_subscription" checked> Require an active subscription when commercial access checks are enabled</span></label></div><h4>Usage prices</h4><p>For storage, use 1073741824 units to price a GiB-month. An empty usage list and a $0 monthly price makes this product free.</p><div data-rates></div><button type="button" data-add-rate>Add usage price</button><div class="pb-actions"><button class="primary" type="submit">Save draft price</button></div></form>`:''}
        ${view==='account'?`<div class="pb-card"><h3>Account controls</h3><p>Start collecting usage before enabling subscription requirements. Commercial access checks apply only to published paid products.</p><div class="pb-row"><span>Access checks: <strong>${data.account.enforce?'Enabled':'Disabled'}</strong></span><button data-enforce>${data.account.enforce?'Disable access checks':'Enable access checks'}</button><button data-monitor>Start usage monitoring</button></div></div><form class="pb-card" data-close-form><h3>Close a billing period</h3><p>The month must have ended at least 72 hours ago. This creates an immutable invoice and never charges a card automatically.</p><label>Period<input type="month" name="period" required value="${period}"></label><div class="pb-actions"><button type="submit">Create invoice</button></div></form><div class="pb-card"><h3>Audit history</h3>${(data.audit||[]).map(a=>`<p>${esc(date(a.at))} · ${esc(a.action)}</p>`).join('')||'<p>No billing changes yet.</p>'}</div>`:''}
      </div>`;
      host.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});
      host.querySelector('[data-period]')?.addEventListener('change',e=>{period=e.target.value;void act(async()=>{});});
      host.querySelector('[data-refresh]').onclick=()=>act(()=>api('/refresh','POST'));
      host.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{if(root.confirm('Stop renewing this subscription? Access continues through the paid period.'))act(()=>api(`/subscriptions/${encodeURIComponent(b.dataset.cancel)}/cancel`,'POST'));});
      host.querySelectorAll('[data-publish]').forEach(b=>b.onclick=()=>{if(root.confirm('Publish this price for new subscriptions? Existing subscriptions keep their current price.'))act(()=>api(`/prices/${encodeURIComponent(b.dataset.publish)}/publish`,'POST'));});
      host.querySelectorAll('[data-subscribe]').forEach(b=>b.onclick=()=>act(async()=>{await review({orgId:org,priceId:b.dataset.subscribe});}));
      host.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>act(async()=>{const r=await api('/subscription-checkouts','POST',{quote_id:b.dataset.resume,accept_terms:true});if(r.url)root.location.assign(stripeUrl(r.url));}));
      host.querySelectorAll('[data-abandon]').forEach(b=>b.onclick=()=>act(()=>api(`/subscription-checkouts/${b.dataset.abandon}/cancel`,'POST')));
      host.querySelectorAll('[data-native-invoice]').forEach(b=>b.onclick=()=>root.location.assign(stripeUrl(b.dataset.nativeInvoice)));
      host.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>act(async()=>{const r=await api(`/invoices/${b.dataset.pay}/checkout`,'POST');if(r.url){const url=new URL(r.url);if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw new Error('Unexpected checkout URL.');root.location.assign(url.href);}}));
      host.querySelector('[data-monitor]')?.addEventListener('click',()=>act(async()=>{await api('/account','PUT',{enforce:data.account.enforce});await api('/refresh','POST');}));
      host.querySelector('[data-enforce]')?.addEventListener('click',()=>{if(root.confirm(`${data.account.enforce?'Disable':'Enable'} subscription access checks for this organization?`))act(()=>api('/account','PUT',{enforce:!data.account.enforce}));});
      host.querySelector('[data-close-form]')?.addEventListener('submit',e=>{e.preventDefault();act(()=>api('/invoices','POST',{period:new FormData(e.target).get('period')}));});
      const form=host.querySelector('[data-price-form]');
      host.querySelector('[data-add-rate]')?.addEventListener('click',()=>{
        const row=document.createElement('div');row.className='pb-rate';row.innerHTML=`<label>Meter<select data-meter aria-label="Meter">${data.meters.map(m=>`<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></label><label>Included units<input data-included type="number" min="0" step="1" value="0" required></label><label>Units per price<input data-units type="number" min="1" step="1" value="1" required></label><label>Price (USD)<input data-price type="number" min="0" step="0.000001" value="0" required></label><button type="button" aria-label="Remove usage price">Remove</button>`;row.querySelector('button').onclick=()=>row.remove();form.querySelector('[data-rates]').appendChild(row);
      });
      form?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(form);const rates=[...form.querySelectorAll('.pb-rate')].map(r=>({meter:r.querySelector('[data-meter]').value,included:Number(r.querySelector('[data-included]').value),unit_quantity:Number(r.querySelector('[data-units]').value),unit_price_micros:Math.round(Number(r.querySelector('[data-price]').value)*1e6)}));act(()=>api('/prices','POST',{product_id:f.get('product_id'),name:f.get('name'),description:f.get('description'),capability_key:f.get('capability_key'),monthly_cents:Math.round(Number(f.get('monthly'))*100),currency:'USD',require_subscription:f.has('require_subscription'),rates}));});
      if(data.can_manage===false) host.querySelectorAll('[data-refresh],[data-cancel],[data-subscribe],[data-pay],[data-resume],[data-abandon]').forEach(b=>b.hidden=true);
      if(data.operator && view==='account') {
        const controls=document.createElement('div');controls.innerHTML=`<form class="pb-card" data-org-form><h3>Organization</h3><label>Organization ID<input name="org" value="${esc(org)}" required></label><div class="pb-actions"><button type="submit">Open billing account</button></div></form><form class="pb-card" data-adjust-form><h3>Credit or adjustment</h3><p>Use a negative amount for a credit. Adjustments require a reason and apply to an open billing period.</p><div class="pb-form"><label>Period<input type="month" name="period" value="${period}" required></label><label>Amount (USD)<input name="amount" type="number" step="0.01" required></label><label class="pb-wide">Reason<input name="reason" maxlength="500" required></label></div><div class="pb-actions"><button type="submit">Record adjustment</button></div></form>`;
        host.querySelector('.pb').appendChild(controls);
        controls.querySelector('[data-org-form]').onsubmit=e=>{e.preventDefault();const next=String(new FormData(e.target).get('org')).trim();act(async()=>{const old=org;org=next;try{await load();}catch(error){org=old;throw error;}});};
        controls.querySelector('[data-adjust-form]').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);act(()=>api('/adjustments','POST',{period:f.get('period'),amount_cents:Math.round(Number(f.get('amount'))*100),reason:f.get('reason'),request_key:crypto.randomUUID()}));};
      }
    }
    host.innerHTML='<div class="pb-empty">Loading platform billing…</div>';
    try{await load();
      const returningId=new URLSearchParams(root.location.search).get('billing_checkout');
      if(data.can_manage && returningId){
        await api('/subscription-checkouts/refresh','POST');await root.PlatformAPI.appFlags?.load?.(org,{refresh:true});await load();
        if(active())host.querySelector('.pb-status').textContent=data.subscriptions.some(s=>s.request_key===returningId)?'Payment confirmed. Your subscription is ready.':(data.purchases||[]).some(p=>p.id===returningId)?'Checkout is not complete yet. Resume payment below.':'Checkout ended without activating a subscription.';
        const url=new URL(root.location.href);url.searchParams.delete('billing_checkout');root.history.replaceState(root.history.state,'',url.href);
      }
    }catch(e){if(active())host.innerHTML=`<div class="pb-status" role="alert">${esc(e.message)}</div>`;}
  }
  root.FirstMatePlatformBilling={mount,isEnabled,configured,review,setup};
})(window);
