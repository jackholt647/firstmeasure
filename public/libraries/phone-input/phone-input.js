/* FirstMate phone input (1M8-240): a calling-code picker limited to the countries offered, the number formatted for the
 * chosen country as it is typed, a preview of the full international number, and E.164 for saving.
 *
 *   const phone = FirstMatePhoneInput.attach({ input, select, countries:[{ code, name, calling_code }], country:'GB' });
 *   phone.e164()  phone.valid()  phone.callingCode()  phone.country()  phone.setCountry('FR')  phone.ready
 *
 * Formatting uses libphonenumber-js (the server's own dependency, vendored for the browser). Until it loads, or if it
 * cannot, the number is left as typed and E.164 is built the way the server builds it (commerce/signup-options.ts). */
(function (root) {
  'use strict';
  if (root.FirstMatePhoneInput) return;
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  const LIBRARY = 'vendor/libphonenumber-js-1.12.31/libphonenumber-js.min.js';
  let libraryPromise = null;

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

  function attach({ input, select = null, countries = [], country = '', preview = true } = {}) {
    const doc = input.ownerDocument;
    const list = countries.filter((entry) => entry && entry.code && entry.calling_code);
    const byCode = new Map(list.map((entry) => [entry.code, entry]));
    const picker = select || doc.createElement('select');
    if (!select) { picker.name = 'phone_country'; input.before(picker); }
    picker.setAttribute('aria-label', say('calling_code', 'Country calling code'));
    picker.replaceChildren(...list.map((entry) => {
      const option = doc.createElement('option');
      option.value = entry.code; option.textContent = entry.code + ' +' + entry.calling_code; option.title = entry.name;
      return option;
    }));
    let current = byCode.has(country) ? country : (list[0]?.code || '');
    picker.value = current;

    const note = preview ? doc.createElement('div') : null;
    if (note) {
      note.className = 'fm-phone-preview';
      note.setAttribute('aria-live', 'polite');
      note.style.cssText = 'margin-top:4px;font-size:12px;line-height:1.35;color:#5f6368;min-height:1.35em';
      (picker.parentElement && picker.parentElement.contains(input) && picker.parentElement !== input.form ? picker.parentElement : input).after(note);
    }

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
    function paintPreview() {
      if (!note) return;
      const number = parsed();
      if (number && number.isPossible()) note.textContent = say('preview', 'Saved as {number}', { number: number.formatInternational() });
      else if (!lib && validE164(e164())) note.textContent = say('preview', 'Saved as {number}', { number: e164() });
      else note.textContent = String(input.value || '').replace(/\D/g, '') ? say('incomplete', 'Enter the full number for {country} (+{code})', { country: byCode.get(current)?.name || current, code: callingCode() }) : '';
    }
    function format(event) {
      if (!lib) return paintPreview();
      // Deleting is left alone, or a removed space or bracket would come straight back.
      if (String(event?.inputType || '').startsWith('delete')) return paintPreview();
      const value = String(input.value || '');
      const atEnd = input.selectionStart == null || input.selectionStart >= value.length;
      // Typing + and a calling code picks that country, when it is offered.
      if (value.trim().startsWith('+')) {
        const code = countryOf(parsed());
        if (code && code !== current) { current = code; picker.value = current; }
      }
      if (atEnd) {
        const formatted = value.trim().startsWith('+') ? new lib.AsYouType().input(value) : new lib.AsYouType(current).input(value);
        if (formatted && formatted !== value) input.value = formatted;
      }
      paintPreview();
    }
    function setCountry(code) {
      if (!byCode.has(code)) return;
      current = code; picker.value = code;
      // A national number keeps its digits; a number with a + keeps its own country.
      format();
    }
    picker.addEventListener('change', () => setCountry(picker.value));
    Promise.resolve(root.PlatformLanguage?.ensure?.(['phone-input'])).then(() => { picker.setAttribute('aria-label', say('calling_code', 'Country calling code')); paintPreview(); }).catch(() => null);
    input.addEventListener('input', format);
    input.addEventListener('blur', paintPreview);

    const ready = loadLibrary(doc).then((library) => {
      lib = library;
      // A saved number shows in the national format of its own country (a stored +1 number reads (555) 555-0123).
      const number = parsed(), code = countryOf(number);
      if (code && String(input.value).trim().startsWith('+')) {
        current = code; picker.value = current; input.value = number.formatNational();
      } else format();
      paintPreview();
      return true;
    }).catch(() => { paintPreview(); return false; });

    return { select: picker, preview: note, ready, e164, valid: () => validE164(e164()), callingCode, country: () => current, setCountry, format };
  }

  root.FirstMatePhoneInput = { attach, plainE164, validE164, loadLibrary };
})(globalThis);
