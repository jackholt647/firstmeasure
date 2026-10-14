/* public/libraries/apps/people/hover-card.js
 *
 * The hover card: a read-only, compact version of an entity's summary that
 * appears when the pointer rests on a person (later a group, a department or
 * an outside company) anywhere in the product.
 *
 *   Mark anything that stands for an entity:   <span data-people-hover="organization_user:ana">Ana</span>
 *
 *   const detach = FirstMatePeople.hoverCard.attach(root, {
 *     resolve(key, element) => model | Promise<model> | null   // the kit.summary model for that key
 *   });
 *   FirstMatePeople.hoverCard.hide()
 *
 * The key is the assignee key ("organization_user:<id>", "resource_group:<id>",
 * "organization_connection:<id>") or any string the resolver understands.
 * A resolver registered with hoverCard.register(prefix, resolve) serves every
 * root that attaches without its own.
 *
 * It opens after a short delay, never takes focus, holds nothing focusable,
 * stays while the pointer moves onto it, and closes on Escape, scroll, or when
 * the pointer leaves. It does not appear on touch devices.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.hoverCard) return;
  const kit = People.kit;
  const OPEN_DELAY = 320;
  const CLOSE_DELAY = 140;
  const resolvers = new Map();
  let card = null;
  let anchor = null;
  let openTimer = 0;
  let closeTimer = 0;
  let token = 0;

  function ensureStyles(){
    if (document.getElementById('pp_hover_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_hover_css';
    style.textContent = `
      .pp-hover{position:fixed;z-index:2147483450;left:0;top:0;border:1px solid var(--pp-line);border-radius:14px;background:var(--pp-panel);box-shadow:var(--pp-shadow);opacity:0;transform:translateY(6px) scale(.97);transform-origin:var(--pp-hover-origin,top left);transition:opacity .14s ease,transform .18s cubic-bezier(.2,.9,.25,1);pointer-events:none}
      .pp-hover.open{opacity:1;transform:none;pointer-events:auto}
      .pp-hover.above{transform:translateY(-6px) scale(.97)}
      .pp-hover.above.open{transform:none}
      @media (prefers-reduced-motion:reduce){.pp-hover{transition:opacity .01s linear;transform:none}}
    `;
    document.head.appendChild(style);
  }
  function element(){
    if (card?.isConnected) return card;
    ensureStyles();
    card = document.createElement('div');
    card.className = 'pp pp-hover';
    card.setAttribute('aria-hidden', 'true');
    card.dataset.settingsAutosave = 'off';
    card.addEventListener('pointerenter', () => window.clearTimeout(closeTimer));
    card.addEventListener('pointerleave', () => scheduleHide());
    document.body.appendChild(card);
    return card;
  }
  function position(target){
    const rect = target.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const width = card.offsetWidth || box.width;
    const height = card.offsetHeight || box.height;
    const pad = 10;
    let left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
    let top = rect.bottom + 8;
    const above = top + height > window.innerHeight - pad && rect.top - height - 8 >= pad;
    if (above) top = rect.top - height - 8;
    card.classList.toggle('above', above);
    card.style.setProperty('--pp-hover-origin', `${above ? 'bottom' : 'top'} left`);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(pad, top))}px`;
  }
  function hide(){
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    token += 1;
    anchor = null;
    card?.classList.remove('open');
  }
  function scheduleHide(){
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, CLOSE_DELAY);
  }
  async function show(target, resolve){
    const key = target.dataset.peopleHover;
    const mine = ++token;
    let model = null;
    try { model = await resolve(key, target); } catch (_) { model = null; }
    if (mine !== token || !model || !target.isConnected) return;
    const node = element();
    node.innerHTML = kit.summary(model, 'card');
    kit.presence.paint(node);
    anchor = target;
    position(target);
    node.classList.add('open');
  }
  function resolverFor(key, own){
    if (own) return own;
    const prefix = String(key || '').split(':')[0];
    return resolvers.get(prefix) || resolvers.get('*') || null;
  }
  function attach(root, options = {}){
    if (!root) return () => {};
    const canHover = () => !window.matchMedia || window.matchMedia('(hover:hover)').matches;
    const onOver = (event) => {
      const target = event.target.closest?.('[data-people-hover]');
      if (!target || !root.contains(target) || !canHover()) return;
      // Controls inside the row (photo, quick actions, chips with their own tooltip) keep their own affordance.
      if (event.target.closest('button:not([data-row-open]),[data-fm-tooltip]') && target.contains(event.target.closest('button:not([data-row-open]),[data-fm-tooltip]'))) { if (anchor !== target) window.clearTimeout(openTimer); return; }
      window.clearTimeout(closeTimer);
      if (anchor === target) return;
      const resolve = resolverFor(target.dataset.peopleHover, options.resolve);
      if (!resolve) return;
      window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => show(target, resolve), anchor ? 120 : OPEN_DELAY);
    };
    const onOut = (event) => {
      const target = event.target.closest?.('[data-people-hover]');
      if (!target) return;
      const to = event.relatedTarget;
      if (to && (target.contains(to) || card?.contains(to))) return;
      scheduleHide();
    };
    const onDown = () => hide();
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('pointerdown', onDown);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('pointerdown', onDown);
      if (anchor && root.contains(anchor)) hide();
    };
  }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && anchor) hide(); }, true);
  window.addEventListener('scroll', (event) => { if (anchor && !card?.contains(event.target)) hide(); }, true);
  window.addEventListener('resize', () => { if (anchor) hide(); });

  People.hoverCard = {
    attach,
    hide,
    register(prefix, resolve){ resolvers.set(String(prefix || '*'), resolve); return () => resolvers.delete(String(prefix || '*')); },
    isOpen:() => !!anchor
  };
})();
