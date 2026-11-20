// The Communications setup (guided experience `comms.setup`, docs/architecture/guided-experiences.md, FM-491, FM-510).
// One step that keeps its own pages, as few as it can: the start (texts, calls and email in a row, each explained in its
// tooltip, and where to start), then one done page. Choosing the business phone (texts and calls, one registration, GP-138)
// turns them on and goes straight into carrier registration (10DLC): the same workflow as Phone Settings
// (settings/sms-registration.js), simulated on development, as more pages of this step: Back on its first page returns
// to the page it was started from, and the phone's back walks its pages first.
// Choosing email asks how it starts (FM-513, FM-590): FirstMate Mail, on at once (the default), the company's own domain,
// or one bought through FirstMate (the Domains workflow, settings/domains.js, full screen like registration). The done page says where each
// channel stands and offers the other one there; the
// texting plan is platform billing's own quote and checkout (FirstMatePlatformBilling.review). Every write is a published
// action run as the person (comms.setup.start). Copy is gx_ keys with English fallbacks; the library entry's options
// may replace the title (`headline`) and the line under it (`subtitle`), and say which channel a place starts with (`first`).
// Texts and calls are set up by texting-setup.js, shared with the appointment setup (FM-515), so both work the same.
// GP-27: an entry may set up email alone (`only: 'email'`, the document Send dialog's first use): it opens on the email
// page, offers nothing else, finishes as soon as FirstMate Mail is on, and its last button says `finish`.
import { commsAction, isRegistered, loadScript, registrationOf, setUpTexting, syncSessions, workflowWindow } from './texting-setup.js?v=20261120-gp138b';
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const DOMAINS_SRCS = ['/libraries/domains-api/domains-api.js?v=20261118-fm590', '/libraries/apps/settings/domains.js?v=20261118-fm590'];

