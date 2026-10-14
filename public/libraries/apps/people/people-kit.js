/* public/libraries/apps/people/people-kit.js
 *
 * People kit: the small shared vocabulary every People surface is built from.
 *
 *   FirstMatePeople.kit
 *     esc(value)                         HTML escape
 *     t(key, fallback, values)           localized text ({name} placeholders in the fallback)
 *     term(key, fallback)                terminology lookup (what an organization calls a thing)
 *     tip(text)                          ` data-fm-tooltip="..."` attribute; every explanation lives here
 *     toast(title, message, ok)          platform toast
 *     countPhrase(parts)                 "42 users, 3 never signed in" from [[42,'user','users'],[3,'never signed in']]
 *     avatar(entity, options)            photo or initials; options: size, online (user id), square
 *     chip(chip)                         { label, tone, color, icon, tooltip }
 *     chips(list, options)               a truncated run of chips with a "+N" overflow chip; options: max
 *     pill(pill)                         { label, tone, icon, tooltip }
 *     summary(model, variant)            the one summary of an entity: 'panel' (modal column) or 'card' (hover)
 *     menu(anchor, options)              popover menu; returns { close() }
 *     confirm(anchor, options)           anchored confirmation; resolves true or false
 *     form(anchor, options)              small anchored form (text fields, dropdowns and toggle chips); resolves its values or null
 *     select(options)                    the one dropdown (types are always picked from one)
 *     stack(entities, total)             overlapping photos and a count
 *     info(text)                         an "i" whose tooltip carries an explanation
 *     presence.watch(orgId)              keeps every [data-people-online] dot current; returns stop()
 *
 * Design rules these pieces enforce: the only exposed strings are titles, every
 * explanation is a tooltip, color and icons mean the same thing everywhere
 * (see TONES and ICONS below).
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.kit) return;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match]));
  const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (match, name) => (values && values[name] != null ? String(values[name]) : match));
  const t = (key, fallback, values) => {
    const readable = fill(fallback, values);
    return globalThis.PlatformLanguage?.text?.('people', key, readable, values) ?? readable;
  };
  const term = (key, fallback) => window.Portal?.terminology?.get?.(key, fallback) || window.PlatformTerminology?.get?.(key, fallback) || fallback;
  const tip = (text) => (text ? ` data-fm-tooltip="${esc(text)}"` : '');
  const toast = (title, message, ok = true) => { try { window.Portal?.ui?.showToast?.(title, message, ok); } catch (_) {} };

  /* One meaning per icon and per tone, everywhere in People. */
  const ICONS = Object.freeze({
    user:'fa-user', users:'fa-users', group:'fa-user-group', department:'fa-sitemap', company:'fa-building',
    role:'fa-id-badge', permissions:'fa-key', apps:'fa-table-cells-large', compensation:'fa-money-bill-wave', fields:'fa-list-check',
    invite:'fa-paper-plane', suspend:'fa-pause', resume:'fa-play', remove:'fa-trash', edit:'fa-pen', search:'fa-magnifying-glass',
    inherited:'fa-arrow-turn-down', allow:'fa-check', deny:'fa-xmark', email:'fa-envelope', phone:'fa-phone', clock:'fa-clock', desktop:'fa-desktop', mobile:'fa-mobile-screen-button'
  });
  const TONES = Object.freeze(['neutral', 'role', 'group', 'ok', 'warn', 'danger', 'muted']);

  function countPhrase(parts){
    return (parts || []).filter((part, index) => part && (index === 0 || Number(part[0]) > 0))
      .map((part) => `${Number(part[0]).toLocaleString()} ${Number(part[0]) === 1 || part[2] == null ? part[1] : part[2]}`).join(', ');
  }

  function initials(name){
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }
  function hue(seed){
    let hash = 0;
    for (const char of String(seed || '')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }
  function avatar(entity = {}, options = {}){
    const size = Number(options.size || 30);
    const name = entity.name || entity.email || '';
    const photo = entity.photoUrl || '';
    const dot = options.online ? `<span class="pp-online" data-people-online="${esc(options.online)}" role="img" hidden></span>` : '';
    const body = photo
      ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async">`
      : entity.icon ? `<i class="fas ${esc(entity.icon)}" aria-hidden="true"></i>` : `<span aria-hidden="true">${esc(initials(name))}</span>`;
    return `<span class="pp-avatar${options.square ? ' square' : ''}" style="--pp-avatar:${size}px;--pp-hue:${hue(entity.id || name)}${entity.color ? `;--pp-avatar-bg:${esc(entity.color)}` : ''}">${body}${dot}</span>`;
  }
  function chip(item = {}){
    const tone = TONES.includes(item.tone) ? item.tone : 'neutral';
    const lead = item.color ? `<i class="pp-chip-dot" style="background:${esc(item.color)}" aria-hidden="true"></i>` : item.icon ? `<i class="fas ${esc(item.icon)}" aria-hidden="true"></i>` : '';
    return `<span class="pp-chip ${tone}${item.color ? ' dot' : ''}"${tip(item.tooltip)}>${lead}<span>${esc(item.label)}</span></span>`;
  }
  function chips(list = [], options = {}){
    const max = Math.max(1, Number(options.max || 2));
    const shown = list.slice(0, max);
    const rest = list.slice(shown.length);
    const more = rest.length ? `<span class="pp-chip more ${TONES.includes(options.tone) ? options.tone : 'muted'}"${tip(rest.map((item) => item.label).join(', '))}>+${rest.length}</span>` : '';
    return shown.map(chip).join('') + more;
  }
  function pill(item = {}){
    const tone = TONES.includes(item.tone) ? item.tone : 'neutral';
    return `<span class="pp-pill ${tone}"${tip(item.tooltip)}>${item.icon ? `<i class="fas ${esc(item.icon)}" aria-hidden="true"></i>` : ''}${esc(item.label)}</span>`;
  }

  /*
   * summary(model, variant)
   *
   * model = {
   *   kind, id, name, secondary, photoUrl, icon, color,
   *   online: userId | '',                 presence dot on the photo
   *   pills: [{ label, tone, icon, tooltip }],
   *   facts: [{ icon, label, value, tooltip }],
   *   sections: [{ id, title, icon, tone, chips:[chip], empty, action:{ id, icon, label } }]
   * }
   * variant 'panel' is the modal's left column (photo, identity, facts, sections with titles);
   * 'card' is the read-only hover card (photo, identity, the facts and chips that matter).
   * options.photoAction adds a camera overlay button (data-people-photo) on the panel photo (options.photoIcon changes its glyph);
   *   options.editAction adds a pencil (data-people-identity). A fact with panel:false is left out of the panel
   *   (its tab shows it), one with card:false out of the card.
   */
  function summary(model = {}, variant = 'panel', options = {}){
    const card = variant === 'card';
    const photo = avatar(model, { size:card ? 44 : 76, online:model.online, square:model.kind && model.kind !== 'organization_user' });
    const photoHtml = !card && options.photoAction
      ? `<button type="button" class="pp-sum-photo" data-people-photo aria-label="${esc(options.photoAction)}"${tip(options.photoAction)}>${photo}<span class="pp-sum-camera" aria-hidden="true"><i class="fas ${esc(options.photoIcon || 'fa-camera')}"></i></span></button>`
      : `<span class="pp-sum-photo">${photo}</span>`;
    const pills = (model.pills || []).map(pill).join('');
    const facts = (model.facts || []).filter((fact) => fact && fact.value && (card ? fact.card !== false : fact.panel !== false)).slice(0, card ? 3 : 12).map((fact) => card
      ? `<div class="pp-sum-fact"><i class="fas ${esc(fact.icon || 'fa-circle')}" aria-hidden="true"></i>${fact.cardLabel ? `<em>${esc(fact.label)}</em>` : ''}<span>${esc(fact.value)}</span></div>`
      : `<div class="pp-sum-fact"${tip(fact.tooltip)}><i class="fas ${esc(fact.icon || 'fa-circle')}" aria-hidden="true"></i><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('');
    const sections = (model.sections || []).filter((section) => section && (!card || (section.chips || []).length)).map((section) => {
      const list = section.chips || [];
      const body = list.length ? (card ? chips(list, { max:4 }) : list.map(chip).join('')) : (section.optional || (!card && section.action)) ? '' : `<span class="pp-sum-empty">${esc(section.empty || '—')}</span>`;
      const action = !card && section.action ? `<button type="button" class="pp-icon-btn" data-people-section-action="${esc(section.id)}" aria-label="${esc(section.action.label)}"${tip(section.action.label)}><i class="fas ${esc(section.action.icon || ICONS.edit)}" aria-hidden="true"></i></button>` : '';
      return card
        ? `<div class="pp-sum-section" data-section="${esc(section.id)}"${tip(section.title)}><i class="fas ${esc(section.icon || 'fa-circle')} pp-sum-section-icon" aria-hidden="true"></i><div class="pp-chip-run wrap">${body}</div></div>`
        : `<section class="pp-sum-section" data-section="${esc(section.id)}"><header><i class="fas ${esc(section.icon || 'fa-circle')}" aria-hidden="true"></i><h4${tip(section.tooltip)}>${esc(section.title)}</h4>${action}</header><div class="pp-chip-run wrap">${body}</div></section>`;
    }).join('');
    const editAction = !card && options.editAction ? `<button type="button" class="pp-icon-btn pp-sum-edit" data-people-identity aria-label="${esc(options.editAction)}"${tip(options.editAction)}><i class="fas ${ICONS.edit}" aria-hidden="true"></i></button>` : '';
    return `<div class="pp-sum ${card ? 'card' : 'panel'}" data-people-summary="${esc(model.kind || '')}:${esc(model.id || '')}">
      <div class="pp-sum-head">${photoHtml}${editAction}<div class="pp-sum-id"><strong class="pp-sum-name">${esc(model.name || '')}</strong>${model.secondary ? `<span class="pp-sum-secondary">${esc(model.secondary)}</span>` : ''}${pills ? `<div class="pp-sum-pills">${pills}</div>` : ''}</div></div>
      ${facts ? (card ? `<div class="pp-sum-facts">${facts}</div>` : `<dl class="pp-sum-facts">${facts}</dl>`) : ''}
      ${sections ? `<div class="pp-sum-sections">${sections}</div>` : ''}
    </div>`;
  }

  /* select({ name, value, options:[{ value, label }], placeholder, label, attrs }): the one dropdown. Types are always picked from one. */
  function select(options = {}){
    const list = options.options || [];
    return `<span class="pp-select"><select class="pp-input" ${options.name ? `name="${esc(options.name)}"` : ''} aria-label="${esc(options.label || options.placeholder || '')}" ${options.attrs || ''} ${options.disabled ? 'disabled' : ''}>${options.placeholder != null ? `<option value="">${esc(options.placeholder)}</option>` : ''}${list.map((item) => `<option value="${esc(item.value)}" ${String(item.value) === String(options.value ?? '') ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select><i class="fas fa-chevron-down" aria-hidden="true"></i></span>`;
  }
  /* stack(entities, total): overlapping photos with the count beside them, for "who is in this". */
  function stack(entities = [], total){
    const shown = entities.slice(0, 4);
    const count = Number(total ?? entities.length);
    return `<span class="pp-stack">${shown.map((entity) => avatar(entity, { size:22 })).join('')}<span class="pp-stack-count">${count.toLocaleString()}</span></span>`;
  }
  /* info(text): a small focusable "i" whose tooltip carries a sentence the screen itself must not spell out. */
  const info = (text) => `<button type="button" class="pp-info" aria-label="${esc(text)}"${tip(text)}><i class="fas fa-circle-info" aria-hidden="true"></i></button>`;

  /* Popovers live inside the open modal when there is one, so its focus trap covers them. */
  const layerHost = (anchor) => anchor?.closest?.('.pp-modal-back') || document.body;
  function place(panel, anchor, align = 'start'){
    const rect = anchor.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const pad = 8;
    let left = align === 'end' ? rect.right - box.width : rect.left;
    left = Math.max(pad, Math.min(left, window.innerWidth - box.width - pad));
    let top = rect.bottom + 6;
    if (top + box.height > window.innerHeight - pad && rect.top - box.height - 6 >= pad) top = rect.top - box.height - 6;
    top = Math.max(pad, Math.min(top, window.innerHeight - box.height - pad));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }
  let openLayer = null;
  function layer(anchor, panel, options = {}){
    openLayer?.close();
    panel.classList.add('pp', 'pp-layer');
    panel.dataset.settingsAutosave = 'off';
    layerHost(anchor).appendChild(panel);
    place(panel, anchor, options.align);
    requestAnimationFrame(() => panel.classList.add('open'));
    const previous = document.activeElement;
    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      panel.remove();
      anchor.setAttribute?.('aria-expanded', 'false');
      if (openLayer === handle) openLayer = null;
      if (options.restoreFocus !== false && previous?.isConnected && result !== 'outside') previous.focus?.();
      options.onClose?.(result);
    };
    const onDown = (event) => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close('outside'); };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close('escape'); }
      else options.onKey?.(event);
    };
    const onMove = (event) => { if (anchor.isConnected && (!event?.target || !panel.contains(event.target))) place(panel, anchor, options.align); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    anchor.setAttribute?.('aria-expanded', 'true');
    const handle = { close, panel };
    openLayer = handle;
    return handle;
  }

  /*
   * menu(anchor, options) -> { close() }
   *   items: [{ id, label, icon, color, tone, checked (true|false for a checkbox item), disabled, tooltip, hint, separator:true, heading:'Title' }]
   *   onSelect(item, { close, setChecked(id, bool) })   return false (or use checkbox items) to keep the menu open
   *   search: placeholder text to add a filter field
   *   align: 'start' | 'end'
   *   label: accessible name
   */
  function menu(anchor, options = {}){
    const panel = document.createElement('div');
    panel.className = 'pp-menu';
    const items = (options.items || []).filter(Boolean);
    const rowHtml = (item, index) => {
      if (item.separator) return '<div class="pp-menu-sep" role="separator"></div>';
      if (item.heading) return `<div class="pp-menu-heading">${esc(item.heading)}</div>`;
      const checkbox = typeof item.checked === 'boolean';
      const lead = checkbox
        ? `<span class="pp-menu-check" aria-hidden="true"><i class="fas fa-check"></i></span>`
        : item.color ? `<i class="pp-chip-dot" style="background:${esc(item.color)}" aria-hidden="true"></i>` : item.icon ? `<i class="fas ${esc(item.icon)} pp-menu-icon" aria-hidden="true"></i>` : '';
      return `<button type="button" class="pp-menu-item ${esc(item.tone || '')}" role="${checkbox ? 'menuitemcheckbox' : 'menuitem'}" ${checkbox ? `aria-checked="${item.checked}"` : ''} data-menu-index="${index}" tabindex="-1" ${item.disabled ? 'disabled aria-disabled="true"' : ''}${tip(item.tooltip)}>${lead}<span class="pp-menu-label">${esc(item.label)}</span>${item.hint ? `<span class="pp-menu-hint">${esc(item.hint)}</span>` : ''}</button>`;
    };
    panel.innerHTML = `${options.search ? `<label class="pp-menu-search"><i class="fas ${ICONS.search}" aria-hidden="true"></i><input type="search" placeholder="${esc(options.search)}" aria-label="${esc(options.search)}" autocomplete="off"></label>` : ''}<div class="pp-menu-list" role="menu" aria-label="${esc(options.label || '')}">${items.map(rowHtml).join('')}</div>`;
    const list = panel.querySelector('.pp-menu-list');
    const input = panel.querySelector('input');
    const buttons = () => Array.from(list.querySelectorAll('.pp-menu-item:not([disabled]):not([hidden])'));
    const focusAt = (index) => { const all = buttons(); if (all.length) all[(index + all.length) % all.length].focus(); };
    const handle = layer(anchor, panel, {
      align:options.align,
      onClose:options.onClose,
      onKey(event){
        const all = buttons();
        const current = all.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(current + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); if (current <= 0 && input) input.focus(); else focusAt(current - 1); }
        else if (event.key === 'Home' && document.activeElement !== input) { event.preventDefault(); focusAt(0); }
        else if (event.key === 'End' && document.activeElement !== input) { event.preventDefault(); focusAt(all.length - 1); }
        else if (event.key === 'Tab') { event.preventDefault(); handle.close('tab'); }
      }
    });
    const controls = {
      close:() => handle.close('select'),
      setChecked(id, checked){
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return;
        items[index].checked = !!checked;
        list.querySelector(`[data-menu-index="${index}"]`)?.setAttribute('aria-checked', String(!!checked));
      }
    };
    list.addEventListener('click', (event) => {
      const button = event.target.closest('.pp-menu-item');
      if (!button || button.disabled) return;
      const item = items[Number(button.dataset.menuIndex)];
      const checkbox = typeof item.checked === 'boolean';
      const result = options.onSelect?.(item, controls);
      if (!checkbox && result !== false) handle.close('select');
    });
    input?.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      list.querySelectorAll('.pp-menu-item').forEach((button) => {
        const item = items[Number(button.dataset.menuIndex)];
        button.hidden = !!query && !String(item.label).toLowerCase().includes(query);
      });
      place(panel, anchor, options.align);
    });
    if (input) input.focus(); else focusAt(0);
    return { close:() => handle.close('api') };
  }

  /* confirm(anchor, { title, confirmLabel, cancelLabel, tone:'danger' }) -> Promise<boolean> */
  function confirm(anchor, options = {}){
    return new Promise((resolve) => {
      const panel = document.createElement('div');
      panel.className = 'pp-confirm';
      panel.setAttribute('role', 'alertdialog');
      panel.setAttribute('aria-label', options.title || '');
      panel.innerHTML = `<strong>${esc(options.title || '')}</strong><div class="pp-confirm-actions"><button type="button" class="pp-btn" data-confirm="no">${esc(options.cancelLabel || t('cancel', 'Cancel'))}</button><button type="button" class="pp-btn ${options.tone === 'danger' ? 'danger' : 'primary'}" data-confirm="yes">${esc(options.confirmLabel || t('confirm', 'Confirm'))}</button></div>`;
      let answered = false;
      const handle = layer(anchor, panel, {
        align:options.align || 'end',
        onClose(){ if (!answered) resolve(false); },
        onKey(event){
          if (event.key !== 'Tab') return;
          const [no, yes] = panel.querySelectorAll('button');
          event.preventDefault();
          (document.activeElement === no ? yes : no).focus();
        }
      });
      panel.addEventListener('click', (event) => {
        const button = event.target.closest('[data-confirm]');
        if (!button) return;
        answered = true;
        resolve(button.dataset.confirm === 'yes');
        handle.close('select');
      });
      panel.querySelector('[data-confirm="no"]').focus();
    });
  }

  /*
   * form(anchor, options) -> Promise<values | null>     a small anchored form (invite, new role)
   *   title, submitLabel, submitIcon, align
   *   fields: [{ id, label, type:'text'|'email'|'select'|'photo', value, required, autocomplete, options:[{ value, label }], placeholder }]
   *   choices: { id, label, items:[{ id, label, tooltip }], value:[ids], min }     toggle chips, several allowed
   *   submit: async (values) => result   runs before closing; a thrown error is shown and the form stays open
   */
  function form(anchor, options = {}){
    return new Promise((resolve) => {
      const panel = document.createElement('form');
      panel.className = 'pp-form';
      panel.noValidate = true;
      panel.setAttribute('aria-label', options.title || '');
      const fields = options.fields || [];
      const choices = options.choices;
      const chosen = new Set(choices?.value || []);
      panel.innerHTML = `<strong class="pp-form-title">${esc(options.title || '')}</strong>
        ${fields.map((field) => field.type === 'select'
          ? `<label class="pp-field"><span>${esc(field.label)}</span>${select({ name:field.id, value:field.value, options:field.options, placeholder:field.placeholder, label:field.label })}</label>`
          : field.type === 'photo'
            ? `<label class="pp-field pp-field-photo"><span>${esc(field.label)}</span><span class="pp-photo-pick"><span class="pp-avatar" style="--pp-avatar:34px;--pp-hue:210" data-photo-preview><i class="fas fa-camera" aria-hidden="true"></i></span><input type="file" name="${esc(field.id)}" accept="image/png,image/jpeg,image/webp"></span></label>`
          : `<label class="pp-field"><span>${esc(field.label)}</span><input type="${esc(field.type || 'text')}" name="${esc(field.id)}" value="${esc(field.value || '')}" autocomplete="${esc(field.autocomplete || 'off')}" ${field.required ? 'required' : ''} spellcheck="false"></label>`).join('')}
        ${choices ? `<div class="pp-field" role="group" aria-label="${esc(choices.label)}"><span>${esc(choices.label)}</span><div class="pp-choice-run">${choices.items.map((item) => `<button type="button" class="pp-choice" data-choice-id="${esc(item.id)}" aria-pressed="${chosen.has(item.id)}"${tip(item.tooltip)}>${esc(item.label)}</button>`).join('')}</div></div>` : ''}
        <div class="pp-form-foot"><span class="pp-form-error" role="alert"></span><button type="button" class="pp-btn quiet" data-form-cancel>${esc(t('cancel', 'Cancel'))}</button><button type="submit" class="pp-btn primary">${options.submitIcon ? `<i class="fas ${esc(options.submitIcon)}" aria-hidden="true"></i>` : ''}${esc(options.submitLabel || t('save', 'Save'))}</button></div>`;
      let done = false;
      const errorEl = panel.querySelector('.pp-form-error');
      const submitButton = panel.querySelector('[type="submit"]');
      const handle = layer(anchor, panel, {
        align:options.align || 'end',
        onClose(){ if (!done) resolve(null); },
        onKey(event){
          if (event.key !== 'Tab') return;
          const focusable = Array.from(panel.querySelectorAll('input,select,button:not([disabled])'));
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); event.stopPropagation(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); event.stopPropagation(); first.focus(); }
        }
      });
      panel.addEventListener('click', (event) => {
        const choice = event.target.closest('[data-choice-id]');
        if (choice) {
          const id = choice.dataset.choiceId;
          if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
          choice.setAttribute('aria-pressed', String(chosen.has(id)));
          return;
        }
        if (event.target.closest('[data-form-cancel]')) handle.close('cancel');
      });
      panel.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(fields.map((field) => [field.id, field.type === 'photo' ? (panel.elements[field.id]?.files?.[0] || null) : String(panel.elements[field.id]?.value || '').trim()]));
        if (choices) values[choices.id] = [...chosen];
        const missing = fields.find((field) => field.required && !values[field.id]);
        const badEmail = fields.find((field) => field.type === 'email' && values[field.id] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values[field.id]));
        if (missing || badEmail) {
          errorEl.textContent = missing ? t('field_required', '{field} is required', { field:missing.label }) : t('email_invalid', 'Enter a valid email.');
          panel.elements[(missing || badEmail).id]?.focus();
          return;
        }
        if (choices?.min && chosen.size < choices.min) { errorEl.textContent = t('choose_one', 'Choose at least one'); return; }
        submitButton.disabled = true;
        errorEl.textContent = '';
        try {
          const result = typeof options.submit === 'function' ? await options.submit(values) : values;
          done = true;
          resolve(result === undefined ? values : result);
          handle.close('select');
        } catch (error) {
          submitButton.disabled = false;
          errorEl.textContent = error?.message || t('save_failed', 'Could not save');
        }
      });
      panel.addEventListener('input', () => { errorEl.textContent = ''; });
      panel.addEventListener('change', (event) => {
        const file = event.target.matches?.('input[type="file"]') ? event.target.files?.[0] : null;
        const preview = file ? event.target.closest('.pp-photo-pick')?.querySelector('[data-photo-preview]') : null;
        if (preview) { const url = URL.createObjectURL(file); preview.innerHTML = `<img src="${url}" alt="">`; }
      });
      panel.querySelector('input,select')?.focus();
    });
  }

  /*
   * Presence. One watch per organization, shared by every People surface, on the
   * platform's own realtime channel (PlatformRealtime.watchPresence). No stream
   * is opened here. Dots are plain markup: <span data-people-online="<user id>">.
   */
  const presence = (() => {
    let online = new Map();
    let stop = null;
    let watchers = 0;
    let watchedOrg = '';
    const listeners = new Set();
    const label = (status) => status === 'active' ? t('online', 'Online') : status === 'away' ? t('away', 'Away') : t('offline', 'Offline');
    const paint = (root = document) => root.querySelectorAll('[data-people-online]').forEach((dot) => {
      const status = online.get(dot.dataset.peopleOnline) || '';
      dot.hidden = !status;
      dot.dataset.status = status;
      dot.setAttribute('aria-label', label(status));
      dot.setAttribute('data-fm-tooltip', label(status));
    });
    function watch(orgId){
      watchers += 1;
      if ((!stop || watchedOrg !== orgId) && window.PlatformRealtime?.watchPresence) {
        stop?.();
        watchedOrg = orgId;
        stop = window.PlatformRealtime.watchPresence(orgId, 'online', (users) => {
          online = new Map((users || []).map((user) => [String(user.user_id), user.status || 'active']));
          paint();
          listeners.forEach((listener) => { try { listener(online); } catch (_) {} });
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers -= 1;
        if (watchers <= 0) { watchers = 0; stop?.(); stop = null; watchedOrg = ''; online = new Map(); }
      };
    }
    return { watch, paint, status:(userId) => online.get(String(userId)) || '', onChange(listener){ listeners.add(listener); return () => listeners.delete(listener); } };
  })();

  function ensureStyles(){
    if (document.getElementById('pp_kit_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_kit_css';
    style.textContent = `
      .pp{--pp-text:#101828;--pp-strong:#344054;--pp-muted:#667085;--pp-faint:#98a2b3;--pp-line:#e4e7ec;--pp-line-soft:#eef0f3;--pp-soft:#f8fafc;--pp-hover:#f2f4f7;--pp-panel:#fff;
        --pp-accent:var(--primary-readable,var(--primary,#d93025));--pp-accent-rgb:var(--primary-rgb,217,48,37);--pp-on-accent:var(--on-primary,#fff);
        --pp-role:#3538cd;--pp-role-bg:#eef4ff;--pp-role-line:#c7d7fe;--pp-group:#0e7090;--pp-group-bg:#ecfdff;--pp-group-line:#a5f0fc;
        --pp-ok:#067647;--pp-ok-bg:#ecfdf3;--pp-ok-line:#abefc6;--pp-warn:#b54708;--pp-warn-bg:#fffaeb;--pp-warn-line:#fedf89;--pp-danger:#b42318;--pp-danger-bg:#fef3f2;--pp-danger-line:#fecdca;
        --pp-online:#16a34a;--pp-away:#98a2b3;--pp-radius:10px;--pp-shadow:0 12px 32px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.06);
        color:var(--pp-text);font-family:inherit;font-size:13px;line-height:1.35;box-sizing:border-box}
      .pp *,.pp *::before,.pp *::after{box-sizing:border-box}
      .pp button{font-family:inherit}
      .pp [hidden]{display:none!important}
      .pp :focus-visible{outline:2px solid var(--pp-accent);outline-offset:2px}
      .pp input:focus-visible,.pp textarea:focus-visible{outline:0}

      .pp-avatar{position:relative;display:inline-grid;place-items:center;flex:none;width:var(--pp-avatar,30px);height:var(--pp-avatar,30px);border-radius:50%;background:var(--pp-avatar-bg,hsl(var(--pp-hue,210) 55% 92%));color:hsl(var(--pp-hue,210) 45% 32%);font-size:calc(var(--pp-avatar,30px)*.38);font-weight:700;letter-spacing:.01em;user-select:none}
      .pp-avatar.square{border-radius:calc(var(--pp-avatar,30px)*.28)}
      .pp-avatar[style*="--pp-avatar-bg"]{color:#fff}
      .pp-avatar>img{width:100%;height:100%;border-radius:inherit;object-fit:cover;display:block}
      .pp-online{position:absolute;right:-1px;bottom:-1px;width:clamp(9px,calc(var(--pp-avatar,30px)*.26),15px);height:clamp(9px,calc(var(--pp-avatar,30px)*.26),15px);border-radius:50%;background:var(--pp-online);box-shadow:0 0 0 2px var(--pp-panel)}
      .pp-online[data-status="away"]{background:var(--pp-away)}

      .pp-chip{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:150px;height:20px;padding:0 7px;border:1px solid var(--pp-line);border-radius:6px;background:var(--pp-panel);color:var(--pp-strong);font-size:11px;font-weight:600;line-height:1;white-space:nowrap}
      .pp-chip>span{overflow:hidden;text-overflow:ellipsis;line-height:1.5}
      .pp-chip>i.fas{font-size:9px;opacity:.8}
      .pp-chip-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--pp-faint)}
      .pp-chip.dot{padding:0 2px;border-color:transparent;background:transparent;font-weight:600}
      .pp-chip.role{border-color:var(--pp-role-line);background:var(--pp-role-bg);color:var(--pp-role)}
      .pp-chip.group{border-color:var(--pp-group-line);background:var(--pp-group-bg);color:var(--pp-group)}
      .pp-chip.ok{border-color:var(--pp-ok-line);background:var(--pp-ok-bg);color:var(--pp-ok)}
      .pp-chip.warn{border-color:var(--pp-warn-line);background:var(--pp-warn-bg);color:var(--pp-warn)}
      .pp-chip.danger{border-color:var(--pp-danger-line);background:var(--pp-danger-bg);color:var(--pp-danger)}
      .pp-chip.muted{background:var(--pp-soft);color:var(--pp-muted)}
      .pp-chip.more{flex:none;padding:0 5px;font-variant-numeric:tabular-nums}
      .pp-chip-run{display:flex;align-items:center;gap:4px;min-width:0}
      .pp-chip-run.wrap{flex-wrap:wrap}
      .pp-pill{display:inline-flex;align-items:center;gap:4px;flex:none;height:18px;padding:0 7px;border-radius:999px;background:var(--pp-hover);color:var(--pp-muted);font-size:10.5px;font-weight:700;line-height:1;white-space:nowrap}
      .pp-pill>i{font-size:8.5px}
      .pp-pill.warn{background:var(--pp-warn-bg);color:var(--pp-warn)}
      .pp-pill.danger{background:var(--pp-danger-bg);color:var(--pp-danger)}
      .pp-pill.ok{background:var(--pp-ok-bg);color:var(--pp-ok)}
      .pp-pill.role{background:var(--pp-role-bg);color:var(--pp-role)}

      .pp-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:var(--pp-panel);color:var(--pp-strong);font-size:12.5px;font-weight:650;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease}
      .pp-btn:hover:not(:disabled){border-color:var(--pp-accent);color:var(--pp-accent)}
      .pp-btn>i{font-size:11.5px}
      .pp-btn .pp-caret{font-size:9px;opacity:.7;margin-left:-1px}
      .pp-btn.primary{border-color:var(--pp-accent);background:var(--pp-accent);color:var(--pp-on-accent)}
      .pp-btn.primary:hover:not(:disabled){color:var(--pp-on-accent);filter:brightness(.95)}
      .pp-btn.danger{border-color:var(--pp-danger);background:var(--pp-danger);color:#fff}
      .pp-btn.danger:hover:not(:disabled){color:#fff;filter:brightness(.95)}
      .pp-btn.quiet{border-color:transparent;background:transparent}
      .pp-btn.quiet:hover:not(:disabled){background:var(--pp-hover);border-color:transparent;color:var(--pp-text)}
      .pp-btn:disabled{opacity:.5;cursor:default}
      .pp-icon-btn{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--pp-muted);font-size:12px;cursor:pointer;transition:background .12s ease,color .12s ease}
      .pp-icon-btn:hover:not(:disabled){background:var(--pp-hover);color:var(--pp-text)}
      .pp-icon-btn.danger:hover:not(:disabled){background:var(--pp-danger-bg);color:var(--pp-danger)}
      .pp-icon-btn:disabled{opacity:.35;cursor:default}

      .pp-search{position:relative;display:block;flex:0 1 240px;min-width:120px}
      .pp-search>i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--pp-faint);font-size:11.5px;pointer-events:none}
      .pp-search>input{width:100%;height:34px;margin:0;padding:0 10px 0 31px;border:1px solid #d0d5dd;border-radius:9px;background:var(--pp-panel);color:var(--pp-text);font:inherit;font-size:12.5px;outline:0;transition:border-color .12s ease,box-shadow .12s ease}
      .pp-search>input::placeholder{color:var(--pp-faint)}
      .pp-search>input:focus{border-color:var(--pp-accent);box-shadow:0 0 0 3px rgba(var(--pp-accent-rgb),.1)}
      .pp-search>input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
      .pp-seg{display:inline-flex;flex:none;padding:2px;border:1px solid var(--pp-line);border-radius:9px;background:var(--pp-soft)}
      .pp-seg>button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--pp-muted);font-size:12px;font-weight:650;white-space:nowrap;cursor:pointer}
      .pp-seg>button>i{font-size:11px;opacity:.8}
      .pp-seg>button[aria-pressed="true"],.pp-seg>button[aria-selected="true"]{background:var(--pp-panel);color:var(--pp-text);box-shadow:0 1px 3px rgba(16,24,40,.12)}
      .pp-seg-count{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--pp-warn-bg);color:var(--pp-warn);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}
      .pp-seg-count:empty{display:none}
      .pp-state,.pp-list-state{display:grid;place-items:center;justify-items:center;gap:10px;padding:48px 16px;color:var(--pp-muted);text-align:center}
      .pp-state>i,.pp-list-state>i{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--pp-hover);color:var(--pp-faint);font-size:17px}
      .pp-state>strong,.pp-list-state>strong{color:var(--pp-strong);font-size:13.5px;font-weight:650}

      .pp-layer{position:fixed;z-index:2147483400;left:0;top:0;min-width:200px;max-width:min(340px,calc(100vw - 16px));border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-panel);box-shadow:var(--pp-shadow);opacity:0;transform:translateY(-4px) scale(.98);transform-origin:top center;transition:opacity .12s ease,transform .14s cubic-bezier(.2,.8,.2,1)}
      .pp-layer.open{opacity:1;transform:none}
      .pp-menu{padding:5px;display:flex;flex-direction:column;max-height:min(420px,calc(100vh - 16px))}
      .pp-menu-list{overflow-y:auto;overscroll-behavior:contain;display:grid;gap:1px}
      .pp-menu-search{position:relative;display:block;margin:0 0 5px}
      .pp-menu-search>i{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--pp-faint);font-size:11px;pointer-events:none}
      .pp-menu-search>input{width:100%;height:32px;padding:0 10px 0 29px;border:1px solid var(--pp-line);border-radius:8px;background:var(--pp-soft);color:var(--pp-text);font:inherit;font-size:12.5px;outline:0}
      .pp-menu-search>input:focus{border-color:var(--pp-accent);background:var(--pp-panel)}
      .pp-menu-item{display:flex;align-items:center;gap:9px;width:100%;min-height:32px;padding:6px 9px;border:0;border-radius:8px;background:transparent;color:var(--pp-strong);font-size:12.5px;font-weight:600;text-align:left;cursor:pointer}
      .pp-menu-item:hover:not(:disabled),.pp-menu-item:focus-visible{background:var(--pp-hover);outline:0}
      .pp-menu-item:disabled{opacity:.45;cursor:default}
      .pp-menu-item.danger{color:var(--pp-danger)}
      .pp-menu-item.accent{color:var(--pp-accent)}
      .pp-menu-icon{width:14px;text-align:center;font-size:11.5px;color:var(--pp-muted)}
      .pp-menu-item.danger .pp-menu-icon,.pp-menu-item.accent .pp-menu-icon{color:inherit}
      .pp-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-menu-hint{flex:none;color:var(--pp-faint);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
      .pp-menu-check{display:grid;place-items:center;flex:none;width:16px;height:16px;border:1.5px solid #d0d5dd;border-radius:5px;color:transparent;font-size:9px}
      .pp-menu-item[aria-checked="true"] .pp-menu-check{border-color:var(--pp-accent);background:var(--pp-accent);color:var(--pp-on-accent)}
      .pp-menu-sep{height:1px;margin:4px 6px;background:var(--pp-line-soft)}
      .pp-menu-heading{padding:7px 9px 3px;color:var(--pp-faint);font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
      .pp-photo-pick{display:flex;align-items:center;gap:10px;min-width:0}
      .pp-photo-pick>input{min-width:0;flex:1;font:inherit;font-size:12px;color:var(--pp-muted)}
      .pp-photo-pick .pp-avatar>i{font-size:13px;color:var(--pp-faint)}
      .pp-select{position:relative;display:block;min-width:0}
      .pp-select>select{appearance:none;-webkit-appearance:none;padding-right:28px;cursor:pointer;text-overflow:ellipsis}
      .pp-select>i{position:absolute;right:10px;top:50%;transform:translateY(-50%);color:var(--pp-faint);font-size:9px;pointer-events:none}
      .pp-stack{display:inline-flex;align-items:center;flex:none}
      .pp-stack>.pp-avatar{margin-left:-6px;box-shadow:0 0 0 2px var(--pp-panel)}
      .pp-stack>.pp-avatar:first-child{margin-left:0}
      .pp-stack-count{margin-left:7px;min-width:14px;color:var(--pp-muted);font-size:12px;font-weight:650;font-variant-numeric:tabular-nums}
      .pp-info{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--pp-faint);font-size:12px;cursor:help}
      .pp-info:hover{color:var(--pp-muted)}
      .pp-form{display:grid;gap:11px;width:300px;max-width:100%;margin:0;padding:14px}
      .pp-form-title{font-size:14px;font-weight:700;color:var(--pp-text)}
      .pp-field{display:grid;gap:5px;min-width:0}
      .pp-field>span{color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-field>input,.pp-input{width:100%;height:34px;margin:0;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;background:var(--pp-panel);color:var(--pp-text);font:inherit;font-size:13px;outline:0;transition:border-color .12s ease,box-shadow .12s ease}
      .pp-field>input:focus,.pp-input:focus{border-color:var(--pp-accent);box-shadow:0 0 0 3px rgba(var(--pp-accent-rgb),.1)}
      .pp-choice-run{display:flex;flex-wrap:wrap;gap:5px}
      .pp-choice{height:26px;padding:0 10px;border:1px solid #d0d5dd;border-radius:999px;background:var(--pp-panel);color:var(--pp-muted);font-size:12px;font-weight:650;cursor:pointer;transition:background .1s ease,border-color .1s ease,color .1s ease}
      .pp-choice:hover{color:var(--pp-text)}
      .pp-choice[aria-pressed="true"]{border-color:var(--pp-role-line);background:var(--pp-role-bg);color:var(--pp-role)}
      .pp-form-foot{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin-top:2px}
      .pp-form-error{flex:1;min-width:0;color:var(--pp-danger);font-size:11.5px;font-weight:600}
      .pp-confirm{padding:12px;display:grid;gap:11px;min-width:230px}
      .pp-confirm>strong{font-size:13px;font-weight:650;color:var(--pp-text)}
      .pp-confirm-actions{display:flex;justify-content:flex-end;gap:7px}
      .pp-confirm-actions .pp-btn{height:30px}

      .pp-sum{display:grid;gap:14px;min-width:0}
      .pp-sum-head{position:relative;display:grid;justify-items:center;gap:10px;text-align:center;min-width:0}
      .pp-sum-edit{position:absolute;right:-6px;top:-10px}
      .pp-sum-photo{position:relative;display:inline-grid;padding:0;border:0;border-radius:50%;background:transparent;cursor:default}
      button.pp-sum-photo{cursor:pointer}
      .pp-sum-photo:has(.pp-avatar.square) .pp-sum-camera{border-radius:21px}
      .pp-sum-camera{position:absolute;inset:0;display:grid;place-items:center;border-radius:50%;background:rgba(16,24,40,.5);color:#fff;font-size:18px;opacity:0;transition:opacity .14s ease}
      button.pp-sum-photo:hover .pp-sum-camera,button.pp-sum-photo:focus-visible .pp-sum-camera{opacity:1}
      .pp-sum-id{display:grid;gap:3px;justify-items:center;min-width:0;max-width:100%}
      .pp-sum-name{max-width:100%;font-size:16px;font-weight:700;line-height:1.25;overflow-wrap:anywhere}
      .pp-sum-secondary{max-width:100%;color:var(--pp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-sum-pills{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;margin-top:3px}
      .pp-sum-facts{display:grid;gap:1px;margin:0}
      .pp-sum.panel .pp-sum-fact{display:grid;grid-template-columns:16px auto minmax(0,1fr);align-items:center;gap:8px;min-height:26px;font-size:12px}
      .pp-sum-fact>i{color:var(--pp-faint);font-size:11px;text-align:center}
      .pp-sum-fact>dt{color:var(--pp-muted)}
      .pp-sum-fact>dd{margin:0;color:var(--pp-strong);font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-sum-sections{display:grid;gap:12px}
      .pp-sum.panel .pp-sum-section>header{display:flex;align-items:center;gap:7px;height:24px;margin-bottom:5px}
      .pp-sum.panel .pp-sum-section>header>i{color:var(--pp-faint);font-size:11px;width:14px;text-align:center}
      .pp-sum.panel .pp-sum-section h4{flex:1;margin:0;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-sum.panel .pp-sum-section>header .pp-icon-btn{width:24px;height:24px;font-size:10.5px}
      .pp-sum.panel .pp-sum-section:has(>.pp-chip-run:empty)>header{margin-bottom:0}
      .pp-sum.panel .pp-sum-section>.pp-chip-run:empty{display:none}
      .pp-sum.panel .pp-chip{max-width:100%}
      .pp-sum-empty{color:var(--pp-faint);font-size:12px}
      .pp-sum.card{gap:10px;width:268px;padding:13px}
      .pp-sum.card .pp-sum-head{grid-template-columns:auto minmax(0,1fr);justify-items:start;align-items:center;gap:11px;text-align:left}
      .pp-sum.card .pp-sum-id{justify-items:start}
      .pp-sum.card .pp-sum-name{font-size:14px}
      .pp-sum.card .pp-sum-pills{justify-content:flex-start}
      .pp-sum.card .pp-sum-facts{gap:5px;padding-top:10px;border-top:1px solid var(--pp-line-soft)}
      .pp-sum.card .pp-sum-fact{display:flex;align-items:center;gap:8px;color:var(--pp-strong);font-size:12px}
      .pp-sum.card .pp-sum-fact>i{width:14px}
      .pp-sum.card .pp-sum-fact>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-sum.card .pp-sum-sections{gap:6px}
      .pp-sum.card .pp-sum-section{display:flex;align-items:flex-start;gap:8px;min-width:0}
      .pp-sum.card .pp-sum-section-icon{margin-top:5px}
      .pp-sum.card .pp-sum-fact>em{flex:none;color:var(--pp-muted);font-style:normal}
      .pp-sum-section-icon{flex:none;width:14px;text-align:center;color:var(--pp-faint);font-size:11px}
      @media (prefers-reduced-motion:reduce){.pp-layer,.pp-btn,.pp-icon-btn,.pp-sum-camera{transition:none}}
    `;
    document.head.appendChild(style);
  }
  ensureStyles();

  /* Sub-pages of the People category register here; people-settings.js mounts them. (Also FirstMatePeople.settings.registerView.) */
  const viewMounts = new Map();
  const viewListeners = new Set();
  People.views = {
    register(id, mountView){ viewMounts.set(String(id), mountView); viewListeners.forEach((listener) => { try { listener(String(id)); } catch (_) {} }); },
    get:(id) => viewMounts.get(String(id)) || null,
    onChange(listener){ viewListeners.add(listener); return () => viewListeners.delete(listener); }
  };

  People.kit = { esc, t, term, tip, toast, countPhrase, initials, avatar, chip, chips, pill, summary, menu, confirm, form, layer, select, stack, info, presence, place, ICONS, TONES, ensureStyles };
})();
