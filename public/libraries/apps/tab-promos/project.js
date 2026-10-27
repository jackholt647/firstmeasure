/* Reusable, read-only project-tab marketing replacements. No material APIs or mutations.
 * The promos themselves are config library entries (kind tab_promo, docs/project-tab-promos.md), read from
 * GET /v1/config-library/read/tab_promo when this file loads; their images are library assets. This file is the
 * render engine only. */
(function(){
  const registry = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const libraryBase = () => {
    const platform = String(window.__APP?.platformApiBase || '').trim();
    return platform ? platform.replace(/\/v1\/platform\/?$/i, '/v1/config-library').replace(/\/+$/, '') : '/v1/config-library';
  };
  /** Library text: shown as is, or a `tab-promos` language key with its English. */
  const txt = value => value && typeof value === 'object' ? (globalThis.PlatformLanguage?.text?.('tab-promos', value.key, value.text) ?? value.text) : String(value ?? '');
  /** An image: a library asset (`asset:<sha256>`), served immutable by the library. */
  const src = value => { const match = /^asset:([0-9a-f]{64})$/.exec(String(value || '')); return match ? `${libraryBase()}/assets/${match[1]}` : ''; };
  function eligible(def, context = {}) {
    const capabilities = window.Portal?.capabilities;
    return capabilities?.value?.(def.flag, false) === true
      && capabilities?.value?.(def.replaces_capability, false) !== true
      && !(def.real_enabled_context && context?.[def.real_enabled_context] === true);
  }
  const css = `
    .pv-tab-badge{display:inline-flex!important;align-items:center;white-space:nowrap;background:#fff0cb;color:#794c00;border:1px solid #f2ca72;border-radius:999px;padding:3px 7px;font-size:9px!important;line-height:1.2;font-weight:800;letter-spacing:.02em;margin-left:5px}
    .fm-tab-promo{height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;background:#f7f7f5;color:#202124;font-family:inherit;box-sizing:border-box;text-align:left}
    .fm-tab-promo *{box-sizing:border-box}.fm-tab-promo .tp-wrap{max-width:1120px;margin:auto;padding:36px 32px 44px}
    .fm-tab-promo .tp-brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:850;letter-spacing:-.03em}.fm-tab-promo .tp-brand img{width:26px;height:26px;object-fit:contain}
    .fm-tab-promo .tp-brand span{margin-left:auto;letter-spacing:.08em;font-size:9px;text-transform:uppercase;color:#7a4b00;background:#fff0cb;padding:6px 9px;border-radius:99px}
    .fm-tab-promo .tp-hero{display:grid;grid-template-columns:1fr;align-items:center;gap:24px;margin:35px 0 40px}.fm-tab-promo .tp-eyebrow{color:#b62820;font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;margin:0 0 12px}
    .fm-tab-promo h1{font-size:clamp(28px,3vw,44px);line-height:1.04;letter-spacing:-.055em;margin:0 0 18px;font-weight:900}.fm-tab-promo h1 em{font-style:normal;color:#d93025}
    .fm-tab-promo p{font-size:13px;line-height:1.65;margin:0 0 16px;color:#59616a}.fm-tab-promo .tp-pill{display:inline-block;padding:8px 12px;border:1px solid #e1e3e6;background:#fff;border-radius:8px;font-size:11px;font-weight:750;color:#414851}
    .fm-tab-promo figure{margin:0;min-width:0}.fm-tab-promo figure img{width:100%;height:auto;display:block;border:1px solid #e4e4e7;border-radius:12px;background:white;box-shadow:0 14px 32px #20212412}.fm-tab-promo figcaption{font-size:10px;color:#777;margin-top:9px;line-height:1.5}
    .fm-tab-promo .tp-rule{display:grid;grid-template-columns:1fr;gap:24px;align-items:center;padding:28px;background:#fff;border:1px solid #e5e5e7;border-radius:16px}.fm-tab-promo .tp-rule figure{order:2}.fm-tab-promo h2{font-size:25px;line-height:1.13;letter-spacing:-.04em;margin:0 0 13px;color:#202124;font-weight:850}
    .fm-tab-promo .tp-features{display:grid;grid-template-columns:repeat(3,1fr);gap:23px;margin:30px 0}.fm-tab-promo .tp-feature{border-top:2px solid #d93025;padding-top:14px}.fm-tab-promo h3{font-size:13px;margin:0 0 8px;font-weight:850}.fm-tab-promo .tp-feature p{font-size:12px}
    .fm-tab-promo .tp-end{background:#202124;color:#fff;padding:23px 25px;border-radius:12px}.fm-tab-promo .tp-end h2{font-size:22px;color:#fff}.fm-tab-promo .tp-end p{color:#ccd0d5;margin-bottom:0;font-size:12px}.fm-tab-promo a{color:#fff;text-underline-offset:4px;font-weight:750}.fm-tab-promo a:focus-visible{outline:3px solid #f2ca72;outline-offset:4px}
    @media(max-width:900px){.fm-tab-promo .tp-hero,.fm-tab-promo .tp-rule{grid-template-columns:1fr}.fm-tab-promo .tp-hero{gap:24px}.fm-tab-promo .tp-rule figure{order:2}.fm-tab-promo .tp-wrap{padding:24px}.fm-tab-promo h1{font-size:38px}}
    @media(max-width:480px){.fm-tab-promo .tp-wrap{padding:20px 16px 32px}.fm-tab-promo .tp-hero{margin:27px 0}.fm-tab-promo h1{font-size:34px}.fm-tab-promo .tp-rule{padding:18px;gap:16px}.fm-tab-promo .tp-features{grid-template-columns:1fr;gap:13px}.fm-tab-promo .tp-end{padding:20px}.pv-tab-badge{font-size:8px!important;padding:3px 5px;margin-left:3px}}
  `;
  const open = (globalThis.PlatformLanguage?.htmlText("tab-promos","m_4a4816db7c642d","Open screenshot at full size") ?? "Open screenshot at full size");
  const figure = image => `<figure><a href="${escape(src(image.src))}" target="_blank" rel="noopener noreferrer" aria-label="${open}"><img src="${escape(src(image.src))}" alt="${escape(txt(image.alt))}" loading="lazy" width="1280" height="720"></a><figcaption>${escape(txt(image.caption))}</figcaption></figure>`;
  function render(def){
    const c = def.content;
    return `<article class="fm-tab-promo" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("tab-promos","m_a9cbcece18bdac",`${v0} coming soon`,{v0}) ?? `${v0} coming soon`)(escape(txt(def.title)))}"><div class="tp-wrap">
      <div class="tp-brand"><img src="/images/logo_square.png" alt="">${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_5c4fb8df281140","FirstMate") ?? "FirstMate")}<span>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_9011dd5d1fb41c","Coming soon") ?? "Coming soon")}</span></div>
      <section class="tp-hero"><div><p class="tp-eyebrow">${escape(txt(c.eyebrow))}</p><h1>${escape(txt(c.headline))}<br><em>${escape(txt(c.accent))}</em></h1><p>${escape(txt(c.intro))}</p><span class="tp-pill">${escape(c.hero_pill ? txt(c.hero_pill) : "Built around the way you work")}</span></div>${figure(c.images[0])}</section>
      <section class="tp-rule">${figure(c.images[1])}<div><p class="tp-eyebrow">${escape(c.rules_eyebrow ? txt(c.rules_eyebrow) : "Make it your own")}</p><h2>${escape(txt(c.rules_title))}</h2><p>${escape(txt(c.rules_body))}</p><span class="tp-pill">${escape(c.rules_pill ? txt(c.rules_pill) : "Built for your business")}</span></div></section>
      <section class="tp-features">${c.features.map(f=>`<div class="tp-feature"><h3>${escape(txt(f.title))}</h3><p>${escape(txt(f.body))}</p></div>`).join('')}</section>
      <footer class="tp-end"><h2>${escape(c.footer_title ? txt(c.footer_title) : "More possibilities. Coming soon.")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_5469b46d69ad5b","This is a preview of what’s coming to FirstMate. Availability and final features may change. ") ?? "This is a preview of what’s coming to FirstMate. Availability and final features may change. ")}<a href="https://1m8.ai/" target="_blank" rel="noopener noreferrer">${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_ba4635a7ef2d18","Explore FirstMate ↗") ?? "Explore FirstMate ↗")}</a></p></footer>
    </div></article>`;
  }
  /** One promo: a library entry's data with its `id` (the app id is `project.<id>`). */
  function register(def){
    if (!def.id || !def.flag || !def.replaces_capability || !def.tab_id || !def.content) throw new Error('A tab promo needs an id, flag, replacement capability, tab id and content.');
    if(registry.has(def.id)) throw new Error('Duplicate tab promo: '+def.id);
    registry.set(def.id,def);
    window.Portal?.util?.injectCSS?.('project-tab-promos',css);
    const title = txt(def.title);
    window.FirstMateEmbeddableApps?.registerApp?.({
      id:`project.${def.id}`,kind:'project_modal_app',projectModalTabId:def.tab_id,
      title,label:title,icon:def.icon || 'fa-boxes-stacked',promoBadge:'Coming soon',order:def.order || 55,
      surfaces:['project_modal'],regions:['main'],requiresContext:['project'],access:{capability:def.flag},
      enabled:context=>eligible(def,context),
      panelHtml:()=>render(def),
      mount(context){const root=context.roots?.main || context.panelRoot;const update=()=>{if(root)root.innerHTML=eligible(def,context)?render(def):'';};update();return {activate:update,setActive:active=>{if(active)update();},destroy:()=>{if(root)root.innerHTML='';}};}
    });
  }
  // The tab pill styles (.pv-tab-badge) are used by every project tab strip, promo or not.
  window.Portal?.util?.injectCSS?.('project-tab-promos',css);
  /** Reads the library's promos once and registers each. A promo that fails to load is simply not offered. */
  const ready = (typeof window.fetch === 'function' ? window.fetch(`${libraryBase()}/read/tab_promo`, { credentials:'same-origin' }) : Promise.reject(new Error('no fetch')))
    .then(response => response.ok ? response.json() : { entries: [] })
    .then(result => {
      for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
        try { if (!registry.has(entry.id)) register({ ...entry.data, id: entry.id }); } catch (error) { globalThis.console?.warn?.('Tab promo not registered', entry?.id, error); }
      }
      return [...registry.values()];
    })
    .catch(() => [...registry.values()]);
  window.FirstMateTabPromos = {register,eligible,ready,definitions:()=>[...registry.values()]};
})();
