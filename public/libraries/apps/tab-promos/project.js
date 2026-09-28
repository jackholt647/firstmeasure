/* Reusable, read-only project-tab marketing replacements. No material APIs or mutations. */
(function(){
  const registry = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function eligible(def, context = {}) {
    const capabilities = window.Portal?.capabilities;
    return capabilities?.value?.(def.flag, false) === true
      && capabilities?.value?.(def.replacesCapability, false) !== true
      && !(def.realEnabled && def.realEnabled(context));
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
  function render(def){
    const c = def.content;
    return `<article class="fm-tab-promo" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("tab-promos","m_a9cbcece18bdac",`${v0} coming soon`,{v0}) ?? `${v0} coming soon`)(escape(def.title))}"><div class="tp-wrap">
      <div class="tp-brand"><img src="/images/logo_square.png" alt="">${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_5c4fb8df281140","FirstMate") ?? "FirstMate")}<span>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_9011dd5d1fb41c","Coming soon") ?? "Coming soon")}</span></div>
      <section class="tp-hero"><div><p class="tp-eyebrow">${String(escape(c.eyebrow))}</p><h1>${String(escape(c.headline))}<br><em>${String(escape(c.accent))}</em></h1><p>${String(escape(c.intro))}</p><span class="tp-pill">${String(escape(c.heroPill || "Built around the way you work"))}</span></div><figure><a href="${String(escape(c.images[0].src))}" target="_blank" rel="noopener noreferrer" aria-label="${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_4a4816db7c642d","Open screenshot at full size") ?? "Open screenshot at full size")}"><img src="${String(escape(c.images[0].src))}" alt="${String(escape(c.images[0].alt))}" loading="lazy" width="1280" height="720"></a><figcaption>${String(escape(c.images[0].caption))}</figcaption></figure></section>
      <section class="tp-rule"><figure><a href="${String(escape(c.images[1].src))}" target="_blank" rel="noopener noreferrer" aria-label="${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_4a4816db7c642d","Open screenshot at full size") ?? "Open screenshot at full size")}"><img src="${String(escape(c.images[1].src))}" alt="${String(escape(c.images[1].alt))}" loading="lazy" width="1280" height="720"></a><figcaption>${String(escape(c.images[1].caption))}</figcaption></figure><div><p class="tp-eyebrow">${String(escape(c.rulesEyebrow || "Make it your own"))}</p><h2>${String(escape(c.rulesTitle))}</h2><p>${String(escape(c.rulesBody))}</p><span class="tp-pill">${String(escape(c.rulesPill || "Built for your business"))}</span></div></section>
      <section class="tp-features">${String(c.features.map(f=>`<div class="tp-feature"><h3>${escape(f.title)}</h3><p>${escape(f.body)}</p></div>`).join(''))}</section>
      <footer class="tp-end"><h2>${String(escape(c.footerTitle || "More possibilities. Coming soon."))}</h2><p>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_5469b46d69ad5b","This is a preview of what’s coming to FirstMate. Availability and final features may change. ") ?? "This is a preview of what’s coming to FirstMate. Availability and final features may change. ")}<a href="https://1m8.ai/" target="_blank" rel="noopener noreferrer">${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_ba4635a7ef2d18","Explore FirstMate ↗") ?? "Explore FirstMate ↗")}</a></p></footer>
    </div></article>`;
  }
  function register(def){
    if (!def.id || !def.flag || !def.replacesCapability || !def.tabId) throw new Error('A tab promo needs an id, flag, replacement capability and tab id.');
    if(registry.has(def.id)) throw new Error('Duplicate tab promo: '+def.id);
    registry.set(def.id,def);
    window.Portal?.util?.injectCSS?.('project-tab-promos',css);
    window.FirstMateEmbeddableApps?.registerApp?.({
      id:`project.${def.id}`,kind:'project_modal_app',projectModalTabId:def.tabId,
      title:def.title,label:def.title,icon:def.icon || 'fa-boxes-stacked',promoBadge:'Coming soon',order:def.order || 55,
      surfaces:['project_modal'],regions:['main'],requiresContext:['project'],access:{capability:def.flag},
      presentation:{projectModal:{left:'default'}},enabled:context=>eligible(def,context),
      panelHtml:()=>render(def),
      mount(context){const root=context.roots?.main || context.panelRoot;const update=()=>{if(root)root.innerHTML=eligible(def,context)?render(def):'';};update();return {activate:update,setActive:active=>{if(active)update();},destroy:()=>{if(root)root.innerHTML='';}};}
    });
  }
  window.FirstMateTabPromos = {register,eligible,definitions:()=>[...registry.values()]};
  register({id:'materials_promo',tabId:'materials',title:(globalThis.PlatformLanguage?.text("tab-promos","m_691187e28aba8e","Materials") ?? "Materials"),order:65,flag:'firstmeasure.materials_promo',replacesCapability:'platform.materials',realEnabled:context=>context.materialsEnabled===true,
    content:{eyebrow:'Materials, powered by FirstMate Scope',headline:'Your products. Your rules.',accent:'Your material lists.',intro:'Turn project measurements into material lists inside FirstMate Scope. Choose your own products, define how quantities are calculated, and carry each list through ordering and delivery—all in the same project.',
      rulesEyebrow:'Your takeoff, your way',rulesPill:'Your catalog + your calculations',footerTitle:'From measurements to materials. Then keep things moving.',rulesTitle:'You decide what goes into every list.',rulesBody:'Set up your own products, coverage, waste, rounding, and formulas. Build reusable setups for different roof systems, crews, or jobs—and adjust the details whenever the project calls for it.',
      images:[{src:'/libraries/apps/tab-promos/images/scope-materials.png',alt:'Actual FirstMate Scope workspace with a roof replacement material list, product variants, quantities, scheduling and ordering controls.',caption:(globalThis.PlatformLanguage?.text("tab-promos","m_582fa8f6e85c70","FirstMate Scope · Actual development app, shown with fictional demo project data.") ?? "FirstMate Scope · Actual development app, shown with fictional demo project data.")},{src:'/libraries/apps/tab-promos/images/scope-pricebook.png',alt:'Actual FirstMate Price Book editor showing material product variants, colors, pricing behavior and SKU customization.',caption:(globalThis.PlatformLanguage?.text("tab-promos","m_c93b8afab697eb","Scope’s Price Book · Actual product and variant customization screen. Demo catalog and prices.") ?? "Scope’s Price Book · Actual product and variant customization screen. Demo catalog and prices.")}],
      features:[{title:(globalThis.PlatformLanguage?.text("tab-promos","m_55aef9e1931342","Start with your measurements") ?? "Start with your measurements"),body:'Generate quantities from the roof measurements already in your project. Keep the flexibility to review and adjust the list.'},{title:(globalThis.PlatformLanguage?.text("tab-promos","m_28ea4baf467ffa","Make it your own") ?? "Make it your own"),body:'Use your own material catalog and calculation rules. Save the setups that work for your business and reuse them.'},{title:(globalThis.PlatformLanguage?.text("tab-promos","m_9d9cee67b5d96a","Keep the job moving") ?? "Keep the job moving"),body:'Connect your material workflow to follow-ups, supplier emails, and delivery scheduling—with the timing and steps you choose.'}]
    }});
})();
