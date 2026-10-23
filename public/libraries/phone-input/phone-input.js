/* FirstMate phone input (1M8-240): a calling-code picker limited to the countries offered, the number shown in the chosen
 * country's own national format as it is typed (United Kingdom 020 7946 0123, Sweden 070-123 45 67, United States
 * (555) 555-0123), and E.164 for saving.
 *
 *   const phone = FirstMatePhoneInput.attach({ input, select, countries:[{ code, name, calling_code }], country:'GB' });
 *   phone.e164()  phone.valid()  phone.callingCode()  phone.country()  phone.setCountry('SE')  phone.ready
 *
 * The picker is a styled listbox in the app's menu style (the account switcher and People menus); the native select stays
 * in the form, hidden, as the submitted value. Formatting uses libphonenumber-js (the server's own dependency, vendored
 * for the browser). Until it loads, or if it cannot, the number is left as typed and E.164 is built the way the server
 * builds it (commerce/signup-options.ts). */
(function (root) {
  'use strict';
  if (root.FirstMatePhoneInput) return;
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  const LIBRARY = 'vendor/libphonenumber-js-1.12.31/libphonenumber-js.min.js';
  let libraryPromise = null;
  let sequence = 0;

  function say(key, fallback, values = {}) {
    const readable = String(fallback).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
    return root.PlatformLanguage?.text?.('phone-input', key, readable, values) ?? readable;
  }

  function loadLibrary(doc) {
    if (root.libphonenumber?.AsYouType) return Promise.resolve(root.libphonenumber);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = SCRIPT_SRC ? new URL('../' + LIBRARY, SCRIPT_SRC).toString() : '/libraries/' + LIBRARY;
      script.async = true;
      // The library's patterns are Unicode; a host page without a declared charset would misread them.
      script.charset = 'utf-8';
      script.addEventListener('load', () => root.libphonenumber?.AsYouType ? resolve(root.libphonenumber) : reject(new Error('Phone formatting did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Phone formatting could not be loaded.')), { once: true });
      doc.head.appendChild(script);
    }).catch((error) => { libraryPromise = null; throw error; });
    return libraryPromise;
  }

  /** The server's rule (commerce/signup-options.ts signupE164): drops a national trunk 0 after a chosen calling code. */
  function plainE164(callingCode, value) {
    const raw = String(value ?? '').trim(), dial = String(callingCode ?? '').replace(/\D/g, '');
    if (!raw || raw.startsWith('+') || !dial) return raw.startsWith('+') ? '+' + raw.replace(/\D/g, '') : raw;
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00' + dial)) digits = digits.slice(2 + dial.length);
    else if (dial === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits ? '+' + dial + digits.replace(/^0+/, '') : '';
  }

  /** The server's acceptance rule: 8 to 15 digits after +, and exactly ten national digits for +1. */
  function validE164(value) {
    const phone = String(value || '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return false;
    return !phone.startsWith('+1') || phone.length === 12;
  }

  const CSS = `
    .fm-phone-cc{position:relative;flex:0 0 auto;display:flex}
    .fm-phone-cc-trigger{display:inline-flex;align-items:center;gap:6px;height:100%;min-height:40px;margin:0;padding:0 10px 0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#202124;font:inherit;font-size:14px;line-height:1;cursor:pointer;white-space:nowrap;box-sizing:border-box}
    .fm-phone-cc-trigger:hover{border-color:#98a2b3}
    .fm-phone-cc-trigger:focus-visible{outline:2px solid rgba(26,115,232,.35);outline-offset:1px;border-color:#1a73e8}
    .fm-phone-cc-trigger[aria-expanded="true"]{border-color:#1a73e8}
    .fm-phone-cc-code{font-weight:700;letter-spacing:.02em}
    .fm-phone-cc-dial{color:#5f6368}
    .fm-phone-cc-chevron{width:10px;height:10px;color:#5f6368;transition:transform .15s ease}
    .fm-phone-cc-trigger[aria-expanded="true"] .fm-phone-cc-chevron{transform:rotate(180deg)}
    .fm-phone-cc-menu{position:absolute;z-index:2147483000;top:calc(100% + 6px);left:0;min-width:240px;max-height:280px;overflow:auto;margin:0;padding:6px;border:1px solid #dadce0;border-radius:12px;background:#fff;box-shadow:0 12px 34px rgba(60,64,67,.28);list-style:none;box-sizing:border-box;font-size:14px;color:#202124;text-align:left}
    .fm-phone-cc-menu[hidden]{display:none}
    .fm-phone-cc-option{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;cursor:pointer;line-height:1.25}
    .fm-phone-cc-option[aria-selected="true"]{background:#e8f0fe;color:#174ea6}
    .fm-phone-cc-option.active{background:#f1f3f4}
    .fm-phone-cc-option[aria-selected="true"].active{background:#d2e3fc}
    .fm-phone-cc-option-code{font-size:12px;font-weight:700;color:#5f6368}
    .fm-phone-cc-option[aria-selected="true"] .fm-phone-cc-option-code{color:inherit}
    .fm-phone-cc-option-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fm-phone-cc-option-dial{color:#5f6368;font-variant-numeric:tabular-nums}
    @media (max-width:520px){.fm-phone-cc-menu{min-width:min(280px,calc(100vw - 32px))}}
  `;
  function injectStyles(input) {
    const node = input.getRootNode?.();
    const host = typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot ? node : input.ownerDocument.head;
    if (host.querySelector?.('style[data-fm-phone-input]')) return;
    const style = input.ownerDocument.createElement('style');
    style.setAttribute('data-fm-phone-input', '');
    style.textContent = CSS;
    host.appendChild(style);
  }
  const CHEVRON = '<svg class="fm-phone-cc-chevron" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function attach({ input, select = null, countries = [], country = '' } = {}) {
    const doc = input.ownerDocument;
    const id = 'fm-phone-cc-' + (++sequence);
    const list = countries.filter((entry) => entry && entry.code && entry.calling_code);
    const byCode = new Map(list.map((entry) => [entry.code, entry]));
    injectStyles(input);

    // The native select keeps the submitted value (phone_country) and its change event; it is not shown.
    const picker = select || doc.createElement('select');
    if (!select) { picker.name = 'phone_country'; input.before(picker); }
    picker.replaceChildren(...list.map((entry) => {
      const option = doc.createElement('option');
      option.value = entry.code; option.textContent = entry.code + ' +' + entry.calling_code;
      return option;
    }));
    picker.hidden = true; picker.style.display = 'none'; picker.tabIndex = -1;

    const wrap = doc.createElement('div'); wrap.className = 'fm-phone-cc';
    const trigger = doc.createElement('button');
    trigger.type = 'button'; trigger.className = 'fm-phone-cc-trigger'; trigger.id = id + '-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', id + '-menu');
    const menu = doc.createElement('ul');
    menu.className = 'fm-phone-cc-menu'; menu.id = id + '-menu'; menu.setAttribute('role', 'listbox'); menu.tabIndex = -1; menu.hidden = true;
    menu.setAttribute('aria-label', say('calling_code', 'Country calling code'));
    menu.innerHTML = list.map((entry) => `<li class="fm-phone-cc-option" role="option" id="${id}-${escapeHtml(entry.code)}" data-code="${escapeHtml(entry.code)}" aria-selected="false"><span class="fm-phone-cc-option-code">${escapeHtml(entry.code)}</span><span class="fm-phone-cc-option-name">${escapeHtml(entry.name || entry.code)}</span><span class="fm-phone-cc-option-dial">+${escapeHtml(entry.calling_code)}</span></li>`).join('');
    wrap.append(trigger, menu);
    picker.after(wrap);
    // Match the phone input's height and corners so the two read as one control.
    try {
      const style = root.getComputedStyle(input);
      const height = input.getBoundingClientRect().height; // border box, as the trigger is sized
      if (height > 0) trigger.style.height = height + 'px';
      trigger.style.borderRadius = style.borderRadius;
      trigger.style.fontFamily = style.fontFamily;
    } catch (_) {}

    let current = byCode.has(country) ? country : (list[0]?.code || '');
    let active = current;
    const options = () => [...menu.querySelectorAll('[role="option"]')];
    function paintTrigger() {
      const entry = byCode.get(current);
      trigger.innerHTML = `<span class="fm-phone-cc-code">${escapeHtml(entry?.code || '')}</span><span class="fm-phone-cc-dial">${entry ? '+' + escapeHtml(entry.calling_code) : ''}</span>${CHEVRON}`;
      trigger.setAttribute('aria-label', say('calling_code_value', 'Country calling code: {country} +{code}', { country: entry?.name || '', code: entry?.calling_code || '' }));
      options().forEach((option) => option.setAttribute('aria-selected', String(option.dataset.code === current)));
    }
    function paintActive(scroll = true) {
      options().forEach((option) => option.classList.toggle('active', option.dataset.code === active));
      const option = menu.querySelector(`[data-code="${active}"]`);
      if (option) { menu.setAttribute('aria-activedescendant', option.id); if (scroll) option.scrollIntoView?.({ block: 'nearest' }); }
    }
    function open() {
      if (!menu.hidden) return;
      menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      active = current; paintActive(); menu.focus({ preventScroll: true });
    }
    function close(focusTrigger = true) {
      if (menu.hidden) return;
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focusTrigger) trigger.focus({ preventScroll: true });
    }
    function choose(code) {
      close();
      if (!byCode.has(code) || code === current) return;
      picker.value = code;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
    trigger.addEventListener('keydown', (event) => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); } });
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => { const option = event.target.closest?.('[role="option"]'); if (option) choose(option.dataset.code); });
    menu.addEventListener('mousemove', (event) => { const option = event.target.closest?.('[role="option"]'); if (option && option.dataset.code !== active) { active = option.dataset.code; paintActive(false); } });
    let typed = '', typedAt = 0;
    menu.addEventListener('keydown', (event) => {
      const codes = list.map((entry) => entry.code), at = Math.max(0, codes.indexOf(active));
      if (event.key === 'ArrowDown') { active = codes[Math.min(codes.length - 1, at + 1)]; paintActive(); }
      else if (event.key === 'ArrowUp') { active = codes[Math.max(0, at - 1)]; paintActive(); }
      else if (event.key === 'Home') { active = codes[0]; paintActive(); }
      else if (event.key === 'End') { active = codes[codes.length - 1]; paintActive(); }
      else if (event.key === 'Enter' || event.key === ' ') choose(active);
      else if (event.key === 'Escape') close();
      else if (event.key === 'Tab') close(false);
      else if (/^[a-z]$/i.test(event.key)) {
        typed = (Date.now() - typedAt < 700 ? typed : '') + event.key.toLowerCase(); typedAt = Date.now();
        const match = list.find((entry) => String(entry.name || '').toLowerCase().startsWith(typed)) || list.find((entry) => entry.code.toLowerCase().startsWith(typed));
        if (match) { active = match.code; paintActive(); }
      } else return;
      event.preventDefault();
    });
    menu.addEventListener('focusout', (event) => { if (!wrap.contains(event.relatedTarget)) close(false); });
    doc.addEventListener('mousedown', (event) => { if (!event.composedPath().includes(wrap)) close(false); });

    let lib = null;
    const callingCode = () => byCode.get(current)?.calling_code || '';
    /* The offered country a parsed number belongs to: its own, else (a shared code such as +1) the current one or the first
       offered with that calling code. */
    const countryOf = (number) => {
      if (!number) return '';
      if (number.country && byCode.has(number.country)) return number.country;
      if (callingCode() === number.countryCallingCode) return current;
      return list.find((entry) => entry.calling_code === number.countryCallingCode)?.code || '';
    };
    function parsed() {
      const value = String(input.value || '').trim();
      if (!lib || !value) return null;
      try { return lib.parsePhoneNumberFromString(value, value.startsWith('+') ? undefined : current) || null; } catch (_) { return null; }
    }
    function e164() {
      const number = parsed();
      if (number && number.isPossible()) return number.number;
      return plainE164(callingCode(), input.value);
    }
    /* The number in the chosen country's national format, as typed (a number typed with + keeps international format). */
    function format(event) {
      if (!lib) return;
      // Deleting is left alone, or a removed space or bracket would come straight back.
      if (String(event?.inputType || '').startsWith('delete')) return;
      const value = String(input.value || '');
      const atEnd = input.selectionStart == null || input.selectionStart >= value.length;
      if (value.trim().startsWith('+')) {
        const code = countryOf(parsed());
        if (code && code !== current) { current = code; picker.value = current; paintTrigger(); }
      }
      if (!atEnd) return;
      const formatted = value.trim().startsWith('+') ? new lib.AsYouType().input(value) : new lib.AsYouType(current).input(value);
      if (formatted && formatted !== value) input.value = formatted;
    }
    function setCountry(code) {
      if (!byCode.has(code)) return;
      current = code; picker.value = code; paintTrigger();
      // A national number is reformatted for the new country; a number with a + keeps its own country.
      if (lib && !String(input.value || '').trim().startsWith('+')) {
        const digits = String(input.value || '').replace(/[^\d]/g, '');
        if (digits) input.value = new lib.AsYouType(current).input(digits);
      }
    }
    picker.value = current;
    picker.addEventListener('change', () => setCountry(picker.value));
    input.addEventListener('input', format);
    paintTrigger();
    Promise.resolve(root.PlatformLanguage?.ensure?.(['phone-input'])).then(paintTrigger).catch(() => null);

    const ready = loadLibrary(doc).then((library) => {
      lib = library;
      // A saved number shows in its own country's national format (a stored +1 number reads (555) 555-0123); a number
      // from a country not offered keeps its international format.
      const number = parsed(), code = countryOf(number);
      if (String(input.value).trim().startsWith('+') && number) {
        if (code) { current = code; picker.value = current; paintTrigger(); input.value = number.formatNational(); }
        else input.value = number.formatInternational();
      } else if (String(input.value || '').trim()) input.value = new lib.AsYouType(current).input(String(input.value));
      return true;
    }).catch(() => false);

    return { select: picker, trigger, menu, ready, e164, valid: () => validE164(e164()), callingCode, country: () => current, setCountry, format };
  }

  root.FirstMatePhoneInput = { attach, plainE164, validE164, loadLibrary };
})(globalThis);
