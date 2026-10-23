/**
 * FMPresentSigning — signing an agreement in person, inside a presentation.
 *
 *   FMPresentSigning.open(container, {
 *     base,          // .../documents/organizations/:org/documents/:doc/signing/present
 *     request,       // (url, { method, body }) => Promise<json> (PlatformAPI.request: session + CSRF)
 *     signer,        // { name, email } the agreement was issued to
 *     title, total,  // what is being agreed to, as the presentation showed it
 *     company,       // who it is with
 *     onDone,        // ({ signed, sealed }) once the customer is finished
 *     onBack         // back to the presentation, before anything is signed
 *   }) -> { close }
 *
 * The contract on the left is the retained review PDF the engine signs (the
 * exact bytes its content hash covers), drawn page by page. The right side is
 * the one consent checkbox with the disclosure beside it, the adopted
 * signature and Adopt & sign. Signing runs through the documents signing
 * engine's presenter route: the presenter attested before handing the screen
 * over, the customer consents and signs, the server checks the challenge and
 * content hash, records the receipt in the ledger and seals the executed copy,
 * which is emailed to the signer. Nothing here decides that a signature
 * counts: the server's answer does.
 */
(function (root) {
  'use strict';
  const FONTS = { script: '"Brush Script MT","Segoe Script","Snell Roundhand",cursive', elegant: '"Lucida Handwriting","Apple Chancery",cursive', casual: '"Segoe Print","Bradley Hand","Comic Sans MS",cursive' };
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (value) => String(value ?? '').trim();
  const t = (key, fallback, vars) => root.PlatformLanguage?.text?.('doc-present', key, fallback, vars) ?? fallback;

  let pdfjs = null;
  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (pdfjs) return pdfjs;
    pdfjs = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS + 'pdf.min.js';
      script.onload = () => { const lib = root.pdfjsLib; if (!lib) { reject(new Error('pdf.js')); return; } lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(lib); };
      script.onerror = () => { pdfjs = null; reject(new Error('pdf.js')); };
      document.head.appendChild(script);
    });
    return pdfjs;
  }

  const STYLE = `
.fmps{position:absolute;inset:0;z-index:2147483600;display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,400px);background:#0b0d12;color:#101828;font-family:var(--fm-body-font,Inter),system-ui,Segoe UI,Arial,sans-serif}
.fmps-doc{position:relative;min-width:0;min-height:0;display:flex;flex-direction:column;background:#3b414c}
.fmps-doc-head{flex:none;display:flex;align-items:center;gap:10px;padding:12px 18px;color:#e7eaf0;font-size:13px;font-weight:600}
.fmps-doc-head strong{font-size:14px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmps-doc-head span{margin-left:auto;color:#aab2c0;font-weight:600;white-space:nowrap}
.fmps-pages{flex:1;min-height:0;overflow:auto;padding:4px 18px 28px;display:flex;flex-direction:column;align-items:center;gap:14px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.fmps-pages canvas{display:block;background:#fff;box-shadow:0 6px 22px rgba(0,0,0,.35);border-radius:2px;max-width:100%}
.fmps-pages iframe{flex:1;width:100%;min-height:70vh;border:0;background:#fff}
.fmps-wait{margin:auto;display:grid;justify-items:center;gap:12px;color:#d0d5dd;font-size:14px;font-weight:600;text-align:center;max-width:420px}
.fmps-spin{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:fmps-spin .8s linear infinite}
@keyframes fmps-spin{to{transform:rotate(360deg)}}
.fmps-disclosure{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;background:#fff;transform:translateX(-100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);visibility:hidden}
.fmps.disclosure-open .fmps-disclosure{transform:none;visibility:visible}
.fmps-disclosure-head{flex:none;display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid #eaecf0;font-size:15px;font-weight:800}
.fmps-disclosure-head button{margin-left:auto}
.fmps-disclosure-text{flex:1;overflow:auto;padding:18px 26px 30px;font-size:14px;line-height:1.6;color:#344054;max-width:760px}
.fmps-disclosure-text h4{margin:16px 0 2px;font-size:14px;color:#101828}
.fmps-disclosure-text p{margin:0}
.fmps-side{min-height:0;overflow:auto;background:#fff;display:flex;flex-direction:column;padding:26px 26px 20px;box-shadow:-12px 0 30px rgba(0,0,0,.25)}
.fmps-side h2{margin:0 0 4px;font-size:22px;font-weight:800;letter-spacing:-.01em}
.fmps-sub{margin:0 0 18px;font-size:13.5px;line-height:1.5;color:#475467}
.fmps-who{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #eaecf0;border-radius:12px;background:#f9fafb;margin-bottom:16px}
.fmps-avatar{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--fm-primary,#d93025);color:#fff;font-weight:800}
.fmps-who strong{display:block;font-size:14px}
.fmps-who small{display:block;font-size:12.5px;color:#667085;overflow-wrap:anywhere}
.fmps-consent{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1.5px solid #d0d5dd;border-radius:12px;cursor:pointer;font-size:14px;line-height:1.45;margin-bottom:16px;transition:border-color .15s,background .15s}
.fmps-consent input{flex:none;width:20px;height:20px;margin:1px 0 0;accent-color:var(--fm-primary,#d93025)}
.fmps-consent.checked{border-color:var(--fm-primary,#d93025);background:color-mix(in srgb,var(--fm-primary,#d93025) 6%,#fff)}
.fmps-consent.nudge{animation:fmps-nudge .35s}
@keyframes fmps-nudge{20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(5px)}}
.fmps-link{border:0;background:none;padding:0;color:#1d4ed8;font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.fmps-label{display:block;font-size:12px;font-weight:700;color:#475467;margin:0 0 6px}
.fmps-input{width:100%;box-sizing:border-box;border:1.5px solid #d0d5dd;border-radius:10px;padding:12px 14px;font:600 16px/1.2 inherit;color:#101828;margin-bottom:14px}
.fmps-input:focus{outline:none;border-color:var(--fm-primary,#d93025)}
.fmps-tabs{display:flex;gap:4px;padding:4px;border-radius:10px;background:#f2f4f7;margin-bottom:10px}
.fmps-tabs button{flex:1;border:0;border-radius:8px;background:none;padding:9px;font:700 13px/1 inherit;color:#475467;cursor:pointer}
.fmps-tabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.fmps-pad{position:relative;height:120px;border:1.5px dashed #d0d5dd;border-radius:12px;background:#fcfcfd;margin-bottom:6px;overflow:hidden}
.fmps-pad .typed{position:absolute;inset:0;display:grid;place-items:center;padding:0 14px;font-size:40px;color:#101828;white-space:nowrap;overflow:hidden}
.fmps-pad canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair}
.fmps-pad .hint{position:absolute;left:14px;bottom:8px;font-size:11.5px;color:#98a2b3;pointer-events:none}
.fmps-pad-tools{display:flex;justify-content:space-between;align-items:center;min-height:26px;margin-bottom:14px}
.fmps-styles{display:flex;gap:6px}
.fmps-styles button{border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:3px 10px;font-size:17px;cursor:pointer}
.fmps-styles button.on{border-color:var(--fm-primary,#d93025)}
.fmps-error{min-height:0;margin:0 0 10px;padding:0;border-radius:10px;font-size:13.5px;font-weight:600;line-height:1.45;color:#b42318;background:#fef3f2;overflow:hidden;max-height:0;transition:max-height .2s,padding .2s}
.fmps-error.on{max-height:160px;padding:10px 12px}
.fmps-go{width:100%;border:0;border-radius:12px;background:var(--fm-primary,#d93025);color:#fff;font:800 16px/1 inherit;padding:16px;cursor:pointer}
.fmps-go[disabled]{opacity:.6;cursor:default}
.fmps-fine{margin:12px 0 0;font-size:11.5px;line-height:1.5;color:#667085}
.fmps-fine code{font-size:11px;color:#344054;word-break:break-all}
.fmps-back{margin-top:auto;padding-top:16px;border:0;background:none;color:#667085;font:600 13px/1 inherit;cursor:pointer;align-self:flex-start}
.fmps-done{display:grid;justify-items:center;text-align:center;gap:10px;margin:auto 0}
.fmps-mark{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;background:var(--fm-primary,#d93025);color:#fff;font-size:32px;font-weight:800;margin-bottom:6px}
.fmps-steps{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px;text-align:left;font-size:13.5px;color:#344054}
.fmps-steps li{display:flex;gap:10px;align-items:center}
.fmps-steps li i{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:11px;font-weight:800;background:#ecfdf3;color:#067647}
.fmps-steps li.wait i{background:#f2f4f7;color:#667085;animation:fmps-pulse 1.2s ease-in-out infinite}
@keyframes fmps-pulse{50%{opacity:.4}}
@media (max-width:820px),(orientation:portrait) and (max-width:1024px){
  .fmps{grid-template-columns:1fr;grid-template-rows:minmax(0,46%) minmax(0,1fr)}
  .fmps-side{box-shadow:0 -12px 30px rgba(0,0,0,.25);padding:20px 18px}
}`;

  function open(container, options) {
    const opts = Object.assign({}, options || {});
    const request = opts.request;
    const base = clean(opts.base).replace(/\/$/, '');
    const signer = Object.assign({ name: '', email: '' }, opts.signer || {});
    if (!document.getElementById('fmps-style')) { const style = document.createElement('style'); style.id = 'fmps-style'; style.textContent = STYLE; document.head.appendChild(style); }
    const el = document.createElement('div');
    el.className = 'fmps';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('sign_dialog', 'Sign the agreement'));
    el.innerHTML = `
      <section class="fmps-doc" aria-label="${esc(t('sign_contract', 'The agreement'))}">
        <div class="fmps-doc-head"><strong>${esc(opts.title || t('sign_contract', 'The agreement'))}</strong><span data-pages></span></div>
        <div class="fmps-pages" data-doc tabindex="0"><div class="fmps-wait"><div class="fmps-spin"></div>${esc(t('sign_preparing', 'Preparing your agreement…'))}</div></div>
        <aside class="fmps-disclosure" aria-label="${esc(t('sign_disclosure_title', 'Electronic records and signature disclosure'))}">
          <div class="fmps-disclosure-head">${esc(t('sign_disclosure_title', 'Electronic records and signature disclosure'))}<button type="button" class="fmps-link" data-disclosure-close>${esc(t('sign_disclosure_close', 'Back to the agreement'))}</button></div>
          <div class="fmps-disclosure-text" data-disclosure>${esc(t('sign_preparing', 'Preparing your agreement…'))}</div>
        </aside>
      </section>
      <section class="fmps-side" data-side></section>`;
    container.appendChild(el);
    const side = el.querySelector('[data-side]');
    const docEl = el.querySelector('[data-doc]');
    let review = null;
    let closed = false;
    const close = () => { closed = true; el.remove(); };
    const setDisclosure = (on) => el.classList.toggle('disclosure-open', on);
    el.querySelector('[data-disclosure-close]').addEventListener('click', () => setDisclosure(false));

    /** The pages of a PDF, drawn to the width of the left side. */
    async function showPdf(bytes) {
      const pages = el.querySelector('[data-pages]');
      try {
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
        if (closed) return;
        docEl.innerHTML = '';
        pages.textContent = pdf.numPages === 1 ? t('sign_one_page', '1 page') : t('sign_pages', `${pdf.numPages} pages`, { count: pdf.numPages });
        const width = Math.max(320, docEl.clientWidth - 36);
        for (let number = 1; number <= pdf.numPages && !closed; number++) {
          const page = await pdf.getPage(number);
          const unscaled = page.getViewport({ scale: 1 });
          const scale = Math.min(2, width / unscaled.width);
          const ratio = Math.min(2, root.devicePixelRatio || 1);
          const viewport = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
          canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
          canvas.setAttribute('aria-label', t('sign_page_label', `Page ${number}`, { number }));
          docEl.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } catch (error) {
        // Without the page renderer the browser's own viewer shows the same file.
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        docEl.innerHTML = `<iframe title="${esc(t('sign_contract', 'The agreement'))}" src="${esc(url)}"></iframe>`;
      }
    }
    async function loadPdf() {
      const response = await fetch(base + '/pdf', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(t('sign_pdf_failed', 'The agreement could not be opened.'));
      const bytes = await response.arrayBuffer();
      if (new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5))) !== '%PDF-') throw new Error(t('sign_pdf_failed', 'The agreement could not be opened.'));
      return bytes;
    }

    const failed = (message) => {
      side.innerHTML = `<h2>${esc(t('sign_unavailable', 'This can’t be signed here right now'))}</h2><p class="fmps-sub">${esc(message)}</p><button type="button" class="fmps-back" data-back>← ${esc(t('sign_back', 'Back to the presentation'))}</button>`;
      side.querySelector('[data-back]').addEventListener('click', () => { close(); opts.onBack?.(); });
      if (!docEl.querySelector('canvas,iframe')) docEl.innerHTML = `<div class="fmps-wait">${esc(message)}</div>`;
    };

    function form() {
      const fingerprint = clean(review.content_hash);
      side.innerHTML = `
        <h2>${esc(t('sign_title', 'Review and sign'))}</h2>
        <p class="fmps-sub">${esc(opts.company ? t('sign_intro_company', `Your agreement with ${opts.company}${opts.total ? `, ${opts.total}` : ''}. The full agreement is on the left.`, { company: opts.company, total: opts.total || '' }) : t('sign_intro', 'The full agreement is on the left.'))}</p>
        <div class="fmps-who"><span class="fmps-avatar">${esc((signer.name || signer.email || '?').trim().charAt(0).toUpperCase())}</span><span><strong>${esc(signer.name || signer.email)}</strong><small>${esc(t('sign_copy_to', `Signing as the customer · a sealed copy goes to ${signer.email}`, { email: signer.email }))}</small></span></div>
        <label class="fmps-consent" data-consent-row><input type="checkbox" data-consent><span>${esc(t('sign_consent', 'I agree to sign and receive records electronically.'))} <button type="button" class="fmps-link" data-disclosure-open>${esc(t('sign_disclosure', 'Disclosure'))}</button></span></label>
        <label class="fmps-label" for="fmps-name">${esc(t('sign_full_name', 'Full name'))}</label>
        <input class="fmps-input" id="fmps-name" data-name autocomplete="name" value="${esc(signer.name)}">
        <div class="fmps-tabs" role="tablist"><button type="button" class="on" data-mode="typed">${esc(t('sign_type', 'Type'))}</button><button type="button" data-mode="drawn">${esc(t('sign_draw', 'Draw'))}</button></div>
        <div class="fmps-pad"><div class="typed" data-typed></div><canvas data-canvas hidden></canvas><span class="hint" data-hint hidden>${esc(t('sign_draw_hint', 'Sign here with your finger or mouse'))}</span></div>
        <div class="fmps-pad-tools"><div class="fmps-styles" data-styles>${Object.keys(FONTS).map((key, index) => `<button type="button" data-style="${key}" class="${index ? '' : 'on'}" style="font-family:${esc(FONTS[key])}" aria-label="${esc(key)}">Aa</button>`).join('')}</div><button type="button" class="fmps-link" data-clear hidden>${esc(t('sign_clear', 'Clear'))}</button></div>
        <p class="fmps-error" data-error role="alert"></p>
        <button type="button" class="fmps-go" data-go>${esc(t('sign_adopt', 'Adopt & sign'))}</button>
        <p class="fmps-fine">${esc(t('sign_fine', 'Adopt & sign applies this signature to the agreement shown, exactly as it is now. Agreement fingerprint:'))} <code title="${esc(fingerprint)}">${esc(fingerprint.slice(0, 16))}…</code></p>
        <button type="button" class="fmps-back" data-back>← ${esc(t('sign_back', 'Back to the presentation'))}</button>`;
      const $ = (selector) => side.querySelector(selector);
      const consent = $('[data-consent]'), consentRow = $('[data-consent-row]'), nameInput = $('[data-name]'), typed = $('[data-typed]'), canvas = $('[data-canvas]'), errorEl = $('[data-error]'), go = $('[data-go]');
      let mode = 'typed', style = 'script', ink = false, sized = false;
      const say = (message) => { errorEl.textContent = message || ''; errorEl.classList.toggle('on', !!message); };
      const paintTyped = () => { typed.textContent = clean(nameInput.value); typed.style.fontFamily = FONTS[style]; };
      paintTyped();
      consent.addEventListener('change', () => { consentRow.classList.toggle('checked', consent.checked); if (consent.checked) say(''); });
      // Opening the disclosure is beside the box, never ticks it.
      $('[data-disclosure-open]').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); setDisclosure(!el.classList.contains('disclosure-open')); });
      nameInput.addEventListener('input', () => { paintTyped(); nameInput.style.borderColor = ''; });
      $('[data-styles]').addEventListener('click', (event) => {
        const button = event.target.closest('[data-style]'); if (!button) return;
        style = button.dataset.style; side.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('on', b === button)); paintTyped();
      });
      const context = canvas.getContext('2d');
      const sizeCanvas = () => { const box = canvas.getBoundingClientRect(); if (!box.width) return; canvas.width = Math.round(Math.min(2000, box.width * 2)); canvas.height = Math.round(Math.min(1000, box.height * 2)); Object.assign(context, { lineWidth: 5, lineCap: 'round', lineJoin: 'round', strokeStyle: '#101828' }); ink = false; };
      const point = (event) => { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left) / box.width * canvas.width, (event.clientY - box.top) / box.height * canvas.height]; };
      let drawing = false;
      canvas.addEventListener('pointerdown', (event) => { drawing = true; canvas.setPointerCapture(event.pointerId); const [x, y] = point(event); context.beginPath(); context.moveTo(x, y); context.lineTo(x + 0.1, y + 0.1); context.stroke(); ink = true; $('[data-hint]').hidden = true; say(''); });
      canvas.addEventListener('pointermove', (event) => { if (!drawing) return; const [x, y] = point(event); context.lineTo(x, y); context.stroke(); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => canvas.addEventListener(name, () => { drawing = false; }));
      $('[data-clear]').addEventListener('click', () => { context.clearRect(0, 0, canvas.width, canvas.height); ink = false; $('[data-hint]').hidden = false; });
      side.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
        mode = button.dataset.mode;
        side.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === button));
        typed.hidden = mode !== 'typed'; canvas.hidden = mode !== 'drawn'; $('[data-hint]').hidden = mode !== 'drawn' || ink;
        $('[data-styles]').style.visibility = mode === 'typed' ? '' : 'hidden'; $('[data-clear]').hidden = mode !== 'drawn';
        // Sized once it is shown: a hidden canvas has no size to match.
        if (mode === 'drawn' && !sized) { sizeCanvas(); sized = true; }
      }));
      $('[data-back]').addEventListener('click', () => { close(); opts.onBack?.(); });
      go.addEventListener('click', async () => {
        say('');
        const name = clean(nameInput.value);
        if (!consent.checked) { say(t('sign_need_consent', 'Please check the box to agree to sign electronically.')); consentRow.classList.remove('nudge'); void consentRow.offsetWidth; consentRow.classList.add('nudge'); consent.focus(); return; }
        if (!name) { say(t('sign_need_name', 'Please type your full name.')); nameInput.style.borderColor = '#d92d20'; nameInput.focus(); return; }
        if (mode === 'drawn' && !ink) { say(t('sign_need_drawing', 'Please draw your signature, or switch to Type.')); return; }
        const value = { type: mode, signer_name: name, text: mode === 'typed' ? name : '', style: mode === 'typed' ? style : 'drawn', signed_at: new Date().toISOString() };
        if (mode === 'drawn') value.image_data = canvas.toDataURL('image/png');
        value.__signing = { signer_id: review.signer.id, challenge: review.challenge, content_hash: review.content_hash,
          consent: { intent: true, electronic_records: true, can_access_and_retain: true, presenter_witnessed: opts.presenterAttested === true, disclosure_hash: review.disclosure.hash } };
        go.disabled = true; go.textContent = t('sign_recording', 'Signing…');
        try {
          // One adopted signature for each field this signer holds, in order.
          for (const field of review.fields.filter((key) => !review.receipts?.[key])) {
            await request(`${base}/outputs/${encodeURIComponent(field)}`, { method: 'POST', body: { value } });
            review.receipts = Object.assign({}, review.receipts, { [field]: true });
          }
        } catch (error) {
          go.disabled = false; go.textContent = t('sign_adopt', 'Adopt & sign');
          const code = clean(error?.data?.code || error?.data?.error);
          if (code === 'signature_review_required' || code === 'signature_content_changed') { say(t('sign_changed', 'The agreement changed while it was open. It has been reloaded: please review it and sign again.')); start(); return; }
          say(error?.message || t('sign_failed', 'Your signature could not be recorded. Please try again.'));
          return;
        }
        signed(name);
      });
      setTimeout(() => { try { consent.focus({ preventScroll: true }); } catch (e) {} }, 60);
    }

    /** Signed: the executed copy is made, sealed and sent by the server; say each as it happens. */
    function signed(name) {
      setDisclosure(false);
      side.innerHTML = `
        <div class="fmps-done">
          <div class="fmps-mark">✓</div>
          <h2>${esc(t('sign_done', `Signed. Thank you, ${name.split(/\s+/)[0]}.`, { name: name.split(/\s+/)[0] }))}</h2>
          <ul class="fmps-steps">
            <li><i>✓</i>${esc(t('sign_step_signed', 'Your signature is recorded on the agreement'))}</li>
            <li class="wait" data-step-seal><i>…</i>${esc(t('sign_step_sealing', 'Sealing and timestamping the signed copy'))}</li>
            <li class="wait" data-step-mail><i>…</i>${esc(t('sign_step_mail', `Emailing your copy to ${signer.email}`, { email: signer.email }))}</li>
          </ul>
        </div>
        <button type="button" class="fmps-go" data-finish>${esc(t('sign_finish', 'Done'))}</button>`;
      let sealed = false;
      side.querySelector('[data-finish]').addEventListener('click', () => { close(); opts.onDone?.({ signed: true, sealed }); });
      // The left side now shows the executed copy, signature in place.
      loadPdf().then(showPdf).catch(() => {});
      const started = Date.now();
      const poll = async () => {
        if (closed) return;
        let status = null;
        try { status = await request(base + '/status', { method: 'GET' }); } catch (e) { status = null; }
        const seal = clean(status?.signing?.seal_status);
        if (seal === 'sealed' || (status && !seal && clean(status?.signing?.status) === 'completed')) {
          sealed = seal === 'sealed';
          side.querySelectorAll('[data-step-seal],[data-step-mail]').forEach((li) => { li.classList.remove('wait'); li.querySelector('i').textContent = '✓'; });
          if (sealed) side.querySelector('[data-step-seal]').lastChild.textContent = t('sign_step_sealed', 'The signed copy is sealed and timestamped');
          side.querySelector('[data-step-mail]').lastChild.textContent = t('sign_step_mailed', `A copy is on its way to ${signer.email}`, { email: signer.email });
          loadPdf().then(showPdf).catch(() => {});
          return;
        }
        if (Date.now() - started > 90000) { side.querySelector('[data-step-seal]').lastChild.textContent = t('sign_step_seal_later', 'The sealed copy will follow by email shortly'); return; }
        setTimeout(poll, 2500);
      };
      setTimeout(poll, 1500);
    }

    async function start() {
      side.innerHTML = `<div class="fmps-wait" style="color:#475467"><div class="fmps-spin" style="border-color:#eaecf0;border-top-color:var(--fm-primary,#d93025)"></div>${esc(t('sign_preparing', 'Preparing your agreement…'))}</div>`;
      try {
        review = await request(base + '/prepare', { method: 'POST', body: {} });
        if (closed) return;
        const blocks = clean(review?.disclosure?.text).split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
        el.querySelector('[data-disclosure]').innerHTML = blocks.map((block) => { const lines = block.split('\n'); return lines.length > 1 ? `<h4>${esc(lines[0])}</h4><p>${esc(lines.slice(1).join(' '))}</p>` : `<p>${esc(lines[0])}</p>`; }).join('');
        form();
        showPdf(await loadPdf());
      } catch (error) {
        if (!closed) failed(error?.message || t('sign_unavailable_detail', 'The agreement could not be prepared for signing.'));
      }
    }
    start();
    return { close, element: el };
  }

  root.FMPresentSigning = { open };
})(typeof window !== 'undefined' ? window : globalThis);
