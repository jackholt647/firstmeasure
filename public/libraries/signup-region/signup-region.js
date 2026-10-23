/* Signup country, phone calling code and company language (1M8-214, 1M8-220).
 * The server prefills from the same detection registration uses (commerce/signup-options.ts);
 * the chosen country is sent as signup_country and decides the account's billing profile. */
(function (root) {
  'use strict';
  const optionRequests = new Map();
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  let phoneInputPromise = null;

  /* The calling-code picker, number formatting and preview are the shared phone input (1M8-240). */
  function loadPhoneInput(doc) {
    if (root.FirstMatePhoneInput) return Promise.resolve(root.FirstMatePhoneInput);
    if (!phoneInputPromise) phoneInputPromise = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = SCRIPT_SRC ? new URL('../phone-input/phone-input.js?v=20261022-phone-countries-v1', SCRIPT_SRC).toString() : '/libraries/phone-input/phone-input.js?v=20261022-phone-countries-v1';
      script.addEventListener('load', () => root.FirstMatePhoneInput ? resolve(root.FirstMatePhoneInput) : reject(new Error('Phone input did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Phone input could not be loaded.')), { once: true });
      doc.head.appendChild(script);
    }).catch((error) => { phoneInputPromise = null; throw error; });
    return phoneInputPromise;
  }

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
    const params = new URLSearchParams({ time_zone: timeZone, locale: navigator.language || '' });
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
   * Adds Country and Language selects above the phone field and a calling-code select
   * beside the phone input. `classes` match the host form: field, label, control.
   */
  function mount({ form, phoneInput, apiBase, classes = {} }) {
    const doc = form.ownerDocument;
    const phoneField = phoneInput.closest('.' + (classes.field || 'form-group')) || phoneInput.parentElement;
    function field(name, labelText) {
      const wrapper = doc.createElement('div'); wrapper.className = classes.field || 'form-group';
      const label = doc.createElement('label'); label.className = classes.label || ''; label.textContent = labelText;
      const select = doc.createElement('select'); select.name = name; select.className = classes.control || ''; select.required = true;
      select.id = 'signup-region-' + name + '-' + Math.random().toString(36).slice(2, 8); label.htmlFor = select.id;
      wrapper.append(label, select);
      return { wrapper, select };
    }
    const country = field('signup_country', text('country', 'Country'));
    const language = field('signup_language', text('language', 'Language (app and reports)'));
    const dial = doc.createElement('select');
    dial.name = 'phone_country'; dial.className = classes.control || ''; dial.setAttribute('aria-label', text('calling_code', 'Country calling code'));
    dial.style.cssText = 'width:auto;flex:0 0 auto;max-width:8.5em';
    const row = doc.createElement('div'); row.style.cssText = 'display:flex;gap:6px;align-items:stretch';
    phoneInput.replaceWith(row); row.append(dial, phoneInput); phoneInput.style.flex = '1 1 auto'; phoneInput.style.minWidth = '0';
    country.wrapper.hidden = language.wrapper.hidden = true; dial.hidden = true;
    phoneField.before(country.wrapper, language.wrapper);

    const state = { options: null, dialTouched: false, languageTouched: false, phone: null };
    const callingCodes = () => new Map((state.options?.countries || []).map(c => [c.code, c.calling_code]));
    function applyCountry(code) {
      const entry = (state.options?.countries || []).find(c => c.code === code);
      if (!entry) return;
      if (!state.dialTouched) { if (state.phone) state.phone.setCountry(entry.code); else dial.value = entry.code; }
      if (!state.languageTouched && [...language.select.options].some(o => o.value === entry.language)) language.select.value = entry.language;
      phoneInput.placeholder = entry.calling_code === '1' ? '(555) 555-0123' : '';
    }
    const ready = fetchOptions(apiBase).then(options => {
      state.options = options;
      country.select.append(option(doc, '', text('choose_country', 'Choose your country')));
      country.select.options[0].disabled = true;
      options.countries.forEach(c => country.select.append(option(doc, c.code, c.name)));
      // Only the countries the platform serves, the detected one first (1M8-240).
      (options.phone_countries || [...options.countries].sort((a, b) => a.code.localeCompare(b.code)))
        .forEach(c => dial.append(option(doc, c.code, c.code + ' +' + c.calling_code)));
      options.languages.forEach(l => language.select.append(option(doc, l.code, l.label)));
      country.select.value = options.country || '';
      dial.value = options.country || 'US';
      language.select.value = options.language || 'en-US';
      applyCountry(options.country);
      country.wrapper.hidden = language.wrapper.hidden = dial.hidden = false;
      return loadPhoneInput(doc).then((phoneInputLibrary) => {
        state.phone = phoneInputLibrary.attach({ input: phoneInput, select: dial, countries: options.phone_countries || options.countries, country: dial.value });
        return options;
      }, () => options);
    }).catch(() => {
      // Without options the form behaves as before: the server detects the country.
      country.wrapper.remove(); language.wrapper.remove(); dial.remove();
      return null;
    });
    country.select.addEventListener('change', () => applyCountry(country.select.value));
    dial.addEventListener('change', () => { state.dialTouched = true; });
    language.select.addEventListener('change', () => { state.languageTouched = true; });

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
      formatsAsNorthAmerican: () => !state.phone && (!state.options || callingCode() === '1')
    };
  }

  root.FirstMateSignupRegion = { mount, e164, validE164, fetchOptions };
})(globalThis);
