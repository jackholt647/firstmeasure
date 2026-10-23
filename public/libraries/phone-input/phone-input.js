/* FirstMate phone input (1M8-240): a calling-code picker limited to the countries offered, the number shown in the chosen
 * country's own national format as it is typed (United Kingdom 020 7946 0123, Sweden 070-123 45 67, United States
 * (555) 555-0123), an example number for the chosen country as the placeholder, and E.164 for saving.
 *
 *   const phone = FirstMatePhoneInput.attach({ input, select, countries:[{ code, name, calling_code }], country:'GB' });
 *   phone.e164()  phone.valid()  phone.callingCode()  phone.country()  phone.setCountry('SE')  phone.ready
 *
 * The picker is the shared FirstMateSelectList (libraries/select-list) when it is loaded; the native select stays in the
 * form, hidden, as the submitted value. Formatting and the examples use libphonenumber-js (the server's own dependency,
 * vendored for the browser). Until it loads, or if it cannot, the number is left as typed and E.164 is built the way the
 * server builds it (commerce/signup-options.ts). */
(function (root) {
  'use strict';
  if (root.FirstMatePhoneInput) return;
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  const VENDOR = 'vendor/libphonenumber-js-1.12.31/';
  const vendorUrl = (file) => (SCRIPT_SRC ? new URL('../' + VENDOR + file, SCRIPT_SRC).toString() : '/libraries/' + VENDOR + file);
  let libraryPromise = null, examplesPromise = null;

  function say(key, fallback, values = {}) {
    const readable = String(fallback).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
    return root.PlatformLanguage?.text?.('phone-input', key, readable, values) ?? readable;
  }

  function loadLibrary(doc) {
    if (root.libphonenumber?.AsYouType) return Promise.resolve(root.libphonenumber);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = vendorUrl('libphonenumber-js.min.js');
      script.async = true;
      // The library's patterns are Unicode; a host page without a declared charset would misread them.
      script.charset = 'utf-8';
      script.addEventListener('load', () => root.libphonenumber?.AsYouType ? resolve(root.libphonenumber) : reject(new Error('Phone formatting did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Phone formatting could not be loaded.')), { once: true });
      doc.head.appendChild(script);
    }).catch((error) => { libraryPromise = null; throw error; });
    return libraryPromise;
  }
  /** Example mobile numbers per country (libphonenumber's examples.mobile.json), for the placeholder. */
  function loadExamples() {
    if (!examplesPromise) examplesPromise = fetch(vendorUrl('examples.mobile.json'), { credentials: 'omit' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Phone examples unavailable'))))
      .catch((error) => { examplesPromise = null; throw error; });
    return examplesPromise;
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

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function attach({ input, select = null, countries = [], country = '' } = {}) {
    const doc = input.ownerDocument;
    const list = countries.filter((entry) => entry && entry.code && entry.calling_code);
    const byCode = new Map(list.map((entry) => [entry.code, entry]));

    // The native select keeps the submitted value (phone_country) and its change event.
    const picker = select || doc.createElement('select');
    if (!select) { picker.name = 'phone_country'; input.before(picker); }
    picker.replaceChildren(...list.map((entry) => {
      const option = doc.createElement('option');
      option.value = entry.code; option.textContent = entry.code + ' +' + entry.calling_code;
      return option;
    }));
    let current = byCode.has(country) ? country : (list[0]?.code || '');
    picker.value = current;
    const styled = root.FirstMateSelectList?.attach(picker, {
      items: list.map((entry) => ({ value: entry.code, badge: entry.code, label: entry.name || entry.code, hint: '+' + entry.calling_code })),
      trigger: (entry) => `<span class="fm-select-list-badge">${esc(entry.badge)}</span><span class="fm-select-list-hint">${esc(entry.hint)}</span>`,
      label: say('calling_code', 'Country calling code'),
      compact: true
    }) || null;
    // The calling-code button sits beside the phone field, so it takes the field's height (border box).
    try { const height = input.getBoundingClientRect().height; if (styled && height > 0) styled.button.style.height = height + 'px'; } catch (_) {}

    let lib = null, examples = null, previous = String(input.value || '');
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
    /** The placeholder: an example number of the chosen country, in its national format (Sweden 070-123 45 67). */
    function paintPlaceholder() {
      let example = '';
      try { if (lib && examples) example = lib.getExampleNumber(current, examples)?.formatNational() || ''; } catch (_) {}
      input.placeholder = example;
    }
    /* The number in the chosen country's national format, as typed (a number typed with + keeps international format).
       Digits beyond the longest number the country has are not taken. */
    function format(event) {
      const value = String(input.value || '');
      if (!lib) { previous = value; return; }
      const international = value.trim().startsWith('+');
      try {
        const length = international ? lib.validatePhoneNumberLength(value) : lib.validatePhoneNumberLength(value, current);
        if (length === 'TOO_LONG' && !String(event?.inputType || '').startsWith('delete')) { input.value = previous; return; }
      } catch (_) {}
      // Deleting is left alone, or a removed space or bracket would come straight back.
      if (String(event?.inputType || '').startsWith('delete')) { previous = value; return; }
      const atEnd = input.selectionStart == null || input.selectionStart >= value.length;
      if (international) {
        const code = countryOf(parsed());
        if (code && code !== current) { current = code; picker.value = current; styled?.sync(); paintPlaceholder(); }
      }
      if (atEnd) {
        const formatted = international ? new lib.AsYouType().input(value) : new lib.AsYouType(current).input(value);
        if (formatted && formatted !== value) input.value = formatted;
      }
      previous = String(input.value || '');
    }
    function setCountry(code) {
      if (!byCode.has(code)) return;
      current = code; picker.value = code; styled?.sync(); paintPlaceholder();
      // A national number is reformatted for the new country; a number with a + keeps its own country.
      if (lib && !String(input.value || '').trim().startsWith('+')) {
        const digits = String(input.value || '').replace(/[^\d]/g, '');
        if (digits) input.value = new lib.AsYouType(current).input(digits);
        previous = String(input.value || '');
      }
    }
    picker.addEventListener('change', () => setCountry(picker.value));
    input.addEventListener('input', format);
    input.placeholder = '';
    Promise.resolve(root.PlatformLanguage?.ensure?.(['phone-input'])).then(() => styled?.sync()).catch(() => null);

    const ready = loadLibrary(doc).then((library) => {
      lib = library;
      // A saved number shows in its own country's national format (a stored +1 number reads (555) 555-0123); a number
      // from a country not offered keeps its international format.
      const number = parsed(), code = countryOf(number);
      if (String(input.value).trim().startsWith('+') && number) {
        if (code) { current = code; picker.value = current; styled?.sync(); input.value = number.formatNational(); }
        else input.value = number.formatInternational();
      } else if (String(input.value || '').trim()) input.value = new lib.AsYouType(current).input(String(input.value));
      previous = String(input.value || '');
      return loadExamples().then((data) => { examples = data; paintPlaceholder(); }, () => null).then(() => true);
    }).catch(() => false);

    return { select: picker, list: styled, ready, e164, valid: () => validE164(e164()), callingCode, country: () => current, setCountry, format };
  }

  root.FirstMatePhoneInput = { attach, plainE164, validE164, loadLibrary };
})(globalThis);
