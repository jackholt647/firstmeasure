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
    /* White, in the organization's colours (GP-39). The primary leads (--tp-accent): the mark, the headline's accent, the
       pills, the tinted section and the closing band. The secondary is the accent (--tp-second, made readable on white by
       paintSecondary): the eyebrows and the feature rules. */
    .fm-tab-promo{--tp-accent:var(--primary-readable,var(--primary,#d93025));--tp-second:var(--secondary,#202124);--tp-tint:color-mix(in srgb,var(--tp-accent) 7%,#fff);--fm-mark:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACABAMAAAAxEHz4AAAAMFBMVEVMaXEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACbsZG/AAAAD3RSTlMA/AMlEe/N3jtmp3tRu5FNL+oMAAAACXBIWXMAAAPoAAAD6AG1e1JrAAALx0lEQVRo3pVZfYxU1RV/uTOps7KYvBgLWa335tFgg9RMS6nFFjMprRixJGS1qSKMWCSaqhsL1AjKrkQ0rSluhargB9tWLFWTJRUKddOwVqtpqxU/SrW2XfxAbcWQGzM77rLD7e+ce9/XzHu76/tnd96759xzz+fvnOt52U/geeLCBx8+tGrV9Y9vezbgF5/iEcoL/vqPG417pv3ow/KnYhF4xbv+Lo3x3UM8/vtlT0yWXnkXvy9BLUMJNPFYtkVBsMnRb+42OqJ2j29q/6pMioMSL2J70/KA5dKyNzEHVbzP+NJkPNo3l5cnlCEo3pvYPtKh+ymXlyfQpPDui+iTSowUcXk5GN/+80N6Jr/1MTyHZMxNy8vUeIdQ50g/3PO0dfvnVJjrnHkfLQml0PKacdQgSl3hMn3DFlCLAA/Wi4ufutFx8Gt7RL4C9mp31M8eVUTNe9m/F+90h/MblTwR1GLrPlDVRpAlltGPQqheeUWOCKLQzfTarC97AeLhG9seXYXn+m3PVIhF8UWrIF27J5uDel7b868vY7n4+ntRNNY3bKnQK8fBH820hJgiWQB5JhZ7M/5QjaNRGn0DhFLiOXtG+cssEdQBy77RA/rZ/RSC1gkti2Vb4SXiCHPQWXoUU7S1Ui/o53UZn80WeZVv6h9AMaUhfiO/LzIEYN7yVRx2UTccQZrTNny4WZvjD390Kd77Uv8Kpzi7ysuGW0RwAsgRWgR6hP+bt1dEu5GdQizYDk/UsvYOPt5h172SI0C9J1ClLg11rttK5mcG2Gz2TljXh/1EcYgXjjYL0GYZr8aKt7C/vrZCmZUkOFWAkVfcDqFkoxyoc+zKw+kzqE3sAsNlBRmx9HXFuccx4DT9kyo4LBVK7eClIyLDCeUjQp0tpTbXKPvZ6sBlyvkGX14Tos3G22BSBHGy5oNVAtHva3mzcllDtGu5Jsr1z4EDycgiyJWpExwLBZivyRWDSLKqvFJF2Q7BikiyBtOjyWBrd/4VlLqlrg8mjvd8PRYVboRD9Cq3XW+CwwWahRJqk+Y/8ZfiV5KCzsJnaI8PbL4n0ifQ9TIJYEZTTqaSlUCIA3CowYB9Ad6YPgE4qnOxwxrRVKeSP26DoGcIZSWOz7CQRepVgjifGCdpF7sQ2TVIykroFEk31qOCjCnhY/kcvsMLVnpqB1GcEJGtrBe7eDieL0E/VU3dUM5velTSiwaDdl/X9mmje3OyrjgFAhytSrk7KFBUy4PuBF8yLA9UqEdK+H5VngQLNdznaaPHnLDTnZf3E7c1AiqUu9XTWv4wj8FMDSdp07peUTN1FNPCqrQ3wJcGQkXKvjwVtMFXlNcv5WEkikgJrAIoRs01ZrXw1HMbKpl1n3Db354UbPTpwoptk8K3idmY8HACqE9k105b5OgvQpy2u42oOvkT2VS+Ikr0vtn1Ytx23hP4YMsdzjAYsNycVdj9sPcXdajVrLJ7HinYCTOX9+NwCHVIen2pJc8lcMeiqh95LvIBbc3JFVrk9EAv+mWtnLd/WzcWRa5f7PaHFTZ0WiSLgntB6uMiZ//2IR37nY2dQUURSPmO1Sn7glO0XJ1DX/qFlqnoPUvLPvJrNp51SmKYowJV2MkVtVZWcRWDyCXtAhIewTqUpkdlAs8jprkWFaoIB49yAwwvqjaShvxGNnDd62DzWEJD/f6ozYPQe8mWGTAdEVnANUJGiTqgXkJaUnfz2T1O8p1Ugi7JcsB7jcOrkR/ZuJaDai6Z4TCnaMQyjHAwg/6nMXAuJxicDDOoqUTZB5OwP1ygZUsiEt75MqRHykzFNe+J95dwLILBubpWbmagzq/GSD2pQ6p4H6NucjySR8INXvLrlZb8UdURfVOe65ZjNohGPApmnG+HP5oB28gBM3ToeUP+CVFEGUMK38HWVP1+SyQQZtAhUEsfkPYLGRwjf4Jb+SdEBuqRtatNBiYCg+GK6GIGCGvScJds8SNkGN14ZsG+Fh1SBJLOae9R9mhUtS7OF6qpkJq3cRLOWFel2lrvJGKAMEROsgxgl+mf/9Y3m1ALYiUQlK2bdBggdi0Do5nBCYrN+qFV1/82sQo6opjjgmZ0QodTHvv3P18mkMWJgBkc5+CmuirSOvyYGJTSfshZnH2niQGh82RET3VpEMnO6IQOYXFC7/D88RmwDj92DCKsx7rJYdBkLKpdVgftaWBrQS0BmpgBK/H0F154oScZL4yjYAWk7ZQfFrDwrbQORqGoGPEk0Ld8F/8BmbVku5M0KnNsRvaDzrBPDLEAw/8tCx5q9kPqRs+KHWko9MR0YeTCQ7Gw1piUDh2oCRmMxsGUjkau/zx18FtimX2BIjgZzkNN0VjsDjMJNWLlFgZ+QxW7IgZIKAfSDFwH4zrx6zJyTZRQXErb0ZTSZuqYfmlrlziEE3PCGWGYCz/ZpGtJBuruiN50VFoqjuiWn9ikemqY1rlUtOiQ9u/oaaUvUSvVZtM6F5aVVCoS7mrRL9MPD7aiLirPBxkloRq50jYlhS9dG4oF9a1ZqGuqhmVn2tLWbhFOQSZDNtShrO3JoieY1cMI2fSG5b2YSsvOD/3au5mokZOyhfwIP3IH/Dwm6wmMxTr09TvZqFGQFdUQIxPXbfSg2sfVlXIIVZRd2TNESnKf2HhvOGmhEujllZQOfXNNzgQR6JpRu4OqFq7R709EQoe+uVblTL1Ih7sZHlDrZ8H6GDzbj1IvFKzNzXn05GUIL4aHV9qURxnBose4EV1fyQXOJUnrCWNxnHPjDo5zYywqCjcur+TP/aYSLC86srDjOQyo6tA7ibEgm55fomsCsmWI3YgDr5NY1pkhL8yh5x26SAULrero9WcsZoUSOJ6+cHsoRuszo8LwnlZzm7ImTj7giaOdgRFK/3A5r20orbhOUMmCF7AKXK60//cFpSqxmZUFGGP36A2wHB3PKTrGPbbCjJFUYN2f33jC3f0RMQsnsJUzap5ZH8MK5tGNi7TJ7RtpoR7EDjj6UKJztdkDhoRHyCU0Z8nzoHYp5TL0/z2BLXxhDqMEz/OH2zCfoDY+d2b7MyKDuzDsiUsuNRuUE3hCpHONQAYj5Egb8wwkqmW2/5cHeTwzjgCkb4aMFmfHyrZGNXDki1pmKOkrAfI/+Zr1omj+wDmOU3ivwnhGN1JHSNHDy+y0qZo0YnwGjGcwKDJXJInuSPTyQt1pWIBNunkWxmeg8Yw45msTp2ICHn3RD9VWlSSAndylSjYi1E0T22jg9seQA7BTBC7QgA5hUPe2UF/VLfNAG1CYZyoaLlM5VM3jQIEGEpPOy7ygwG7T3KZyIaBRXYG26eixCZ3ynU21wivuw6SStrhTm9QgLML2hudkagoGoqZjI+ufphXEAP8X0IBq84iACaQ9btZcXZ6OVIw7Ci0bT9J43zIIh/ta3oLp6p94q1pzn2xNo2GkQPyc9qq9uTGWoPCXbqJfXqGZLCOHM0RLtqlGc+HiXlptpr1xv2IG87ZfDeF804GhfYGvMDKaTCcCz0ODwhEaZWPdTUCJ9Zuqdjb+uR6Wjst2Rp8diiBvUYEq/E5qX4cXRBrk0mzYCAW8aFuwzHGbG3pr8zpdBODQ2rfXbUxee4MuDVwrnH3HgUhxFyS7yGwXvueu6Zhk2RYaby+2rWxeyqCEzBz0LoXVYt7/1i7h9Zf+54My0S/qtlckMFV2vnEaAoffQF644oKvPTAwMPDgHHIJJTZ3O+B0ZkVNcM1EGrPjt/iSB3cmTsD6YO5tmVoc3iWZ4SfK7p6Ku4jiXSvcFaQ2r4pxrtrcLQzx+e7RZ10jKmb8+VDYhOOybbw7R1E84jjQDcu0WwcGtm0bGHh0beKyrmP86z5Vejm8LNWJW8/IpSSSzQQ3lu1d4czBelLoTpa+fs9EV55CzV6hfZP5gH7PxNe24LDTZHKAabZO4tIWyav0vmkVAufAHeCkLp6R/h6qNrGg67YflCdHzxlw3q8Tuue/t+6f7MW3HQIXf/xR0ozr9pcnf/XuAKGY88BT3DzWH/893d7m+M//AbWyB1pLFUiIAAAAAElFTkSuQmCC);height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;background:#fff;color:#202124;font-family:inherit;box-sizing:border-box;text-align:left}
    .fm-tab-promo *{box-sizing:border-box}.fm-tab-promo .tp-wrap{max-width:1120px;margin:auto;padding:36px 32px 44px}
    .fm-tab-promo .tp-brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:850;letter-spacing:-.03em}.fm-tab-promo .tp-brand .tp-logo{width:26px;height:26px;flex:none;margin:0;padding:0;border-radius:0;background:var(--tp-accent);-webkit-mask:var(--fm-mark) center/contain no-repeat;mask:var(--fm-mark) center/contain no-repeat}
    .fm-tab-promo .tp-brand span{margin-left:auto;letter-spacing:.08em;font-size:9px;text-transform:uppercase;color:#7a4b00;background:#fff0cb;padding:6px 9px;border-radius:99px}
    .fm-tab-promo .tp-hero{display:grid;grid-template-columns:1fr;align-items:center;gap:24px;margin:35px 0 40px}.fm-tab-promo .tp-eyebrow{display:flex;align-items:center;gap:9px;color:var(--tp-second);font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;margin:0 0 12px}
    .fm-tab-promo .tp-eyebrow:before{content:'';width:20px;height:3px;border-radius:2px;background:currentColor;flex:none}.fm-tab-promo h1{font-size:clamp(28px,3vw,44px);line-height:1.04;letter-spacing:-.055em;margin:0 0 18px;font-weight:900}.fm-tab-promo h1 em{font-style:normal;color:var(--tp-accent)}
    .fm-tab-promo p{font-size:13px;line-height:1.65;margin:0 0 16px;color:#59616a}.fm-tab-promo .tp-pill{display:inline-block;padding:8px 12px;border:1px solid color-mix(in srgb,var(--tp-accent) 22%,#fff);background:var(--tp-tint);border-radius:8px;font-size:11px;font-weight:750;color:var(--tp-accent)}
    .fm-tab-promo figure{margin:0;min-width:0}.fm-tab-promo figure img{width:100%;height:auto;display:block;border:1px solid #e4e4e7;border-radius:12px;box-shadow:0 14px 32px #20212412;aspect-ratio:16/9;background:var(--tp-tint)}.fm-tab-promo figcaption{font-size:10px;color:#777;margin-top:9px;line-height:1.5}
    .fm-tab-promo .tp-rule{display:grid;grid-template-columns:1fr;gap:24px;align-items:center;padding:28px;background:linear-gradient(135deg,var(--tp-tint),color-mix(in srgb,var(--tp-accent) 3%,#fff));border:1px solid #20212410;border-radius:16px}.fm-tab-promo .tp-rule figure{order:2}.fm-tab-promo h2{font-size:25px;line-height:1.13;letter-spacing:-.04em;margin:0 0 13px;color:#202124;font-weight:850}
    .fm-tab-promo .tp-features{display:grid;grid-template-columns:repeat(3,1fr);gap:23px;margin:30px 0}.fm-tab-promo .tp-feature{border-top:3px solid var(--tp-second);padding-top:14px}.fm-tab-promo h3{font-size:13px;margin:0 0 8px;font-weight:850}.fm-tab-promo .tp-feature p{font-size:12px}
    .fm-tab-promo .tp-end{background:var(--primary,var(--tp-accent));color:var(--on-primary,#fff);padding:23px 25px;border-radius:12px}.fm-tab-promo .tp-end h2{font-size:22px;color:inherit}.fm-tab-promo .tp-end p{color:inherit;opacity:.82;margin-bottom:0;font-size:12px}.fm-tab-promo a{color:inherit;text-underline-offset:4px;font-weight:750}.fm-tab-promo a:focus-visible{outline:3px solid #f2ca72;outline-offset:4px}
    @media(max-width:900px){.fm-tab-promo .tp-hero,.fm-tab-promo .tp-rule{grid-template-columns:1fr}.fm-tab-promo .tp-hero{gap:24px}.fm-tab-promo .tp-rule figure{order:2}.fm-tab-promo .tp-wrap{padding:24px}.fm-tab-promo h1{font-size:38px}}
    @media(max-width:480px){.fm-tab-promo .tp-wrap{padding:20px 16px 32px}.fm-tab-promo .tp-hero{margin:27px 0}.fm-tab-promo h1{font-size:34px}.fm-tab-promo .tp-rule{padding:18px;gap:16px}.fm-tab-promo .tp-features{grid-template-columns:1fr;gap:13px}.fm-tab-promo .tp-end{padding:20px}.pv-tab-badge{font-size:8px!important;padding:3px 5px;margin-left:3px}}
  `;
  // The organization's secondary is text on white and the footer behind white text, so a light one is darkened until
  // it reads (contrast 4.5); the portal publishes no readable secondary of its own.
  const luminance = rgb => rgb.map(v => { v /= 255; return v <= .03928 ? v/12.92 : ((v+.055)/1.055)**2.4; }).reduce((sum,v,i) => sum + v*[.2126,.7152,.0722][i], 0);
  function paintSecondary(root){
    const article = root?.querySelector?.('.fm-tab-promo');
    if (!article) return;
    article.style.removeProperty('--tp-second');
    const probe = document.createElement('i'); probe.hidden = true; probe.style.color = 'var(--tp-second)'; article.append(probe);
    let color = (getComputedStyle(probe).color.match(/[\d.]+/g) || []).slice(0,3).map(Number); probe.remove();
    if (color.length < 3) return;
    for (let step = 0; step < 20 && 1.05/(luminance(color)+.05) < 4.5; step++) color = color.map(v => Math.round(v*.88));
    article.style.setProperty('--tp-second', `rgb(${color.join(',')})`);
  }
  const open = (globalThis.PlatformLanguage?.htmlText("tab-promos","m_4a4816db7c642d","Open screenshot at full size") ?? "Open screenshot at full size");
  const figure = (image, eager) => `<figure><a href="${escape(src(image.src))}" target="_blank" rel="noopener noreferrer" aria-label="${open}"><img src="${escape(src(image.src))}" alt="${escape(txt(image.alt))}" loading="${eager ? 'eager' : 'lazy'}" width="1280" height="720"></a><figcaption>${escape(txt(image.caption))}</figcaption></figure>`;
  function render(def){
    const c = def.content;
    return `<article class="fm-tab-promo" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("tab-promos","m_a9cbcece18bdac",`${v0} coming soon`,{v0}) ?? `${v0} coming soon`)(escape(txt(def.title)))}"><div class="tp-wrap">
      <div class="tp-brand"><span class="tp-logo" aria-hidden="true"></span>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_5c4fb8df281140","FirstMate") ?? "FirstMate")}<span>${(globalThis.PlatformLanguage?.htmlText("tab-promos","m_9011dd5d1fb41c","Coming soon") ?? "Coming soon")}</span></div>
      <section class="tp-hero"><div><p class="tp-eyebrow">${escape(txt(c.eyebrow))}</p><h1>${escape(txt(c.headline))}<br><em>${escape(txt(c.accent))}</em></h1><p>${escape(txt(c.intro))}</p><span class="tp-pill">${escape(c.hero_pill ? txt(c.hero_pill) : "Built around the way you work")}</span></div>${figure(c.images[0], true)}</section>
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
      mount(context){const root=context.roots?.main || context.panelRoot;const repaint=()=>paintSecondary(root);const update=()=>{if(root)root.innerHTML=eligible(def,context)?render(def):'';repaint();};update();window.addEventListener?.('fm:theme:updated',repaint);return {activate:update,setActive:active=>{if(active)update();},destroy:()=>{window.removeEventListener?.('fm:theme:updated',repaint);if(root)root.innerHTML='';}};}
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
