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
  materials:'<path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10M7 5l10 5"/>'
};
const icon = theme => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[theme] || icons.documents}</svg>`;
const css = `
.fm-app-welcome{--offer-accent:#d93025;--offer-tint:#fff0eb;container-type:inline-size;overflow:auto;overscroll-behavior:contain;height:100%;min-height:0;background:#faf9f6;color:#202124;text-align:left;font-family:Montserrat,Arial,sans-serif}
.fm-app-welcome *{box-sizing:border-box}.fm-app-welcome[data-theme=photos]{--offer-accent:#287471;--offer-tint:#e9f5f1}.fm-app-welcome[data-theme=portal]{--offer-accent:#5367a8;--offer-tint:#eff1fb}.fm-app-welcome[data-theme=materials]{--offer-accent:#9d6636;--offer-tint:#f7eddd}
.faw-wrap{max-width:1120px;margin:auto;padding:clamp(22px,4cqw,46px);min-height:100%;display:flex;flex-direction:column;justify-content:center;gap:26px}
.faw-top{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;font-weight:800}.faw-brand{display:flex;align-items:center;gap:8px}.faw-brand img{width:23px;height:23px;object-fit:contain}.faw-free{font-size:10px;letter-spacing:.03em;color:#285743;background:#e6f2e9;padding:7px 10px;border-radius:99px;white-space:nowrap}
.faw-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:center;gap:36px}.faw-copy{min-width:0}.faw-eyebrow{font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;color:var(--offer-accent);margin:0 0 13px!important}
.fm-app-welcome h1{font:850 clamp(30px,4.6cqw,50px)/1.04 Montserrat,Arial,sans-serif;letter-spacing:-.045em;margin:0 0 17px;max-width:14ch;color:#202124}.faw-description{font-size:14px;line-height:1.6;color:#5b626c;max-width:44ch;margin:0 0 20px!important}
.faw-benefits{list-style:none;padding:0;margin:0 0 25px;display:grid;gap:11px}.faw-benefits li{display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.5;font-weight:600}.faw-benefits svg{width:17px;height:17px;flex:none;stroke:var(--offer-accent);stroke-width:2.5;fill:none;margin-top:1px}
.fm-app-welcome .faw-start{display:inline-flex;align-items:center;justify-content:center;gap:22px;min-height:46px;padding:12px 22px;border:0;border-radius:9px;background:#d93025;color:#fff;font:750 14px Montserrat,Arial,sans-serif;cursor:pointer;box-shadow:0 6px 15px #d9302520}.faw-start:hover{background:#bb251b}.faw-start:focus-visible{outline:3px solid #202124;outline-offset:4px}.faw-start:disabled{opacity:.65;cursor:wait}.faw-start svg{width:18px;height:18px;stroke:currentColor;stroke-width:2;fill:none}
.faw-note{font-size:10px;line-height:1.5;margin:10px 0 0!important;color:#737983}.faw-error{font-size:12px;color:#ad221b;margin:10px 0 0!important}.faw-error:empty{display:none}
.faw-art{position:relative;min-width:0;padding:35px 20px 25px;background:radial-gradient(ellipse at 80% 10%,#ffffffaa,transparent 60%),var(--offer-tint);border-radius:22px;min-height:310px;display:flex;align-items:center;justify-content:center}.faw-art:before{content:'';position:absolute;width:150px;height:150px;border:1px solid #ffffffbd;border-radius:50%;right:12px;top:10px}.faw-demo{position:relative;background:#fff;border:1px solid #20212412;border-radius:13px;box-shadow:0 17px 35px #20212413;width:100%;max-width:330px;padding:18px;transform:rotate(-3deg)}
.faw-demo-head{display:flex;align-items:center;gap:9px;border-bottom:1px solid #f0efec;padding-bottom:12px;margin-bottom:12px;font-size:11px;font-weight:750}.faw-demo-head svg{width:20px;height:20px;stroke:var(--offer-accent);stroke-width:1.7;fill:none}.faw-demo-small{font-size:8px;color:#8b9199;margin-top:4px;font-weight:500;letter-spacing:.02em}.faw-photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.faw-photo{height:77px;background:linear-gradient(155deg,#d8e5e8 45%,#567d75 46%,#416961);position:relative;border-radius:6px;overflow:hidden}.faw-photo:nth-child(2){background:linear-gradient(145deg,#dce2df 40%,#9caa9c 41%,#566c61)}.faw-photo:nth-child(3){background:linear-gradient(155deg,#eee4cf 35%,#bd9c6b 36%,#927653)}.faw-photo:nth-child(4){background:linear-gradient(155deg,#cfdae3 45%,#758a9a 46%,#536a7c)}.faw-photo:before{content:'';position:absolute;width:45px;height:45px;background:#f4f0e8;bottom:5px;left:22px;clip-path:polygon(0 44%,50% 0,100% 44%,87% 44%,87% 100%,13% 100%,13% 44%)}.faw-photo span{position:absolute;left:6px;bottom:5px;color:white;background:#263b38b0;padding:3px 5px;border-radius:3px;font-size:7px;font-weight:700}
.faw-row{display:flex;align-items:center;gap:9px;padding:11px 0;border-bottom:1px solid #f0efec;font-size:10px;font-weight:650}.faw-row:last-child{border:0}.faw-row>svg{width:27px;height:27px;padding:5px;background:var(--offer-tint);border-radius:6px;stroke:var(--offer-accent);fill:none;stroke-width:1.5}.faw-row>span{flex:1}.faw-row small{font-size:8px;color:#737983;font-weight:500;display:block;margin-top:3px}.faw-row>b{font-size:9px;color:var(--offer-accent);font-weight:700}.faw-doc-title{font-size:18px;font-weight:850;letter-spacing:-.03em;margin:17px 0 6px}.faw-line{height:5px;background:#eceef1;border-radius:9px;margin:8px 0;width:92%}.faw-line.short{width:59%}.faw-signature{font-family:Georgia,serif;font-size:23px;font-style:italic;color:#727b94;margin-top:19px;padding-bottom:6px;border-bottom:1px solid #d6dae2}.faw-stamp{position:absolute;right:-9px;bottom:18px;transform:rotate(5deg);background:#fff;box-shadow:0 5px 18px #20212419;border:1px solid #2021240b;padding:10px 13px;border-radius:9px;font-size:9px;font-weight:750;display:flex;align-items:center;gap:6px}.faw-stamp svg{width:15px;height:15px;stroke:#358464;fill:none;stroke-width:2.5}.faw-portal-cover{height:65px;border-radius:7px;background:linear-gradient(145deg,#eceefa,#cad5ea);display:flex;align-items:center;justify-content:center;margin-bottom:14px}.faw-portal-cover svg{width:35px;height:35px;stroke:#7887b5;stroke-width:1.4;fill:none}.faw-caption{font-size:10px;color:#777e87;line-height:1.5;margin:13px 0 0;text-align:center}
@container(max-width:680px){.faw-wrap{gap:23px;padding:24px}.faw-hero{grid-template-columns:1fr;gap:26px}.fm-app-welcome h1{font-size:36px;max-width:17ch}.faw-description{font-size:13px;max-width:48ch}.faw-art{min-height:225px;padding:23px 28px}.faw-demo{max-width:300px;padding:14px}.faw-photo{height:62px}.faw-row{padding:8px 0}.faw-caption{margin-top:10px}.faw-benefits{gap:9px;margin-bottom:20px}}
@container(max-width:370px){.faw-wrap{padding:19px 17px}.fm-app-welcome h1{font-size:31px}.faw-benefits li{font-size:11px}.faw-free{font-size:9px;padding:6px 8px}.faw-start{width:100%}.faw-art{padding:22px}}
@media(prefers-reduced-motion:reduce){.faw-demo{transform:none}}
`;

function illustration(theme){
  const head = `<div class="faw-demo-head">${icon(theme)}<div>${t('demo_project','Oak Street Project')}<div class="faw-demo-small">${t('demo_workspace','EVERYTHING IN ONE PLACE')}</div></div></div>`;
  const row = (title, sub, end) => `<div class="faw-row">${icon(theme)}<span>${title}<small>${sub}</small></span><b>${end}</b></div>`;
  let body = '';
  if (theme === 'photos') body = `<div class="faw-photo-grid">${['Before','Details','In progress','Finished'].map((label,i)=>`<div class="faw-photo"><span>${t('photo_label_'+i,label)}</span></div>`).join('')}</div>`;
  else if (theme === 'documents') body = `<div class="faw-doc-title">${t('demo_proposal','Project proposal')}</div><div class="faw-demo-small">${t('demo_prepared','PREPARED FOR YOUR CUSTOMER')}</div><div class="faw-line"></div><div class="faw-line"></div><div class="faw-line short"></div><div class="faw-signature">${t('demo_signature','A great first impression.')}</div>`;
  else if (theme === 'portal') body = `<div class="faw-portal-cover">${icon(theme)}</div>${row(t('demo_welcome','Welcome to your project'),t('demo_portal_sub','The details, right at your fingertips'),'')}${row(t('demo_shared','Shared with you'),t('demo_shared_sub','Your project information'),'↗')}`;
  else body = row(t('demo_shingles','Roofing shingles'),t('demo_shingles_sub','Selected product & color'),'24')+row(t('demo_underlay','Underlayment'),t('demo_underlay_sub','Ready for the next step'),'3')+row(t('demo_trim','Drip edge'),t('demo_trim_sub','The details are on the list'),'18');
  return `<div class="faw-art" aria-hidden="true"><div class="faw-demo">${head}${body}<div class="faw-stamp">${check}${t('demo_connected','Connected to your project')}</div></div></div>`;
}

export function renderWelcome(welcome){
  const theme = Object.hasOwn(icons, welcome.theme) ? welcome.theme : 'documents';
  return `<article class="fm-app-welcome" data-theme="${theme}"><div class="faw-wrap"><div class="faw-top"><div class="faw-brand"><img src="/images/logo_square.png" alt="">FirstMate</div><span class="faw-free">${t('free','Free to get started')}</span></div><div class="faw-hero"><section class="faw-copy"><p class="faw-eyebrow">${esc(copy(welcome.eyebrow))}</p><h1>${esc(copy(welcome.headline))}</h1><p class="faw-description">${esc(copy(welcome.description))}</p><ul class="faw-benefits">${welcome.benefits.map(benefit=>`<li>${check}<span>${esc(copy(benefit))}</span></li>`).join('')}</ul><button type="button" class="faw-start">${t('start','Get Started')}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></button><p class="faw-note">${t('organization','Start using this app with your organization.')}</p><p class="faw-error" role="alert"></p></section><div>${illustration(theme)}<p class="faw-caption">${esc(copy(welcome.caption))}</p></div></div></div></article>`;
}

function installStyles(){
  if (document.getElementById('fm-app-welcome-style')) return;
  const style = document.createElement('style'); style.id='fm-app-welcome-style'; style.textContent=css; document.head.append(style);
}

async function refreshOrganization(orgId){
  const windows = new Set([window]);
  try { if (window.top.location.origin === window.location.origin) windows.add(window.top); } catch {}
  for (const win of [...windows]) for (const frame of win.document.querySelectorAll('iframe')) {
    try { if (frame.contentWindow?.Portal && frame.contentWindow.location.origin === location.origin) windows.add(frame.contentWindow); } catch {}
  }
  for (const win of windows) {
    if ((win.__APP?.userOrgId || win.Portal?.currentUser?.orgId) !== orgId) continue;
    await Promise.all([win.PlatformAPI.capabilities.load(orgId,{refresh:true}),win.PlatformAPI.appFlags.load(orgId,{refresh:true})]);
    await win.Portal.auth.syncPlatformSession();
    await win.FirstMateGuides?.refresh?.();
    win.dispatchEvent(new win.CustomEvent('fm:app-flags:updated'));
  }
}

export function mountWelcome(context){
  installStyles();
  const root = context.roots?.main || context.panelRoot;
  const welcome = context.entitlement?.welcome;
  if (!root || !welcome) throw new Error('The app welcome is unavailable.');
  root.innerHTML=renderWelcome(welcome);
  root.classList.add('fm-app-welcome-host');
  let destroyed=false, pending=false, started=false;
  const button=root.querySelector('.faw-start');
  const start=async()=>{
    if(pending || destroyed) return;
    pending=true;button.disabled=true;root.querySelector('.faw-error').textContent='';
    try {
      if (!started) await window.PlatformAPI.request(`/organizations/${encodeURIComponent(context.orgId)}/app-offers/${encodeURIComponent(context.appId)}/start`,{method:'POST',body:{}});
      started=true;
      await refreshOrganization(context.orgId);
      if (!destroyed && root.isConnected) window.dispatchEvent(new CustomEvent('fm:app-offer:started',{detail:{appId:context.appId}}));
    } catch(error) {
      if(!destroyed) root.querySelector('.faw-error').textContent=error?.message || text('gx_offer_error','Could not start this app. Please try again.');
    } finally {pending=false;if(!destroyed)button.disabled=false;}
  };
  button.addEventListener('click',start);
  return { offered:true, setActive(){}, destroy(){destroyed=true;button.removeEventListener('click',start);root.classList.remove('fm-app-welcome-host');root.innerHTML='';} };
}
