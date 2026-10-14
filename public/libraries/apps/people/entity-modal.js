/* public/libraries/apps/people/entity-modal.js
 *
 * The large entity modal: summary on the left, actions and sub-tabs on the
 * right. One job per tab, so a tab fits on screen without scrolling. Used for
 * a user and a role today; a group, a department and an outside company open
 * in the same modal.
 *
 *   const modal = FirstMatePeople.entityModal.open({
 *     label: 'Ana Lopez',                     // accessible name of the dialog
 *     opener: element,                        // focus returns here on close
 *     returnFocus() => element,               // or find it at close time, when the opener may have been redrawn
 *     summary(host, modal) {},                // draw the left column into host; called again by modal.refreshSummary()
 *     actions(modal) => [{ id, icon, label, tone, disabled, onClick(button, modal) }],   // icon buttons, top right
 *     tabs: [{ id, label, icon, mount(panel, ctx) => ({ save(), destroy(), show() }) }],
 *     tab: 'permissions',                     // tab to open on
 *     onSave: async (modal) => {},            // persist what the caller's own tabs edited
 *     footer: false,                          // no Save bar, for a modal whose every change saves itself
 *     onClose() {}
 *   });
 *
 *   A tab's mount receives ctx = { modal, setDirty(bool), setStatus(state, text) } and may return
 *   { save: async () => {}, destroy() {}, show() {} }. Save in the footer runs every dirty tab's
 *   save() and then onSave. Tabs mount on first view and stay mounted.
 *
 *   modal.close(force)   modal.selectTab(id)   modal.setDirty(id, bool)   modal.isDirty()
 *   modal.setStatus('saving'|'saved'|'error'|'notice'|'', text)   modal.refreshSummary()   modal.refreshActions()
 *   modal.setTabBadge(id, text)   modal.el
 *
 * Behaviour: focus is trapped and restored, Escape closes (after confirming
 * unsaved changes), tabs follow the arrow keys. Below 760px the modal is the
 * whole screen with the summary on top, collapsed to who it is.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.entityModal) return;
  const kit = People.kit;
  const { esc, t, tip } = kit;

  function ensureStyles(){
    if (document.getElementById('pp_modal_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_modal_css';
    style.textContent = `
      .pp-modal-back{position:fixed;inset:0;z-index:2147483300;display:grid;place-items:center;padding:24px;background:rgba(16,24,40,.46);opacity:0;transition:opacity .16s ease}
      .pp-modal-back.open{opacity:1}
      .pp-modal{position:relative;display:grid;grid-template-columns:292px minmax(0,1fr);width:min(1120px,100%);height:min(720px,100%);border-radius:16px;background:var(--pp-panel);box-shadow:0 32px 80px rgba(16,24,40,.32);overflow:hidden;transform:translateY(8px) scale(.985);transition:transform .2s cubic-bezier(.2,.8,.2,1)}
      .pp-modal-back.open .pp-modal{transform:none}
      .pp-modal-summary{display:flex;flex-direction:column;min-height:0;padding:26px 20px 18px;border-right:1px solid var(--pp-line);background:var(--pp-soft);overflow-y:auto;overscroll-behavior:contain}
      .pp-modal-summary-toggle{display:none}
      .pp-modal-main{display:flex;flex-direction:column;min-width:0;min-height:0}
      .pp-modal-top{display:flex;align-items:center;gap:12px;flex:none;min-height:58px;padding:0 14px 0 18px;border-bottom:1px solid var(--pp-line)}
      .pp-tabs{display:flex;align-items:stretch;gap:2px;flex:1;min-width:0;align-self:stretch;overflow-x:auto;scrollbar-width:none}
      .pp-tabs::-webkit-scrollbar{display:none}
      .pp-tab{position:relative;display:inline-flex;align-items:center;gap:7px;flex:none;padding:0 11px;border:0;background:transparent;color:var(--pp-muted);font-size:13px;font-weight:650;white-space:nowrap;cursor:pointer;transition:color .12s ease}
      .pp-tab>i{font-size:12px;opacity:.85}
      .pp-tab::after{content:'';position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--pp-accent);transform:scaleX(0);transition:transform .16s ease}
      .pp-tab:hover{color:var(--pp-text)}
      .pp-tab[aria-selected="true"]{color:var(--pp-accent)}
      .pp-tab[aria-selected="true"]::after{transform:scaleX(1)}
      .pp-tab:focus-visible{outline-offset:-3px;border-radius:8px}
      .pp-tab-badge{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--pp-warn-bg);color:var(--pp-warn);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}
      .pp-tab-badge:empty{display:none}
      .pp-modal-actions{display:flex;align-items:center;gap:2px;flex:none}
      .pp-modal-actions .pp-icon-btn{width:32px;height:32px;font-size:13px}
      .pp-modal-actions .pp-modal-sep{width:1px;height:18px;margin:0 5px;background:var(--pp-line)}
      .pp-modal-panels{position:relative;flex:1;min-height:0}
      .pp-modal-panel{position:absolute;inset:0;padding:16px 18px;overflow:auto;overscroll-behavior:contain;animation:pp-panel-in .16s ease}
      @keyframes pp-panel-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
      .pp-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;min-height:54px;padding:0 18px;border-top:1px solid var(--pp-line)}
      .pp-modal-status{display:inline-flex;align-items:center;gap:6px;margin-right:auto;min-width:0;color:var(--pp-muted);font-size:12px;font-weight:600}
      .pp-modal-status[data-state="saved"]{color:var(--pp-ok)}
      .pp-modal-status[data-state="error"]{color:var(--pp-danger)}
      .pp-modal-status[data-state="notice"]{color:var(--pp-strong)}
      .pp-modal-status[data-state="notice"]::before{content:'';flex:none;width:7px;height:7px;border-radius:50%;background:var(--pp-role)}
      .pp-modal-status[data-state="dirty"]::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--pp-warn)}
      .pp-modal-status>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      @media (max-width:760px){
        .pp-modal-back{padding:0}
        .pp-modal{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);width:100%;height:100%;border-radius:0}
        .pp-modal-summary{padding:12px 14px;border-right:0;border-bottom:1px solid var(--pp-line);max-height:58vh}
        .pp-modal-summary .pp-sum.panel{gap:10px}
        .pp-modal-summary .pp-sum.panel .pp-sum-head{grid-template-columns:auto minmax(0,1fr) auto;justify-items:start;align-items:center;text-align:left;gap:12px;padding-right:var(--pp-modal-actions-width,118px)}
        .pp-modal-summary .pp-sum.panel .pp-sum-edit{position:static;order:3}
        .pp-modal-summary .pp-sum.panel .pp-sum-id{justify-items:start}
        .pp-modal-summary .pp-sum.panel .pp-sum-pills{justify-content:flex-start}
        .pp-modal-summary .pp-sum.panel .pp-avatar{--pp-avatar:46px!important}
        .pp-modal-summary .pp-sum.panel .pp-sum-camera{font-size:13px}
        .pp-modal-summary:not(.expanded) .pp-sum-facts,.pp-modal-summary:not(.expanded) .pp-sum-sections,.pp-modal-summary:not(.expanded) .pp-modal-summary-extra{display:none}
        .pp-modal-summary-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;align-self:center;height:22px;margin:6px 0 -6px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--pp-muted);font-size:11px;font-weight:650;cursor:pointer}
        .pp-modal-summary-toggle>i{font-size:9px;transition:transform .16s ease}
        .pp-modal-summary.expanded .pp-modal-summary-toggle>i{transform:rotate(180deg)}
        .pp-modal-top{min-height:46px;padding:0 6px 0 8px}
        .pp-modal-actions{position:absolute;top:10px;right:8px}
        .pp-modal-panel{padding:12px 14px}
        .pp-modal-foot{padding:0 14px}
      }
      @media (prefers-reduced-motion:reduce){.pp-modal-back,.pp-modal,.pp-tab::after{transition:none}.pp-modal-panel{animation:none}}
    `;
    document.head.appendChild(style);
  }

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  let current = null;

  function open(options = {}){
    ensureStyles();
    current?.close(true);
    const tabs = (options.tabs || []).filter(Boolean);
    const opener = options.opener || document.activeElement;
    const back = document.createElement('div');
    back.className = 'pp pp-modal-back';
    back.dataset.settingsAutosave = 'off';
    const uid = `pp_modal_${Math.random().toString(36).slice(2, 8)}`;
    back.innerHTML = `<div class="pp-modal" role="dialog" aria-modal="true" aria-label="${esc(options.label || '')}">
      <aside class="pp-modal-summary"><div data-modal-summary></div><button type="button" class="pp-modal-summary-toggle" data-modal-summary-toggle aria-expanded="false"><span>${esc(t('details', 'Details'))}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></button></aside>
      <section class="pp-modal-main">
        <header class="pp-modal-top">
          <div class="pp-tabs" role="tablist" aria-label="${esc(options.label || '')}">${tabs.map((tab) => `<button type="button" class="pp-tab" role="tab" id="${uid}_tab_${esc(tab.id)}" aria-controls="${uid}_panel_${esc(tab.id)}" aria-selected="false" tabindex="-1" data-modal-tab="${esc(tab.id)}"${tip(tab.tooltip)}>${tab.icon ? `<i class="fas ${esc(tab.icon)}" aria-hidden="true"></i>` : ''}<span>${esc(tab.label)}</span><span class="pp-tab-badge" data-tab-badge></span></button>`).join('')}</div>
          <div class="pp-modal-actions" data-modal-actions></div>
        </header>
        <div class="pp-modal-panels">${tabs.map((tab) => `<div class="pp-modal-panel" role="tabpanel" id="${uid}_panel_${esc(tab.id)}" aria-labelledby="${uid}_tab_${esc(tab.id)}" data-modal-panel="${esc(tab.id)}" tabindex="-1" hidden></div>`).join('')}</div>
        <footer class="pp-modal-foot"><span class="pp-modal-status" role="status" aria-live="polite" data-state=""><span></span></span><button type="button" class="pp-btn quiet" data-modal-discard hidden>${esc(t('discard', 'Discard'))}</button><button type="button" class="pp-btn primary" data-modal-save disabled>${esc(t('save', 'Save'))}</button></footer>
      </section>
    </div>`;
    if (options.footer === false) back.querySelector('.pp-modal-foot').hidden = true;
    const dialog = back.querySelector('.pp-modal');
    const summaryHost = back.querySelector('[data-modal-summary]');
    const summaryColumn = back.querySelector('.pp-modal-summary');
    const actionsHost = back.querySelector('[data-modal-actions]');
    const statusEl = back.querySelector('.pp-modal-status');
    const saveButton = back.querySelector('[data-modal-save]');
    const discardButton = back.querySelector('[data-modal-discard]');
    const dirty = new Set();
    const handles = new Map();
    let activeTab = '';
    let closed = false;
    let saving = false;
    let statusTimer = 0;
    let actionList = [];

    const modal = {
      el:back,
      dialog,
      isDirty:() => dirty.size > 0,
      setDirty(id, value = true){
        if (value) dirty.add(id); else dirty.delete(id);
        syncFooter();
      },
      setStatus(state = '', text = ''){
        window.clearTimeout(statusTimer);
        statusEl.dataset.state = state;
        statusEl.firstElementChild.textContent = text;
        if (state === 'saved') statusTimer = window.setTimeout(() => { if (!dirty.size) modal.setStatus(); }, 2200);
      },
      setTabBadge(id, text){ const badge = back.querySelector(`[data-modal-tab="${CSS.escape(id)}"] [data-tab-badge]`); if (badge) badge.textContent = text ? String(text) : ''; },
      refreshSummary(){ options.summary?.(summaryHost, modal); kit.presence.paint(summaryHost); },
      refreshActions(){
        actionList = (typeof options.actions === 'function' ? options.actions(modal) : options.actions || []).filter(Boolean);
        actionsHost.innerHTML = `${actionList.map((action, index) => `<button type="button" class="pp-icon-btn ${action.tone === 'danger' ? 'danger' : ''}" data-modal-action="${index}" aria-label="${esc(action.label)}"${tip(action.label)} ${action.disabled ? 'disabled' : ''}><i class="fas ${esc(action.icon)}" aria-hidden="true"></i></button>`).join('')}${actionList.length ? '<span class="pp-modal-sep" aria-hidden="true"></span>' : ''}<button type="button" class="pp-icon-btn" data-modal-close aria-label="${esc(t('close', 'Close'))}"${tip(t('close', 'Close'))}><i class="fas fa-xmark" aria-hidden="true"></i></button>`;
      },
      selectTab(id, focus = false){
        const tab = tabs.find((entry) => entry.id === id) || tabs[0];
        if (!tab) return;
        activeTab = tab.id;
        back.querySelectorAll('[data-modal-tab]').forEach((button) => {
          const selected = button.dataset.modalTab === tab.id;
          button.setAttribute('aria-selected', String(selected));
          button.tabIndex = selected ? 0 : -1;
          if (selected && focus) button.focus();
          if (selected) button.scrollIntoView?.({ block:'nearest', inline:'nearest' });
        });
        back.querySelectorAll('[data-modal-panel]').forEach((panel) => { panel.hidden = panel.dataset.modalPanel !== tab.id; });
        const panel = back.querySelector(`[data-modal-panel="${CSS.escape(tab.id)}"]`);
        if (!handles.has(tab.id)) {
          let handle = null;
          try {
            handle = tab.mount?.(panel, { modal, setDirty:(value = true) => modal.setDirty(tab.id, value), setStatus:modal.setStatus }) || {};
          } catch (error) {
            panel.innerHTML = `<div class="pp-list-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`;
            handle = {};
          }
          handles.set(tab.id, handle);
        }
        handles.get(tab.id)?.show?.();
        options.onTab?.(tab.id, modal);
      },
      activeTab:() => activeTab,
      async save(){
        if (saving || !dirty.size) return false;
        saving = true;
        syncFooter();
        modal.setStatus('saving', t('saving', 'Saving…'));
        try {
          for (const [id, handle] of handles) {
            if (!dirty.has(id) || typeof handle?.save !== 'function') continue;
            try { await handle.save(); dirty.delete(id); }
            catch (notice) {
              /* A tab that owns its own save (a slot) may decline once, to show what the change would do. That is a message, not a failure:
                 the tab shows its own detail, the modal stays open and still dirty, and Save can be pressed again. */
              saving = false;
              syncFooter();
              modal.selectTab(id);
              modal.setStatus('notice', notice?.message || t('check_and_save_again', 'Check, then save again'));
              return false;
            }
          }
          if (typeof options.onSave === 'function') await options.onSave(modal);
          dirty.clear();
          saving = false;
          syncFooter();
          modal.setStatus('saved', t('saved', 'Saved'));
          return true;
        } catch (error) {
          saving = false;
          syncFooter();
          modal.setStatus('error', error?.message || t('save_failed', 'Could not save'));
          return false;
        }
      },
      async close(force = false){
        if (closed) return true;
        if (!force && dirty.size) {
          const leave = await kit.confirm(back.querySelector('[data-modal-close]') || saveButton, { title:t('discard_changes', 'Discard unsaved changes?'), confirmLabel:t('discard', 'Discard'), cancelLabel:t('keep_editing', 'Keep editing'), tone:'danger' });
          if (!leave) return false;
        }
        closed = true;
        window.clearTimeout(statusTimer);
        document.removeEventListener('keydown', onKey, true);
        handles.forEach((handle) => { try { handle?.destroy?.(); } catch (_) {} });
        back.classList.remove('open');
        window.setTimeout(() => back.remove(), 170);
        if (current === modal) current = null;
        const back2 = (typeof options.returnFocus === 'function' && options.returnFocus()) || (opener?.isConnected ? opener : null);
        back2?.focus?.({ preventScroll:true });
        options.onClose?.(modal);
        return true;
      }
    };
    function syncFooter(){
      const isDirty = dirty.size > 0;
      saveButton.disabled = !isDirty || saving;
      discardButton.hidden = !isDirty || saving || typeof options.onDiscard !== 'function';
      if (isDirty && !saving && !['error', 'notice'].includes(statusEl.dataset.state)) modal.setStatus('dirty', t('unsaved_changes', 'Unsaved changes'));
      else if (!isDirty && statusEl.dataset.state === 'dirty') modal.setStatus();
    }
    function onKey(event){
      if (closed || !back.isConnected) return;
      // An open menu or confirmation owns the keyboard until it closes.
      if (document.querySelector('.pp-layer')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); modal.close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(back.querySelectorAll(FOCUSABLE)).filter((node) => node.getClientRects().length && !node.closest('[hidden]'));
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!back.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    back.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-close]')) { modal.close(); return; }
      const action = event.target.closest('[data-modal-action]');
      if (action && !action.disabled) { actionList[Number(action.dataset.modalAction)]?.onClick?.(action, modal); return; }
      const tab = event.target.closest('[data-modal-tab]');
      if (tab) { modal.selectTab(tab.dataset.modalTab); return; }
      if (event.target.closest('[data-modal-save]')) { modal.save(); return; }
      if (event.target.closest('[data-modal-discard]')) { options.onDiscard?.(modal); return; }
      const toggle = event.target.closest('[data-modal-summary-toggle]');
      if (toggle) { const expanded = summaryColumn.classList.toggle('expanded'); toggle.setAttribute('aria-expanded', String(expanded)); }
    });
    let downOnBackdrop = false;
    back.addEventListener('pointerdown', (event) => { downOnBackdrop = event.target === back; });
    back.addEventListener('pointerup', (event) => { if (downOnBackdrop && event.target === back) modal.close(); downOnBackdrop = false; });
    back.querySelector('.pp-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      const index = tabs.findIndex((tab) => tab.id === activeTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      modal.selectTab(tabs[next].id, true);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(back);
    current = modal;
    modal.refreshSummary();
    modal.refreshActions();
    modal.selectTab(options.tab || tabs[0]?.id);
    dialog.tabIndex = -1;
    requestAnimationFrame(() => {
      back.classList.add('open');
      (back.querySelector('[data-modal-tab][aria-selected="true"]') || dialog).focus({ preventScroll:true });
    });
    return modal;
  }

  People.entityModal = { open, current:() => current, ensureStyles };
})();
