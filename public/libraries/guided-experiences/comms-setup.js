// The Communications setup (guided experience `comms.setup`, docs/architecture/guided-experiences.md, FM-491).
// One step that keeps its own pages: what Communications does (texts, calls, email), which to set up first, a simple
// page for each, the texting plan, then the other one or on to Communications. Every write is a published action run
// as the person (comms.setup.start); the texting plan is bought through platform billing's own quote and checkout
// (FirstMatePlatformBilling.review: the card on file, else Stripe). Copy is gx_ keys with English fallbacks; the
// library entry's options may replace the opening headline and say which channel a place starts with (`first`).
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxc{display:flex;flex-direction:column;gap:18px;min-width:0;padding:2px 0 8px;color:#101828}
.gxc p{margin:0;color:#475467;line-height:1.55}
.gxc-hero h3{margin:0 0 6px;font-size:22px;line-height:1.25;font-weight:800;letter-spacing:-.01em}
.gxc-ways{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.gxc-way{position:relative;display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;animation:gxcIn .3s cubic-bezier(.22,1,.36,1) both}
.gxc-way strong{font-size:15px}.gxc-way p{font-size:13px}
.gxc-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px;flex:none}
.gxc-on{position:absolute;top:14px;right:14px;font-size:11px;font-weight:750;color:#067647;background:#ecfdf3;border-radius:999px;padding:2px 8px}
.gxc-choose{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.gxc-choice{display:flex;align-items:center;gap:14px;min-height:76px;padding:14px 16px;border:1px solid #d0d5dd;border-radius:16px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,box-shadow .2s,transform .15s}
.gxc-choice:hover{border-color:var(--primary,#d93025);transform:translateY(-1px)}
.gxc-choice:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxc-choice strong{display:block;font-size:15px}.gxc-choice small{display:block;font-size:13px;color:#667085;margin-top:2px}
.gxc-choice[data-first]{border-color:var(--primary,#d93025);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxc-label{font-size:13px;font-weight:750;color:#344054}
.gxc-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}
.gxc-list li{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1px solid #eaecf0;border-radius:14px;background:#fcfcfd}
.gxc-list strong{display:block;font-size:14px;margin-bottom:2px}.gxc-list p{font-size:13px}
.gxc-done{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:14px;background:#ecfdf3;color:#05603a}
.gxc-done strong{display:block;font-size:15px;color:#05603a}.gxc-done p{color:#067647;font-size:13px}
.gxc-check{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#12b76a;color:#fff;font-size:13px}
.gxc-address{font:600 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#101828;word-break:break-all}
.gxc-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.gxc-plan{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid #e4e7ec;border-radius:16px;background:#fff}
.gxc-plan h4{margin:0;font-size:15px}.gxc-plan b{font-size:18px}.gxc-plan p{font-size:13px}
.gxc-pay{display:flex;gap:10px;align-items:center;font-size:13px;color:#475467}
.gxc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:4px}
.gxc-actions .gxc-spacer{flex:1}
.gxc-btn{height:40px;padding:0 16px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.gxc-btn:hover{background:#f9fafb}.gxc-btn:disabled{opacity:.55;cursor:default}
.gxc-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
.gxc-btn.primary:hover{filter:brightness(.95)}
.gxc-error{color:#b42318;font-size:13px;min-height:1em}
.gxc-note{font-size:12.5px;color:#667085}
@media(max-width:640px){.gxc-ways,.gxc-choose{grid-template-columns:minmax(0,1fr)}.gxc-way{flex-direction:row;align-items:flex-start;gap:12px;padding:14px}.gxc-way>div{min-width:0}.gxc-hero h3{font-size:19px}.gxc-actions .gxc-btn{flex:1 1 auto;justify-content:center}.gxc-actions .gxc-spacer{display:none}}
@keyframes gxcIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.gxc *{animation:none!important;transition:none!important}}
`;

function installStyle(){
  if (document.getElementById('gxc-css')) return;
  const style = document.createElement('style');
  style.id = 'gxc-css';
  style.textContent = css;
  document.head.appendChild(style);
}
function loadScript(src){
  return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('load failed')); }; document.head.append(script); });
}
async function syncSessions(orgId){
  const wins = new Set([window]);
  try { if (window.top.location.origin === location.origin) wins.add(window.top); } catch {}
  await Promise.all([...wins].map(async (win) => {
    await Promise.all([win.PlatformAPI?.capabilities?.load?.(orgId, { refresh: true }), win.PlatformAPI?.appFlags?.load?.(orgId, { refresh: true })].map((p) => Promise.resolve(p).catch(() => null)));
    await Promise.resolve(win.Portal?.auth?.syncPlatformSession?.()).catch(() => null);
    // The project Comms tab and the Communications page redraw their channels (Texts, Email) from the new switches.
    win.dispatchEvent(new CustomEvent('fm:comms:setup-changed'));
  }));
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const text = (copy, fallback = '') => { const value = object(copy); return value.key ? ctx.L(value.key, clean(value.text) || fallback) : clean(copy) || fallback; };
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const options = object(ctx.options);
  const first = options.first === 'email' ? 'email' : 'phone';
  let alive = true, busy = false, page = 'intro', status = { phone: {}, email: {}, done: {} }, billing = null, last = '';

  const invoke = async (action, input = {}) => {
    const key = action === 'comms.setup.start' ? `comms.setup.start:${orgId}:${input.channel}:${Date.now()}` : undefined;
    const result = await window.PlatformAPI.publication.invoke(orgId, action, { scope: 'organization', organizationId: orgId }, input, key ? { idempotencyKey: key } : {});
    return object(result.value ?? result.result ?? result);
  };
  const names = {
    phone: () => L('gx_comms_phone_name', 'Texts and calls'),
    email: () => L('gx_comms_email_name', 'Email')
  };
  const icon = (name) => `<span class="gxc-icon" aria-hidden="true"><i class="fas ${name}"></i></span>`;
  const check = '<span class="gxc-check" aria-hidden="true"><i class="fas fa-check"></i></span>';
  const errorLine = '<p class="gxc-error" role="alert" data-gxc-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxc-error]'); if (node) node.textContent = clean(error?.message) || L('gx_comms_error', 'That didn’t work. Try again.'); };
  const working = (button, on) => { busy = on; if (button) button.disabled = on; };

  function show(next){ page = next; draw(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); }

  function drawIntro(){
    ctx.setTitle?.('');
    const done = object(status.done);
    const ways = [
      ['sms', 'fa-comment-sms', L('gx_comms_way_texts', 'Texts'), L('gx_comms_way_texts_body', 'Text customers from any project. Their replies come back to the project.'), done.phone],
      ['calls', 'fa-phone', L('gx_comms_way_calls', 'Calls'), L('gx_comms_way_calls_body', 'Call from FirstMate with the customer’s details beside you. Notes and outcomes are saved.'), done.phone],
      ['email', 'fa-envelope', L('gx_comms_way_email', 'Email'), L('gx_comms_way_email_body', 'A company inbox. Email customers from a project and see every reply there.'), done.email]
    ];
    const choice = (id, iconName, body) => `<button type="button" class="gxc-choice" data-gxc-start="${id}" ${id === first ? 'data-first' : ''}>${icon(iconName)}<span><strong>${esc(done[id] ? L('gx_comms_review', 'Review {name}', { name: names[id]() }) : L('gx_comms_setup_name', 'Set up {name}', { name: names[id]().toLowerCase() }))}</strong><small>${esc(body)}</small></span></button>`;
    const order = first === 'email' ? ['email', 'phone'] : ['phone', 'email'];
    el.innerHTML = `<div class="gxc">
      <div class="gxc-hero"><h3>${esc(text(options.headline, L('gx_comms_intro_headline', 'Every conversation with your customers, in one place')))}</h3>
        <p>${esc(text(options.body, L('gx_comms_intro_body', 'Text, call and email customers from FirstMate. Everything you send and receive is saved on the project, so anyone on your team can pick it up.')))}</p></div>
      <div class="gxc-ways">${ways.map(([id, iconName, title, body, on], index) => `<div class="gxc-way" data-gxc-way="${id}" style="animation-delay:${index * 50}ms">${icon(iconName)}<div><strong>${esc(title)}</strong><p>${esc(body)}</p></div>${on ? `<span class="gxc-on">${esc(L('gx_comms_on', 'On'))}</span>` : ''}</div>`).join('')}</div>
      <span class="gxc-label">${esc(L('gx_comms_where_start', 'Where do you want to start?'))}</span>
      <div class="gxc-choose">${order.map((id) => id === 'phone' ? choice('phone', 'fa-mobile-screen', L('gx_comms_choice_phone', 'Your business number for texting and calling')) : choice('email', 'fa-envelope-open-text', L('gx_comms_choice_email', 'Your company inbox for customer email'))).join('')}</div>
      ${done.phone && done.email ? `<div class="gxc-actions"><span class="gxc-spacer"></span><button type="button" class="gxc-btn primary" data-gxc-finish>${esc(L('gx_comms_go', 'Go to Communications'))}</button></div>` : ''}
      ${errorLine}
    </div>`;
    el.querySelectorAll('[data-gxc-start]').forEach((button) => button.addEventListener('click', () => show(button.dataset.gxcStart)));
  }

  function drawPhone(){
    ctx.setTitle?.(names.phone());
    const phone = object(status.phone), on = !!phone.texts;
    const number = array(phone.numbers)[0] || array(phone.texting_numbers)[0] || '';
    el.innerHTML = `<div class="gxc">
      ${on ? `<div class="gxc-done">${check}<div><strong>${esc(L('gx_comms_phone_on', 'Texts are on'))}</strong><p>${esc(L('gx_comms_phone_on_body', 'Every project now has a Texts tab. Calls and texts are saved on the project.'))}</p></div></div>` : `<p>${esc(L('gx_comms_phone_intro', 'Here’s what we’ll set up. Turning it on takes a second; your number takes a few minutes more.'))}</p>`}
      <ul class="gxc-list">
        <li>${icon('fa-comment-sms')}<div><strong>${esc(L('gx_comms_phone_texts', 'Texts on every project'))}</strong><p>${esc(L('gx_comms_phone_texts_body', 'Text a customer from their project. Replies come back to the same project.'))}</p></div></li>
        <li>${icon('fa-phone')}<div><strong>${esc(L('gx_comms_phone_calls', 'Calls from FirstMate'))}</strong><p>${esc(phone.calls ? L('gx_comms_phone_calls_ready', 'Calls are ready: press New call on any project.') : L('gx_comms_phone_calls_body', 'Call from your browser or your phone, with notes, outcomes and recordings saved to the project.'))}</p></div></li>
        <li>${icon('fa-id-card')}<div><strong>${esc(L('gx_comms_phone_number', 'Your business number'))}</strong><p>${esc(number ? L('gx_comms_phone_number_ready', 'Texts and calls use {number}.', { number }) : L('gx_comms_phone_number_body', 'Phone carriers ask every business to register before it texts customers. It takes about 10 minutes, then a few days to be approved; we’ll walk you through it.'))}</p></div></li>
      </ul>
      ${errorLine}
      <div class="gxc-actions">
        <button type="button" class="gxc-btn" data-gxc-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
        <span class="gxc-spacer"></span>
        ${on ? `${number ? '' : `<button type="button" class="gxc-btn" data-gxc-register>${esc(L('gx_comms_register', 'Register my business'))}</button>`}<button type="button" class="gxc-btn primary" data-gxc-continue>${esc(L('gx_ui_continue', 'Continue'))}</button>` : `<button type="button" class="gxc-btn primary" data-gxc-turn-on="phone">${esc(L('gx_comms_phone_turn_on', 'Turn on texts and calls'))}</button>`}
      </div>
    </div>`;
    el.querySelector('[data-gxc-back]').addEventListener('click', () => show('intro'));
    el.querySelector('[data-gxc-turn-on]')?.addEventListener('click', (event) => turnOn('phone', event.currentTarget));
    el.querySelector('[data-gxc-continue]')?.addEventListener('click', async (event) => { working(event.currentTarget, true); try { show(await billingAvailable() ? 'billing' : 'next'); } finally { busy = false; } });
    el.querySelector('[data-gxc-register]')?.addEventListener('click', () => finish('register'));
  }

  function drawEmail(){
    ctx.setTitle?.(names.email());
    const email = object(status.email), on = !!email.on;
    el.innerHTML = `<div class="gxc">
      ${on ? `<div class="gxc-done">${check}<div><strong>${esc(L('gx_comms_email_on', 'Email is on'))}</strong><p>${esc(L('gx_comms_email_on_body', 'Every project now has an Email tab. Customers can write to your company address:'))}</p>${email.address ? `<p class="gxc-address" data-gxc-address>${esc(email.address)}</p>` : ''}</div></div>` : `<p>${esc(L('gx_comms_email_intro', 'Your company gets its own FirstMate inbox. There’s nothing to install.'))}</p>`}
      <ul class="gxc-list">
        <li>${icon('fa-inbox')}<div><strong>${esc(L('gx_comms_email_inbox', 'A company inbox'))}</strong><p>${esc(L('gx_comms_email_inbox_body', 'Customer email lands on the right project, so your whole team sees the conversation.'))}</p></div></li>
        <li>${icon('fa-paper-plane')}<div><strong>${esc(L('gx_comms_email_send', 'Send from any project'))}</strong><p>${esc(L('gx_comms_email_send_body', 'Write to a customer from their project; replies come back to it.'))}</p></div></li>
      </ul>
      ${errorLine}
      <div class="gxc-actions">
        <button type="button" class="gxc-btn" data-gxc-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
        <span class="gxc-spacer"></span>
        ${on ? `<button type="button" class="gxc-btn primary" data-gxc-continue>${esc(L('gx_ui_continue', 'Continue'))}</button>` : `<button type="button" class="gxc-btn primary" data-gxc-turn-on="email">${esc(L('gx_comms_email_turn_on', 'Turn on email'))}</button>`}
      </div>
    </div>`;
    el.querySelector('[data-gxc-back]').addEventListener('click', () => show('intro'));
    el.querySelector('[data-gxc-turn-on]')?.addEventListener('click', (event) => turnOn('email', event.currentTarget));
    el.querySelector('[data-gxc-continue]')?.addEventListener('click', () => show('next'));
  }

  // The texting plan: platform billing's SMS prices. Where billing is not offered (or nothing is for sale), no page.
  async function billingAvailable(){
    if (billing) return billing.plans.length > 0;
    billing = { plans: [], data: null };
    try {
      if (!window.FirstMatePlatformBilling) await loadScript('/libraries/apps/settings/platform-billing.js');
      if (!window.FirstMatePlatformBilling?.isEnabled?.()) return false;
      const base = window.PlatformAPI.baseUrl().replace(/\/platform\/?$/, '/platform-billing');
      const data = await window.PlatformAPI.request(`${base}/organizations/${encodeURIComponent(orgId)}`);
      const latest = new Map();
      for (const price of array(data.prices)) {
        if (!price.published || price.capability_key !== 'comms.sms' || price.placeholder) continue;
        const key = `${price.product_id}:${price.plan_key || 'default'}`;
        if (!latest.has(key) || latest.get(key).version < price.version) latest.set(key, price);
      }
      billing = { data, plans: [...latest.values()].sort((a, b) => a.monthly_cents - b.monthly_cents) };
    } catch { billing = { plans: [], data: null }; }
    return billing.plans.length > 0;
  }
  function drawBilling(){
    ctx.setTitle?.(L('gx_comms_billing_title', 'Add a texting plan'));
    const data = object(billing?.data), now = new Date().toISOString();
    const current = array(data.subscriptions).find((sub) => sub.product_id === 'sms' && (!sub.ends_at || sub.ends_at > now));
    const card = object(data.payment_details).has_payment_method === true;
    const money = (plan) => new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency || 'USD' }).format(Number(plan.monthly_cents || 0) / 10 ** (plan.minor_digits ?? 2));
    el.innerHTML = `<div class="gxc">
      <p>${esc(L('gx_comms_billing_body', 'Texting is a monthly plan on your FirstMate subscription. Pick one now, or later in Settings › Billing.'))}</p>
      ${current ? `<div class="gxc-done">${check}<div><strong>${esc(L('gx_comms_billing_current', 'You’re on {plan}', { plan: current.price?.name || current.name || 'SMS' }))}</strong></div></div>` : ''}
      <div class="gxc-plans">${array(billing?.plans).map((plan) => { const mine = current && (current.price?.id === plan.id || current.price_id === plan.id); return `<div class="gxc-plan"><h4>${esc(plan.name)}</h4><b>${esc(L('gx_comms_billing_price', '{price} / month', { price: money(plan) }))}</b><p>${esc(plan.description || '')}</p>${data.can_manage && !mine ? `<button type="button" class="gxc-btn primary" data-gxc-plan="${esc(plan.id)}">${esc(current ? L('gx_comms_billing_change', 'Switch to this plan') : L('gx_comms_billing_add', 'Add this plan'))}</button>` : mine ? `<span class="gxc-on" style="position:static;align-self:flex-start">${esc(L('gx_comms_billing_yours', 'Your plan'))}</span>` : ''}</div>`; }).join('')}</div>
      <p class="gxc-pay">${icon(card ? 'fa-credit-card' : 'fa-lock')}<span>${esc(card ? L('gx_comms_billing_card', 'We’ll charge the card you already have on file.') : L('gx_comms_billing_stripe', 'You’ll add a card securely with Stripe, then come back to Settings › Billing.'))}</span></p>
      ${data.can_manage ? '' : `<p class="gxc-note">${esc(L('gx_comms_billing_ask', 'Ask whoever manages billing to add a texting plan.'))}</p>`}
      ${errorLine}
      <div class="gxc-actions">
        <button type="button" class="gxc-btn" data-gxc-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
        <span class="gxc-spacer"></span>
        <button type="button" class="gxc-btn ${current ? 'primary' : ''}" data-gxc-continue>${esc(current ? L('gx_ui_continue', 'Continue') : L('gx_comms_billing_later', 'Not now'))}</button>
      </div>
    </div>`;
    el.querySelector('[data-gxc-back]').addEventListener('click', () => show('phone'));
    el.querySelector('[data-gxc-continue]').addEventListener('click', () => show('next'));
    el.querySelectorAll('[data-gxc-plan]').forEach((button) => button.addEventListener('click', async () => {
      if (busy) return; working(button, true);
      try {
        const paid = await window.FirstMatePlatformBilling.review({ orgId, priceId: button.dataset.gxcPlan });
        if (paid && alive) { billing = null; await billingAvailable(); if (alive) drawBilling(); }
      } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
    }));
  }

  function drawNext(){
    ctx.setTitle?.('');
    const done = object(status.done), other = last === 'email' ? 'phone' : 'email';
    el.innerHTML = `<div class="gxc">
      <div class="gxc-done">${check}<div><strong>${esc(L('gx_comms_next_done', '{name} is set up', { name: names[last || 'phone']() }))}</strong><p>${esc(L('gx_comms_next_body', 'You can change it any time in Settings.'))}</p></div></div>
      ${done[other] ? '' : `<span class="gxc-label">${esc(L('gx_comms_next_other', 'Set up {name} too?', { name: names[other]().toLowerCase() }))}</span>
      <div class="gxc-choose" style="grid-template-columns:minmax(0,1fr)"><button type="button" class="gxc-choice" data-gxc-start="${other}">${icon(other === 'email' ? 'fa-envelope-open-text' : 'fa-mobile-screen')}<span><strong>${esc(L('gx_comms_setup_name', 'Set up {name}', { name: names[other]().toLowerCase() }))}</strong><small>${esc(other === 'email' ? L('gx_comms_choice_email', 'Your company inbox for customer email') : L('gx_comms_choice_phone', 'Your business number for texting and calling'))}</small></span></button></div>`}
      ${errorLine}
      <div class="gxc-actions"><span class="gxc-spacer"></span><button type="button" class="gxc-btn primary" data-gxc-finish>${esc(L('gx_comms_go', 'Go to Communications'))}</button></div>
    </div>`;
    el.querySelector('[data-gxc-start]')?.addEventListener('click', (event) => show(event.currentTarget.dataset.gxcStart));
  }

  async function turnOn(channel, button){
    if (busy) return; working(button, true);
    try {
      status = await invoke('comms.setup.start', { channel });
      last = channel;
      ctx.change({ comms_setup: ['phone', 'email'].filter((id) => object(status.done)[id]) }, names[channel]());
      await syncSessions(orgId);
      if (alive) draw();
    } catch (error) { fail(error); } finally { busy = false; if (button?.isConnected) button.disabled = false; }
  }

  async function finish(then){
    if (busy) return; busy = true;
    try {
      await ctx.complete?.();
      if (then === 'register') {
        // Carrier registration is the 10DLC workflow in Phone Settings; it opens in the portal, not in a project.
        const portal = (() => { try { return window.top.Portal || window.Portal; } catch { return window.Portal; } })();
        portal?.navigation?.push?.({ tab: 'company_settings', sub: 'sms', workflow: '10dlc', project: null, projectTab: null });
        void portal?.navigation?.applyCurrent?.({ source: 'comms-setup' });
      }
    } catch (error) { fail(error); } finally { busy = false; }
  }

  function draw(){
    if (!alive) return;
    if (page === 'phone') drawPhone();
    else if (page === 'email') drawEmail();
    else if (page === 'billing') drawBilling();
    else if (page === 'next') drawNext();
    else drawIntro();
    el.querySelector('[data-gxc-finish]')?.addEventListener('click', () => finish());
  }

  el.innerHTML = '<div class="gxs-module-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';
  // Where the setup was asked for a channel (an Overview button), it opens on that channel's page.
  const top = (() => { try { return window.top.__fmCommsSetupStart !== undefined ? window.top : window; } catch { return window; } })();
  const asked = window.__fmCommsSetupStart || top.__fmCommsSetupStart;
  const start = ['phone', 'email'].includes(asked) ? asked : '';
  window.__fmCommsSetupStart = ''; try { top.__fmCommsSetupStart = ''; } catch {}
  invoke('comms.setup.status').then((value) => { status = value; if (start) page = start; draw(); }).catch((error) => { draw(); fail(error); });
  return { valid: () => true, destroy(){ alive = false; } };
}
export default mount;
