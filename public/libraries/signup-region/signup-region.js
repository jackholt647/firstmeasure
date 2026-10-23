/* Signup phone calling code (1M8-214) and the signup language (1M8-240).
 * Visitors never choose a country or language: the server detects both (commerce/regions.ts). The calling-code
 * picker defaults to the detected country; the language the form is shown in is sent as signup_language and becomes
 * the new organization's company language (libraries/signup-language). */
(function (root) {
  'use strict';
  const optionRequests = new Map();
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  const KEY = '20261023-phone-format-v1';
  const scripts = new Map();

  /* The styled lists (select-list) and the phone input (calling code, formatting, example) are shared libraries (1M8-240). */
  function loadScript(doc, path, global) {
    if (root[global]) return Promise.resolve(root[global]);
    if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = SCRIPT_SRC ? new URL('../' + path + '?v=' + KEY, SCRIPT_SRC).toString() : '/libraries/' + path + '?v=' + KEY;
      script.addEventListener('load', () => root[global] ? resolve(root[global]) : reject(new Error(path + ' did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error(path + ' could not be loaded.')), { once: true });
      doc.head.appendChild(script);
    }).catch((error) => { scripts.delete(path); throw error; }));
    return scripts.get(path);
  }
  const loadSelectList = (doc) => loadScript(doc, 'select-list/select-list.js', 'FirstMateSelectList');
  const loadPhoneInput = (doc) => loadSelectList(doc).catch(() => null).then(() => loadScript(doc, 'phone-input/phone-input.js', 'FirstMatePhoneInput'));

  function text(key, fallback) {
    return root.PlatformLanguage?.text('signup-region', key, fallback) ?? fallback;
  }

  /** The phone as E.164 after a chosen calling code; drops a national trunk 0 (020… → +4420…). */
  function e164(callingCode, value) {
    const raw = String(value ?? '').trim(), dial = String(callingCode ?? '').replace(/\D/g, '');
    if (!raw || raw.startsWith('+') || !dial) return raw.startsWith('+') ? '+' + raw.replace(/\D/g, '') : raw;
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00' + dial)) digits = digits.slice(2 + dial.length);
    else if (dial === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits ? '+' + dial + digits.replace(/^0+/, '') : '';
  }

  /** Matches the server: 8 to 15 digits after +, and exactly ten national digits for +1. */
  function validE164(value) {
    const phone = String(value || '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return false;
    return !phone.startsWith('+1') || phone.length === 12;
  }

  function fetchOptions(apiBase) {
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    const lang = root.FirstMateSignupLanguage?.handoff?.() || '';
    const params = new URLSearchParams({ time_zone: timeZone, locale: navigator.language || '', locales: (navigator.languages || []).join(','), ...(lang ? { lang } : {}) });
    const url = String(apiBase).replace(/\/$/, '') + '/auth/signup-options?' + params;
    if (!optionRequests.has(url)) {
      optionRequests.set(url, fetch(url, { credentials: 'include', cache: 'no-store' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error('Signup options unavailable')))
        .catch(error => { optionRequests.delete(url); throw error; }));
    }
    return optionRequests.get(url);
  }

  function option(doc, value, label) {
    const element = doc.createElement('option');
    element.value = value; element.textContent = label;
    return element;
  }

  /**
   * Adds the calling-code picker beside the phone input and a hidden signup_language field (1M8-240: no Country or
   * Language dropdowns; both are detected). `options` may be the signup options already fetched by the page's
   * language start-up; `classes` match the host form: field, label, control.
   */
  function mount({ form, phoneInput, apiBase, classes = {}, options: knownOptions = null }) {
    const doc = form.ownerDocument;
    const language = doc.createElement('input');
    language.type = 'hidden'; language.name = 'signup_language';
    form.appendChild(language);
    const dial = doc.createElement('select');
    dial.name = 'phone_country'; dial.className = classes.control || ''; dial.setAttribute('aria-label', text('calling_code', 'Country calling code'));
    dial.style.cssText = 'width:auto;flex:0 0 auto;max-width:8.5em';
    const row = doc.createElement('div'); row.style.cssText = 'display:flex;gap:6px;align-items:stretch';
    phoneInput.replaceWith(row); row.append(dial, phoneInput); phoneInput.style.flex = '1 1 auto'; phoneInput.style.minWidth = '0';
    dial.hidden = true; dial.style.display = 'none';

    const state = { options: null, phone: null };
    const callingCodes = () => new Map((state.options?.countries || []).map(c => [c.code, c.calling_code]));
    const ready = Promise.resolve(knownOptions || fetchOptions(apiBase)).then(options => {
      if (!options) throw new Error('Signup options unavailable');
      state.options = options;
      language.value = root.FirstMateSignupLanguage?.language?.() || options.language || '';
      // The countries the platform serves, the detected one first (1M8-240). The list only offers calling codes; it
      // never limits who can sign up.
      (options.phone_countries || [...options.countries].sort((a, b) => a.code.localeCompare(b.code)))
        .forEach(c => dial.append(option(doc, c.code, c.code + ' +' + c.calling_code)));
      dial.value = options.country || (options.phone_countries?.[0]?.code) || 'US';
      dial.hidden = false; dial.style.display = '';
      if (dial.value === 'US' || dial.value === 'CA') phoneInput.placeholder = '(555) 555-0123';
      return loadPhoneInput(doc).then((phoneInputLibrary) => {
        state.phone = phoneInputLibrary.attach({ input: phoneInput, select: dial, countries: options.phone_countries || options.countries, country: dial.value });
        return options;
      }, () => options);
    }).catch(() => {
      // Without options the form behaves as before: the server detects the country.
      dial.remove();
      return null;
    });

    const callingCode = () => state.phone ? state.phone.callingCode() : state.options ? callingCodes().get(dial.value) || '' : '';
    return {
      ready,
      callingCode,
      /** The phone to submit: E.164 whenever a calling code is known. */
      phone: () => state.phone ? state.phone.e164() : e164(callingCode(), phoneInput.value),
      valid() {
        if (state.phone) return state.phone.valid();
        const code = callingCode();
        if (code) return validE164(e164(code, phoneInput.value));
        const digits = String(phoneInput.value || '').replace(/\D/g, '');
        if (String(phoneInput.value || '').trim().startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits);
        return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
      },
      /** North American numbers keep their familiar (555) 555-0123 formatting while typing. */
      formatsAsNorthAmerican: () => !state.phone && (!state.options || callingCode() === '1'),
      /** The language the form is shown in (sent as signup_language). */
      setLanguage: (code) => { language.value = code || ''; }
    };
  }

  root.FirstMateSignupRegion = { mount, e164, validE164, fetchOptions };
})(globalThis);
