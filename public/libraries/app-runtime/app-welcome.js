/* A static advertisement for an offered app. Activation and progress belong to the server. */
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const text = (key, fallback) => window.PlatformLanguage?.text?.('guided-experiences', key, fallback) ?? fallback;
const copy = value => text(value?.key, value?.text || '');
const t = (key, fallback) => esc(text('gx_offer_' + key, fallback));
const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const icons = {
  photos:'<rect x="3" y="6" width="18" height="15" rx="3"/><path d="m8 6 2-3h4l2 3"/><circle cx="12" cy="13" r="4"/>',
  documents:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
  portal:'<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
  equipment:'<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7M6 17v1m12-1v1"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  materials:'<path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10M7 5l10 5"/>',
  money:'<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M6 10v5M18 10v5"/>',
  checklists:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  scheduling:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14h3v3H8z"/>',
  comms:'<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M8 9h9M8 13h5"/>',
  // An app with no welcome of its own yet (offers.ts placeholderWelcome).
  generic:'<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><path d="M17.25 13.5v7.5M13.5 17.25H21"/>'
};
const icon = theme => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[theme] || icons.documents}</svg>`;
const css = `
.fm-app-welcome{--fm-mark:url(data:image/png;base64,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)}
/* White, in the organization's colours (GP-39). The primary leads (--offer-accent, readable on white): the mark, Get
   Started, the illustration and its icons. The secondary is the accent (--offer-second, made readable by paintSecondary):
   the eyebrow, the checks, the illustration's ring, figures and tick. An app's theme colour is only the fallback on a page
   without a theme. */
