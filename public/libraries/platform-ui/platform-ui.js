/* libraries/platform-ui/platform-ui.js
 * Shared Platform UI affordances: toasts, tooltips, alerts, and confirms.
 */
(function(){
  const root = window;
  if (root.PlatformUI?.__initialized) return;

  const state = {
    tooltip: null,
    tooltipTarget: null,
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
        position:fixed;right:18px;bottom:18px;z-index:9102;
        background:rgba(255,255,255,.96);border:1px solid rgba(0,0,0,.08);
        box-shadow:0 18px 50px rgba(0,0,0,.16);border-radius:16px;
        padding:12px;display:none;min-width:280px;max-width:min(520px,calc(100vw - 36px));
        backdrop-filter:blur(10px)
      }
      .fm-toast.show{display:flex;gap:10px;align-items:center;animation:fmUiFade .16s ease-out}
      .fm-toast .ic{width:36px;height:36px;border-radius:14px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,.06);flex-shrink:0}
      .fm-toast .tx{display:flex;flex-direction:column;min-width:0}
      .fm-toast .t1{font-weight:1000;font-size:13px;color:#111}
      .fm-toast .t2{font-weight:800;font-size:12px;color:#666;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-toast .x{margin-left:auto;width:36px;height:36px;border-radius:14px;border:1px solid rgba(0,0,0,.08);background:#fff;cursor:pointer;transition:.16s ease}
      .fm-toast .x:hover{transform:translateY(-1px)}
      .fm-tooltip{
        position:fixed;z-index:2147483600;max-width:min(360px,calc(100vw - 24px));
        background:rgba(15,23,42,.94);color:#fff;border-radius:9px;padding:8px 10px;
        font-size:11px;font-weight:850;line-height:1.35;box-shadow:0 12px 28px rgba(15,23,42,.22);
        pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease;
        white-space:normal
      }
      .fm-tooltip.visible{opacity:1;transform:translateY(0)}
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
      @keyframes fmUiFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
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
    el.innerHTML = `
      <div class="ic" id="fmToastIc"><i class="fas fa-check"></i></div>
      <div class="tx">
        <div class="t1" id="fmToastT1">Done</div>
        <div class="t2" id="fmToastT2"></div>
      </div>
      <button class="x" id="fmToastX" type="button" data-fm-tooltip="Dismiss"><i class="fas fa-times"></i></button>
    `;
    document.body.appendChild(el);
    document.getElementById('fmToastX')?.addEventListener('click', hideToast);
    return el;
  }

  function showToast(t1, t2, ok = true){
    ensureToast();
    document.getElementById('fmToastT1').textContent = t1 || 'Done';
    document.getElementById('fmToastT2').textContent = t2 || '';
    const ic = document.getElementById('fmToastIc');
    if (ic) {
      ic.style.background = ok ? '#e6f4ea' : '#fce8e6';
      ic.style.borderColor = ok ? '#b7e1c1' : '#f4b4ae';
      ic.style.color = ok ? '#137333' : '#c5221f';
      ic.innerHTML = ok ? '<i class="fas fa-check"></i>' : '<i class="fas fa-triangle-exclamation"></i>';
    }
    const el = document.getElementById('fmToast');
    el?.classList.add('show');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, 4200);
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
    const html = String(target.getAttribute('data-fm-tooltip-html') || '').trim();
    if (html) return { html };
    const text = String(target.getAttribute('data-fm-tooltip') || '').trim();
    return text ? { text } : null;
  }

  function positionTooltip(target){
    const tip = ensureTooltip();
    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 10;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < pad) top = rect.bottom + 8;
    left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - tipRect.height - pad));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showTooltip(target, options = {}){
    if (!target) return;
    const content = options.html || options.text ? options : tooltipContentFromTarget(target);
    if (!content) return;
    const tip = ensureTooltip();
    if (content.html) tip.innerHTML = content.html;
    else tip.textContent = content.text || '';
    state.tooltipTarget = target;
    tip.classList.add('visible');
    tip.style.left = '0px';
    tip.style.top = '0px';
    positionTooltip(target);
  }

  function hideTooltip(target = null){
    if (target && state.tooltipTarget && target !== state.tooltipTarget) return;
    state.tooltip?.classList.remove('visible');
    state.tooltipTarget = null;
  }

  function initTooltips(){
    injectCSS();
    if (state.listenersBound) return;
    state.listenersBound = true;
    document.addEventListener('mouseover', (event) => {
      const target = event.target?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html]');
      if (target) showTooltip(target);
    });
    document.addEventListener('mousemove', (event) => {
      const target = event.target?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html]');
      if (target && state.tooltipTarget === target) positionTooltip(target);
    });
    document.addEventListener('mouseout', (event) => {
      const target = event.target?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html]');
      if (target && !target.contains(event.relatedTarget)) hideTooltip(target);
    });
    document.addEventListener('focusin', (event) => {
      const target = event.target?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html]');
      if (target) showTooltip(target);
    });
    document.addEventListener('focusout', (event) => {
      const target = event.target?.closest?.('[data-fm-tooltip],[data-fm-tooltip-html]');
      if (target) hideTooltip(target);
    });
    window.addEventListener('scroll', () => {
      if (state.tooltipTarget) positionTooltip(state.tooltipTarget);
    }, true);
    window.addEventListener('resize', () => {
      if (state.tooltipTarget) positionTooltip(state.tooltipTarget);
    });
  }

  function dialog(options = {}){
    injectCSS();
    const isPrompt = options.prompt === true;
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
            ${(options.confirm || isPrompt) ? `<button type="button" class="fm-dialog-btn" data-dialog-cancel>${escapeHtml(cancelLabel)}</button>` : ''}
            <button type="button" class="fm-dialog-btn primary${options.danger ? ' danger' : ''}" data-dialog-ok>${escapeHtml(okLabel)}</button>
          </div>
        </div>
      `;
      let modalHandle = null;
      const finish = (value) => {
        modalHandle?.unregister?.();
        modalHandle = null;
        backdrop.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') finish(false);
        if (isPrompt && event.key === 'Enter') finish(backdrop.querySelector('[data-dialog-input]')?.value ?? '');
      };
      const modalManager = root.Portal?.modals || null;
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop && (!modalManager || modalManager.isTop(backdrop))) finish(false);
      });
      backdrop.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(false));
      backdrop.querySelector('[data-dialog-ok]')?.addEventListener('click', () => {
        finish(isPrompt ? (backdrop.querySelector('[data-dialog-input]')?.value ?? '') : true);
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
      setTimeout(() => (backdrop.querySelector('[data-dialog-input]') || backdrop.querySelector('[data-dialog-ok]'))?.focus(), 0);
    });
  }

  function alertUi(message, options = {}){
    return dialog({ ...options, message, confirm: false }).then(() => true);
  }

  function confirmUi(message, options = {}){
    return dialog({ ...options, message, confirm: true });
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
    prompt: promptUi,
    installBrowserDialogOverrides,
    native: nativeDialogs,
  };

  root.PlatformUI = api;
  installBrowserDialogOverrides();
  document.addEventListener('DOMContentLoaded', initTooltips);
  if (document.readyState !== 'loading') initTooltips();
})();
