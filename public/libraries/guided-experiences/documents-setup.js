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
/* The styles as a looping carousel (Jack): the one in the middle large, its pages scrolling; the others peek in smaller.
   The cards keep a margin above and below for their shadows (FM-608: the top looked cut off), and dragging with a mouse
   or a finger turns it (touch-action leaves up and down to the document's own scroll). */
.gxd-stage{position:relative;flex:1 1 auto;min-height:360px;overflow-x:clip;overflow-y:visible;outline:none;touch-action:pan-y;-webkit-user-select:none;user-select:none}
.gxd-stage *{touch-action:pan-y}
.gxd-stage.gxd-dragging,.gxd-stage.gxd-dragging *{cursor:grabbing!important}
.gxd-stage.gxd-dragging .gxd-card{transition:none}
.gxd-card{position:absolute;top:0;left:50%;display:flex;flex-direction:column;border-radius:10px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.1),0 10px 28px rgba(16,24,40,.12);transform-origin:50% 50%;transition:transform .45s cubic-bezier(.22,1,.36,1),opacity .35s,box-shadow .3s;cursor:pointer;overflow:clip}
.gxd-card.gxd-jump{transition:none}
.gxd-card.gxd-ghost{pointer-events:none}
.gxd-card[data-role=center]{cursor:grab;box-shadow:0 2px 8px rgba(16,24,40,.12),0 22px 50px rgba(16,24,40,.2)}
.gxd-card[data-role=side]{opacity:.55}
.gxd-card[data-role=side]:hover{opacity:.8}
/* Between the pages of a document, a grey gutter: on white they ran together. */
.gxd-doc{flex:1 1 auto;min-height:0;overflow:clip;background:#e4e7ec}
.gxd-card[data-role=center] .gxd-doc{overflow-y:auto;scrollbar-width:thin}
.gxd-doc>div{position:relative}
.gxd-doc .fmdoc-page{margin-bottom:44px;box-shadow:none}
.gxd-doc .fmdoc-page:last-child{margin-bottom:0}
.gxd-expand{position:absolute;top:12px;right:20px;z-index:2;width:38px;height:38px;border:0;border-radius:10px;background:rgba(16,24,40,.66);color:#fff;font-size:15px;cursor:pointer;display:grid;place-items:center;opacity:0;transition:opacity .2s,background .15s;box-shadow:0 4px 12px rgba(16,24,40,.22)}
.gxd-card[data-role=center]:hover .gxd-expand,.gxd-expand:focus-visible{opacity:1}
.gxd-card[data-role=side] .gxd-expand{display:none}
.gxd-expand:hover{background:rgba(16,24,40,.86)}
.gxd-expand:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
@media(hover:none){.gxd-card[data-role=center] .gxd-expand{opacity:1}}
.gxd-arrow{position:absolute;top:50%;z-index:12;width:44px;height:44px;margin-top:-22px;border:0;border-radius:50%;background:rgba(16,24,40,.72);color:#fff;font-size:20px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(16,24,40,.25)}
.gxd-arrow:hover{background:rgba(16,24,40,.88)}
.gxd-arrow:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-arrow[data-go="-1"]{left:8px}
.gxd-arrow[data-go="1"]{right:8px}
/* The name and the dots sit on the line of the sheet's Back and Done, which float over this step (FM-608): they keep
   clear of them at the sides. */
.gxd-under{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 230px;flex:none}
.gxd-caption{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;column-gap:12px;row-gap:2px;min-height:26px;text-align:center}
.gxd-caption strong{display:block;font-size:17px;color:#101828}
.gxd-caption small{display:block;font-size:13px;color:#667085}
.gxd-dots{display:flex;gap:6px;justify-content:center}
.gxd-dots button{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:#d0d5dd;cursor:pointer}
.gxd-dots button[aria-current=true]{width:22px;border-radius:999px;background:var(--primary,#d93025)}
/* One style full screen, its pages scrolling, with the others a press of an arrow away. */
.gxd-view{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:rgba(16,24,40,.94);color:#fff;animation:gxdViewIn .22s ease-out both}
.gxd-view-bar{display:flex;align-items:center;gap:14px;padding:12px 16px 12px 22px;flex:none}
.gxd-view-bar>div{flex:1;min-width:0;display:flex;align-items:baseline;flex-wrap:wrap;column-gap:12px}
.gxd-view-bar strong{font-size:17px}
.gxd-view-bar small{font-size:13px;color:rgba(255,255,255,.72)}
.gxd-view-close{width:40px;height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;font-size:26px;line-height:1;cursor:pointer}
.gxd-view-close:hover{background:rgba(255,255,255,.22)}
.gxd-view-close:focus-visible,.gxd-view .gxd-arrow:focus-visible{outline:2px solid #fff;outline-offset:2px}
.gxd-view-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 0 40px}
.gxd-view-doc{margin:0 auto;border-radius:6px;overflow:clip}
.gxd-view-doc>div{position:relative}
.gxd-view-doc .fmdoc-page{margin-bottom:28px}
.gxd-view-doc .fmdoc-page:last-child{margin-bottom:0}
.gxd-view .gxd-arrow{position:fixed;background:rgba(255,255,255,.16)}
.gxd-view .gxd-arrow:hover{background:rgba(255,255,255,.28)}
.gxd-view .gxd-arrow[data-view-go="-1"]{left:16px}
.gxd-view .gxd-arrow[data-view-go="1"]{right:16px}
@keyframes gxdViewIn{from{opacity:0}to{opacity:1}}
.gxd-busy{display:grid;place-items:center;min-height:180px}
.gxd-error{color:#b42318!important}
.gxd-error:empty{display:none}
@media(max-width:640px){.gxd-grid,.gxd-grid.gxd-small{grid-template-columns:1fr}.gxd-tile.gxd-feature{min-height:96px;padding:16px 44px 16px 16px}.gxd-feature .gxd-icon{width:46px;height:46px;font-size:20px}.gxd-feature strong{font-size:17px}}
@media(max-width:640px){.gxd-stage>.gxd-arrow{display:none}.gxd-view .gxd-arrow{top:auto;bottom:16px}}
/* On a phone the sheet's Back and Done have the bottom line to themselves: the name and dots sit above them. */
@media(max-width:760px){.gxd-under{padding:0 0 58px}}
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
    let alive = true, previews = [], Renderer = null, timer = 0, lastSize = '', center = 0, drag = null, dragged = false, view = null;
    const cards = [];
    const args = { document_kind: clean(selections.document_kind) || 'proposal' };
    if (args.document_kind === 'proposal') for (const name of ['presentation', 'customer_changes', 'detail', 'scope_write_up']) if (selections[name] !== undefined) args[name] = selections[name];
    // The previews want room: the sheet widens (the player's wide sheet) and this step fills it. The sheet's Back and
    // Done float over its bottom edge (data-float-foot), beside the style's name, so the carousel has the full height.
    const sheet = el.closest('.gxs'), wasWide = !!sheet?.classList.contains('gxs-wide');
    sheet?.classList.add('gxs-wide');
    const pane = el.closest('.gxs-step');
    pane?.setAttribute('data-fill', '');
    pane?.setAttribute('data-float-foot', '');
    // Filled, the step does not scroll by itself; on a short window the carousel keeps a least size and the step scrolls.
    if (pane) { pane.style.overflowY = 'auto'; pane.style.paddingBottom = '14px'; }
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const PAGE_W = 612 * 96 / 72, PAGE_H = 792 * 96 / 72, SIDE = 0.62, INSET = 16;
    let step = 1;
    const chosen = () => previews[center]?.theme_id || '';
    // The style in the middle is the one chosen.
    const report = () => { const entry = previews[center]; ctx.change(entry ? { theme_id: entry.theme_id } : {}, entry ? entry.name : ''); };
    /** Where each card sits: -1 left, 0 middle, 1 right (and further out with more styles), going round. */
    const offsetOf = (at) => { const n = previews.length; let d = ((at - center) % n + n) % n; if (d > n / 2) d -= n; return d; };
    /** A card at a position (fractional while dragged): along the row, shrinking from the middle to a side card's size. */
    const pose = (at) => `translateX(${at * step}px) scale(${1 - (1 - SIDE) * Math.min(1, Math.abs(at))})`;
    function layout(before){
      const stage = el.querySelector('.gxd-stage'); if (!stage) return;
      const wide = stage.clientWidth, high = Math.max(160, stage.clientHeight - INSET * 2);
      const phone = wide < 640;
      const width = Math.max(200, Math.min(wide * (phone ? 0.72 : 0.46), high * PAGE_W / PAGE_H));
      // Room between the middle page and the ones beside it (FM-608: they were crowded).
      step = width / 2 + (phone ? 18 : Math.max(44, width * 0.1)) + width * SIDE / 2;
      cards.forEach((card, at) => {
        const offset = offsetOf(at), was = before ? before[at] : offset;
        const side = offset !== 0;
        Object.assign(card.el.style, { top: `${INSET}px`, width: `${width}px`, height: `${high}px`, marginLeft: `${-width / 2}px`, zIndex: String(10 - Math.abs(offset)), visibility: Math.abs(offset) > 1 ? 'hidden' : '' });
        // A card going round the back (one end to the other) leaves past its old side and comes in from beyond its new
        // one, instead of crossing the middle or appearing where it lands (FM-608).
        if (Math.abs(offset - was) > 1) {
          if (Math.abs(was) <= 1 && was !== 0) leave(card, was);
          if (Math.abs(offset) <= 1 && offset !== 0) {
            card.el.classList.add('gxd-jump');
            card.el.style.transform = pose(offset + Math.sign(offset)); card.el.style.opacity = '0';
            void card.el.offsetWidth;
            card.el.classList.remove('gxd-jump');
          }
        }
        card.el.style.transform = pose(offset); card.el.style.opacity = '';
        card.el.dataset.role = side ? 'side' : 'center';
        card.el.setAttribute('aria-hidden', String(side));
        card.el.tabIndex = side ? -1 : 0;
        card.el.querySelector('.gxd-expand').tabIndex = side ? -1 : 0;
        if (side) card.doc.scrollTop = 0;
        if (card.width !== width) draw(card, width);
      });
      const entry = previews[center];
      const caption = el.querySelector('[data-caption]');
      if (caption && entry) caption.innerHTML = `<strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small>`;
      el.querySelectorAll('[data-dot]').forEach((dot) => dot.setAttribute('aria-current', String(Number(dot.dataset.dot) === center)));
    }
    /** A copy of a card that slides on out past the side it was on and fades, while the card itself comes round. */
    function leave(card, was){
      const ghost = card.el.cloneNode(true);
      ghost.classList.add('gxd-ghost'); ghost.removeAttribute('role'); ghost.setAttribute('aria-hidden', 'true'); ghost.style.zIndex = '1';
      card.el.after(ghost);
      void ghost.offsetWidth;
      ghost.style.transform = pose(was + Math.sign(was)); ghost.style.opacity = '0';
      setTimeout(() => ghost.remove(), 500);
    }
    /** A card's document: every page of the real render at the middle card's width (the sides are the same, scaled down). */
    function draw(card, width){
      if (!Renderer) return;
      card.width = width;
      try { card.handle?.destroy?.(); } catch (_) {}
      card.handle = render(card.doc, card.preview, width);
    }
    function render(host, preview, width){
      host.innerHTML = '<div></div>';
      try {
        return Renderer.render(host.firstElementChild, { document: preview.resolved_definition, theme: preview.theme, themeContext: { overrides: object(preview.theme_vars) }, widgetData: object(preview.widget_data), mode: 'static', scale: width / PAGE_W });
      } catch (error) { host.textContent = clean(error?.message); return null; }
    }
    function go(to){
      if (!previews.length) return;
      const before = cards.map((_, at) => offsetOf(at));
      center = ((to % previews.length) + previews.length) % previews.length;
      layout(before);
      report();
      if (view) showView();
    }

    // ── The style in the middle, full screen ──
    function showView(){
      const entry = previews[center]; if (!entry) return;
      const width = Math.min(window.innerWidth - (window.innerWidth < 640 ? 24 : 160), 960);
      if (!view) {
        view = document.createElement('div');
        view.className = 'gxd-view'; view.setAttribute('role', 'dialog'); view.setAttribute('aria-modal', 'true');
        view.innerHTML = `<div class="gxd-view-bar"><div data-view-caption></div><button type="button" class="gxd-view-close" data-view-close aria-label="${esc(t('style_view_close', 'Close'))}">&times;</button></div>
          <div class="gxd-view-scroll"><div class="gxd-view-doc"></div></div>
          ${previews.length > 1 ? `<button type="button" class="gxd-arrow" data-view-go="-1" aria-label="${esc(t('style_previous', 'Previous style'))}">‹</button><button type="button" class="gxd-arrow" data-view-go="1" aria-label="${esc(t('style_next', 'Next style'))}">›</button>` : ''}`;
        view.addEventListener('click', onViewClick);
        view.addEventListener('keydown', onViewKey);
        (el.closest('.gxs') || document.body).append(view);
        view.querySelector('[data-view-close]').focus({ preventScroll: true });
      }
      view.setAttribute('aria-label', entry.name);
      view.querySelector('[data-view-caption]').innerHTML = `<strong>${esc(entry.name)}</strong><small>${esc(entry.description)}</small>`;
      const doc = view.querySelector('.gxd-view-doc');
      doc.style.width = `${width}px`;
      try { view.handle?.destroy?.(); } catch (_) {}
      view.handle = render(doc, entry, width);
      view.querySelector('.gxd-view-scroll').scrollTop = 0;
    }
    function closeView(){
      if (!view) return false;
      try { view.handle?.destroy?.(); } catch (_) {}
      view.remove(); view = null;
      cards[center]?.el.querySelector('.gxd-expand')?.focus({ preventScroll: true });
      return true;
    }
    const onViewClick = (event) => {
      if (event.target.closest('[data-view-close]')) { closeView(); return; }
      const arrow = event.target.closest('[data-view-go]'); if (arrow) go(center + Number(arrow.dataset.viewGo));
    };
    const onViewKey = (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(center - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(center + 1); }
    };

    const onClick = (event) => {
      // The click that ends a drag is not a press on what it ended over.
      if (dragged) { dragged = false; return; }
      if (event.target.closest('[data-expand]')) { showView(); return; }
      const arrow = event.target.closest('[data-go]'); if (arrow) { go(center + Number(arrow.dataset.go)); return; }
      const dot = event.target.closest('[data-dot]'); if (dot) { go(Number(dot.dataset.dot)); return; }
      const card = event.target.closest('.gxd-card'); if (!card) return;
      const at = cards.findIndex((entry) => entry.el === card);
      if (at >= 0 && at !== center) go(at);
    };
    const onDoubleClick = (event) => { const card = event.target.closest('.gxd-card'); if (card && card === cards[center]?.el) showView(); };
    const onKey = (event) => {
      if (event.target.closest?.('input,textarea')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(center - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(center + 1); }
    };
    // Dragging sideways (a mouse or a finger) moves the cards with it and turns the carousel when let go far or fast
    // enough; up and down scroll the document in the middle, and its scroll bar is not a drag.
    const onPointerDown = (event) => {
      dragged = false;
      if (drag || previews.length < 2 || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (event.target.closest('button,a,input,textarea,select')) return;
      const doc = event.target.closest('.gxd-doc');
      if (doc && event.target === doc && event.offsetX >= doc.clientWidth) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, moving: false, samples: [] };
    };
    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moving) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
        if (Math.abs(dx) < 8) return;
        drag.moving = true;
        const stage = el.querySelector('.gxd-stage');
        try { stage.setPointerCapture(event.pointerId); } catch (_) {}
        stage.classList.add('gxd-dragging');
        window.getSelection?.()?.removeAllRanges?.();
      }
      event.preventDefault();
      drag.dx = dx;
      drag.samples.push([event.timeStamp, dx]); if (drag.samples.length > 6) drag.samples.shift();
      cards.forEach((card, at) => {
        const offset = offsetOf(at);
        if (Math.abs(offset) <= 1) card.el.style.transform = pose(offset + dx / step);
      });
    };
    const endDrag = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { moving, dx, samples } = drag; drag = null;
      if (!moving) return;
      dragged = !cancelled;
      el.querySelector('.gxd-stage')?.classList.remove('gxd-dragging');
      const [first, last] = [samples[0], samples[samples.length - 1]];
      const speed = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
      let turn = Math.round(-dx / step);
      if (!turn && !cancelled && (Math.abs(dx) > Math.min(90, step * 0.22) || (Math.abs(speed) > 0.45 && Math.sign(speed) === Math.sign(dx)))) turn = dx < 0 ? 1 : -1;
      if (turn && !cancelled) go(center + turn); else layout();
      // A drag that ends outside the step leaves no click to swallow.
      setTimeout(() => { dragged = false; }, 400);
    };
    const onPointerUp = (event) => endDrag(event, false);
    const onPointerCancel = (event) => endDrag(event, true);
    const onDragStart = (event) => event.preventDefault();
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDoubleClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('dragstart', onDragStart);
    // Laid out again when the carousel changes size (the sheet widening, the window resized), once it has settled.
    const observer = window.ResizeObserver ? new ResizeObserver(() => {
      const stage = el.querySelector('.gxd-stage'); const size = stage ? `${stage.clientWidth}x${stage.clientHeight}` : '';
      if (!size || size === lastSize) return;
      lastSize = size; clearTimeout(timer); timer = setTimeout(() => { if (alive) { layout(); if (view) showView(); } }, 160);
    }) : null;
    Promise.all([ctx.read('document-setup', 'previews', { args }), renderer()]).then(([value, loaded]) => {
      if (!alive) return;
      Renderer = loaded;
      previews = array(object(value).previews);
      center = Math.max(0, previews.findIndex((preview) => preview.theme_id === clean(selections.theme_id)));
      el.innerHTML = `<div class="gxd gxd-fill">
        <div class="gxd-stage" tabindex="0" role="listbox" aria-label="${esc(ctx.L(ctx.step.title))}">
          ${previews.map((preview) => `<div class="gxd-card" role="option" data-theme="${esc(preview.theme_id)}" aria-label="${esc(preview.name)}"><div class="gxd-doc"></div><button type="button" class="gxd-expand" data-expand aria-label="${esc(t('style_view', 'See it full screen'))}" title="${esc(t('style_view', 'See it full screen'))}"><i class="fas fa-expand" aria-hidden="true"></i></button></div>`).join('')}
          <button type="button" class="gxd-arrow" data-go="-1" aria-label="${esc(t('style_previous', 'Previous style'))}">‹</button>
          <button type="button" class="gxd-arrow" data-go="1" aria-label="${esc(t('style_next', 'Next style'))}">›</button>
        </div>
        <div class="gxd-under">
          <div class="gxd-caption" data-caption aria-live="polite"></div>
          <div class="gxd-dots">${previews.map((preview, at) => `<button type="button" data-dot="${at}" aria-label="${esc(preview.name)}"></button>`).join('')}</div>
        </div>
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
      // Escape (and a phone's back) closes the full-screen view first.
      escape: () => closeView(),
      destroy(){
        alive = false; clearTimeout(timer); observer?.disconnect(); closeView();
        if (!wasWide) sheet?.classList.remove('gxs-wide');
        el.removeEventListener('click', onClick); el.removeEventListener('dblclick', onDoubleClick); el.removeEventListener('keydown', onKey);
        el.removeEventListener('pointerdown', onPointerDown); el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp); el.removeEventListener('pointercancel', onPointerCancel); el.removeEventListener('dragstart', onDragStart);
        cards.forEach((card) => { try { card.handle?.destroy?.(); } catch (_) {} });
      }
    };
  }
}
export default mount;
