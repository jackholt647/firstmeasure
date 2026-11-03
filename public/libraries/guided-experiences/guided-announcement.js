/* public/libraries/guided-experiences/guided-announcement.js
 * The `announcement` kind of guided experience (docs/architecture/guided-experiences.md, "Announcements"): one website
 * billboard in a popup, played by the shared runtime, which keeps progress on the server. The person closes it or
 * presses the page's own action button; either finishes it for good.
 *
 * The billboard is a sandboxed copy served by the app with a small script added (guided-experiences/billboards.ts). It
 * posts `ready` once loaded and `action` when its button is pressed. Nothing is shown, and nothing used up, until the
 * page has answered: a billboard not yet published leaves the announcement waiting for the next load.
 */
(function(root){
  'use strict';
  const document = root.document;
  const G = () => root.FirstMateGuides;
  const READY_TIMEOUT_MS = 8000;
  // The billboard is laid out for a 760 x 560 card. Where the window has room the whole card is zoomed up, page and
  // all, so the page keeps its layout and simply reads larger.
  const CARD = { width: 760, height: 560, margin: 48, maxZoom: 1.35 };
  function fitCard(card){
    const zoom = Math.min(CARD.maxZoom, (root.innerWidth - CARD.margin) / CARD.width, (root.innerHeight - CARD.margin) / CARD.height);
    card.style.zoom = zoom > 1.01 ? zoom.toFixed(3) : '';
  }
  const css = `
    .gxa-host{position:fixed;inset:0;z-index:2147483300;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(16,24,40,.62);opacity:0;transition:opacity .22s ease}
    .gxa-host.gxa-in{opacity:1}
    .gxa-host[hidden],.gxa-foot[hidden]{display:none}
    .gxa-card{outline:none;position:relative;display:flex;flex-direction:column;width:min(760px,100%);height:min(560px,100%);background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(16,24,40,.35);transform:translateY(10px) scale(.98);transition:transform .28s cubic-bezier(.22,1,.36,1)}
    .gxa-host.gxa-in .gxa-card{transform:none}
    .gxa-card iframe{flex:1;min-height:0;width:100%;border:0;display:block}
    .gxa-close{position:absolute;top:10px;right:10px;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.92);color:#344054;cursor:pointer;box-shadow:0 1px 4px rgba(16,24,40,.25);display:flex;align-items:center;justify-content:center}
    .gxa-close:hover{background:#fff}
    .gxa-close svg{width:18px;height:18px;stroke:currentColor;stroke-width:2.2;fill:none;stroke-linecap:round}
    .gxa-close:focus-visible,.gxa-try:focus-visible{outline:3px solid var(--primary,#d93025);outline-offset:2px}
    .gxa-foot{display:flex;justify-content:flex-end;padding:12px 16px;border-top:1px solid #eaecf0}
    .gxa-try{min-height:42px;padding:0 20px;border:0;border-radius:9px;background:var(--primary,#d93025);color:#fff;font:700 14px Montserrat,Arial,sans-serif;cursor:pointer}
    @media(max-width:640px){.gxa-host{padding:0}.gxa-card{width:100%;height:100%;border-radius:0}}
    @media(prefers-reduced-motion:reduce){.gxa-host,.gxa-card{transition:none}}
  `;

  /** What the action button opens: a new order, for a scope when the step names one. */
  function openWorkflow(options){
    if (!options.workflow) return;
    root.dispatchEvent(new CustomEvent('fm:new-project-workflow', { detail: { workflow: options.workflow, orderScope: options.order_scope || '' } }));
  }

  async function player(ctx){
    const { experience, api, track, L, esc, reducedMotion } = ctx;
    const step = experience.steps[0], options = step?.options || {};
    if (!options.billboard) return { status: 'unavailable' };
    const url = api.billboardUrl(options.billboard);
    const published = await fetch(url, { credentials: 'include', cache: 'no-store' }).then((response) => response.ok, () => false);
    if (!published) return { status: 'ended' };
    G().injectCss('gxa-css', css);
    const host = document.createElement('div');
    host.className = 'gxa-host'; host.hidden = true; host.setAttribute('data-fmr-ignore', ''); host.dataset.gxExperience = experience.id;
    host.innerHTML = `<div class="gxa-card" tabindex="-1" role="dialog" aria-modal="true" aria-label="${esc(L(step.title))}">
      <iframe aria-label="${esc(L(step.title))}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>
      <button type="button" class="gxa-close" aria-label="${esc(L('gx_announce_close', 'Close'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <div class="gxa-foot" hidden><button type="button" class="gxa-try">${esc(L('gx_announce_try', 'Try It Now'))}</button></div>
    </div>`;
    const frame = host.querySelector('iframe'), foot = host.querySelector('.gxa-foot'), card = host.querySelector('.gxa-card');
    document.body.append(host);
    return new Promise((resolve) => {
      let finished = false, shown = false;
      const previousFocus = document.activeElement;
      const onResize = () => fitCard(card);
      const remove = () => {
        root.removeEventListener('resize', onResize);
        root.removeEventListener('message', onMessage);
        document.removeEventListener('keydown', onKey, true);
        clearTimeout(timer);
        host.remove();
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
      };
      const finish = async (type) => {
        if (finished) return;
        finished = true;
        // Recorded before it goes: a failed save brings the announcement back rather than losing it.
        await track(type, { step_id: step.id });
        const leave = () => { remove(); if (type === 'complete') openWorkflow(options); resolve({ status: type === 'complete' ? 'completed' : 'dismissed' }); };
        if (reducedMotion()) return leave();
        host.classList.remove('gxa-in');
        setTimeout(leave, 220);
      };
      const reveal = (buttonFound) => {
        if (shown) return;
        shown = true;
        clearTimeout(timer);
        // The page has no button by the expected id: it still works, with the platform's own.
        if (!buttonFound) { foot.hidden = false; console.warn(`Announcement ${experience.id}: the billboard has no button with the expected id.`); }
        host.hidden = false;
        requestAnimationFrame(() => { host.classList.add('gxa-in'); host.querySelector('.gxa-card').focus({ preventScroll: true }); });
      };
      // Only this frame's window: the page has an opaque origin, so its origin says nothing.
      const onMessage = (event) => {
        if (event.source !== frame.contentWindow || event.data?.fmBillboard !== true) return;
        if (event.data.type === 'ready') reveal(event.data.button === true);
        else if (event.data.type === 'action' && shown) finish('complete');
      };
      const onKey = (event) => { if (event.key === 'Escape' && shown) { event.preventDefault(); event.stopPropagation(); finish('dismiss'); } };
      const timer = setTimeout(() => { if (!shown) { finished = true; remove(); resolve({ status: 'ended' }); } }, READY_TIMEOUT_MS);
      fitCard(card);
      root.addEventListener('resize', onResize);
      root.addEventListener('message', onMessage);
      document.addEventListener('keydown', onKey, true);
      host.querySelector('.gxa-close').addEventListener('click', () => finish('dismiss'));
      host.querySelector('.gxa-try').addEventListener('click', () => finish('complete'));
      frame.src = url;
    });
  }

  function register(){
    if (!G()?.registerKind) return false;
    G().registerKind('announcement', player);
    return true;
  }
  if (!register()) root.addEventListener?.('DOMContentLoaded', register, { once: true });
})(window);