const css = `
.gxc{display:flex;flex-direction:column;gap:18px;min-width:0;padding:2px 0 8px;color:#101828}
.gxc p{margin:0;color:#475467;line-height:1.5}
.gxc-lead{font-size:15px}
.gxc-ways{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.gxc-way{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 8px 14px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;font:inherit;color:#101828;cursor:help;animation:gxcFade .3s ease both}
.gxc-way:hover{border-color:#d0d5dd}
.gxc-way:hover,.gxc-way:focus-visible{z-index:2}
.gxc-way:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxc-way strong{font-size:14px;line-height:1.2}
.gxc-way .gxc-icon{width:44px;height:44px;font-size:19px}
.gxc-way-name{display:inline-flex;align-items:center;gap:6px}
.gxc-i{width:16px;height:16px;border-radius:50%;border:1px solid #d0d5dd;color:#667085;font:italic 700 10px/14px Georgia,serif;text-align:center;flex:none}
.gxc-way-on{font-size:11px;font-weight:750;line-height:1.3;color:#067647;text-align:center}
.gxc-way-on i{margin-right:4px}
.gxc-way-on[data-state=wait]{color:#b54708}
.gxc-way-on[data-state=todo]{color:#b42318}
.gxc-tip{position:absolute;bottom:calc(100% + 9px);left:50%;z-index:3;box-sizing:border-box;width:max-content;max-width:min(280px,calc(100vw - 32px));background:#101828;color:#fff;font-size:13px;font-weight:400;line-height:1.45;text-align:left;border-radius:10px;padding:8px 12px;opacity:0;pointer-events:none;margin-left:var(--gxc-tip-x,0px);transform:translate(-50%,4px);transition:opacity .15s,transform .15s;box-shadow:0 12px 30px rgba(16,24,40,.25)}
.gxc-tip::after{content:"";position:absolute;top:100%;left:calc(50% - var(--gxc-tip-x,0px));margin-left:-6px;border:6px solid transparent;border-top-color:#101828}
.gxc-tip[data-below]{bottom:auto;top:calc(100% + 9px);transform:translate(-50%,-4px)}
.gxc-tip[data-below]::after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:#101828}
/* One tip at a time (FM-598): a clicked card keeps focus, so a tip shows on hover or keyboard focus only, and the card under the pointer wins. */
.gxc-way:hover .gxc-tip,.gxc-way:focus-visible .gxc-tip{opacity:1;transform:translate(-50%,0)}
.gxc-ways:hover .gxc-way:not(:hover) .gxc-tip{opacity:0;transform:translate(-50%,4px)}
.gxc-ways:hover .gxc-way:not(:hover) .gxc-tip[data-below]{transform:translate(-50%,-4px)}
.gxc-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px;flex:none}
.gxc-choose{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.gxc-choice{display:flex;align-items:center;gap:14px;min-height:72px;padding:14px 16px;border:1px solid #d0d5dd;border-radius:16px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,box-shadow .2s,transform .15s}
.gxc-choice:hover{border-color:var(--primary,#d93025);transform:translateY(-1px)}
.gxc-choice:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxc-choice:disabled{opacity:.6;cursor:default;transform:none}
.gxc-choice strong{display:block;font-size:15px}.gxc-choice small{display:block;font-size:13px;color:#667085;margin-top:2px}
.gxc-choice>span:last-child{flex:1;min-width:0}
.gxc-choice[data-first]{border-color:var(--primary,#d93025);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxc-tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:#ecfdf3;color:#067647;font-size:11px;font-weight:750;line-height:18px;vertical-align:1px}
.gxc-tag[data-paid]{background:#f2f4f7;color:#475467}
.gxc-label{font-size:13px;font-weight:750;color:#344054}
.gxc-rows{display:grid;gap:10px}
.gxc-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid #e4e7ec;border-radius:16px;background:#fff}
.gxc-row>div{flex:1;min-width:0}
.gxc-row strong{display:block;font-size:15px}.gxc-row p{font-size:13px}
.gxc-row[data-state=done]{background:#f6fef9;border-color:#d1fadf}
.gxc-row[data-state=wait]{background:#fffcf5;border-color:#fedf89}
.gxc-row[data-state=offer]{border-style:dashed;border-color:#d0d5dd}
.gxc-mark{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:13px;color:#fff;background:#12b76a}
.gxc-row[data-state=wait] .gxc-mark{background:#f79009}
.gxc-row[data-state=todo] .gxc-mark{background:#f04438}
.gxc-row[data-state=offer] .gxc-mark{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary,#d93025)}
.gxc-address{font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#101828;word-break:break-all}
.gxc-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.gxc-plan{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid #e4e7ec;border-radius:16px;background:#fff}
.gxc-plan h4{margin:0;font-size:15px}.gxc-plan b{font-size:18px}.gxc-plan p{font-size:13px}
.gxc-on{font-size:11px;font-weight:750;color:#067647;background:#ecfdf3;border-radius:999px;padding:2px 8px;align-self:flex-start}
.gxc-pay{display:flex;gap:10px;align-items:center;font-size:13px;color:#475467}
.gxc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:4px}
.gxc-actions .gxc-spacer{flex:1}
.gxc-btn{height:40px;padding:0 16px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;white-space:nowrap}
.gxc-btn:hover{background:#f9fafb}.gxc-btn:disabled{opacity:.55;cursor:default}
.gxc-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
.gxc-btn.primary:hover{filter:brightness(.95)}
.gxc-btn.small{height:34px;padding:0 12px;font-size:13px}
.gxc-busy{display:flex;align-items:center;gap:12px;padding:18px 16px;border-radius:16px;background:#f9fafb;color:#475467}
.gxc-error{color:#b42318;font-size:13px;min-height:1em}
.gxc-note{font-size:12.5px;color:#667085}
@media(max-width:640px){.gxc-choose{grid-template-columns:minmax(0,1fr)}.gxc-tip{max-width:calc(100vw - 32px)}.gxc-ways{gap:8px}.gxc-way{padding:14px 4px 12px}.gxc-way strong{font-size:13px}.gxc-row{flex-wrap:wrap}.gxc-row>div{flex-basis:calc(100% - 40px)}.gxc-row .gxc-btn{margin-left:40px}.gxc-actions .gxc-btn{flex:1 1 auto}.gxc-actions .gxc-spacer{display:none}}
/* Each channel's tooltip sits over its own card (under it where the step has no room above), kept inside the row: place(). */
@keyframes gxcFade{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.gxc *{animation:none!important;transition:none!important}}
`;

