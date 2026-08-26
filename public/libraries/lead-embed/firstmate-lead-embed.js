/* libraries/lead-embed/firstmate-lead-embed.js
 * Public browser embed for website lead capture forms.
 *
 * Inputs:
 *   FirstMateLeadEmbed.render({ formId, target, baseUrl })
 *   <script src="/libraries/lead-embed/firstmate-lead-embed.js" data-form-id="form_x" data-target="#el"></script>
 *
 * Server:
 *   GET  /v1/lead-intake/public/forms/:formId
 *   POST /v1/lead-intake/public/forms/:formId/submit
 *
 * Output:
 *   Renders a self-contained contact/scheduling form and submits a website_embed
 *   lead through the public Lead Intake API endpoint.
 */
(function(){
  const root = window;
  const FONT_URLS = {
    Montserrat: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800;900&display=swap',
    Inter: 'https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800;900&display=swap',
    Roboto: 'https://fonts.googleapis.com/css2?family=Roboto:wght@500;700;900&display=swap',
    'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@500;700;800&display=swap',
    Lato: 'https://fonts.googleapis.com/css2?family=Lato:wght@700;900&display=swap',
    Poppins: 'https://fonts.googleapis.com/css2?family=Poppins:wght@500;700;800&display=swap',
    'Source Sans 3': 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@500;700;900&display=swap'
  };

  function cleanText(value){ return String(value ?? '').trim(); }
  function esc(value){
    return cleanText(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }
  function currentScript(){ return document.currentScript || document.querySelector('script[data-form-id][src*="firstmate-lead-embed"]'); }
  function defaultBaseUrl(){
    const script = currentScript();
    const explicit = cleanText(script?.dataset?.baseUrl);
    if (explicit) return explicit.replace(/\/+$/, '');
    try {
      const src = new URL(script?.src || '', location.href);
      if (src.hostname === location.hostname && (src.hostname === 'localhost' || src.hostname === '127.0.0.1')) return `${src.protocol}//${src.hostname}:3111/v1/lead-intake`;
      return `${src.origin}/v1/lead-intake`;
    } catch {
      return `${location.origin}/v1/lead-intake`;
    }
  }
  function injectFont(font){
    const url = FONT_URLS[font];
    if (!url || document.querySelector(`link[data-fm-lead-font="${CSS.escape(font)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.fmLeadFont = font;
    document.head.appendChild(link);
  }
  function resolveTarget(target, script){
    if (target instanceof Element) return target;
    if (cleanText(target)) {
      const el = document.querySelector(cleanText(target));
      if (el) return el;
    }
    const mount = document.createElement('div');
    (script || currentScript())?.insertAdjacentElement('beforebegin', mount);
    return mount;
  }
  async function jsonFetch(baseUrl, path, options = {}){
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok || data?.ok === false) throw new Error(cleanText(data?.message || data?.error) || `Lead form request failed (${res.status})`);
    return data;
  }
  function localDateInput(date = new Date()){
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function dateFromInput(value){
    const [year, month, day] = cleanText(value).split('-').map(Number);
    const date = new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
  function addDays(date, days){
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }
  function calendarDays(selectedDate){
    const selected = dateFromInput(selectedDate);
    const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }
  function upcomingDays(count = 21){
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    return Array.from({ length: count }, (_, index) => addDays(today, index));
  }
  function dayButton(date, selectedDate, mobile = false){
    const value = localDateInput(date);
    const selected = value === selectedDate;
    if (mobile) {
      return `<button type="button" class="fmle-day-pill ${selected ? 'active' : ''}" data-date="${esc(value)}"><span>${esc(date.toLocaleDateString([], { weekday:'short' }))}</span><b>${date.getDate()}</b></button>`;
    }
    const muted = date.getMonth() !== dateFromInput(selectedDate).getMonth();
    return `<button type="button" class="fmle-cal-day ${selected ? 'active' : ''} ${muted ? 'muted' : ''}" data-date="${esc(value)}">${date.getDate()}</button>`;
  }
  function estimatePagesFor(form){
    const pages = Array.isArray(form.estimate?.pages) && form.estimate.pages.length
      ? form.estimate.pages
      : Array.isArray(form.pages) && form.pages.length
        ? form.pages
        : [];
    return pages.map((page, index) => ({
      key: cleanText(page.key) || `question_${index + 1}`,
      title: cleanText(page.title) || `Question ${index + 1}`,
      subtitle: cleanText(page.subtitle),
      type: cleanText(page.type) === 'image' ? 'image' : 'choice',
      options: Array.isArray(page.options) && page.options.length ? page.options : [{ value:'option', label:'Option' }]
    }));
  }
  function renderEstimateQuestion(page){
    const options = page.options.map((option, index) => {
      const value = cleanText(option.value || option.label || `option_${index + 1}`);
      const label = cleanText(option.label || value);
      const description = cleanText(option.description);
      const image = cleanText(option.image);
      return `
        <label class="fmle-est-choice ${page.type === 'image' ? 'image' : ''}">
          <input type="radio" name="answer_${esc(page.key)}" value="${esc(value)}" required>
          ${image ? `<span class="fmle-est-img" style="background-image:url('${esc(image)}')"></span>` : ''}
          <span><b>${esc(label)}</b>${description ? `<small>${esc(description)}</small>` : ''}</span>
        </label>
      `;
    }).join('');
    return `<section class="fmle-est-page" data-est-page>
      <h4>${esc(page.title)}</h4>
      ${page.subtitle ? `<p>${esc(page.subtitle)}</p>` : ''}
      <div class="fmle-est-options">${options}</div>
    </section>`;
  }
  function renderEstimateMarkup(form, instanceId){
    const copy = form.copy || {};
    const style = form.style || {};
    const font = cleanText(style.font_family || 'Montserrat');
    injectFont(font);
    const logo = style.logo_enabled && style.logo_url ? `<img class="fmle-logo" src="${esc(style.logo_url)}" alt="">` : '';
    const questions = estimatePagesFor(form);
    const totalPages = questions.length + 4;
    const dots = Array.from({ length: totalPages }, (_, index) => `<button type="button" class="fmle-est-dot" data-est-jump="${index}" aria-label="Page ${index + 1}">${index + 1}</button>`).join('');
    return `
      <style>
        #${instanceId}.fmle-wrap{--fmle-primary:${esc(style.primary_color || '#d93025')};--fmle-secondary:${esc(style.secondary_color || '#111827')};--fmle-bg:${esc(style.background_color || '#fff')};--fmle-text:${esc(style.text_color || '#111827')};font-family:${JSON.stringify(font)},Arial,sans-serif;background:var(--fmle-bg);color:var(--fmle-text);border:1px solid rgba(15,23,42,.12);border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,.12);overflow:hidden;max-width:920px;container-type:inline-size}
        #${instanceId} *{box-sizing:border-box}
        #${instanceId} form{display:grid;min-height:560px}
        #${instanceId} .fmle-est-page{display:none;padding:30px;align-content:center;gap:18px;min-height:440px}
        #${instanceId} .fmle-est-page.active{display:grid}
        #${instanceId} .fmle-est-brand{display:flex;align-items:center;gap:16px;margin-bottom:8px}
        #${instanceId} .fmle-logo{height:58px;width:auto;max-width:190px;object-fit:contain;flex:0 0 auto}
        #${instanceId} h3,#${instanceId} h4{margin:0;color:var(--fmle-text);letter-spacing:0;font-weight:900;line-height:1.08}
        #${instanceId} h3{font-size:34px;max-width:720px}
        #${instanceId} h4{font-size:26px}
        #${instanceId} p{margin:0;color:color-mix(in srgb,var(--fmle-text) 68%,#fff);font-size:15px;line-height:1.5;font-weight:700;max-width:660px}
        #${instanceId} label{display:grid;gap:6px;font-size:11px;font-weight:900;text-transform:uppercase;color:color-mix(in srgb,var(--fmle-text) 64%,#fff)}
        #${instanceId} input,#${instanceId} textarea{width:100%;border:1px solid rgba(15,23,42,.18);border-radius:8px;padding:12px 13px;font:inherit;font-size:14px;font-weight:700;background:#fff;color:#111827;outline:none}
        #${instanceId} textarea{min-height:110px;resize:vertical}
        #${instanceId} input:focus,#${instanceId} textarea:focus{border-color:var(--fmle-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmle-primary) 18%,transparent)}
        #${instanceId} .fmle-est-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
        #${instanceId} .fmle-solar-preview{position:relative;min-height:250px;border:1px solid rgba(15,23,42,.14);border-radius:10px;background:#eef2f7;overflow:hidden;display:grid;place-items:center}
        #${instanceId} .fmle-solar-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
        #${instanceId} .fmle-solar-preview .mask{opacity:.56;mix-blend-mode:multiply}
        #${instanceId} .fmle-solar-preview span{position:relative;z-index:1;margin:18px;padding:12px 14px;border-radius:8px;background:rgba(255,255,255,.92);font-size:13px;font-weight:900;color:#111827;text-align:center}
        #${instanceId} .fmle-address-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        #${instanceId} .fmle-address-actions button{border:0;border-radius:8px;background:var(--fmle-primary);color:#fff;padding:11px 14px;font:inherit;font-size:13px;font-weight:900;cursor:pointer}
        #${instanceId} .fmle-est-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        #${instanceId} .fmle-est-choice{position:relative;border:1px solid rgba(15,23,42,.14);border-radius:8px;background:#fff;min-height:86px;padding:14px;text-transform:none;color:#111827;cursor:pointer;overflow:hidden}
        #${instanceId} .fmle-est-choice input{position:absolute;opacity:0;pointer-events:none}
        #${instanceId} .fmle-est-choice b{display:block;font-size:15px;line-height:1.2}
        #${instanceId} .fmle-est-choice small{display:block;margin-top:5px;font-size:12px;line-height:1.35;color:#6b7280;text-transform:none}
        #${instanceId} .fmle-est-choice:has(input:checked){border-color:var(--fmle-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmle-primary) 16%,transparent)}
        #${instanceId} .fmle-est-choice.image{min-height:145px;align-content:end;color:#fff;background:#111827;padding:0}
        #${instanceId} .fmle-est-img{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.72}
        #${instanceId} .fmle-est-choice.image span:last-child{position:relative;padding:16px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.72))}
        #${instanceId} .fmle-est-actions{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:0 30px 26px}
        #${instanceId} .fmle-est-actions button{border:0;border-radius:8px;background:var(--fmle-primary);color:#fff;padding:12px 15px;font:inherit;font-size:14px;font-weight:900;cursor:pointer}
        #${instanceId} .fmle-est-actions button.secondary{background:#fff;color:#111827;border:1px solid rgba(15,23,42,.18)}
        #${instanceId} button[disabled]{opacity:.55;cursor:not-allowed}
        #${instanceId} .fmle-est-dots{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;padding:0 30px 18px}
        #${instanceId} .fmle-est-dot{width:30px;height:30px;border:1px solid rgba(15,23,42,.16);border-radius:999px;background:#fff;color:#111827;font-size:12px;font-weight:900;padding:0;cursor:pointer}
        #${instanceId} .fmle-est-dot.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        #${instanceId} .fmle-status{min-height:18px;padding:0 30px 24px;font-size:13px;font-weight:800;line-height:1.35}
        #${instanceId} .fmle-success{padding:28px}
        #${instanceId} .fmle-est-range{font-size:30px;font-weight:900;color:var(--fmle-primary)}
        @container(max-width:680px){#${instanceId} form{min-height:620px}#${instanceId} .fmle-est-page{padding:22px;min-height:490px}#${instanceId} .fmle-logo{height:48px;max-width:160px}#${instanceId} h3{font-size:28px}#${instanceId} h4{font-size:22px}#${instanceId} .fmle-est-grid,#${instanceId} .fmle-est-options{grid-template-columns:1fr}#${instanceId} .fmle-est-actions{padding:0 22px 22px}#${instanceId} .fmle-est-dots{padding:0 22px 16px}}
        @media(max-width:680px){#${instanceId} form{min-height:620px}#${instanceId} .fmle-est-page{padding:22px;min-height:490px}#${instanceId} .fmle-logo{height:48px;max-width:160px}#${instanceId} h3{font-size:28px}#${instanceId} h4{font-size:22px}#${instanceId} .fmle-est-grid,#${instanceId} .fmle-est-options{grid-template-columns:1fr}#${instanceId} .fmle-est-actions{padding:0 22px 22px}#${instanceId} .fmle-est-dots{padding:0 22px 16px}}
      </style>
      <form data-instant-estimate="true">
        <section class="fmle-est-page active" data-est-page>
          <div class="fmle-est-brand">${logo}</div>
          <h3>${esc(copy.headline || 'Get a free instant estimate')}</h3>
          <p>${esc(copy.subheadline || 'Answer a few questions and preview your project range.')}</p>
        </section>
        <section class="fmle-est-page" data-est-page>
          <h4>What is the project address?</h4>
          <label>Address<input name="address" autocomplete="street-address" required></label>
          <input type="hidden" name="latitude">
          <input type="hidden" name="longitude">
          <div class="fmle-address-actions"><button type="button" data-est-preview>Show rooftop mask</button></div>
          <div class="fmle-solar-preview" data-est-preview-panel><span>Enter the address, then load the top-down Solar mask.</span></div>
        </section>
        ${questions.map(renderEstimateQuestion).join('')}
        <section class="fmle-est-page" data-est-page>
          <h4>Tell us about your project</h4>
          <label>Project details<textarea name="message"></textarea></label>
        </section>
        <section class="fmle-est-page" data-est-page>
          <h4>Where should we send your estimate?</h4>
          <div class="fmle-est-grid">
            <label>Name<input name="name" autocomplete="name" required></label>
            <label>Phone<input name="phone" autocomplete="tel" inputmode="tel"></label>
            <label>Email<input name="email" autocomplete="email" inputmode="email" required></label>
          </div>
          <p>${esc(copy.fine_print || 'By submitting, you agree to be contacted about your request.')}</p>
        </section>
        <div class="fmle-est-dots">${dots}</div>
        <div class="fmle-est-actions">
          <button type="button" class="secondary" data-est-prev>Previous</button>
          <button type="button" data-est-next>Next</button>
          <button type="submit" data-est-submit style="display:none">${esc(copy.submit_label || 'Get my estimate')}</button>
        </div>
        <div class="fmle-status" role="status"></div>
      </form>
    `;
  }
  function renderMarkup(form, instanceId){
    if (form.mode === 'instant_estimate') return renderEstimateMarkup(form, instanceId);
    const copy = form.copy || {};
    const style = form.style || {};
    const font = cleanText(style.font_family || 'Montserrat');
    injectFont(font);
    const logo = style.logo_enabled && style.logo_url ? `<img class="fmle-logo" src="${esc(style.logo_url)}" alt="">` : '';
    const showSchedule = form.mode === 'appointment' || form.mode === 'call';
    return `
      <style>
        #${instanceId}.fmle-wrap{--fmle-primary:${esc(style.primary_color || '#d93025')};--fmle-secondary:${esc(style.secondary_color || '#111827')};--fmle-bg:${esc(style.background_color || '#fff')};--fmle-text:${esc(style.text_color || '#111827')};font-family:${JSON.stringify(font)},Arial,sans-serif;background:var(--fmle-bg);color:var(--fmle-text);border:1px solid rgba(15,23,42,.12);border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,.12);overflow:hidden;max-width:920px;container-type:inline-size}
        #${instanceId} *{box-sizing:border-box}
        #${instanceId} .fmle-head{padding:26px 28px 18px;background:linear-gradient(180deg,rgba(0,0,0,.035),rgba(0,0,0,0));display:flex;align-items:center;gap:18px}
        #${instanceId} .fmle-logo{height:58px;width:auto;max-width:190px;object-fit:contain;flex:0 0 auto}
        #${instanceId} .fmle-headText{display:grid;gap:7px;min-width:0}
        #${instanceId} h3{margin:0;font-size:24px;line-height:1.08;font-weight:900;letter-spacing:0}
        #${instanceId} p{margin:0;color:color-mix(in srgb,var(--fmle-text) 68%,#fff);font-size:14px;line-height:1.4;font-weight:700}
        #${instanceId} form{padding:0 28px 28px;display:grid;gap:16px}
        #${instanceId} label{display:grid;gap:6px;font-size:11px;font-weight:900;text-transform:uppercase;color:color-mix(in srgb,var(--fmle-text) 64%,#fff)}
        #${instanceId} input,#${instanceId} textarea,#${instanceId} select{width:100%;border:1px solid rgba(15,23,42,.18);border-radius:8px;padding:11px 12px;font:inherit;font-size:14px;font-weight:700;background:#fff;color:#111827;outline:none}
        #${instanceId} textarea{min-height:84px;resize:vertical}
        #${instanceId} input:focus,#${instanceId} textarea:focus,#${instanceId} select:focus{border-color:var(--fmle-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmle-primary) 18%,transparent)}
        #${instanceId} .fmle-contact{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
        #${instanceId} button{border:0;border-radius:8px;background:var(--fmle-primary);color:#fff;padding:13px 14px;font:inherit;font-size:14px;font-weight:900;cursor:pointer}
        #${instanceId} .fmle-booking{display:grid;grid-template-columns:minmax(300px,1.35fr) minmax(170px,.65fr);gap:18px;align-items:stretch}
        #${instanceId} .fmle-calendar,#${instanceId} .fmle-time-panel{border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;padding:16px}
        #${instanceId} .fmle-cal-head{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:900;margin-bottom:14px}
        #${instanceId} .fmle-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
        #${instanceId} .fmle-cal-dow{text-align:center;font-size:10px;font-weight:900;color:color-mix(in srgb,var(--fmle-text) 54%,#fff);padding:4px 0}
        #${instanceId} .fmle-cal-day{border:1px solid transparent;background:#fff;color:#111827;border-radius:8px;padding:9px 0;font-size:13px;font-weight:900;box-shadow:none}
        #${instanceId} .fmle-cal-day.muted{color:#a1a1aa}
        #${instanceId} .fmle-cal-day.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        #${instanceId} .fmle-mobile-days{display:none;gap:8px;overflow-x:auto;padding:2px calc(50% - 35px) 8px;scroll-snap-type:x proximity;scroll-behavior:smooth;mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent)}
        #${instanceId} .fmle-day-pill{min-width:70px;border:1px solid rgba(15,23,42,.14);background:#fff;color:#111827;border-radius:10px;padding:9px 10px;display:grid;gap:3px;scroll-snap-align:start;box-shadow:none}
        #${instanceId} .fmle-day-pill span{font-size:11px;font-weight:900;color:color-mix(in srgb,var(--fmle-text) 58%,#fff)}
        #${instanceId} .fmle-day-pill b{font-size:18px;line-height:1}
        #${instanceId} .fmle-day-pill.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        #${instanceId} .fmle-day-pill.active span{color:#fff}
        #${instanceId} .fmle-time-title{font-size:13px;font-weight:900;margin-bottom:13px;text-align:center}
        #${instanceId} .fmle-slots{height:225px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:88px 6px;scroll-snap-type:y proximity;scroll-behavior:smooth;mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent);-webkit-mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent)}
        #${instanceId} .fmle-slot{border:1px solid rgba(15,23,42,.16);background:#fff;color:#111827;border-radius:8px;padding:12px 10px;font-size:14px;font-weight:900;box-shadow:none;scroll-snap-align:center}
        #${instanceId} .fmle-slot:hover{border-color:var(--fmle-primary)}
        #${instanceId} .fmle-slot.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        #${instanceId} .fmle-slot[disabled]{opacity:.42;cursor:not-allowed;text-decoration:line-through}
        #${instanceId} .fmle-schedule-note{min-height:8px;margin-top:12px;font-size:12px;font-weight:800;color:color-mix(in srgb,var(--fmle-text) 62%,#fff);line-height:1.35}
        #${instanceId} button[disabled]{opacity:.62;cursor:progress}
        #${instanceId} .fmle-fine{font-size:11px;line-height:1.35;font-weight:700;color:color-mix(in srgb,var(--fmle-text) 54%,#fff)}
        #${instanceId} .fmle-status{font-size:13px;font-weight:800;line-height:1.35}
        #${instanceId} .fmle-success{padding:22px}
        #${instanceId} .fmle-time-panel button[type="submit"]{display:block;width:auto;min-width:150px;margin:18px auto 0;padding:10px 18px}
        @container(max-width:680px){#${instanceId}.fmle-wrap{max-width:none;border-radius:10px}#${instanceId} .fmle-head{display:grid;gap:10px;padding:22px 20px 14px}#${instanceId} .fmle-logo{height:48px;width:auto;max-width:160px}#${instanceId} form{padding:0 20px 22px}#${instanceId} .fmle-contact,#${instanceId} .fmle-booking{grid-template-columns:1fr}#${instanceId} .fmle-calendar{display:none}#${instanceId} .fmle-mobile-days{display:flex}#${instanceId} .fmle-slots{height:210px}#${instanceId} .fmle-fine{order:8}}
        @media(max-width:680px){#${instanceId}.fmle-wrap{max-width:none;border-radius:10px}#${instanceId} .fmle-head{display:grid;gap:10px;padding:22px 20px 14px}#${instanceId} .fmle-logo{height:48px;width:auto;max-width:160px}#${instanceId} form{padding:0 20px 22px}#${instanceId} .fmle-contact,#${instanceId} .fmle-booking{grid-template-columns:1fr}#${instanceId} .fmle-calendar{display:none}#${instanceId} .fmle-mobile-days{display:flex}#${instanceId} .fmle-slots{height:210px}#${instanceId} .fmle-fine{order:8}}
      </style>
      <div class="fmle-head">
        ${logo}
        <div class="fmle-headText">
          <h3>${esc(copy.headline || 'Schedule an appointment')}</h3>
          <p>${esc(copy.subheadline || '')}</p>
        </div>
      </div>
      <form>
        <div class="fmle-contact">
          <label>Name<input name="name" autocomplete="name" required></label>
          <label>Phone<input name="phone" autocomplete="tel" inputmode="tel" required></label>
          <label>Email<input name="email" autocomplete="email" inputmode="email"></label>
        </div>
        <label>Address<input name="address" autocomplete="street-address"></label>
        ${showSchedule ? `<div class="fmle-booking">
          <input name="preferred_start_at" type="hidden">
          <div class="fmle-mobile-days" data-mobile-days></div>
          <section class="fmle-calendar">
            <div class="fmle-cal-head"><span data-cal-month></span></div>
            <div class="fmle-cal-grid" data-calendar></div>
          </section>
          <section class="fmle-time-panel">
            <div class="fmle-time-title" data-selected-day>Choose a day</div>
            <div class="fmle-slots" data-slots><button type="button" disabled>Loading times...</button></div>
            <div class="fmle-schedule-note" data-schedule-note></div>
            <button type="submit">${esc(copy.submit_label || 'Submit')}</button>
          </section>
        </div>` : ''}
        ${!showSchedule ? `<label>Message<textarea name="message"></textarea></label>` : ''}
        ${!showSchedule ? `<button type="submit">${esc(copy.submit_label || 'Submit')}</button>` : ''}
        <div class="fmle-fine">${esc(copy.fine_print || '')}</div>
        <div class="fmle-status" role="status"></div>
      </form>
    `;
  }
  async function hydrateBooking(wrap, baseUrl, formId){
    const hidden = wrap.querySelector('input[name="preferred_start_at"]');
    const calendarEl = wrap.querySelector('[data-calendar]');
    const monthEl = wrap.querySelector('[data-cal-month]');
    const mobileDaysEl = wrap.querySelector('[data-mobile-days]');
    const selectedDayEl = wrap.querySelector('[data-selected-day]');
    const slotsEl = wrap.querySelector('[data-slots]');
    const noteEl = wrap.querySelector('[data-schedule-note]');
    if (!hidden || !slotsEl) return;
    let selectedDate = localDateInput();
    const centerInScroller = (scroller, item, axis = 'x', behavior = 'smooth') => {
      if (!scroller || !item) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (axis === 'y') {
        const delta = (itemRect.top + itemRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2);
        scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior });
        return;
      }
      const delta = (itemRect.left + itemRect.width / 2) - (scrollerRect.left + scrollerRect.width / 2);
      scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + delta), behavior });
    };
    const restoreHorizontalScroll = (scroller, left) => {
      if (!scroller) return;
      const previousBehavior = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollLeft = left;
      void scroller.offsetWidth;
      scroller.style.scrollBehavior = previousBehavior;
    };
    const centerSelectedDay = (behavior = 'smooth') => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        centerInScroller(mobileDaysEl, mobileDaysEl?.querySelector('.fmle-day-pill.active'), 'x', behavior);
      }));
    };
    const centerSelectedSlot = (behavior = 'smooth') => {
      requestAnimationFrame(() => {
        centerInScroller(slotsEl, slotsEl?.querySelector('.fmle-slot.active'), 'y', behavior);
      });
    };
    const renderDays = () => {
      const previousMobileScroll = mobileDaysEl ? mobileDaysEl.scrollLeft : 0;
      const selected = dateFromInput(selectedDate);
      if (monthEl) monthEl.textContent = selected.toLocaleDateString([], { month:'long', year:'numeric' });
      if (calendarEl) {
        const dows = ['S','M','T','W','T','F','S'].map((day) => `<div class="fmle-cal-dow">${day}</div>`).join('');
        calendarEl.innerHTML = dows + calendarDays(selectedDate).map((date) => dayButton(date, selectedDate, false)).join('');
      }
      if (mobileDaysEl) {
        mobileDaysEl.innerHTML = upcomingDays(21).map((date) => dayButton(date, selectedDate, true)).join('');
        restoreHorizontalScroll(mobileDaysEl, previousMobileScroll);
      }
      if (selectedDayEl) selectedDayEl.textContent = selected.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
      centerSelectedDay('smooth');
      wrap.querySelectorAll('[data-date]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedDate = button.dataset.date || selectedDate;
          renderDays();
          load(false);
        });
      });
    };
    const load = async (autoAdvance = false) => {
      hidden.value = '';
      slotsEl.innerHTML = '<button type="button" disabled>Loading times...</button>';
      try {
        const data = await jsonFetch(baseUrl, `/public/forms/${encodeURIComponent(formId)}/availability?date=${encodeURIComponent(selectedDate)}`);
        const slots = Array.isArray(data.slots) ? data.slots : [];
        let available = slots.filter((slot) => slot.available || slot.hasAvailability);
        if (!available.length && autoAdvance) {
          for (let offset = 1; offset <= 14; offset += 1) {
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + offset);
            const nextDateText = localDateInput(nextDate);
            const nextData = await jsonFetch(baseUrl, `/public/forms/${encodeURIComponent(formId)}/availability?date=${encodeURIComponent(nextDateText)}`);
            const nextAvailable = (Array.isArray(nextData.slots) ? nextData.slots : []).filter((slot) => slot.available || slot.hasAvailability);
            if (nextAvailable.length) {
              selectedDate = nextDateText;
              available = nextAvailable;
              renderDays();
              break;
            }
          }
        }
        slotsEl.innerHTML = available.length
          ? available.map((slot) => `<button type="button" class="fmle-slot" data-start="${esc(slot.start)}">${esc(slot.label || slot.time)}</button>`).join('')
          : '<button type="button" disabled>No times available</button>';
        if (noteEl) noteEl.textContent = available.length
          ? ''
          : 'Choose another date to see more availability.';
        slotsEl.querySelectorAll('.fmle-slot').forEach((button) => {
          button.addEventListener('click', () => {
            hidden.value = button.dataset.start || '';
            slotsEl.querySelectorAll('.fmle-slot').forEach((item) => item.classList.toggle('active', item === button));
            centerSelectedSlot('smooth');
          });
        });
      } catch (error) {
        slotsEl.innerHTML = '<button type="button" disabled>Times unavailable</button>';
        if (noteEl) noteEl.textContent = error.message || 'Could not load appointment times.';
      }
    };
    renderDays();
    await load(true);
  }
  async function loadSolarPreview(formEl, baseUrl, formId){
    const address = cleanText(formEl.querySelector('input[name="address"]')?.value);
    const panel = formEl.querySelector('[data-est-preview-panel]');
    const latInput = formEl.querySelector('input[name="latitude"]');
    const lngInput = formEl.querySelector('input[name="longitude"]');
    if (!address || !panel) return false;
    panel.dataset.previewAttempted = 'true';
    panel.innerHTML = '<span>Loading top-down Solar mask...</span>';
    try {
      const data = await jsonFetch(baseUrl, `/public/forms/${encodeURIComponent(formId)}/solar-preview`, {
        method: 'POST',
        body: JSON.stringify({ address })
      });
      if (data?.ok && data.image && data.mask) {
        if (latInput) latInput.value = cleanText(data.latitude);
        if (lngInput) lngInput.value = cleanText(data.longitude);
        panel.dataset.previewReady = 'true';
        panel.innerHTML = `<img src="${esc(data.image)}" alt=""><img class="mask" src="${esc(data.mask)}" alt=""><span>${esc(data.formatted_address || address)}</span>`;
        return true;
      }
      panel.dataset.previewReady = 'false';
      panel.innerHTML = `<span>${esc(data?.error || data?.status || 'Solar mask unavailable for this address.')}</span>`;
      return false;
    } catch (error) {
      panel.dataset.previewReady = 'false';
      panel.innerHTML = `<span>${esc(error?.message || 'Solar mask unavailable for this address.')}</span>`;
      return false;
    }
  }
  function hydrateInstantEstimate(wrap, baseUrl, formId){
    const formEl = wrap.querySelector('form[data-instant-estimate="true"]');
    if (!formEl) return;
    const pages = Array.from(formEl.querySelectorAll('[data-est-page]'));
    const prev = formEl.querySelector('[data-est-prev]');
    const next = formEl.querySelector('[data-est-next]');
    const submit = formEl.querySelector('[data-est-submit]');
    const status = formEl.querySelector('.fmle-status');
    let current = 0;
    const pageIsComplete = (page) => {
      const controls = Array.from(page.querySelectorAll('input,textarea,select'));
      for (const control of controls) {
        if (control.required && !cleanText(control.value)) return false;
        if (control.type === 'radio' && control.required) {
          const checked = page.querySelector(`input[name="${CSS.escape(control.name)}"]:checked`);
          if (!checked) return false;
        }
      }
      return true;
    };
    const show = (index) => {
      current = Math.max(0, Math.min(pages.length - 1, index));
      pages.forEach((page, pageIndex) => page.classList.toggle('active', pageIndex === current));
      formEl.querySelectorAll('[data-est-jump]').forEach((button, pageIndex) => {
        button.classList.toggle('active', pageIndex === current);
      });
      if (prev) prev.disabled = current === 0;
      if (next) next.style.display = current === pages.length - 1 ? 'none' : '';
      if (submit) submit.style.display = current === pages.length - 1 ? '' : 'none';
      if (status) status.textContent = '';
    };
    prev?.addEventListener('click', () => show(current - 1));
    next?.addEventListener('click', async () => {
      if (!pageIsComplete(pages[current])) {
        if (status) status.textContent = 'Complete this page to continue.';
        return;
      }
      const previewPanel = pages[current].querySelector('[data-est-preview-panel]');
      if (previewPanel && previewPanel.dataset.previewAttempted !== 'true') {
        if (status) status.textContent = 'Loading the rooftop mask...';
        await loadSolarPreview(formEl, baseUrl, formId);
        if (status) status.textContent = 'Review the top-down mask, then continue.';
        return;
      }
      show(current + 1);
    });
    formEl.querySelector('[data-est-preview]')?.addEventListener('click', async () => {
      if (status) status.textContent = '';
      await loadSolarPreview(formEl, baseUrl, formId);
    });
    formEl.querySelector('input[name="address"]')?.addEventListener('input', () => {
      const panel = formEl.querySelector('[data-est-preview-panel]');
      if (panel) {
        delete panel.dataset.previewAttempted;
        delete panel.dataset.previewReady;
        panel.innerHTML = '<span>Enter the address, then load the top-down Solar mask.</span>';
      }
      const latInput = formEl.querySelector('input[name="latitude"]');
      const lngInput = formEl.querySelector('input[name="longitude"]');
      if (latInput) latInput.value = '';
      if (lngInput) lngInput.value = '';
    });
    formEl.querySelectorAll('[data-est-jump]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = Number(button.dataset.estJump);
        if (target > current && !pages.slice(0, target).every(pageIsComplete)) {
          if (status) status.textContent = 'Complete the previous pages first.';
          return;
        }
        show(target);
      });
    });
    show(0);
  }
  function instantEstimateBody(formEl){
    const body = Object.fromEntries(new FormData(formEl).entries());
    const answers = {};
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith('answer_')) {
        answers[key.slice('answer_'.length)] = value;
        delete body[key];
      }
    }
    body.answers = answers;
    return body;
  }
  function estimateSuccessMarkup(form, result){
    const copy = form.copy || {};
    const style = form.style || {};
    const font = cleanText(style.font_family || 'Montserrat');
    const estimate = result?.instant_estimate?.estimate || {};
    const currency = cleanText(estimate.currency || 'USD');
    const fmt = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return '';
      return new Intl.NumberFormat('en-US', { style:'currency', currency, maximumFractionDigits:0 }).format(number);
    };
    const range = fmt(estimate.low || estimate.low_price) && fmt(estimate.high || estimate.high_price)
      ? `${fmt(estimate.low || estimate.low_price)} - ${fmt(estimate.high || estimate.high_price)}`
      : '';
    return `<div class="fmle-success" style="font-family:${esc(font)},Arial,sans-serif;padding:28px;color:${esc(style.text_color || '#111827')};background:${esc(style.background_color || '#ffffff')};border:1px solid rgba(15,23,42,.12);border-radius:12px;box-shadow:0 18px 50px rgba(15,23,42,.12);max-width:920px;">
      <h3 style="margin:0 0 14px;font-size:28px;line-height:1.1;font-weight:900;letter-spacing:0;">${esc(copy.success_title || 'Estimate ready')}</h3>
      ${range ? `<div class="fmle-est-range" style="margin:0 0 12px;font-size:30px;line-height:1.1;font-weight:900;color:${esc(style.primary_color || '#d93025')};">${esc(range)}</div>` : ''}
      <p style="margin:0;color:color-mix(in srgb,${esc(style.text_color || '#111827')} 68%,#fff);font-size:15px;line-height:1.5;font-weight:700;">${esc(copy.success_body || 'We have your information and will follow up shortly.')}</p>
    </div>`;
  }
  async function render(options = {}){
    const script = currentScript();
    const formId = cleanText(options.formId || script?.dataset?.formId);
    if (!formId) throw new Error('FirstMateLeadEmbed requires a formId.');
    const baseUrl = cleanText(options.baseUrl || script?.dataset?.baseUrl || defaultBaseUrl());
    const mount = resolveTarget(options.target || script?.dataset?.target, script);
    const instanceId = `fmle_${Math.random().toString(36).slice(2, 10)}`;
    mount.innerHTML = `<div id="${instanceId}" class="fmle-wrap"><div class="fmle-head"><h3>Loading...</h3></div></div>`;
    const data = await jsonFetch(baseUrl, `/public/forms/${encodeURIComponent(formId)}`);
    const form = data.form || {};
    const wrap = mount.querySelector(`#${instanceId}`);
    wrap.innerHTML = renderMarkup(form, instanceId);
    hydrateBooking(wrap, baseUrl, formId).catch(() => null);
    hydrateInstantEstimate(wrap, baseUrl, formId);
    wrap.querySelector('form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget;
      const button = formEl.querySelector('button[type="submit"]');
      const status = formEl.querySelector('.fmle-status');
      const body = formEl.dataset.instantEstimate === 'true' ? instantEstimateBody(formEl) : Object.fromEntries(new FormData(formEl).entries());
      if (formEl.querySelector('input[name="preferred_start_at"]') && !cleanText(body.preferred_start_at)) {
        status.textContent = 'Choose an appointment time.';
        return;
      }
      body.page_url = location.href;
      body.referrer = document.referrer;
      button.disabled = true;
      status.textContent = 'Sending...';
      try {
        const result = await jsonFetch(baseUrl, `/public/forms/${encodeURIComponent(formId)}/submit`, { method:'POST', body: JSON.stringify(body) });
        wrap.innerHTML = formEl.dataset.instantEstimate === 'true'
          ? estimateSuccessMarkup(form, result)
          : `<div class="fmle-success"><h3>${esc(form.copy?.success_title || 'Request received')}</h3><p>${esc(form.copy?.success_body || 'We will follow up shortly.')}</p></div>`;
      } catch (error) {
        status.textContent = error.message || 'Could not send this request.';
        button.disabled = false;
      }
    });
    return { form, mount };
  }

  root.FirstMateLeadEmbed = { render };
  const script = currentScript();
  if (script?.dataset?.formId && script.dataset.auto !== 'false') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => render().catch(console.error), { once:true });
    else render().catch(console.error);
  }
})();
