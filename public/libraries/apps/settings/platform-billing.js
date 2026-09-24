(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=c=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(c)/100);
  const date=v=>v?new Date(v).toLocaleString():'—';
  const planKey=p=>p.product_id+':'+(p.plan_key||'default');
  const highlights=p=>(p.highlights||[]).length?'<ul>'+p.highlights.map(h=>'<li>'+esc(h)+'</li>').join('')+'</ul>':'';
  const priceText=p=>`${money(p.monthly_cents)} / month${p.rates.length?' + usage':''}`;
  const apiFor=org=>(path='',method='GET',body)=>root.PlatformAPI.request(`${root.PlatformAPI.baseUrl().replace(/\/platform\/?$/,'/platform-billing')}/organizations/${encodeURIComponent(org)}${path}`,{method,body});
  function configured(group,flag){
    const flags=root.PlatformAPI?.appFlags;
    return flags?.has?.('platform','expanded_access')===true && (flags.current?.()?.available?.[group]?.[flag]===true || flags.has?.(group,flag)===true);
  }
  function stripeUrl(value){
    const url=new URL(value);
    if(url.protocol!=='https:'||!['checkout.stripe.com','invoice.stripe.com','pay.stripe.com','billing.stripe.com'].includes(url.hostname))throw new Error('Unexpected checkout URL.');
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
        dialog.innerHTML=`<h3>${q.replaces_id?'Change to':'Add'} ${esc(q.price.name)}</h3><p>${esc(q.price.description)}</p>${highlights(q.price)}
          <div class="pb-card">${q.items.map(item=>`<div class="pb-row"><span>${esc(item.name)} ${item.added?'<span class="pb-tag green">Adding</span>':''}</span><strong>${money(item.monthly_cents)} / mo</strong></div>`).join('')}</div>
          <div class="pb-row"><span>Current monthly total</span><span>${money(q.current_monthly_cents)}</span></div>
          <div class="pb-row"><strong>New monthly total</strong><strong>${money(q.new_monthly_cents)}</strong></div>
          <hr style="border:0;border-top:1px solid #eaecf0;margin:16px 0">
          ${q.credit_cents?`<div class="pb-row"><span>Account credit applied</span><span>−${money(q.credit_cents)}</span></div>`:''}
          ${q.future_credit_cents?`<p>${money(q.future_credit_cents)} credit will apply to future automatic charges.</p>`:''}<div class="pb-row"><h3>Due today</h3><h3>${money(q.due_now_cents)}</h3></div>
          <p>${q.subscription_id?`Prorated difference through ${esc(new Date(q.renewal_at).toLocaleDateString())}. Your existing paid subscription is credited in this calculation.`:q.price.monthly_cents?'Your first month, charged at checkout. Renews monthly from today.':'No subscription payment is due today.'}</p>
          ${q.price.rates.length?`<details><summary>Included usage & additional charges</summary>${q.price.rates.map(r=>`<p>${esc(r.meter)}: ${esc(r.included.toLocaleString())} included; ${esc('$'+(r.unit_price_micros/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,''))} per ${esc(r.unit_quantity.toLocaleString())}.</p>`).join('')}<p>Usage is billed separately after each calendar month.</p></details>`:''}
          <p><small>Renews until cancelled. ${q.subscription_id?'Confirming charges your saved payment method.':'Payment is handled securely by Stripe.'}</small></p>
          <div role="status" aria-live="polite" class="pb-status"></div><div class="pb-actions"><button data-back>Back</button><button class="primary" data-accept>${q.subscription_id?(q.due_now_cents?'Pay '+money(q.due_now_cents)+' & confirm':'Confirm change'):q.price.monthly_cents?'Continue to checkout':'Confirm & add'}</button></div>`;
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
    const latest=new Map();for(const p of data.prices)if(p.published&&(!latest.has(planKey(p))||latest.get(planKey(p)).version<p.version))latest.set(planKey(p),p);
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
    let data,view=options.adminOnly?'catalog':'overview',period=new Date().toISOString().slice(0,7),busy=false;
    let org=options.orgId;
    const api=(path='',method='GET',body)=>root.PlatformAPI.request(`${root.PlatformAPI.baseUrl().replace(/\/platform\/?$/,'/platform-billing')}/organizations/${encodeURIComponent(org)}${path}`,{method,body});
    const active=()=>host.isConnected&&host._billingMount===token;
    async function load(){data=await api(`?period=${period}`);if(active())render();}
    async function act(operation){if(busy)return;busy=true;host.querySelectorAll('button').forEach(b=>b.disabled=true);try{await operation();await load();}catch(e){if(active()){render();host.querySelector('.pb-status').textContent=e.message||'Could not save billing changes.';}}finally{busy=false;}}
    function rates(p){return p.rates.map(r=>`<div>${esc(data.meters.find(m=>m.id===r.meter)?.label||r.meter)}: ${esc(r.included.toLocaleString())} included; $${esc((r.unit_price_micros/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,''))} per ${esc(r.unit_quantity.toLocaleString())}</div>`).join('');}
    function lines(items){return `<div class="pb-table"><table><thead><tr><th>Charge</th><th>Measured quantity</th><th>Included</th><th>Amount</th></tr></thead><tbody>${items.map(l=>`<tr><td>${esc(l.label)}<br><small>${esc(l.price_id)}</small></td><td>${esc(l.quantity)}</td><td>${esc(l.included)}</td><td>${money(l.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`;}
    function render(){
      const latest=new Map();for(const p of data.prices)if(p.published && (!latest.has(planKey(p))||latest.get(planKey(p)).version<p.version))latest.set(planKey(p),p);
      const subscriptions=data.subscriptions.filter(s=>!s.ends_at||s.ends_at>new Date().toISOString());
      host.innerHTML=`<div class="pb" data-settings-autosave="off"><header class="pb-head"><div><h2>${options.adminOnly?'Billing administration':'Subscriptions & usage'}</h2><p>${options.adminOnly?'Manage pricing and commercial access.':'Subscriptions, usage and storage for your organization.'}</p></div><button data-refresh>Refresh usage & payments</button></header>
        <div class="pb-status" role="status" aria-live="polite"></div>
        ${(data.purchases||[]).map(p=>`<div class="pb-note pb-row"><span>${esc(p.name)} · Payment pending</span><div class="pb-actions"><button data-resume="${esc(p.id)}">Resume checkout</button><button data-abandon="${esc(p.id)}">Cancel checkout</button></div></div>`).join('')}
        <nav aria-label="Billing views">${(options.adminOnly?(data.operator?[['catalog','Pricing catalog'],['account','Account controls']]:[]):[['overview','Overview'],['subscriptions','Subscriptions'],['invoices','Invoices'],...(data.operator?[['catalog','Pricing catalog'],['account','Account controls']]:[])]).map(([id,label])=>`<button data-view="${id}" class="${view===id?'active':''}">${label}</button>`).join('')}</nav>
        ${view==='overview'?`<div class="pb-row"><h3>Current charges</h3><label>Billing month<input type="month" data-period value="${period}"></label></div><p>Monthly subscriptions renew until cancelled. Subscription fees are paid in advance. Usage is invoiced after each UTC calendar month.</p>
        <div class="pb-grid"><div class="pb-card"><small>Estimated charges to date</small><strong class="total">${money(data.estimate.total_cents)}</strong><small>${esc(period)} · before tax</small></div><div class="pb-card"><small>Monthly subscription</small><strong class="total">${money(subscriptions.filter(s=>!s.ends_at).reduce((total,s)=>total+s.price.monthly_cents,0))}</strong><small>${subscriptions.length} subscriptions · usage billed separately</small></div><div class="pb-card"><small>Stored media</small><strong class="total">${data.storage?(Number(data.storage.quantity)/1073741824).toFixed(2)+' GiB':'Not measured'}</strong><small>${data.storage?'Measured '+esc(date(data.storage.occurred_at)):'Enable monitoring to start storage snapshots.'}</small></div></div>
        <div class="pb-note">${data.sync?`Usage updated ${esc(date(data.sync.at))}${data.sync.error?' · '+esc(data.sync.error):data.sync.complete?'':' · Catch-up in progress'}`:'Usage collection begins when monitoring or a subscription is activated.'} Storage charges use the time-weighted average of retained media, including generated renditions.</div>
        ${data.estimate.lines.length?`<div class="pb-card">${lines(data.estimate.lines)}</div>`:'<div class="pb-empty">No platform charges for this period. Features without a published paid price remain free.</div>'}
        ${data.late_usage.length?'<div class="pb-note">Additional usage arrived after this invoice closed. An operator can review an adjustment; the issued invoice stays fixed.</div>':''}`:''}
        ${view==='subscriptions'?`<h3>Your subscriptions</h3><p>Activating a subscription accepts its listed monthly and usage prices. Cancelling preserves access through the paid period.</p>${data.subscriptions.map(s=>`<div class="pb-card pb-row"><div><h4>${esc(s.price.name)}</h4><div>${esc(priceText(s.price))} <span class="pb-tag">${esc(s.price.id)}</span></div><small>Started ${esc(date(s.starts_at))}${s.ends_at?' · Ends '+esc(date(s.ends_at)):''}</small>${rates(s.price)}</div>${!s.ends_at?`<button data-cancel="${esc(s.id)}">Cancel renewal</button>`:''}</div>`).join('')||'<div class="pb-empty">No subscriptions yet.</div>'}<h3>Available subscriptions</h3>${[...latest.values()].filter(p=>p.published).map(p=>`<div class="pb-card pb-row"><div><h4>${esc(p.name)}</h4><p>${esc(p.description)}</p><strong>${esc(priceText(p))}</strong>${rates(p)}</div><button data-subscribe="${esc(p.id)}" ${subscriptions.some(s=>s.product_id===p.product_id)?'disabled':''}>Review & add</button></div>`).join('')||'<p>No paid products have been published.</p>'}`:''}
        ${view==='invoices'?`<h3>Invoices</h3><p>Subscription payments appear below. Usage invoices close 72 hours after month end.</p>${(data.recurring_invoices||[]).sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(i=>`<div class="pb-card"><div class="pb-row"><div><h4>Subscription · ${esc(new Date(i.created_at).toLocaleDateString())}</h4><span class="pb-tag ${i.status==='paid'?'green':''}">${esc(i.status)}</span></div><strong>${money(i.total_cents)}</strong>${i.url?`<button data-native-invoice="${esc(i.url)}">${i.status==='open'?'Complete payment':'View receipt'}</button>`:''}</div><details><summary>View charges</summary>${i.lines.map(l=>`<div class="pb-row"><span>${esc(l.label)}</span><strong>${money(l.amount_cents)}</strong></div>`).join('')}</details></div>`).join('')}${data.invoices.map(i=>`<div class="pb-card"><div class="pb-row"><div><h4>${esc(i.period)}</h4><span class="pb-tag ${i.status==='paid'?'green':''}">${esc(i.status)}</span></div><strong>${money(i.total_cents)}</strong>${i.status==='open'?'<small>Collected automatically from your subscription payment method.</small>':''}</div><details><summary>View charges</summary>${lines(i.lines)}</details></div>`).join('')||'<div class="pb-empty">Your issued invoices will appear here.</div>'}`:''}
        ${view==='catalog'?`<h3>Pricing catalog</h3><button data-standard-catalog>Install standard offers</button><p>Connect any eligible app or feature to a price. Publish a new version to offer new prices; existing subscriptions retain their accepted version.</p>${data.prices.map(p=>`<div class="pb-card pb-row"><div><h4>${esc(p.name)} <span class="pb-tag">v${p.version} · ${p.published?'Published':'Draft'}</span></h4><small>${esc(p.capability_key)}</small><div>${esc(priceText(p))}</div>${rates(p)}</div>${!p.published?`<button data-publish="${esc(p.id)}">Publish price</button>`:''}</div>`).join('')}
        <form class="pb-card" data-price-form><h3>Create a price version</h3><div class="pb-form"><label>Product ID<input name="product_id" required pattern="[a-z][a-z0-9_-]{1,63}" placeholder="agents"></label><label>Plan key<input name="plan_key" required pattern="[a-z0-9_-]{1,40}" value="default"></label><label>Display name<input name="name" required maxlength="100" placeholder="AI agents"></label><label class="pb-wide">Feature or app<select name="capability_key">${data.capabilities.map(c=>`<option value="${esc(c.key)}">${esc(c.label)} · ${esc(c.key)}</option>`).join('')}</select></label><label>Description<textarea name="description" maxlength="1000"></textarea></label><label>Highlights (one per line)<textarea name="highlights"></textarea></label><label>Included outgoing SMS<input type="number" name="sms_messages" min="0" step="1"></label><label>Storage allowance (GB)<input type="number" name="storage_gb" min="0" step="1"></label><label><span><input name="placeholder" type="checkbox"> Placeholder offer</span></label><label>Monthly price (USD)<input name="monthly" type="number" min="0" max="1000000" step="0.01" value="0" required></label><label class="pb-wide"><span><input type="checkbox" name="require_subscription" checked> Require an active subscription when commercial access checks are enabled</span></label></div><h4>Usage prices</h4><p>For storage, use 1073741824 units to price a GiB-month. An empty usage list and a $0 monthly price makes this product free.</p><div data-rates></div><button type="button" data-add-rate>Add usage price</button><div class="pb-actions"><button class="primary" type="submit">Save draft price</button></div></form>`:''}
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
      host.querySelector('[data-standard-catalog]')?.addEventListener('click',()=>act(()=>api('/catalog/install','POST')));
      const form=host.querySelector('[data-price-form]');
      host.querySelector('[data-add-rate]')?.addEventListener('click',()=>{
        const row=document.createElement('div');row.className='pb-rate';row.innerHTML=`<label>Meter<select data-meter aria-label="Meter">${data.meters.map(m=>`<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></label><label>Included units<input data-included type="number" min="0" step="1" value="0" required></label><label>Units per price<input data-units type="number" min="1" step="1" value="1" required></label><label>Price (USD)<input data-price type="number" min="0" step="0.000001" value="0" required></label><button type="button" aria-label="Remove usage price">Remove</button>`;row.querySelector('button').onclick=()=>row.remove();form.querySelector('[data-rates]').appendChild(row);
      });
      form?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(form);const rates=[...form.querySelectorAll('.pb-rate')].map(r=>({meter:r.querySelector('[data-meter]').value,included:Number(r.querySelector('[data-included]').value),unit_quantity:Number(r.querySelector('[data-units]').value),unit_price_micros:Math.round(Number(r.querySelector('[data-price]').value)*1e6)}));act(()=>api('/prices','POST',{product_id:f.get('product_id'),plan_key:f.get('plan_key'),highlights:String(f.get('highlights')||'').split('\n').map(s=>s.trim()).filter(Boolean),placeholder:f.has('placeholder'),allowances:{...(f.get('sms_messages')!==''?{sms_messages:Number(f.get('sms_messages'))}:{}),...(f.get('storage_gb')!==''?{storage_bytes:Number(f.get('storage_gb'))*1e9}:{})},name:f.get('name'),description:f.get('description'),capability_key:f.get('capability_key'),monthly_cents:Math.round(Number(f.get('monthly'))*100),currency:'USD',require_subscription:f.has('require_subscription'),rates}));});
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
      const returningId=new URLSearchParams(root.location.search).get('billing_checkout')||new URLSearchParams(root.location.search).get('billing_portal');
      if(data.can_manage && returningId){
        await api('/subscription-checkouts/refresh','POST');await root.PlatformAPI.appFlags?.load?.(org,{refresh:true});await load();
        if(active())host.querySelector('.pb-status').textContent=data.subscriptions.some(s=>s.request_key===returningId)?'Payment confirmed. Your subscription is ready.':(data.purchases||[]).some(p=>p.id===returningId)?'Checkout is not complete yet. Resume payment below.':'Checkout ended without activating a subscription.';
        const url=new URL(root.location.href);url.searchParams.delete('billing_checkout');url.searchParams.delete('billing_portal');root.history.replaceState(root.history.state,'',url.href);
      }
    }catch(e){if(active())host.innerHTML=`<div class="pb-status" role="alert">${esc(e.message)}</div>`;}
  }
  // A common statement model. Credit movements and cash payments are separate units.
  function statementRows(period, ledger, data, describe = row => ({title:row.reason || 'Measurement credit',detail:''})) {
    const rows = ledger.map((row,index) => {
      const info=describe(row), meta=row.meta||{}, reason=String(row.reason||'');
      const purchase=/^stripe_|^credits?_purchase$|^credits_loaded$/.test(reason) && Number(row.delta)>0 && !/refund/.test(reason);
      const cents=meta.amount_total??row.amount_total??meta.amount_cents;
      const dollars=meta.paid_dollars??row.paid_dollars??meta.charged_dollars;
      const paid=!purchase?null:cents!=null?Number(cents):dollars!=null?Math.round(Number(dollars)*100):reason==='stripe_auto_topup'?Math.round(Number(row.delta)*100):null;
      return {id:'credit-'+(row.id||index),at:row.ts||row.ts_utc||row.created_at,service:'credits',title:info.title,detail:info.detail,
        status:'Posted',paymentUnknown:purchase&&paid==null,paid:paid==null?null:Number(paid),due:0,credits:Number(row.delta)||0,balance:row.balance_after,lines:[]};
    });
    for (const [service, invoices] of [['subscriptions',data.recurring_invoices||[]],['usage',data.invoices||[]]]) {
      for (const invoice of invoices) rows.push({id:service+'-'+invoice.id,at:invoice.created_at,service,
        title:service==='subscriptions'?'Subscription invoice':'Usage invoice',detail:invoice.period?'Service month '+invoice.period:(invoice.lines||[]).map(l=>l.label).join(' · '),
        status:invoice.status,paid:invoice.amount_paid_cents>0?invoice.amount_paid_cents:invoice.status==='paid'?(invoice.amount_paid_cents??invoice.total_cents):null,
        due:invoice.status==='open'?Math.max(0,invoice.total_cents-(invoice.amount_paid_cents||0)):0,credits:null,lines:invoice.lines||[],invoice});
    }
    return rows.filter(row=>String(row.at||'').slice(0,7)===period).sort((a,b)=>String(b.at).localeCompare(String(a.at))||a.id.localeCompare(b.id));
  }
  function statementCsv(rows) {
    const cell=value=>'"'+(typeof value==='number'?String(value):String(value??'').replace(/^(?:\s*[=+@\-]|[\t\r])/,"'$&")).replace(/"/g,'""')+'"';
    return [['Date (UTC)','Service','Transaction','Details','Status','Paid (USD)','Due (USD)','Measurement credit change (USD)','Credit balance (USD)'],
      ...rows.map(r=>[r.at,r.service,r.title,r.detail,r.status,r.paid==null?'':(r.paid/100).toFixed(2),r.due?(r.due/100).toFixed(2):'',r.credits??'',r.balance??''])]
      .map(row=>row.map(cell).join(',')).join('\r\n');
  }
  function workspaceStyles(){
    if(document.getElementById('billing-workspace-css'))return;
    const style=document.createElement('style');style.id='billing-workspace-css';style.textContent=`
      .bw{container-type:inline-size;container-name:billing; width:100%;min-width:0;color:#182230;font-size:13px;line-height:1.5}.bw *{box-sizing:border-box}.bw h2{font-size:24px;letter-spacing:-.035em;margin:0}.bw h3{font-size:16px;margin:0}.bw h4{margin:0;font-size:13px}.bw p{margin:4px 0;color:#667085}.bw small{font-size:12px;color:#667085}.bw button,.bw select,.bw input{font:inherit}.bw button{cursor:pointer;background:#fff;border:1px solid #d0d5dd;border-radius:5px;padding:8px 12px;color:#344054;font-weight:600}.bw button:hover{background:#f8fafc}.bw button.primary{background:#182230;color:white;border-color:#182230}.bw button:disabled{opacity:.5;cursor:default}.bw button.link{border:0;padding:4px 0;background:none;color:#344054;text-decoration:underline;text-underline-offset:3px}.bw-head,.bw-row{display:flex;justify-content:space-between;align-items:center;gap:16px}.bw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.bw-head{margin-bottom:24px}.bw-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid #d0d5dd;border-bottom:1px solid #d0d5dd;margin-bottom:28px}.bw-summary.bw-platform-only{grid-template-columns:repeat(2,minmax(0,1fr))}.bw-metric{padding:22px 24px;border-left:1px solid #eaecf0}.bw-metric:first-child{padding-left:0;border-left:0}.bw-metric strong{display:block;font-size:30px;letter-spacing:-.04em;line-height:1.3;margin:5px 0}.bw-metric .bw-row{align-items:end;flex-wrap:wrap}.bw-main{display:grid;grid-template-columns:minmax(0,2fr) minmax(240px,1fr);gap:32px;margin-bottom:32px}.bw-section{min-width:0}.bw-section>.bw-row{margin-bottom:12px}.bw-aside{border-left:1px solid #eaecf0;padding-left:28px}.bw-subscription{padding:14px 0;border-bottom:1px solid #eaecf0}.bw-subscription .bw-row{align-items:start}.bw-amount{white-space:nowrap;font-variant-numeric:tabular-nums}.bw-usage{margin-top:20px}.bw-usage summary{font-weight:600;cursor:pointer}.bw-usage .bw-row{padding:8px 0;border-bottom:1px solid #f2f4f7}.bw-statement{border-top:1px solid #d0d5dd;padding-top:24px}.bw-statement-head{display:flex;justify-content:space-between;gap:18px;align-items:start;flex-wrap:wrap}.bw select,.bw input[type=month]{border:1px solid #d0d5dd;border-radius:5px;background:white;padding:8px;color:#344054;min-width:0}.bw-stats{display:flex;gap:32px;flex-wrap:wrap;margin:20px 0;background:#f8fafc;padding:14px 18px}.bw-stats strong{display:block;font-size:18px}.bw-table{width:100%;overflow:auto}.bw table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.bw th{font-weight:600;color:#667085;background:#f8fafc;white-space:nowrap}.bw td,.bw th{padding:12px 10px;border-bottom:1px solid #eaecf0;vertical-align:top}.bw td:first-child,.bw th:first-child{padding-left:0}.bw td:last-child,.bw th:last-child{text-align:right}.bw td small{display:block;max-width:440px;overflow-wrap:anywhere}.bw-tag{font-size:11px;text-transform:capitalize;color:#475467}.bw-empty{padding:24px 0;color:#667085}.bw-error{color:#b42318;margin:8px 0}.bw-notice{padding:10px 0;border-bottom:1px solid #eaecf0}.bw dialog{border:1px solid #d0d5dd;border-radius:8px;padding:24px;width:min(680px,calc(100% - 24px));max-height:90vh;overflow:auto;color:#182230}.bw dialog::backdrop{background:#10182888}.bw dialog .bw-head{margin-bottom:16px}.bw dialog .bl-card{border:0;box-shadow:none;border-radius:0;padding:0;margin:0;background:none}.bw dialog .bl-h,.bw dialog .bl-sub{display:none}.bw dialog .bl-pill{background:none;border:0;padding:0;border-radius:0}.bw dialog .bl-summary,.bw dialog .bl-toggleLine,.bw dialog .bl-moneyWrap,.bw dialog .bl-money{border-radius:4px}.bw dialog .cs-btn{box-shadow:none}.bw dialog .bl-toggleLine{background:none}.bw [hidden]{display:none!important}
      @media(max-width:1050px){.bw-main{grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr);gap:20px}.bw-aside{padding-left:20px}.bw-metric{padding:18px}.bw-metric strong{font-size:26px}}
      @container billing (max-width:650px){.bw-head{align-items:start;flex-wrap:wrap;gap:10px}.bw-summary,.bw-summary.bw-platform-only{grid-template-columns:1fr}.bw-metric,.bw-metric:first-child{padding:14px 0;border-left:0;border-bottom:1px solid #eaecf0}.bw-metric:last-child{border-bottom:0}.bw-main{grid-template-columns:1fr;gap:24px}.bw-aside{border-left:0;padding-left:0;border-top:1px solid #eaecf0;padding-top:20px}.bw-stats{gap:16px;padding:12px}.bw-stats strong{font-size:16px}.bw-actions{gap:6px}.bw td,.bw th{padding:10px 8px}.bw table{min-width:620px}.bw dialog{padding:18px}.bw-statement-head>.bw-actions{width:100%}.bw-statement-head input{flex:1}.bw-subscription .bw-row{flex-wrap:wrap}}
    `;document.head.appendChild(style);
  }
  async function mountWorkspace(host,options={}){
    workspaceStyles();const token={};host._billingMount=token;
    const api=apiFor(options.orgId), currentMonth=new Date().toISOString().slice(0,7);
    let period=currentMonth,filter='all',data=null,ledger=[],errors=[],rows=[],generation=0,busy=false,notice='';
    const active=()=>host.isConnected&&host._billingMount===token;
    const subscriptions=()=> (data?.subscriptions||[]).filter(s=>!s.ends_at||s.ends_at>new Date().toISOString());
    const amount=value=>money(Math.round(Number(value)*100));
    const titleMonth=()=>new Date(period+'-02T12:00:00Z').toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'});
    function modal(title,body){
      const dialog=document.createElement('dialog');dialog.setAttribute('aria-label',title);dialog.innerHTML=`<header class="bw-head"><h3>${esc(title)}</h3><button data-close aria-label="Close ${esc(title)}">Close</button></header><div data-body>${body}</div>`;host.querySelector('.bw').appendChild(dialog);
      dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();return dialog;
    }
    async function load(){
      const run=++generation,selected=period;
      host.setAttribute('aria-busy','true');host.querySelectorAll('button').forEach(button=>button.disabled=true);
      const results=await Promise.allSettled([api('?period='+selected),options.credits?options.credits.statement(Number(selected.slice(5)),Number(selected.slice(0,4))):Promise.resolve({ok:true,transactions:[]})]);
      if(!active()||run!==generation)return;
      errors=[];data=results[0].status==='fulfilled'?results[0].value:null;
      if(!data)errors.push('Subscriptions and usage could not be loaded. Refresh to try again.');
      const credit=results[1].status==='fulfilled'?results[1].value:null;
      ledger=credit?.ok?(credit.transactions||credit.ledger||[]):[];
      if(!credit?.ok)errors.push('Measurement-credit statement could not be loaded. Totals are incomplete.');
      rows=statementRows(period,ledger,data||{},options.credits?.describe);render();host.removeAttribute('aria-busy');
    }
    async function act(operation){
      if(busy)return;busy=true;host.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{await operation();await load();}catch(error){notice=error.message||'Could not complete this action.';render();}finally{busy=false;}
    }
    function renderStatement(){
      const visible=rows.filter(row=>filter==='all'||row.service===filter);
      const paid=rows.reduce((sum,r)=>sum+(r.paid||0),0),due=rows.reduce((sum,r)=>sum+(r.due||0),0),creditDelta=rows.reduce((sum,r)=>sum+(r.credits||0),0);
      const target=host.querySelector('[data-statement]');
      target.innerHTML=`<div class="bw-stats"><div><small>Payments on listed transactions</small><strong>${money(paid)}</strong></div><div><small>Outstanding invoices</small><strong>${money(due)}</strong></div>${options.credits?`<div><small>Net measurement-credit change</small><strong>${amount(creditDelta)}</strong></div>`:''}</div>
        <div class="bw-row" style="margin-bottom:12px"><h4>Billing history <small>· ${visible.length} transactions</small></h4><label><span class="sr-only">Filter history</span><select aria-label="Filter history" data-filter><option value="all">All services</option>${options.credits?'<option value="credits">Measurement credits</option>':''}<option value="subscriptions">Subscriptions</option><option value="usage">Usage</option></select></label></div>
        <div class="bw-table"><table><thead><tr><th>Date</th><th>Transaction</th><th>Status</th><th>Paid / due</th>${options.credits?'<th>Credit change</th>':''}<th></th></tr></thead><tbody>${visible.map(r=>`<tr><td class="bw-amount">${esc(new Date(r.at).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'}))}</td><td><strong>${esc(r.title)}</strong><small>${esc(r.detail)}</small><small>${r.service==='credits'?'Measurement credits':r.service==='subscriptions'?'Subscriptions':'Usage'}</small></td><td><span class="bw-tag">${esc(r.status)}</span></td><td class="bw-amount">${r.paid!=null?money(r.paid)+(r.due?'<small>'+money(r.due)+' due</small>':''):r.due?money(r.due)+' due':r.paymentUnknown?'Not recorded':'—'}</td>${options.credits?`<td class="bw-amount">${r.credits==null?'—':(r.credits>0?'+':'')+amount(r.credits)}</td>`:''}<td>${r.invoice?`<button class="link" data-invoice="${esc(r.id)}">Details</button>`:''}</td></tr>`).join('')||`<tr><td colspan="6"><div class="bw-empty">${errors.length?'Some billing records are unavailable.':'No transactions for this month'+(filter==='all'?'': ' and service')+'.'}</div></td></tr>`}</tbody></table></div><p style="margin-top:10px"><small>Transactions posted in ${esc(titleMonth())} (UTC). Credit changes are prepaid balance movements. Usage estimates are billed after month end.${rows.some(r=>r.paymentUnknown)?' Older purchases without a recorded payment amount are excluded from payment totals.':''}</small></p>`;
      target.querySelector('[data-filter]').value=filter;target.querySelector('[data-filter]').onchange=e=>{filter=e.target.value;renderStatement();};
      target.querySelectorAll('[data-invoice]').forEach(button=>button.onclick=()=>{
        const row=rows.find(r=>r.id===button.dataset.invoice),invoice=row.invoice;
        const dialog=modal(row.title,`<p>${esc(row.detail)} · ${esc(row.status)}</p>${row.lines.map(line=>`<div class="bw-row bw-subscription"><span>${esc(line.label)}</span><strong>${money(line.amount_cents)}</strong></div>`).join('')}<div class="bw-row bw-subscription"><strong>Total</strong><strong>${money(invoice.total_cents)}</strong></div>${invoice.url?'<button class="primary" data-receipt>View invoice / receipt</button>':row.service==='usage'&&row.due?'<p>Charged automatically to your subscription payment method.</p>':''}`);
        dialog.querySelector('[data-receipt]')?.addEventListener('click',()=>{try{root.location.assign(stripeUrl(invoice.url));}catch(e){notice=e.message;dialog.close();render();}});
        dialog.querySelector('[data-pay]')?.addEventListener('click',()=>{dialog.close();void act(async()=>{const result=await api('/invoices/'+encodeURIComponent(invoice.id)+'/checkout','POST');root.location.assign(stripeUrl(result.url));});});
      });
    }
    function render(){
      if(!active())return;
      const subs=subscriptions(),monthly=subs.filter(s=>!s.ends_at).reduce((sum,s)=>sum+s.price.monthly_cents,0),credit=options.credits?.settings();
      host.innerHTML=`<div class="bw" data-settings-autosave="off"><header class="bw-head"><div><h2>Billing</h2><p>Credits, subscriptions and payments in one place.</p></div><div class="bw-actions">${data?.operator?'<button class="link" data-admin>Billing administration</button>':''}<button data-refresh>Refresh</button></div></header>
      <div role="status" aria-live="polite">${errors.map(error=>`<p class="bw-error">${esc(error)}</p>`).join('')}${notice?`<p>${esc(notice)}</p>`:''}</div>
      <div class="bw-summary ${!options.credits?'bw-platform-only':''}">${options.credits?`<div class="bw-metric"><small>Measurement credits</small><div class="bw-row"><strong class="credits-val-target">—</strong><button data-buy-credits="settings_billing">Add credit</button></div><small>Available for measurement orders</small></div>`:''}<div class="bw-metric"><small>Monthly subscriptions</small><strong>${data?money(monthly):'Unavailable'}</strong><small>${subs.length} active · usage billed separately</small></div><div class="bw-metric"><small>${esc(titleMonth())} usage</small><strong>${data?money(data.estimate.total_cents):'Unavailable'}</strong><small>Estimate to date · before tax</small></div></div>
      <div class="bw-main"><section class="bw-section"><div class="bw-row"><h3>Subscriptions</h3>${data?.can_manage?'<button data-add>Add subscription</button>':''}</div><p><strong>Basic AI</strong> · Included free</p>${subs.map(s=>`<div class="bw-subscription"><div class="bw-row"><div><h4>${esc(s.price.name)}</h4><p>${esc(s.price.description||'')}</p><small>${s.ends_at?'Access until '+esc(date(s.ends_at)):s.paid_through?'Renews '+esc(new Date(s.paid_through).toLocaleDateString()):'Renews monthly'}${s.price.rates.length?' · Includes usage pricing':''}</small></div><div style="text-align:right"><strong class="bw-amount">${money(s.price.monthly_cents)}<small> / mo</small></strong>${data.can_manage?`<div class="bw-actions">${!s.ends_at?`<button class="link" data-change="${esc(s.product_id)}">Change plan</button><button class="link" data-cancel="${esc(s.id)}">Cancel renewal</button>`:`<button class="link" data-renew="${esc(s.id)}">Resume renewal</button>`}</div>`:''}</div></div>${s.price.rates.length?`<details class="bw-usage"><summary>Included usage & rates</summary>${s.price.rates.map(r=>`<p>${esc(data.meters.find(m=>m.id===r.meter)?.label||r.meter)}: ${esc(r.included)} included; $${esc(r.unit_price_micros/1e6)} per ${esc(r.unit_quantity)} units.</p>`).join('')}</details>`:''}</div>`).join('')||'<p class="bw-empty">'+(data?'No active subscriptions.':'Subscriptions unavailable.')+'</p>'}
      ${data?.sms_allowance?`<div class="bw-notice"><strong>SMS · ${data.sms_allowance.used.toLocaleString()} / ${data.sms_allowance.limit.toLocaleString()} messages</strong><p>${data.sms_allowance.paused?'Sending paused. Upgrade your SMS plan or wait for renewal.':'Allowance renews '+esc(new Date(data.sms_allowance.renews_at).toLocaleDateString())+'. No overage charges.'}</p></div>`:''}
      ${(data?.purchases||[]).map(p=>`<div class="bw-notice bw-row"><span>${esc(p.name)} · Payment pending</span>${data.can_manage?`<div class="bw-actions"><button data-resume="${esc(p.id)}">Resume checkout</button><button data-abandon="${esc(p.id)}">Cancel</button></div>`:''}</div>`).join('')}
      <details class="bw-usage"><summary>Usage & storage</summary>${data?.storage_allowance!=null?`<p>${(data.storage_allowance/1e9).toLocaleString()} GB storage allowance</p>`:''}${data?.storage?`<p>${(Number(data.storage.quantity)/1073741824).toFixed(2)} GiB stored · measured ${esc(date(data.storage.occurred_at))}</p>`:'<p>Storage has not been measured yet.</p>'}${(data?.estimate.lines||[]).map(line=>`<div class="bw-row"><div>${esc(line.label)}<small> · ${esc(line.quantity)} units · ${esc(line.included)} included</small></div><strong>${money(line.amount_cents)}</strong></div>`).join('')||'<p>No metered charges for this month.</p>'}${data?.sync?`<p><small>Updated ${esc(date(data.sync.at))}${data.sync.error?' · '+esc(data.sync.error):data.sync.complete?'':' · Catch-up in progress'}</small></p>`:''}${data?.late_usage?.length?'<p>Late usage is awaiting an operator adjustment.</p>':''}</details></section>
      <aside class="bw-section bw-aside">${credit?`<div class="bw-row"><h3>Credit auto top-up</h3><button class="link" data-topup>Manage</button></div><h4>${credit.enabled?'On':'Off'}</h4><p>${credit.enabled?'Add '+amount(credit.amount)+' when credits fall below '+amount(credit.threshold)+'.':'Add measurement credits automatically when your balance runs low.'}</p><div style="margin-top:20px"><h4>Credit payment method</h4><p>${esc(credit.card||'No saved card')}</p></div>`:'<h3>Payment timing</h3>'}<div style="margin-top:20px"><h4>Subscription payment method</h4><p>${data?.has_customer?(data.payment_details?.has_payment_method?'Saved securely with Stripe.':'Manage your saved card with Stripe.'):'Saved during your first checkout.'}</p>${data?.has_customer&&data.can_manage?'<button data-card>Manage payment details</button>':''}${['past_due','unpaid','incomplete'].includes(data?.payment_details?.status)?'<p class="bw-error">Your automatic payment needs attention. Update your payment method to restore renewal.</p>':''}</div><p style="margin-top:20px"><small>Subscriptions charge automatically each month. Add-ons show the updated total and the amount due before you pay.</small></p></aside></div>
      <section class="bw-statement"><div class="bw-statement-head"><div><h3>Monthly statement</h3><p>One history for credits, subscriptions and usage.</p></div><div class="bw-actions"><button data-prev aria-label="Previous billing month">‹</button><input type="month" aria-label="Statement month" data-month value="${period}" max="${currentMonth}"><button data-next aria-label="Next billing month" ${period>=currentMonth?'disabled':''}>›</button><button data-export ${errors.length?'disabled':''}>Export CSV</button></div></div><div data-statement></div></section></div>`;
      renderStatement();options.credits?.refreshBalance();
      host.querySelector('[data-refresh]').onclick=()=>act(async()=>{if(data?.can_manage)await api('/refresh','POST');});
      const changeMonth=value=>{if(!/^\d{4}-\d{2}$/.test(value)||value>currentMonth)return;period=value;void load();};
      host.querySelector('[data-month]').onchange=e=>changeMonth(e.target.value);
      for(const [key,delta] of [['prev',-1],['next',1]])host.querySelector('[data-'+key+']').onclick=()=>{const d=new Date(period+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+delta);changeMonth(d.toISOString().slice(0,7));};
      host.querySelector('[data-export]').onclick=()=>{const url=URL.createObjectURL(new Blob(['\uFEFF'+statementCsv(rows)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='billing-statement-'+period+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      host.querySelector('[data-topup]')?.addEventListener('click',()=>options.credits.open());
      function choosePlan(product){
        const latest=new Map();for(const p of data.prices)if(p.published&&(!latest.has(planKey(p))||latest.get(planKey(p)).version<p.version))latest.set(planKey(p),p);
        const available=[...latest.values()].filter(p=>product?p.product_id===product:!subs.some(s=>s.product_id===p.product_id));
        const dialog=modal(product?'Change plan':'Add subscription',available.map(p=>`<div class="bw-subscription"><div class="bw-row"><div><h4>${esc(p.name)}</h4><p>${esc(p.description)}</p>${highlights(p)}<strong>${money(p.monthly_cents)} / month${p.rates.length?' + usage':''}</strong></div><button data-subscribe="${esc(p.id)}" ${subs.some(s=>s.price.id===p.id)?'disabled':''}>${subs.some(s=>s.price.id===p.id)?'Current plan':'Review '+(product?'change':'& add')}</button></div></div>`).join('')+(available.some(p=>p.product_id==='sms')?'<div class="bw-subscription"><h4>SMS Enterprise</h4><p>Need a larger allowance? Contact your account team for a custom monthly plan.</p></div>':'')||'<p>No additional subscriptions are available.</p>');
        dialog.querySelectorAll('[data-subscribe]').forEach(b=>b.onclick=()=>{dialog.close();void act(()=>review({orgId:options.orgId,priceId:b.dataset.subscribe}));});
      }
      host.querySelector('[data-add]')?.addEventListener('click',()=>choosePlan());
      host.querySelectorAll('[data-change]').forEach(b=>b.onclick=()=>choosePlan(b.dataset.change));
      host.querySelectorAll('[data-renew]').forEach(b=>b.onclick=()=>act(()=>api('/subscriptions/'+encodeURIComponent(b.dataset.renew)+'/resume','POST')));
      host.querySelector('[data-card]')?.addEventListener('click',()=>act(async()=>{const result=await api('/customer-portal','POST');root.location.assign(stripeUrl(result.url));}));
      host.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{if(root.confirm('Stop renewing this subscription? Access continues through the paid period.'))void act(()=>api('/subscriptions/'+encodeURIComponent(b.dataset.cancel)+'/cancel','POST'));});
      host.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>act(async()=>{const result=await api('/subscription-checkouts','POST',{quote_id:b.dataset.resume,accept_terms:true});if(result.url)root.location.assign(stripeUrl(result.url));}));
      host.querySelectorAll('[data-abandon]').forEach(b=>b.onclick=()=>act(()=>api('/subscription-checkouts/'+encodeURIComponent(b.dataset.abandon)+'/cancel','POST')));
      host.querySelector('[data-admin]')?.addEventListener('click',()=>{const dialog=modal('Billing administration','<div data-admin-host></div>');void mount(dialog.querySelector('[data-admin-host]'),{orgId:options.orgId,adminOnly:true});dialog.addEventListener('close',()=>void load(),{once:true});});
    }
    host._billingRefresh=load;host.innerHTML='<p role="status">Loading billing…</p>';await load();
    const returningId=new URLSearchParams(root.location.search).get('billing_checkout')||new URLSearchParams(root.location.search).get('billing_portal');
    if(active()&&data?.can_manage&&returningId)await act(async()=>{await api('/subscription-checkouts/refresh','POST');await root.PlatformAPI.appFlags?.load?.(options.orgId,{refresh:true});notice='Checkout status refreshed. Your current subscriptions and any pending payments are shown below.';const url=new URL(root.location.href);url.searchParams.delete('billing_checkout');url.searchParams.delete('billing_portal');root.history.replaceState(root.history.state,'',url.href);});
  }

  root.FirstMatePlatformBilling={mount,mountWorkspace,statementRows,statementCsv,isEnabled,configured,review,setup};
})(window);
