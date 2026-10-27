/* FirstMate select list (1M8-240): a styled, keyboard-accessible listbox in the app's menu style (the account switcher and
 * People menus) shown in place of a native <select>. The select stays in the form, hidden, as the submitted value and the
 * source of change events, so form code keeps reading and setting select.value.
 *
 *   const list = FirstMateSelectList.attach(select, {
 *     items: [{ value, label, badge, hint }],   // badge: a short code before the label; hint: muted text after it
 *     trigger: (item) => html,                  // optional: the closed button's content (default: badge and label)
 *     label: 'Country', compact: false          // compact: sized to its content (the calling code); else full width
 *   });
 *   list.sync()      // after setting select.value in code (a change event repaints by itself)
 *   list.setItems(items)
 */
(function (root) {
  'use strict';
  if (root.FirstMateSelectList) return;
  let sequence = 0;

  const CSS = `
    .fm-select-list{position:relative;display:flex;min-width:0}
    .fm-select-list.full{width:100%}
    .fm-select-list.compact{flex:0 0 auto}
    .fm-select-list-trigger{display:flex;align-items:center;gap:6px;width:100%;height:100%;min-height:40px;margin:0;padding:0 10px 0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#202124;font:inherit;font-size:14px;line-height:1.2;text-align:left;cursor:pointer;white-space:nowrap;box-sizing:border-box}
    .fm-select-list.compact .fm-select-list-trigger{width:auto}
    .fm-select-list-trigger:hover{border-color:#98a2b3}
    .fm-select-list-trigger:focus-visible{outline:2px solid rgba(26,115,232,.35);outline-offset:1px;border-color:#1a73e8}
    .fm-select-list-trigger[aria-expanded="true"]{border-color:#1a73e8}
    .fm-select-list-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .fm-select-list-placeholder{color:#80868b}
    .fm-select-list-badge{font-weight:700;letter-spacing:.02em}
    .fm-select-list-hint{color:#5f6368}
    .fm-select-list-chevron{flex:0 0 auto;width:10px;height:10px;color:#5f6368;transition:transform .15s ease}
    .fm-select-list-trigger[aria-expanded="true"] .fm-select-list-chevron{transform:rotate(180deg)}
    .fm-select-list-menu{position:absolute;z-index:2147483000;top:calc(100% + 6px);left:0;min-width:100%;max-height:300px;overflow:auto;margin:0;padding:6px;border:1px solid #dadce0;border-radius:12px;background:#fff;box-shadow:0 12px 34px rgba(60,64,67,.28);list-style:none;box-sizing:border-box;font-size:14px;color:#202124;text-align:left}
    .fm-select-list.compact .fm-select-list-menu{min-width:250px}
    .fm-select-list-menu[hidden]{display:none}
    .fm-select-list-option{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;line-height:1.25}
    .fm-select-list-option.has-badge{grid-template-columns:30px minmax(0,1fr) auto}
    .fm-select-list-option[aria-selected="true"]{background:#e8f0fe;color:#174ea6}
    .fm-select-list-option.active{background:#f1f3f4}
    .fm-select-list-option[aria-selected="true"].active{background:#d2e3fc}
    .fm-select-list-option[aria-disabled="true"]{display:none}
    .fm-select-list-option-badge{font-size:12px;font-weight:700;color:#5f6368}
    .fm-select-list-option[aria-selected="true"] .fm-select-list-option-badge{color:inherit}
    .fm-select-list-option-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fm-select-list-option-hint{color:#5f6368;font-variant-numeric:tabular-nums}
    @media (max-width:520px){.fm-select-list.compact .fm-select-list-menu{min-width:min(280px,calc(100vw - 32px))}}
  `;
  const CHEVRON = '<svg class="fm-select-list-chevron" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function injectStyles(node) {
    const scope = node.getRootNode?.();
    const host = typeof ShadowRoot !== 'undefined' && scope instanceof ShadowRoot ? scope : node.ownerDocument.head;
    if (host.querySelector?.('style[data-fm-select-list]')) return;
    const style = node.ownerDocument.createElement('style');
    style.setAttribute('data-fm-select-list', '');
    style.textContent = CSS;
    host.appendChild(style);
  }

  function attach(select, { items = null, trigger: triggerContent = null, label = '', compact = false, placeholder = '' } = {}) {
    const doc = select.ownerDocument;
    const id = 'fm-select-list-' + (++sequence);
    injectStyles(select);
    // Measure the select's own look before it is hidden, so the button matches the host form's controls.
    let look = null;
    try {
      const box = select.getBoundingClientRect(), style = root.getComputedStyle(select);
      look = { height: box.height, radius: style.borderRadius, font: style.fontFamily, size: style.fontSize };
    } catch (_) {}

    const wrap = doc.createElement('div'); wrap.className = 'fm-select-list ' + (compact ? 'compact' : 'full');
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'fm-select-list-trigger'; button.id = id + '-trigger';
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id + '-menu');
    if (look) {
      if (look.height > 0) button.style.height = look.height + 'px';
      if (look.radius) button.style.borderRadius = look.radius;
      if (look.font) button.style.fontFamily = look.font;
      if (look.size && !compact) button.style.fontSize = look.size;
    }
    const menu = doc.createElement('ul');
    menu.className = 'fm-select-list-menu'; menu.id = id + '-menu'; menu.setAttribute('role', 'listbox'); menu.tabIndex = -1; menu.hidden = true;
    if (label) { menu.setAttribute('aria-label', label); }
    wrap.append(button, menu);
    select.after(wrap);
    select.hidden = true; select.style.display = 'none'; select.tabIndex = -1;
    // A <label for> pointing at the select now focuses the button.
    if (select.id) {
      const scope = select.getRootNode?.() || doc;
      scope.querySelectorAll?.(`label[for="${select.id}"]`).forEach((element) => { element.htmlFor = button.id; });
    }

    let list = [], active = '';
    const fromSelect = () => [...select.options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
    const item = (value) => list.find((entry) => entry.value === value);
    const optionNodes = () => [...menu.querySelectorAll('[role="option"]')];
    const usable = () => list.filter((entry) => !entry.disabled);
    function renderMenu() {
      menu.innerHTML = list.map((entry) => `<li class="fm-select-list-option${entry.badge ? ' has-badge' : ''}" role="option" id="${id}-${esc(entry.value)}" data-value="${esc(entry.value)}" aria-selected="false"${entry.disabled ? ' aria-disabled="true"' : ''}>${entry.badge ? `<span class="fm-select-list-option-badge">${esc(entry.badge)}</span>` : ''}<span class="fm-select-list-option-label">${esc(entry.label)}</span><span class="fm-select-list-option-hint">${esc(entry.hint || '')}</span></li>`).join('');
    }
    function sync() {
      const current = item(select.value);
      const content = current && !current.disabled
        ? (triggerContent ? triggerContent(current) : `${current.badge ? `<span class="fm-select-list-badge">${esc(current.badge)}</span>` : ''}<span class="fm-select-list-value">${esc(current.label)}</span>`)
        : `<span class="fm-select-list-value fm-select-list-placeholder">${esc(placeholder || item('')?.label || '')}</span>`;
      button.innerHTML = content + CHEVRON;
      button.setAttribute('aria-label', [label, current && !current.disabled ? [current.label, current.hint].filter(Boolean).join(' ') : ''].filter(Boolean).join(': '));
      optionNodes().forEach((node) => node.setAttribute('aria-selected', String(node.dataset.value === select.value)));
    }
    function setItems(next) {
      list = (next || fromSelect()).map((entry) => ({ ...entry, value: String(entry.value) }));
      renderMenu(); sync();
    }
    function paintActive(scroll = true) {
      optionNodes().forEach((node) => node.classList.toggle('active', node.dataset.value === active));
      const node = menu.querySelector(`[data-value="${CSS_escape(active)}"]`);
      if (node) { menu.setAttribute('aria-activedescendant', node.id); if (scroll) node.scrollIntoView?.({ block: 'nearest' }); }
    }
    function open() {
      if (!menu.hidden) return;
      menu.hidden = false; button.setAttribute('aria-expanded', 'true');
      active = item(select.value) && !item(select.value).disabled ? select.value : (usable()[0]?.value || '');
      paintActive(); menu.focus({ preventScroll: true });
    }
    function close(focusButton = true) {
      if (menu.hidden) return;
      menu.hidden = true; button.setAttribute('aria-expanded', 'false');
      if (focusButton) button.focus({ preventScroll: true });
    }
    function choose(value) {
      close();
      const entry = item(value);
      if (!entry || entry.disabled || value === select.value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    button.addEventListener('click', () => (menu.hidden ? open() : close()));
    button.addEventListener('keydown', (event) => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); } });
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => { const node = event.target.closest?.('[role="option"]'); if (node) choose(node.dataset.value); });
    menu.addEventListener('mousemove', (event) => { const node = event.target.closest?.('[role="option"]'); if (node && node.dataset.value !== active) { active = node.dataset.value; paintActive(false); } });
    let typed = '', typedAt = 0;
    menu.addEventListener('keydown', (event) => {
      const values = usable().map((entry) => entry.value), at = Math.max(0, values.indexOf(active));
      if (event.key === 'ArrowDown') { active = values[Math.min(values.length - 1, at + 1)]; paintActive(); }
      else if (event.key === 'ArrowUp') { active = values[Math.max(0, at - 1)]; paintActive(); }
      else if (event.key === 'Home') { active = values[0]; paintActive(); }
      else if (event.key === 'End') { active = values[values.length - 1]; paintActive(); }
      else if (event.key === 'Enter' || event.key === ' ') choose(active);
      else if (event.key === 'Escape') close();
      else if (event.key === 'Tab') close(false);
      else if (event.key.length === 1 && /\S/.test(event.key)) {
        typed = (Date.now() - typedAt < 700 ? typed : '') + event.key.toLowerCase(); typedAt = Date.now();
        const match = usable().find((entry) => String(entry.label).toLowerCase().startsWith(typed)) || usable().find((entry) => String(entry.badge || '').toLowerCase().startsWith(typed));
        if (match) { active = match.value; paintActive(); }
      } else return;
      event.preventDefault();
    });
    menu.addEventListener('focusout', (event) => { if (!wrap.contains(event.relatedTarget)) close(false); });
    doc.addEventListener('mousedown', (event) => { if (!event.composedPath().includes(wrap)) close(false); });
    select.addEventListener('change', sync);
    setItems(items);
    return { wrap, button, menu, sync, setItems, open, close, select };
  }
  const CSS_escape = (value) => (root.CSS?.escape ? root.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

  root.FirstMateSelectList = { attach };
})(globalThis);
