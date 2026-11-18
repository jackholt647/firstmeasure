// The document setup's steps (guided experience `documents.setup`, FM-582, docs/architecture/guided-experiences.md,
// "Document setup"). It plays the first time someone who manages company settings presses New document: which kind
// of document they want to make, then for a proposal (after the company type, the kinds of work and who sells, each
// asked only while unanswered) how they present it, whether the customer may change it, how much detail it carries,
// whether a written scope of work goes with it, their prices (optional), and for every kind one of three styles,
// previewed with what their answers make. Each step is this module with its own `part`; the answers are the setup's
// selections and its finish (documents.setup.apply) makes the kind's template. It reads through the publication layer
// only (document-setup.price_sheet, .previews) and writes nothing itself.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxd{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 0 8px;color:#101828}
.gxd p{margin:0;color:#475467;line-height:1.5;font-size:13px}
.gxd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gxd-tile{position:relative;display:flex;align-items:flex-start;gap:12px;min-height:76px;padding:14px 42px 14px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s}
.gxd-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxd-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-tile>span:not(.gxd-icon):not(.gxd-tick){display:flex;flex-direction:column;gap:3px;min-width:0}
.gxd-tile strong{font-size:14px;font-weight:700;line-height:1.25}
.gxd-tile small{font-size:12px;color:#667085;line-height:1.4}
.gxd-tile[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxd-icon{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:16px}
.gxd-tick{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxd-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-checked=true]>.gxd-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-checked=true]>.gxd-tick svg{opacity:1}
.gxd-group{display:flex;flex-direction:column;gap:10px}
.gxd-tile.gxd-feature{align-items:center;gap:16px;min-height:112px;padding:20px 48px 20px 20px;border-width:1.5px}
.gxd-feature .gxd-icon{width:56px;height:56px;border-radius:15px;font-size:24px}
.gxd-feature strong{font-size:19px}
.gxd-feature small{font-size:13.5px}
.gxd-feature .gxd-tick{top:14px;right:14px;width:24px;height:24px}
.gxd-badge{align-self:flex-start;display:inline-flex;align-items:center;height:22px;padding:0 9px;margin-bottom:3px;border-radius:999px;background:var(--primary,#d93025);color:#fff;font-size:11px;font-style:normal;font-weight:700;letter-spacing:.02em}
.gxd-others{margin:6px 0 0!important;font-size:12px!important;font-weight:650;color:#667085!important;text-transform:uppercase;letter-spacing:.04em}
.gxd-grid.gxd-small{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.gxd-small .gxd-tile{min-height:64px;padding:11px 36px 11px 12px;gap:10px}
.gxd-small .gxd-icon{width:32px;height:32px;border-radius:9px;font-size:14px}
.gxd-small .gxd-tile strong{font-size:13.5px}
.gxd-small .gxd-tile small{font-size:11.5px}
.gxd-small .gxd-tick{width:20px;height:20px;top:9px;right:9px}
/* clip, not hidden: a box that is a scroll container keeps the wheel (the setup frame contains overscroll) */
/* A question with two answers: two tall tiles, close to square, centred with room around them (Jack: not flat). */
.gxd-grid.gxd-pair{grid-template-columns:repeat(2,minmax(0,290px));justify-content:center;gap:22px;padding:18px 0 22px}
.gxd-pair .gxd-tile{flex-direction:column;align-items:center;justify-content:flex-start;gap:16px;min-height:250px;padding:46px 26px 30px;text-align:center}
.gxd-pair .gxd-tile>span:not(.gxd-icon):not(.gxd-tick){align-items:center;gap:6px}
.gxd-pair .gxd-icon{width:64px;height:64px;border-radius:18px;font-size:27px}
.gxd-pair .gxd-tile strong{font-size:17px}
.gxd-pair .gxd-tile small{font-size:13px;max-width:220px}
.gxd-pair .gxd-tick{top:14px;right:14px;width:24px;height:24px}
.gxd-prices{display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:13px;overflow:clip}
.gxd-price{display:flex;align-items:center;gap:12px;padding:9px 12px;border-top:1px solid #f2f4f7;font-size:13px}
.gxd-price:first-child{border-top:0}
.gxd-price label{flex:1 1 auto;min-width:0;font-weight:600;color:#344054}
.gxd-money{display:flex;align-items:center;gap:6px;flex:none;color:#667085;font-size:12px}
.gxd-money span:first-child{color:#344054;font-size:13px}
.gxd-money input{width:96px;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;font:inherit;font-size:14px;text-align:right;color:#101828}
.gxd-money input:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxd-note{font-size:12px!important;color:#667085!important}
.gxd.gxd-fill{flex:1 1 auto;gap:10px;padding-bottom:0}
/* The styles as a looping carousel (Jack): the one in the middle large, its pages scrolling; the others peek in smaller. */
.gxd-stage{position:relative;flex:1 1 auto;min-height:360px;overflow:clip;outline:none}
.gxd-card{position:absolute;top:0;left:50%;display:flex;flex-direction:column;border-radius:12px;background:#fff;box-shadow:0 2px 6px rgba(16,24,40,.12),0 14px 34px rgba(16,24,40,.14);transform-origin:50% 50%;transition:transform .45s cubic-bezier(.22,1,.36,1),opacity .35s,box-shadow .3s;cursor:pointer;overflow:clip}
.gxd-card.gxd-jump{transition:none}
.gxd-card[data-role=center]{cursor:default;box-shadow:0 0 0 2px var(--primary,#d93025),0 18px 44px rgba(16,24,40,.2)}
.gxd-card[data-role=side]{opacity:.55}
.gxd-card[data-role=side]:hover{opacity:.8}
.gxd-doc{flex:1 1 auto;min-height:0;overflow:clip;background:#fff}
.gxd-card[data-role=center] .gxd-doc{overflow-y:auto;scrollbar-width:thin}
/* The rendered document is made of boxes that clip (each a scroll container): under the frame's contained overscroll
   the wheel would stop at the innermost one, so inside a preview everything passes it on to the document, then the step. */
.gxs .gxd-card .gxd-doc,.gxs .gxd-card .gxd-doc *{overscroll-behavior:auto}
.gxd-doc>div{position:relative}
.gxd-arrow{position:absolute;top:50%;z-index:5;width:44px;height:44px;margin-top:-22px;border:0;border-radius:50%;background:rgba(16,24,40,.72);color:#fff;font-size:20px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(16,24,40,.25)}
.gxd-arrow:hover{background:rgba(16,24,40,.88)}
.gxd-arrow:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-arrow[data-go="-1"]{left:8px}
.gxd-arrow[data-go="1"]{right:8px}
.gxd-caption{display:flex;align-items:center;justify-content:center;gap:14px;min-height:46px;text-align:center}
.gxd-caption strong{display:block;font-size:17px;color:#101828}
.gxd-caption small{display:block;font-size:13px;color:#667085}
.gxd-dots{display:flex;gap:6px;justify-content:center}
.gxd-dots button{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:#d0d5dd;cursor:pointer}
.gxd-dots button[aria-current=true]{width:22px;border-radius:999px;background:var(--primary,#d93025)}
.gxd-busy{display:grid;place-items:center;min-height:180px}
.gxd-error{color:#b42318!important}
.gxd-error:empty{display:none}
@media(max-width:640px){.gxd-grid,.gxd-grid.gxd-small{grid-template-columns:1fr}.gxd-tile.gxd-feature{min-height:96px;padding:16px 44px 16px 16px}.gxd-feature .gxd-icon{width:46px;height:46px;font-size:20px}.gxd-feature strong{font-size:17px}}
@media(max-width:640px){.gxd-arrow{display:none}}
@media(max-width:640px){.gxd-grid.gxd-pair{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:8px 0 12px}.gxd-pair .gxd-tile{min-height:190px;padding:32px 12px 18px;gap:12px}.gxd-pair .gxd-icon{width:52px;height:52px;font-size:22px}.gxd-pair .gxd-tile strong{font-size:15px}.gxd-pair .gxd-tile small{font-size:12px}}
@media(prefers-reduced-motion:reduce){.gxd *{transition:none!important}}
`;
function installStyle(){
  if (document.getElementById('gxd-css')) return;
  const style = document.createElement('style'); style.id = 'gxd-css'; style.textContent = css; document.head.append(style);
}
const tick = '<span class="gxd-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
const scripts = new Map();
function loadScript(path){
  if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = path; script.onload = resolve;
    script.onerror = () => { script.remove(); scripts.delete(path); reject(new Error('The preview could not be loaded.')); };
    document.head.append(script);
  }));
  return scripts.get(path);
}
async function renderer(){
  if (!window.FMDocModel) await loadScript('/libraries/doc-model/firstmate-doc-model.js');
  // Signatures, payment and other widgets draw as they do on the document, not as placeholders.
  if (!window.FMDocWidgets) await loadScript('/libraries/doc-widgets/firstmate-doc-widgets.js').catch(() => null);
  if (!window.FMDocRenderer) await loadScript('/libraries/doc-renderer/firstmate-doc-renderer.js');
  return window.FMDocRenderer;
}

/** The questions with one answer each: the choices, with their copy (gx_docs_setup_* keys). */
function choicesFor(part, selections){
  const c = (id, icon, key, title, hint, value = id) => ({ id, icon, value, title: [`gx_docs_setup_${key}`, title], hint: [`gx_docs_setup_${key}_hint`, hint] });
  if (part === 'kind') return { key: 'document_kind', choices: [
    c('proposal', 'fa-file-signature', 'kind_proposal', 'Proposal', 'Price the work for your customer to approve and sign.'),
    c('invoice', 'fa-file-invoice-dollar', 'kind_invoice', 'Invoice', 'Bill a deposit, the balance or extra charges.'),
    c('change_order', 'fa-pen-to-square', 'kind_change_order', 'Change order', 'Add or change work on a signed agreement.'),
    c('completion_certificate', 'fa-award', 'kind_certificate', 'Completion certificate', 'Your customer signs off that the work is done.')
  ] };
  if (part === 'presentation') return { key: 'presentation', choices: [
    c('options', 'fa-layer-group', 'presentation_options', 'Several options to choose from', 'For example good, better and best.'),
    c('single', 'fa-file-lines', 'presentation_single', 'One main option', 'The work you recommend, at one price.')
  ] };
  if (part === 'changes') return { key: 'customer_changes', choices: clean(selections.presentation) === 'options' ? [
    c('mix', 'fa-shuffle', 'changes_mix', 'They can mix and match', 'Your customer swaps line items between the options before signing.'),
    c('pick', 'fa-hand-pointer', 'changes_pick', 'They pick one of the options', 'Each option stays as you wrote it.')
  ] : [
    c('mix', 'fa-sliders', 'changes_mix_single', 'They can add or remove items', 'Optional items your customer turns on or off before signing.'),
    c('ask', 'fa-comments', 'changes_ask', 'They talk to us', 'Any change means a new estimate from you.')
  ] };
  if (part === 'detail') return { key: 'detail', choices: [
    c('itemized', 'fa-list-check', 'detail_itemized', 'Every line item', 'Each part of the job, with its own price.'),
    c('rough', 'fa-ruler-combined', 'detail_rough', 'A broad estimate', 'From a few things: squares, the shingle and underlayment, ice and water, add-ons.')
  ] };
  if (part === 'scope') return { key: 'scope_write_up', choices: [
    c('yes', 'fa-images', 'scope_yes', 'A written scope of work', 'Photos and descriptions from the estimate, then the proposal.', true),
    c('no', 'fa-file-contract', 'scope_no', 'Just the proposal', 'The price and what’s included.', false)
  ] };
  return null;
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (copy) => ctx.L(copy[0], copy[1]);
  const t = (key, text) => ctx.L(`gx_docs_setup_${key}`, text);
  const part = clean(ctx.options.part);
  const selections = object(ctx.selections);
  if (part === 'prices') return pricesPart();
  if (part === 'style') return stylePart();
  const question = choicesFor(part, selections);
  if (!question) { el.innerHTML = `<p class="gxd-error">${esc(t('unknown', 'This step cannot be shown here.'))}</p>`; return { valid: () => false }; }

  // ── One answer from a few choices ─────────────────────────────────────
  const { key, choices } = question;
  const valueOf = (choice) => choice.value;
  // Most people start with a proposal (FM-582): on the first question it is the large, recommended choice, already
  // picked, and the other kinds sit in a smaller row below it.
  const featured = part === 'kind' ? choices.find((choice) => choice.id === 'proposal') : null;
  let chosen = choices.find((choice) => valueOf(choice) === selections[key]) || featured || null;
  const tileHtml = (choice, big = false) => `
    <button type="button" class="gxd-tile${big ? ' gxd-feature' : ''}" role="radio" data-choice="${esc(choice.id)}" aria-checked="${chosen === choice}">
      <span class="gxd-icon" aria-hidden="true"><i class="fas ${esc(choice.icon)}"></i></span>
      <span>${big ? `<em class="gxd-badge">${esc(t('kind_recommended', 'Recommended to start'))}</em>` : ''}<strong>${esc(L(choice.title))}</strong><small>${esc(L(choice.hint))}</small></span>${tick}
    </button>`;
  const others = choices.filter((choice) => choice !== featured);
  el.innerHTML = `<div class="gxd"><div role="radiogroup" aria-label="${esc(ctx.L(ctx.step.title))}" class="gxd-group">${featured
    ? `${tileHtml(featured, true)}<p class="gxd-others">${esc(t('kind_others', 'Or set up another kind of document'))}</p><div class="gxd-grid gxd-small">${others.map((choice) => tileHtml(choice)).join('')}</div>`
    : `<div class="gxd-grid${choices.length === 2 ? ' gxd-pair' : ''}">${choices.map((choice) => tileHtml(choice)).join('')}</div>`}</div></div>`;
  const report = () => ctx.change(chosen ? { [key]: valueOf(chosen) } : {}, chosen ? L(chosen.title) : '');
  const onClick = (event) => {
    const tile = event.target.closest('[data-choice]'); if (!tile) return;
    chosen = choices.find((choice) => choice.id === tile.dataset.choice) || null;
    el.querySelectorAll('[data-choice]').forEach((node) => node.setAttribute('aria-checked', String(node.dataset.choice === chosen?.id)));
    report();
  };
  el.addEventListener('click', onClick);
  if (chosen) report();
  return {
    valid: () => !!chosen,
    hint: () => t('choose_hint', 'Choose the answer that fits best.'),
    summary: () => chosen ? L(chosen.title) : '',
    destroy(){ el.removeEventListener('click', onClick); }
  };

  // ── Prices (optional) ─────────────────────────────────────────────────
  function pricesPart(){
    let alive = true, items = [];
    const given = new Map(array(selections.prices).map((entry) => [clean(entry.item_id), Number(entry.unit_price)]));
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const unitLabel = (unit) => ({ sq: t('unit_sq', 'per square'), lf: t('unit_lf', 'per foot'), ft: t('unit_lf', 'per foot'), ea: t('unit_ea', 'each'), job: t('unit_job', 'per job') }[clean(unit).toLowerCase()] || (unit ? `/ ${unit}` : ''));
    const changed = () => items.map((item) => {
      const input = el.querySelector(`[data-price="${CSS.escape(item.id)}"]`);
      const value = Number(String(input?.value ?? '').replace(/[^0-9.]/g, ''));
      if (!input || clean(input.value) === '' || !Number.isFinite(value)) return null;
      return value !== item.unit_price ? { item_id: item.id, unit_price: Math.round(value * 100) / 100 } : null;
    }).filter(Boolean);
    const report = () => { const list = changed(); ctx.change({ prices: list }, list.length ? t('prices_summary', '{count} prices').replace('{count}', String(list.length)) : ''); };
    ctx.read('document-setup', 'price_sheet').then((sheet) => {
      if (!alive) return;
      items = array(object(sheet).items).map((item) => ({ ...item, unit_price: item.unit_price == null ? null : Number(item.unit_price) }));
      if (!items.length) {
        el.innerHTML = `<div class="gxd"><p>${esc(t('prices_none', 'Your price book has nothing for these yet. Skip this step and set your prices in the price book any time.'))}</p></div>`;
        return;
      }
      const shown = (item) => given.has(item.id) ? given.get(item.id) : item.unit_price;
      el.innerHTML = `<div class="gxd">
        <p>${esc(t('prices_lead', 'What you charge your customer for each, before tax. We price your proposals from these.'))}</p>
        <div class="gxd-prices">${items.map((item) => `<div class="gxd-price"><label for="gxd-price-${esc(item.id)}">${esc(item.name)}</label><span class="gxd-money"><span>$</span><input id="gxd-price-${esc(item.id)}" inputmode="decimal" autocomplete="off" data-price="${esc(item.id)}" value="${shown(item) == null ? '' : esc(String(shown(item)))}" placeholder="0.00"><span>${esc(unitLabel(item.unit))}</span></span></div>`).join('')}</div>
        <p class="gxd-note">${esc(t('prices_note', 'You can change your default prices in your price book at any time, and any price on a single proposal while you write it.'))}</p>
      </div>`;
      el.addEventListener('input', report);
      report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('load_failed', 'This didn’t load. Skip this step or try again.'))}</p></div>`; });
    return {
      valid: () => true,
      summary: () => { const count = changed().length; return count ? t('prices_summary', '{count} prices').replace('{count}', String(count)) : ''; },
      destroy(){ alive = false; el.removeEventListener('input', report); }
    };
  }

  // ── Three styles, previewed with what the answers make ────────────────
  function stylePart(){
    let alive = true, previews = [], Renderer = null, timer = 0, lastSize = '', center = 0, touch = null;
    const cards = [];
    const args = { document_kind: clean(selections.document_kind) || 'proposal' };
    if (args.document_kind === 'proposal') for (const name of ['presentation', 'customer_changes', 'detail', 'scope_write_up']) if (selections[name] !== undefined) args[name] = selections[name];
    // The previews want room: the sheet widens (the player's wide sheet) and this step fills it.
    const sheet = el.closest('.gxs'), wasWide = !!sheet?.classList.contains('gxs-wide');
    sheet?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step');
    pane?.setAttribute('data-fill', '');
    // Filled, the step does not scroll by itself; on a short window the carousel keeps a least size and the step scrolls.
    if (pane) pane.style.overflowY = 'auto';
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const PAGE_W = 612 * 96 / 72, PAGE_H = 792 * 96 / 72, SIDE = 0.62, GAP = 28;
    const chosen = () => previews[center]?.theme_id || '';
    // The style in the middle is the one chosen.
    const report = () => { const entry = previews[center]; ctx.change(entry ? { theme_id: entry.theme_id } : {}, entry ? entry.name : ''); };
    /** Where each card sits: -1 left, 0 middle, 1 right (and further out with more styles), going round. */
    const offsetOf = (at) => { const n = previews.length; let d = ((at - center) % n + n) % n; if (d > n / 2) d -= n; return d; };
    function layout(before){
      const stage = el.querySelector('.gxd-stage'); if (!stage) return;
      const wide = stage.clientWidth, high = stage.clientHeight;
      const width = Math.max(200, Math.min(wide * (wide < 640 ? 0.72 : 0.5), high * PAGE_W / PAGE_H));
      cards.forEach((card, at) => {
        const offset = offsetOf(at), was = before ? before[at] : offset;
        const side = offset !== 0;
        // A card going round the back (one end to the other) jumps instead of crossing the middle.
        card.el.classList.toggle('gxd-jump', Math.abs(offset - was) > 1);
        Object.assign(card.el.style, { width: `${width}px`, height: `${high}px`, marginLeft: `${-width / 2}px`, zIndex: String(10 - Math.abs(offset)),
          transform: `translateX(${offset * (width / 2 + GAP + width * SIDE / 2)}px) scale(${side ? SIDE : 1})`, visibility: Math.abs(offset) > 1 ? 'hidden' : '' });
        card.el.dataset.role = side ? 'side' : 'center';
        card.el.setAttribute('aria-hidden', String(side));
        card.el.tabIndex = side ? -1 : 0;
        if (side) card.doc.scrollTop = 0;
        if (card.width !== width) draw(card, width);
      });
      requestAnimationFrame(() => cards.forEach((card) => card.el.classList.remove('gxd-jump')));
      const entry = previews[center];
      const caption = el.querySelector('[data-caption]');
      if (caption && entry) caption.innerHTML = `<strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small>`;
      el.querySelectorAll('[data-dot]').forEach((dot) => dot.setAttribute('aria-current', String(Number(dot.dataset.dot) === center)));
    }
    /** A card's document: every page of the real render at the middle card's width (the sides are the same, scaled down). */
    function draw(card, width){
      if (!Renderer) return;
      card.width = width;
      try { card.handle?.destroy?.(); } catch (_) {}
      card.doc.innerHTML = '<div></div>';
      try {
        const preview = card.preview;
        card.handle = Renderer.render(card.doc.firstElementChild, { document: preview.resolved_definition, theme: preview.theme, themeContext: { overrides: object(preview.theme_vars) }, widgetData: object(preview.widget_data), mode: 'static', scale: width / PAGE_W });
      } catch (error) { card.doc.textContent = clean(error?.message); }
    }
    function go(to){
      if (!previews.length) return;
      const before = cards.map((_, at) => offsetOf(at));
      center = ((to % previews.length) + previews.length) % previews.length;
      layout(before);
      report();
    }
    const onClick = (event) => {
      const arrow = event.target.closest('[data-go]'); if (arrow) { go(center + Number(arrow.dataset.go)); return; }
      const dot = event.target.closest('[data-dot]'); if (dot) { go(Number(dot.dataset.dot)); return; }
      const card = event.target.closest('.gxd-card'); if (!card) return;
      const at = cards.findIndex((entry) => entry.el === card);
      if (at >= 0 && at !== center) go(at);
    };
    const onKey = (event) => {
      if (event.target.closest?.('input,textarea')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(center - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(center + 1); }
    };
    // A sideways swipe turns the carousel; up and down scroll the document in the middle.
    const onTouchStart = (event) => { const point = event.touches?.[0]; touch = point ? { x: point.clientX, y: point.clientY } : null; };
    const onTouchEnd = (event) => {
      const point = event.changedTouches?.[0]; if (!touch || !point) return;
      const dx = point.clientX - touch.x, dy = point.clientY - touch.y; touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(center + (dx < 0 ? 1 : -1));
    };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    // Laid out again when the carousel changes size (the sheet widening, the window resized), once it has settled.
    const observer = window.ResizeObserver ? new ResizeObserver(() => {
      const stage = el.querySelector('.gxd-stage'); const size = stage ? `${stage.clientWidth}x${stage.clientHeight}` : '';
      if (!size || size === lastSize) return;
      lastSize = size; clearTimeout(timer); timer = setTimeout(() => { if (alive) layout(); }, 160);
    }) : null;
    Promise.all([ctx.read('document-setup', 'previews', { args }), renderer()]).then(([value, loaded]) => {
      if (!alive) return;
      Renderer = loaded;
      previews = array(object(value).previews);
      center = Math.max(0, previews.findIndex((preview) => preview.theme_id === clean(selections.theme_id)));
      el.innerHTML = `<div class="gxd gxd-fill">
        <div class="gxd-stage" tabindex="0" role="listbox" aria-label="${esc(ctx.L(ctx.step.title))}">
          ${previews.map((preview) => `<div class="gxd-card" role="option" data-theme="${esc(preview.theme_id)}" aria-label="${esc(preview.name)}"><div class="gxd-doc"></div></div>`).join('')}
          <button type="button" class="gxd-arrow" data-go="-1" aria-label="${esc(t('style_previous', 'Previous style'))}">‹</button>
          <button type="button" class="gxd-arrow" data-go="1" aria-label="${esc(t('style_next', 'Next style'))}">›</button>
        </div>
        <div class="gxd-caption" data-caption aria-live="polite"></div>
        <div class="gxd-dots">${previews.map((preview, at) => `<button type="button" data-dot="${at}" aria-label="${esc(preview.name)}"></button>`).join('')}</div>
      </div>`;
      el.querySelectorAll('.gxd-card').forEach((node, at) => cards.push({ el: node, doc: node.querySelector('.gxd-doc'), preview: previews[at], handle: null, width: 0 }));
      const stage = el.querySelector('.gxd-stage');
      lastSize = `${stage.clientWidth}x${stage.clientHeight}`;
      layout();
      observer?.observe(stage);
      report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('preview_failed', 'The previews didn’t load. Close the setup and try again.'))}</p></div>`; });
    return {
      valid: () => !!chosen(),
      hint: () => t('style_hint', 'Choose a style.'),
      summary: () => previews[center]?.name || '',
      destroy(){
        alive = false; clearTimeout(timer); observer?.disconnect();
        if (!wasWide) sheet?.classList.remove('gxs-wide');
        el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey);
        el.removeEventListener('touchstart', onTouchStart); el.removeEventListener('touchend', onTouchEnd);
        cards.forEach((card) => { try { card.handle?.destroy?.(); } catch (_) {} });
      }
    };
  }
}
export default mount;
