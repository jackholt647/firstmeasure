/* public/libraries/apps/customer-portal/project.js
 * Project window Customer Portal tab.
 *
 * One page, no sub-tabs: the customer link (preview, copy, email, QR) and the
 * customer's options at the top, the project's media below it, and the
 * portal's history in a narrow column on the right (stacked below on a phone).
 * Explanations live in tooltips, not on the page.
 *
 * Nothing here sends anything: Email opens the user's own mail app with the
 * link filled in, and every change is an explicit click.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const esc = (value) => escapeHtml(String(value ?? ''));
  const showToast = (...args) => (Portal?.ui?.showToast || window.showToast || (() => {}))(...args);

  // Catalog text for a key, with {name} placeholders filled from values.
  const L = (key, fallback, values) => {
    const message = globalThis.PlatformLanguage?.text?.('customer-portal', key, fallback, values) ?? fallback;
    return values ? String(message).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match) : String(message);
  };
  const H = (key, fallback, values) => esc(L(key, fallback, values));

  const APP_ICON = 'fa-link';
  const HISTORY_PAGE = 40;

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    portal: { loading: false, portal: null, activity: [], error: '' },
    selection: new Set(),
    mediaFilter: 'all',
    guestOpen: false,
    historyLimit: HISTORY_PAGE,
    mediaSignature: '',
    busy: ''
  };

  function hostFor(context = {}){
    return context.projectWorkspace || context.host?.projectWorkspace || context.host || state.host || {};
  }

  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  function modelFromContext(context = {}){
    if (context.projectModel || context.model) return context.projectModel || context.model;
    if (context.projectWorkspace || context.host) return null;
    return state.model || window.FirstMateAppContext?.modelFromContext?.(context) || null;
  }

  function project(){
    return callHost('getProject') || state.model?.state?.activeBaseProject || window.activeBaseProject || {};
  }

  function photos(){
    const hosted = callHost('getPhotos');
    if (Array.isArray(hosted)) return hosted;
    if (Array.isArray(state.model?.state?.projectPhotos)) return state.model.state.projectPhotos;
    if (Array.isArray(window.projectPhotos)) return window.projectPhotos;
    return Array.isArray(project().photos) ? project().photos : [];
  }

  // Library photos and videos: what can be shared. A project's generated
  // satellite image is not library media, so it is shown as the cover only.
  function libraryMedia(){
    return photos().filter((photo) => !photo?.is_top_down_thumbnail && photo?.designator !== 'top_down_thumbnail' && photo?.id !== 'top_down_thumbnail');
  }

  function projectId(){
    return String(project()?.id || '').trim();
  }

  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function projectContact(){
    const current = project() || {};
    const contacts = Array.isArray(current.contacts) ? current.contacts : [];
    const primary = contacts.find((entry) => entry?.primary) || contacts.find((entry) => firstText(entry?.id, entry?.contact_id, entry?.name, entry?.email, entry?.phone)) || {};
    const customer = current.customer && typeof current.customer === 'object' && !Array.isArray(current.customer) ? current.customer : {};
    const id = firstText(primary.id, primary.contact_id, current.contact_id, current.primary_contact_id);
    return {
      id,
      contact_id: id,
      name: firstText(primary.name, customer.name, current.customer_name, current.customerName, current.primary_contact_name, current.resident, current.resident_name),
      email: firstText(primary.email, customer.email, current.customer_email, current.customerEmail, current.primary_contact_email, current.resident_email).toLowerCase(),
      phone: firstText(primary.phone, Array.isArray(primary.phones) ? primary.phones[0] : '', customer.phone, current.customer_phone, current.customerPhone, current.primary_contact_phone, current.resident_phone),
      address: firstText(primary.address, primary.default_address, current.contact_address, current.customer_address, current.primary_contact_address, customer.address)
    };
  }

  function orgId(){
    return String(callHost('projectOrgId') || window.projectOrgId?.() || Portal?.cfg?.userOrgId || Portal?.cfg?.orgId || window.__APP?.userOrgId || '').trim();
  }

  function feature(name, fallback = true){
    const fromHost = callHost(name);
    if (fromHost !== undefined) return !!fromHost;
    const fn = window[name];
    if (typeof fn === 'function') return !!fn();
    return fallback;
  }

  function customerPortalEnabled(){
    return feature('customerPortalEnabled', true);
  }

  function customerPortalMediaEnabled(){
    return feature('customerPortalMediaEnabled', true);
  }

  const RESCHEDULING_CAPABILITY = 'scheduling.customer_rescheduling';

  // Fails closed: an option tied to a capability shows only once the
  // organization's capabilities say it is on.
  function capabilityOn(key){
    const capabilities = window.Portal?.capabilities || window.PlatformAPI?.capabilities;
    return capabilities?.can?.(key) === true;
  }

  function photoId(photo, fallback = ''){
    const hosted = callHost('projectPhotoId', photo, fallback);
    if (hosted) return String(hosted);
    return String(photo?.id || photo?.photo_id || photo?.media_id || photo?.src || photo?.thumb || fallback || '').trim();
  }

  function isVideo(photo = {}){
    const hosted = callHost('isVideoMedia', photo);
    if (hosted !== undefined) return !!hosted;
    const type = String(photo.media_type || photo.mediaType || photo.type || photo.mime_type || photo.mimeType || '').toLowerCase();
    return type.startsWith('video') || /\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/i.test(String(photo.src || photo.url || ''));
  }

  function reducedMotion(){
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  /* ---------- styles ---------- */

  function injectStyles(){
    const css = `
      .cpo-panel{height:100%;min-height:0;box-sizing:border-box;background:#f8fafc;color:#101828;container:cpo / inline-size;overflow:auto}
      .cpo-wrap{min-height:100%;box-sizing:border-box;padding:18px;display:flex;flex-direction:column;gap:14px;max-width:1500px;margin:0 auto}
      .cpo-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px}
      .cpo-title{display:flex;align-items:center;gap:11px;min-width:0}
      .cpo-title>i{width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;flex:0 0 auto;font-size:15px}
      .cpo-title strong{font-size:18px;line-height:1.15;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cpo-sync{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 10px;border-radius:999px;background:#fff;border:1px solid #eaecf0;color:#667085;font-size:11px;font-weight:900;opacity:0;transform:translateY(-3px);transition:opacity .2s ease,transform .2s ease;pointer-events:none}
      .cpo-sync.is-on{opacity:1;transform:none}
      .cpo-sync i{animation:cpoSpin 1s linear infinite}
      .cpo-body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}
      .cpo-main{display:flex;flex-direction:column;gap:14px;min-width:0}
      .cpo-card[hidden]{display:none}
      .cpo-card{background:#fff;border:1px solid #eaecf0;border-radius:13px;box-shadow:0 1px 2px rgba(16,24,40,.04);min-width:0}
      .cpo-enter{animation:cpoIn .32s cubic-bezier(.22,1,.36,1) both}
      .cpo-enter.cpo-d1{animation-delay:.04s}.cpo-enter.cpo-d2{animation-delay:.08s}
      .cpo-error{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:11px;padding:9px 12px;font-size:12px;font-weight:800;animation:cpoIn .24s ease both}
      .cpo-error button{border:0;background:transparent;color:inherit;font:inherit;font-weight:1000;cursor:pointer;text-decoration:underline}
      .cpo-btn{height:36px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:900;cursor:pointer;text-decoration:none;white-space:nowrap;transition:border-color .16s ease,background .16s ease,color .16s ease,box-shadow .16s ease,transform .16s ease}
      .cpo-btn:hover:not(:disabled){border-color:rgba(var(--primary-rgb,217,48,37),.32);color:var(--primary-readable,var(--primary,#d93025))}
      .cpo-btn:active:not(:disabled){transform:scale(.97)}
      .cpo-btn:focus-visible,.cpo-tile:focus-visible,.cpo-switch:focus-within,.cpo-seg button:focus-visible{outline:none;box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.16)}
      .cpo-btn:disabled{opacity:.5;cursor:not-allowed}
      .cpo-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .cpo-btn.primary:hover:not(:disabled){color:#fff;box-shadow:0 6px 16px rgba(var(--primary-rgb,217,48,37),.24)}
      .cpo-btn.quiet{border-color:transparent;background:transparent;color:#667085;height:30px;padding:0 8px}
      .cpo-btn.quiet:hover:not(:disabled){background:#f2f4f7}
      .cpo-btn.icon{width:32px;padding:0}
      .cpo-btn.danger:hover:not(:disabled){border-color:#fda29b;color:#b42318}
      .cpo-btn .cpo-done{display:none}
      .cpo-btn.is-done .cpo-idle{display:none}
      .cpo-btn.is-done .cpo-done{display:inline;animation:cpoPop .28s ease}
      .cpo-help{color:#98a2b3;font-size:12px;cursor:help}
      /* Link card */
      .cpo-head-tools{display:flex;align-items:center;gap:10px;min-width:0}
      .cpo-head-action{height:38px;padding:0 14px;flex:0 0 auto}
      .cpo-head-action[aria-disabled="true"]{opacity:.5;cursor:not-allowed;box-shadow:none}
      .cpo-link-none{display:flex;align-items:center;color:#98a2b3;font-family:inherit;font-weight:800;border-style:dashed;background:#fcfcfd}
      .cpo-spin{animation:cpoSpin 1s linear infinite}
      .cpo-link{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
      .cpo-label{flex:0 0 auto;white-space:nowrap}
      .cpo-label{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:1000;color:#344054}
      .cpo-link-row{display:flex;align-items:center;gap:8px;min-width:0}
      .cpo-link-field{flex:1 1 auto;min-width:0;height:38px;box-sizing:border-box;border:1px solid #eaecf0;border-radius:10px;background:#f9fafb;color:#344054;padding:0 12px;font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none;text-overflow:ellipsis}
      .cpo-link-field:focus{border-color:var(--primary,#d93025);background:#fff}
      .cpo-link-field.is-pending{background:linear-gradient(110deg,#f2f4f7 8%,#fafbfc 18%,#f2f4f7 33%);background-size:200% 100%;animation:cpoShimmer 1.15s linear infinite;color:transparent}
      .cpo-link-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
      .cpo-options{display:flex;align-items:center;flex-wrap:wrap;gap:8px 18px;padding-top:10px;border-top:1px solid #f2f4f7}
      .cpo-switch{display:inline-flex;align-items:center;gap:9px;font-size:12px;font-weight:850;color:#344054;cursor:pointer;border-radius:8px;user-select:none}
      .cpo-switch input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
      .cpo-switch .cpo-track{position:relative;width:32px;height:18px;border-radius:999px;background:#d0d5dd;transition:background .2s ease;flex:0 0 auto}
      .cpo-switch .cpo-track::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.2);transition:transform .22s cubic-bezier(.22,1,.36,1)}
      .cpo-switch input:checked+.cpo-track{background:var(--primary,#d93025)}
      .cpo-switch input:checked+.cpo-track::after{transform:translateX(14px)}
      .cpo-switch input:disabled+.cpo-track{opacity:.55}
      .cpo-guest-count{border:0;background:#f2f4f7;color:#475467;border-radius:999px;height:24px;padding:0 9px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .16s ease,color .16s ease}
      .cpo-guest-count:hover,.cpo-guest-count[aria-expanded="true"]{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .cpo-guest-count i{transition:transform .2s ease}
      .cpo-guest-count[aria-expanded="true"] i{transform:rotate(180deg)}
      .cpo-reveal{display:grid;grid-template-rows:0fr;margin-top:-10px;transition:grid-template-rows .26s cubic-bezier(.22,1,.36,1),margin-top .26s cubic-bezier(.22,1,.36,1)}
      .cpo-reveal.is-open{grid-template-rows:1fr;margin-top:0}
      .cpo-reveal>div{overflow:hidden;min-height:0}
      .cpo-guests{display:flex;flex-direction:column;gap:6px;padding-top:2px}
      .cpo-guest{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid #f2f4f7;border-radius:10px;background:#fcfcfd}
      .cpo-guest-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
      .cpo-guest-copy strong{font-size:12px;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cpo-guest-copy span{font-size:11px;color:#667085}
      .cpo-guest-actions{display:flex;gap:4px;flex:0 0 auto}
      /* Media */
      .cpo-media{padding:14px;display:flex;flex-direction:column;gap:12px;position:relative}
      .cpo-media-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .cpo-media-head strong{font-size:14px;font-weight:1000}
      .cpo-media-head em{font-style:normal;color:#667085;font-size:12px;font-weight:850;margin-left:6px}
      .cpo-media-tools{display:flex;align-items:center;gap:8px}
      .cpo-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:10px;overflow:hidden;background:#fff}
      .cpo-seg button{height:32px;border:0;background:#fff;color:#667085;padding:0 11px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer;transition:background .16s ease,color .16s ease;white-space:nowrap}
      .cpo-seg button+button{border-left:1px solid #eaecf0}
      .cpo-seg button.active{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .cpo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
      .cpo-tile{position:relative;min-width:0;border:1px solid #eaecf0;border-radius:11px;background:#f2f4f7;padding:0;overflow:hidden;cursor:pointer;aspect-ratio:4/3;transition:border-color .16s ease,box-shadow .18s ease,transform .18s ease,opacity .2s ease}
      .cpo-tile:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(16,24,40,.10)}
      .cpo-tile[aria-pressed="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.35)}
      .cpo-tile:disabled{cursor:progress;opacity:.7;transform:none}
      .cpo-tile[hidden]{display:none}
      .cpo-grid[data-filter="shared"] .cpo-tile:not(.is-shared),.cpo-grid[data-filter="unshared"] .cpo-tile.is-shared{display:none}
      .cpo-thumb{position:absolute;inset:0;background:#e4e7ec}
      .cpo-thumb::before{content:'';position:absolute;inset:0;z-index:1;background:linear-gradient(110deg,#e4e7ec 8%,#f2f4f7 18%,#e4e7ec 33%);background-size:200% 100%;animation:cpoShimmer 1.15s linear infinite}
      .cpo-thumb.loaded::before,.cpo-thumb.failed::before{display:none}
      .cpo-thumb img,.cpo-thumb video{width:100%;height:100%;object-fit:cover;display:block}
      .cpo-thumb.failed img,.cpo-thumb.failed video{display:none}
      .cpo-fallback{position:absolute;inset:0;z-index:2;display:none;align-items:center;justify-content:center;color:#98a2b3;font-size:22px}
      .cpo-thumb.failed .cpo-fallback{display:flex}
      .cpo-tile:not(.is-shared) .cpo-thumb{filter:saturate(.75)}
      .cpo-check{position:absolute;z-index:3;top:7px;left:7px;width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(255,255,255,.9);background:rgba(16,24,40,.32);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;transition:background .16s ease,transform .2s cubic-bezier(.22,1,.36,1),opacity .16s ease;opacity:0}
      .cpo-tile:hover .cpo-check,.cpo-tile:focus-visible .cpo-check,.cpo-grid.has-selection .cpo-check{opacity:1}
      .cpo-check i{opacity:0;transform:scale(.4);transition:opacity .16s ease,transform .2s cubic-bezier(.22,1,.36,1)}
      .cpo-tile[aria-pressed="true"] .cpo-check{opacity:1;background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
      .cpo-tile[aria-pressed="true"] .cpo-check i{opacity:1;transform:none}
      .cpo-badge{position:absolute;z-index:3;top:7px;right:7px;height:22px;padding:0 8px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:1000;background:rgba(16,24,40,.55);color:#fff;backdrop-filter:blur(8px);opacity:0;transform:translateY(-3px) scale(.92);transition:opacity .2s ease,transform .22s cubic-bezier(.22,1,.36,1),background .2s ease}
      .cpo-tile.is-shared .cpo-badge{opacity:1;transform:none;background:#079455}
      .cpo-tile.is-pending .cpo-badge{opacity:1;transform:none;background:rgba(16,24,40,.55)}
      .cpo-kind{position:absolute;z-index:3;bottom:7px;left:7px;width:22px;height:22px;border-radius:7px;background:rgba(16,24,40,.55);color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px}
      .cpo-cover{display:flex;align-items:center;gap:12px;padding:8px 10px 8px 8px;border:1px solid #eaecf0;border-radius:11px;background:#fcfcfd;min-width:0;animation:cpoIn .28s ease both}
      .cpo-cover-media{flex:0 0 auto;width:76px;aspect-ratio:4/3;border-radius:8px;overflow:hidden;background:#f2f4f7;display:flex;align-items:center;justify-content:center;color:#98a2b3;font-size:18px}
      .cpo-cover-media img{width:100%;height:100%;object-fit:cover;display:block}
      .cpo-cover-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
      .cpo-cover-kicker{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.08em;color:var(--primary-readable,var(--primary,#d93025))}
      .cpo-cover-copy strong{font-size:13px;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cpo-cover-state{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:1000;transition:background .2s ease,color .2s ease}
      .cpo-cover-state.is-shared{background:#ecfdf3;color:#067647}
      .cpo-cover-chip{position:absolute;z-index:3;bottom:7px;left:7px;height:22px;padding:0 8px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:1000;background:var(--primary,#d93025);color:#fff}
      .cpo-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 12px;color:#667085;font-size:12px;font-weight:800;text-align:center}
      .cpo-empty i{width:40px;height:40px;border-radius:12px;background:#f2f4f7;color:#98a2b3;display:flex;align-items:center;justify-content:center;font-size:16px}
      .cpo-media{transition:padding-bottom .26s cubic-bezier(.22,1,.36,1)}
      .cpo-media.has-selection{padding-bottom:62px}
      .cpo-selwrap{position:sticky;bottom:58px;z-index:5;height:0;display:flex;justify-content:center;margin-top:-12px}
      .cpo-selbar{position:absolute;top:4px;display:flex;align-items:center;gap:8px;padding:6px 6px 6px 14px;border-radius:12px;background:#101828;color:#fff;box-shadow:0 14px 34px rgba(16,24,40,.28);font-size:12px;font-weight:900;opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .2s ease,transform .26s cubic-bezier(.22,1,.36,1);max-width:100%;flex-wrap:wrap;justify-content:center}
      .cpo-selbar.is-open{opacity:1;transform:none;pointer-events:auto}
      .cpo-selbar .cpo-btn{height:32px;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff}
      .cpo-selbar .cpo-btn:hover:not(:disabled){border-color:rgba(255,255,255,.4);color:#fff;background:rgba(255,255,255,.14)}
      .cpo-selbar .cpo-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
      .cpo-selbar .cpo-btn:disabled{opacity:.4}
      /* History */
      .cpo-history{display:flex;flex-direction:column;min-width:0;position:sticky;top:0;max-height:calc(100vh - 150px)}
      .cpo-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 8px 14px}
      .cpo-history-head strong{font-size:14px;font-weight:1000}
      .cpo-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:0 12px 10px}
      .cpo-stat{border:1px solid #f2f4f7;border-radius:9px;padding:7px 8px;background:#fcfcfd;min-width:0}
      .cpo-stat span{display:block;font-size:10px;font-weight:900;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cpo-stat b{display:block;margin-top:2px;font-size:13px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cpo-timeline{overflow:auto;min-height:0;padding:0 8px 10px;border-top:1px solid #f2f4f7}
      .cpo-day{position:sticky;top:0;z-index:1;background:#fff;padding:9px 6px 5px;font-size:10px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3}
      .cpo-event{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;align-items:start;padding:6px;border-radius:9px;transition:background .16s ease;animation:cpoIn .26s ease both}
      .cpo-event:hover{background:#f9fafb}
      .cpo-event>i{width:26px;height:26px;border-radius:8px;background:#f2f4f7;color:#475467;display:flex;align-items:center;justify-content:center;font-size:11px}
      .cpo-event.is-view>i{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .cpo-event-copy{min-width:0;display:flex;flex-direction:column;gap:1px}
      .cpo-event-copy strong{font-size:12px;font-weight:900;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cpo-event-copy span{font-size:11px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cpo-tag{display:inline-block;margin-left:5px;padding:0 6px;border-radius:999px;background:#f4ebff;color:#6941c6;font-size:10px;font-weight:1000;vertical-align:1px}
      .cpo-more{margin:6px auto 0;display:flex}
      @container cpo (max-width: 900px){
        .cpo-body{grid-template-columns:minmax(0,1fr) 260px}
      }
      @container cpo (max-width: 760px){
        .cpo-wrap{padding:12px}
        .cpo-body{grid-template-columns:minmax(0,1fr)}
        .cpo-history{position:static;max-height:none}
        .cpo-timeline{max-height:420px}
        .cpo-grid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
      }
      @container cpo (max-width: 600px){
        .cpo-link-row{flex-wrap:wrap}
        .cpo-link-field{flex:1 1 0}
        .cpo-link-actions{flex:1 1 100%}
        .cpo-link-actions .cpo-btn{flex:1 1 0}
      }
      @container cpo (max-width: 420px){
        .cpo-head-action{width:38px;padding:0}
        .cpo-head-action span{display:none}
        .cpo-link-actions .cpo-btn i{display:none}
        .cpo-link-actions .cpo-btn{padding:0 8px}
        .cpo-seg button{padding:0 8px}
      }
      @keyframes cpoIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
      @keyframes cpoPop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
      @keyframes cpoSpin{to{transform:rotate(360deg)}}
      @keyframes cpoShimmer{from{background-position:200% 0}to{background-position:-200% 0}}
      @media (prefers-reduced-motion: reduce){
        .cpo-panel *,.cpo-panel *::before,.cpo-panel *::after{animation:none!important;transition:none!important}
      }
    `;
    if (typeof util.injectCSS === 'function') util.injectCSS('project-customer-portal', css);
    else if (!document.getElementById('project-customer-portal')) {
      const style = document.createElement('style');
      style.id = 'project-customer-portal';
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  /* ---------- data ---------- */

  function panelHtml(){
    return '<div class="cpo-panel" id="rCustomerPortalPanel"></div>';
  }

  function resolveRoot(context = {}){
    const root = context.panelRoot || context.roots?.main || state.panelRoot || $('#rCustomerPortalPanel');
    if (root?.id === 'rCustomerPortalPanel') return root;
    return root?.querySelector?.('#rCustomerPortalPanel') || root || null;
  }

  function setPortal(next){
    state.portal = next && typeof next === 'object'
      ? next
      : { loading: false, portal: null, activity: [], error: '' };
    if (state.model?.state) state.model.state.customerPortalState = state.portal;
    return state.portal;
  }

  function sharedPortalMediaIds(){
    const items = Array.isArray(state.portal.portal?.shared_items) ? state.portal.portal.shared_items : [];
    return new Set(items
      .filter((item) => String(item?.type || 'media') === 'media')
      .map((item) => String(item?.item_id || item?.media_id || item?.id || '').trim())
      .filter(Boolean));
  }

  function portalLinks(){
    const portal = (projectId() && state.portal.portal) || {};
    return { live: String(portal.live_url || '').trim(), preview: String(portal.preview_url || '').trim() };
  }

  function customerEmail(){
    return firstText(state.portal.portal?.customer?.email, projectContact().email);
  }

  function activeGuestLinks(){
    const links = Array.isArray(state.portal.portal?.guest_links) ? state.portal.portal.guest_links : [];
    return links.filter((item) => String(item?.status || '').toLowerCase() === 'active');
  }

  // A draft project (not saved yet) shows the whole tab empty. Opening or
  // reading it never creates the project; the first thing that writes (Generate
  // link, sharing media, a switch) saves the draft through the project window's
  // ensureProject (the path the To Do, Activity and Agent trays use), then acts.
  let draftSave = null;
  function ensureProjectFn(){
    const own = state.ensureProject || state.host?.ensureProject;
    if (typeof own === 'function') return own;
    // The project window's tray path: create the draft record, then save it remotely.
    if (typeof window.ensureDraftBaseProject === 'function' && window.Portal?.ProjectStore?.saveRemote) {
      return async () => {
        const created = window.ensureDraftBaseProject({ allowEmpty: true });
        if (!created) throw new Error(L('cpo_save_failed', 'The project could not be saved.'));
        await window.Portal.ProjectStore.saveRemote(created);
        return project();
      };
    }
    return null;
  }

  async function ensureSavedProject(){
    if (projectId()) return true;
    const ensure = ensureProjectFn();
    if (!ensure) throw new Error(L('cpo_save_failed', 'The project could not be saved.'));
    draftSave ||= Promise.resolve().then(() => ensure()).finally(() => { draftSave = null; });
    await draftSave;
    if (!projectId()) throw new Error(L('cpo_save_failed', 'The project could not be saved.'));
    return true;
  }

  // Runs a write, saving a draft project first and loading its portal, so the
  // tab adopts the new project in place.
  async function withSavedProject(action){
    if (projectId() && state.portal.portal) return action ? action() : true;
    try {
      state.saving = true;
      render();
      await ensureSavedProject();
      if (!state.portal.portal) await load({ silent: true });
      if (!state.portal.portal) return false;
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || L('cpo_save_failed', 'The project could not be saved.') });
      render();
      return false;
    } finally {
      state.saving = false;
      renderStatus();
    }
    return action ? action() : true;
  }

  async function load(options = {}){
    if (!customerPortalEnabled()) return;
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !window.PlatformAPI?.customerPortals) return;
    setPortal({ ...state.portal, loading: true, error: '' });
    if (!options.silent) render();
    else renderStatus();
    try {
      const [portalResult, activityResult] = await Promise.all([
        window.PlatformAPI.customerPortals.ensure(oid, pid, { contact_id: projectContact().id, customer: projectContact() }),
        window.PlatformAPI.customerPortals.activity(oid, pid).catch(() => ({ events: [] }))
      ]);
      setPortal({
        loading: false,
        portal: portalResult.portal || null,
        activity: Array.isArray(activityResult.events) ? activityResult.events : [],
        error: ''
      });
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || L('cpo_load_failed', 'Could not load the customer portal.') });
    }
    render();
  }

  async function updateSharing(mediaIds, shared){
    const ids = (Array.isArray(mediaIds) ? mediaIds : [mediaIds]).map((id) => String(id || '').trim()).filter(Boolean);
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !ids.length || !window.PlatformAPI?.customerPortals) return;
    markPending(ids, true);
    try {
      setPortal({ ...state.portal, loading: true });
      renderStatus();
      const result = shared
        ? await window.PlatformAPI.customerPortals.shareMedia(oid, pid, ids)
        : await window.PlatformAPI.customerPortals.unshareMedia(oid, pid, ids);
      setPortal({ ...state.portal, loading: false, portal: result.portal || state.portal.portal, error: '' });
      ids.forEach((id) => state.selection.delete(id));
      const count = ids.length;
      showToast(
        shared ? L('cpo_toast_shared', 'Shared with customer') : L('cpo_toast_hidden', 'Hidden from customer'),
        count === 1 ? L('cpo_toast_one_item', '1 item updated.') : L('cpo_toast_items', '{count} items updated.', { count }),
        true
      );
      render();
      return true;
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || L('cpo_share_failed', 'Could not update what the customer sees.') });
      showToast(L('cpo_toast_update_failed', 'Portal update failed'), state.portal.error, false);
      render();
      return false;
    }
  }

  async function updateSettings(patch, toast){
    const oid = orgId();
    const pid = projectId();
    const portal = state.portal.portal || {};
    if (!oid || !pid || !window.PlatformAPI?.customerPortals) return;
    try {
      setPortal({ ...state.portal, loading: true });
      renderStatus();
      const result = await window.PlatformAPI.customerPortals.update(oid, pid, {
        settings: { ...(portal.settings || {}), ...patch(portal.settings || {}) }
      });
      setPortal({ ...state.portal, loading: false, portal: result.portal || portal, error: '' });
      showToast(toast[0], toast[1], true);
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || L('cpo_settings_failed', 'Could not update the portal.') });
    }
    render();
  }

  function setCustomerSharingEnabled(enabled){
    return withSavedProject(() => updateSettings(
      (settings) => ({ sharing: { ...(settings.sharing || {}), enabled: enabled === true } }),
      enabled
        ? [L('cpo_toast_guests_on', 'Guest links on'), L('cpo_toast_guests_on_body', 'The customer can now share read-only guest links.')]
        : [L('cpo_toast_guests_off', 'Guest links off'), L('cpo_toast_guests_off_body', 'The customer can no longer make new guest links.')]
    ));
  }

  function setCustomerReschedulingEnabled(enabled){
    return withSavedProject(() => updateSettings(
      (settings) => ({ scheduling: { ...(settings.scheduling || {}), enabled: enabled === true, reschedule: enabled === true } }),
      enabled
        ? [L('cpo_toast_resched_on', 'Rescheduling on'), L('cpo_toast_resched_on_body', 'Eligible appointments can be rescheduled in the portal.')]
        : [L('cpo_toast_resched_off', 'Rescheduling off'), L('cpo_toast_resched_off_body', 'The customer can no longer reschedule from the portal.')]
    ));
  }

  async function revokeGuestShare(shareId){
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !shareId || !window.PlatformAPI?.customerPortals?.revokeShare) return;
    if (!window.confirm(L('cpo_revoke_confirm', 'Revoke this guest link now? Anyone using it loses access immediately.'))) return;
    try {
      setPortal({ ...state.portal, loading: true });
      renderStatus();
      await window.PlatformAPI.customerPortals.revokeShare(oid, pid, shareId);
      await load({ silent: true });
      showToast(L('cpo_toast_revoked', 'Guest link revoked'), L('cpo_toast_revoked_body', 'That link can no longer open the portal.'), true);
    } catch (error) {
      setPortal({ ...state.portal, loading: false, error: error?.message || L('cpo_revoke_failed', 'Could not revoke the guest link.') });
      render();
    }
  }

  function flashDone(button){
    if (!button) return;
    button.classList.add('is-done');
    clearTimeout(button._cpoDone);
    button._cpoDone = setTimeout(() => button.classList.remove('is-done'), 1600);
  }

  async function copyLink(url, button){
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      flashDone(button);
      showToast(L('cpo_toast_copied', 'Link copied'), L('cpo_toast_copied_body', 'Paste it anywhere you send the customer messages.'), true);
    } catch (_) {
      showToast(L('cpo_toast_copy_failed', 'Copy failed'), L('cpo_toast_copy_failed_body', 'Could not copy the link. Select it and copy it by hand.'), false);
    }
  }

  function emailHref(url){
    const subject = L('cpo_email_subject', 'Your project portal');
    const body = L('cpo_email_body', 'Here is your private project portal:\n\n{url}', { url });
    return `mailto:${encodeURIComponent(customerEmail())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function downloadQr(url, button){
    if (!url) return;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=640x640&margin=16&data=${encodeURIComponent(url)}`;
    const save = (href) => {
      const link = document.createElement('a');
      link.href = href;
      link.download = 'customer-portal-qr.png';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    try {
      const response = await fetch(qrUrl, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error('qr');
      const objectUrl = URL.createObjectURL(await response.blob());
      save(objectUrl);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
      flashDone(button);
    } catch (_) {
      // Cross-origin download blocked: open the image so it can be saved.
      window.open(qrUrl, '_blank', 'noopener');
    }
  }

  /* ---------- history ---------- */

  function eventDate(event = {}){
    const parsed = new Date(firstText(event.created_at, event.createdAt, event.timestamp));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatTime(date){
    return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }

  function formatWhen(date, options = {}){
    if (!date) return '';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(options.includeYear ? { year: 'numeric' } : {})
    });
  }

  function formatDate(date){
    return date ? date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  function dayKey(date){
    return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : 'unknown';
  }

  function dayLabel(date){
    if (!date) return L('cpo_day_unknown', 'Undated');
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    if (dayKey(date) === dayKey(today)) return L('cpo_day_today', 'Today');
    if (dayKey(date) === dayKey(yesterday)) return L('cpo_day_yesterday', 'Yesterday');
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
  }

  function relative(date){
    if (!date) return L('cpo_never', 'Never');
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return L('cpo_just_now', 'Just now');
    if (minutes < 60) return L('cpo_minutes_ago', '{n}m ago', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return L('cpo_hours_ago', '{n}h ago', { n: hours });
    const days = Math.round(hours / 24);
    if (days < 7) return L('cpo_days_ago', '{n}d ago', { n: days });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function eventType(event = {}){
    return firstText(event.type, event.event).replace(/^customer_portal\./, '');
  }

  const EVENT_META = {
    viewed: ['fa-eye', () => L('cpo_ev_viewed', 'Opened the portal')],
    tab_opened: ['fa-table-columns', (event) => L('cpo_ev_tab', 'Opened {tab}', { tab: firstText(event.tab, event.metadata?.tab, L('cpo_ev_tab_fallback', 'a page')) })],
    media_opened: ['fa-image', () => L('cpo_ev_media_opened', 'Viewed media')],
    media_downloaded: ['fa-download', () => L('cpo_ev_media_downloaded', 'Downloaded media')],
    proposal_opened: ['fa-file-signature', () => L('cpo_ev_proposal_opened', 'Opened a proposal')],
    proposal_downloaded: ['fa-file-arrow-down', () => L('cpo_ev_proposal_downloaded', 'Downloaded a proposal')],
    proposal_printed: ['fa-print', () => L('cpo_ev_proposal_printed', 'Printed a proposal')],
    workflow_step_opened: ['fa-list-check', (event) => L('cpo_ev_step', 'Opened {step}', { step: firstText(event.step, event.metadata?.step, L('cpo_ev_step_fallback', 'a step')) })],
    project_opened: ['fa-right-left', () => L('cpo_ev_project', 'Switched project')]
  };

  function eventMeta(event = {}){
    const type = eventType(event);
    const known = EVENT_META[type];
    if (known) return { icon: known[0], label: known[1](event), type };
    const words = type.replace(/[._]/g, ' ').trim();
    return { icon: 'fa-circle-dot', label: words ? words[0].toUpperCase() + words.slice(1) : L('cpo_ev_generic', 'Portal activity'), type };
  }

  function eventIp(event = {}){
    const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const request = metadata.request && typeof metadata.request === 'object' ? metadata.request : {};
    return firstText(event.visitor_ip, event.ip_address, event.client_ip, event.ip, request.client_ip, request.request_ip, request.remote_address);
  }

  function eventLocation(event = {}){
    return [event.city, event.region, event.country].map((part) => firstText(part)).filter(Boolean).join(', ');
  }

  function eventBrowser(event = {}){
    const ua = firstText(event.user_agent);
    if (!ua) return '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
    const platform = /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : '';
    return [browser, platform].filter(Boolean).join(' · ');
  }

  function mediaLabel(id){
    const photo = photos().find((item) => photoId(item) === id);
    return firstText(photo?.label, photo?.alt);
  }

  function guestLabel(event = {}){
    if (String(event.portal_access_mode || '') !== 'guest') return '';
    const links = Array.isArray(state.portal.portal?.guest_links) ? state.portal.portal.guest_links : [];
    const link = links.find((item) => item.id === event.portal_guest_link_id);
    return firstText(link?.label, L('cpo_guest_default', 'Guest link'));
  }

  function eventTooltip(event, date){
    const lines = [formatWhen(date, { includeYear: true })];
    const guest = guestLabel(event);
    if (guest) lines.push(L('cpo_tip_via_guest', 'Through the guest link “{label}”', { label: guest }));
    const where = eventLocation(event);
    if (where) lines.push(where);
    const browser = eventBrowser(event);
    if (browser) lines.push(browser);
    const ip = eventIp(event);
    if (ip) lines.push(L('cpo_tip_ip', 'IP {ip}', { ip }));
    return lines.filter(Boolean).join('\n');
  }

  function historyStatsHtml(events){
    const views = events.filter((event) => eventType(event) === 'viewed').length;
    const visitors = new Set(events.map((event) => eventIp(event) || firstText(event.visitor_session_id, event.user_agent_hash)).filter(Boolean)).size;
    const latest = events.map(eventDate).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const stats = [
      [L('cpo_stat_visits', 'Visits'), views, L('cpo_tip_stat_visits', 'How many times the portal was opened.')],
      [L('cpo_stat_people', 'Devices'), visitors, L('cpo_tip_stat_people', 'Different networks or devices that opened the portal. A second one can mean the customer shared the link or a guest link.')],
      [L('cpo_stat_last', 'Last seen'), relative(latest), latest ? formatWhen(latest, { includeYear: true }) : L('cpo_tip_stat_never', 'Nobody has opened the portal yet.')]
    ];
    return `<div class="cpo-stats">${stats.map(([label, value, tip]) => `<div class="cpo-stat" data-fm-tooltip="${esc(tip)}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div>`;
  }

  function historyListHtml(events){
    if (!events.length) {
      return `<div class="cpo-empty" data-cpo-history-empty><i class="fas fa-clock-rotate-left"></i><span>${H('cpo_history_empty', 'No visits yet')}</span></div>`;
    }
    const sorted = [...events].sort((a, b) => (eventDate(b)?.getTime() || 0) - (eventDate(a)?.getTime() || 0));
    const shown = sorted.slice(0, state.historyLimit);
    let currentDay = null;
    const rows = shown.map((event) => {
      const date = eventDate(event);
      const meta = eventMeta(event);
      const key = dayKey(date);
      const header = key !== currentDay ? `<div class="cpo-day">${esc(dayLabel(date))}</div>` : '';
      currentDay = key;
      const detail = firstText(event.media_id ? mediaLabel(event.media_id) : '', eventBrowser(event));
      const guest = guestLabel(event);
      return `${header}<div class="cpo-event${meta.type === 'viewed' ? ' is-view' : ''}" data-cpo-event data-fm-tooltip="${esc(eventTooltip(event, date))}">
        <i class="fas ${esc(meta.icon)}"></i>
        <div class="cpo-event-copy"><strong>${esc(meta.label)}${guest ? `<span class="cpo-tag">${H('cpo_tag_guest', 'Guest')}</span>` : ''}</strong><span>${esc([formatTime(date), detail].filter(Boolean).join(' · '))}</span></div>
      </div>`;
    }).join('');
    const more = sorted.length > shown.length
      ? `<button type="button" class="cpo-btn quiet cpo-more" data-cpo-history-more>${H('cpo_history_more', 'Show {n} more', { n: Math.min(HISTORY_PAGE, sorted.length - shown.length) })}</button>`
      : '';
    return rows + more;
  }

  /* ---------- cover ---------- */

  // The project's cover, resolved as the Photos tab does: the chosen
  // cover_photo media, else the satellite image (projectMedia.primaryPhoto).
  function coverOptions(){
    return {
      orgId: orgId(),
      firstMeasureUrlBuilder: util.fmUrl || ((path) => String(path || '')),
      googleMapsApiKey: Portal?.util?.googleMapsApiKey?.() || '',
      width: 640
    };
  }

  function coverInfo(){
    const current = project() || {};
    const values = current.custom_field_values || current.custom_fields || {};
    const chosenId = String(values.cover_photo?.media_id || '').trim();
    const library = libraryMedia();
    const chosen = chosenId ? library.find((photo) => photoId(photo) === chosenId || String(photo?.media_id || '') === chosenId) || null : null;
    const media = window.PlatformAPI?.projectMedia;
    let photo = null;
    try { photo = media?.primaryPhoto?.({ ...current, photos: library }, coverOptions()) || null; } catch (_) { photo = null; }
    if (!photo && chosen) photo = chosen;
    if (!photo) return null;
    const resolvedId = String(photo.media_id || photo.id || '').trim();
    const isChosen = !!chosenId && resolvedId === chosenId;
    const mediaId = isChosen ? chosenId : (photo.is_top_down_thumbnail ? '' : photoId(photo));
    let src = '';
    if (mediaId) {
      try { src = String(window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), mediaId, 320) || '').trim(); } catch (_) { src = ''; }
    }
    src = src || String(photo.thumb || photo.src || '').trim();
    let staticMap = null;
    if (photo.is_top_down_thumbnail && photo.source !== 'google_static_map') {
      try { staticMap = media?.googleStaticMapPhoto?.(current, coverOptions()) || null; } catch (_) { staticMap = null; }
    }
    const fallbacks = [...new Set([photo.src, chosen?.thumb, chosen?.src, staticMap?.thumb || staticMap?.src].map((url) => String(url || '').trim()))].filter((url) => url && url !== src);
    const entry = mediaId ? library.find((item) => photoId(item) === mediaId) : null;
    return {
      kind: photo.is_top_down_thumbnail ? 'satellite' : (isChosen ? 'chosen' : 'library'),
      mediaId: entry ? photoId(entry) : '',
      src,
      fallbacks,
      label: firstText(entry?.file_name, entry?.label, photo.file_name, photo.label, photo.alt) || L('cpo_cover_label', 'Cover photo')
    };
  }

  function coverTip(cover, shared){
    if (!cover.mediaId) return L('cpo_tip_cover_satellite', 'The project’s cover: its satellite image, shown on the project tile and in Overview. The customer’s portal does not show a cover image, so the customer does not see this. Choose another cover in Photos.');
    return shared
      ? L('cpo_tip_cover_shared', 'The project’s cover, shown on the project tile and in Overview. The customer can see this photo with the shared media below. The customer’s portal does not show it as a cover.')
      : L('cpo_tip_cover_hidden', 'The project’s cover, shown on the project tile and in Overview. It is hidden from the customer; share it below if they should see it. The customer’s portal does not show a cover image.');
  }

  function coverStateHtml(cover, shared){
    if (!cover.mediaId) return `<i class="fas fa-eye-slash"></i>${H('cpo_cover_not_in_portal', 'Not in portal')}`;
    return shared ? `<i class="fas fa-eye"></i>${H('cpo_badge_shared', 'Shared')}` : `<i class="fas fa-eye-slash"></i>${H('cpo_cover_hidden', 'Hidden')}`;
  }

  function coverHtml(cover, shared){
    if (!cover) return '';
    const isShared = !!cover.mediaId && shared.has(cover.mediaId);
    return `<div class="cpo-cover" data-cpo-cover data-cover-kind="${esc(cover.kind)}" data-cover-media="${esc(cover.mediaId)}" data-fm-tooltip="${esc(coverTip(cover, isShared))}">
      <span class="cpo-cover-media">${cover.src ? `<img src="${esc(cover.src)}" alt=""${cover.fallbacks.length ? ` data-cpo-fallbacks="${esc(JSON.stringify(cover.fallbacks))}"` : ''}>` : '<i class="fas fa-image"></i>'}</span>
      <span class="cpo-cover-copy"><span class="cpo-cover-kicker"><i class="fas fa-image"></i>${H('cpo_cover_kicker', 'Cover')}</span><strong>${esc(cover.kind === 'satellite' ? L('cpo_cover_satellite', 'Satellite image') : cover.label)}</strong></span>
      <span class="cpo-cover-state${isShared ? ' is-shared' : ''}" data-cpo-cover-state>${coverStateHtml(cover, isShared)}</span>
    </div>`;
  }

  function bindCoverFallbacks(root){
    root.querySelectorAll('.cpo-cover img[data-cpo-fallbacks]').forEach((img) => {
      img.addEventListener('error', () => {
        let rest = [];
        try { rest = JSON.parse(img.dataset.cpoFallbacks) || []; } catch (_) { rest = []; }
        const next = rest.shift();
        img.dataset.cpoFallbacks = JSON.stringify(rest);
        if (next) img.src = next;
        else img.replaceWith(Object.assign(document.createElement('i'), { className: 'fas fa-image' }));
      });
    });
  }

  /* ---------- rendering ---------- */

  function tileTip(label, shared){
    return shared
      ? L('cpo_tip_tile_shared', '{label}\nThe customer can see this. Click to select it.', { label })
      : L('cpo_tip_tile_hidden', '{label}\nHidden from the customer. Click to select it.', { label });
  }

  function mediaTileHtml(photo, shared, pending, cover = false){
    const id = photoId(photo);
    const label = firstText(photo?.label, photo?.alt, L('cpo_media_untitled', 'Project media'));
    const video = isVideo(photo);
    const imageSrc = String(photo?.thumb || photo?.src || '').trim();
    const videoThumbSrc = String(photo?.thumb || '').trim();
    const originalSrc = String(photo?.src || photo?.thumb || '').trim();
    let media = '';
    if (video) {
      if (videoThumbSrc) media = `<img src="${esc(videoThumbSrc)}" alt="" loading="lazy" decoding="async" data-cp-thumb-img data-cp-base-src="${esc(videoThumbSrc)}" data-cp-original-src="${esc(originalSrc)}" data-cp-media-kind="video">`;
      else if (originalSrc) media = `<video src="${esc(originalSrc)}" muted playsinline preload="metadata" data-cp-thumb-video></video>`;
    } else if (imageSrc) {
      media = `<img src="${esc(imageSrc)}" alt="" loading="lazy" decoding="async" data-cp-thumb-img data-cp-base-src="${esc(imageSrc)}" data-cp-media-kind="image">`;
    }
    const selected = state.selection.has(id);
    return `<button type="button" class="cpo-tile${shared ? ' is-shared' : ''}${pending ? ' is-pending' : ''}" data-cpo-tile="${esc(id)}" data-cpo-label="${esc(label)}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${esc(label)}" data-fm-tooltip="${esc(tileTip(label, shared))}">
      <span class="cpo-thumb${media ? '' : ' failed'}">${media}<span class="cpo-fallback"><i class="fas ${video ? 'fa-video' : 'fa-image'}"></i></span></span>
      <span class="cpo-check"><i class="fas fa-check"></i></span>
      <span class="cpo-badge"><i class="fas fa-eye"></i>${H('cpo_badge_shared', 'Shared')}</span>
      ${video ? '<span class="cpo-kind"><i class="fas fa-play"></i></span>' : ''}
      ${cover ? `<span class="cpo-cover-chip" data-cpo-tile-cover><i class="fas fa-image"></i>${H('cpo_cover_kicker', 'Cover')}</span>` : ''}
    </button>`;
  }

  function linkCardHtml(){
    const links = portalLinks();
    const ready = !!links.live;
    const email = customerEmail();
    const disabled = ready ? '' : ' disabled';
    const label = `<span class="cpo-label">${H('cpo_link_label', 'Customer link')}<i class="fas fa-circle-info cpo-help" tabindex="0" data-fm-tooltip="${H('cpo_tip_link', 'The customer’s private link to their portal for this project. Anyone with it can open the portal, so send it only to the customer.')}"></i></span>`;
    // No link yet (a draft project): offer to make one. Generating saves the project.
    if (!ready && !projectId()) {
      const busy = state.saving || state.portal.loading;
      return `
      <div class="cpo-link-row">
        ${label}
        <span class="cpo-link-field cpo-link-none" data-cpo-no-link>${H('cpo_no_link', 'No link yet')}</span>
        <div class="cpo-link-actions">
          <button type="button" class="cpo-btn primary" data-cpo-generate${busy ? ' disabled' : ''} data-fm-tooltip="${H('cpo_tip_generate', 'Make the customer’s private portal link. This saves the project, so it appears in your projects. Nothing is sent to the customer.')}"><i class="fas ${busy ? 'fa-rotate cpo-spin' : 'fa-link'}"></i><span>${H('cpo_generate', 'Generate link')}</span></button>
        </div>
      </div>
      ${optionsHtml()}
    `;
    }
    return `
      <div class="cpo-link-row">
        ${label}
        <input class="cpo-link-field${ready ? '' : ' is-pending'}" data-cpo-link readonly data-fmr-mask aria-label="${H('cpo_link_label', 'Customer link')}" value="${esc(links.live)}">
        <div class="cpo-link-actions">
          <button type="button" class="cpo-btn" data-cpo-copy${disabled} data-fm-tooltip="${H('cpo_tip_copy', 'Copy the customer link to paste into a text or message.')}"><i class="fas fa-copy cpo-idle"></i><i class="fas fa-check cpo-done"></i><span>${H('cpo_copy', 'Copy')}</span></button>
          <a class="cpo-btn" data-cpo-email${ready ? ` href="${esc(emailHref(links.live))}"` : ' aria-disabled="true"'} data-fm-tooltip="${esc(email ? L('cpo_tip_email_to', 'Opens your email app with the link filled in, addressed to {email}. Nothing is sent until you send it.', { email }) : L('cpo_tip_email', 'Opens your email app with the link filled in. This contact has no email address, so add the recipient yourself. Nothing is sent until you send it.'))}"><i class="fas fa-envelope"></i><span>${H('cpo_email', 'Email')}</span></a>
          <button type="button" class="cpo-btn" data-cpo-qr${disabled} data-fm-tooltip="${H('cpo_tip_qr', 'Download a QR code of the customer link, for a printout, a yard sign or a leave-behind.')}"><i class="fas fa-qrcode cpo-idle"></i><i class="fas fa-check cpo-done"></i><span>${H('cpo_qr', 'Download QR')}</span></button>
        </div>
      </div>
      ${optionsHtml()}
    `;
  }

  function optionsHtml(){
    const portal = state.portal.portal || {};
    const sharingOn = portal.settings?.sharing?.enabled === true;
    const reschedulingOn = portal.settings?.scheduling?.enabled === true && portal.settings?.scheduling?.reschedule === true;
    const guests = activeGuestLinks();
    const disabled = state.portal.loading || state.saving || (projectId() && !state.portal.portal) ? ' disabled' : '';
    const guestCount = guests.length
      ? `<button type="button" class="cpo-guest-count" data-cpo-guests-toggle aria-expanded="${state.guestOpen ? 'true' : 'false'}" data-fm-tooltip="${H('cpo_tip_guest_list', 'Guest links that still work. Open the list to copy or revoke one.')}">${esc(guests.length === 1 ? L('cpo_guest_count_one', '1 active') : L('cpo_guest_count', '{n} active', { n: guests.length }))}<i class="fas fa-chevron-down"></i></button>`
      : '';
    const resched = capabilityOn(RESCHEDULING_CAPABILITY) ? `
        <label class="cpo-switch" data-cpo-resched-switch data-fm-tooltip="${H('cpo_tip_resched', 'Lets the customer pick a new time for an upcoming appointment from live availability, when that appointment’s scheduling rules also allow it. Off: only your team reschedules.')}">
          <input type="checkbox" data-cpo-rescheduling${reschedulingOn ? ' checked' : ''}${disabled}><span class="cpo-track"></span><span>${H('cpo_resched_label', 'Customer can reschedule')}</span>
        </label>` : '';
    return `
      <div class="cpo-options">
        <label class="cpo-switch" data-cpo-guest-switch data-fm-tooltip="${H('cpo_tip_guests', 'Lets the customer make their own read-only links to share the portal with someone else, such as a family member or an adjuster. Guest links can expire, never include payments, signing, approvals or editing, and you can revoke any of them here. Turning this off stops new links; existing ones keep working until they expire or you revoke them.')}">
          <input type="checkbox" data-cpo-sharing${sharingOn ? ' checked' : ''}${disabled}><span class="cpo-track"></span><span>${H('cpo_guests_label', 'Customer can share guest links')}</span>
        </label>
        ${guestCount}
        ${resched}
      </div>
      ${guests.length ? `<div class="cpo-reveal${state.guestOpen ? ' is-open' : ''}" data-cpo-guests><div><div class="cpo-guests">${guests.map(guestRowHtml).join('')}</div></div></div>` : ''}
    `;
  }

  function guestRowHtml(item){
    const presets = {
      full_view: L('cpo_preset_full', 'Full view'),
      project_updates: L('cpo_preset_updates', 'Schedule and photos'),
      photos_only: L('cpo_preset_photos', 'Photos only')
    };
    const expires = item.expires_at ? L('cpo_guest_expires', 'Expires {date}', { date: formatDate(new Date(item.expires_at)) }) : L('cpo_guest_never', 'Never expires');
    const seen = item.last_viewed_at ? L('cpo_guest_seen', 'last opened {when}', { when: relative(new Date(item.last_viewed_at)) }) : L('cpo_guest_unseen', 'not opened yet');
    const by = String(item.created_by || '').startsWith('staff:') ? L('cpo_guest_by_staff', 'Made by your team') : L('cpo_guest_by_customer', 'Made by the customer');
    return `<div class="cpo-guest" data-cpo-guest="${esc(item.id)}">
      <div class="cpo-guest-copy" data-fm-tooltip="${esc([by, presets[item.preset] || '', item.created_at ? L('cpo_guest_created', 'Created {date}', { date: formatDate(new Date(item.created_at)) }) : ''].filter(Boolean).join('\n'))}">
        <strong>${esc(item.label || L('cpo_guest_default', 'Guest link'))}</strong>
        <span>${esc([presets[item.preset] || '', expires, seen].filter(Boolean).join(' · '))}</span>
      </div>
      <div class="cpo-guest-actions">
        ${item.url ? `<button type="button" class="cpo-btn quiet icon" data-cpo-guest-copy="${esc(item.id)}" aria-label="${H('cpo_guest_copy', 'Copy guest link')}" data-fm-tooltip="${H('cpo_guest_copy', 'Copy guest link')}"><i class="fas fa-copy cpo-idle"></i><i class="fas fa-check cpo-done"></i></button>` : ''}
        <button type="button" class="cpo-btn quiet icon danger" data-cpo-revoke="${esc(item.id)}" aria-label="${H('cpo_guest_revoke', 'Revoke guest link')}" data-fm-tooltip="${H('cpo_tip_revoke', 'Revoke: this link stops working immediately.')}"><i class="fas fa-ban"></i></button>
      </div>
    </div>`;
  }

  function mediaCardHtml(){
    const shared = sharedPortalMediaIds();
    const items = libraryMedia();
    const cover = coverInfo();
    const sharedCount = items.filter((photo) => shared.has(photoId(photo))).length;
    const filter = state.mediaFilter;
    const head = `
      <div class="cpo-media-head">
        <div><strong data-fm-tooltip="${H('cpo_tip_media', 'Photos and videos added in the Photos tab. Choose which ones the customer sees in their portal.')}">${H('cpo_media_title', 'Media')}</strong>${items.length ? `<em data-cpo-media-count>${esc(L('cpo_media_count', '{shared} of {total} shared', { shared: sharedCount, total: items.length }))}</em>` : ''}</div>
        ${items.length ? `<div class="cpo-media-tools">
          <div class="cpo-seg" role="group" aria-label="${H('cpo_filter_label', 'Show media')}">
            ${[
              ['all', L('cpo_filter_all', 'All'), L('cpo_tip_filter_all', 'Every photo and video on the project.')],
              ['shared', L('cpo_filter_shared', 'Shared'), L('cpo_tip_filter_shared', 'Only what the customer can see.')],
              ['unshared', L('cpo_filter_hidden', 'Hidden'), L('cpo_tip_filter_hidden', 'Only what the customer cannot see.')]
            ].map(([id, label, tip]) => `<button type="button" class="${filter === id ? 'active' : ''}" data-cpo-filter="${id}" aria-pressed="${filter === id ? 'true' : 'false'}" data-fm-tooltip="${esc(tip)}">${esc(label)}</button>`).join('')}
          </div>
          <button type="button" class="cpo-btn icon" data-cpo-select-all aria-label="${H('cpo_select_all', 'Select all shown')}" data-fm-tooltip="${H('cpo_tip_select_all', 'Select every item shown, then share or hide them together.')}"><i class="fas fa-check-double"></i></button>
        </div>` : ''}
      </div>`;
    const grid = items.length
      ? `<div class="cpo-grid${state.selection.size ? ' has-selection' : ''}" data-cpo-grid data-filter="${esc(filter)}">${items.map((photo) => mediaTileHtml(photo, shared.has(photoId(photo)), false, !!cover?.mediaId && cover.mediaId === photoId(photo))).join('')}</div>`
      : '';
    // Empty only when there is truly nothing: no media and no cover.
    const body = items.length || cover
      ? coverHtml(cover, shared) + grid
      : `<div class="cpo-empty" data-cpo-media-empty><i class="fas fa-images"></i><span>${H('cpo_media_empty', 'No photos or videos on this project yet')}</span></div>`;
    const selbar = `
      <div class="cpo-selwrap"><div class="cpo-selbar" data-cpo-selbar role="toolbar" aria-label="${H('cpo_selection_label', 'Selected media')}">
        <span data-cpo-sel-count></span>
        <button type="button" class="cpo-btn primary" data-cpo-share data-fm-tooltip="${H('cpo_tip_share', 'Show the selected items in the customer’s portal.')}"><i class="fas fa-eye"></i><span data-cpo-share-label></span></button>
        <button type="button" class="cpo-btn" data-cpo-unshare data-fm-tooltip="${H('cpo_tip_unshare', 'Remove the selected items from the customer’s portal. Nothing is deleted from the project.')}"><i class="fas fa-eye-slash"></i><span data-cpo-unshare-label></span></button>
        <button type="button" class="cpo-btn icon" data-cpo-clear aria-label="${H('cpo_clear', 'Clear selection')}" data-fm-tooltip="${H('cpo_clear', 'Clear selection')}"><i class="fas fa-xmark"></i></button>
      </div></div>`;
    return head + body + selbar;
  }

  // Which tiles exist; shared state is synced in place so it can animate.
  function mediaSignature(){
    const cover = coverInfo();
    return [cover ? `cover|${cover.kind}|${cover.mediaId}|${cover.src}` : 'cover|none', ...libraryMedia().map((photo) => `${photoId(photo)}|${photo?.thumb || photo?.src || ''}`)].join('\n');
  }

  function skeletonHtml(){
    const title = window.Portal?.terminology?.get?.('customer_portal.project_tab', '') || L('m_61f3d0db590ab0', 'Customer Portal');
    return `
      <div class="cpo-wrap">
        <div class="cpo-head" data-app-header>
          <div class="cpo-title"><i class="fas ${APP_ICON}" data-fm-tooltip="${H('cpo_tip_app', 'The customer’s private page for this project. They see the media you share here, plus the documents, schedule and payments their portal includes.')}"></i><strong>${esc(title)}</strong></div>
          <div class="cpo-head-tools">
            <span class="cpo-sync" data-cpo-sync aria-live="polite"><i class="fas fa-rotate"></i><span>${H('cpo_syncing', 'Syncing')}</span></span>
            <a class="cpo-btn primary cpo-head-action" data-cpo-preview aria-disabled="true" aria-label="${H('cpo_preview_button', 'Preview customer portal')}" data-fm-tooltip="${H('cpo_tip_preview', 'Opens exactly what the customer sees, in a new tab. Nothing can be signed, accepted or paid there, and your visit is not recorded in History.')}"><i class="fas fa-eye"></i><span>${H('cpo_preview_button', 'Preview customer portal')}</span></a>
          </div>
        </div>
        <div data-cpo-error></div>
        <div class="cpo-body">
          <div class="cpo-main">
            <section class="cpo-card cpo-link cpo-enter" data-cpo-link-card aria-label="${H('cpo_link_label', 'Customer link')}"></section>
            <section class="cpo-card cpo-media cpo-enter cpo-d1" data-cpo-media aria-label="${H('cpo_media_title', 'Media')}"></section>
          </div>
          <aside class="cpo-card cpo-history cpo-enter cpo-d2" data-cpo-history aria-label="${H('cpo_history_title', 'History')}">
            <div class="cpo-history-head">
              <strong data-fm-tooltip="${H('cpo_tip_history', 'What happened in the customer’s portal: visits, pages, media and proposals opened. Previews by your team are not included. Hover an entry for its time, place and device.')}">${H('cpo_history_title', 'History')}</strong>
              <button type="button" class="cpo-btn quiet icon" data-cpo-refresh aria-label="${H('cpo_refresh', 'Refresh')}" data-fm-tooltip="${H('cpo_tip_refresh', 'Check for new activity.')}"><i class="fas fa-rotate-right"></i></button>
            </div>
            <div data-cpo-stats></div>
            <div class="cpo-timeline" data-cpo-timeline></div>
          </aside>
        </div>
      </div>
    `;
  }

  function renderStatus(){
    const root = state.panelRoot;
    if (!root) return;
    root.querySelector('[data-cpo-sync]')?.classList.toggle('is-on', !!state.portal.loading);
    root.querySelector('[data-cpo-history]')?.setAttribute('aria-busy', state.portal.loading ? 'true' : 'false');
    root.querySelectorAll('[data-cpo-sharing],[data-cpo-rescheduling]').forEach((input) => { input.disabled = !!state.portal.loading || !!state.saving || (!!projectId() && !state.portal.portal); });
    root.querySelector('[data-cpo-sync]')?.classList.toggle('is-on', !!state.portal.loading || !!state.saving);
  }

  function renderError(root){
    const slot = root.querySelector('[data-cpo-error]');
    if (!slot) return;
    const message = state.portal.error;
    if (!message) { slot.innerHTML = ''; return; }
    if (slot.dataset.message === message && slot.firstElementChild) return;
    slot.dataset.message = message;
    slot.innerHTML = `<div class="cpo-error" role="alert"><span>${esc(message)}</span><button type="button" data-cpo-retry>${H('cpo_retry', 'Try again')}</button></div>`;
  }

  function renderMedia(root, force = false){
    const slot = root.querySelector('[data-cpo-media]');
    if (!slot) return;
    if (!customerPortalMediaEnabled()) {
      slot.hidden = true;
      slot.innerHTML = '';
      state.mediaSignature = '';
      return;
    }
    slot.hidden = false;
    const signature = mediaSignature();
    if (force || signature !== state.mediaSignature || !slot.firstElementChild) {
      state.mediaSignature = signature;
      slot.innerHTML = mediaCardHtml();
      bindThumbLoading(slot);
      bindCoverFallbacks(slot);
    }
    syncSelection(root);
  }

  function markPending(ids, pending){
    const root = state.panelRoot;
    if (!root) return;
    ids.forEach((id) => {
      const tile = root.querySelector(`[data-cpo-tile="${CSS.escape(id)}"]`);
      if (!tile) return;
      tile.classList.toggle('is-pending', pending);
      tile.disabled = pending;
    });
    root.querySelectorAll('[data-cpo-share],[data-cpo-unshare]').forEach((button) => { button.disabled = pending || button.disabled; });
  }

  function syncSelection(root){
    const valid = new Set(libraryMedia().map((photo) => photoId(photo)).filter(Boolean));
    state.selection.forEach((id) => { if (!valid.has(id)) state.selection.delete(id); });
    const shared = sharedPortalMediaIds();
    let toShare = 0;
    let toHide = 0;
    state.selection.forEach((id) => { if (shared.has(id)) toHide += 1; else toShare += 1; });
    root.querySelectorAll('[data-cpo-tile]').forEach((tile) => {
      const id = tile.dataset.cpoTile;
      const isShared = shared.has(id);
      tile.setAttribute('aria-pressed', state.selection.has(id) ? 'true' : 'false');
      if (tile.classList.contains('is-shared') !== isShared) {
        tile.classList.toggle('is-shared', isShared);
        tile.setAttribute('data-fm-tooltip', tileTip(tile.dataset.cpoLabel || '', isShared));
      }
      if (!state.portal.loading && tile.classList.contains('is-pending')) {
        tile.classList.remove('is-pending');
        tile.disabled = false;
      }
    });
    const mediaCount = root.querySelector('[data-cpo-media-count]');
    if (mediaCount) {
      const items = libraryMedia();
      mediaCount.textContent = L('cpo_media_count', '{shared} of {total} shared', { shared: items.filter((photo) => shared.has(photoId(photo))).length, total: items.length });
    }
    const coverRow = root.querySelector('[data-cpo-cover]');
    const coverMedia = coverRow?.dataset.coverMedia || '';
    if (coverMedia) {
      const coverShared = shared.has(coverMedia);
      const chip = coverRow.querySelector('[data-cpo-cover-state]');
      if (chip && chip.classList.contains('is-shared') !== coverShared) {
        const info = { mediaId: coverMedia };
        chip.classList.toggle('is-shared', coverShared);
        chip.innerHTML = coverStateHtml(info, coverShared);
        coverRow.setAttribute('data-fm-tooltip', coverTip(info, coverShared));
      }
    }
    root.querySelector('[data-cpo-grid]')?.classList.toggle('has-selection', state.selection.size > 0);
    root.querySelector('[data-cpo-media]')?.classList.toggle('has-selection', state.selection.size > 0);
    const bar = root.querySelector('[data-cpo-selbar]');
    if (!bar) return;
    const count = state.selection.size;
    bar.classList.toggle('is-open', count > 0);
    bar.setAttribute('aria-hidden', count ? 'false' : 'true');
    bar.inert = !count;
    const countEl = bar.querySelector('[data-cpo-sel-count]');
    if (countEl && count) countEl.textContent = count === 1 ? L('cpo_sel_one', '1 selected') : L('cpo_sel_many', '{n} selected', { n: count });
    const share = bar.querySelector('[data-cpo-share]');
    const unshare = bar.querySelector('[data-cpo-unshare]');
    if (share) {
      share.disabled = !toShare || !!state.portal.loading;
      share.querySelector('[data-cpo-share-label]').textContent = toShare ? L('cpo_share_n', 'Share {n}', { n: toShare }) : L('cpo_share', 'Share');
    }
    if (unshare) {
      unshare.disabled = !toHide || !!state.portal.loading;
      unshare.querySelector('[data-cpo-unshare-label]').textContent = toHide ? L('cpo_hide_n', 'Hide {n}', { n: toHide }) : L('cpo_hide', 'Hide');
    }
  }

  function renderHistory(root){
    const events = Array.isArray(state.portal.activity) ? state.portal.activity : [];
    const stats = root.querySelector('[data-cpo-stats]');
    const timeline = root.querySelector('[data-cpo-timeline]');
    if (stats) stats.innerHTML = events.length ? historyStatsHtml(events) : '';
    if (timeline) timeline.innerHTML = historyListHtml(events);
  }

  function render(context = {}){
    const root = resolveRoot(context);
    if (!root || !customerPortalEnabled()) return;
    state.panelRoot = root;
    injectStyles();
    root.classList.add('cpo-panel');
    // A draft has no portal yet: never show another project's link, media state or visits.
    if (!projectId() && (state.portal.portal || state.portal.activity.length) && !state.saving) {
      setPortal({ loading: false, portal: null, activity: [], error: state.portal.error });
      state.selection.clear();
    }
    if (!root.querySelector('.cpo-wrap')) {
      root.innerHTML = skeletonHtml();
      state.mediaSignature = '';
      if (reducedMotion()) root.querySelectorAll('.cpo-enter').forEach((node) => node.classList.remove('cpo-enter'));
    }
    bindRoot(root);
    renderError(root);
    const linkCard = root.querySelector('[data-cpo-link-card]');
    if (linkCard) {
      const focused = document.activeElement && linkCard.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused ? [...focused.attributes].map((attr) => attr.name).find((name) => name.startsWith('data-cpo-')) : '';
      linkCard.innerHTML = linkCardHtml();
      if (focusKey) linkCard.querySelector(`[${focusKey}]`)?.focus?.({ preventScroll: true });
    }
    renderPreview(root);
    renderMedia(root);
    renderHistory(root);
    renderStatus();
  }

  // The header's preview button is part of the skeleton; only its link changes.
  function renderPreview(root){
    const button = root.querySelector('[data-cpo-preview]');
    if (!button) return;
    const href = portalLinks().preview;
    if (href) {
      button.setAttribute('href', href);
      button.setAttribute('target', '_blank');
      button.setAttribute('rel', 'noopener');
      button.removeAttribute('aria-disabled');
      button.setAttribute('data-fm-tooltip', L('cpo_tip_preview', 'Opens exactly what the customer sees, in a new tab. Nothing can be signed, accepted or paid there, and your visit is not recorded in History.'));
    } else {
      button.removeAttribute('href');
      button.setAttribute('aria-disabled', 'true');
      if (!projectId()) button.setAttribute('data-fm-tooltip', L('cpo_tip_preview_draft', 'Generate the customer link first, then preview what the customer sees.'));
    }
  }

  function bindRoot(root){
    // The page can load this file twice (a script tag and the app bundle);
    // only the instance that last rendered the panel handles its events.
    if (root._cpoOwner === api) return;
    root._cpoOwner = api;
    root.addEventListener('click', (event) => {
      if (root._cpoOwner !== api) return;
      const target = event.target.closest('[data-cpo-generate],[data-cpo-tile],[data-cpo-filter],[data-cpo-select-all],[data-cpo-share],[data-cpo-unshare],[data-cpo-clear],[data-cpo-copy],[data-cpo-qr],[data-cpo-refresh],[data-cpo-retry],[data-cpo-guests-toggle],[data-cpo-revoke],[data-cpo-guest-copy],[data-cpo-history-more],[data-cpo-preview],[data-cpo-email],[data-cpo-link]');
      if (!target || !root.contains(target)) return;
      const links = portalLinks();
      if (target.matches('[data-cpo-preview],[data-cpo-email]')) {
        if (target.getAttribute('aria-disabled') === 'true') event.preventDefault();
        return;
      }
      if (target.matches('[data-cpo-link]')) { target.select(); return; }
      if (target.matches('[data-cpo-generate]')) {
        if (target.disabled) return;
        target.disabled = true;
        withSavedProject().then((ok) => {
          if (ok) showToast(L('cpo_toast_link_ready', 'Customer link ready'), L('cpo_toast_link_ready_body', 'The project is saved and its portal link is ready to share.'), true);
          else render();
        });
        return;
      }
      if (target.matches('[data-cpo-tile]')) {
        const id = target.dataset.cpoTile;
        if (!id || target.disabled) return;
        if (state.selection.has(id)) state.selection.delete(id);
        else state.selection.add(id);
        syncSelection(root);
        return;
      }
      if (target.matches('[data-cpo-filter]')) {
        state.mediaFilter = ['shared', 'unshared'].includes(target.dataset.cpoFilter) ? target.dataset.cpoFilter : 'all';
        root.querySelector('[data-cpo-grid]')?.setAttribute('data-filter', state.mediaFilter);
        root.querySelectorAll('[data-cpo-filter]').forEach((button) => {
          const on = button.dataset.cpoFilter === state.mediaFilter;
          button.classList.toggle('active', on);
          button.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        return;
      }
      if (target.matches('[data-cpo-select-all]')) {
        const shared = sharedPortalMediaIds();
        libraryMedia().map((photo) => photoId(photo)).filter(Boolean).forEach((id) => {
          const visible = state.mediaFilter === 'all' || (state.mediaFilter === 'shared') === shared.has(id);
          if (visible) state.selection.add(id);
        });
        syncSelection(root);
        return;
      }
      if (target.matches('[data-cpo-share],[data-cpo-unshare]')) {
        const share = target.matches('[data-cpo-share]');
        const shared = sharedPortalMediaIds();
        const ids = [...state.selection].filter((id) => shared.has(id) !== share);
        withSavedProject(() => updateSharing(ids, share));
        return;
      }
      if (target.matches('[data-cpo-clear]')) { state.selection.clear(); syncSelection(root); return; }
      if (target.matches('[data-cpo-copy]')) { copyLink(links.live, target); return; }
      if (target.matches('[data-cpo-qr]')) { downloadQr(links.live, target); return; }
      if (target.matches('[data-cpo-refresh],[data-cpo-retry]')) { load({ silent: true }); return; }
      if (target.matches('[data-cpo-guests-toggle]')) {
        state.guestOpen = !state.guestOpen;
        target.setAttribute('aria-expanded', state.guestOpen ? 'true' : 'false');
        root.querySelector('[data-cpo-guests]')?.classList.toggle('is-open', state.guestOpen);
        return;
      }
      if (target.matches('[data-cpo-revoke]')) { revokeGuestShare(target.dataset.cpoRevoke || ''); return; }
      if (target.matches('[data-cpo-guest-copy]')) {
        const item = activeGuestLinks().find((link) => link.id === target.dataset.cpoGuestCopy);
        if (item?.url) copyLink(item.url, target);
        return;
      }
      if (target.matches('[data-cpo-history-more]')) {
        state.historyLimit += HISTORY_PAGE;
        renderHistory(root);
      }
    });
    root.addEventListener('change', (event) => {
      if (root._cpoOwner !== api) return;
      const input = event.target;
      if (input.matches?.('[data-cpo-sharing]')) setCustomerSharingEnabled(input.checked);
      else if (input.matches?.('[data-cpo-rescheduling]')) setCustomerReschedulingEnabled(input.checked);
    });
  }

  function retrySrc(src, tries){
    if (!src) return '';
    try {
      const url = new URL(src, window.location.href);
      url.searchParams.set('_cp_retry', `${Date.now()}_${tries}`);
      return url.href;
    } catch (_) {
      const separator = src.includes('?') ? '&' : '?';
      return `${src}${separator}_cp_retry=${Date.now()}_${tries}`;
    }
  }

  function bindThumbLoading(root = document){
    const bindVideo = (video, thumb) => {
      const markLoaded = () => { thumb.classList.add('loaded'); thumb.classList.remove('failed'); };
      if (video.readyState >= 2) markLoaded();
      else video.addEventListener('loadeddata', markLoaded, { once: true });
      video.addEventListener('error', () => { thumb.classList.add('failed'); thumb.classList.remove('loaded'); }, { once: true });
    };
    root.querySelectorAll?.('.cpo-thumb img[data-cp-thumb-img]').forEach((img) => {
      const thumb = img.closest('.cpo-thumb');
      if (!thumb) return;
      const baseSrc = img.dataset.cpBaseSrc || img.currentSrc || img.src || '';
      const markLoaded = () => { thumb.classList.add('loaded'); thumb.classList.remove('failed'); };
      const markFailed = () => { thumb.classList.add('failed'); thumb.classList.remove('loaded'); };
      const retry = () => {
        if (thumb.classList.contains('loaded') || !img.isConnected) return;
        const tries = Number(img.dataset.cpThumbRetries || 0);
        const originalSrc = img.dataset.cpOriginalSrc || '';
        if (tries >= 2 && img.dataset.cpMediaKind === 'video' && originalSrc) {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.dataset.cpThumbVideo = '1';
          video.src = originalSrc;
          img.replaceWith(video);
          bindVideo(video, thumb);
          return;
        }
        if (!baseSrc || tries >= 3) { markFailed(); return; }
        img.dataset.cpThumbRetries = String(tries + 1);
        thumb.classList.remove('failed');
        img.src = retrySrc(baseSrc, tries + 1);
      };
      if (img.complete && img.naturalWidth > 0) markLoaded();
      else if (img.complete) window.setTimeout(retry, 250);
      else window.setTimeout(retry, 3200);
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', () => window.setTimeout(retry, 350));
    });
    root.querySelectorAll?.('.cpo-thumb video[data-cp-thumb-video]').forEach((video) => {
      const thumb = video.closest('.cpo-thumb');
      if (thumb) bindVideo(video, thumb);
    });
  }

  /* ---------- lifecycle ---------- */

  function mount(context = {}){
    state.host = hostFor(context);
    if (typeof context.ensureProject === 'function') state.ensureProject = context.ensureProject;
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.mounted = !!state.panelRoot;
    state.active = context.active !== false;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    render(context);
    return api;
  }

  function activate(context = {}){
    if (context.host || context.projectWorkspace) mount(context);
    state.active = true;
    render(context);
    // Reading never creates a project: a draft loads nothing until something writes.
    if (projectId() && !state.portal.portal && !state.portal.loading) load({ silent: true });
  }

  function reset(){
    setPortal({ loading: false, portal: null, activity: [], error: '' });
    state.selection = new Set();
    state.guestOpen = false;
    state.historyLimit = HISTORY_PAGE;
    state.mediaSignature = '';
  }

  const api = {
    mount,
    activate,
    render,
    load,
    updateSharing,
    reset,
    destroy: reset,
    unmount: reset,
    context: () => ({ mounted: state.mounted, active: state.active, portal: state.portal })
  };

  const definition = {
    id: 'project.customer_portal',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("customer-portal","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal"),
    label: (globalThis.PlatformLanguage?.text("customer-portal","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal"),
    icon: APP_ICON,
    order: 30,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    // Shown on a draft project too: the whole tab, empty, until something writes.
    enabled: (context = {}) => context.customerPortalEnabled !== false,
    panelHtml,
    mount
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.customerPortalProject = api;
  Portal.ProjectCustomerPortalApp = api;

  window.addEventListener('fm:capabilities:updated', () => { if (state.mounted && state.panelRoot?.isConnected) render(); });

  runtime?.registerApp?.(definition);
})();
