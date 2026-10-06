/* libraries/forms-embed/firstmate-forms-embed.js
 * Public renderer for FirstMate forms.
 *
 *   <script src=".../libraries/forms-embed/firstmate-forms-embed.js" data-form="FORM_KEY"></script>
 *   FirstMateForms.render({ key, target })                       // live form
 *   FirstMateForms.render({ definition, name, target, transport }) // editor preview of a draft
 *
 * A form is steps of blocks. Every block kind has one renderer below; the
 * server validates the same definition, so nothing here is trusted. The form
 * mounts in a shadow root so host-page CSS cannot restyle it. Host pages can
 * listen for `fm-form:ready`, `fm-form:step` and `fm-form:submitted` on the
 * mount element.
 *
 * Keep this file ASCII-only (use \u escapes): it is served to pages of any
 * character encoding.
 */
(function(){
  const root = window;
  if (root.FirstMateForms) return;
  const SCRIPT = document.currentScript;
  const SCRIPT_SRC = SCRIPT?.src || '';
  const FONT_URLS = {
    Montserrat: 'Montserrat:wght@500;600;700;800',
    Inter: 'Inter:wght@400;500;600;700',
    Roboto: 'Roboto:wght@400;500;700',
    'Open Sans': 'Open+Sans:wght@400;600;700',
    Lato: 'Lato:wght@400;700;900',
    Poppins: 'Poppins:wght@400;500;600;700',
    'Source Sans 3': 'Source+Sans+3:wght@400;600;700'
  };

  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  // Only plain http(s), same-site or inline image URLs, and nothing that could break out of a CSS url().
  const safeUrl = (value) => /^(https?:\/\/|data:image\/|\/[^/])/i.test(clean(value)) && !/[\s'"()<>\\]/.test(clean(value)) ? clean(value) : '';

  // --- Conditions (mirrors v1/forms/contracts.ts) ---------------------------
  function answerAt(answers, path){
    let value = answers;
    for (const part of String(path).split('.')) {
      if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }
  const isEmpty = (value) => value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
  function conditionMatches(condition, answers){
    const actual = answerAt(answers, condition.param);
    const expected = condition.value;
    switch (condition.op) {
      case 'answered': return !isEmpty(actual);
      case 'empty': return isEmpty(actual);
      case 'in': return Array.isArray(expected) && (Array.isArray(actual) ? actual.some((entry) => expected.includes(entry)) : expected.includes(actual));
      case 'neq': return Array.isArray(actual) ? !actual.includes(expected) : String(actual ?? '') !== String(expected ?? '');
      case 'gt': return Number(actual) > Number(expected);
      case 'gte': return Number(actual) >= Number(expected);
      case 'lt': return Number(actual) < Number(expected);
      case 'lte': return Number(actual) <= Number(expected);
      default: return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '') === String(expected ?? '');
    }
  }
  const conditionsMatch = (conditions, answers) => (conditions || []).every((condition) => conditionMatches(condition, answers));

  // --- Transport ------------------------------------------------------------
  function defaultBaseUrl(){
    try {
      const src = new URL(SCRIPT_SRC || location.href, location.href);
      if (src.hostname === location.hostname && (src.hostname === 'localhost' || src.hostname === '127.0.0.1') && src.port !== '3101') return `${src.protocol}//${src.hostname}:3101/v1/forms`;
      return `${src.origin}/v1/forms`;
    } catch {
      return `${location.origin}/v1/forms`;
    }
  }
  async function call(baseUrl, path, options = {}){
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
      method: options.method || 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(clean(data?.message) || (res.status === 429 ? 'Too many requests. Please try again in a moment.' : 'Something went wrong. Please try again.'));
      error.status = res.status;
      error.code = clean(data?.error);
      error.issues = Array.isArray(data?.details?.issues) ? data.details.issues : [];
      throw error;
    }
    return data;
  }
  function liveTransport(baseUrl, key){
    const base = `public/${encodeURIComponent(key)}`;
    return {
      load: () => call(baseUrl, base).then((data) => data.form),
      availability: (item, date, address) => call(baseUrl, `${base}/availability?${new URLSearchParams({ item_id: item.id, date, ...(address ? { address } : {}) })}`),
      measure: (item, address) => call(baseUrl, `${base}/measurement`, { method: 'POST', body: { item_id: item.id, address } }),
      submit: (payload) => call(baseUrl, `${base}/submit`, { method: 'POST', body: payload }),
      // Anonymous counts of views, starts and steps reached. Best effort; never blocks the visitor.
      activity: (type, stepId) => { try { fetch(`${baseUrl.replace(/\/+$/, '')}/${base}/activity`, { method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...(stepId ? { step_id: stepId } : {}) }) }).catch(() => {}); } catch {} }
    };
  }

  // --- Assets ---------------------------------------------------------------
  function siblingUrl(path){
    try { return new URL(path, SCRIPT_SRC || new URL('/libraries/forms-embed/firstmate-forms-embed.js', location.href)).href; } catch { return path; }
  }
  let pickerLoading = null;
  function ensurePicker(){
    if (root.FirstMateAvailability) return Promise.resolve();
    return pickerLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = siblingUrl('../appointment-booking/availability.js');
      script.onload = resolve;
      script.onerror = () => { pickerLoading = null; script.remove(); reject(new Error('Could not load the calendar.')); };
      document.head.append(script);
    });
  }
  function ensureFont(font){
    // Company fonts are not limited to the built-in list; anything else is requested by family name.
    const spec = FONT_URLS[font] || (/^[A-Za-z0-9 ]{1,80}$/.test(font) ? `${font.replace(/ /g, '+')}:wght@400;500;600;700;800` : '');
    if (!spec || document.querySelector(`link[data-fm-form-font="${CSS.escape(font)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
    link.dataset.fmFormFont = font;
    document.head.appendChild(link);
  }
  function readableOn(hex){
    const match = /^#([0-9a-f]{6})$/i.exec(clean(hex));
    if (!match) return '#ffffff';
    const [r, g, b] = [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16) / 255).map((channel) => channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111827' : '#ffffff';
  }

  const CSS_TEXT = `
:host{display:block;max-width:100%}
*{box-sizing:border-box}
.ff{--ff-primary:#2563eb;--ff-on-primary:#fff;--ff-text:#111827;--ff-bg:#fff;--ff-radius:12px;--ff-field-radius:9px;
  --ff-muted:color-mix(in srgb,var(--ff-text) 62%,var(--ff-bg));--ff-line:color-mix(in srgb,var(--ff-text) 16%,var(--ff-bg));--ff-soft:color-mix(in srgb,var(--ff-primary) 7%,var(--ff-bg));
  container-type:inline-size;max-width:720px;margin:0 auto;background:var(--ff-bg);color:var(--ff-text);border:1px solid var(--ff-line);border-radius:var(--ff-radius);
  box-shadow:0 14px 40px rgba(15,23,42,.08);overflow:hidden;font-size:15px;line-height:1.5;text-align:left}
.ff.wide{max-width:920px}
.ff[data-corners=square]{--ff-radius:0px;--ff-field-radius:0px}
.ff[data-corners=round]{--ff-radius:20px;--ff-field-radius:14px}
.ff[data-header=band] .ff-head{margin:-28px -28px 22px;padding:26px 28px;background:var(--ff-primary);color:var(--ff-on-primary)}
.ff[data-header=band] .ff-head h2,.ff[data-header=band] .ff-head .ff-sub{color:inherit}
.ff[data-header=band] .ff-head .ff-sub{opacity:.88}
.ff[data-header=band] .ff-logo{background:#fff;border-radius:8px;padding:6px 8px}
.ff[data-header=centered] .ff-head{align-items:center;text-align:center}
.ff[data-header=centered] .ff-logo{align-self:center}
.ff-step{animation:ff-in .22s ease}
@keyframes ff-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ff-progress{height:4px;background:var(--ff-line)}
.ff-progress i{display:block;height:100%;background:var(--ff-primary);transition:width .25s ease}
.ff-dots{display:flex;gap:6px;justify-content:center;padding:16px 24px 0}
.ff-dots button,.ff-dots span{width:8px;height:8px;border-radius:99px;border:0;padding:0;background:var(--ff-line)}
.ff-dots .on{background:var(--ff-primary);width:22px}
.ff-dots button{cursor:pointer}
.ff-body{padding:28px 28px 8px}
.ff-head{display:flex;flex-direction:column;gap:8px;margin-bottom:22px}
.ff-logo{max-height:52px;max-width:180px;object-fit:contain;align-self:flex-start;margin-bottom:6px}
.ff h2{margin:0;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.ff h3{margin:0;font-size:20px;line-height:1.25;font-weight:700}
.ff h3:focus{outline:none}
.ff p{margin:0}
.ff-sub{color:var(--ff-muted);font-size:15px}
.ff-step{display:grid;gap:20px}
.ff-step+.ff-step{margin-top:28px;padding-top:28px;border-top:1px solid var(--ff-line)}
.ff-step-head{display:grid;gap:4px}
.ff-item{display:grid;gap:7px;min-width:0}
.ff-label{font-size:13.5px;font-weight:650;color:var(--ff-text)}
.ff-label em{font-style:normal;color:var(--ff-muted);font-weight:500;margin-left:4px}
.ff-help{font-size:13px;color:var(--ff-muted)}
.ff input[type=text],.ff input[type=email],.ff input[type=tel],.ff input[type=number],.ff input[type=date],.ff textarea,.ff select{
  width:100%;font:inherit;color:#111827;background:#fff;border:1px solid var(--ff-line);border-radius:var(--ff-field-radius);padding:11px 13px;outline:none;transition:border-color .12s,box-shadow .12s}
.ff textarea{min-height:104px;resize:vertical}
.ff input:focus,.ff textarea:focus,.ff select:focus{border-color:var(--ff-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--ff-primary) 20%,transparent)}
.ff [aria-invalid=true]{border-color:#dc2626}
.ff-unit{display:flex;align-items:center;gap:10px}
.ff-unit span{color:var(--ff-muted);font-size:14px;white-space:nowrap}
.ff-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.ff-grid .ff-span{grid-column:1/-1}
.ff-choices{display:grid;gap:10px}
.ff-choices.cards{grid-template-columns:repeat(2,minmax(0,1fr))}
.ff-choice{position:relative;display:flex;align-items:flex-start;gap:11px;padding:13px 14px;border:1px solid var(--ff-line);border-radius:var(--ff-field-radius);background:#fff;color:#111827;cursor:pointer;transition:border-color .12s,box-shadow .12s,background .12s}
.ff-choice:hover{border-color:color-mix(in srgb,var(--ff-primary) 55%,var(--ff-line))}
.ff-choice input{position:absolute;opacity:0;pointer-events:none}
.ff-choice .ff-mark{flex:0 0 auto;width:18px;height:18px;margin-top:2px;border:1.5px solid color-mix(in srgb,var(--ff-text) 34%,#fff);border-radius:99px;display:grid;place-items:center}
.ff-choice.multi .ff-mark{border-radius:5px}
.ff-choice:has(input:checked){border-color:var(--ff-primary);background:var(--ff-soft);box-shadow:0 0 0 1px var(--ff-primary)}
.ff-choice:has(input:checked) .ff-mark{border-color:var(--ff-primary);background:var(--ff-primary)}
.ff-choice:has(input:checked) .ff-mark::after{content:"";width:7px;height:7px;border-radius:99px;background:var(--ff-on-primary)}
.ff-choice.multi:has(input:checked) .ff-mark::after{width:9px;height:5px;border-radius:0;background:none;border-left:2px solid var(--ff-on-primary);border-bottom:2px solid var(--ff-on-primary);transform:rotate(-45deg) translateY(-1px)}
.ff-choice:has(input:focus-visible){outline:3px solid color-mix(in srgb,var(--ff-primary) 35%,transparent);outline-offset:2px}
.ff-choice b{display:block;font-weight:650;font-size:14.5px;line-height:1.3}
.ff-choice small{display:block;margin-top:3px;font-size:12.5px;color:#6b7280;line-height:1.35}
.ff-choice.image{flex-direction:column;padding:0;overflow:hidden}
.ff-choice.image .ff-pic{width:100%;aspect-ratio:16/10;background:#e5e7eb center/cover no-repeat}
.ff-choice.image .ff-cap{display:flex;gap:10px;padding:11px 13px 13px;width:100%}
.ff-yesno{display:flex;gap:10px}
.ff-yesno label{flex:1;justify-content:center;align-items:center;font-weight:650}
.ff-consent{display:flex;gap:10px;align-items:flex-start;font-size:14px;cursor:pointer}
.ff-consent input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--ff-primary);flex:0 0 auto}
.ff-content img{max-width:100%;border-radius:var(--ff-field-radius);margin-top:8px}
.ff-content p{white-space:pre-line;color:var(--ff-muted)}
.ff-error{font-size:13px;font-weight:600;color:#dc2626}
.ff-measure{display:grid;gap:14px}
.ff-map{position:relative;aspect-ratio:16/10;border-radius:var(--ff-field-radius);overflow:hidden;background:#e8edf3;display:grid;place-items:center;border:1px solid var(--ff-line)}
.ff-map img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ff-map img.mask{opacity:.55;mix-blend-mode:multiply}
.ff-map .ff-pin{position:absolute;left:12px;bottom:12px;right:12px;width:fit-content;max-width:calc(100% - 24px);padding:7px 11px;border-radius:8px;background:rgba(255,255,255,.94);color:#111827;font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ff-map .ff-wait{position:relative;font-size:14px;font-weight:600;color:#475467;padding:0 20px;text-align:center}
.ff-skeleton{background:linear-gradient(100deg,#e8edf3 40%,#f4f6f9 50%,#e8edf3 60%);background-size:200% 100%;animation:ff-shimmer 1.3s linear infinite}
@keyframes ff-shimmer{to{background-position:-200% 0}}
.ff-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.ff-fact{padding:13px 14px;border:1px solid var(--ff-line);border-radius:var(--ff-field-radius);background:var(--ff-soft)}
.ff-fact small{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ff-muted)}
.ff-fact strong{display:block;margin-top:4px;font-size:18px;line-height:1.2}
.ff-note{font-size:13px;color:var(--ff-muted)}
.ff-picked{font-size:14px;font-weight:650;color:var(--ff-primary)}
.ff-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 28px 24px}
.ff-btn{font:inherit;font-weight:700;font-size:15px;border-radius:var(--ff-field-radius);padding:12px 20px;border:1px solid transparent;cursor:pointer;transition:filter .12s,opacity .12s}
.ff-btn.primary{background:var(--ff-primary);color:var(--ff-on-primary);margin-left:auto}
.ff-btn.primary:hover{filter:brightness(.94)}
.ff-btn.ghost{background:transparent;color:var(--ff-text);border-color:var(--ff-line)}
.ff-btn[disabled]{opacity:.55;cursor:not-allowed}
.ff-btn:focus-visible{outline:3px solid color-mix(in srgb,var(--ff-primary) 35%,transparent);outline-offset:2px}
.ff-fine{padding:0 28px 22px;font-size:12px;color:var(--ff-muted);line-height:1.45}
.ff-banner{margin:0 28px 16px;padding:11px 14px;border-radius:var(--ff-field-radius);background:#fef2f2;color:#b91c1c;font-size:13.5px;font-weight:600}
.ff-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}
.ff-done{padding:36px 28px 32px;display:grid;gap:16px}
.ff-check{width:46px;height:46px;border-radius:99px;background:var(--ff-primary);color:var(--ff-on-primary);display:grid;place-items:center;font-size:24px;font-weight:800}
.ff-when{font-size:17px;font-weight:700}
.ff-range{font-size:34px;line-height:1.1;font-weight:800;color:var(--ff-primary);letter-spacing:-.01em}
.ff-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.ff-option{padding:16px;border:1px solid var(--ff-line);border-radius:var(--ff-field-radius);background:#fff;color:#111827}
.ff-option b{display:block;font-size:15px}
.ff-option strong{display:block;margin-top:6px;font-size:21px;color:var(--ff-primary)}
.ff-option small{display:block;margin-top:6px;font-size:12.5px;color:#6b7280;line-height:1.4}
.ff-cta{display:inline-block;text-decoration:none;justify-self:start}
.ff-preview-tag{display:inline-block;justify-self:start;padding:3px 9px;border-radius:99px;background:#fef3c7;color:#92400e;font-size:11.5px;font-weight:700}
.ff-state{padding:40px 28px;text-align:center;color:var(--ff-muted);font-weight:600}
@container (max-width:560px){
  .ff-body{padding:22px 18px 6px}.ff[data-header=band] .ff-head{margin:-22px -18px 18px;padding:20px 18px}.ff-foot{padding:18px 18px 20px}.ff-fine{padding:0 18px 20px}.ff-banner{margin:0 18px 14px}.ff-done{padding:28px 18px 26px}
  .ff h2{font-size:22px}.ff h3{font-size:18px}.ff-grid,.ff-choices.cards,.ff-facts{grid-template-columns:1fr}.ff-range{font-size:28px}
}
@media (prefers-reduced-motion:reduce){.ff *{transition:none!important;animation:none!important}}
`;

  function render(options = {}){
    const script = options.script || null;
    const key = clean(options.key || script?.dataset?.form);
    const preview = !!options.definition;
    if (!key && !preview) throw new Error('FirstMateForms.render needs a form key.');
    const mount = options.target instanceof Element ? options.target
      : (clean(options.target) && document.querySelector(clean(options.target))) || (() => {
        const el = document.createElement('div');
        (script || document.body).insertAdjacentElement(script ? 'beforebegin' : 'beforeend', el);
        return el;
      })();
    const shadow = mount.shadowRoot || mount.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="ff" part="form"><div class="ff-state">Loading\u2026</div></div>`;
    const wrap = shadow.querySelector('.ff');
    const transport = options.transport || liveTransport(clean(options.baseUrl || script?.dataset?.baseUrl) || defaultBaseUrl(), key);
    const emit = (name, detail) => mount.dispatchEvent(new CustomEvent(`fm-form:${name}`, { detail, bubbles: true }));
    const tracked = new Set();
    const track = (type, stepId) => { const key = `${type}:${stepId || ''}`; if (preview || tracked.has(key)) return; tracked.add(key); transport.activity?.(type, stepId); };

    const state = { form: null, answers: {}, measurements: {}, errors: {}, step: 0, busy: false, banner: '', result: null, submissionId: '' };
    let picker = null;
    let advance = 0;
    let pickerClosing = false;
    let destroyed = false;
    // The picker reports "no selection" as it is torn down for a repaint; that is not the visitor clearing a choice.
    const closePicker = () => { pickerClosing = true; try { picker?.destroy(); } finally { pickerClosing = false; picker = null; } };

    const allItems = () => state.form.steps.flatMap((step) => step.items);
    /**
     * What is on screen, decided exactly as the server decides it: blocks are walked in order and an
     * answer only counts while its block is shown. A stale answer to a hidden block changes nothing.
     */
    function shown(){
      const answers = {};
      for (const item of allItems()) if (item.kind === 'property_measurement' && item.param && state.answers[item.param] !== undefined) answers[item.param] = state.answers[item.param];
      const steps = [];
      for (const step of state.form.steps) {
        if (!conditionsMatch(step.visible_when, answers)) continue;
        const items = [];
        for (const item of step.items) {
          if (!conditionsMatch(item.visible_when, answers)) continue;
          items.push(item);
          if (item.param && item.kind !== 'property_measurement' && state.answers[item.param] !== undefined) answers[item.param] = state.answers[item.param];
        }
        if (items.length) steps.push({ step, items });
      }
      return steps;
    }
    const visibleSteps = () => shown().map((entry) => entry.step);
    const visibleItems = (step) => shown().find((entry) => entry.step === step)?.items || [];
    const paged = () => state.form.presentation.layout !== 'page';
    const addressFor = (item) => {
      const param = item.address_param || allItems().find((entry) => entry.kind === 'address')?.param;
      return clean(param ? state.answers[param] : '');
    };

    function applyTheme(){
      const style = state.form.presentation.style || {};
      const primary = /^#[0-9a-f]{6}$/i.test(clean(style.primary_color)) ? style.primary_color : '#2563eb';
      wrap.style.setProperty('--ff-primary', primary);
      wrap.style.setProperty('--ff-on-primary', readableOn(primary));
      if (/^#[0-9a-f]{6}$/i.test(clean(style.text_color))) wrap.style.setProperty('--ff-text', style.text_color);
      if (/^#[0-9a-f]{6}$/i.test(clean(style.background_color))) wrap.style.setProperty('--ff-bg', style.background_color);
      wrap.dataset.corners = style.corners || 'soft';
      wrap.dataset.header = style.header || 'plain';
      const font = clean(style.font_family) || 'Inter';
      ensureFont(font);
      wrap.style.fontFamily = `${JSON.stringify(font)},system-ui,-apple-system,"Segoe UI",Arial,sans-serif`;
      wrap.classList.toggle('wide', allItems().some((item) => item.kind === 'appointment'));
    }

    // --- Block renderers ----------------------------------------------------
    const errorLine = (item) => state.errors[item.id] ? `<div class="ff-error" role="alert">${esc(state.errors[item.id])}</div>` : '';
    const invalid = (item) => state.errors[item.id] ? ' aria-invalid="true"' : '';
    const label = (item, forId) => item.label ? `<label class="ff-label"${forId ? ` for="${forId}"` : ''}>${esc(item.label)}${item.required ? '' : '<em>Optional</em>'}</label>` : '';
    const help = (item) => item.description ? `<div class="ff-help">${esc(item.description)}</div>` : '';
    const fieldId = (item, suffix = '') => `ff_${item.id}${suffix}`;

    const blocks = {
      contact(item){
        const value = isObject(state.answers[item.param]) ? state.answers[item.param] : {};
        const fields = [
          ['name', 'Full name', 'text', 'name', 'Jane Doe'],
          ['email', 'Email', 'email', 'email', 'you@example.com'],
          ['phone', 'Phone', 'tel', 'tel', '(555) 555-5555']
        ].filter(([key]) => item.fields?.[key]?.enabled !== false);
        return `<div class="ff-item" data-item="${esc(item.id)}"><div class="ff-grid">${fields.map(([key, text, type, autocomplete, placeholder], index) => `
          <div class="ff-item ${fields.length % 2 && index === 0 ? 'ff-span' : ''}">
            <label class="ff-label" for="${fieldId(item, key)}">${text}${item.fields?.[key]?.required ? '' : '<em>Optional</em>'}</label>
            <input id="${fieldId(item, key)}" type="${type}" autocomplete="${autocomplete}" ${type === 'tel' ? 'inputmode="tel"' : ''} placeholder="${placeholder}" data-contact="${key}" value="${esc(value[key] || '')}"${invalid(item)}>
          </div>`).join('')}</div>${errorLine(item)}</div>`;
      },
      address(item){
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}<input id="${fieldId(item)}" type="text" autocomplete="street-address" placeholder="${esc(item.placeholder || 'Street, city, state')}" data-value value="${esc(state.answers[item.param] || '')}"${invalid(item)}>${errorLine(item)}</div>`;
      },
      text(item){
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}<input id="${fieldId(item)}" type="text" placeholder="${esc(item.placeholder)}" data-value value="${esc(state.answers[item.param] || '')}"${invalid(item)}>${errorLine(item)}</div>`;
      },
      paragraph(item){
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}<textarea id="${fieldId(item)}" placeholder="${esc(item.placeholder)}" data-value${invalid(item)}>${esc(state.answers[item.param] || '')}</textarea>${errorLine(item)}</div>`;
      },
      number(item){
        const input = `<input id="${fieldId(item)}" type="number" inputmode="decimal" ${item.min !== undefined ? `min="${esc(item.min)}"` : ''} ${item.max !== undefined ? `max="${esc(item.max)}"` : ''} placeholder="${esc(item.placeholder)}" data-value value="${esc(state.answers[item.param] ?? '')}"${invalid(item)}>`;
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}${item.unit ? `<div class="ff-unit">${input}<span>${esc(item.unit)}</span></div>` : input}${errorLine(item)}</div>`;
      },
      date(item){
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}<input id="${fieldId(item)}" type="date" data-value value="${esc(state.answers[item.param] || '')}"${invalid(item)}>${errorLine(item)}</div>`;
      },
      select(item){
        const current = state.answers[item.param];
        if (item.style === 'dropdown') {
          return `<div class="ff-item" data-item="${esc(item.id)}">${label(item, fieldId(item))}${help(item)}<select id="${fieldId(item)}" data-value${invalid(item)}><option value="">Choose\u2026</option>${item.options.map((option) => `<option value="${esc(option.value)}" ${current === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>${errorLine(item)}</div>`;
        }
        return choices(item, 'radio', (option) => current === option.value);
      },
      multi_select(item){
        const current = Array.isArray(state.answers[item.param]) ? state.answers[item.param] : [];
        return choices(item, 'checkbox', (option) => current.includes(option.value));
      },
      boolean(item){
        const current = state.answers[item.param];
        return `<div class="ff-item" data-item="${esc(item.id)}" role="radiogroup" aria-label="${esc(item.label)}">${label(item)}${help(item)}<div class="ff-yesno">${[[true, 'Yes'], [false, 'No']].map(([value, text]) => `<label class="ff-choice"><input type="radio" name="${fieldId(item)}" value="${value}" data-bool ${current === value ? 'checked' : ''}><span>${text}</span></label>`).join('')}</div>${errorLine(item)}</div>`;
      },
      consent(item){
        return `<div class="ff-item" data-item="${esc(item.id)}"><label class="ff-consent"><input type="checkbox" data-check ${state.answers[item.param] === true ? 'checked' : ''}${invalid(item)}><span>${esc(item.label || 'I agree to be contacted about my request.')}</span></label>${errorLine(item)}</div>`;
      },
      content(item){
        const image = safeUrl(item.image_url);
        return `<div class="ff-item ff-content" data-item="${esc(item.id)}">${item.heading ? `<h3>${esc(item.heading)}</h3>` : ''}${item.body ? `<p>${esc(item.body)}</p>` : ''}${image ? `<img src="${esc(image)}" alt="">` : ''}</div>`;
      },
      appointment(item){
        const picked = state.answers[item.param]?.label;
        return `<div class="ff-item" data-item="${esc(item.id)}">${label(item)}${help(item)}<div class="fm-availability" data-picker="${esc(item.id)}"><div class="ff-state">Loading available times\u2026</div></div>${picked ? `<div class="ff-picked">Selected: ${esc(picked)}</div>` : ''}${errorLine(item)}</div>`;
      },
      property_measurement(item){
        const measured = state.measurements[item.id];
        const address = addressFor(item);
        if (!address) return `<div class="ff-item" data-item="${esc(item.id)}"><div class="ff-note">Enter the property address first.</div></div>`;
        if (!measured || measured.address !== address || measured.loading) {
          return `<div class="ff-item ff-measure" data-item="${esc(item.id)}"><div class="ff-map ff-skeleton"><span class="ff-wait">Finding your property\u2026</span></div><div class="ff-facts">${[0, 1, 2].map(() => '<div class="ff-fact ff-skeleton" style="height:66px"></div>').join('')}</div></div>`;
        }
        const image = safeUrl(measured.preview?.image);
        const mask = safeUrl(measured.preview?.mask);
        return `<div class="ff-item ff-measure" data-item="${esc(item.id)}">
          ${image ? `<div class="ff-map"><img src="${esc(image)}" alt="Satellite view of the property">${mask ? `<img class="mask" src="${esc(mask)}" alt="">` : ''}<span class="ff-pin">${esc(measured.formatted_address || address)}</span></div>` : ''}
          ${measured.facts?.length ? `<div class="ff-facts">${measured.facts.map((fact) => `<div class="ff-fact"><small>${esc(fact.label)}</small><strong>${esc(fact.value)}</strong></div>`).join('')}</div>` : ''}
          <div class="ff-note">${esc(measured.measured ? 'These measurements are automatic and preliminary. We verify them before final pricing.' : (measured.message || 'We could not measure this property automatically. Continue and we will confirm the details with you.'))}</div>
        </div>`;
      }
    };
    function choices(item, type, checked){
      const images = item.style === 'cards' && item.options.some((option) => safeUrl(option.image_url));
      const mark = '<span class="ff-mark"></span>';
      return `<div class="ff-item" data-item="${esc(item.id)}" role="${type === 'radio' ? 'radiogroup' : 'group'}" aria-label="${esc(item.label)}">${label(item)}${help(item)}
        <div class="ff-choices ${item.style === 'cards' && item.options.length > 1 ? 'cards' : ''}">${item.options.map((option) => {
          const input = `<input type="${type}" name="${fieldId(item)}" value="${esc(option.value)}" data-choice ${checked(option) ? 'checked' : ''}>`;
          const text = `<span><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span>`;
          return images
            ? `<label class="ff-choice image ${type === 'checkbox' ? 'multi' : ''}">${input}<span class="ff-pic" style="background-image:url('${esc(safeUrl(option.image_url))}')"></span><span class="ff-cap">${mark}${text}</span></label>`
            : `<label class="ff-choice ${type === 'checkbox' ? 'multi' : ''}">${input}${mark}${text}</label>`;
        }).join('')}</div>${errorLine(item)}</div>`;
    }

    // --- Validation (the server repeats all of this) -------------------------
    function validateItem(item){
      if (!item.param) return '';
      const value = state.answers[item.param];
      if (item.kind === 'contact') {
        const contact = isObject(value) ? value : {};
        for (const [key, text] of [['name', 'your name'], ['email', 'your email address'], ['phone', 'your phone number']]) {
          const field = item.fields?.[key];
          if (!field || field.enabled === false) continue;
          const entry = clean(contact[key]);
          if (!entry && field.required) return `Enter ${text}.`;
          if (entry && key === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry)) return 'Enter a valid email address.';
          if (entry && key === 'phone' && entry.replace(/\D/g, '').length < 7) return 'Enter a valid phone number.';
        }
        return '';
      }
      if (item.kind === 'property_measurement') return '';
      if (item.kind === 'consent') return value === true ? '' : 'Please check this box to continue.';
      if (item.kind === 'boolean') return item.required && value !== true && value !== false ? 'Choose yes or no.' : '';
      if (item.kind === 'appointment') return item.required && !value?.start_at ? 'Choose a day and time.' : '';
      if (item.kind === 'number' && value !== undefined && value !== '') {
        if (!Number.isFinite(Number(value))) return 'Enter a number.';
        if (item.min !== undefined && Number(value) < item.min) return `Enter ${item.min} or more.`;
        if (item.max !== undefined && Number(value) > item.max) return `Enter ${item.max} or less.`;
      }
      if (item.required && (value === undefined || value === '' || (Array.isArray(value) && !value.length))) {
        return item.kind === 'select' || item.kind === 'multi_select' ? 'Choose an option.' : 'This field is required.';
      }
      return '';
    }
    function validateStep(step){
      let first = null;
      for (const item of visibleItems(step)) {
        const message = validateItem(item);
        if (message) { state.errors[item.id] = message; first ||= item; }
        else delete state.errors[item.id];
      }
      return first;
    }
    const onScreen = (item) => wrap.querySelector(`[data-item="${CSS.escape(item.id)}"]`);
    const measuring = (step) => visibleItems(step).some((item) => item.kind === 'property_measurement' && addressFor(item) && (!state.measurements[item.id] || state.measurements[item.id].loading || state.measurements[item.id].address !== addressFor(item)));

    const waiting = () => (paged() ? [visibleSteps()[state.step]] : visibleSteps()).some((step) => step && measuring(step));
    /** Redraws one measurement block in place and keeps the submit button in step with it. */
    function refreshMeasurement(item){
      const el = onScreen(item);
      if (!el) return;
      el.outerHTML = blocks.property_measurement(item);
      const button = wrap.querySelector('button[type=submit]');
      if (button) button.disabled = state.busy || waiting();
    }

    // --- Rendering ----------------------------------------------------------
    function stepMarkup(step, index, showHead){
      const head = showHead && (step.title || step.description)
        ? `<div class="ff-step-head">${step.title ? `<h3 tabindex="-1" data-step-title>${esc(step.title)}</h3>` : ''}${step.description ? `<p class="ff-sub">${esc(step.description)}</p>` : ''}</div>` : '';
      return `<section class="ff-step" data-step="${esc(step.id)}" data-index="${index}">${head}${visibleItems(step).map((item) => blocks[item.kind]?.(item) || '').join('')}</section>`;
    }
    function paint(focusTitle = false){
      if (destroyed) return;
      closePicker();
      if (state.result) return paintResult();
      const presentation = state.form.presentation;
      const steps = visibleSteps();
      if (!steps.length) { wrap.innerHTML = '<div class="ff-state">This form has no questions yet.</div>'; return; }
      state.step = Math.max(0, Math.min(steps.length - 1, state.step));
      const isPaged = paged();
      const last = !isPaged || state.step === steps.length - 1;
      const logo = presentation.style?.logo_enabled !== false ? safeUrl(presentation.style?.logo_url) : '';
      const intro = (!isPaged || state.step === 0) && (logo || presentation.headline || presentation.subheadline)
        ? `<div class="ff-head">${logo ? `<img class="ff-logo" src="${esc(logo)}" alt="">` : ''}${presentation.headline ? `<h2>${esc(presentation.headline)}</h2>` : ''}${presentation.subheadline ? `<p class="ff-sub">${esc(presentation.subheadline)}</p>` : ''}</div>` : '';
      const progress = !isPaged || steps.length < 2 || presentation.progress === 'none' ? ''
        : presentation.progress === 'dots'
          ? `<div class="ff-dots" aria-hidden="${preview ? 'false' : 'true'}">${steps.map((_, index) => preview ? `<button type="button" class="${index === state.step ? 'on' : ''}" data-jump="${index}" aria-label="Go to step ${index + 1}"></button>` : `<span class="${index === state.step ? 'on' : ''}"></span>`).join('')}</div>`
          : `<div class="ff-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${steps.length}" aria-valuenow="${state.step + 1}" aria-label="Step ${state.step + 1} of ${steps.length}"><i style="width:${Math.round(((state.step + 1) / steps.length) * 100)}%"></i></div>`;
      const busyHere = waiting();
      wrap.innerHTML = `
        ${progress}
        <form novalidate>
          <div class="ff-body">${intro}${isPaged ? stepMarkup(steps[state.step], state.step, true) : steps.map((step, index) => stepMarkup(step, index, steps.length > 1)).join('')}</div>
          <div class="ff-hp" aria-hidden="true"><label>Website<input type="text" name="website_url" tabindex="-1" autocomplete="off"></label></div>
          ${state.banner ? `<div class="ff-banner" role="alert">${esc(state.banner)}</div>` : ''}
          <div class="ff-foot">
            ${isPaged && state.step > 0 ? `<button type="button" class="ff-btn ghost" data-back ${state.busy ? 'disabled' : ''}>${esc(presentation.back_label || 'Back')}</button>` : ''}
            <button type="submit" class="ff-btn primary" ${state.busy || busyHere ? 'disabled' : ''}>${esc(state.busy ? 'Sending\u2026' : last ? (presentation.submit_label || 'Submit') : (state.step === 0 && presentation.start_label) || presentation.next_label || 'Next')}</button>
          </div>
          ${last && presentation.fine_print ? `<div class="ff-fine">${esc(presentation.fine_print)}</div>` : ''}
        </form>`;
      bind(steps);
      for (const step of isPaged ? [steps[state.step]] : steps) track('step', step.id);
      if (focusTitle) wrap.querySelector('[data-step-title]')?.focus({ preventScroll: true });
    }

    function setAnswer(item, value){
      track('start');
      if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete state.answers[item.param];
      else state.answers[item.param] = value;
      if (state.errors[item.id]) { delete state.errors[item.id]; return true; }
      return false;
    }
    const signature = () => visibleSteps().map((step) => `${step.id}:${visibleItems(step).map((item) => item.id).join(',')}`).join('|');

    function bind(steps){
      const form = wrap.querySelector('form');
      const byId = new Map(allItems().map((item) => [item.id, item]));
      for (const el of wrap.querySelectorAll('[data-item]')) {
        const item = byId.get(el.dataset.item);
        if (!item) continue;
        const refresh = (before, hadError) => { if (hadError || before !== signature()) paint(); };
        if (item.kind === 'contact') {
          el.querySelectorAll('[data-contact]').forEach((input) => input.addEventListener('input', () => {
            const next = { ...(isObject(state.answers[item.param]) ? state.answers[item.param] : {}) };
            if (clean(input.value)) next[input.dataset.contact] = clean(input.value); else delete next[input.dataset.contact];
            setAnswer(item, Object.keys(next).length ? next : undefined);
          }));
        } else if (item.kind === 'select' && item.style !== 'dropdown' || item.kind === 'multi_select') {
          // Arrow keys also fire "change" while a keyboard user is still moving through the choices.
          let pointer = false;
          el.addEventListener('pointerdown', () => { pointer = true; });
          el.addEventListener('keydown', () => { pointer = false; });
          el.querySelectorAll('[data-choice]').forEach((input) => input.addEventListener('change', () => {
            const before = signature();
            const hadError = setAnswer(item, item.kind === 'select' ? input.value : [...el.querySelectorAll('[data-choice]:checked')].map((entry) => entry.value));
            // A lone single-choice question answers itself: move on without an extra click.
            const step = steps[state.step];
            if (pointer && item.kind === 'select' && paged() && state.step < steps.length - 1 && visibleItems(step).length === 1) {
              clearTimeout(advance);
              advance = setTimeout(() => { advance = 0; go(1); }, 160);
              return;
            }
            refresh(before, hadError);
          }));
        } else if (item.kind === 'boolean') {
          el.querySelectorAll('[data-bool]').forEach((input) => input.addEventListener('change', () => {
            const before = signature();
            refresh(before, setAnswer(item, input.value === 'true'));
          }));
        } else if (item.kind === 'consent') {
          el.querySelector('[data-check]')?.addEventListener('change', (event) => { if (setAnswer(item, event.target.checked ? true : undefined)) paint(); });
        } else if (item.kind === 'appointment') {
          mountPicker(item, el.querySelector('[data-picker]'));
        } else if (item.kind === 'property_measurement') {
          measure(item);
        } else {
          const input = el.querySelector('[data-value]');
          input?.addEventListener('input', () => { setAnswer(item, item.kind === 'number' ? (input.value === '' ? undefined : Number(input.value)) : input.value); });
          input?.addEventListener('change', () => { const before = signature(); setAnswer(item, item.kind === 'number' ? (input.value === '' ? undefined : Number(input.value)) : clean(input.value));
            if (before !== signature()) return paint();
            // A measurement on the same screen follows the address without repainting the form under the visitor.
            if (item.kind === 'address') for (const entry of allItems()) if (entry.kind === 'property_measurement' && onScreen(entry)) measure(entry);
          });
        }
      }
      wrap.querySelector('[data-back]')?.addEventListener('click', () => go(-1, false));
      wrap.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => { state.step = Number(button.dataset.jump); state.banner = ''; paint(true); }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (state.busy) return;
        if (paged() && state.step < steps.length - 1) return go(1);
        submit(form);
      });
    }

    function focusFirstError(item){
      paint();
      const el = wrap.querySelector(`[data-item="${CSS.escape(item.id)}"]`);
      el?.querySelector('input,textarea,select,button')?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function go(delta, validate = true){
      clearTimeout(advance);
      advance = 0;
      const steps = visibleSteps();
      if (delta > 0 && validate) {
        const failed = validateStep(steps[state.step]);
        if (failed) return focusFirstError(failed);
      }
      state.banner = '';
      state.step = Math.max(0, Math.min(visibleSteps().length - 1, state.step + delta));
      paint(true);
      emit('step', { index: state.step, id: visibleSteps()[state.step]?.id });
      const top = mount.getBoundingClientRect().top;
      if (top < 0 || top > root.innerHeight * 0.4) mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function mountPicker(item, host){
      if (!host) return;
      try { await ensurePicker(); } catch (error) { host.innerHTML = `<div class="ff-note">${esc(error.message)}</div>`; return; }
      if (destroyed || !host.isConnected) return;
      host.innerHTML = root.FirstMateAvailability.markup();
      // Inline so it outranks the picker's own default accent.
      host.style.setProperty('--fmle-primary', 'var(--ff-primary)');
      host.style.setProperty('--fmle-text', 'var(--ff-text)');
      const selected = state.answers[item.param];
      picker = root.FirstMateAvailability.mount(host, {
        date: selected?.start_at ? `${new Date(selected.start_at).getFullYear()}-${String(new Date(selected.start_at).getMonth() + 1).padStart(2, '0')}-${String(new Date(selected.start_at).getDate()).padStart(2, '0')}` : undefined,
        loadAvailability: (date) => transport.availability(item, date, addressFor(item)),
        onChange: (slot) => {
          if (!slot) { if (!pickerClosing) { delete state.answers[item.param]; host.parentElement.querySelector('.ff-picked')?.remove(); } return; }
          const start = slot.start_at || slot.start;
          // The day and time text come from the picker and server, which speak the business's timezone.
          state.answers[item.param] = { start_at: start, label: [clean(host.querySelector('[data-selected-day]')?.textContent), clean(slot.label)].filter(Boolean).join(' \u00b7 ') };
          delete state.errors[item.id];
          host.parentElement.querySelector('.ff-error')?.remove();
          let picked = host.parentElement.querySelector('.ff-picked');
          if (!picked) { picked = document.createElement('div'); picked.className = 'ff-picked'; host.insertAdjacentElement('afterend', picked); }
          picked.textContent = `Selected: ${state.answers[item.param].label}`;
        }
      });
    }

    async function measure(item){
      const address = addressFor(item);
      const current = state.measurements[item.id];
      if (!address || (current && current.address === address)) return;
      const before = signature();
      state.measurements[item.id] = { address, loading: true };
      delete state.answers[item.param];
      if (!paged()) refreshMeasurement(item);
      let result;
      try { result = await transport.measure(item, address); }
      catch (error) { result = { measured: false, message: error.status === 429 ? error.message : '', facts: [], token: '' }; }
      if (destroyed || state.measurements[item.id]?.address !== address) return;
      state.measurements[item.id] = { ...result, address, loading: false };
      // Display-only copy so later questions can react to the measurement; the server prices its signed values.
      if (isObject(result.values)) state.answers[item.param] = result.values;
      // On a single-page form only this block changes, unless the measurement reveals or hides other blocks.
      if (paged() || before !== signature()) paint(); else refreshMeasurement(item);
    }

    async function submit(form){
      for (const [index, step] of visibleSteps().entries()) {
        const failed = validateStep(step);
        if (failed) { state.step = index; return focusFirstError(failed); }
      }
      state.busy = true;
      state.banner = '';
      const honeypot = clean(form.querySelector('[name=website_url]')?.value);
      paint();
      const answers = {};
      const measurements = {};
      for (const step of visibleSteps()) for (const item of visibleItems(step)) {
        if (!item.param) continue;
        if (item.kind === 'property_measurement') { if (state.measurements[item.id]?.token) measurements[item.id] = state.measurements[item.id].token; continue; }
        if (state.answers[item.param] === undefined) continue;
        answers[item.param] = item.kind === 'appointment' ? { start_at: state.answers[item.param].start_at } : state.answers[item.param];
      }
      state.submissionId ||= (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        const result = await transport.submit({ answers, measurements, submission_id: state.submissionId, page_url: location.href.slice(0, 2000), referrer: document.referrer.slice(0, 2000), ...(honeypot ? { website_url: honeypot } : {}), ...(preview ? { definition: options.definition } : {}) });
        state.result = result;
        state.busy = false;
        paint();
        emit('submitted', { estimate: result.estimate || null, appointment: result.appointment || null, preview });
        mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        state.busy = false;
        // The id is kept: if the first attempt did reach the server, the retry must resolve to it, not repeat it.
        const byParam = new Map(allItems().filter((item) => item.param).map((item) => [item.param, item]));
        const flagged = (error.issues || []).map((issue) => ({ item: byParam.get(issue.param) || allItems().find((item) => item.id === issue.item_id), message: issue.message })).filter((entry) => entry.item);
        if (flagged.length) {
          for (const entry of flagged) state.errors[entry.item.id] = entry.message;
          if (error.code === 'form_slot_unavailable') delete state.answers[flagged[0].item.param];
          const index = visibleSteps().findIndex((step) => visibleItems(step).includes(flagged[0].item));
          if (index >= 0) {
            state.step = index;
            return focusFirstError(flagged[0].item);
          }
          // Never leave the visitor without an explanation if the flagged block is not on screen.
          state.banner = flagged[0].message;
          return paint();
        }
        state.banner = error.message || 'Something went wrong. Please try again.';
        paint();
      }
    }

    function paintResult(){
      const result = state.result;
      const success = result.success || state.form.presentation.success || {};
      const estimate = isObject(result.estimate) ? result.estimate : null;
      const money = (value) => {
        try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: clean(estimate?.currency) || 'USD', maximumFractionDigits: 0 }).format(Number(value) || 0); }
        catch { return `$${Math.round(Number(value) || 0).toLocaleString()}`; }
      };
      const range = (low, high) => Number(low) === Number(high) ? money(low) : `${money(low)} \u2013 ${money(high)}`;
      const options = Array.isArray(estimate?.options) ? estimate.options : [];
      const quantity = isObject(estimate?.quantity) && Number(estimate.quantity.value) ? estimate.quantity : null;
      const appointment = isObject(result.appointment) ? result.appointment : null;
      const cta = clean(success.cta_label) && /^https:\/\//i.test(clean(success.cta_url)) ? success : null;
      wrap.innerHTML = `<div class="ff-done" role="status">
        ${result.preview ? '<span class="ff-preview-tag">Preview \u2014 nothing was submitted</span>' : ''}
        <div class="ff-check" aria-hidden="true">\u2713</div>
        <h2 tabindex="-1">${esc(success.title || 'Thanks \u2014 we got it')}</h2>
        ${appointment ? `<div class="ff-when">${esc(appointment.status === 'booked' ? appointment.label : `Requested: ${appointment.label}`)}</div>${appointment.status === 'booked' ? '' : '<p class="ff-sub">We will confirm this time with you shortly.</p>'}` : ''}
        ${estimate ? (options.length > 1
          ? `<div class="ff-options">${options.map((option) => `<div class="ff-option"><b>${esc(option.label)}</b><strong>${esc(range(option.low, option.high))}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</div>`).join('')}</div>`
          : `<div class="ff-range">${esc(range(estimate.low, estimate.high))}</div>`) : ''}
        ${!estimate && result.estimate_unavailable ? '<p class="ff-sub">We could not work out an instant estimate from these answers. We will follow up with pricing.</p>' : ''}
        ${quantity ? `<p class="ff-sub">${esc(quantity.label || 'Quantity')}: ${esc(Number(quantity.value).toLocaleString())} ${esc(quantity.unit || '')}${quantity.source === 'fallback' ? ' (a typical size \u2014 we will confirm yours)' : ''}</p>` : ''}
        ${success.body ? `<p>${esc(success.body)}</p>` : ''}
        ${cta ? `<a class="ff-btn primary ff-cta" href="${esc(cta.cta_url)}" target="_top" rel="noopener">${esc(cta.cta_label)}</a>` : ''}
        ${estimate?.disclaimer ? `<p class="ff-note">${esc(estimate.disclaimer)}</p>` : ''}
        ${result.preview ? '<button type="button" class="ff-btn ghost" data-restart style="justify-self:start">Start over</button>' : ''}
      </div>`;
      wrap.querySelector('[data-restart]')?.addEventListener('click', () => controller.reset());
      wrap.querySelector('h2')?.focus({ preventScroll: true });
    }

    function start(form){
      state.form = form;
      applyTheme();
      paint();
    }
    const controller = {
      mount,
      /** Editor preview: swap in an edited draft, keeping the visitor's place and answers. */
      update(definition, name){
        const signature = JSON.stringify([definition, name]);
        if (signature === controller.signature) return;
        controller.signature = signature;
        options.definition = definition;
        const stepId = state.form ? visibleSteps()[state.step]?.id : '';
        state.form = { name: name || state.form?.name || '', presentation: definition.presentation, steps: definition.steps };
        state.errors = {};
        if (state.result) state.result = null;
        const index = visibleSteps().findIndex((step) => step.id === stepId);
        if (index >= 0) state.step = index;
        applyTheme();
        paint();
      },
      goToStep(stepId){
        if (!state.form) return;
        const hadResult = !!state.result;
        state.result = null;
        const index = visibleSteps().findIndex((step) => step.id === stepId);
        if (index >= 0 && index !== state.step) { state.step = index; paint(); }
        else if (hadResult) paint();
        if (!paged()) wrap.querySelector(`[data-step="${CSS.escape(stepId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      reset(){
        Object.assign(state, { answers: {}, measurements: {}, errors: {}, step: 0, busy: false, banner: '', result: null, submissionId: '' });
        paint();
      },
      destroy(){ destroyed = true; closePicker(); shadow.innerHTML = ''; }
    };

    if (preview) {
      start({ name: options.name || '', presentation: options.definition.presentation, steps: options.definition.steps });
      controller.ready = Promise.resolve(controller);
    } else {
      controller.ready = transport.load().then((form) => {
        if (destroyed) return controller;
        start(form);
        track('view');
        emit('ready', { name: form.name });
        return controller;
      }).catch((error) => {
        wrap.innerHTML = `<div class="ff-state">${esc(error.status === 404 || error.status === 403 ? 'This form is not available right now.' : 'This form could not be loaded. Please refresh and try again.')}</div>`;
        throw error;
      });
    }
    return controller;
  }

  root.FirstMateForms = { render };
  if (SCRIPT?.dataset?.form && SCRIPT.dataset.auto !== 'false') {
    const boot = () => { render({ script: SCRIPT, target: SCRIPT.dataset.target }).ready.catch((error) => console.error('[FirstMateForms]', error)); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})();
