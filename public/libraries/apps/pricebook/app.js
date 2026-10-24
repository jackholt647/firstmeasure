/* public/libraries/apps/pricebook/app.js
 * The price book as a full page (portal.pricebook). Its home is Settings >
 * Pricebook; the apps overlay opens this page and it can be pinned. Both use
 * the same renderer, FirstMatePricebook.mount.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const orgId = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
  let host = null;
  let handle = null;

  // The renderer draws into one place at a time, so the page mounts it again
  // each time it is shown (Settings may have drawn it since).
  function draw(){
    const pricebook = window.FirstMatePricebook || window.Portal?.modules?.pricebook;
    if (!host) return;
    try { handle?.destroy?.(); } catch (error) {}
    handle = null;
    if (!pricebook?.mount) {
      host.innerHTML = `<div style="padding:24px;color:#667085;font-weight:700">${(globalThis.PlatformLanguage?.htmlText("pricebook","portal_pricebook_unavailable","The price book could not be loaded.") ?? "The price book could not be loaded.")}</div>`;
      return;
    }
    pricebook.configure?.({ currentOrganizationId:orgId });
    handle = pricebook.mount(host, {
      title:(globalThis.PlatformLanguage?.text("pricebook","m_5bdcd2418294b6","Organization Price Book") ?? "Organization Price Book")
    });
  }

  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return {};
    host = document.createElement('div');
    host.className = 'fm-pricebook-page';
    host.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden';
    root.appendChild(host);
    draw();
    return {
      destroy(){
        try { handle?.destroy?.(); } catch (error) {}
        handle = null;
        host?.remove();
        host = null;
      }
    };
  }

  runtime.registerApp({
    id:'portal.pricebook', package:'pricebook', kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("firstmate-apps-manifest","portal_pricebook_title","Pricebook") ?? "Pricebook"),
    label:(globalThis.PlatformLanguage?.text("firstmate-apps-manifest","portal_pricebook_title","Pricebook") ?? "Pricebook"),
    icon:'fa-book', order:61,
    surfaces:['portal_tab'], regions:['main'], visible:true, fullBleed:true,
    access:{ capability:'platform.pricebook' },
    mount,
    onShow(){ draw(); }
  });
})();