.fm-app-welcome{--offer-theme:#d93025;--offer-accent:var(--primary-readable,var(--primary,var(--offer-theme)));--offer-second:var(--secondary,#202124);--offer-tint:color-mix(in srgb,var(--offer-accent) 10%,#fff);--offer-tint-2:color-mix(in srgb,var(--offer-second) 12%,#fff);container-type:inline-size;overflow:auto;overscroll-behavior:contain;height:100%;min-height:0;background:#fff;color:#202124;text-align:left;font-family:Montserrat,Arial,sans-serif}
.fm-app-welcome *{box-sizing:border-box}.fm-app-welcome[data-theme=photos]{--offer-theme:#287471}.fm-app-welcome[data-theme=portal]{--offer-theme:#5367a8}.fm-app-welcome[data-theme=equipment],.fm-app-welcome[data-theme=materials]{--offer-theme:#9d6636}.fm-app-welcome[data-theme=money]{--offer-theme:#2f7a4f}.fm-app-welcome[data-theme=checklists]{--offer-theme:#4b5fa8}.fm-app-welcome[data-theme=scheduling]{--offer-theme:#7a4fb5}.fm-app-welcome[data-theme=comms]{--offer-theme:#2b6cb0}.fm-app-welcome[data-theme=generic]{--offer-theme:#4f5d73}
.faw-wrap{max-width:1120px;margin:auto;padding:clamp(22px,4cqw,46px);min-height:100%;display:flex;flex-direction:column;justify-content:center;gap:26px}
.faw-top{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;font-weight:800}.faw-brand{display:flex;align-items:center;gap:8px}.faw-logo{width:23px;height:23px;flex:none;background:var(--offer-accent);-webkit-mask:var(--fm-mark) center/contain no-repeat;mask:var(--fm-mark) center/contain no-repeat}.faw-free{font-size:10px;letter-spacing:.03em;color:#285743;background:#e6f2e9;padding:7px 10px;border-radius:99px;white-space:nowrap}
.faw-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:center;gap:36px}.faw-copy{min-width:0}.faw-eyebrow{display:flex;align-items:center;gap:9px;font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;color:var(--offer-second);margin:0 0 13px!important}.faw-eyebrow:before{content:'';width:20px;height:3px;border-radius:2px;background:var(--offer-second);flex:none}
.fm-app-welcome h1{font:850 clamp(30px,4.6cqw,50px)/1.04 Montserrat,Arial,sans-serif;letter-spacing:-.045em;margin:0 0 17px;max-width:14ch;color:#202124}.faw-description{font-size:14px;line-height:1.6;color:#5b626c;max-width:44ch;margin:0 0 20px!important}
.faw-benefits{list-style:none;padding:0;margin:0 0 25px;display:grid;gap:11px}.faw-benefits li{display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.5;font-weight:600}.faw-benefits svg{width:13px;height:13px;padding:3px;box-sizing:content-box;border-radius:50%;background:var(--offer-tint-2);flex:none;stroke:var(--offer-second);stroke-width:3;fill:none;margin-top:0}
.fm-app-welcome .faw-start{display:inline-flex;align-items:center;justify-content:center;gap:22px;min-height:46px;padding:12px 22px;border:0;border-radius:9px;background:var(--primary,var(--offer-theme));color:var(--on-primary,#fff);font:750 14px Montserrat,Arial,sans-serif;cursor:pointer;box-shadow:0 6px 15px #20212418}.faw-start:hover{filter:brightness(.92)}.faw-start:focus-visible{outline:3px solid #202124;outline-offset:4px}.faw-start:disabled{opacity:.65;cursor:wait}.faw-start svg{width:18px;height:18px;stroke:currentColor;stroke-width:2;fill:none}
.faw-note{font-size:10px;line-height:1.5;margin:10px 0 0!important;color:#737983}.faw-free.faw-setup{color:#794c00;background:#fff0cb}.faw-setup-note{font-size:12px;line-height:1.5;font-weight:650;color:#794c00;margin:-8px 0 18px!important}.faw-error{font-size:12px;color:#ad221b;margin:10px 0 0!important}.faw-error:empty{display:none}
.faw-art{position:relative;min-width:0;padding:35px 20px 25px;background:radial-gradient(ellipse at 80% 10%,#ffffffaa,transparent 60%),linear-gradient(135deg,var(--offer-tint),color-mix(in srgb,var(--offer-accent) 4%,#fff));border-radius:22px;min-height:310px;display:flex;align-items:center;justify-content:center}.faw-art:before{content:'';position:absolute;width:150px;height:150px;border:2px solid color-mix(in srgb,var(--offer-second) 45%,transparent);border-radius:50%;right:12px;top:10px}.faw-art:after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background:var(--offer-second);right:84px;top:3px}.faw-demo{position:relative;background:#fff;border:1px solid #20212412;border-radius:13px;box-shadow:0 17px 35px #20212413;width:100%;max-width:330px;padding:18px;transform:rotate(-3deg)}
.faw-demo-head{display:flex;align-items:center;gap:9px;border-bottom:1px solid #eef0f2;padding-bottom:12px;margin-bottom:12px;font-size:11px;font-weight:750}.faw-demo-head svg{width:20px;height:20px;stroke:var(--offer-accent);stroke-width:1.7;fill:none}.faw-demo-small{font-size:8px;color:#8b9199;margin-top:4px;font-weight:500;letter-spacing:.02em}.faw-photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.faw-photo{height:77px;background:linear-gradient(155deg,#d8e5e8 45%,#567d75 46%,#416961);position:relative;border-radius:6px;overflow:hidden}.faw-photo:nth-child(2){background:linear-gradient(145deg,#dce2df 40%,#9caa9c 41%,#566c61)}.faw-photo:nth-child(3){background:linear-gradient(155deg,#eee4cf 35%,#bd9c6b 36%,#927653)}.faw-photo:nth-child(4){background:linear-gradient(155deg,#cfdae3 45%,#758a9a 46%,#536a7c)}.faw-photo:before{content:'';position:absolute;width:45px;height:45px;background:#f4f0e8;bottom:5px;left:22px;clip-path:polygon(0 44%,50% 0,100% 44%,87% 44%,87% 100%,13% 100%,13% 44%)}.faw-photo span{position:absolute;left:6px;bottom:5px;color:white;background:#263b38b0;padding:3px 5px;border-radius:3px;font-size:7px;font-weight:700}
.faw-row{display:flex;align-items:center;gap:9px;padding:11px 0;border-bottom:1px solid #eef0f2;font-size:10px;font-weight:650}.faw-row:last-child{border:0}.faw-row>svg{width:27px;height:27px;padding:5px;background:var(--offer-tint);border-radius:6px;stroke:var(--offer-accent);fill:none;stroke-width:1.5}.faw-row>span{flex:1}.faw-row small{font-size:8px;color:#737983;font-weight:500;display:block;margin-top:3px}.faw-row>b{font-size:9px;color:var(--offer-second);font-weight:700}.faw-doc-title{font-size:18px;font-weight:850;letter-spacing:-.03em;margin:17px 0 6px}.faw-line{height:5px;background:#eceef1;border-radius:9px;margin:8px 0;width:92%}.faw-line.short{width:59%}.faw-signature{font-family:Georgia,serif;font-size:23px;font-style:italic;color:#727b94;margin-top:19px;padding-bottom:6px;border-bottom:1px solid #d6dae2}.faw-stamp{position:absolute;right:-9px;bottom:18px;transform:rotate(5deg);background:#fff;box-shadow:0 5px 18px #20212419;border:1px solid #2021240b;padding:10px 13px;border-radius:9px;font-size:9px;font-weight:750;display:flex;align-items:center;gap:6px}.faw-stamp svg{width:15px;height:15px;stroke:var(--offer-second);fill:none;stroke-width:2.5}.faw-portal-cover{height:65px;border-radius:7px;background:linear-gradient(145deg,var(--offer-tint),color-mix(in srgb,var(--offer-accent) 24%,#fff));display:flex;align-items:center;justify-content:center;margin-bottom:14px}.faw-portal-cover svg{width:35px;height:35px;stroke:var(--offer-accent);stroke-width:1.4;fill:none}.faw-caption{font-size:10px;color:#777e87;line-height:1.5;margin:13px 0 0;text-align:center}
@container(max-width:680px){.faw-wrap{gap:23px;padding:24px}.faw-hero{grid-template-columns:1fr;gap:26px}.fm-app-welcome h1{font-size:36px;max-width:17ch}.faw-description{font-size:13px;max-width:48ch}.faw-art{min-height:225px;padding:23px 28px}.faw-demo{max-width:300px;padding:14px}.faw-photo{height:62px}.faw-row{padding:8px 0}.faw-caption{margin-top:10px}.faw-benefits{gap:9px;margin-bottom:20px}}
@container(max-width:370px){.faw-wrap{padding:19px 17px}.fm-app-welcome h1{font-size:31px}.faw-benefits li{font-size:11px}.faw-free{font-size:9px;padding:6px 8px}.faw-start{width:100%}.faw-art{padding:22px}}
/* An advertisement is one page: the host's side rail for the app (the project window keeps one for Operations, Money and
   Proposals) is empty until the app is started, so it is hidden while the welcome shows and the welcome takes the width. */
.r-tab-content:has(.fm-app-welcome-host)>.r-tab-sidebar{display:none!important}
.r-tab-content:has(.fm-app-welcome-host)>.r-tab-main{flex:1 1 auto!important;width:100%!important;max-width:none!important;min-width:0}
/* On a phone the portal tab is the advertisement, edge to edge: no shell padding around it and one scroller, its own (FM-481). */
@media(max-width:820px){.main-panels:has(>.fm-tabpanel.active.fm-app-welcome-host){padding:0;overflow:hidden}}
/* layout: page. One full-width page: the copy centred on top, the benefits side by side, the illustration as a wide band below. */
.fm-app-welcome[data-layout=page] .faw-wrap{max-width:1040px;justify-content:flex-start;gap:30px}
.fm-app-welcome[data-layout=page] .faw-hero{grid-template-columns:minmax(0,1fr);justify-items:center;gap:30px}
.fm-app-welcome[data-layout=page] .faw-copy{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:820px}.fm-app-welcome[data-layout=page] .faw-eyebrow:after{content:'';width:20px;height:3px;border-radius:2px;background:var(--offer-second);flex:none}
.fm-app-welcome[data-layout=page] h1{max-width:20ch;font-size:clamp(32px,5cqw,56px)}
.fm-app-welcome[data-layout=page] .faw-description{max-width:58ch;font-size:15px}
.fm-app-welcome[data-layout=page] .faw-benefits{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;width:100%;margin-bottom:28px}
.fm-app-welcome[data-layout=page] .faw-benefits li{flex-direction:column;align-items:center;text-align:center;gap:10px;padding:16px 14px;background:#fff;border:1px solid #20212414;border-radius:14px;box-shadow:0 1px 3px #2021240a}
.fm-app-welcome[data-layout=page] .faw-benefits svg{width:18px;height:18px;padding:6px}
.fm-app-welcome[data-layout=page] .faw-visual{width:100%}
.fm-app-welcome[data-layout=page] .faw-art{min-height:280px;padding:40px 24px 32px}
.fm-app-welcome[data-layout=page] .faw-demo{max-width:420px}
@container(max-width:680px){.fm-app-welcome[data-layout=page] .faw-benefits{grid-template-columns:minmax(0,1fr)}.fm-app-welcome[data-layout=page] .faw-benefits li{flex-direction:row;text-align:left;padding:12px 14px}.fm-app-welcome[data-layout=page] h1{font-size:34px}.fm-app-welcome[data-layout=page] .faw-art{min-height:220px;padding:24px}}
@container(max-width:370px){.fm-app-welcome[data-layout=page] h1{font-size:30px}}
@media(prefers-reduced-motion:reduce){.faw-demo{transform:none}}
`;

function illustration(theme){
  const head = `<div class="faw-demo-head">${icon(theme)}<div>${t('demo_project','Oak Street Project')}<div class="faw-demo-small">${t('demo_workspace','EVERYTHING IN ONE PLACE')}</div></div></div>`;
  const row = (title, sub, end) => `<div class="faw-row">${icon(theme)}<span>${title}<small>${sub}</small></span><b>${end}</b></div>`;
  let body = '';
  if (theme === 'photos') body = `<div class="faw-photo-grid">${['Before','Details','In progress','Finished'].map((label,i)=>`<div class="faw-photo"><span>${t('photo_label_'+i,label)}</span></div>`).join('')}</div>`;
  else if (theme === 'documents') body = `<div class="faw-doc-title">${t('demo_proposal','Project proposal')}</div><div class="faw-demo-small">${t('demo_prepared','PREPARED FOR YOUR CUSTOMER')}</div><div class="faw-line"></div><div class="faw-line"></div><div class="faw-line short"></div><div class="faw-signature">${t('demo_signature','A great first impression.')}</div>`;
  else if (theme === 'portal') body = `<div class="faw-portal-cover">${icon(theme)}</div>${row(t('demo_welcome','Welcome to your project'),t('demo_portal_sub','The details, right at your fingertips'),'')}${row(t('demo_shared','Shared with you'),t('demo_shared_sub','Your project information'),'↗')}`;
  else if (theme === 'money') body = row(t('demo_money_deposit','Deposit received'),t('demo_money_deposit_sub','Card payment'),'$4,200')+row(t('demo_money_balance','Balance due'),t('demo_money_balance_sub','On completion'),'$9,800')+row(t('demo_money_profit','Project profit'),t('demo_money_profit_sub','After materials and labor'),'32%');
  else if (theme === 'checklists') body = row(t('demo_check_start','Job start'),t('demo_check_start_sub','Completed by the crew lead'),'✓')+row(t('demo_check_quality','Quality inspection'),t('demo_check_quality_sub','Photos on every item'),'✓')+row(t('demo_check_closeout','Closeout'),t('demo_check_closeout_sub','Ready for review'),'↗');
  else if (theme === 'scheduling') body = row(t('demo_schedule_sales','Sales appointment'),t('demo_schedule_sales_sub','Tuesday, with the homeowner'),'9:00')+row(t('demo_schedule_crew','Installation'),t('demo_schedule_crew_sub','Your crew, booked for the job'),t('demo_schedule_crew_end','3 days'))+row(t('demo_schedule_delivery','Material delivery'),t('demo_schedule_delivery_sub','The morning the work starts'),'✓');
  else if (theme === 'comms') body = row(t('demo_comms_call','Call from the homeowner'),t('demo_comms_call_sub','Saved to Oak Street'),'2:14')+row(t('demo_comms_text','Text: running 10 minutes late'),t('demo_comms_text_sub','From your business number'),'✓')+row(t('demo_comms_center','Call center'),t('demo_comms_center_sub','New leads ready to call'),'12');
  else if (theme === 'generic') body = row(t('demo_generic_projects','Your projects'),t('demo_generic_projects_sub','Already connected'),'✓')+row(t('demo_generic_team','Your team'),t('demo_generic_team_sub','Everyone who uses it'),'✓')+row(t('demo_generic_start','Ready when you are'),t('demo_generic_start_sub','One click to start'),'↗');
  else if (theme === 'equipment') body = row(t('demo_equipment_trailer','Dump trailer'),t('demo_equipment_trailer_sub','Hauling & debris removal'),'✓')+row(t('demo_equipment_lift','Material lift'),t('demo_equipment_lift_sub','Lifting & roof access'),'✓')+row(t('demo_equipment_project','Project requirements'),t('demo_equipment_project_sub','Match the equipment to the work'),'↗');
  else body = row(t('demo_shingles','Roofing shingles'),t('demo_shingles_sub','Selected product & color'),'24')+row(t('demo_underlay','Underlayment'),t('demo_underlay_sub','Ready for the next step'),'3')+row(t('demo_trim','Drip edge'),t('demo_trim_sub','The details are on the list'),'18');
  return `<div class="faw-art" aria-hidden="true"><div class="faw-demo">${head}${body}<div class="faw-stamp">${check}${t('demo_connected','Connected to your project')}</div></div></div>`;
}

export function renderWelcome(welcome){
  const theme = Object.hasOwn(icons, welcome.theme) ? welcome.theme : 'documents';
  // `layout: page` (offers.ts): one full-width page instead of two sides.
  const layout = welcome.layout === 'page' ? 'page' : 'split';
  return `<article class="fm-app-welcome" data-theme="${theme}" data-layout="${layout}"><div class="faw-wrap"><div class="faw-top"><div class="faw-brand"><span class="faw-logo" aria-hidden="true"></span>FirstMate</div>${welcome.setup ? `<span class="faw-free faw-setup">${t('setup_required','Setup required')}</span>` : welcome.placeholder ? '' : `<span class="faw-free">${t('free','Free Forever')}</span>`}</div><div class="faw-hero"><section class="faw-copy"><p class="faw-eyebrow">${esc(copy(welcome.eyebrow))}</p><h1>${esc(copy(welcome.headline))}</h1><p class="faw-description">${esc(copy(welcome.description))}</p><ul class="faw-benefits">${welcome.benefits.map(benefit=>`<li>${check}<span>${esc(copy(benefit))}</span></li>`).join('')}</ul>${welcome.setup_note ? `<p class="faw-setup-note">${esc(copy(welcome.setup_note))}</p>` : ''}<button type="button" class="faw-start">${t('start','Get Started')}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></button><p class="faw-note">${t('organization','Start using this app with your organization.')}</p><p class="faw-error" role="alert"></p></section><div>${illustration(theme)}<p class="faw-caption">${esc(copy(welcome.caption))}</p></div></div></div></article>`;
}

// Get Started on an app whose switch needs a setup first (Money: payments onboarding) continues into that setup.
function runRequiredSetup(key, appId){
  const setup = window.Portal?.appSetup;
  const state = key && setup?.describe?.(key);
  if (!state || !setup.has?.(key) || state.mode !== 'required' || state.status === 'complete') return;
  Promise.resolve(setup.run(key, { mode:'post_add', source:'app-welcome', appId })).catch(error => console.warn('App setup could not start', error));
}

// The organization's secondary colour is used as text and lines on white, so a light one is darkened until it reads
// (contrast 4.5). The portal has no readable secondary of its own (--primary-readable is the primary's).
const luminance = rgb => rgb.map(v => { v /= 255; return v <= .03928 ? v/12.92 : ((v+.055)/1.055)**2.4; }).reduce((sum,v,i) => sum + v*[.2126,.7152,.0722][i], 0);
export function readableOnWhite(rgb){
  let color = rgb.slice(0,3).map(Number);
  for (let step = 0; step < 20 && 1.05/(luminance(color)+.05) < 4.5; step++) color = color.map(v => Math.round(v*.88));
  return `rgb(${color.join(',')})`;
}
function paintSecondary(article){
  if (!article?.isConnected) return;
  article.style.removeProperty('--offer-second');
  const probe = document.createElement('i'); probe.hidden = true; probe.style.color = 'var(--offer-second)'; article.append(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g); probe.remove();
  if (rgb?.length >= 3) article.style.setProperty('--offer-second', readableOnWhite(rgb));
}

function installStyles(){
  if (document.getElementById('fm-app-welcome-style')) return;
  const style = document.createElement('style'); style.id='fm-app-welcome-style'; style.textContent=css; document.head.append(style);
}

// This window, the portal around it and the portal's other frames (the project window).
function portalWindows(){
  const windows = new Set([window]);
  try { if (window.top.location.origin === window.location.origin) windows.add(window.top); } catch {}
  for (const win of [...windows]) for (const frame of win.document.querySelectorAll('iframe')) {
    try { if (frame.contentWindow?.Portal && frame.contentWindow.location.origin === location.origin) windows.add(frame.contentWindow); } catch {}
  }
  return [...windows];
}

async function refreshOrganization(orgId){
  await Promise.all(portalWindows().map(async win => {
    if ((win.__APP?.userOrgId || win.Portal?.currentUser?.orgId) !== orgId) return;
    // Load guide eligibility before the new session redraws the active tab.
    await Promise.all([win.PlatformAPI.capabilities.load(orgId,{refresh:true}),win.PlatformAPI.appFlags.load(orgId,{refresh:true}),win.FirstMateGuides?.refresh?.()]);
    await win.Portal.auth.syncPlatformSession();
    win.dispatchEvent(new win.CustomEvent('fm:app-flags:updated'));
  }));
}

// Transitions still covering a panel in this window. A tour waits for them (settled), so its first step is drawn
// over the real app, never over the advertisement.
const transitions=new Set();
function settled(){return Promise.all([...transitions].map(entry=>entry.done)).then(()=>undefined);}
if(typeof window!=='undefined')window.FirstMateAppWelcome={settled,pending:()=>transitions.size>0};

// Keep the advertisement in place while the host replaces its panel, then reveal the mounted app. The cover ends when the
// real app is mounted, the person goes to another tab, the panel leaves the page, the window is resized, or after 10 s.
function transitionFrom(root, appId){
  const rect=root.getBoundingClientRect(), article=root.querySelector(':scope > .fm-app-welcome'), cover=article.cloneNode(true);
  cover.setAttribute('aria-hidden','true'); cover.inert=true; cover.classList.add('fm-app-welcome-cover');
  Object.assign(cover.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'1000',pointerEvents:'none'});
  document.body.append(cover);
  let finished=false, resolve;
  const entry={done:new Promise(r=>{resolve=r;})};
  transitions.add(entry);
  const done=()=>{cover.remove();transitions.delete(entry);resolve();};
  const finish=()=>{
    if(finished)return;finished=true;clearTimeout(timeout);clearInterval(watch);
    window.removeEventListener('fm:embeddable-apps:app-mounted',mounted);
    window.removeEventListener('fm:project-tab:opened',changed);
    window.removeEventListener('resize',finish);
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches||!cover.animate){done();return;}
    cover.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-8px)'}],{duration:220,easing:'ease-out'}).finished.catch(()=>{}).finally(done);
  };
  const mounted=event=>{
    const detail=event.detail||{}, mountedRoot=detail.context?.roots?.main||detail.context?.panelRoot;
    if(detail.context?.entitlement?.offered||(detail.appId!==appId&&mountedRoot!==root))return;
    // The real app is showing: nothing of the advertisement stays behind it.
    if(mountedRoot===root&&root.contains(article)){article.remove();root.classList.remove('fm-app-welcome-host');}
    finish();
  };
  const changed=event=>{if(event.detail?.appId!==appId)finish();};
  const timeout=setTimeout(finish,10000);
  // The host may drop the whole panel (another project, the window closed) without mounting anything.
  const watch=setInterval(()=>{if(!root.isConnected)finish();},150);
  window.addEventListener('fm:embeddable-apps:app-mounted',mounted);
  window.addEventListener('fm:project-tab:opened',changed);
  window.addEventListener('resize',finish);
  return finish;
}

export function mountWelcome(context){
  installStyles();
  const root = context.roots?.main || context.panelRoot;
  const welcome = context.entitlement?.welcome;
  if (!root || !welcome) throw new Error('The app welcome is unavailable.');
  root.innerHTML=renderWelcome(welcome);
  root.classList.add('fm-app-welcome-host');
  const article=root.querySelector(':scope > .fm-app-welcome'), repaint=()=>paintSecondary(article);
  repaint();window.addEventListener('fm:theme:updated',repaint);
  let destroyed=false, pending=false, started=false;
  // Fetch/register bundles while the advertisement is showing; mounting remains gated by Get Started.
  const preload=Promise.resolve().then(()=>context.preload?.()).catch(()=>null);
  const button=root.querySelector('.faw-start');
  const start=async()=>{
    if(pending || destroyed) return;
    pending=true;button.disabled=true;root.querySelector('.faw-error').textContent='';
    let finishTransition;
    try {
      // The offer is the entitlement's app: an app group member (the Call center) starts its parent's (GP-87).
      if (!started) await window.PlatformAPI.request(`/organizations/${encodeURIComponent(context.orgId)}/app-offers/${encodeURIComponent(context.entitlement?.id || context.appId)}/start`,{method:'POST',body:{}});
      started=true;
      await preload;
      if(!destroyed)finishTransition=transitionFrom(root,context.appId);
      // Get Started launched it for this person: an unfinished required setup now says "Setup required", not "New" (FM-469).
      for (const win of portalWindows()) { try { win.FirstMateTabGuides?.launch?.(context.appId, welcome.setup); } catch {} }
      window.dispatchEvent(new CustomEvent('fm:app-offer:starting',{detail:{appId:context.appId}}));
      await refreshOrganization(context.orgId);
      // Refreshing the session may already replace this welcome; still re-arm the newly available guide.
      if ((window.__APP?.userOrgId || window.Portal?.currentUser?.orgId) === context.orgId) window.dispatchEvent(new CustomEvent('fm:app-offer:started',{detail:{appId:context.appId}}));
      runRequiredSetup(welcome.setup, context.appId);
    } catch(error) {
      finishTransition?.();
      if(!destroyed) root.querySelector('.faw-error').textContent=error?.message || text('gx_offer_error','Could not start this app. Please try again.');
    } finally {pending=false;if(!destroyed)button.disabled=false;}
  };
  button.addEventListener('click',start);
  return { offered:true, setActive(){}, destroy(){destroyed=true;button.removeEventListener('click',start);window.removeEventListener('fm:theme:updated',repaint);root.classList.remove('fm-app-welcome-host');root.innerHTML='';} };
}
