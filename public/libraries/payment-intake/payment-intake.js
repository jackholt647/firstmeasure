/* public/libraries/payment-intake/payment-intake.js
 * Reusable browser payment intake modal for Card/ACH collection.
 * This is processor-agnostic UI; callers provide the submit callback.
 */
(function(){
  const root = window;
  const state = { active: null };

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[char]));
  }
  function digits(value){ return cleanText(value).replace(/\D/g, ''); }
  function money(cents, fallback = ''){
    const number = Number(cents);
    if (!Number.isFinite(number)) return fallback;
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' }).format(number / 100);
  }
  function centsFromAmount(value){
    const text = cleanText(value).replace(/[$,\s]/g, '');
    if (!text) return 0;
    const number = Number(text);
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  }
  function cardNumberValid(value){
    const valueDigits = digits(value);
    if (valueDigits.length < 13 || valueDigits.length > 19) return false;
    let sum = 0;
    let dbl = false;
    for (let i = valueDigits.length - 1; i >= 0; i -= 1) {
      let digit = Number(valueDigits[i]);
      if (dbl) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  function expiryValid(monthValue, yearValue){
    const month = Number(digits(monthValue));
    const rawYear = digits(yearValue);
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
    if (month < 1 || month > 12 || year < 2000) return false;
    return new Date(year, month, 0, 23, 59, 59, 999).getTime() >= Date.now();
  }
  function normalizeMethods(value){
    const list = Array.isArray(value) ? value : ['card', 'ach'];
    const methods = new Set(list.map((item) => cleanText(item).toLowerCase()));
    return {
      card: methods.has('card') || methods.has('cards'),
      ach: methods.has('ach') || methods.has('bank')
    };
  }
  function fakeSavedMethods(options = {}, methods){
    const canUseSaved = options.allowSavedMethods === true || options.useSavedMethods === true || options.allowPreviousPaymentMethods === true;
    if (!canUseSaved || !options.contact) return [];
    const contact = options.contact || {};
    const name = cleanText(contact.name || contact.display_name || contact.email || 'Customer');
    const saved = [];
    if (methods.card) saved.push({ id: 'test_card_on_file', type: 'card', label: (globalThis.PlatformLanguage?.text("payment-intake","m_176d224f76f11e","Visa ending in 4242") ?? "Visa ending in 4242"), detail: `${name} card on file`, brand: 'Visa', last4: '4242' });
    if (methods.ach) saved.push({ id: 'test_ach_on_file', type: 'ach', label: (globalThis.PlatformLanguage?.text("payment-intake","m_8ac3a593a96e78","Bank account ending in 6789") ?? "Bank account ending in 6789"), detail: `${name} ACH on file`, bank: 'Test Bank', last4: '6789' });
    return saved;
  }
  // ── Provider tokenization ────────────────────────────────────────────────
  // options.tokenization switches the card/bank fields into a tokenizing
  // element: the raw values are exchanged for a payment_method_id BEFORE
  // onSubmit runs, and the sensitive inputs are cleared. Without it the modal
  // behaves exactly as before (raw fields passed through to onSubmit).
  function normalizeTokenization(value){
    if (!value || typeof value !== 'object') return null;
    const mode = cleanText(value.mode).toLowerCase();
    if (mode !== 'mock' && mode !== 'forward') return null;
    return {
      mode,
      createPaymentMethod: typeof value.createPaymentMethod === 'function' ? value.createPaymentMethod : null,
      sdkUrl: cleanText(value.sdkUrl || value.sdk_url),
      publicKey: cleanText(value.publicKey || value.public_key)
    };
  }
  function normalizeSurcharge(value){
    if (!value || typeof value !== 'object' || value.enabled !== true) return null;
    return {
      enabled: true,
      mode: cleanText(value.mode) || 'card_only',
      quote: typeof value.quote === 'function' ? value.quote : null
    };
  }

  // ── Forward SDK scaffold (activates ONLY when tokenization.mode === "forward").
  // Untestable until sandbox keys exist, so every step is defensive: the SDK
  // loads once from the configured URL, the element mounts into the existing
  // card-field container, and any failure surfaces as a normal modal error.
  const forwardSdk = { promise: null };
  function loadForwardSdk(url){
    if (root.Forward) return Promise.resolve(root.Forward);
    if (forwardSdk.promise) return forwardSdk.promise;
    forwardSdk.promise = new Promise((resolve, reject) => {
      const src = cleanText(url) || 'https://sandbox-cdn.pci.getfwd.com/sdk/forward.js';
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => root.Forward ? resolve(root.Forward) : reject(new Error('Secure card entry could not be loaded.'));
      script.onerror = () => { forwardSdk.promise = null; reject(new Error('Secure card entry could not be loaded.')); };
      document.head.appendChild(script);
    });
    return forwardSdk.promise;
  }
  async function mountForwardElement(ctx){
    const tokenization = ctx.options.tokenization;
    if (!tokenization || tokenization.mode !== 'forward') return;
    const container = host(ctx).querySelector('[data-fmpi-forward-element]');
    if (!container || container.dataset.fmpiForwardMounted === '1') return;
    try {
      const sdk = await loadForwardSdk(tokenization.sdkUrl);
      const client = typeof sdk === 'function' ? sdk(tokenization.publicKey) : (sdk.init ? sdk.init(tokenization.publicKey) : sdk);
      const elements = client && typeof client.elements === 'function' ? client.elements() : client;
      const kind = ctx.method === 'ach' ? 'bank' : 'card';
      const element = elements && typeof elements.create === 'function' ? elements.create(kind) : null;
      if (!element || typeof element.mount !== 'function') throw new Error('Secure card entry could not be initialized.');
      element.mount(container);
      container.dataset.fmpiForwardMounted = '1';
      ctx.forwardElement = element;
      ctx.forwardClient = client;
      ctx.forwardElementComplete = false;
      if (typeof element.on === 'function') {
        element.on('change', (event) => {
          ctx.forwardElementComplete = !event || event.complete !== false;
          updateSubmitState(ctx);
        });
      } else {
        ctx.forwardElementComplete = true;
      }
      updateSubmitState(ctx);
    } catch (error) {
      ctx.error = cleanText(error?.message) || 'Secure card entry could not be loaded.';
      render(ctx);
    }
  }
  async function exchangeForwardPaymentMethod(ctx){
    const tokenization = ctx.options.tokenization;
    if (!ctx.forwardElement || !tokenization?.createPaymentMethod) {
      throw new Error('Secure card entry is not ready yet.');
    }
    // The mount's callback creates the payment-method intent server-side and
    // returns {client_secret}; the element exchanges it for a payment method.
    const intent = await tokenization.createPaymentMethod({ type: ctx.method === 'ach' ? 'bank' : 'card' });
    const secret = cleanText(intent?.intent?.client_secret || intent?.client_secret);
    const element = ctx.forwardElement;
    const client = ctx.forwardClient;
    const exchange = (element && typeof element.confirm === 'function' && ((s) => element.confirm(s)))
      || (client && typeof client.confirmPaymentMethodIntent === 'function' && ((s) => client.confirmPaymentMethodIntent(s, { element })))
      || (client && typeof client.createPaymentMethod === 'function' && ((s) => client.createPaymentMethod({ element, client_secret: s })));
    if (!exchange) {
      const direct = cleanText(intent?.intent?.payment_method_id || intent?.payment_method_id);
      if (direct) return { payment_method_id: direct, brand: cleanText(intent?.payment_method?.brand), last4: cleanText(intent?.payment_method?.last4) };
      throw new Error('Secure card entry could not tokenize this payment method.');
    }
    const result = await exchange(secret);
    const paymentMethodId = cleanText(result?.payment_method_id || result?.payment_method?.id || result?.id);
    if (!paymentMethodId) throw new Error(cleanText(result?.error?.message) || 'The payment method could not be tokenized.');
    return { payment_method_id: paymentMethodId, brand: cleanText(result?.brand || result?.payment_method?.brand), last4: cleanText(result?.last4 || result?.payment_method?.last4) };
  }

  function normalizeHex(value, fallback){
    let text = cleanText(value);
    if (!text) return fallback;
    if (!text.startsWith('#')) text = `#${text}`;
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  }
  function hexToRgbCsv(value){
    const hex = normalizeHex(value, '#2563eb');
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)].join(',');
  }
  function defaultThemeColor(name, fallback){
    const styles = getComputedStyle(document.documentElement);
    return normalizeHex(styles.getPropertyValue(name), fallback);
  }
  function ensureStyles(){
    if (document.getElementById('firstmate-payment-intake-styles')) return;
    const style = document.createElement('style');
    style.id = 'firstmate-payment-intake-styles';
    style.textContent = `
.fmpi-host{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;background:rgba(15,23,42,.58);padding:20px}
.fmpi-inline-host{display:block;width:100%}
.fmpi-modal{--fmpi-primary:#2563eb;--fmpi-primary-rgb:37,99,235;--fmpi-secondary:#111827;--fmpi-on-primary:#fff;width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border-radius:10px;background:#fff;box-shadow:0 24px 80px rgba(15,23,42,.30);padding:22px;display:grid;gap:18px;color:#111827;font-family:Inter,Arial,sans-serif;transition:min-height .22s ease}
.fmpi-inline-host .fmpi-modal{width:100%;max-height:none;box-shadow:none;border:0;padding:0;overflow:visible}
.fmpi-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.fmpi-head strong{display:block;font-size:20px}.fmpi-head span{display:block;margin-top:3px;color:#667085;font-size:13px;line-height:1.4}.fmpi-close{border:0;border-radius:7px;width:36px;height:36px;background:var(--fmpi-secondary);color:#fff;cursor:pointer}
.fmpi-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(310px,.95fr);gap:18px;align-items:start}.fmpi-main,.fmpi-side{display:grid;gap:14px;align-content:start}.fmpi-amount{border:1px solid rgba(var(--fmpi-primary-rgb),.18);border-radius:8px;background:rgba(var(--fmpi-primary-rgb),.06);padding:18px}.fmpi-label{display:block;color:#667085;font-size:12px;font-weight:900;text-transform:uppercase}.fmpi-amount strong{display:block;margin-top:3px;font-size:38px;line-height:1}.fmpi-amount small{display:block;margin-top:4px;color:#667085;font-size:12px}.fmpi-custom-amount{display:grid;gap:7px}.fmpi-custom-amount input{width:100%;border:1px solid #d0d5dd;border-radius:7px;padding:11px 12px;font:inherit}
.fmpi-methods,.fmpi-saved{display:grid;gap:10px}.fmpi-method,.fmpi-saved-method{display:flex;align-items:center;gap:10px;border:1px solid #e4e7ec;border-radius:8px;background:#fff;color:#111827;padding:12px;text-align:left;cursor:pointer}.fmpi-method:hover,.fmpi-saved-method:hover,.fmpi-method.active,.fmpi-saved-method.active{border-color:rgba(var(--fmpi-primary-rgb),.42);box-shadow:0 0 0 3px rgba(var(--fmpi-primary-rgb),.10);background:rgba(var(--fmpi-primary-rgb),.04)}.fmpi-method span,.fmpi-saved-method span{display:block}.fmpi-method small,.fmpi-saved-method small{display:block;color:#667085;font-size:12px;margin-top:2px}.fmpi-icon{position:relative;width:32px;height:32px;border-radius:8px;background:rgba(var(--fmpi-primary-rgb),.08);display:grid;place-items:center;color:var(--fmpi-primary);font-weight:950;flex:0 0 auto}.fmpi-icon.card:before{content:"$"}.fmpi-icon.bank:before{content:"";position:absolute;left:7px;right:7px;top:8px;height:4px;background:currentColor;clip-path:polygon(50% 0,100% 100%,0 100%)}.fmpi-icon.bank:after{content:"";position:absolute;left:8px;right:8px;bottom:8px;height:11px;background:linear-gradient(currentColor 0 0) left 2px top 3px/3px 8px no-repeat,linear-gradient(currentColor 0 0) center top 3px/3px 8px no-repeat,linear-gradient(currentColor 0 0) right 2px top 3px/3px 8px no-repeat,linear-gradient(currentColor 0 0) left bottom/100% 2px no-repeat}
.fmpi-pane{display:grid;gap:12px;animation:fmpiFade .22s ease-out both}.fmpi-pane h3,.fmpi-form h3{margin:0;color:var(--fmpi-secondary)}.fmpi-details{display:grid;gap:8px}.fmpi-detail{display:flex;justify-content:space-between;gap:12px;border:1px solid #e4e7ec;border-radius:8px;background:#fff;padding:12px}.fmpi-detail span{color:#667085;font-size:12px;font-weight:900;text-transform:uppercase}.fmpi-detail strong{text-align:right}
.fmpi-form{display:grid;gap:14px;border:1px solid #e4e7ec;border-radius:8px;background:#fff;padding:14px}.fmpi-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fmpi-field{display:grid;gap:6px}.fmpi-field.wide{grid-column:1/-1}.fmpi-field span,.fmpi-check span{color:#667085;font-size:12px;font-weight:900;text-transform:uppercase}.fmpi-field input,.fmpi-field select{width:100%;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#111827;padding:10px 11px;font:inherit}.fmpi-field input:focus,.fmpi-field select:focus{outline:0;border-color:rgba(var(--fmpi-primary-rgb),.48);box-shadow:0 0 0 3px rgba(var(--fmpi-primary-rgb),.10)}.fmpi-expiry{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fmpi-check{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;color:#475467;font-size:13px;line-height:1.35}.fmpi-check span{text-transform:none;font-weight:700}.fmpi-error{border:1px solid rgba(220,38,38,.24);border-radius:8px;background:#fef2f2;color:#991b1b;padding:10px 12px;font-size:13px;font-weight:800}.fmpi-actions{display:flex;justify-content:flex-end;gap:10px}.fmpi-primary,.fmpi-secondary{border-radius:8px;padding:10px 13px;font-size:13px;font-weight:900;cursor:pointer}.fmpi-primary{border:1px solid var(--fmpi-secondary);background:var(--fmpi-secondary);color:#fff}.fmpi-primary:disabled{opacity:.5;cursor:not-allowed;background:#98a2b3;border-color:#98a2b3}.fmpi-secondary{border:1px solid #d0d5dd;background:#fff;color:#344054}.fmpi-success{text-align:center;padding:30px 0;display:grid;gap:10px;justify-items:center}.fmpi-success svg{width:68px;height:68px;color:#10b981}.fmpi-success circle{fill:rgba(16,185,129,.10);stroke:currentColor;stroke-width:3}.fmpi-success path{fill:none;stroke:currentColor;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}.fmpi-spinner{width:32px;height:32px;border:4px solid rgba(var(--fmpi-primary-rgb),.18);border-top-color:var(--fmpi-primary);border-radius:999px;animation:fmpiSpin .7s linear infinite}
.fmpi-surcharge{display:flex;justify-content:space-between;gap:12px;border:1px solid rgba(var(--fmpi-primary-rgb),.18);border-radius:8px;background:rgba(var(--fmpi-primary-rgb),.04);padding:10px 12px;font-size:13px;color:#475467}.fmpi-surcharge strong{color:#111827}.fmpi-surcharge small{display:block;color:#667085;font-size:11px;margin-top:2px}
.fmpi-provider-element{border:1px solid #d0d5dd;border-radius:7px;background:#fff;padding:10px 11px;min-height:44px}
@keyframes fmpiFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes fmpiSpin{to{transform:rotate(360deg)}}@media(max-width:760px){.fmpi-grid{grid-template-columns:1fr}.fmpi-fields{grid-template-columns:1fr}.fmpi-modal{width:100%;padding:18px}#rOverlay .mn-mobile-payment-intake-view .fmpi-modal{padding:14px 12px;gap:12px}#rOverlay .mn-mobile-payment-intake-view .fmpi-head{gap:8px}#rOverlay .mn-mobile-payment-intake-view .fmpi-head strong{font-size:18px}#rOverlay .mn-mobile-payment-intake-view .fmpi-head span{margin-top:2px;font-size:12px}#rOverlay .mn-mobile-payment-intake-view .fmpi-grid{gap:12px}#rOverlay .mn-mobile-payment-intake-view .fmpi-main,#rOverlay .mn-mobile-payment-intake-view .fmpi-side{gap:10px}#rOverlay .mn-mobile-payment-intake-view .fmpi-amount{padding:12px;border-radius:10px}#rOverlay .mn-mobile-payment-intake-view .fmpi-custom-amount{gap:5px}#rOverlay .mn-mobile-payment-intake-view .fmpi-custom-amount input{padding:10px 11px;font-size:18px}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved,#rOverlay .mn-mobile-payment-intake-view .fmpi-methods{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved>.fmpi-label{grid-column:1/-1}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved-method,#rOverlay .mn-mobile-payment-intake-view .fmpi-method{min-width:0;min-height:66px;padding:8px;gap:7px;border-radius:10px}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved-method>span,#rOverlay .mn-mobile-payment-intake-view .fmpi-method>span{min-width:0}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved-method strong,#rOverlay .mn-mobile-payment-intake-view .fmpi-method strong{display:block;font-size:11px;line-height:1.2}#rOverlay .mn-mobile-payment-intake-view .fmpi-saved-method small,#rOverlay .mn-mobile-payment-intake-view .fmpi-method small{font-size:10px;line-height:1.2}#rOverlay .mn-mobile-payment-intake-view .fmpi-icon{width:28px;height:28px;border-radius:7px}#rOverlay .mn-mobile-payment-intake-view .fmpi-form{padding:12px;gap:10px}#rOverlay .mn-mobile-payment-intake-view .fmpi-form h3{font-size:16px}.fmpi-actions .fmpi-primary{min-height:40px}}
`;
    document.head.appendChild(style);
  }
  function host(ctx = state.active){
    if (ctx?.container) return ctx.container;
    let node = document.getElementById('firstmatePaymentIntakeHost');
    if (!node) {
      node = document.createElement('div');
      node.id = 'firstmatePaymentIntakeHost';
      document.body.appendChild(node);
    }
    return node;
  }
  function normalizedOptions(options = {}){
    const methods = normalizeMethods(options.methods || options.allowedMethods);
    const amountCents = Number.isFinite(Number(options.amountCents)) ? Math.max(0, Math.round(Number(options.amountCents))) : null;
    const primaryColor = normalizeHex(options.primaryColor || options.brandColor || options.theme?.primary || defaultThemeColor('--cp-primary', '#2563eb'), '#2563eb');
    const secondaryColor = normalizeHex(options.secondaryColor || options.theme?.secondary || defaultThemeColor('--cp-secondary', '#111827'), '#111827');
    return {
      title: cleanText(options.title || (globalThis.PlatformLanguage?.text("payment-intake","m_377f336f0d4d29","Take payment") ?? "Take payment")),
      description: cleanText(options.description || ''),
      amountLabel: cleanText(options.amountLabel || 'Payment amount'),
      amountCents,
      allowCustomAmount: options.allowCustomAmount === true || amountCents == null,
      customAmountPlaceholder: cleanText(options.customAmountPlaceholder || '0.00'),
      amountProvider: typeof options.amountProvider === 'function' ? options.amountProvider : null,
      detailsOnly: options.detailsOnly === true || cleanText(options.layout).toLowerCase() === 'details',
      methods,
      details: Array.isArray(options.details) ? options.details : [],
      contact: options.contact || null,
      tokenization: normalizeTokenization(options.tokenization),
      surcharge: normalizeSurcharge(options.surcharge),
      // With provider tokenization active, saved methods come only from real
      // data; the hardcoded stubs remain the legacy no-provider fallback.
      savedMethods: Array.isArray(options.savedMethods)
        ? options.savedMethods
        : (normalizeTokenization(options.tokenization) ? [] : fakeSavedMethods(options, methods)),
      savePaymentMethodDefault: options.savePaymentMethodDefault === true,
      allowSavePaymentMethod: options.allowSavePaymentMethod !== false,
      requireAchAuthorization: options.requireAchAuthorization !== false,
      submitLabel: cleanText(options.submitLabel || 'Run payment'),
      onSubmit: typeof options.onSubmit === 'function' ? options.onSubmit : async () => ({ ok: true }),
      onSuccess: typeof options.onSuccess === 'function' ? options.onSuccess : null,
      successTitle: cleanText(options.successTitle || 'Payment went through'),
      successDescription: cleanText(options.successDescription || ''),
      successActions: Array.isArray(options.successActions) ? options.successActions : [],
      primaryColor,
      secondaryColor,
      primaryRgb: hexToRgbCsv(primaryColor)
    };
  }
  function currentAmount(ctx){
    if (ctx.options.amountProvider) {
      const provided = Number(ctx.options.amountProvider());
      return Number.isFinite(provided) ? Math.max(0, Math.round(provided)) : 0;
    }
    const input = host(ctx).querySelector('[data-fmpi-custom-amount]');
    return ctx.options.allowCustomAmount && input ? centsFromAmount(input.value) : Math.max(0, Number(ctx.options.amountCents || 0));
  }
  function amountHtml(ctx){
    const opts = ctx.options;
    if (opts.allowCustomAmount) {
      const value = opts.amountCents ? (opts.amountCents / 100).toFixed(2) : '';
      return `<div class="fmpi-amount"><label class="fmpi-custom-amount"><span class="fmpi-label">${escapeHtml(opts.amountLabel)}</span><input type="text" inputmode="decimal" data-fmpi-custom-amount placeholder="${escapeHtml(opts.customAmountPlaceholder)}" value="${escapeHtml(value)}"></label></div>`;
    }
    return `<div class="fmpi-amount"><span class="fmpi-label">${escapeHtml(opts.amountLabel)}</span><strong>${escapeHtml(money(opts.amountCents, '$0.00'))}</strong></div>`;
  }
  function selectedMethodKind(ctx){
    if (ctx.savedMethodId) {
      const saved = ctx.options.savedMethods.find((item) => item.id === ctx.savedMethodId) || {};
      return cleanText(saved.type).toLowerCase() === 'ach' || cleanText(saved.type).toLowerCase() === 'bank' ? 'bank' : 'card';
    }
    return ctx.method === 'ach' ? 'bank' : ctx.method === 'card' ? 'card' : '';
  }
  function surchargeHtml(ctx){
    if (!ctx.options.surcharge || !selectedMethodKind(ctx)) return '';
    const quote = ctx.surchargeQuote;
    if (!quote || !(quote.surcharge_cents > 0)) return '';
    return `<div class="fmpi-surcharge" data-fmpi-surcharge><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_a06abf2eed89c1","Card processing surcharge") ?? "Card processing surcharge")}<small>${(globalThis.PlatformLanguage?.text("payment-intake","m_895a5d9dcb6389","Passed through at cost") ?? "Passed through at cost")}</small></span><strong>${((v0,v1) => globalThis.PlatformLanguage?.text("payment-intake","m_b1b2ec6a817233",`${v0} &middot; total ${v1}`,{v0,v1}) ?? `${v0} &middot; total ${v1}`)(escapeHtml(money(quote.surcharge_cents, '$0.00')),escapeHtml(money(quote.total_cents, '$0.00')))}</strong></div>`;
  }
  function refreshSurcharge(ctx){
    const surcharge = ctx.options.surcharge;
    if (!surcharge || !surcharge.quote) return;
    const method = selectedMethodKind(ctx);
    const amount = currentAmount(ctx);
    if (!method || amount <= 0) {
      if (ctx.surchargeQuote) { ctx.surchargeQuote = null; renderSurchargeLine(ctx); }
      return;
    }
    const key = `${amount}:${method}`;
    if (ctx.surchargeKey === key) return;
    ctx.surchargeKey = key;
    Promise.resolve(surcharge.quote(amount, method)).then((quote) => {
      if (ctx.surchargeKey !== key) return;
      const surchargeCents = Math.max(0, Math.round(Number(quote?.surcharge_cents ?? quote?.surchargeCents) || 0));
      ctx.surchargeQuote = { amount_cents: amount, surcharge_cents: surchargeCents, total_cents: amount + surchargeCents, method };
      renderSurchargeLine(ctx);
    }).catch(() => {
      if (ctx.surchargeKey !== key) return;
      ctx.surchargeQuote = null;
      renderSurchargeLine(ctx);
    });
  }
  function renderSurchargeLine(ctx){
    const hostNode = host(ctx);
    const existing = hostNode.querySelector('[data-fmpi-surcharge]');
    const markup = surchargeHtml(ctx);
    if (existing) {
      if (markup) existing.outerHTML = markup;
      else existing.remove();
      return;
    }
    if (!markup) return;
    const amountNode = hostNode.querySelector('.fmpi-amount');
    if (amountNode) amountNode.insertAdjacentHTML('afterend', markup);
  }
  function detailsHtml(ctx){
    const opts = ctx.options;
    if (!opts.details.length) return '';
    return `<div class="fmpi-details">${opts.details.map((item) => `<div class="fmpi-detail"><span>${escapeHtml(item.label || item.name || '')}</span><strong>${escapeHtml(item.value || item.detail || '')}</strong></div>`).join('')}</div>`;
  }
  function methodHtml(ctx){
    const opts = ctx.options;
    const methods = [];
    if (opts.methods.card) methods.push(['card', 'Card', 'Credit or debit card', 'card']);
    if (opts.methods.ach) methods.push(['ach', 'ACH', 'Bank transfer', 'bank']);
    return `<div class="fmpi-methods">${methods.map(([id, label, detail, icon]) => `<button type="button" class="fmpi-method ${ctx.method === id ? 'active' : ''}" data-fmpi-method="${id}" aria-pressed="${ctx.method === id ? 'true' : 'false'}"><i class="fmpi-icon ${icon}"></i><span><strong>${label}</strong><small>${detail}</small></span></button>`).join('')}</div>`;
  }
  function savedHtml(ctx){
    const saved = ctx.options.savedMethods.filter((item) => ctx.options.methods[cleanText(item.type).toLowerCase()]);
    if (!saved.length) return '';
    return `<div class="fmpi-saved"><span class="fmpi-label">${(globalThis.PlatformLanguage?.text("payment-intake","m_4164e71993536a","Saved payment methods") ?? "Saved payment methods")}</span>${String(saved.map((item) => `<button type="button" class="fmpi-saved-method ${ctx.savedMethodId === item.id ? 'active' : ''}" data-fmpi-saved="${escapeHtml(item.id)}"><i class="fmpi-icon ${item.type === 'ach' ? 'bank' : 'card'}"></i><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail || '')}</small></span></button>`).join(''))}</div>`;
  }
  function formHtml(ctx){
    if (!ctx.method && !ctx.savedMethodId) return `<div class="fmpi-pane"><h3>${(globalThis.PlatformLanguage?.text("payment-intake","m_eabc1e9c634739","Payment details") ?? "Payment details")}</h3>${String(detailsHtml(ctx) || '<p style="margin:0;color:#667085">Choose a payment method to continue.</p>')}</div>`;
    if (ctx.savedMethodId) {
      const saved = ctx.options.savedMethods.find((item) => item.id === ctx.savedMethodId) || {};
      return `<div class="fmpi-pane"><form class="fmpi-form" data-fmpi-form><h3>${String(escapeHtml(saved.label || 'Saved payment method'))}</h3><label class="fmpi-check"><input type="checkbox" data-fmpi-save ${String(ctx.save ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_9d33b52c6133f4","Keep this payment method available for future payments.") ?? "Keep this payment method available for future payments.")}</span></label>${String(ctx.error ? `<div class="fmpi-error">${escapeHtml(ctx.error)}</div>` : '')}<div class="fmpi-actions"><button type="submit" class="fmpi-primary" data-fmpi-submit disabled>${String(escapeHtml(ctx.options.submitLabel))}</button></div></form></div>`;
    }
    if (ctx.options.tokenization?.mode === 'forward') {
      // Forward SDK path: the provider element owns the sensitive inputs; we
      // never see raw card/bank data. Mounted after render (see render()).
      return `<div class="fmpi-pane"><form class="fmpi-form" data-fmpi-form><h3>${ctx.method === 'ach' ? 'ACH payment' : 'Card payment'}</h3><div class="fmpi-field wide"><span>${ctx.method === 'ach' ? 'Bank details' : 'Card details'}</span><div class="fmpi-provider-element" data-fmpi-forward-element></div></div>${ctx.options.allowSavePaymentMethod ? `<label class="fmpi-check"><input type="checkbox" data-fmpi-save ${String(ctx.save ? 'checked' : '')}><span>${((v1) => globalThis.PlatformLanguage?.text("payment-intake","m_296905a8811757",`Save this ${v1} for future payments.`,{v1}) ?? `Save this ${v1} for future payments.`)(ctx.method === 'ach' ? 'bank account' : 'card')}</span></label>` : ''}${ctx.error ? `<div class="fmpi-error">${escapeHtml(ctx.error)}</div>` : ''}<div class="fmpi-actions"><button type="submit" class="fmpi-primary" data-fmpi-submit disabled>${escapeHtml(ctx.options.submitLabel)}</button></div></form></div>`;
    }
    if (ctx.method === 'ach') {
      return `<div class="fmpi-pane"><form class="fmpi-form" data-fmpi-form><h3>${(globalThis.PlatformLanguage?.text("payment-intake","m_474c1095f06ee2","ACH payment") ?? "ACH payment")}</h3><div class="fmpi-fields"><label class="fmpi-field wide"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_8506755b32ab8f","Account holder name") ?? "Account holder name")}</span><input type="text" autocomplete="name" data-fmpi-field="achName" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_4fce17318219ed","Jordan Smith") ?? "Jordan Smith")}"></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_308a9ca41691ca","Routing number") ?? "Routing number")}</span><input type="text" inputmode="numeric" data-fmpi-field="routing" placeholder="021000021" maxlength="9"></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_a2ee1cfe84c2c3","Account type") ?? "Account type")}</span><select data-fmpi-field="accountType"><option value="checking">${(globalThis.PlatformLanguage?.text("payment-intake","m_8f2aa52d7e253b","Checking") ?? "Checking")}</option><option value="savings">${(globalThis.PlatformLanguage?.text("payment-intake","m_5b503699d80ad2","Savings") ?? "Savings")}</option></select></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_b028fb8bb8ac0a","Account number") ?? "Account number")}</span><input type="password" inputmode="numeric" data-fmpi-field="account" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_b1011e3f2fdec3","4-17 digits") ?? "4-17 digits")}"></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_3e51d57ae99ede","Confirm account") ?? "Confirm account")}</span><input type="password" inputmode="numeric" data-fmpi-field="accountConfirm" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_ec1fbf411120da","Retype account") ?? "Retype account")}"></label></div>${String(ctx.options.requireAchAuthorization ? '<label class="fmpi-check"><input type="checkbox" data-fmpi-field="achAuthorize"><span>I authorize this ACH debit from the bank account above for the payment amount shown.</span></label>' : '')}${String(ctx.options.allowSavePaymentMethod ? `<label class="fmpi-check"><input type="checkbox" data-fmpi-save ${ctx.save ? 'checked' : ''}><span>Save this bank account for future payments.</span></label>` : '')}${String(ctx.error ? `<div class="fmpi-error">${escapeHtml(ctx.error)}</div>` : '')}<div class="fmpi-actions"><button type="submit" class="fmpi-primary" data-fmpi-submit disabled>${String(escapeHtml(ctx.options.submitLabel))}</button></div></form></div>`;
    }
    return `<div class="fmpi-pane"><form class="fmpi-form" data-fmpi-form><h3>${(globalThis.PlatformLanguage?.text("payment-intake","m_997bb5a9e56d22","Card payment") ?? "Card payment")}</h3><div class="fmpi-fields"><label class="fmpi-field wide"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_3a7bcfa366c064","Name on card") ?? "Name on card")}</span><input type="text" autocomplete="cc-name" data-fmpi-field="cardName" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_4fce17318219ed","Jordan Smith") ?? "Jordan Smith")}"></label><label class="fmpi-field wide"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_cbbfb3da2ddfde","Card number") ?? "Card number")}</span><input type="text" inputmode="numeric" autocomplete="cc-number" data-fmpi-field="cardNumber" placeholder="4242 4242 4242 4242" maxlength="23"></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_95af41e20221e6","Expiration") ?? "Expiration")}</span><span class="fmpi-expiry"><input type="text" inputmode="numeric" autocomplete="cc-exp-month" data-fmpi-field="expMonth" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_65c801480ef4cc","MM") ?? "MM")}" maxlength="5"><input type="text" inputmode="numeric" autocomplete="cc-exp-year" data-fmpi-field="expYear" placeholder="${(globalThis.PlatformLanguage?.text("payment-intake","m_4cbe3961dabf19","YY") ?? "YY")}" maxlength="4"></span></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_7e7759fb0c36df","CVC") ?? "CVC")}</span><input type="text" inputmode="numeric" autocomplete="cc-csc" data-fmpi-field="cvc" placeholder="123" maxlength="4"></label><label class="fmpi-field"><span>${(globalThis.PlatformLanguage?.text("payment-intake","m_37e7c561258701","Billing ZIP") ?? "Billing ZIP")}</span><input type="text" inputmode="numeric" autocomplete="postal-code" data-fmpi-field="zip" placeholder="90210"></label></div>${String(ctx.options.allowSavePaymentMethod ? `<label class="fmpi-check"><input type="checkbox" data-fmpi-save ${ctx.save ? 'checked' : ''}><span>Save this card for future payments.</span></label>` : '')}${String(ctx.error ? `<div class="fmpi-error">${escapeHtml(ctx.error)}</div>` : '')}<div class="fmpi-actions"><button type="submit" class="fmpi-primary" data-fmpi-submit disabled>${String(escapeHtml(ctx.options.submitLabel))}</button></div></form></div>`;
  }
  function render(ctx){
    const opts = ctx.options;
    const style = `--fmpi-primary:${opts.primaryColor};--fmpi-primary-rgb:${opts.primaryRgb};--fmpi-secondary:${opts.secondaryColor};`;
    const closeButton = ctx.inline ? '' : ("<button type=\"button\" class=\"fmpi-close\" data-fmpi-close aria-label=\"" + (globalThis.PlatformLanguage?.text("payment-intake","m_3742924668fb10","Close") ?? "Close") + "\">x</button>");
    const checkoutHtml = opts.detailsOnly ? `<div class="fmpi-details-only">${formHtml(ctx)}</div>` : `<div class="fmpi-grid"><div class="fmpi-main">${amountHtml(ctx)}${surchargeHtml(ctx)}${savedHtml(ctx)}${methodHtml(ctx)}</div><aside class="fmpi-side">${formHtml(ctx)}</aside></div>`;
    const headHtml = opts.detailsOnly ? '' : `<div class="fmpi-head"><div><strong>${escapeHtml(opts.title)}</strong>${opts.description ? `<span>${escapeHtml(opts.description)}</span>` : ''}</div>${closeButton}</div>`;
    const content = `<div class="fmpi-modal" style="${escapeHtml(style)}" role="dialog" aria-modal="${ctx.inline ? 'false' : 'true'}">${headHtml}${ctx.step === 'success' ? successHtml(ctx) : ctx.step === 'processing' ? processingHtml(ctx) : checkoutHtml}</div>`;
    host(ctx).innerHTML = ctx.inline ? `<div class="fmpi-inline-host">${content}</div>` : `<div class="fmpi-host">${content}</div>`;
    bind(ctx);
    updateSubmitState(ctx);
    if (ctx.step === 'checkout') {
      refreshSurcharge(ctx);
      if (ctx.options.tokenization?.mode === 'forward' && ctx.method && !ctx.savedMethodId) void mountForwardElement(ctx);
    }
  }
  function processingHtml(){
    return `<div class="fmpi-success"><span class="fmpi-spinner"></span><strong>${(globalThis.PlatformLanguage?.text("payment-intake","m_c094604d7b92f1","Processing payment...") ?? "Processing payment...")}</strong><p style="margin:0;color:#667085">${(globalThis.PlatformLanguage?.text("payment-intake","m_2f639ee25d94d2","Please keep this window open.") ?? "Please keep this window open.")}</p></div>`;
  }
  function successHtml(ctx){
    return `<div class="fmpi-success"><svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25"></circle><path d="M17 29.5 24.5 37 40 20"></path></svg><h3 style="margin:0">${String(escapeHtml(ctx.options.successTitle))}</h3><p style="margin:0;color:#667085">${String(escapeHtml(ctx.options.successDescription || `${money(ctx.result?.amountCents || currentAmount(ctx), '$0.00')} was recorded.`))}</p><div class="fmpi-actions">${String(ctx.options.successActions.map((action, index) => `<button type="button" class="${action.primary ? 'fmpi-primary' : 'fmpi-secondary'}" data-fmpi-success-action="${index}">${escapeHtml(action.label || 'Done')}</button>`).join(''))}<button type="button" class="fmpi-primary" data-fmpi-close>${(globalThis.PlatformLanguage?.text("payment-intake","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div></div>`;
  }
  function field(hostNode, name){ return hostNode.querySelector(`[data-fmpi-field="${name}"]`)?.value || ''; }
  function hasRequiredInput(ctx){
    const hostNode = host(ctx);
    if (currentAmount(ctx) <= 0) return false;
    if (ctx.savedMethodId) return true;
    if (ctx.options.tokenization?.mode === 'forward' && ctx.method) return ctx.forwardElementComplete === true;
    if (ctx.method === 'ach') {
      return !!cleanText(field(hostNode, 'achName'))
        && digits(field(hostNode, 'routing')).length > 0
        && digits(field(hostNode, 'account')).length > 0
        && digits(field(hostNode, 'accountConfirm')).length > 0
        && (!ctx.options.requireAchAuthorization || !!hostNode.querySelector('[data-fmpi-field="achAuthorize"]')?.checked);
    }
    if (ctx.method === 'card') {
      return !!cleanText(field(hostNode, 'cardName'))
        && digits(field(hostNode, 'cardNumber')).length > 0
        && digits(field(hostNode, 'expMonth')).length > 0
        && digits(field(hostNode, 'expYear')).length > 0
        && digits(field(hostNode, 'cvc')).length > 0
        && digits(field(hostNode, 'zip')).length > 0;
    }
    return false;
  }
  function updateSubmitState(ctx){
    const button = host(ctx).querySelector('[data-fmpi-submit]');
    if (button) button.disabled = !hasRequiredInput(ctx);
  }
  function validate(ctx){
    const hostNode = host(ctx);
    const amount = currentAmount(ctx);
    if (amount <= 0) return 'Enter a payment amount greater than zero.';
    if (ctx.savedMethodId) return '';
    if (ctx.options.tokenization?.mode === 'forward' && ctx.method) return ctx.forwardElementComplete === true ? '' : 'Complete the payment details to continue.';
    if (ctx.method === 'ach') {
      if (!cleanText(field(hostNode, 'achName'))) return 'Enter the account holder name.';
      if (!/^\d{9}$/.test(digits(field(hostNode, 'routing')))) return 'Enter a valid 9-digit routing number.';
      const account = digits(field(hostNode, 'account'));
      if (account.length < 4 || account.length > 17) return 'Enter an account number between 4 and 17 digits.';
      if (account !== digits(field(hostNode, 'accountConfirm'))) return 'Account numbers must match.';
      if (ctx.options.requireAchAuthorization && !hostNode.querySelector('[data-fmpi-field="achAuthorize"]')?.checked) return 'Authorize the ACH debit to continue.';
      return '';
    }
    if (!cleanText(field(hostNode, 'cardName'))) return 'Enter the name on the card.';
    if (!cardNumberValid(field(hostNode, 'cardNumber'))) return 'Enter a valid card number.';
    if (!expiryValid(field(hostNode, 'expMonth'), field(hostNode, 'expYear'))) return 'Enter a valid future expiration date.';
    if (!/^\d{3,4}$/.test(digits(field(hostNode, 'cvc')))) return 'Enter a 3 or 4 digit security code.';
    if (!/^\d{5}(\d{4})?$/.test(digits(field(hostNode, 'zip')))) return 'Enter a valid billing ZIP code.';
    return '';
  }
  function payload(ctx){
    const hostNode = host(ctx);
    const saved = ctx.options.savedMethods.find((item) => item.id === ctx.savedMethodId) || null;
    return {
      amountCents: currentAmount(ctx),
      method: saved ? cleanText(saved.type) : ctx.method,
      savedPaymentMethodId: ctx.savedMethodId,
      savedPaymentMethod: saved,
      savePaymentMethod: !!hostNode.querySelector('[data-fmpi-save]')?.checked,
      contact: ctx.options.contact,
      fields: {
        cardName: field(hostNode, 'cardName'),
        cardNumber: digits(field(hostNode, 'cardNumber')),
        expMonth: digits(field(hostNode, 'expMonth')),
        expYear: digits(field(hostNode, 'expYear')),
        cvc: digits(field(hostNode, 'cvc')),
        zip: digits(field(hostNode, 'zip')),
        achName: field(hostNode, 'achName'),
        routing: digits(field(hostNode, 'routing')),
        accountLast4: digits(field(hostNode, 'account')).slice(-4),
        accountType: field(hostNode, 'accountType')
      }
    };
  }
  function clearSensitiveInputs(ctx){
    const hostNode = host(ctx);
    ['cardNumber', 'cvc', 'account', 'accountConfirm', 'routing'].forEach((name) => {
      const input = hostNode.querySelector(`[data-fmpi-field="${name}"]`);
      if (input) input.value = '';
    });
  }
  // Capture everything the submission needs from the DOM synchronously —
  // before the processing view replaces the form — including the raw values
  // tokenization will exchange. The full account number rides only in this
  // in-memory capture (the legacy payload deliberately keeps just last4).
  function captureSubmission(ctx){
    const hostNode = host(ctx);
    return { base: payload(ctx), account: digits(field(hostNode, 'account')) };
  }
  // Provider-element path: exchange the captured raw fields for a
  // payment_method_id BEFORE onSubmit sees the payload. The raw card number
  // and CVC never leave the modal except inside the tokenization call itself.
  async function finalizeSubmission(ctx, captured){
    const base = captured.base;
    const tokenization = ctx.options.tokenization;
    if (!tokenization) return base;
    base.save_method = base.savePaymentMethod === true;
    if (ctx.surchargeQuote && ctx.surchargeQuote.amount_cents === base.amountCents) {
      base.surchargeCents = ctx.surchargeQuote.surcharge_cents;
      base.totalCents = ctx.surchargeQuote.total_cents;
    }
    if (ctx.savedMethodId) {
      const saved = base.savedPaymentMethod || {};
      base.payment_method_id = cleanText(saved.provider_payment_method_id);
      base.saved_method_id = ctx.savedMethodId;
      return base;
    }
    let result;
    if (tokenization.mode === 'forward') {
      result = await exchangeForwardPaymentMethod(ctx);
    } else {
      if (!tokenization.createPaymentMethod) throw new Error('Payment tokenization is not configured.');
      const fields = base.fields || {};
      const request = base.method === 'ach'
        ? { type: 'bank', bank: {
            routing: cleanText(fields.routing),
            account: captured.account,
            account_type: cleanText(fields.accountType) || 'checking',
            name: cleanText(fields.achName)
          } }
        : { type: 'card', card: {
            number: cleanText(fields.cardNumber),
            exp_month: Number(fields.expMonth) || 0,
            exp_year: Number(fields.expYear) || 0,
            cvc: cleanText(fields.cvc),
            name: cleanText(fields.cardName),
            zip: cleanText(fields.zip)
          } };
      result = await tokenization.createPaymentMethod(request);
    }
    const pm = (result && (result.payment_method || result)) || {};
    base.payment_method_id = cleanText(result?.intent?.payment_method_id || result?.payment_method_id || pm.id);
    if (!base.payment_method_id) throw new Error('The payment method could not be tokenized.');
    base.brand = cleanText(pm.brand || result?.brand);
    base.last4 = cleanText(pm.last4 || result?.last4) || cleanText(base.fields?.cardNumber).slice(-4);
    // Tokenized submissions never carry raw card/bank data onward.
    base.fields = {
      ...base.fields,
      cardNumber: '',
      cvc: '',
      routing: '',
      cardLast4: base.last4
    };
    captured.account = '';
    return base;
  }
  function bindFormatters(ctx){
    const hostNode = host(ctx);
    const card = hostNode.querySelector('[data-fmpi-field="cardNumber"]');
    card?.addEventListener('input', () => { card.value = digits(card.value).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '); });
    const mm = hostNode.querySelector('[data-fmpi-field="expMonth"]');
    const yy = hostNode.querySelector('[data-fmpi-field="expYear"]');
    if (mm && yy) {
      mm.addEventListener('input', () => {
        const value = digits(mm.value);
        if (value.length > 2) {
          mm.value = value.slice(0, 2);
          yy.value = value.slice(2, 6);
          yy.focus();
        } else {
          mm.value = value;
          if (value.length === 2) yy.focus();
        }
      });
      yy.addEventListener('input', () => { yy.value = digits(yy.value).slice(0, 4); });
    }
  }
  function bind(ctx){
    const hostNode = host(ctx);
    hostNode.querySelectorAll('[data-fmpi-close]').forEach((btn) => btn.addEventListener('click', () => close(ctx)));
    hostNode.querySelectorAll('[data-fmpi-method]').forEach((btn) => btn.addEventListener('click', () => {
      ctx.method = cleanText(btn.dataset.fmpiMethod);
      ctx.savedMethodId = '';
      ctx.error = '';
      render(ctx);
      host(ctx).querySelector('.fmpi-side input, .fmpi-side select')?.focus();
    }));
    hostNode.querySelectorAll('[data-fmpi-saved]').forEach((btn) => btn.addEventListener('click', () => {
      ctx.savedMethodId = cleanText(btn.dataset.fmpiSaved);
      ctx.method = '';
      ctx.error = '';
      render(ctx);
    }));
    hostNode.querySelector('[data-fmpi-form]')?.addEventListener('input', () => {
      if (!ctx.error) return;
      ctx.error = '';
      hostNode.querySelector('.fmpi-error')?.remove();
    });
    hostNode.querySelector('[data-fmpi-form]')?.addEventListener('input', () => updateSubmitState(ctx));
    hostNode.querySelector('[data-fmpi-form]')?.addEventListener('change', () => updateSubmitState(ctx));
    hostNode.querySelector('[data-fmpi-custom-amount]')?.addEventListener('input', () => { updateSubmitState(ctx); refreshSurcharge(ctx); });
    hostNode.querySelector('[data-fmpi-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      ctx.error = validate(ctx);
      if (ctx.error) return render(ctx);
      // Capture the payload BEFORE the processing view replaces the form —
      // afterwards the inputs no longer exist to read.
      const captured = captureSubmission(ctx);
      if (ctx.options.tokenization) clearSensitiveInputs(ctx);
      ctx.step = 'processing';
      render(ctx);
      try {
        const submitted = await finalizeSubmission(ctx, captured);
        const result = await ctx.options.onSubmit(submitted);
        ctx.result = { ...(result || {}), amountCents: submitted.amountCents };
        ctx.step = 'success';
        await ctx.options.onSuccess?.(ctx.result, submitted);
        render(ctx);
      } catch (error) {
        ctx.step = 'checkout';
        ctx.error = cleanText(error?.message || 'Payment could not be processed.');
        render(ctx);
      }
    });
    hostNode.querySelectorAll('[data-fmpi-success-action]').forEach((btn) => btn.addEventListener('click', () => {
      const action = ctx.options.successActions[Number(btn.dataset.fmpiSuccessAction || 0)];
      action?.onClick?.(ctx.result);
    }));
    bindFormatters(ctx);
    updateSubmitState(ctx);
  }
  function createContext(options = {}, container = null){
    ensureStyles();
    const opts = normalizedOptions(options);
    return {
      options: opts,
      step: 'checkout',
      method: '',
      savedMethodId: '',
      save: opts.savePaymentMethodDefault,
      error: '',
      result: null,
      surchargeQuote: null,
      surchargeKey: '',
      forwardElement: null,
      forwardClient: null,
      forwardElementComplete: false,
      container,
      inline: !!container
    };
  }
  function open(options = {}){
    const ctx = createContext(options);
    state.active = ctx;
    render(ctx);
    return {
      close: () => close(ctx),
      context: ctx,
      render: () => render(ctx),
      setMethod: (method) => { ctx.method = cleanText(method); ctx.savedMethodId = ''; ctx.error = ''; render(ctx); },
      setSavedMethod: (id) => { ctx.savedMethodId = cleanText(id); ctx.method = ''; ctx.error = ''; render(ctx); },
      updateSubmitState: () => updateSubmitState(ctx)
    };
  }
  function mount(container, options = {}){
    if (!container) throw new Error('Payment intake mount requires a container.');
    const ctx = createContext(options, container);
    render(ctx);
    return {
      close: () => close(ctx),
      context: ctx,
      render: () => render(ctx),
      setMethod: (method) => { ctx.method = cleanText(method); ctx.savedMethodId = ''; ctx.error = ''; render(ctx); },
      setSavedMethod: (id) => { ctx.savedMethodId = cleanText(id); ctx.method = ''; ctx.error = ''; render(ctx); },
      updateSubmitState: () => updateSubmitState(ctx)
    };
  }
  function close(ctx = state.active){
    host(ctx).innerHTML = '';
    if (!ctx || state.active === ctx) state.active = null;
  }

  root.FirstMatePaymentIntake = { open, mount, close };
})();