function installStyle(){
  if (document.getElementById('gxc-css')) return;
  const style = document.createElement('style');
  style.id = 'gxc-css';
  style.textContent = css;
  document.head.appendChild(style);
}
const domainsWindow = () => workflowWindow(DOMAINS_SRCS, (win) => !!(win.DomainsAPI && win.FirstMateDomainsSettings?.openForEmail));
export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const text = (copy, fallback = '') => { const value = object(copy); return value.key ? ctx.L(value.key, clean(value.text) || fallback) : clean(copy) || fallback; };
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const options = object(ctx.options);
  const first = options.first === 'email' || options.only === 'email' ? 'email' : 'phone';
  const only = options.only === 'email' ? 'email' : '';
  const finishLabel = () => text(options.finish, L('gx_comms_go', 'Go to Communications'));
  let alive = true, busy = false, watcher = null, page = 'intro', status = { phone: {}, email: {}, done: {} }, billing = null, domains = null, registering = false, registration = null;

  const invoke = (action, input = {}) => commsAction(orgId, action, input);
  const icon = (name, more = '') => `<span class="gxc-icon${more ? ` ${more}` : ''}" aria-hidden="true"><i class="fas ${name}"></i></span>`;
  const mark = (name) => `<span class="gxc-mark" aria-hidden="true"><i class="fas ${name}"></i></span>`;
  const errorLine = '<p class="gxc-error" role="alert" data-gxc-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxc-error]'); if (node) node.textContent = clean(error?.message) || L('gx_comms_error', 'That didn’t work. Try again.'); };
  const registration = () => registrationOf(status);
  const registered = () => isRegistered(status);

  // One title per page: the step's heading on a wide screen and the top bar on a phone (setTitle) name the page.
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){
    ctx.setTitle?.(value);
    if (heading) heading.innerHTML = value ? esc(value) : stepHeading;
  }
  function show(next){ page = next; draw(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); }

  function drawIntro(){
    title(text(options.headline));
    const done = object(status.done);
    // Texts and calls are on only once carrier registration is approved (FM-586); until then the card says where it stands.
    const state = registration();
    const phoneState = !done.phone ? null
      : state === 'approved' ? ['done', 'fa-check', L('gx_comms_on', 'On')]
        : state === 'submitted' ? ['wait', 'fa-clock', L('gx_comms_awaiting_approval', 'Awaiting approval')]
          : state === 'attention' ? ['todo', 'fa-circle-exclamation', L('gx_comms_needs_attention', 'Needs attention')]
            : ['wait', 'fa-pen', L('gx_comms_needs_review', 'Needs review')];
    const emailState = done.email ? ['done', 'fa-check', L('gx_comms_on', 'On')] : null;
    const ways = [
      ['texts', 'fa-comment-sms', L('gx_comms_way_texts', 'Texts'), L('gx_comms_way_texts_tip', 'Text customers from their project. Replies come back to the same project.'), phoneState],
      ['calls', 'fa-phone', L('gx_comms_way_calls', 'Calls'), L('gx_comms_way_calls_tip', 'Call with the customer’s details beside you. Notes, outcomes and recordings are saved.'), phoneState],
      ['email', 'fa-envelope', L('gx_comms_way_email', 'Email'), L('gx_comms_way_email_tip', 'A company inbox. Every email with a customer lands on their project.'), emailState]
    ];
    const chosen = { phone: phoneState, email: emailState };
    const choices = {
      phone: [L('gx_comms_choice_business_phone', 'Business phone'), L('gx_comms_choice_business_phone_body', 'Texts and calls on your number'), 'fa-phone'],
      email: [L('gx_comms_choice_email_title', 'Email'), L('gx_comms_choice_email', 'Your company inbox'), 'fa-envelope-open-text']
    };
    const choice = (id) => { const [name, body, iconName] = choices[id]; return `<button type="button" class="gxc-choice" data-gxc-start="${id}" ${id === first && !done[id] ? 'data-first' : ''}>${icon(iconName)}<span><strong>${esc(name)}</strong><small>${esc(!chosen[id] ? body : chosen[id][0] === 'done' ? L('gx_comms_choice_on', 'On · review') : chosen[id][2])}</small></span></button>`; };
    el.innerHTML = `<div class="gxc">
      <p class="gxc-lead">${esc(text(options.subtitle || options.body, L('gx_comms_subtitle', 'Every conversation with your customers in one place.')))}</p>
      <div class="gxc-ways">${ways.map(([id, iconName, name, tip, on], index) => `<button type="button" class="gxc-way" data-gxc-way="${id}" aria-describedby="gxc-tip-${id}" style="animation-delay:${index * 50}ms">${icon(iconName)}<span class="gxc-way-name"><strong>${esc(name)}</strong><span class="gxc-i" aria-hidden="true">i</span></span>${on ? `<span class="gxc-way-on" data-state="${on[0]}"><i class="fas ${on[1]}" aria-hidden="true"></i>${esc(on[2])}</span>` : ''}<span class="gxc-tip" role="tooltip" id="gxc-tip-${id}">${esc(tip)}</span></button>`).join('')}</div>
      <span class="gxc-label">${esc(L('gx_comms_where_start', 'Where do you want to start?'))}</span>
      <div class="gxc-choose">${(first === 'email' ? ['email', 'phone'] : ['phone', 'email']).map(choice).join('')}</div>
      ${done.phone && done.email ? `<div class="gxc-actions"><span class="gxc-spacer"></span><button type="button" class="gxc-btn primary" data-gxc-finish>${esc(L('gx_comms_go', 'Go to Communications'))}</button></div>` : ''}
      ${errorLine}
    </div>`;
    el.querySelectorAll('.gxc-way').forEach((way) => { const tip = () => place(way); way.addEventListener('pointerenter', tip); way.addEventListener('focus', tip); });
    // Hidden tips are placed too, so none reaches past the row (and widens the step) before it is shown.
    const row = el.querySelector('.gxc-ways'), placeAll = () => row.querySelectorAll('.gxc-way').forEach(place);
    placeAll();
    watcher?.disconnect(); watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(placeAll) : null; watcher?.observe(row);
    el.querySelectorAll('[data-gxc-start]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.gxcStart;
      if (object(status.done)[id] && (id === 'email' || registered())) return show('done');
      if (id === 'email') return show('email');
      void startPhone(button);
    }));
  }

  // A channel's tooltip goes over its card, or under it where the step's scroll area has no room above, and moves
  // sideways (its arrow staying on the card) so it stays inside the row of channels.
  function place(way){
    const tip = way.querySelector('.gxc-tip'), row = way.closest('.gxc-ways');
    if (!tip || !row) return;
    tip.style.setProperty('--gxc-tip-x', '0px');
    const card = way.getBoundingClientRect(), box = tip.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    const scroller = way.closest('.gxs-step')?.getBoundingClientRect(), top = Math.max(scroller ? scroller.top : 0, 0);
    tip.toggleAttribute('data-below', card.top - top < box.height + 10);
    const left = card.left + card.width / 2 - box.width / 2;
    const shift = Math.min(Math.max(left, bounds.left), Math.max(bounds.left, bounds.right - box.width)) - left;
    tip.style.setProperty('--gxc-tip-x', `${Math.round(shift)}px`);
  }

  function drawBusy(message){
    el.innerHTML = `<div class="gxc"><div class="gxc-busy" role="status"><span class="gxs-spin" aria-hidden="true"></span><span>${esc(message)}</span></div>${errorLine}</div>`;
  }

  // Where each channel stands, and the other one offered right here.
  function drawDone(){
    const phone = object(status.phone), email = object(status.email), done = object(status.done), state = registration();
    const number = array(phone.numbers)[0] || array(phone.texting_numbers)[0] || '';
    title(done.phone && !registered() ? L('gx_comms_done_title_register', 'Finish registering your business') : L('gx_comms_done_title', 'You’re set up'));
    const row = (rowState, markIcon, name, body, action = '', extra = '') => `<div class="gxc-row" data-state="${rowState}">${mark(markIcon)}<div><strong>${esc(name)}</strong>${body ? `<p>${esc(body)}</p>` : ''}${extra}</div>${action}</div>`;
    const button = (attr, label, primary = false) => `<button type="button" class="gxc-btn small ${primary ? 'primary' : ''}" ${attr}>${esc(label)}</button>`;
    const phoneName = L('gx_comms_business_phone_name', 'Business phone');
    const phoneRow = !done.phone
      ? row('offer', 'fa-plus', L('gx_comms_offer_business_phone', 'Add a business phone'), L('gx_comms_offer_business_phone_body', 'One number, registered once, for texting and calling customers.'), button('data-gxc-phone', L('gx_comms_set_up', 'Set up'), true))
      : state === 'approved'
        ? row('done', 'fa-check', phoneName, number ? L('gx_comms_phone_ready_number', 'Ready on {number}.', { number }) : L('gx_comms_phone_ready', 'Ready to text and call.'))
        : state === 'submitted'
          ? row('wait', 'fa-clock', phoneName, L('gx_comms_phone_review', 'Carriers are reviewing your business, usually for a few days. Texts start once it’s approved.'))
          : row('todo', 'fa-exclamation', phoneName, state === 'attention' ? L('gx_comms_phone_attention', 'Your registration needs changes before you can text.') : L('gx_comms_phone_register', 'Register your business with the carriers to start texting.'), button('data-gxc-phone', state === 'attention' ? L('gx_comms_fix', 'Fix it') : L('gx_comms_continue_registration', 'Continue'), true));
    // Email on a domain whose email records are not set up yet still sends from FirstMate Mail: the row says so.
    const domain = object(email.domain), domainWaits = !!domain.address && domain.state !== 'ready';
    const address = (value) => `<p class="gxc-address" data-gxc-address>${esc(value)}</p>`;
    const emailRow = done.email
      ? domainWaits
        ? row('wait', 'fa-clock', L('gx_comms_email_name', 'Email'), email.address ? L('gx_comms_email_domain_wait', 'Sends from {address} until its email records are set up.', { address: email.address }) : '', '', address(domain.address))
        : row('done', 'fa-check', L('gx_comms_email_name', 'Email'), '', '', address(domain.state === 'ready' ? domain.address : email.address))
      : row('offer', 'fa-plus', L('gx_comms_offer_email', 'Add email'), '', button('data-gxc-email', L('gx_comms_set_up', 'Set up'), !done.phone || registered()));
    el.innerHTML = `<div class="gxc">
      <div class="gxc-rows">${(only ? [emailRow] : done.phone || !done.email ? [phoneRow, emailRow] : [emailRow, phoneRow]).join('')}<div data-gxc-plan-row hidden></div></div>
      ${errorLine}
      <div class="gxc-actions">
        ${only && done.email ? '' : `<button type="button" class="gxc-btn" data-gxc-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>`}
        <span class="gxc-spacer"></span>
        <button type="button" class="gxc-btn primary" data-gxc-finish>${esc(finishLabel())}</button>
      </div>
    </div>`;
    el.querySelector('[data-gxc-back]')?.addEventListener('click', () => show(only ? 'email' : 'intro'));
    el.querySelector('[data-gxc-phone]')?.addEventListener('click', (event) => startPhone(event.currentTarget));
    el.querySelector('[data-gxc-email]')?.addEventListener('click', () => show('email'));
    // The texting plan, where platform billing sells one and the organization has none yet.
    if (done.phone && !only) void billingAvailable().then((available) => {
      const slot = el.querySelector('[data-gxc-plan-row]');
      if (!available || !slot || !alive || page !== 'done' || currentPlan()) return;
      slot.outerHTML = row('offer', 'fa-credit-card', L('gx_comms_plan_row', 'Texting plan'), L('gx_comms_plan_row_body', 'Pick a monthly plan now, or later in Settings › Billing.'), button('data-gxc-plans', L('gx_comms_plan_choose', 'Choose a plan')));
      el.querySelector('[data-gxc-plans]')?.addEventListener('click', () => show('billing'));
    });
  }

  // How email starts (FM-590): FirstMate Mail, the default, on at once; the company's own domain; or a domain bought
  // through FirstMate (the Domains workflow's search, cart and checkout). The first two are free; buying is billed yearly.
  // Nothing is turned on until one is picked.
  async function domainsOffered(){
    if (domains) return domains;
    domains = { buy: false };
    try {
      const win = await domainsWindow(); const config = object(await win.DomainsAPI.config());
      domains = { buy: config.configured === true && config.encryption_configured === true && config.billing_enabled === true };
    }
    catch { domains = { buy: false }; }
    return domains;
  }
  function drawEmail(){
    title(L('gx_comms_email_title', 'Your email address'));
    const domain = object(object(status.email).domain), started = domain.name && !domain.address;
    const tag = (paid) => `<span class="gxc-tag"${paid ? ' data-paid' : ''}>${esc(paid ? L('gx_comms_paid', 'Paid') : L('gx_comms_free', 'Free'))}</span>`;
    const card = (id, iconName, name, body, paid, { disabled = false, first = false } = {}) => `<button type="button" class="gxc-choice gxs-choice" data-gxc-email-way="${id}" ${first ? 'data-first' : ''} ${disabled ? 'disabled' : ''}>${icon(iconName, 'gxs-choice-icon')}<span class="gxs-choice-text"><strong>${esc(name)}${disabled ? '' : tag(paid)}</strong><small>${esc(body)}</small></span></button>`;
    const buy = domains?.buy !== false;
    el.innerHTML = `<div class="gxc">
      <div class="gxs-choices" style="--gxs-n:3">
        ${card('firstmate', 'fa-paper-plane', L('gx_comms_email_firstmate', 'FirstMate Mail'), L('gx_comms_email_firstmate_body', 'Ready now, on firstmatemail.com'), false, { first: !domain.name })}
        ${card('existing', 'fa-globe', L('gx_comms_email_yours', 'Use your own domain'), domain.address || (started ? L('gx_comms_email_own_resume', 'Finish connecting {domain}', { domain: domain.name }) : L('gx_comms_email_own_body', 'you@yourcompany.com')), false, { first: !!domain.name })}
        ${card('register', 'fa-cart-shopping', L('gx_comms_email_buy_us', 'Buy a domain through FirstMate'), buy ? L('gx_comms_email_buy_us_body', 'Search for a name and see its yearly price') : L('gx_comms_email_buy_soon', 'Not available yet'), true, { disabled: !buy })}
      </div>
      <p class="gxc-note" data-gxc-email-cost>${esc(L('gx_comms_email_cost', 'FirstMate Mail and your own domain are free. A domain bought through FirstMate is billed every year, with privacy included free.'))}</p>
      ${errorLine}
      ${only ? '' : `<div class="gxc-actions">
        <button type="button" class="gxc-btn" data-gxc-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
      </div>`}
    </div>`;
    el.querySelector('[data-gxc-back]')?.addEventListener('click', () => show(object(status.done).phone ? 'done' : 'intro'));
    el.querySelectorAll('[data-gxc-email-way]').forEach((button) => button.addEventListener('click', () => {
      const way = button.dataset.gxcEmailWay;
      // A domain that already has its address (connected in Settings › Domains) only needs email turned on.
      void (way === 'firstmate' || (way === 'existing' && domain.address) ? startEmail(button) : startDomain(way, button));
    }));
    if (!domains) void domainsOffered().then(() => { if (alive && page === 'email' && !busy) drawEmail(); });
  }
  // The domain workflow, full screen over the page like registration; when it closes, email turns on once the domain
  // has its address (mail sends from FirstMate Mail until the domain's email records are set up), else back here.
  async function startDomain(path, button){
    if (busy) return; busy = true; if (button) button.disabled = true;
    try {
      const win = await domainsWindow();
      const sheet = el.closest('.gxs');
      if (sheet) { sheet.style.visibility = 'hidden'; sheet.inert = true; }
      registering = true;
      // "Use my domain" picks up a domain already started; "Buy a domain" always starts a new one.
      try { await win.FirstMateDomainsSettings.openForEmail({ orgId, path, domain: path === 'existing' ? object(object(status.email).domain).name || '' : '' }); }
      finally { registering = false; if (sheet) { sheet.style.visibility = ''; sheet.inert = false; } }
      if (!alive) return;
      status = await invoke('comms.setup.status');
      if (object(object(status.email).domain).address) { await turnOn('email'); if (alive) show('done'); }
      else if (alive) show('email');
    } catch (error) { if (alive) { show('email'); fail(error); } }
    finally { busy = false; if (button?.isConnected) button.disabled = false; }
  }

  // The texting plan: platform billing's SMS prices. Where billing is not offered (or nothing is for sale), no row.
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
  function currentPlan(){
    const now = new Date().toISOString();
    return array(object(billing?.data).subscriptions).find((sub) => sub.product_id === 'sms' && (!sub.ends_at || sub.ends_at > now));
  }
  function drawBilling(){
    title(L('gx_comms_billing_title', 'Add a texting plan'));
    const data = object(billing?.data), current = currentPlan();
    const card = object(data.payment_details).has_payment_method === true;
    const money = (plan) => new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency || 'USD' }).format(Number(plan.monthly_cents || 0) / 10 ** (plan.minor_digits ?? 2));
    el.innerHTML = `<div class="gxc">
      <div class="gxc-plans">${array(billing?.plans).map((plan) => { const mine = current && (current.price?.id === plan.id || current.price_id === plan.id); return `<div class="gxc-plan"><h4>${esc(plan.name)}</h4><b>${esc(L('gx_comms_billing_price', '{price} / month', { price: money(plan) }))}</b><p>${esc(plan.description || '')}</p>${data.can_manage && !mine ? `<button type="button" class="gxc-btn primary" data-gxc-plan="${esc(plan.id)}">${esc(current ? L('gx_comms_billing_change', 'Switch to this plan') : L('gx_comms_billing_add', 'Add this plan'))}</button>` : mine ? `<span class="gxc-on">${esc(L('gx_comms_billing_yours', 'Your plan'))}</span>` : ''}</div>`; }).join('')}</div>
      <p class="gxc-pay">${icon(card ? 'fa-credit-card' : 'fa-lock')}<span>${esc(card ? L('gx_comms_billing_card', 'We’ll charge the card you already have on file.') : L('gx_comms_billing_stripe', 'You’ll add a card securely with Stripe.'))}</span></p>
      ${data.can_manage ? '' : `<p class="gxc-note">${esc(L('gx_comms_billing_ask', 'Ask whoever manages billing to add a texting plan.'))}</p>`}
      ${errorLine}
      <div class="gxc-actions">
        <span class="gxc-spacer"></span>
        <button type="button" class="gxc-btn ${current ? 'primary' : ''}" data-gxc-continue>${esc(current ? L('gx_ui_continue', 'Continue') : L('gx_comms_billing_later', 'Not now'))}</button>
      </div>
    </div>`;
    el.querySelector('[data-gxc-continue]').addEventListener('click', () => show('done'));
    el.querySelectorAll('[data-gxc-plan]').forEach((button) => button.addEventListener('click', async () => {
      if (busy) return; busy = true; button.disabled = true;
      try {
        const paid = await window.FirstMatePlatformBilling.review({ orgId, priceId: button.dataset.gxcPlan });
        if (paid && alive) { billing = null; await billingAvailable(); if (alive) drawBilling(); }
      } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
    }));
  }

  function report(channel){ ctx.change({ comms_setup: ['phone', 'email'].filter((id) => object(status.done)[id]) }, channel === 'email' ? L('gx_comms_email_name', 'Email') : L('gx_comms_business_phone_name', 'Business phone')); }
  async function turnOn(channel){
    status = await invoke('comms.setup.start', { channel });
    report(channel);
    await syncSessions(orgId);
  }
  // FirstMate Mail: on at once, then the done page (with its address and texts and calls offered).
  async function startEmail(button){
    if (busy) return; busy = true; if (button) button.disabled = true;
    try { await turnOn('email'); if (alive) show('done'); }
    catch (error) { fail(error); }
    finally { busy = false; if (button?.isConnected) button.disabled = false; }
    // Email alone: FirstMate Mail is ready at once, so there is nothing more to say here; back to what asked.
    if (alive && only && object(status.done).email) await finish();
  }
  // The business phone: on at once, then straight into carrier registration, drawn here as more pages (GP-138). When it
  // is left having just been submitted (GP-7), the setup goes on to what is left: email when it is not on yet, else it
  // is finished and closes, and Communications shows texts and calls pending approval. Back out of its first page
  // returns to the page it was started from; left any other way without submitting, the done page.
  async function startPhone(button){
    if (busy) return; busy = true; if (button) button.disabled = true;
    const wasRegistered = registered(), from = page;
    let next = '';
    try {
      const result = await setUpTexting({ orgId, status, host: el, setTitle: title, alive: () => alive,
        onStep: () => { ctx.syncBack?.(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); },
        onStatus: (value) => { status = value; report('phone'); },
        onRegistering: (handle) => {
          registration = handle || null;
          if (!handle && alive) { title(L('gx_comms_registering_title', 'Register your business')); drawBusy(L('gx_comms_registering', 'Registering your business with the carriers…')); }
        } });
      status = result.status;
      next = result.left === 'back' ? from : !wasRegistered && registered() ? object(status.done).email ? 'finish' : 'email' : 'done';
      if (alive && next !== 'finish') show(next);
    } catch (error) {
      registration = null;
      if (alive) { show(object(status.done).phone ? 'done' : 'intro'); fail(error); }
    } finally { busy = false; if (button?.isConnected) button.disabled = false; ctx.syncBack?.(); }
    if (alive && next === 'finish') { show('done'); await finish(); }
  }
  async function finish(){
    if (busy) return; busy = true;
    try { await ctx.complete?.(); } catch (error) { fail(error); } finally { busy = false; }
  }

  function draw(){
    if (!alive) return;
    watcher?.disconnect(); watcher = null;
    if (page === 'done') drawDone();
    else if (page === 'email') drawEmail();
    else if (page === 'billing') drawBilling();
    else drawIntro();
    el.querySelector('[data-gxc-finish]')?.addEventListener('click', () => finish());
  }

  el.innerHTML = '<div class="gxs-module-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';
  // Where the setup was asked for a channel (an Overview button), it starts that channel at once.
  const top = (() => { try { return window.top.__fmCommsSetupStart !== undefined ? window.top : window; } catch { return window; } })();
  const asked = only || window.__fmCommsSetupStart || top.__fmCommsSetupStart;
  const start = ['phone', 'email'].includes(asked) ? asked : '';
  window.__fmCommsSetupStart = ''; try { top.__fmCommsSetupStart = ''; } catch {}
  invoke('comms.setup.status').then((value) => {
    status = value; draw();
    if (start === 'email') show(object(status.done).email ? 'done' : 'email');
    else if (start === 'phone') void (object(status.done).phone && registered() ? show('done') : startPhone());
  }).catch((error) => { draw(); fail(error); });
  // While registration shows, Back and the phone's back walk its pages, and its first page's Back returns here.
  return { valid: () => true, escape: () => registering, back: () => registration?.back?.() === true, backDepth: () => registration ? registration.depth() : 0,
    destroy(){ alive = false; watcher?.disconnect(); registration?.close?.(); } };
}
export default mount;
