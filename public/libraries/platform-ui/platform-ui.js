/* libraries/platform-ui/platform-ui.js
 * Shared Platform UI affordances: toasts, tooltips, alerts, and confirms.
 */
(function(){
  const root = window;
  if (root.PlatformUI?.__initialized) return;

  const state = {
    tooltip: null,
    tooltipTarget: null,
    tooltipShowTimer: null,
    tooltipHideTimer: null,
    tooltipSuppressedTarget: null,
    tooltipObserver: null,
    tooltipFrame: null,
    toastTimer: null,
    listenersBound: false,
  };
  const nativeDialogs = {
    alert: root.alert?.bind(root),
    confirm: root.confirm?.bind(root),
    prompt: root.prompt?.bind(root),
  };

  function escapeHtml(value){
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function injectCSS(){
    if (document.getElementById('platformUiStyle')) return;
    const style = document.createElement('style');
    style.id = 'platformUiStyle';
    style.textContent = `
      .fm-toast{
        position:fixed;right:18px;bottom:18px;z-index:2147483600;
        background:rgba(255,255,255,.96);border:1px solid rgba(0,0,0,.08);
        box-shadow:0 18px 50px rgba(0,0,0,.16);border-radius:16px;
        padding:12px;display:none;min-width:280px;max-width:min(520px,calc(100vw - 36px));
        backdrop-filter:blur(10px);cursor:pointer
      }
      .fm-toast :is(button,a,[role=button],input,select,textarea){cursor:pointer}
      .fm-toast.show{display:flex;gap:10px;align-items:center;animation:fmUiFade .16s ease-out}
      .fm-toast .ic{width:36px;height:36px;border-radius:14px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,.06);flex-shrink:0}
      .fm-toast .tx{display:flex;flex:1;flex-direction:column;min-width:0}
      .fm-toast .t1{font-weight:1000;font-size:13px;color:#111}
      .fm-toast .t2{font-weight:800;font-size:12px;color:#666;margin-top:2px;line-height:1.35;overflow:hidden;overflow-wrap:anywhere;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}
      .fm-toast .x{flex-shrink:0;margin-left:auto;width:36px;height:36px;border-radius:14px;border:1px solid rgba(0,0,0,.08);background:#fff;cursor:pointer;transition:.16s ease}
      .fm-toast .x:hover{transform:translateY(-1px)}
      .fm-toast.compact{min-width:0;max-width:min(var(--fm-toast-compact-width,300px),calc(100vw - 36px));padding:9px;gap:8px;border-radius:14px}
      .fm-toast.compact .ic,.fm-toast.compact .x{width:28px;height:28px;border-radius:10px}
      .fm-toast.compact .t1{font-size:12px}
      .fm-toast.compact .t2{font-size:11px;-webkit-line-clamp:4}
      .fm-tooltip{
        position:fixed;z-index:2147483600;max-width:min(360px,calc(100vw - 24px));
        background:rgba(15,23,42,.96);color:#fff;border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:8px 10px;
        font-family:Montserrat,Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
        font-size:11px;font-weight:650;line-height:1.38;letter-spacing:.005em;box-shadow:0 12px 30px rgba(15,23,42,.26);
        backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);
        pointer-events:none;opacity:0;transform:translateY(-4px) scale(.985);transform-origin:var(--fm-tooltip-origin,50% 0);
        transition:opacity .16s ease,transform .18s cubic-bezier(.2,.8,.2,1);white-space:normal;overflow-wrap:anywhere
      }
      .fm-tooltip.fm-tooltip-plain{white-space:pre-line}
      .fm-tooltip.fm-tooltip-instant{transition:none;transform:none}
      .fm-tooltip[data-side="right"]::after{left:-12px;top:50%;transform:translateY(-50%);border-right-color:rgba(15,23,42,.96)}
      .fm-tooltip[data-side="above"]{transform:translateY(4px) scale(.985);--fm-tooltip-origin:50% 100%}
      .fm-tooltip.visible{opacity:1;transform:translateY(0) scale(1)}
      .fm-tooltip::after{content:"";position:absolute;left:var(--fm-tooltip-arrow-x,50%);width:0;height:0;transform:translateX(-50%);border:6px solid transparent;filter:drop-shadow(0 1px 0 rgba(255,255,255,.08))}
      .fm-tooltip[data-side="below"]::after{top:-12px;border-bottom-color:rgba(15,23,42,.96)}
      .fm-tooltip[data-side="above"]::after{bottom:-12px;border-top-color:rgba(15,23,42,.96)}
      .fm-tooltip-title,.fm-tip-title{font-size:11px;font-weight:1000;margin-bottom:6px;color:#fff}
      .fm-tooltip-row,.fm-tip-row{display:grid;grid-template-columns:minmax(86px,1fr) auto;gap:12px;padding:3px 0;border-top:1px solid rgba(255,255,255,.12)}
      .fm-tooltip-row:first-of-type,.fm-tip-row:first-of-type{border-top:0}
      .fm-tooltip-name,.fm-tip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.84)}
      .fm-tooltip-value,.fm-tip-value{font-weight:1000;color:#fff}
      .fm-ui-help{
        display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;
        border:1px solid rgba(15,23,42,.10);background:#eef2f7;color:#344054;
        font-size:11px;font-weight:1000;cursor:help;line-height:1;vertical-align:middle
      }
      .fm-ui-help:hover,.fm-ui-help:focus{background:#111827;color:#fff;outline:none}
      .fm-dialog-backdrop{position:fixed;inset:0;z-index:2147483601;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:18px}
      .fm-dialog{width:min(430px,calc(100vw - 36px));background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden}
      .fm-dialog-body{padding:18px 18px 10px;display:grid;gap:8px}
      .fm-dialog-title{font-size:16px;font-weight:1000;color:#101828}
      .fm-dialog-message{font-size:13px;font-weight:800;color:#475467;line-height:1.45}
      .fm-dialog-input{width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.14);border-radius:12px;padding:11px 12px;font-size:13px;font-weight:850;color:#101828;outline:0;background:#fff}
      .fm-dialog-input:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
      .fm-dialog-actions{padding:14px 18px 18px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .fm-dialog-btn{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:12px;padding:10px 13px;font-size:12px;font-weight:1000;cursor:pointer}
      .fm-dialog-btn.primary{background:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .fm-dialog-btn.danger{background:#b42318;border-color:#b42318;color:#fff}
      .fm-dialog-btn:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:2px}
      @keyframes fmUiFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @media (prefers-reduced-motion:reduce){.fm-tooltip{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function ensureToast(){
    injectCSS();
    let el = document.getElementById('fmToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'fmToast';
    el.className = 'fm-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.innerHTML = `
      <div class="ic" id="fmToastIc"><i class="fas fa-check"></i></div>
      <div class="tx">
        <div class="t1" id="fmToastT1">${(globalThis.PlatformLanguage?.htmlText("platform-ui","m_8cb6b086a0e69c","Done") ?? "Done")}</div>
        <div class="t2" id="fmToastT2"></div>
      </div>
      <button class="x" id="fmToastX" type="button" data-fm-tooltip="Dismiss"><i class="fas fa-times"></i></button>
    `;
    document.body.appendChild(el);
    document.getElementById('fmToastX')?.addEventListener('click', hideToast);
    /* A click on the toast itself (not its Dismiss / Undo / Retry controls)
     * dismisses it, so whatever it covers (a Save button, a new calendar
     * item) is one click away. The click never reaches the hidden control
     * underneath, which the user could not see. */
    el.addEventListener('click', (event) => {
      if (event.target?.closest?.('button,a,[role=button],input,select,textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      hideToast();
    });
    return el;
  }

  /* Toast tones: true / 'success' (green check), false / 'error' (red
   * warning), 'info' (neutral, e.g. "View only") and 'warning' (amber). The
   * third argument may also be { tone, duration } (duration in ms). */
  const TOAST_TONES = {
    success: { background:'#e6f4ea', border:'#b7e1c1', color:'#137333', icon:'fa-check' },
    error: { background:'#fce8e6', border:'#f4b4ae', color:'#c5221f', icon:'fa-triangle-exclamation' },
    info: { background:'#eef2f6', border:'#d0d5dd', color:'#475467', icon:'fa-circle-info' },
    warning: { background:'#fffaeb', border:'#fedf89', color:'#b54708', icon:'fa-circle-exclamation' },
  };
  function toastTone(ok){
    const value = ok && typeof ok === 'object' ? ok.tone : ok;
    if (value === false || value === 'error') return 'error';
    if (value === 'info' || value === 'warning') return value;
    return 'success';
  }
  function showToast(t1, t2, ok = true){
    if (window.FirstMateSettingsPages?.consumeAutosaveToast?.(t1, t2, ok)) return;
    ensureToast();
    document.getElementById('fmToastT1').textContent = t1 || 'Done';
    document.getElementById('fmToastT2').textContent = t2 || '';
    const tone = toastTone(ok);
    const look = TOAST_TONES[tone];
    const ic = document.getElementById('fmToastIc');
    if (ic) {
      ic.style.background = look.background;
      ic.style.borderColor = look.border;
      ic.style.color = look.color;
      ic.innerHTML = `<i class="fas ${look.icon}"></i>`;
    }
    const el = document.getElementById('fmToast');
    if (el) el.dataset.tone = tone;
    // { compact:true }: a narrower toast for dense surfaces (a calendar
    // grid under it stays usable while it waits to be dismissed).
    el?.classList.toggle('compact', !!(ok && typeof ok === 'object' && ok.compact === true));
    el?.classList.add('show');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    const duration = Number(ok && typeof ok === 'object' ? ok.duration : 0);
    state.toastTimer = setTimeout(hideToast, Number.isFinite(duration) && duration > 0 ? duration : 4200);
  }

  function hideToast(){
    document.getElementById('fmToast')?.classList.remove('show');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }

  function ensureTooltip(){
    injectCSS();
    if (state.tooltip) return state.tooltip;
    const tip = document.createElement('div');
    tip.id = 'fmTooltip';
    tip.className = 'fm-tooltip';
    document.body.appendChild(tip);
    state.tooltip = tip;
    return tip;
  }

  function tooltipContentFromTarget(target){
    if (!target) return null;
    if (instantSidebarTooltip(target)) {
      const text = target.getAttribute('aria-label') || target.getAttribute('data-fm-tooltip') ||
        target.getAttribute('data-fm-native-title') || target.getAttribute('title') || target.textContent;
      return text?.trim() ? { text: text.trim() } : null;
    }
    const html = String(target.getAttribute('data-fm-tooltip-html') || '').trim();
    if (html) return { html };
    const text = String(target.getAttribute('data-fm-tooltip') || '').trim();
    return text ? { text } : null;
  }

  function adoptNativeTooltip(target){
    if (!target?.getAttribute || !target.hasAttribute('title')) return target;
    const nativeTitle = String(target.getAttribute('title') || '').trim();
    const previouslyAdopted = target.hasAttribute('data-fm-native-title');
    if (nativeTitle && !target.hasAttribute('data-fm-tooltip-html') && (previouslyAdopted || !target.hasAttribute('data-fm-tooltip'))) {
      target.setAttribute('data-fm-tooltip', nativeTitle);
    }
    if (nativeTitle) target.setAttribute('data-fm-native-title', nativeTitle);
    target.removeAttribute('title');
    return target;
  }

  function adoptNativeTooltipsWithin(node){
    if (!node || node.nodeType !== 1) return;
    if (node.matches?.('[title]')) adoptNativeTooltip(node);
    node.querySelectorAll?.('[title]').forEach(adoptNativeTooltip);
  }

  function instantSidebarTooltip(target){
    return !!target?.closest?.('#mainSidebar.sidebar-instant-tooltips.sidebar-compact:not(.sidebar-compact-expanded)') &&
      !window.matchMedia('(max-width:820px)').matches;
  }

  function tooltipTargetFrom(start){
    if (instantSidebarTooltip(start)) {
      const item = start?.closest?.('button,a,[role="button"],.fm-link');
      if (item) return adoptNativeTooltip(item);
    }
    const target = start?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html],[title]') || null;
    return target ? adoptNativeTooltip(target) : null;
  }

  function positionTooltip(target){
    // A re-render can remove the hovered element without a mouseout; its rect
    // is then all zeros and the tooltip would pin to the viewport's corner.
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[hidden],[inert]')) {
      if (state.tooltipTarget === target) hideTooltip();
      return;
    }
    const tip = ensureTooltip();
    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 10;
    if (instantSidebarTooltip(target)) {
      const sidebarRect = target.closest('#mainSidebar').getBoundingClientRect();
      tip.dataset.side = 'right';
      tip.style.left = `${Math.round(Math.max(pad, Math.min(sidebarRect.right + 10, window.innerWidth - tipRect.width - pad)))}px`;
      tip.style.top = `${Math.round(Math.max(pad, Math.min(rect.top + (rect.height - tipRect.height) / 2, window.innerHeight - tipRect.height - pad)))}px`;
      return;
    }
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let side = 'below';
    let top = rect.bottom + 10;
    if (top + tipRect.height > window.innerHeight - pad && rect.top - tipRect.height - 10 >= pad) {
      side = 'above';
      top = rect.top - tipRect.height - 10;
    }
    left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - tipRect.height - pad));
    const arrowX = Math.max(10, Math.min(tipRect.width - 10, rect.left + rect.width / 2 - left));
    tip.dataset.side = side;
    tip.style.setProperty('--fm-tooltip-arrow-x', `${Math.round(arrowX)}px`);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showTooltip(target, options = {}){
    if (!target || state.tooltipSuppressedTarget === target) return;
    const content = options.html || options.text ? options : tooltipContentFromTarget(target);
    if (!content) return;
    const tip = ensureTooltip();
    clearTimeout(state.tooltipShowTimer);
    clearTimeout(state.tooltipHideTimer);
    state.tooltipShowTimer = null;
    state.tooltipHideTimer = null;
    if (content.html) tip.innerHTML = content.html;
    else tip.textContent = content.text || '';
    // Plain-text tooltips keep their author's line breaks; HTML ones use markup.
    tip.classList.toggle('fm-tooltip-plain', !content.html);
    tip.classList.toggle('fm-tooltip-instant', instantSidebarTooltip(target));
    state.tooltipTarget = target;
    tip.classList.remove('visible');
    tip.style.left = '0px';
    tip.style.top = '0px';
    positionTooltip(target);
    const initialAnchor = target.getBoundingClientRect();
    // Layout changes need not emit mouseout (window docking, hiding, reparenting).
    // Watch only while a tooltip is visible, and dismiss when its anchor moves.
    const watchAnchor = () => {
      const rect = target.getBoundingClientRect();
      const anchor = [rect.x, rect.y, rect.width, rect.height];
      const check = () => {
        if (state.tooltipTarget !== target) return;
        const next = target.getBoundingClientRect();
        if (!target.isConnected || !target.getClientRects().length || target.closest('[hidden],[inert]') ||
            [next.x, next.y, next.width, next.height].some((value, i) => Math.abs(value - anchor[i]) > 1)) {
          hideTooltip();
          return;
        }
        state.tooltipFrame = requestAnimationFrame(check);
      };
      cancelAnimationFrame(state.tooltipFrame);
      state.tooltipFrame = requestAnimationFrame(check);
    };
    const reveal = () => {
      if (state.tooltipTarget !== target || !target.isConnected) return;
      const currentAnchor = target.getBoundingClientRect();
      if (['x', 'y', 'width', 'height'].some(key => Math.abs(currentAnchor[key] - initialAnchor[key]) > 1)) { hideTooltip(); return; }
      positionTooltip(target);
      if (state.tooltipTarget !== target) return;
      watchAnchor();
      if (instantSidebarTooltip(target)) {
        tip.classList.add('visible');
        return;
      }
      requestAnimationFrame(() => {
        if (state.tooltipTarget === target) tip.classList.add('visible');
      });
    };
    const delay = instantSidebarTooltip(target) ? 0 : Math.max(0, Number(options.delay) || 0);
    if (delay) state.tooltipShowTimer = setTimeout(reveal, delay);
    else reveal();
  }

  function hideTooltip(target = null){
    if (target && state.tooltipTarget && target !== state.tooltipTarget) return;
    clearTimeout(state.tooltipShowTimer);
    clearTimeout(state.tooltipHideTimer);
    state.tooltipShowTimer = null;
    state.tooltipHideTimer = null;
    cancelAnimationFrame(state.tooltipFrame);
    state.tooltipFrame = null;
    const tip = state.tooltip;
    tip?.classList.remove('visible');
    state.tooltipTarget = null;
    if (tip) state.tooltipHideTimer = setTimeout(() => {
      if (!tip.classList.contains('visible')) {
        tip.textContent = '';
        tip.removeAttribute('data-side');
      }
    }, 190);
  }

  function initTooltips(){
    injectCSS();
    if (state.listenersBound) return;
    state.listenersBound = true;
    document.querySelectorAll('[title]').forEach(adoptNativeTooltip);
    if (root.MutationObserver) {
      state.tooltipObserver = new root.MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') adoptNativeTooltip(record.target);
          else for (const node of record.addedNodes || []) adoptNativeTooltipsWithin(node);
        }
        if (state.tooltipTarget && !state.tooltipTarget.isConnected) hideTooltip();
      });
      if (document.documentElement) state.tooltipObserver.observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['title'] });
    }
    // Touch has no hover: the compatibility mouse events and the focus a tap
    // produces must not pin a tooltip over whatever the tap opened. And
    // after a click, the element re-rendered under a still pointer (an
    // editor/popover just opened) doesn't pop its tooltip over it.
    const recentTouch = () => Date.now() - Number(state.lastTouchAt || 0) < 900;
    const pressedHere = (event) => {
      const press = state.lastPress;
      return !!press && Date.now() - press.at < 2500
        && Math.hypot(Number(event.clientX) - press.x, Number(event.clientY) - press.y) < 12;
    };
    document.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') state.lastTouchAt = Date.now();
      state.lastPress = { x:Number(event.clientX), y:Number(event.clientY), at:Date.now() };
    }, true);
    document.addEventListener('mouseover', (event) => {
      if (recentTouch() || pressedHere(event)) return;
      const target = tooltipTargetFrom(event.target);
      if (target && !target.contains(event.relatedTarget)) showTooltip(target, { delay: 280 });
    }, true);
    document.addEventListener('mousemove', (event) => {
      const target = tooltipTargetFrom(event.target);
      if (state.tooltipTarget && target !== state.tooltipTarget) hideTooltip();
      else if (target && state.tooltipTarget === target) positionTooltip(target);
    }, true);
    document.addEventListener('mouseout', (event) => {
      const target = tooltipTargetFrom(event.target);
      if (target && !target.contains(event.relatedTarget)) {
        if (state.tooltipSuppressedTarget === target) state.tooltipSuppressedTarget = null;
        hideTooltip(target);
      }
    }, true);
    // Focus shows a tooltip only when it is keyboard focus (focus a script
    // moved after a click or a dialog must not pop one over the next row).
    const keyboardFocus = (node) => { try { return !!node?.matches?.(':focus-visible'); } catch { return true; } };
    document.addEventListener('focusin', (event) => {
      if (recentTouch() || !keyboardFocus(event.target)) return;
      const target = tooltipTargetFrom(event.target);
      if (target) showTooltip(target, { delay: 120 });
    }, true);
    document.addEventListener('focusout', (event) => {
      const target = tooltipTargetFrom(event.target);
      if (target) {
        if (state.tooltipSuppressedTarget === target) state.tooltipSuppressedTarget = null;
        hideTooltip(target);
      }
    }, true);
    // Activating a control often opens a native select or a custom popover.
    // Pointer-down precedes focus-in, so remember the target as suppressed;
    // otherwise focus-in immediately schedules the tooltip over the open UI.
    // It becomes eligible again only after the pointer leaves or focus moves.
    document.addEventListener('pointerdown', (event) => {
      state.tooltipSuppressedTarget = tooltipTargetFrom(event.target);
      hideTooltip();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { hideTooltip(); return; }
      if (!['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) return;
      const target = tooltipTargetFrom(event.target);
      if (!target || !target.matches?.('select,button,[role="button"],[aria-haspopup]')) return;
      state.tooltipSuppressedTarget = target;
      hideTooltip();
    }, true);
    window.addEventListener('scroll', () => {
      if (state.tooltipTarget) positionTooltip(state.tooltipTarget);
    }, true);
    window.addEventListener('resize', () => {
      if (state.tooltipTarget) positionTooltip(state.tooltipTarget);
    });
    window.addEventListener('blur', () => hideTooltip());
    window.addEventListener('pagehide', () => hideTooltip());
    document.addEventListener('visibilitychange', () => { if (document.hidden) hideTooltip(); });
    document.documentElement.addEventListener('mouseleave', () => hideTooltip());
    window.addEventListener('fm:sidebar-mode:changed', () => hideTooltip());
  }

  /* Which control a dialog focuses first (what Enter will do):
   *   options.defaultFocus: 'ok' | 'cancel' | a choice value, or a choice
   *   with default:true. Otherwise the primary action, except a destructive
   *   one (danger) never takes focus by default: Cancel / the first safe
   *   choice does, so Enter can't destroy anything by accident. */
  function defaultFocusTarget(backdrop, options = {}, choices = []){
    const input = backdrop.querySelector('[data-dialog-input]');
    if (input) return input;
    const choiceButton = (index) => (index >= 0 ? backdrop.querySelector(`[data-dialog-choice="${index}"]`) : null);
    const requested = options.defaultFocus;
    if (choices.length) {
      const byValue = (value) => choices.findIndex((choice) => choice.value === value);
      let index = choices.findIndex((choice) => choice.default === true);
      if (index < 0 && requested !== undefined && requested !== null && requested !== '') {
        index = requested === 'ok' ? choices.findIndex((choice) => choice.primary) : byValue(requested);
      }
      if (index < 0) {
        const primary = choices.findIndex((choice) => choice.primary);
        const cancelIndex = byValue('cancel');
        const safeIndex = choices.findIndex((choice) => !choice.danger && !choice.primary);
        index = primary >= 0 && !choices[primary].danger
          ? primary
          : (cancelIndex >= 0 ? cancelIndex : (safeIndex >= 0 ? safeIndex : 0));
      }
      return choiceButton(index) || backdrop.querySelector('[data-dialog-choice]');
    }
    const ok = backdrop.querySelector('[data-dialog-ok]');
    const cancel = backdrop.querySelector('[data-dialog-cancel]');
    if (requested === 'cancel') return cancel || ok;
    if (requested === 'ok') return ok;
    return options.danger && cancel ? cancel : ok;
  }

  function dialog(options = {}){
    injectCSS();
    const isPrompt = options.prompt === true;
    const choices = Array.isArray(options.choices) ? options.choices.filter((choice) => choice && choice.label) : [];
    const title = options.title || (isPrompt ? 'Input' : (options.confirm ? 'Confirm' : 'Notice'));
    const message = options.message || '';
    const okLabel = options.okLabel || (isPrompt ? 'Submit' : (options.confirm ? 'Confirm' : 'OK'));
    const cancelLabel = options.cancelLabel || 'Cancel';
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'fm-dialog-backdrop';
      backdrop.innerHTML = `
        <div class="fm-dialog" role="dialog" aria-modal="true" aria-labelledby="fmDialogTitle">
          <div class="fm-dialog-body">
            <div class="fm-dialog-title" id="fmDialogTitle">${escapeHtml(title)}</div>
            <div class="fm-dialog-message">${escapeHtml(message)}</div>
            ${isPrompt ? `<input class="fm-dialog-input" data-dialog-input value="${escapeHtml(options.defaultValue || '')}" autocomplete="${escapeHtml(options.autocomplete || 'off')}">` : ''}
          </div>
          <div class="fm-dialog-actions">
            ${choices.length
              ? choices.map((choice, index) => `<button type="button" class="fm-dialog-btn${choice.primary ? ' primary' : ''}${choice.danger ? ' danger' : ''}" data-dialog-choice="${index}">${escapeHtml(choice.label)}</button>`).join('')
              : `${(options.confirm || isPrompt) ? `<button type="button" class="fm-dialog-btn" data-dialog-cancel>${escapeHtml(cancelLabel)}</button>` : ''}<button type="button" class="fm-dialog-btn primary${options.danger ? ' danger' : ''}" data-dialog-ok>${escapeHtml(okLabel)}</button>`}
          </div>
        </div>
      `;
      let modalHandle = null;
      let finished = false;
      // Focus returns to whatever had it before the dialog opened (unless the
      // caller moves it on afterwards).
      const previousFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        const focusWasInside = backdrop.contains(document.activeElement);
        modalHandle?.unregister?.();
        modalHandle = null;
        backdrop.remove();
        document.removeEventListener('keydown', onKeydown);
        if (previousFocus?.isConnected && (focusWasInside || !document.activeElement || document.activeElement === document.body)) {
          try { previousFocus.focus({ preventScroll:true }); } catch {}
        }
        // Callers that opened the dialog from a gesture with nothing focused
        // (a drag) can hand focus back to the item they acted on.
        try { root.dispatchEvent(new CustomEvent('fm:dialog:closed', { detail:{ value, focusWasInside } })); } catch {}
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') finish(false);
      };
      const modalManager = root.Portal?.modals || null;
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop && (!modalManager || modalManager.isTop(backdrop))) finish(false);
      });
      backdrop.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(false));
      backdrop.querySelector('[data-dialog-ok]')?.addEventListener('click', () => {
        finish(isPrompt ? (backdrop.querySelector('[data-dialog-input]')?.value ?? '') : true);
      });
      backdrop.querySelectorAll('[data-dialog-choice]').forEach((button) => button.addEventListener('click', () => {
        finish(choices[Number(button.dataset.dialogChoice)]?.value ?? null);
      }));
      // Enter submits a prompt whether or not a modal manager owns the
      // dialog's keyboard handling.
      backdrop.querySelector('[data-dialog-input]')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        finish(event.currentTarget.value ?? '');
      });
      document.body.appendChild(backdrop);
      if (modalManager) {
        modalHandle = modalManager.register(backdrop, {
          id: `platform-dialog-${Date.now()}`,
          closeOnEscape: true,
          closeOnBackdrop: true,
          onClose: () => finish(false)
        });
      } else {
        document.addEventListener('keydown', onKeydown);
      }
      setTimeout(() => defaultFocusTarget(backdrop, options, choices)?.focus(), 0);
    });
  }

  function alertUi(message, options = {}){
    return dialog({ ...options, message, confirm: false }).then(() => true);
  }

  function confirmUi(message, options = {}){
    return dialog({ ...options, message, confirm: true });
  }

  function chooseUi(message, choices = [], options = {}){
    return dialog({ ...options, message, choices });
  }

  function promptUi(message, defaultValue = '', options = {}){
    if (defaultValue && typeof defaultValue === 'object') {
      options = defaultValue;
      defaultValue = options.defaultValue || '';
    }
    return dialog({ ...options, message, defaultValue, prompt: true }).then((value) => value === false ? null : value);
  }

  function installBrowserDialogOverrides(){
    root.alert = (message = '', options = {}) => alertUi(message, options);
    root.confirm = (message = '', options = {}) => confirmUi(message, options);
    root.prompt = (message = '', defaultValue = '', options = {}) => promptUi(message, defaultValue, options);
  }

  const api = {
    __initialized: true,
    escapeHtml,
    initTooltips,
    showTooltip,
    hideTooltip,
    showToast,
    hideToast,
    alert: alertUi,
    confirm: confirmUi,
    choose: chooseUi,
    prompt: promptUi,
    installBrowserDialogOverrides,
    native: nativeDialogs,
  };

  root.PlatformUI = api;
  installBrowserDialogOverrides();
  document.addEventListener('DOMContentLoaded', initTooltips);
  if (document.readyState !== 'loading') initTooltips();
})();
