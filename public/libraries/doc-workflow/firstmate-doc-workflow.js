/* public/libraries/doc-workflow/firstmate-doc-workflow.js
 * The document engine's workflow RUNTIME (contracts §8, tiers spec §4.2).
 *
 * One shared stepper that renders a workflow definition
 *   { schema_version, name, contract:{params,outputs},
 *     steps:[{ id, title, when?, audience?, items:[{ kind, writes, ... }] }],
 *     audiences:{ internal:{...}, customer:{ theme, hide_steps } } }
 * against a document instance's params/outputs. The host owns persistence:
 * every item write goes through onWrite(path, value) ("params.x" /
 * "outputs.y") exactly like the Data panel PATCHes the instance.
 *
 * Mounts in: the project Documents tab (audience "internal"), the customer
 * portal (audience "customer", portal-skinned), the studio test pane.
 *
 *   FMDocWorkflow.mount(container, {
 *     workflow, audience, state:{params,outputs,current_step,completed_steps},
 *     contract, onWrite(path,value), onStepState(state), onComplete(),
 *     preview:{ resolve():Promise<resolved>, mount(el,resolved)? },
 *     services:{ pricebook, pieceCatalog, generateScopeItems, media }, scope:{...extra}, theme
 *   }) -> { destroy, goTo(stepId), refresh(state) }
 *
 *   FMDocWorkflow.registerKind(kind, renderer(el, ctx) -> { validate?, destroy? })
 *
 * Styles self-inject (style#fmdw-styles, fmdw- prefix) and follow the visual
 * language of documents.css / customer_portal.css. No hard dependency on any
 * other engine library: FMDocModel powers `when` conditions, FMDocRenderer
 * powers the live preview, FMDocWidgets powers signature/payment — each
 * degrades cleanly when absent.
 */
(function(){
  const root = typeof window !== 'undefined' ? window : globalThis;

  // ------------------------------------------------------------- utilities
  function cleanText(value){ return String(value ?? '').trim(); }
  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function clone(value){
    try { return structuredClone(value); } catch (e) {
      try { return JSON.parse(JSON.stringify(value ?? null)); } catch (e2) { return value; }
    }
  }
  function obj(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function arr(value){ return Array.isArray(value) ? value : []; }
  function firstText(...values){
    for (const value of values) { const text = cleanText(value); if (text) return text; }
    return '';
  }
  let uidCounter = 0;
  function uid(prefix){ return `${prefix}_${Date.now().toString(36)}${(++uidCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
  function moneyFromCents(cents){
    return (Number(cents || 0) / 100).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function moneyFromDollars(dollars){
    return (Number(dollars || 0)).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function prettyKey(key){
    return cleanText(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function isEmptyValue(value){
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return cleanText(value) === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false; // numbers (incl. 0) and booleans (incl. false) count as answered
  }
  function getPath(source, path){
    const parts = cleanText(path).split('.').filter(Boolean);
    let cursor = source;
    for (const part of parts) {
      if (cursor === null || cursor === undefined) return undefined;
      cursor = cursor[part];
    }
    return cursor;
  }
  function setPath(target, path, value){
    const parts = cleanText(path).split('.').filter(Boolean);
    if (!parts.length) return;
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (cursor[parts[i]] === null || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  // ------------------------------------------------- expression evaluation
  // `when` conditions, options_from, and prefill use the SAME expression
  // language as documents (FMDocModel). Missing model → conditions pass,
  // expressions resolve to undefined (never crash the stepper).
  function evalExpr(raw, scope){
    const model = root.FMDocModel;
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== 'string') return raw;
    const text = raw.trim();
    if (!text) return undefined;
    if (!model) return undefined;
    try {
      if (typeof model.hasInterpolation === 'function' && model.hasInterpolation(text) && typeof model.interpolate === 'function') {
        return model.interpolate(text, scope || {});
      }
      if (typeof model.evaluateSafe === 'function') return model.evaluateSafe(text, scope || {}, undefined);
    } catch (e) { /* defensive */ }
    return undefined;
  }
  function whenPasses(when, scope){
    const text = cleanText(when);
    if (!text) return true;
    if (!root.FMDocModel) return true; // no evaluator — never hide content
    const value = evalExpr(text, scope);
    if (value === undefined || value === '') return false;
    return !!value;
  }

  // ------------------------------------------------------------ audiences
  const DEFAULT_STEP_AUDIENCE = ['internal'];
  function stepAudiences(step){
    const list = arr(step.audience).map(cleanText).filter(Boolean);
    return list.length ? list : DEFAULT_STEP_AUDIENCE;
  }
  function stepVisibleFor(step, audience, workflow){
    if (!stepAudiences(step).includes(audience)) return false;
    const hidden = arr(obj(obj(workflow.audiences)[audience]).hide_steps).map(cleanText);
    if (hidden.includes(cleanText(step.id))) return false;
    return true;
  }
  function itemVisibleFor(item, audience){
    const list = arr(item.audience).map(cleanText).filter(Boolean);
    if (!list.length) return true; // inherits the step's audience
    return list.includes(audience);
  }

  // ------------------------------------------------------- options helpers
  function normalizeOption(option){
    if (option === null || option === undefined) return null;
    if (typeof option !== 'object') {
      const value = cleanText(option);
      return value ? { value, label: prettyKey(value) } : null;
    }
    const value = firstText(option.value, option.id, option.key, option.name);
    if (!value && option.label === undefined) return null;
    return {
      value: value || cleanText(option.label),
      label: firstText(option.label, option.name, option.display_name, value),
      description: cleanText(option.description),
      image: firstText(option.image, option.image_url, option.thumbnail, option.thumb_url),
      media_id: firstText(option.media_id, option.mediaId),
      icon: firstText(option.icon),
      price_cents: Number.isFinite(Number(option.price_cents)) ? Number(option.price_cents)
        : (Number.isFinite(Number(option.unit_price)) ? Math.round(Number(option.unit_price) * 100) : null)
    };
  }
  /** item.options, or options_from (expression / pricebook sugar), or []. */
  function resolveOptions(item, scope, services){
    const direct = arr(item.options).map(normalizeOption).filter(Boolean);
    if (direct.length) return direct;
    const from = cleanText(item.options_from || item.optionsFrom || item.source);
    if (!from) return [];
    // pricebook.category('shingles') sugar — resolvable client-side.
    const pbMatch = from.match(/pricebook\.category\(\s*['"]([^'"]+)['"]\s*\)/);
    if (pbMatch) {
      const category = pbMatch[1];
      const pricebook = obj(services).pricebook;
      try {
        const items = arr(
          (typeof pricebook?.category === 'function' && pricebook.category(category))
          || arr(obj(typeof pricebook?.getState === 'function' ? pricebook.getState() : null).items)
            .filter((entry) => cleanText(obj(entry).category) === category)
        );
        const mapped = items.map(normalizeOption).filter(Boolean);
        if (mapped.length) return mapped;
      } catch (e) { /* fall through */ }
    }
    const evaluated = evalExpr(from, scope);
    return arr(evaluated).map(normalizeOption).filter(Boolean);
  }

  // ---------------------------------------------------- scope item helpers
  // Line items keep EXACTLY the proposal builder's editable.scope.root_items
  // item shape so the server's doc.line_items resolver understands them.
  function makeScopeItem(overrides){
    return {
      id: uid('scope'),
      type: 'scope_item',
      pricebook_ref: {},
      name: '',
      display_name: '',
      description: '',
      unit: 'ea',
      quantity: '1',
      unit_price: 0,
      base_price: 0,
      included: false,
      price_driving: true,
      selection: { mode: 'always', selected: true },
      variations: [],
      children: [],
      ...obj(overrides)
    };
  }
  function normalizeScopeItem(item){
    const source = obj(item);
    return {
      ...makeScopeItem(),
      ...source,
      id: firstText(source.id, uid('scope')),
      type: firstText(source.type, 'scope_item'),
      name: firstText(source.name, source.display_name, 'Line item'),
      quantity: String(source.quantity ?? '1'),
      unit_price: Number(source.unit_price ?? source.unitPrice ?? source.base_price ?? source.basePrice ?? source.amount ?? 0) || 0,
      base_price: Number(source.base_price ?? source.basePrice ?? source.unit_price ?? 0) || 0,
      children: arr(source.children).map(normalizeScopeItem)
    };
  }
  function scopeItemsTotal(items){
    let total = 0;
    const walk = (list) => arr(list).forEach((item) => {
      if (item.included !== true && item.price_driving !== false && obj(item.selection).selected !== false) {
        total += (Number(item.quantity || 0) || 0) * (Number(item.unit_price || 0) || 0);
      }
      walk(item.children);
    });
    walk(items);
    return total;
  }
  function countScopeItems(items){
    let count = 0;
    const walk = (list) => arr(list).forEach((item) => { count += 1; walk(obj(item).children); });
    walk(items);
    return count;
  }
  /** Measurement keys referenced by scope-item pricing formulas. */
  function scopeMeasurementKeys(items){
    const keys = new Set();
    const pricebook = root.FirstMatePricebook;
    const addFromConfig = (config) => {
      arr(obj(config).tokens).forEach((raw) => {
        const token = obj(raw);
        if (cleanText(token.type) === 'measurement' && cleanText(token.value)) keys.add(cleanText(token.value));
      });
    };
    const walk = (list) => arr(list).forEach((raw) => {
      const item = obj(raw);
      addFromConfig(item.formula_config || item.formulaConfig);
      arr(item.variations).forEach((variation) => addFromConfig(obj(variation).formula_config || obj(variation).formulaConfig));
      const ref = obj(item.pricebook_ref);
      const refId = firstText(ref.item_id, ref.catalog_item_id, ref.id);
      if (refId && typeof pricebook?.getItem === 'function') {
        try {
          const pbItem = obj(pricebook.getItem(refId));
          addFromConfig(pbItem.formula_config || pbItem.formulaConfig);
        } catch (e) { /* pricebook not hydrated */ }
      }
      walk(item.children);
    });
    walk(items);
    return [...keys];
  }
  /** Measurement keys declared by the piece selection (piece_select writes
   *  them to params.measurement_requirements after derivation). */
  function requiredMeasurementKeys(sc){
    return arr(getPath(sc, 'params.measurement_requirements')).map(cleanText).filter(Boolean);
  }
  /** True when an item already holds a complete answer — used by the
   *  step-level `auto_skip_when_complete` flag. Measurements items driven by
   *  scope formulas count as complete when EVERY formula-derived key has a
   *  value (vacuously true when the scope needs no measurements). */
  function itemAnswered(item, sc){
    const source = obj(item);
    const value = getPath(sc, cleanText(source.writes));
    if (cleanText(source.kind) === 'measurements') {
      const from = cleanText(source.fields_from || source.fieldsFrom);
      let needed = null;
      if (from === 'scope_items_formulas') needed = scopeMeasurementKeys(arr(getPath(sc, 'params.scope_items')));
      else if (from === 'measurement_requirements' || from === 'piece_selection') needed = requiredMeasurementKeys(sc);
      if (needed) {
        const current = obj(value);
        return needed.every((key) => !(current[key] === undefined || current[key] === null || current[key] === ''));
      }
    }
    return !isEmptyValue(value);
  }

  function measurementLabelFor(key){
    const pricebook = root.FirstMatePricebook;
    let fields = [];
    try { fields = arr(pricebook?.formulaFields?.() || pricebook?.measurementFields); }
    catch (e) { fields = arr(pricebook?.measurementFields); }
    return firstText(fields.find((field) => obj(field).key === key)?.label, prettyKey(key));
  }

  // ------------------------------------------------------- value formatting
  function formatValue(item, value){
    const kind = cleanText(obj(item).kind);
    if (isEmptyValue(value) && typeof value !== 'number' && typeof value !== 'boolean') return '—';
    if (kind === 'currency') return moneyFromCents(value);
    if (kind === 'boolean') return value ? 'Yes' : 'No';
    if (kind === 'date') return cleanText(value).slice(0, 10) || '—';
    if (kind === 'multi_select') return arr(value).map((v) => prettyKey(v)).join(', ') || '—';
    if (kind === 'line_item_editor' || kind === 'piece_picker' || kind === 'line_items_review') {
      const count = countScopeItems(value);
      return count ? `${count} line item${count === 1 ? '' : 's'} · ${moneyFromDollars(scopeItemsTotal(value))}` : '—';
    }
    if (kind === 'piece_select') {
      const names = arr(value).map((p) => firstText(obj(p).name, obj(p).template_id, typeof p === 'string' ? p : '')).filter(Boolean);
      return names.length ? names.join(', ') : '—';
    }
    if (kind === 'measurements') {
      const entries = Object.keys(obj(value));
      return entries.length ? `${entries.length} measurement${entries.length === 1 ? '' : 's'}` : '—';
    }
    if (kind === 'content_blocks') {
      const count = arr(value).length;
      return count ? `${count} content block${count === 1 ? '' : 's'}` : '—';
    }
    if (kind === 'media_picker') {
      if (Array.isArray(value)) return value.length ? `${value.length} photo${value.length === 1 ? '' : 's'}` : '—';
      return obj(value).media_id ? '1 photo' : '—';
    }
    if (kind === 'signature') {
      const sig = obj(value);
      return sig.signer_name ? `Signed by ${sig.signer_name}` : (isEmptyValue(value) ? 'Not signed' : 'Signed');
    }
    if (kind === 'payment') return isEmptyValue(value) ? 'Not paid' : 'Paid';
    if (kind === 'choice_group') {
      if (Array.isArray(value)) return value.map((v) => prettyKey(typeof v === 'object' ? firstText(v.value, v.id) : v)).join(', ') || '—';
      if (value && typeof value === 'object') return prettyKey(firstText(value.value, value.id, JSON.stringify(value)));
      return prettyKey(value);
    }
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
  }

  // ============================================================ kind registry
  const kindRegistry = new Map();
  function registerKind(kind, renderer){
    if (!cleanText(kind) || typeof renderer !== 'function') return;
    kindRegistry.set(cleanText(kind), renderer);
  }

  // Simple field wrapper used by the scalar kinds.
  function fieldShell(el, ctx, controlHtml){
    el.innerHTML = `
      <label class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        ${controlHtml}
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </label>`;
    return el.querySelector('[data-fmdw-control]');
  }
  function itemLabel(item){
    return firstText(item.label, item.title, prettyKey(cleanText(item.writes).split('.').pop()), 'Field');
  }
  function requiredError(ctx){
    if (ctx.item.required && isEmptyValue(ctx.value())) return 'This field is required.';
    return null;
  }

  // ------------------------------------------------------------ scalar kinds
  registerKind('text', (el, ctx) => {
    const multiline = cleanText(obj(ctx.item.presentation).style) === 'multiline' || obj(ctx.item.presentation).multiline === true;
    const value = ctx.value();
    const control = fieldShell(el, ctx, multiline
      ? `<textarea data-fmdw-control ${ctx.readonly ? 'disabled' : ''} placeholder="${esc(ctx.item.placeholder || '')}">${esc(value ?? '')}</textarea>`
      : `<input type="text" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(value ?? '')}" placeholder="${esc(ctx.item.placeholder || '')}">`);
    control?.addEventListener('change', () => ctx.write(control.value));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('number', (el, ctx) => {
    const value = ctx.value();
    const control = fieldShell(el, ctx, `<input type="number" step="any" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${value === null || value === undefined || value === '' ? '' : esc(value)}">`);
    control?.addEventListener('change', () => ctx.write(cleanText(control.value) === '' ? null : Number(control.value)));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('currency', (el, ctx) => {
    const cents = ctx.value();
    const dollars = cents === null || cents === undefined || cents === '' ? '' : (Number(cents || 0) / 100).toFixed(2);
    const control = fieldShell(el, ctx, `<span class="fmdw-money"><input type="number" step="0.01" min="0" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(dollars)}" placeholder="0.00"></span>`);
    control?.addEventListener('change', () => ctx.write(cleanText(control.value) === '' ? null : Math.round(Number(control.value || 0) * 100)));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('date', (el, ctx) => {
    const control = fieldShell(el, ctx, `<input type="date" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(cleanText(ctx.value()).slice(0, 10))}">`);
    control?.addEventListener('change', () => ctx.write(control.value || null));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('boolean', (el, ctx) => {
    el.innerHTML = `
      <label class="fmdw-toggle-row">
        <span class="fmdw-toggle ${ctx.value() === true ? 'on' : ''}" data-fmdw-toggle role="switch" aria-checked="${ctx.value() === true}" tabindex="${ctx.readonly ? -1 : 0}"><i></i></span>
        <span class="fmdw-toggle-copy">
          <strong>${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</strong>
          ${ctx.item.description ? `<small>${esc(ctx.item.description)}</small>` : ''}
        </span>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </label>`;
    const toggle = el.querySelector('[data-fmdw-toggle]');
    const flip = () => {
      if (ctx.readonly) return;
      const next = !(ctx.value() === true);
      ctx.write(next);
      toggle.classList.toggle('on', next);
      toggle.setAttribute('aria-checked', String(next));
    };
    toggle?.addEventListener('click', flip);
    toggle?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
    });
    return { validate: () => (ctx.item.required && ctx.value() !== true && ctx.value() !== false ? 'Choose an option.' : null) };
  });

  registerKind('select', (el, ctx) => {
    const options = ctx.options();
    const presentation = obj(ctx.item.presentation);
    if (['cards', 'tiles', 'buttons'].includes(cleanText(presentation.style))) {
      renderChoiceCards(el, ctx, options, false);
      return { validate: () => requiredError(ctx) };
    }
    const current = cleanText(ctx.value());
    const control = fieldShell(el, ctx, `
      <select data-fmdw-control ${ctx.readonly ? 'disabled' : ''}>
        <option value="">—</option>
        ${options.map((opt) => `<option value="${esc(opt.value)}" ${opt.value === current ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}
      </select>`);
    control?.addEventListener('change', () => ctx.write(control.value || null));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('multi_select', (el, ctx) => {
    const options = ctx.options();
    if (['cards', 'tiles', 'buttons'].includes(cleanText(obj(ctx.item.presentation).style))) {
      renderChoiceCards(el, ctx, options, true);
      return { validate: () => requiredError(ctx) };
    }
    const selected = arr(ctx.value()).map(cleanText);
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        <div class="fmdw-check-list">
          ${options.length ? options.map((opt) => `
            <label class="fmdw-check">
              <input type="checkbox" value="${esc(opt.value)}" ${selected.includes(opt.value) ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''}>
              <span>${esc(opt.label)}</span>
            </label>`).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2eeb0742b30735","No options are configured for this question.") ?? "No options are configured for this question.")}</p>`}
        </div>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </div>`;
    el.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => {
      const values = [...el.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
      ctx.write(values);
    }));
    return { validate: () => requiredError(ctx) };
  });

  // ------------------------------------------------------------ choice cards
  function optionImageUrl(opt, services){
    if (opt.image) return opt.image;
    if (opt.media_id && typeof obj(services).media?.url === 'function') {
      try { return cleanText(obj(services).media.url(opt.media_id)); } catch (e) { return ''; }
    }
    return '';
  }
  function renderChoiceCards(el, ctx, options, multi){
    const showImages = obj(ctx.item.presentation).images === true || options.some((opt) => optionImageUrl(opt, ctx.services));
    const selectedValues = multi
      ? arr(ctx.value()).map((v) => cleanText(typeof v === 'object' ? obj(v).value : v))
      : [cleanText(typeof ctx.value() === 'object' ? obj(ctx.value()).value : ctx.value())].filter(Boolean);
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        <div class="fmdw-choice-grid">
          ${options.length ? options.map((opt) => {
            const image = showImages ? optionImageUrl(opt, ctx.services) : '';
            const active = selectedValues.includes(opt.value);
            return `
              <button type="button" class="fmdw-choice-card ${active ? 'active' : ''}" data-fmdw-choice="${esc(opt.value)}" ${ctx.readonly ? 'disabled' : ''}>
                ${image ? `<span class="fmdw-choice-img"><img src="${esc(image)}" alt="" loading="lazy"></span>` : (opt.icon ? `<span class="fmdw-choice-icon"><i class="fas ${esc(opt.icon)}"></i></span>` : '')}
                <strong>${esc(opt.label)}</strong>
                ${opt.description ? `<small>${esc(opt.description)}</small>` : ''}
                ${opt.price_cents !== null && opt.price_cents !== undefined ? `<span class="fmdw-choice-price">${esc(moneyFromCents(opt.price_cents))}</span>` : ''}
                <span class="fmdw-choice-tick"><i class="fas fa-check"></i></span>
              </button>`;
          }).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2eeb0742b30735","No options are configured for this question.") ?? "No options are configured for this question.")}</p>`}
        </div>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </div>`;
    el.querySelectorAll('[data-fmdw-choice]').forEach((button) => button.addEventListener('click', () => {
      const value = button.dataset.fmdwChoice;
      if (multi) {
        const current = arr(ctx.value()).map((v) => cleanText(typeof v === 'object' ? obj(v).value : v));
        const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
        ctx.write(next);
      } else {
        ctx.write(value);
      }
      renderChoiceCards(el, ctx, options, multi);
      ctx.requestPreview();
    }));
  }

  registerKind('choice_group', (el, ctx) => {
    const source = cleanText(ctx.item.options_from || ctx.item.optionsFrom);
    // options_from:"scope_items" — the customer-facing choices ARE the scope's
    // choice groups (shingle profile, underlayment, optional add-ons...).
    // Internal reps set the defaults directly on params.scope_items; the
    // customer audience records picks as outputs.selections (outputs-only).
    if (source === 'scope_items' || source === 'scope_item_choice_groups') {
      return renderScopeChoiceGroups(el, ctx);
    }
    const options = ctx.options();
    const multi = ctx.item.multi === true || obj(ctx.item.presentation).multi === true;
    renderChoiceCards(el, ctx, options, multi);
    return { validate: () => requiredError(ctx) };
  });

  function collectScopeChoiceGroups(scopeItems){
    const groups = new Map();
    const optionals = [];
    const groupTitles = new Map();
    const walk = (items) => {
      for (const raw of arr(items)) {
        const item = obj(raw);
        for (const def of arr(item.selection_groups)) {
          const g = obj(def);
          if (cleanText(g.id)) groupTitles.set(cleanText(g.id), { title: firstNonEmpty(g.title, g.label, cleanText(g.id)), behavior: cleanText(g.behavior) || 'single' });
        }
        const sel = obj(item.selection);
        const customer = arr(sel.selectable_by).includes('customer');
        if (customer && cleanText(sel.mode) === 'choice' && cleanText(sel.group_id)) {
          const gid = cleanText(sel.group_id);
          if (!groups.has(gid)) groups.set(gid, []);
          groups.get(gid).push(item);
        } else if (customer && cleanText(sel.mode) === 'optional') {
          optionals.push(item);
        }
        walk(item.children);
      }
    };
    walk(scopeItems);
    return { groups, optionals, groupTitles };
  }

  function firstNonEmpty(...values){
    for (const value of values) { const text = cleanText(value); if (text) return text; }
    return '';
  }

  function renderScopeChoiceGroups(el, ctx){
    const render = () => {
      const scope = ctx.scope();
      const scopeItems = arr(getPath(scope, 'params.scope_items'));
      const { groups, optionals, groupTitles } = collectScopeChoiceGroups(scopeItems);
      const customerAudience = ['customer', 'field'].includes(ctx.audience);
      const selections = customerAudience ? obj(getPath(scope, 'outputs.selections')) : {};
      const isSelected = (item) => {
        const sel = obj(item.selection);
        if (!customerAudience) return sel.selected === true;
        const gid = cleanText(sel.group_id);
        if (gid && selections[gid] !== undefined) return cleanText(selections[gid]) === cleanText(item.id);
        if (!gid && selections[cleanText(item.id)] !== undefined) return selections[cleanText(item.id)] === true;
        return sel.selected === true;
      };
      const priceTag = (item) => {
        const price = Number(item.unit_price || item.base_price || 0) * (Number(item.quantity) || 1);
        return price > 0 ? `<em>+ ${esc(moneyFromDollars(price))}</em>` : '';
      };
      const optionCard = (item, gid) => `
        <button type="button" class="fmdw-choice-card ${isSelected(item) ? 'active' : ''}" data-fmdw-scg-option="${esc(cleanText(item.id))}" data-fmdw-scg-group="${esc(gid)}" ${ctx.readonly ? 'disabled' : ''}>
          <strong>${esc(firstNonEmpty(item.display_name, item.name, 'Option'))}</strong>
          ${cleanText(item.description) ? `<span>${esc(cleanText(item.description))}</span>` : ''}
          ${priceTag(item)}
          ${isSelected(item) ? '<i class="fas fa-circle-check"></i>' : ''}
        </button>`;
      const sections = [];
      for (const [gid, items] of groups.entries()) {
        const meta = groupTitles.get(gid) || { title: gid, behavior: 'single' };
        sections.push(`
          <div class="fmdw-scg-group">
            <span class="fmdw-field-label">${esc(meta.title)}</span>
            <div class="fmdw-choice-grid">${items.map((item) => optionCard(item, gid)).join('')}</div>
          </div>`);
      }
      if (optionals.length) {
        sections.push(`
          <div class="fmdw-scg-group">
            <span class="fmdw-field-label">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_1ad84cd7f804e7","Optional add-ons") ?? "Optional add-ons")}</span>
            <div class="fmdw-choice-grid">${String(optionals.map((item) => optionCard(item, '')).join(''))}</div>
          </div>`);
      }
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          ${sections.length
            ? sections.join('')
            : `<div class="fmdw-card"><p class="fmdw-hint" style="margin:0"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_7bbfcb28626c80"," No customer-facing options in this scope yet. Options come from the line items’ choice groups and customer-optional rows.") ?? " No customer-facing options in this scope yet. Options come from the line items’ choice groups and customer-optional rows.")}</p></div>`}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      if (ctx.readonly) return;
      el.querySelectorAll('[data-fmdw-scg-option]').forEach((button) => button.addEventListener('click', () => {
        const optionId = cleanText(button.dataset.fmdwScgOption);
        const gid = cleanText(button.dataset.fmdwScgGroup);
        if (customerAudience) {
          const next = obj(clone(selections));
          if (gid) next[gid] = optionId;
          else {
            const target = optionals.find((item) => cleanText(item.id) === optionId);
            next[optionId] = !(target && isSelected(target));
          }
          ctx.writePath('outputs.selections', next);
        } else {
          const tree = clone(scopeItems);
          const walk = (items) => {
            for (const item of arr(items)) {
              const sel = obj(item.selection);
              if (gid && cleanText(sel.group_id) === gid && cleanText(sel.mode) === 'choice') {
                item.selection = { ...sel, selected: cleanText(item.id) === optionId };
              } else if (!gid && cleanText(item.id) === optionId && cleanText(sel.mode) === 'optional') {
                item.selection = { ...sel, selected: sel.selected !== true };
              }
              walk(item.children);
            }
          };
          walk(tree);
          ctx.writePath('params.scope_items', tree);
        }
        ctx.requestPreview?.();
        render();
      }));
    };
    render();
    return { validate: () => null };
  }

  // ------------------------------------------------------------ measurements
  registerKind('measurements', (el, ctx) => {
    const render = () => {
      const current = obj(ctx.value());
      // fields_from: "scope_items_formulas" — the scope's pricing formulas
      // decide which measurements are needed (mirrors the app's Data panel).
      // fields_from: "measurement_requirements" — the SELECTED pieces decide
      // (piece_select derives the keys before any items are generated), so
      // measurements are asked exactly once, pre-generation.
      let neededKeys = [];
      const fieldsFrom = cleanText(ctx.item.fields_from || ctx.item.fieldsFrom);
      if (fieldsFrom === 'scope_items_formulas') {
        const scope = ctx.scope();
        const scopeItems = arr(getPath(scope, 'params.scope_items'));
        neededKeys = scopeMeasurementKeys(scopeItems);
      } else if (fieldsFrom === 'measurement_requirements' || fieldsFrom === 'piece_selection') {
        neededKeys = requiredMeasurementKeys(ctx.scope());
      }
      const prefillExpr = cleanText(ctx.item.prefill);
      const prefillValue = prefillExpr ? obj(prefillExpr.includes('{{') || /[()]/.test(prefillExpr)
        ? evalExpr(prefillExpr, ctx.scope())
        : getPath(ctx.scope(), prefillExpr)) : {};
      const hasPrefill = Object.keys(prefillValue).length > 0;
      // First open with an empty value: load the prefill automatically.
      if (isEmptyValue(ctx.value()) && hasPrefill && !ctx.readonly) {
        ctx.write(clone(prefillValue));
        return render();
      }
      const otherEntries = Object.entries(current).filter(([key]) => !neededKeys.includes(key));
      const missing = neededKeys.filter((key) => current[key] === undefined || current[key] === null || current[key] === '');
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${neededKeys.length ? `
              <p class="fmdw-hint" style="margin:0"><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_bcbe13786c818e"," These measurements drive this document's pricing:") ?? " These measurements drive this document's pricing:")}</p>
              <div class="fmdw-meas-grid">
                ${String(neededKeys.map((key) => {
                  const filled = !(current[key] === undefined || current[key] === null || current[key] === '');
                  return `
                    <label class="fmdw-meas-field ${filled ? '' : 'needed'}">
                      <span>${esc(measurementLabelFor(key))}</span>
                      <input type="number" step="any" min="0" data-fmdw-meas="${esc(key)}" ${ctx.readonly ? 'disabled' : ''} value="${filled ? esc(Number(current[key])) : ''}" placeholder="—">
                    </label>`;
                }).join(''))}
              </div>
              ${String(missing.length ? `<p class="fmdw-meas-note"><i class="fas fa-triangle-exclamation"></i>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_5d86a0fb6c1652",` ${v0} measurement${v1} still needed`,{v0,v1}) ?? ` ${v0} measurement${v1} still needed`)(missing.length,missing.length === 1 ? '' : 's')}</p>` : '')}` : ''}
            ${otherEntries.length ? `
              <div class="fmdw-stat-grid">
                ${otherEntries.slice(0, 12).map(([key, value]) => `<span class="fmdw-stat"><i>${esc(prettyKey(key))}</i><b>${esc(typeof value === 'object' ? `${Object.keys(obj(value)).length || arr(value).length} entries` : String(value))}</b></span>`).join('')}
                ${otherEntries.length > 12 ? `<span class="fmdw-stat"><i>${((v0) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_1d44c767357f4a",`+${v0} more`,{v0}) ?? `+${v0} more`)(otherEntries.length - 12)}</i><b></b></span>` : ''}
              </div>` : (neededKeys.length ? '' : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_08781c4c9e5c9b","No measurements yet.") ?? "No measurements yet.")}</p>`)}
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions">
                <button type="button" class="fmdw-btn ghost" data-fmdw-meas-reload ${String(hasPrefill ? '' : 'disabled')}><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_641beeb7a2ff91"," Load from project") ?? " Load from project")}</button>
                ${String(Object.keys(current).length ? `<button type="button" class="fmdw-btn ghost" data-fmdw-meas-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_687e1653230514"," Clear") ?? " Clear")}</button>` : '')}
              </div>`}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-meas]').forEach((input) => input.addEventListener('change', () => {
        const next = obj(clone(ctx.value()));
        const key = input.dataset.fmdwMeas;
        if (cleanText(input.value) === '') delete next[key];
        else next[key] = Number(input.value) || 0;
        ctx.write(Object.keys(next).length ? next : null);
        // NO re-render here: change fires on Tab/blur, and rebuilding the DOM
        // mid-Tab destroys focus order. Update the needed-highlight in place;
        // the full field list re-renders on step entry.
        const wrap = input.closest('.fmdw-meas-field, .fmdw-field-row, label') || input;
        wrap.classList?.toggle('missing', cleanText(input.value) === '');
      }));
      el.querySelector('[data-fmdw-meas-reload]')?.addEventListener('click', () => { ctx.write(clone(prefillValue)); render(); });
      el.querySelector('[data-fmdw-meas-clear]')?.addEventListener('click', () => { ctx.write(null); render(); });
    };
    render();
    return { validate: () => requiredError(ctx) };
  });

  // ------------------------------------------------------------ media picker
  registerKind('media_picker', (el, ctx) => {
    const media = obj(ctx.services).media;
    const multi = ctx.item.multi === true || obj(ctx.item.presentation).multi === true;
    const render = () => {
      let photos = [];
      try { photos = arr(typeof media?.photos === 'function' ? media.photos() : media?.photos).map(obj).filter((p) => firstText(p.media_id, p.id)); }
      catch (e) { photos = []; }
      const selectedIds = multi
        ? arr(ctx.value()).map((v) => firstText(obj(v).media_id, obj(v).id, typeof v === 'string' ? v : ''))
        : [firstText(obj(ctx.value()).media_id, obj(ctx.value()).id)].filter(Boolean);
      const urlFor = (photo) => {
        if (firstText(photo.url, photo.thumb_url, photo.src)) return firstText(photo.url, photo.thumb_url, photo.src);
        try { return typeof media?.url === 'function' ? cleanText(media.url(firstText(photo.media_id, photo.id))) : ''; } catch (e) { return ''; }
      };
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${photos.length ? `
              <div class="fmdw-photo-grid">
                ${photos.slice(0, 30).map((photo) => {
                  const id = firstText(photo.media_id, photo.id);
                  const active = selectedIds.includes(id);
                  return `
                    <button type="button" class="fmdw-photo ${active ? 'active' : ''}" data-fmdw-photo="${esc(id)}" ${ctx.readonly ? 'disabled' : ''} title="${esc(photo.label || '')}">
                      <img src="${esc(urlFor(photo))}" alt="${esc(photo.label || 'Photo')}" loading="lazy">
                      ${active ? '<i class="fas fa-circle-check"></i>' : ''}
                    </button>`;
                }).join('')}
              </div>`
              : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f236362c34b933","No project photos are available to choose from yet.") ?? "No project photos are available to choose from yet.")}</p>`}
            ${!ctx.readonly && selectedIds.length ? `<div class="fmdw-row-actions"><button type="button" class="fmdw-btn ghost" data-fmdw-photo-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_4f893b8c92cc5a"," Clear selection") ?? " Clear selection")}</button></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-photo]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.fmdwPhoto;
        if (multi) {
          const current = arr(ctx.value()).map((v) => obj(typeof v === 'string' ? { media_id: v } : v));
          const exists = current.some((v) => firstText(v.media_id, v.id) === id);
          const next = exists ? current.filter((v) => firstText(v.media_id, v.id) !== id) : [...current, { media_id: id, variant: 'display' }];
          ctx.write(next);
        } else {
          ctx.write({ media_id: id, variant: 'display' });
        }
        render();
        ctx.requestPreview();
      }));
      el.querySelector('[data-fmdw-photo-clear]')?.addEventListener('click', () => { ctx.write(multi ? [] : null); render(); });
    };
    render();
    return { validate: () => requiredError(ctx) };
  });

  // ----------------------------------------------------------- content blocks
  // Tiers spec §10.1 — edits params.content_blocks rows:
  //   { id, title, body, media: {media_id|url} | null, video: {url} | null,
  //     layout: "auto"|"media_left"|"media_right"|"text_only",
  //     display: "inline"|"popup" }
  // Document-side the rows render through a repeater over a media_text_row
  // component; layout "auto" alternates left/right via the repeater's
  // variant_by_index (doc-model), and display "popup" rows emit the
  // data-fmdoc-media-popup lightbox chip (doc-widgets contract).
  const CONTENT_BLOCK_LAYOUTS = [
    ['auto', 'Alternate sides'],
    ['media_left', 'Media left'],
    ['media_right', 'Media right'],
    ['text_only', 'Text only']
  ];
  const CONTENT_BLOCK_DISPLAYS = [['inline', 'Inline'], ['popup', 'Popup']];
  function normalizeContentBlock(raw){
    const source = obj(raw);
    const media = obj(source.media);
    const video = obj(source.video);
    return {
      id: firstText(source.id, uid('cb')),
      title: cleanText(source.title),
      body: String(source.body ?? ''),
      media: firstText(media.media_id, media.url) ? { ...media } : null,
      video: firstText(video.url) ? { ...video } : null,
      layout: CONTENT_BLOCK_LAYOUTS.some(([value]) => value === cleanText(source.layout)) ? cleanText(source.layout) : 'auto',
      display: cleanText(source.display) === 'popup' ? 'popup' : 'inline'
    };
  }

  registerKind('content_blocks', (el, ctx) => {
    let blocks = arr(ctx.value()).map(normalizeContentBlock);
    let pickerOpenFor = ''; // block id whose project-photo grid is expanded
    const media = obj(ctx.services).media;
    const commit = () => { ctx.write(clone(blocks)); ctx.requestPreview(); };
    const photoList = () => {
      try { return arr(typeof media?.photos === 'function' ? media.photos() : media?.photos).map(obj).filter((p) => firstText(p.media_id, p.id)); }
      catch (e) { return []; }
    };
    const photoUrl = (photo) => {
      if (firstText(photo.url, photo.thumb_url, photo.src)) return firstText(photo.url, photo.thumb_url, photo.src);
      try { return typeof media?.url === 'function' ? cleanText(media.url(firstText(photo.media_id, photo.id))) : ''; } catch (e) { return ''; }
    };
    const blockThumb = (block) => {
      const source = obj(block.media);
      if (firstText(source.url)) return cleanText(source.url);
      const id = firstText(source.media_id);
      if (id && typeof media?.url === 'function') { try { return cleanText(media.url(id)); } catch (e) { return ''; } }
      return '';
    };

    const render = () => {
      const cards = blocks.map((block, index) => {
        const thumb = blockThumb(block);
        const photos = pickerOpenFor === block.id ? photoList() : [];
        return `
          <div class="fmdw-cb-card" data-fmdw-cb="${String(esc(block.id))}">
            <div class="fmdw-cb-head">
              <span class="fmdw-cb-index">${String(index + 1)}</span>
              <input type="text" class="fmdw-cb-title" data-fmdw-cb-title value="${String(esc(block.title))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_09242ff7fde37f","Block title") ?? "Block title")}" ${String(ctx.readonly ? 'disabled' : '')}>
              ${String(ctx.readonly ? '' : `
                <button type="button" class="fmdw-icon-btn" data-fmdw-cb-up title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f51d0d563b4d76","Move up") ?? "Move up")}" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="fmdw-icon-btn" data-fmdw-cb-down title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8dda6677ff0f34","Move down") ?? "Move down")}" ${index === blocks.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="fmdw-icon-btn danger" data-fmdw-cb-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_e635189453de2e","Remove block") ?? "Remove block")}"><i class="fas fa-xmark"></i></button>`)}
            </div>
            <textarea class="fmdw-cb-body" data-fmdw-cb-body placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8b606c39e02eaa","Body text — what should the customer read here?") ?? "Body text — what should the customer read here?")}" ${String(ctx.readonly ? 'disabled' : '')}>${String(esc(block.body))}</textarea>
            <div class="fmdw-cb-media-row">
              <div class="fmdw-cb-thumb ${String(thumb ? '' : 'empty')}">
                ${String(thumb ? `<img src="${esc(thumb)}" alt="">` : '<i class="fas fa-image"></i>')}
              </div>
              <div class="fmdw-cb-media-controls">
                ${String(ctx.readonly ? '' : `
                  <div class="fmdw-row-actions">
                    <button type="button" class="fmdw-btn ghost" data-fmdw-cb-pick><i class="fas fa-images"></i> ${pickerOpenFor === block.id ? 'Hide photos' : 'Pick photo'}</button>
                    ${block.media ? `<button type="button" class="fmdw-btn ghost" data-fmdw-cb-clear-media><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_687e1653230514"," Clear") ?? " Clear")}</button>` : ''}
                  </div>`)}
                <input type="text" data-fmdw-cb-media-url value="${String(esc(firstText(obj(block.media).url)))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_bec0e58a594874","…or paste an image URL") ?? "…or paste an image URL")}" ${String(ctx.readonly ? 'disabled' : '')}>
                <input type="text" data-fmdw-cb-video value="${String(esc(firstText(obj(block.video).url)))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_d4f98e183ac3e7","Video URL (YouTube, Vimeo, or file)") ?? "Video URL (YouTube, Vimeo, or file)")}" ${String(ctx.readonly ? 'disabled' : '')}>
              </div>
            </div>
            ${String(pickerOpenFor === block.id ? `
              <div class="fmdw-photo-grid fmdw-cb-photo-grid">
                ${photos.length ? photos.slice(0, 30).map((photo) => {
                  const id = firstText(photo.media_id, photo.id);
                  const active = firstText(obj(block.media).media_id) === id;
                  return `
                    <button type="button" class="fmdw-photo ${active ? 'active' : ''}" data-fmdw-cb-photo="${esc(id)}" title="${esc(photo.label || '')}">
                      <img src="${esc(photoUrl(photo))}" alt="${esc(photo.label || 'Photo')}" loading="lazy">
                      ${active ? '<i class="fas fa-circle-check"></i>' : ''}
                    </button>`;
                }).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8c7d055c8d2a9d","No project photos are available — paste an image URL instead.") ?? "No project photos are available — paste an image URL instead.")}</p>`}
              </div>` : '')}
            <div class="fmdw-cb-settings">
              <label>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_414b43a606b221","Layout\n                ") ?? "Layout\n                ")}<select data-fmdw-cb-layout ${String(ctx.readonly ? 'disabled' : '')}>
                  ${String(CONTENT_BLOCK_LAYOUTS.map(([value, label]) => `<option value="${esc(value)}" ${block.layout === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
                </select>
              </label>
              <label>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0a1b926b9ae7f2","Media display\n                ") ?? "Media display\n                ")}<select data-fmdw-cb-display ${String(ctx.readonly ? 'disabled' : '')}>
                  ${String(CONTENT_BLOCK_DISPLAYS.map(([value, label]) => `<option value="${esc(value)}" ${block.display === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
                </select>
              </label>
            </div>
          </div>`;
      });
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-cb-list">
            ${cards.length ? cards.join('') : `<div class="fmdw-card"><p class="fmdw-hint" style="margin:0"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9b58eb110cbbc5"," No content blocks yet — add one to pair photos and text on the document.") ?? " No content blocks yet — add one to pair photos and text on the document.")}</p></div>`}
          </div>
          ${ctx.readonly ? '' : `<div class="fmdw-row-actions"><button type="button" class="fmdw-btn" data-fmdw-cb-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_d2da9449c9549c"," Add block") ?? " Add block")}</button></div>`}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;

      const blockAt = (id) => blocks.find((b) => b.id === id);
      el.querySelectorAll('[data-fmdw-cb]').forEach((card) => {
        const id = card.dataset.fmdwCb;
        card.querySelector('[data-fmdw-cb-title]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.title = cleanText(event.target.value); commit(); }
        });
        card.querySelector('[data-fmdw-cb-body]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.body = String(event.target.value ?? ''); commit(); }
        });
        card.querySelector('[data-fmdw-cb-media-url]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (!block) return;
          const url = cleanText(event.target.value);
          block.media = url ? { url } : (firstText(obj(block.media).media_id) ? block.media : null);
          commit();
          render();
        });
        card.querySelector('[data-fmdw-cb-video]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (!block) return;
          const url = cleanText(event.target.value);
          block.video = url ? { url } : null;
          commit();
        });
        card.querySelector('[data-fmdw-cb-layout]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.layout = cleanText(event.target.value) || 'auto'; commit(); }
        });
        card.querySelector('[data-fmdw-cb-display]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.display = cleanText(event.target.value) === 'popup' ? 'popup' : 'inline'; commit(); }
        });
        card.querySelector('[data-fmdw-cb-pick]')?.addEventListener('click', () => {
          pickerOpenFor = pickerOpenFor === id ? '' : id;
          render();
        });
        card.querySelector('[data-fmdw-cb-clear-media]')?.addEventListener('click', () => {
          const block = blockAt(id);
          if (block) { block.media = null; commit(); render(); }
        });
        card.querySelectorAll('[data-fmdw-cb-photo]').forEach((button) => button.addEventListener('click', () => {
          const block = blockAt(id);
          if (!block) return;
          const mediaId = button.dataset.fmdwCbPhoto;
          block.media = firstText(obj(block.media).media_id) === mediaId ? null : { media_id: mediaId, variant: 'display' };
          commit();
          render();
        }));
        card.querySelector('[data-fmdw-cb-remove]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index !== -1) { blocks.splice(index, 1); commit(); render(); }
        });
        card.querySelector('[data-fmdw-cb-up]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index > 0) { blocks.splice(index - 1, 0, blocks.splice(index, 1)[0]); commit(); render(); }
        });
        card.querySelector('[data-fmdw-cb-down]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index !== -1 && index < blocks.length - 1) { blocks.splice(index + 1, 0, blocks.splice(index, 1)[0]); commit(); render(); }
        });
      });
      el.querySelector('[data-fmdw-cb-add]')?.addEventListener('click', () => {
        blocks.push(normalizeContentBlock({ title: '', body: '' }));
        commit();
        render();
      });
    };
    render();
    return { validate: () => (ctx.item.required && !arr(ctx.value()).length ? 'Add at least one content block.' : null) };
  });

  // ---------------------------------------------------- media attach popover
  // Shared by line_items_review rows and the documents app's scope editor
  // (FMDocWorkflow.openMediaAttach): attaches media/video to a scope item —
  //   item.media   = [{ media_id|url, caption? }]
  //   item.video   = { url, caption? } | null
  //   item.display = "inline" | "popup"
  // — persisted with params.scope_items, so the server line-items resolver and
  // doc.line_items / li_row repeater components can render thumbs or the
  // data-fmdoc-media-popup lightbox chip.
  function openMediaAttach(options){
    if (typeof document === 'undefined') return null;
    ensureStyles();
    const opts = obj(options);
    const anchor = opts.anchor;
    const item = obj(opts.item);
    const media = obj(opts.services).media;
    document.querySelectorAll('.fmdw-attach-pop').forEach((existing) => existing.remove());
    if (!anchor || typeof opts.onSave !== 'function') return null;

    let photos = [];
    try { photos = arr(typeof media?.photos === 'function' ? media.photos() : media?.photos).map(obj).filter((p) => firstText(p.media_id, p.id)); }
    catch (e) { photos = []; }
    const photoUrl = (photo) => {
      if (firstText(photo.url, photo.thumb_url, photo.src)) return firstText(photo.url, photo.thumb_url, photo.src);
      try { return typeof media?.url === 'function' ? cleanText(media.url(firstText(photo.media_id, photo.id))) : ''; } catch (e) { return ''; }
    };
    const current = obj(arr(item.media)[0]);
    const state = {
      media_id: firstText(current.media_id),
      media_url: firstText(current.url),
      caption: cleanText(current.caption || obj(item.video).caption),
      video_url: firstText(obj(item.video).url),
      display: cleanText(item.display) === 'popup' ? 'popup' : 'inline'
    };

    const pop = document.createElement('div');
    pop.className = 'fmdw-attach-pop';
    const renderPop = () => {
      pop.innerHTML = `
        <div class="fmdw-attach-head"><i class="fas fa-paperclip"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b4c6eb9bd49fcc"," Photo & video") ?? " Photo & video")}</div>
        ${String(photos.length ? `
          <div class="fmdw-photo-grid fmdw-attach-grid">
            ${photos.slice(0, 18).map((photo) => {
              const id = firstText(photo.media_id, photo.id);
              const active = state.media_id === id;
              return `
                <button type="button" class="fmdw-photo ${active ? 'active' : ''}" data-fmdw-attach-photo="${esc(id)}" title="${esc(photo.label || '')}">
                  <img src="${esc(photoUrl(photo))}" alt="${esc(photo.label || 'Photo')}" loading="lazy">
                  ${active ? '<i class="fas fa-circle-check"></i>' : ''}
                </button>`;
            }).join('')}
          </div>` : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_4adeb3f53bdf71","No project photos available — paste an image URL below.") ?? "No project photos available — paste an image URL below.")}</p>`)}
        <label class="fmdw-attach-field"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_e834f5774af181","Image URL") ?? "Image URL")}</span><input type="text" data-fmdw-attach-url value="${String(esc(state.media_url))}" placeholder="https://…"></label>
        <label class="fmdw-attach-field"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8e5d22e5fc5931","Caption") ?? "Caption")}</span><input type="text" data-fmdw-attach-caption value="${String(esc(state.caption))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_68f76580b578dd","Optional caption") ?? "Optional caption")}"></label>
        <label class="fmdw-attach-field"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_ab0945e21b5b82","Video URL") ?? "Video URL")}</span><input type="text" data-fmdw-attach-video value="${String(esc(state.video_url))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_41259d9663ed29","YouTube, Vimeo, or file URL") ?? "YouTube, Vimeo, or file URL")}"></label>
        <label class="fmdw-attach-field"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_92999b4236dd11","Display") ?? "Display")}</span>
          <select data-fmdw-attach-display>
            <option value="inline" ${String(state.display === 'inline' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_05687b313f334d","Inline (row grows)") ?? "Inline (row grows)")}</option>
            <option value="popup" ${String(state.display === 'popup' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f7737190739c74","Popup (lightbox chip)") ?? "Popup (lightbox chip)")}</option>
          </select>
        </label>
        <div class="fmdw-attach-actions">
          <button type="button" class="fmdw-btn ghost" data-fmdw-attach-remove><i class="fas fa-trash-can"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_09a65903b3217c"," Remove") ?? " Remove")}</button>
          <button type="button" class="fmdw-btn" data-fmdw-attach-cancel>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
          <button type="button" class="fmdw-btn primary" data-fmdw-attach-save>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
        </div>`;
      pop.querySelectorAll('[data-fmdw-attach-photo]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.fmdwAttachPhoto;
        state.media_id = state.media_id === id ? '' : id;
        if (state.media_id) state.media_url = '';
        renderPop();
      }));
      pop.querySelector('[data-fmdw-attach-url]')?.addEventListener('change', (event) => {
        state.media_url = cleanText(event.target.value);
        if (state.media_url) state.media_id = '';
      });
      pop.querySelector('[data-fmdw-attach-caption]')?.addEventListener('change', (event) => { state.caption = cleanText(event.target.value); });
      pop.querySelector('[data-fmdw-attach-video]')?.addEventListener('change', (event) => { state.video_url = cleanText(event.target.value); });
      pop.querySelector('[data-fmdw-attach-display]')?.addEventListener('change', (event) => {
        state.display = cleanText(event.target.value) === 'popup' ? 'popup' : 'inline';
      });
      pop.querySelector('[data-fmdw-attach-remove]')?.addEventListener('click', () => {
        close();
        opts.onSave({ media: [], video: null, display: 'inline' });
      });
      pop.querySelector('[data-fmdw-attach-cancel]')?.addEventListener('click', () => close());
      pop.querySelector('[data-fmdw-attach-save]')?.addEventListener('click', () => {
        // Read the fields directly too, so typing without blurring still lands.
        state.media_url = cleanText(pop.querySelector('[data-fmdw-attach-url]')?.value ?? state.media_url);
        state.caption = cleanText(pop.querySelector('[data-fmdw-attach-caption]')?.value ?? state.caption);
        state.video_url = cleanText(pop.querySelector('[data-fmdw-attach-video]')?.value ?? state.video_url);
        const mediaEntry = state.media_id
          ? { media_id: state.media_id, variant: 'display' }
          : (state.media_url ? { url: state.media_url } : null);
        if (mediaEntry && state.caption) mediaEntry.caption = state.caption;
        const video = state.video_url
          ? { url: state.video_url, ...(!mediaEntry && state.caption ? { caption: state.caption } : {}) }
          : null;
        close();
        opts.onSave({ media: mediaEntry ? [mediaEntry] : [], video, display: state.display });
      });
    };

    function place(){
      const rect = anchor.getBoundingClientRect?.() || { left: 40, bottom: 40 };
      const width = Math.min(340, Math.max(240, window.innerWidth - 24));
      pop.style.width = `${width}px`;
      pop.style.left = `${Math.max(8, Math.min(rect.left - width + 34, window.innerWidth - width - 8))}px`;
      const top = rect.bottom + 6;
      pop.style.top = `${Math.min(top, Math.max(8, window.innerHeight - 30))}px`;
    }
    function onDocDown(event){
      if (!pop.contains(event.target) && event.target !== anchor && !anchor.contains?.(event.target)) close();
    }
    function onKey(event){
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    }
    let closed = false;
    function close(){
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      pop.remove();
    }

    renderPop();
    document.body.appendChild(pop);
    place();
    // Defer so the click that opened the popover doesn't instantly close it.
    setTimeout(() => {
      if (closed) return;
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return { close, element: pop };
  }

  // -------------------------------------------------------- line item editor
  registerKind('line_item_editor', (el, ctx) => {
    let items = arr(ctx.value()).map(normalizeScopeItem);
    const services = obj(ctx.services);
    const commit = () => ctx.write(clone(items));
    const render = () => {
      const rows = [];
      const pushRow = (item, depth) => {
        rows.push(`
          <div class="fmdw-li-row ${String(depth ? 'child' : '')}" data-fmdw-li="${String(esc(item.id))}">
            <div class="fmdw-li-name">
              ${String(ctx.readonly
                ? `<strong>${esc(firstText(item.display_name, item.name, 'Line item'))}</strong>`
                : `<input type="text" data-fmdw-li-name value="${esc(firstText(item.display_name, item.name))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_83915801b47db5","Line item") ?? "Line item")}">`)}
              ${String(item.description ? `<small>${esc(item.description)}</small>` : '')}
            </div>
            <input class="fmdw-li-qty" type="number" step="any" min="0" data-fmdw-li-qty value="${String(esc(item.quantity))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c689ddee2f502","Quantity") ?? "Quantity")}">
            <span class="fmdw-li-unit">${String(esc(item.unit || 'ea'))}</span>
            <input class="fmdw-li-price" type="number" step="0.01" min="0" data-fmdw-li-price value="${String(esc(Number(item.unit_price || 0).toFixed(2)))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c68827ddeaf565","Unit price ($)") ?? "Unit price ($)")}">
            ${String(ctx.readonly ? '' : `<button type="button" class="fmdw-icon-btn danger" data-fmdw-li-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`)}
          </div>`);
        arr(item.children).forEach((child) => pushRow(child, depth + 1));
      };
      items.forEach((item) => pushRow(item, 0));
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions" style="margin-bottom:2px">
                ${String(services.pricebook && typeof services.pricebook.pick === 'function' ? `<button type="button" class="fmdw-btn" data-fmdw-li-pricebook><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c38fcf1b64a2ea"," Pricebook") ?? " Pricebook")}</button>` : '')}
                <button type="button" class="fmdw-btn" data-fmdw-li-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8e13db264d4c9f"," Add row") ?? " Add row")}</button>
              </div>`}
            <div class="fmdw-li-list">
              ${rows.length ? rows.join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0b854052709977","No line items yet.") ?? "No line items yet.")}</p>`}
            </div>
            ${rows.length ? `<div class="fmdw-li-total"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9403c7637d4905","Total") ?? "Total")}</span><b>${String(esc(moneyFromDollars(scopeItemsTotal(items))))}</b></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const findItem = (list, id) => {
        for (const item of arr(list)) {
          if (item.id === id) return { item, list };
          const found = findItem(item.children, id);
          if (found) return found;
        }
        return null;
      };
      el.querySelectorAll('[data-fmdw-li]').forEach((row) => {
        const id = row.dataset.fmdwLi;
        row.querySelector('[data-fmdw-li-name]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) {
            found.item.name = cleanText(event.target.value) || found.item.name;
            found.item.display_name = cleanText(event.target.value) || found.item.display_name;
            commit();
          }
        });
        row.querySelector('[data-fmdw-li-qty]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.quantity = String(Math.max(0, Number(event.target.value || 0))); commit(); render(); }
        });
        row.querySelector('[data-fmdw-li-price]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.unit_price = Math.max(0, Number(event.target.value || 0)); commit(); render(); }
        });
        row.querySelector('[data-fmdw-li-remove]')?.addEventListener('click', () => {
          const found = findItem(items, id);
          if (found) { found.list.splice(found.list.indexOf(found.item), 1); commit(); render(); }
        });
      });
      el.querySelector('[data-fmdw-li-add]')?.addEventListener('click', () => {
        items.push(makeScopeItem({ name: 'New line item', display_name: 'New line item' }));
        commit();
        render();
      });
      el.querySelector('[data-fmdw-li-pricebook]')?.addEventListener('click', async () => {
        try {
          const picked = await services.pricebook.pick();
          if (arr(picked).length) { items = [...items, ...arr(picked).map(normalizeScopeItem)]; commit(); render(); }
        } catch (e) { /* cancelled */ }
      });
    };
    render();
    return { validate: () => requiredError(ctx) };
  });

  // ------------------------------------------------------------ piece picker


  // ------------------------------------------------------------ piece select
  // Native "What are we doing?" cards — the proposal piece-type vocabulary
  // (scope templates) sourced from services.pieceCatalog(). Writes the
  // selection (params.scope_pieces by convention) and derives
  // params.measurement_requirements — the measurement keys the selected
  // pieces' pricing formulas reference — so later steps (`when` conditions,
  // the measurements item) can condition on the selection BEFORE any line
  // items exist. Changing the selection clears previously generated
  // params.scope_items so the line-items step regenerates.
  const renderPieceSelectKind = (el, ctx) => {
    const services = obj(ctx.services);
    let catalog = null; // null = loading; [] = unavailable

    const selectionValue = () => arr(ctx.value()).map((p) => (typeof p === 'string' ? { template_id: p } : obj(p)));
    const selectedIds = () => selectionValue().map((p) => cleanText(p.template_id || p.id)).filter(Boolean);

    async function loadCatalog(){
      try {
        const raw = typeof services.pieceCatalog === 'function' ? await services.pieceCatalog() : null;
        catalog = arr(raw).map(obj).map((piece) => ({
          id: cleanText(piece.id || piece.template_id),
          name: firstText(piece.name, prettyKey(cleanText(piece.id || piece.template_id))),
          description: cleanText(piece.description),
          icon: firstText(piece.icon, 'fa-diagram-project'),
          color: cleanText(piece.color)
        })).filter((piece) => piece.id);
      } catch (e) { catalog = []; }
      if (el.isConnected) render();
    }

    async function deriveRequirements(selection){
      let keys = [];
      try {
        if (typeof services.measurementKeysForSelection === 'function') {
          keys = arr(await services.measurementKeysForSelection(selection)).map(cleanText).filter(Boolean);
        } else if (arr(selection).length && typeof services.generateScopeItems === 'function') {
          // Provisional generation (current measurements) just to read which
          // measurement keys the generated scope's pricing formulas reference.
          const provisional = arr(await services.generateScopeItems(clone(selection), obj(getPath(ctx.scope(), 'params.measurements'))));
          keys = scopeMeasurementKeys(provisional);
        }
      } catch (e) { keys = []; }
      ctx.writePath('params.measurement_requirements', keys);
    }

    async function toggle(pieceId){
      if (ctx.readonly) return;
      const multi = ctx.item.multi !== false && obj(ctx.item.presentation).multi !== false;
      const current = selectionValue();
      const exists = current.some((p) => cleanText(p.template_id || p.id) === pieceId);
      const meta = arr(catalog).find((p) => p.id === pieceId) || { id: pieceId, name: prettyKey(pieceId) };
      const next = exists
        ? current.filter((p) => cleanText(p.template_id || p.id) !== pieceId)
        : [...(multi ? current : []), {
            id: `piece_${pieceId}`,
            template_id: pieceId,
            name: meta.name,
            ...(meta.icon ? { icon: meta.icon } : {}),
            ...(meta.color ? { color: meta.color } : {})
          }];
      ctx.write(next);
      // Any previously generated items belong to the old selection.
      ctx.writePath('params.scope_items', []);
      render();
      await deriveRequirements(next);
      ctx.requestPreview();
    }

    function render(){
      const ids = selectedIds();
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          ${catalog === null
            ? `<p class="fmdw-hint"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_900d0404687053"," Loading project types…") ?? " Loading project types…")}</p>`
            : (catalog.length ? `
          <div class="fmdw-choice-grid fmdw-piece-grid">
            ${catalog.map((piece) => `
              <button type="button" class="fmdw-choice-card fmdw-piece-type ${ids.includes(piece.id) ? 'active' : ''}" data-fmdw-piece-type="${esc(piece.id)}" ${ctx.readonly ? 'disabled' : ''}${piece.color ? ` style="--fmdw-piece-color:${esc(piece.color)}"` : ''}>
                <span class="fmdw-piece-type-icon"><i class="fas ${esc(piece.icon)}"></i></span>
                <strong>${esc(piece.name)}</strong>
                ${piece.description ? `<small>${esc(piece.description)}</small>` : ''}
                <span class="fmdw-choice-tick"><i class="fas fa-check"></i></span>
              </button>`).join('')}
          </div>` : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0a1a27b7480d52","No project types are available in this session.") ?? "No project types are available in this session.")}</p>`)}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-piece-type]').forEach((button) => button.addEventListener('click', () => toggle(button.dataset.fmdwPieceType)));
    }

    render();
    loadCatalog();
    return { validate: () => (ctx.item.required && !selectionValue().length ? 'Choose at least one project type.' : null) };
  };
  registerKind('piece_select', renderPieceSelectKind);
  // Old seeded workflows still reference 'piece_picker' — they render the
  // SAME native cards. The legacy inline/modal scope builder is gone from
  // the workflow runtime entirely.
  registerKind('piece_picker', renderPieceSelectKind);

  // ------------------------------------------------------- line items review
  // Native generated-line-items list. On entry with an empty value it runs
  // the SAME generation the legacy proposal flow performs (piece scope
  // template + pricebook + measurements → root_items) via
  // services.generateScopeItems(selection, measurements), then lists EVERY
  // row: customer-optional rows flagged distinctly from fixed ones, inline
  // qty/unit-price edits recomputing totals, remove/add, plus a Regenerate
  // affordance. Writes the scope-item tree (params.scope_items).
  registerKind('line_items_review', (el, ctx) => {
    const services = obj(ctx.services);
    let items = arr(ctx.value()).map(normalizeScopeItem);
    let generating = false;
    let generateNote = '';
    const commit = () => ctx.write(clone(items));
    const selection = () => arr(getPath(ctx.scope(), cleanText(ctx.item.selection_from) || 'params.scope_pieces'));

    async function generate(){
      if (generating || ctx.readonly) return;
      if (typeof services.generateScopeItems !== 'function') {
        generateNote = 'Automatic generation is not available in this session — add rows manually or use the pricebook.';
        render();
        return;
      }
      if (!selection().length) {
        generateNote = 'Pick at least one project type on the first step to generate line items.';
        render();
        return;
      }
      generating = true;
      generateNote = '';
      render();
      try {
        const measurements = obj(getPath(ctx.scope(), 'params.measurements'));
        const roots = arr(await services.generateScopeItems(clone(selection()), clone(measurements))).map(normalizeScopeItem);
        if (roots.length) {
          items = roots;
          commit();
          ctx.requestPreview();
        } else {
          generateNote = 'Generation produced no line items — add rows manually or use the pricebook.';
        }
      } catch (e) {
        generateNote = 'Could not generate line items — add rows manually or use the pricebook.';
      }
      generating = false;
      if (el.isConnected) render();
    }

    function flagFor(item){
      const sel = obj(item.selection);
      const by = arr(sel.selectable_by).map(cleanText);
      const mode = cleanText(sel.mode);
      if (mode === 'optional' && by.includes('customer')) return `<span class="fmdw-li-flag optional">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_d02510a1664f87","Customer optional") ?? "Customer optional")}</span>`;
      if (mode === 'choice') return `<span class="fmdw-li-flag choice">${by.includes('customer') ? 'Customer choice' : 'Choice'}</span>`;
      if (item.included === true) return `<span class="fmdw-li-flag included">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f02be43cb91cd2","Included") ?? "Included")}</span>`;
      return '';
    }

    // Attached-media indicator: first image thumb, or a play glyph when only
    // a video is attached (see openMediaAttach for the item shape).
    function attachThumbHtml(item){
      const entry = obj(arr(item.media)[0]);
      const hasVideo = !!firstText(obj(item.video).url);
      let url = firstText(entry.url);
      const mediaId = firstText(entry.media_id);
      if (!url && mediaId && typeof obj(ctx.services).media?.url === 'function') {
        try { url = cleanText(obj(ctx.services).media.url(mediaId)); } catch (e) { url = ''; }
      }
      if (url) return `<span class="fmdw-li-thumb" title="${esc(entry.caption || 'Attached photo')}"><img src="${esc(url)}" alt=""></span>`;
      if (mediaId || hasVideo) return `<span class="fmdw-li-thumb video" title="${esc(hasVideo ? 'Attached video' : 'Attached photo')}"><i class="fas ${hasVideo ? 'fa-circle-play' : 'fa-image'}"></i></span>`;
      return '';
    }
    function hasAttachment(item){
      return arr(item.media).length > 0 || !!firstText(obj(item.video).url);
    }

    const render = () => {
      const rows = [];
      const pushRow = (item, depth) => {
        rows.push(`
          <div class="fmdw-li-row ${String(depth ? 'child' : '')}" data-fmdw-lir="${String(esc(item.id))}">
            <div class="fmdw-li-name">
              <span class="fmdw-li-name-line">
                ${String(attachThumbHtml(item))}
                <strong>${String(esc(firstText(item.display_name, item.name, 'Line item')))}</strong>
                ${String(flagFor(item))}
              </span>
              ${String(item.description ? `<small>${esc(item.description)}</small>` : '')}
            </div>
            <input class="fmdw-li-qty" type="number" step="any" min="0" data-fmdw-lir-qty value="${String(esc(item.quantity))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c689ddee2f502","Quantity") ?? "Quantity")}">
            <span class="fmdw-li-unit">${String(esc(item.unit || 'ea'))}</span>
            <input class="fmdw-li-price" type="number" step="0.01" min="0" data-fmdw-lir-price value="${String(esc(Number(item.unit_price || 0).toFixed(2)))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c68827ddeaf565","Unit price ($)") ?? "Unit price ($)")}">
            ${String(ctx.readonly ? '' : `<button type="button" class="fmdw-icon-btn ${hasAttachment(item) ? 'has-media' : ''}" data-fmdw-lir-attach title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_74c8aa88118d1c","Attach photo or video") ?? "Attach photo or video")}"><i class="fas fa-camera"></i></button>`)}
            ${String(ctx.readonly ? '' : `<button type="button" class="fmdw-icon-btn danger" data-fmdw-lir-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`)}
          </div>`);
        arr(item.children).forEach((child) => pushRow(child, depth + 1));
      };
      items.forEach((item) => pushRow(item, 0));
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions" style="margin-bottom:2px">
                <button type="button" class="fmdw-btn ${String(rows.length ? '' : 'primary')}" data-fmdw-lir-generate ${String(generating ? 'disabled' : '')}>
                  <i class="fas ${String(generating ? 'fa-circle-notch fa-spin' : 'fa-rotate')}"></i> ${String(generating ? 'Generating…' : (rows.length ? 'Regenerate' : 'Generate line items'))}
                </button>
                ${String(services.pricebook && typeof services.pricebook.pick === 'function' ? `<button type="button" class="fmdw-btn" data-fmdw-lir-pricebook><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c38fcf1b64a2ea"," Pricebook") ?? " Pricebook")}</button>` : '')}
                <button type="button" class="fmdw-btn" data-fmdw-lir-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8e13db264d4c9f"," Add row") ?? " Add row")}</button>
              </div>`}
            ${generateNote ? `<p class="fmdw-hint"><i class="fas fa-circle-info"></i> ${esc(generateNote)}</p>` : ''}
            <div class="fmdw-li-list">
              ${rows.length ? rows.join('') : (generating ? `<p class="fmdw-hint"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2b766d3ceb94da"," Generating line items…") ?? " Generating line items…")}</p>` : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0b854052709977","No line items yet.") ?? "No line items yet.")}</p>`)}
            </div>
            ${rows.length ? `<div class="fmdw-li-total"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9403c7637d4905","Total") ?? "Total")}</span><b data-fmdw-lir-total>${String(esc(moneyFromDollars(scopeItemsTotal(items))))}</b></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const findItem = (list, id) => {
        for (const item of arr(list)) {
          if (item.id === id) return { item, list };
          const found = findItem(item.children, id);
          if (found) return found;
        }
        return null;
      };
      el.querySelectorAll('[data-fmdw-lir]').forEach((row) => {
        const id = row.dataset.fmdwLir;
        row.querySelector('[data-fmdw-lir-qty]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.quantity = String(Math.max(0, Number(event.target.value || 0))); commit(); render(); ctx.requestPreview(); }
        });
        row.querySelector('[data-fmdw-lir-price]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.unit_price = Math.max(0, Number(event.target.value || 0)); commit(); render(); ctx.requestPreview(); }
        });
        row.querySelector('[data-fmdw-lir-remove]')?.addEventListener('click', () => {
          const found = findItem(items, id);
          if (found) { found.list.splice(found.list.indexOf(found.item), 1); commit(); render(); ctx.requestPreview(); }
        });
        row.querySelector('[data-fmdw-lir-attach]')?.addEventListener('click', (event) => {
          const found = findItem(items, id);
          if (!found) return;
          openMediaAttach({
            anchor: event.currentTarget,
            item: found.item,
            services,
            onSave: (patch) => {
              found.item.media = arr(obj(patch).media);
              found.item.video = obj(patch).video && firstText(obj(obj(patch).video).url) ? obj(patch).video : null;
              found.item.display = cleanText(obj(patch).display) === 'popup' ? 'popup' : 'inline';
              commit();
              render();
              ctx.requestPreview();
            }
          });
        });
      });
      el.querySelector('[data-fmdw-lir-generate]')?.addEventListener('click', () => generate());
      el.querySelector('[data-fmdw-lir-add]')?.addEventListener('click', () => {
        items.push(makeScopeItem({ name: 'New line item', display_name: 'New line item' }));
        commit();
        render();
      });
      el.querySelector('[data-fmdw-lir-pricebook]')?.addEventListener('click', async () => {
        try {
          const picked = await services.pricebook.pick();
          if (arr(picked).length) { items = [...items, ...arr(picked).map(normalizeScopeItem)]; commit(); render(); ctx.requestPreview(); }
        } catch (e) { /* cancelled */ }
      });
    };

    render();
    // Auto-generate on entry when nothing has been generated yet.
    if (!countScopeItems(items)) generate();
    return { validate: () => (ctx.item.required && !countScopeItems(arr(ctx.value())) ? 'Generate or add at least one line item.' : null) };
  });

  // ----------------------------------------------------------------- review
  registerKind('review', (el, ctx) => {
    const workflow = ctx.workflow;
    const rows = [];
    arr(workflow.steps).forEach((step) => {
      arr(obj(step).items).forEach((item) => {
        const kind = cleanText(obj(item).kind);
        if (kind === 'review') return;
        const writes = cleanText(obj(item).writes);
        if (!writes) return;
        const hiddenHere = !stepVisibleFor(obj(step), ctx.audience, workflow) || !itemVisibleFor(obj(item), ctx.audience);
        rows.push({
          label: itemLabel(obj(item)),
          value: formatValue(obj(item), getPath(ctx.scope(), writes)),
          hidden: hiddenHere
        });
      });
    });
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item) === 'Field' ? 'Review' : itemLabel(ctx.item))}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        <div class="fmdw-card fmdw-review">
          ${rows.length ? rows.map((row) => `
            <div class="fmdw-review-row ${row.hidden ? 'muted' : ''}">
              <span>${esc(row.label)}${row.hidden ? ` <em>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b355543c278b0d","(set by your project team)") ?? "(set by your project team)")}</em>` : ''}</span>
              <b>${esc(row.value)}</b>
            </div>`).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c36246dea049d6","Nothing has been filled in yet.") ?? "Nothing has been filled in yet.")}</p>`}
        </div>
        ${ctx.hasPreview ? `<p class="fmdw-hint"><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_eff08b0fc06db7"," The live preview shows the finished document with these answers.") ?? " The live preview shows the finished document with these answers.")}</p>` : ''}
      </div>`;
    return {};
  });

  // ------------------------------------------------------ signature / payment
  function outputKeyFor(item, fallback){
    const writes = cleanText(obj(item).writes);
    if (writes.startsWith('outputs.')) return writes.slice('outputs.'.length);
    return firstText(obj(item).output_key, fallback);
  }
  function widgetContext(ctx, config, refresh){
    return {
      node: { id: uid('fmdw_widget'), type: 'widget', props: { widget: '', config } },
      config,
      data: null,
      mode: ctx.readonly ? 'static' : 'interactive',
      scope: ctx.scope(),
      themeVars: {},
      skin: {},
      outputs: obj(getPath(ctx.scope(), 'outputs')),
      api: obj(ctx.services).api || {},
      submitOutput: (key, value) => {
        ctx.writePath(`outputs.${key}`, value);
        ctx.requestPreview();
      },
      refresh: () => { try { refresh(); } catch (e) {} }
    };
  }
  function statusCardHtml(icon, title, sub, done){
    return `
      <div class="fmdw-card fmdw-status-card ${done ? 'done' : ''}">
        <span class="fmdw-status-icon"><i class="fas ${icon}"></i></span>
        <div class="fmdw-piece-copy"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      </div>`;
  }

  // Server-generated document (receipt / follow-up): the backend mints the
  // configured document when this step completes and records its ref at the
  // item's outputs.* path — this card just reflects that state.
  registerKind('generate_document', (el, ctx) => {
    function draw(){
      const current = obj(ctx.value());
      const config = obj(ctx.item.config);
      const label = firstText(ctx.item.label, config.title, 'Generated document');
      if (cleanText(current.document_id)) {
        const canOpen = typeof obj(ctx.services).openDocument === 'function' && ctx.audience !== 'customer';
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${String(esc(label))}</span>
            <div class="fmdw-gen-doc done">
              <i class="fas fa-file-circle-check"></i>
              <span class="fmdw-gen-doc-copy"><strong>${String(esc(firstText(current.title, label)))}</strong><small>${((v2) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_7cda0ae68e2436",`Generated ${v2}`,{v2}) ?? `Generated ${v2}`)(esc(cleanText(current.generated_at).slice(0, 10)))}</small></span>
              ${String(canOpen ? `<button type="button" class="fmdw-gen-doc-open" data-fmdw-gen-open>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c25cc66b28cc9d","Open") ?? "Open")}</button>` : '')}
            </div>
          </div>`;
        el.querySelector('[data-fmdw-gen-open]')?.addEventListener('click', () => {
          try { obj(ctx.services).openDocument(cleanText(current.document_id)); } catch (e) { /* host handles */ }
        });
      } else {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${String(esc(label))}</span>
            <div class="fmdw-gen-doc pending">
              <i class="fas fa-file-circle-plus"></i>
              <span class="fmdw-gen-doc-copy"><strong>${String(esc(firstText(config.title, label)))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_3aae9c62ecf927","Created automatically when this step is completed.") ?? "Created automatically when this step is completed.")}</small></span>
            </div>
          </div>`;
      }
    }
    draw();
    return { validate: () => null };
  });

  registerKind('signature', (el, ctx) => {
    const key = outputKeyFor(ctx.item, 'sig_customer');
    const render = () => {
      const value = obj(getPath(ctx.scope(), `outputs.${key}`));
      const signed = !!firstText(value.signer_name, value.text, value.image_data);
      if (!['customer', 'field'].includes(ctx.audience) || ctx.readonly) {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
            ${statusCardHtml('fa-signature', signed ? `Signed by ${firstText(value.signer_name, 'customer')}` : 'Awaiting customer signature', signed ? cleanText(value.signed_at).slice(0, 10) : 'The customer signs from their portal.', signed)}
            <span class="fmdw-field-error" data-fmdw-error hidden></span>
          </div>`;
        return;
      }
      const widget = root.FMDocWidgets?.get?.('doc.signature', 1);
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card"><div class="fmdw-widget-host" data-fmdw-widget></div></div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const host = el.querySelector('[data-fmdw-widget]');
      if (widget?.renderInteractive) {
        try {
          widget.renderInteractive(host, widgetContext(ctx, { label: itemLabel(ctx.item), output_key: key, signer: 'customer' }, render));
          return;
        } catch (e) { /* fall through to the fallback card */ }
      }
      host.outerHTML = statusCardHtml('fa-signature', signed ? `Signed by ${firstText(value.signer_name, 'you')}` : 'Signature required', signed ? '' : 'Open the document view to sign.', signed);
    };
    render();
    return {
      validate: () => {
        if (!ctx.item.required) return null;
        const value = obj(getPath(ctx.scope(), `outputs.${key}`));
        return firstText(value.signer_name, value.text, value.image_data) ? null : 'A signature is required before continuing.';
      }
    };
  });

  registerKind('payment', (el, ctx) => {
    const key = outputKeyFor(ctx.item, 'payment');
    const render = () => {
      const value = getPath(ctx.scope(), `outputs.${key}`);
      const paymentValue = obj(value);
      const paid = !isEmptyValue(value) && !!firstText(paymentValue.payment_method, paymentValue.method, obj(paymentValue.checkout).payment_method);
      if (!['customer', 'field'].includes(ctx.audience) || ctx.readonly) {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
            ${statusCardHtml('fa-credit-card', paid ? 'Payment received' : 'Awaiting payment', paid ? '' : 'The customer pays from their portal.', paid)}
            <span class="fmdw-field-error" data-fmdw-error hidden></span>
          </div>`;
        return;
      }
      const widget = root.FMDocWidgets?.get?.('doc.pay_now', 1);
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card"><div class="fmdw-widget-host" data-fmdw-widget></div></div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const host = el.querySelector('[data-fmdw-widget]');
      if (widget?.renderInteractive) {
        try {
          const config = { ...obj(ctx.item.config), label: itemLabel(ctx.item), output_key: key };
          const source = cleanText(config.source || ctx.item.amount_from);
          const scopedAmount = source
            ? getPath(ctx.scope(), source)
            : getPath(ctx.scope(), key === 'final_payment' ? 'params.final_payment_cents' : 'params.deposit_cents');
          if (scopedAmount !== undefined && scopedAmount !== null && scopedAmount !== '') config.amount_cents = Number(scopedAmount) || 0;
          widget.renderInteractive(host, widgetContext(ctx, config, render));
          return;
        } catch (e) { /* fall through */ }
      }
      host.outerHTML = statusCardHtml('fa-credit-card', paid ? 'Payment received' : 'Payment', paid ? '' : 'Payment can be completed from the document view.', paid);
    };
    render();
    return {
      validate: () => (ctx.item.required && isEmptyValue(getPath(ctx.scope(), `outputs.${key}`)) ? 'Payment is required before continuing.' : null)
    };
  });

  // ============================================================= mount
  function mount(container, options = {}){
    if (!container) throw new Error('FMDocWorkflow.mount: container is required');
    ensureStyles();

    const opts = obj(options);
    const workflow = obj(opts.workflow);
    const requestedAudience = cleanText(opts.audience);
    const audience = ['customer', 'field'].includes(requestedAudience) ? requestedAudience : 'internal';
    const contract = obj(opts.contract && Object.keys(obj(opts.contract)).length ? opts.contract : workflow.contract);
    const services = obj(opts.services);
    const preview = opts.preview && typeof obj(opts.preview).resolve === 'function' ? obj(opts.preview) : null;
    const extraScope = obj(opts.scope);
    const theme = firstText(opts.theme, obj(obj(workflow.audiences)[audience]).theme);
    const showWorkflowTitle = opts.showWorkflowTitle !== false;

    const st = {
      params: obj(clone(obj(opts.state).params)),
      outputs: obj(clone(obj(opts.state).outputs)),
      completed: new Set(arr(obj(opts.state).completed_steps).map(cleanText).filter(Boolean)),
      currentId: cleanText(obj(opts.state).current_step),
      destroyed: false,
      itemHandles: [],
      previewTimer: 0,
      previewBusy: false,
      previewHandle: null,
      previewStale: false
    };

    function scope(){
      return { params: st.params, outputs: st.outputs, contract, ...extraScope };
    }

    function visibleSteps(){
      const sc = scope();
      return arr(workflow.steps)
        .map(obj)
        .filter((step) => cleanText(step.id))
        .filter((step) => stepVisibleFor(step, audience, workflow))
        .filter((step) => whenPasses(step.when, sc));
    }

    function stepItems(step){
      const sc = scope();
      // A step may itself be `{kind:"review"}` sugar with no items array.
      const sectionItems = arr(step.sections)
        .map(obj)
        .filter((section) => itemVisibleFor(section, audience))
        .filter((section) => whenPasses(section.when, sc))
        .flatMap((section) => arr(section.items));
      const items = sectionItems.length ? sectionItems : (arr(step.items).length ? arr(step.items) : (cleanText(step.kind) ? [{ kind: step.kind, ...obj(step.item) }] : []));
      return items.map(obj).filter((item) => itemVisibleFor(item, audience)).filter((item) => whenPasses(item.when, sc));
    }

    function stepSections(step){
      const sc = scope();
      const sections = arr(step.sections).map(obj).filter((section) => itemVisibleFor(section, audience)).filter((section) => whenPasses(section.when, sc));
      if (sections.length) return sections.map((section) => ({ ...section, items: arr(section.items).map(obj).filter((item) => itemVisibleFor(item, audience)).filter((item) => whenPasses(item.when, sc)) }));
      return [{ id: `${cleanText(step.id)}_default`, title: '', items: stepItems(step), legacy: true }];
    }

    // Step-level `auto_skip_when_complete: true`: when FORWARD navigation
    // lands on the step and every answerable item already holds a complete
    // answer, the step is skipped (marked done). Manual entry — a rail click
    // or Back — always enters the step, even when it is complete.
    function stepAutoSkips(step, sc){
      if (obj(step).auto_skip_when_complete !== true) return false;
      const items = stepItems(step).filter((item) => !['review', 'signature', 'payment'].includes(cleanText(item.kind)));
      if (!items.length) return false;
      return items.every((item) => itemAnswered(item, sc));
    }

    function currentIndex(steps){
      const index = steps.findIndex((step) => cleanText(step.id) === st.currentId);
      if (index >= 0) return index;
      // Default: first step not yet completed.
      const firstOpen = steps.findIndex((step) => !st.completed.has(cleanText(step.id)));
      return firstOpen >= 0 ? firstOpen : Math.max(0, steps.length - 1);
    }

    // Index of the first step that may NOT be jumped to: everything after the
    // first incomplete step (you can revisit done steps + the next open one).
    function firstLockedIndex(steps){
      for (let i = 0; i < steps.length; i += 1) {
        if (!st.completed.has(cleanText(steps[i].id))) return i + 1;
      }
      return steps.length;
    }

    // ------------------------------------------------------------- writes
    function allowedWrite(path){
      if (audience !== 'customer') return true;
      return cleanText(path).startsWith('outputs.');
    }
    function writePath(path, value){
      const target = cleanText(path);
      if (!target || !allowedWrite(target)) return false;
      if (target.startsWith('params.')) setPath(st.params, target.slice('params.'.length), clone(value));
      else if (target.startsWith('outputs.')) setPath(st.outputs, target.slice('outputs.'.length), clone(value));
      else setPath(st.params, target, clone(value));
      try { opts.onWrite?.(target, clone(value)); } catch (e) { console.warn('FMDocWorkflow onWrite failed', e); }
      schedulePreview();
      updateRail();
      return true;
    }

    function emitStepState(){
      const payload = { current_step: st.currentId, completed_steps: [...st.completed] };
      try { opts.onStepState?.(payload); } catch (e) { /* host issue */ }
      try { opts.onStepChange?.(payload); } catch (e) { /* legacy alias */ }
    }

    // -------------------------------------------------------------- layout
    container.innerHTML = `
      <div class="fmdw ${String(theme === 'portal' ? 'fmdw-portal' : '')} ${String(preview ? 'has-preview' : '')}" data-fmdw-root>
        <aside class="fmdw-rail">
          <div class="fmdw-rail-head ${String(showWorkflowTitle ? '' : 'titleless')}">
            ${String(showWorkflowTitle ? `<strong>${esc(firstText(workflow.name, 'Workflow'))}</strong>` : '')}
            <span data-fmdw-rail-sub></span>
          </div>
          <nav class="fmdw-steps" data-fmdw-steps></nav>
        </aside>
        <section class="fmdw-main">
          <header class="fmdw-step-head" data-fmdw-step-head></header>
          <div class="fmdw-items" data-fmdw-items></div>
          <footer class="fmdw-foot">
            <button type="button" class="fmdw-btn" data-fmdw-back><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c5b830c019950"," Previous") ?? " Previous")}</button>
            <span class="fmdw-foot-note" data-fmdw-foot-note></span>
            <button type="button" class="fmdw-btn primary" data-fmdw-continue>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_854c72abba5166","Continue ") ?? "Continue ")}<i class="fas fa-arrow-right"></i></button>
          </footer>
        </section>
        ${String(preview ? `
        <aside class="fmdw-preview" data-fmdw-preview>
          <div class="fmdw-preview-head" data-fmdw-preview-head>
            <strong><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_a979f59edfcd90"," Live preview") ?? " Live preview")}</strong>
            <div class="fmdw-preview-zoom">
              <button type="button" class="fmdw-icon-btn" data-fmdw-zoom-out title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_acf282d479dddf","Zoom out") ?? "Zoom out")}"><i class="fas fa-magnifying-glass-minus"></i></button>
              <button type="button" class="fmdw-zoom-pct" data-fmdw-zoom-fit title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b4e9fa5595e7cf","Fit width") ?? "Fit width")}" data-fmdw-zoom-pct>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2d8510904d5879","Fit") ?? "Fit")}</button>
              <button type="button" class="fmdw-icon-btn" data-fmdw-zoom-in title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_a593d968057ce9","Zoom in") ?? "Zoom in")}"><i class="fas fa-magnifying-glass-plus"></i></button>
              <button type="button" class="fmdw-icon-btn" data-fmdw-preview-refresh title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_acf1841e689f24","Refresh preview") ?? "Refresh preview")}"><i class="fas fa-rotate"></i></button>
            </div>
          </div>
          <div class="fmdw-preview-stage" data-fmdw-preview-stage>
            <div class="fmdw-preview-empty"><i class="fas fa-file-lines"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_cec49be42c7614","The preview updates as you answer.") ?? "The preview updates as you answer.")}</span></div>
          </div>
        </aside>` : '')}
      </div>`;

    const el = {
      root: container.querySelector('[data-fmdw-root]'),
      railSub: container.querySelector('[data-fmdw-rail-sub]'),
      steps: container.querySelector('[data-fmdw-steps]'),
      stepHead: container.querySelector('[data-fmdw-step-head]'),
      items: container.querySelector('[data-fmdw-items]'),
      back: container.querySelector('[data-fmdw-back]'),
      cont: container.querySelector('[data-fmdw-continue]'),
      footNote: container.querySelector('[data-fmdw-foot-note]'),
      preview: container.querySelector('[data-fmdw-preview]'),
      previewStage: container.querySelector('[data-fmdw-preview-stage]')
    };

    // ---------------------------------------------------------------- rail
    function updateRail(){
      if (st.destroyed) return;
      const steps = visibleSteps();
      const index = currentIndex(steps);
      const lockedFrom = firstLockedIndex(steps);
      st.currentId = cleanText(obj(steps[index]).id);
      el.railSub.textContent = steps.length ? `Step ${index + 1} of ${steps.length}` : 'No steps';
      el.steps.innerHTML = steps.map((step, i) => {
        const id = cleanText(step.id);
        const done = st.completed.has(id);
        const current = i === index;
        const locked = !done && !current && i >= lockedFrom;
        return `
          <button type="button" class="fmdw-step ${current ? 'current' : ''} ${done ? 'done' : ''} ${locked ? 'locked' : ''}" data-fmdw-step="${esc(id)}" ${locked ? 'disabled' : ''}>
            <span class="fmdw-step-dot">${done && !current ? '<i class="fas fa-check"></i>' : (locked ? '<i class="fas fa-lock"></i>' : i + 1)}</span>
            <span class="fmdw-step-title">${esc(firstText(step.navigation_title, step.short_title, step.title, prettyKey(id)))}</span>
          </button>`;
      }).join('');
      el.steps.querySelectorAll('[data-fmdw-step]').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.fmdwStep)));
    }

    // --------------------------------------------------------------- items
    function destroyItemHandles(){
      st.itemHandles.forEach((entry) => { try { entry.handle?.destroy?.(); } catch (e) {} });
      st.itemHandles = [];
    }

    function renderStep(){
      if (st.destroyed) return;
      const steps = visibleSteps();
      if (!steps.length) {
        el.stepHead.innerHTML = `<h2>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_cdf312ca4a3b4e","Nothing to fill in") ?? "Nothing to fill in")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_44399b69b88f2d","This workflow has no steps for you right now.") ?? "This workflow has no steps for you right now.")}</p>`;
        el.items.innerHTML = `<div class="fmdw-empty"><i class="fas fa-circle-check"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b4700fabfa5e9b","You are all set.") ?? "You are all set.")}</span></div>`;
        el.back.hidden = true;
        el.cont.hidden = true;
        return;
      }
      const index = currentIndex(steps);
      const step = steps[index];
      st.currentId = cleanText(step.id);
      destroyItemHandles();
      el.stepHead.innerHTML = `
        <h2>${esc(firstText(step.title, prettyKey(step.id)))}</h2>
        ${cleanText(step.description) ? `<p>${esc(step.description)}</p>` : ''}`;
      el.items.innerHTML = '';
      el.footNote.textContent = '';
      const sections = stepSections(step);
      const items = sections.flatMap((section) => arr(section.items));
      if (!items.length) {
        el.items.innerHTML = `<div class="fmdw-empty"><i class="fas fa-circle-info"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8a8fecd55b2bdc","Nothing to answer on this step.") ?? "Nothing to answer on this step.")}</span></div>`;
      }
      const renderItem = (item, parent) => {
        const holder = document.createElement('div');
        const itemTransition = obj(obj(item.presentation).transition);
        holder.className = `fmdw-item fmdw-enter-${firstText(itemTransition.type, 'fade').replace(/[^a-z-]/gi, '')}`;
        holder.style.setProperty('--fmdw-enter-ms', `${Math.max(0, Number(itemTransition.duration_ms || 180))}ms`);
        if (item.disabled === true) {
          holder.classList.add('fmdw-capability-disabled');
          holder.setAttribute('aria-disabled', 'true');
          holder.setAttribute('data-disabled-reason', firstText(item.disabled_reason, 'This feature is disabled for this organization.'));
        }
        parent.appendChild(holder);
        const renderer = kindRegistry.get(cleanText(item.kind));
        const readonly = item.disabled === true || opts.readonly === true || !allowedWrite(cleanText(item.writes) || 'params._');
        const ctx = {
          item,
          step,
          audience,
          readonly,
          disabled: item.disabled === true,
          workflow,
          services,
          hasPreview: !!preview,
          scope,
          value: () => getPath(scope(), cleanText(item.writes)),
          write: (value) => writePath(cleanText(item.writes), value),
          writePath,
          options: () => resolveOptions(item, scope(), services),
          requestPreview: () => schedulePreview(),
          // Advance the stepper (validation still applies) — used by kinds
          // whose embedded flow finishing means "this step is done".
          next: () => goNext(),
          helpers: { esc, cleanText, moneyFromCents, moneyFromDollars, prettyKey, clone }
        };
        if (!renderer) {
          holder.innerHTML = `<div class="fmdw-card"><p class="fmdw-hint"><i class="fas fa-puzzle-piece"></i>${((v0) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2060888166e53b",` This question type ("${v0}") is not supported in this view.`,{v0}) ?? ` This question type ("${v0}") is not supported in this view.`)(esc(item.kind))}</p></div>`;
          st.itemHandles.push({ item, el: holder, handle: {} });
          return;
        }
        let handle = {};
        try { handle = obj(renderer(holder, ctx)); }
        catch (error) {
          console.warn('FMDocWorkflow kind renderer failed', item.kind, error);
          holder.innerHTML = `<div class="fmdw-card"><p class="fmdw-hint"><i class="fas fa-triangle-exclamation"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_63c83caf528f7c"," This question could not be displayed.") ?? " This question could not be displayed.")}</p></div>`;
        }
        st.itemHandles.push({ item, el: holder, ctx, handle });
      };
      sections.forEach((section) => {
        const sectionEl = document.createElement('section');
        const transition = obj(section.transition);
        sectionEl.className = `fmdw-section fmdw-enter-${esc(firstText(transition.type, section.legacy ? 'none' : 'grow'))}`;
        sectionEl.style.setProperty('--fmdw-enter-ms', `${Math.max(0, Number(transition.duration_ms || 220))}ms`);
        const background = firstText(obj(section.style).background);
        if (background) sectionEl.style.background = background;
        if (cleanText(section.title)) sectionEl.innerHTML = `<h3>${esc(section.title)}</h3>${cleanText(section.description) ? `<p>${esc(section.description)}</p>` : ''}`;
        const body = document.createElement('div'); body.className = 'fmdw-section-items'; sectionEl.appendChild(body); el.items.appendChild(sectionEl);
        arr(section.items).forEach((item) => renderItem(item, body));
      });
      // Footer
      const isLast = index >= steps.length - 1;
      el.back.hidden = index === 0;
      el.cont.hidden = false;
      el.cont.innerHTML = isLast
        ? `${esc(firstText(obj(opts.labels).finish, 'Submit'))} <i class="fas fa-check"></i>`
        : `${esc(firstText(obj(opts.labels).continue, 'Next'))} <i class="fas fa-arrow-right"></i>`;
      updateRail();
      // Scroll the pane back to the top on step change.
      try { el.items.scrollTop = 0; } catch (e) {}
    }

    function validateCurrentStep(){
      let firstError = null;
      st.itemHandles.forEach((entry) => {
        let message = null;
        try { message = obj(entry.item).disabled !== true && entry.handle?.validate ? entry.handle.validate() : null; } catch (e) { message = null; }
        if (!message && entry.ctx && obj(entry.item).required && obj(entry.item).disabled !== true && isEmptyValue(entry.ctx.value())) {
          const kind = cleanText(entry.item.kind);
          if (!['review', 'signature', 'payment'].includes(kind)) message = 'This field is required.';
        }
        const errorEl = entry.el.querySelector('[data-fmdw-error]');
        if (errorEl) {
          errorEl.hidden = !message;
          errorEl.textContent = message || '';
        }
        entry.el.classList.toggle('invalid', !!message);
        if (message && !firstError) firstError = entry;
      });
      if (firstError) {
        try { firstError.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        el.footNote.textContent = (globalThis.PlatformLanguage?.text("doc-workflow","m_252c511fd2c95b","Fill in the highlighted fields to continue.") ?? "Fill in the highlighted fields to continue.");
      } else {
        el.footNote.textContent = '';
      }
      return !firstError;
    }

    function goNext(){
      if (!validateCurrentStep()) return;
      let steps = visibleSteps();
      const index = currentIndex(steps);
      const step = steps[index];
      st.completed.add(cleanText(step.id));
      // Recompute: completing this step's writes may reveal `when` steps.
      steps = visibleSteps();
      let nextIndex = steps.findIndex((s) => cleanText(s.id) === cleanText(step.id)) + 1;
      if (nextIndex <= 0) nextIndex = index + 1;
      // Skip past auto_skip_when_complete steps that are already answered.
      const sc = scope();
      while (nextIndex < steps.length && stepAutoSkips(steps[nextIndex], sc)) {
        st.completed.add(cleanText(steps[nextIndex].id));
        nextIndex += 1;
      }
      if (nextIndex >= steps.length) {
        emitStepState();
        try { opts.onComplete?.({ params: clone(st.params), outputs: clone(st.outputs) }); } catch (e) { console.warn('FMDocWorkflow onComplete failed', e); }
        return;
      }
      st.currentId = cleanText(steps[nextIndex].id);
      emitStepState();
      renderStep();
    }
    function goBack(){
      const steps = visibleSteps();
      const index = currentIndex(steps);
      if (index <= 0) return;
      st.currentId = cleanText(steps[index - 1].id);
      emitStepState();
      renderStep();
    }
    function goTo(stepId){
      const steps = visibleSteps();
      const target = steps.find((step) => cleanText(step.id) === cleanText(stepId));
      if (!target) return;
      const targetIndex = steps.indexOf(target);
      const lockedFrom = firstLockedIndex(steps);
      if (targetIndex >= lockedFrom && !st.completed.has(cleanText(target.id)) && audience === 'internal') return; // customer + field task links may jump directly
      st.currentId = cleanText(target.id);
      emitStepState();
      renderStep();
    }

    el.back?.addEventListener('click', goBack);
    el.cont?.addEventListener('click', goNext);

    // -------------------------------------------------------------- preview
    function schedulePreview(){
      if (!preview || st.destroyed) return;
      clearTimeout(st.previewTimer);
      st.previewTimer = setTimeout(() => refreshPreview(), 700);
    }
    async function refreshPreview(){
      if (!preview || st.destroyed) return;
      if (st.previewBusy) { st.previewStale = true; return; }
      st.previewBusy = true;
      el.preview?.classList.add('loading');
      try {
        const resolved = obj(await preview.resolve());
        if (st.destroyed) return;
        renderPreview(resolved);
      } catch (error) {
        if (!st.destroyed) renderPreviewUnavailable();
      } finally {
        st.previewBusy = false;
        el.preview?.classList.remove('loading');
        if (st.previewStale && !st.destroyed) { st.previewStale = false; schedulePreview(); }
      }
    }
    function renderPreviewUnavailable(){
      if (!el.previewStage) return;
      try { st.previewHandle?.destroy?.(); } catch (e) {}
      st.previewHandle = null;
      el.previewStage.innerHTML = `<div class="fmdw-preview-empty"><i class="fas fa-eye-slash"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_4478f7b14b3b0c","Preview unavailable right now.") ?? "Preview unavailable right now.")}</span></div>`;
    }
    function previewFitScale(definition){
      const dims = root.FMDocModel?.paperDimensions?.(definition) || { w_pt: 612 };
      const available = Math.max(240, (el.previewStage?.clientWidth || 266) - 26);
      return Math.min(1, available / (dims.w_pt * (96 / 72)));
    }
    function previewScale(definition){
      return st.previewZoom > 0 ? st.previewZoom : previewFitScale(definition);
    }
    function syncZoomLabel(scale){
      const label = el.preview?.querySelector('[data-fmdw-zoom-pct]');
      if (label) label.textContent = st.previewZoom > 0 ? `${Math.round(scale * 100)}%` : 'Fit';
    }
    function renderPreview(resolved){
      if (!el.previewStage) return;
      st.lastResolved = resolved; // zoom changes retransform without re-resolving
      if (typeof preview.mount === 'function') {
        try { preview.mount(el.previewStage, resolved); return; } catch (e) { /* fall through */ }
      }
      const renderer = root.FMDocRenderer;
      const definition = obj(resolved.resolved_definition || resolved.definition);
      if (!renderer?.render || (!arr(definition.pages).length && !definition.root)) { renderPreviewUnavailable(); return; }
      try { st.previewHandle?.destroy?.(); } catch (e) {}
      st.previewHandle = null;
      el.previewStage.innerHTML = '';
      try {
        const scale = previewScale(definition);
        st.previewHandle = renderer.render(el.previewStage, {
          document: definition,
          theme: resolved.theme || null,
          // Server-resolved theme_vars carry org branding the client can't
          // see — pass them as overrides so preview colors match the PDF.
          themeContext: { ...obj(resolved.theme_context || resolved.themeContext), overrides: { ...obj(obj(resolved.theme_context || resolved.themeContext).overrides), ...obj(resolved.theme_vars) } },
          mode: 'static',
          widgetData: obj(resolved.widget_data || resolved.widgetData),
          scale
        });
        syncZoomLabel(scale);
      } catch (error) {
        renderPreviewUnavailable();
      }
    }
    /** Zoom without re-resolving: retransform the live handle (renderer fast
     *  path) or re-render the cached payload. */
    function applyPreviewZoom(){
      const resolved = obj(st.lastResolved);
      const definition = obj(resolved.resolved_definition || resolved.definition);
      const scale = previewScale(definition);
      if (st.previewHandle?.setScale) {
        try { st.previewHandle.setScale(scale); syncZoomLabel(scale); return; } catch (e) { /* re-render below */ }
      }
      if (st.lastResolved) renderPreview(st.lastResolved);
    }
    el.preview?.querySelector('[data-fmdw-preview-refresh]')?.addEventListener('click', () => refreshPreview());
    el.preview?.querySelector('[data-fmdw-zoom-in]')?.addEventListener('click', () => {
      const current = st.previewZoom > 0 ? st.previewZoom : previewFitScale(obj(obj(st.lastResolved).resolved_definition));
      st.previewZoom = Math.min(2, Math.round((current + 0.15) * 100) / 100);
      applyPreviewZoom();
    });
    el.preview?.querySelector('[data-fmdw-zoom-out]')?.addEventListener('click', () => {
      const current = st.previewZoom > 0 ? st.previewZoom : previewFitScale(obj(obj(st.lastResolved).resolved_definition));
      st.previewZoom = Math.max(0.25, Math.round((current - 0.15) * 100) / 100);
      applyPreviewZoom();
    });
    el.preview?.querySelector('[data-fmdw-zoom-fit]')?.addEventListener('click', () => {
      st.previewZoom = 0;
      applyPreviewZoom();
    });

    // ----------------------------------------------------------------- boot
    renderStep();
    if (preview) refreshPreview();

    const handle = {
      destroy(){
        if (st.destroyed) return;
        st.destroyed = true;
        clearTimeout(st.previewTimer);
        destroyItemHandles();
        try { st.previewHandle?.destroy?.(); } catch (e) {}
        container.innerHTML = '';
      },
      goTo,
      next: goNext,
      back: goBack,
      refresh(nextState){
        const next = obj(nextState);
        if (next.params) st.params = obj(clone(next.params));
        if (next.outputs) st.outputs = obj(clone(next.outputs));
        if (next.completed_steps) st.completed = new Set(arr(next.completed_steps).map(cleanText).filter(Boolean));
        if (cleanText(next.current_step)) st.currentId = cleanText(next.current_step);
        renderStep();
        schedulePreview();
      },
      state(){
        return { params: clone(st.params), outputs: clone(st.outputs), current_step: st.currentId, completed_steps: [...st.completed] };
      },
      /** Force a preview re-resolve now (hosts call this after out-of-band
       *  document changes: theme switch, Data-panel saves, etc.). */
      refreshPreview(){
        if (preview && !st.destroyed) refreshPreview();
      }
    };
    return handle;
  }

  // =============================================================== styles
  const CSS = `
/* FMDocWorkflow runtime (self-injected). Visual language mirrors
   documents.css / customer_portal.css: neutral grays, --primary accents. */
.fmdw{--fmdw-primary:var(--cp-primary,var(--fm-primary,var(--primary,#2563EB)));--fmdw-on-primary:var(--cp-on-primary,var(--fmdx-on-primary,#fff));--fmdw-ink:#111827;--fmdw-muted:#667085;--fmdw-line:#e4e7ec;--fmdw-bg:#f8fafc;--fmdw-card:#fff;
  display:flex;align-items:stretch;width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--fmdw-bg);color:var(--fmdw-ink);font-family:inherit}
.fmdw,.fmdw *,.fmdw *::before,.fmdw *::after{box-sizing:border-box}
/* rail */
.fmdw-rail{flex:none;width:230px;min-width:0;border-right:1px solid var(--fmdw-line);background:#fff;display:flex;flex-direction:column;overflow:auto}
.fmdw-rail-head{padding:16px 16px 10px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--fmdw-line)}
.fmdw-rail-head.titleless{padding-top:12px}
.fmdw-rail-head strong{font-size:13.5px;font-weight:1000;line-height:1.3}
.fmdw-rail-head span{font-size:10.5px;font-weight:850;color:var(--fmdw-muted)}
.fmdw-steps{display:flex;flex-direction:column;width:100%;max-width:100%;min-width:0;padding:10px 8px;gap:2px}
.fmdw-step{display:flex;align-items:center;gap:10px;border:0;background:transparent;border-radius:11px;padding:9px 10px;font:inherit;font-size:12px;font-weight:900;color:#475467;cursor:pointer;text-align:left;min-width:0;transition:background .12s ease,color .12s ease}
.fmdw-step:hover{background:#f4f6fa}
.fmdw-step.current{background:color-mix(in srgb,var(--fmdw-primary) 9%,#fff);color:var(--fmdw-primary)}
.fmdw-step.done{color:#137a45}
.fmdw-step.locked{color:#98a2b3;cursor:not-allowed}
.fmdw-step-dot{flex:none;width:24px;height:24px;border-radius:99px;display:grid;place-items:center;font-size:10.5px;font-weight:1000;background:#eef0f5;color:#5a6382}
.fmdw-step.current .fmdw-step-dot{background:var(--fmdw-primary);color:var(--fmdw-on-primary)}
.fmdw-step.done .fmdw-step-dot{background:#d7f5e3;color:#0c5f36}
.fmdw-step.locked .fmdw-step-dot{background:#f2f4f7;color:#98a2b3;font-size:9px}
.fmdw-step-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* main — equal flex basis with the preview so the two panes split the space
   after the (thin) rail ~50/50 on wide screens. */
.fmdw-main{flex:1 1 0;width:100%;max-width:100%;min-width:0;overflow:hidden;display:flex;flex-direction:column}
.fmdw-step-head{flex:none;padding:18px 22px 4px}
.fmdw-step-head h2{margin:0;font-size:18px;font-weight:1000;line-height:1.25}
.fmdw-step-head p{margin:6px 0 0;font-size:12.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.5}
.fmdw-items{flex:1;min-height:0;overflow:auto;padding:14px 22px 18px;display:flex;flex-direction:column;gap:14px}
.fmdw-section{border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:16px;display:flex;flex-direction:column;gap:12px;transform-origin:top center}
.fmdw-section>h3{margin:0;font-size:14px;font-weight:1000}.fmdw-section>p{margin:-6px 0 0;color:var(--fmdw-muted);font-size:11.5px;font-weight:750}.fmdw-section-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.fmdw-section-items>.fmdw-item:only-child{grid-column:1/-1}
.fmdw-enter-fade{animation:fmdw-enter-fade var(--fmdw-enter-ms,180ms) ease both}.fmdw-enter-grow{animation:fmdw-enter-grow var(--fmdw-enter-ms,220ms) ease both}.fmdw-enter-slide{animation:fmdw-enter-slide var(--fmdw-enter-ms,220ms) ease both}
@keyframes fmdw-enter-fade{from{opacity:0}to{opacity:1}}@keyframes fmdw-enter-grow{from{opacity:0;transform:scaleY(.04)}to{opacity:1;transform:scaleY(1)}}@keyframes fmdw-enter-slide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.fmdw-item.invalid .fmdw-card,.fmdw-item.invalid input,.fmdw-item.invalid select,.fmdw-item.invalid textarea{border-color:#e5484d}
.fmdw-capability-disabled{position:relative;filter:grayscale(.8);opacity:.52;cursor:not-allowed}
.fmdw-capability-disabled::after{content:attr(data-disabled-reason);display:block;margin-top:7px;padding:6px 9px;border:1px solid #d0d5dd;border-radius:8px;background:#f2f4f7;color:#667085;font-size:9.5px;font-weight:900;line-height:1.35}
.fmdw-capability-disabled :is(button,input,select,textarea,[role="switch"]){pointer-events:none}
.fmdw-foot{flex:none;display:flex;align-items:center;gap:10px;padding:12px 22px;border-top:1px solid var(--fmdw-line);background:#fff}
.fmdw-foot [data-fmdw-continue]{margin-left:auto}
.fmdw-foot-note{font-size:11px;font-weight:900;color:#b42318}
/* fields */
.fmdw-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.fmdw-field-label{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:var(--fmdw-muted)}
.fmdw-field-desc{font-size:11.5px;font-weight:800;color:var(--fmdw-muted);text-transform:none;letter-spacing:0;line-height:1.45}
.fmdw-req{color:#e5484d;font-style:normal;margin-left:2px}
.fmdw-field input,.fmdw-field select,.fmdw-field textarea{width:100%;max-width:460px;border:1px solid #d4d9e6;border-radius:10px;background:#fff;color:var(--fmdw-ink);padding:10px 12px;font:inherit;font-size:13px;font-weight:800;outline:none;min-width:0}
.fmdw-field textarea{min-height:76px;resize:vertical;line-height:1.5}
.fmdw-field input:focus,.fmdw-field select:focus,.fmdw-field textarea:focus{border-color:var(--fmdw-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmdw-primary) 12%,transparent)}
.fmdw-field input:disabled,.fmdw-field select:disabled,.fmdw-field textarea:disabled{background:#f5f7fb;color:#98a2b3;cursor:not-allowed}
.fmdw-field-error{font-size:11px;font-weight:900;color:#b42318;text-transform:none;letter-spacing:0}
.fmdw-money{position:relative;display:block;max-width:460px}
.fmdw-money::before{content:'$';position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:12.5px;font-weight:900;color:#98a2b3;pointer-events:none}
.fmdw-money input{padding-left:26px}
.fmdw-hint{margin:0;font-size:11.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.5;text-transform:none;letter-spacing:0}
.fmdw-hint i{margin-right:5px}
.fmdw-card{border:1px solid var(--fmdw-line);border-radius:14px;background:var(--fmdw-card);padding:14px;display:flex;flex-direction:column;gap:11px}
.fmdw-empty{flex:1;min-height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--fmdw-muted);font-size:12.5px;font-weight:850}
.fmdw-empty i{font-size:24px;color:#98a2b3}
/* buttons */
.fmdw-btn{min-height:36px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;color:#344054;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;white-space:nowrap;transition:border-color .12s ease,color .12s ease,background .12s ease}
.fmdw-btn:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-btn.primary{background:var(--fmdw-primary);border-color:var(--fmdw-primary);color:var(--fmdw-on-primary)}
.fmdw-btn.primary:hover{filter:brightness(1.07);color:var(--fmdw-on-primary)}
.fmdw-btn.ghost{border-color:transparent;background:transparent;color:var(--fmdw-muted)}
.fmdw-btn.ghost:hover{color:var(--fmdw-primary)}
.fmdw-btn:disabled{opacity:.5;cursor:not-allowed;pointer-events:none}
.fmdw-icon-btn{width:30px;height:30px;flex:none;border:1px solid var(--fmdw-line);border-radius:9px;background:#fff;color:var(--fmdw-muted);display:inline-grid;place-items:center;cursor:pointer;font-size:11px}
.fmdw-icon-btn:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-icon-btn.danger:hover{border-color:#e5484d;color:#e5484d}
.fmdw-row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* toggle */
.fmdw-toggle-row{display:flex;align-items:center;gap:12px;border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:13px 14px;cursor:pointer;max-width:460px}
.fmdw-toggle{flex:none;width:40px;height:23px;border-radius:99px;background:#d6dbe7;position:relative;transition:background .15s ease;cursor:pointer}
.fmdw-toggle i{position:absolute;top:2.5px;left:3px;width:18px;height:18px;border-radius:99px;background:#fff;transition:left .15s ease;box-shadow:0 1px 3px rgba(15,23,42,.25)}
.fmdw-toggle.on{background:var(--fmdw-primary)}
.fmdw-toggle.on i{left:19px}
.fmdw-toggle-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.fmdw-toggle-copy strong{font-size:12.5px;font-weight:1000}
.fmdw-toggle-copy small{font-size:11px;font-weight:800;color:var(--fmdw-muted)}
/* checkboxes */
.fmdw-check-list{display:flex;flex-direction:column;gap:7px;max-width:460px}
.fmdw-check{display:flex;align-items:center;gap:9px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;padding:10px 12px;font-size:12.5px;font-weight:850;cursor:pointer;text-transform:none;letter-spacing:0;color:var(--fmdw-ink)}
.fmdw-check input{width:auto;max-width:none;accent-color:var(--fmdw-primary);margin:0}
/* choice cards */
.fmdw-choice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.fmdw-choice-card{position:relative;border:1.5px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:13px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;cursor:pointer;font:inherit;text-align:left;color:var(--fmdw-ink);min-width:0;transition:border-color .12s ease,box-shadow .12s ease}
.fmdw-choice-card:hover{border-color:color-mix(in srgb,var(--fmdw-primary) 45%,var(--fmdw-line))}
.fmdw-choice-card.active{border-color:var(--fmdw-primary);background:color-mix(in srgb,var(--fmdw-primary) 5%,#fff);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmdw-primary) 14%,transparent)}
.fmdw-choice-card:disabled{opacity:.6;cursor:default}
.fmdw-choice-img{width:100%;aspect-ratio:4/3;border-radius:9px;overflow:hidden;background:#eef1f6}
.fmdw-choice-img img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-choice-icon{width:32px;height:32px;border-radius:9px;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary);display:grid;place-items:center;font-size:14px}
.fmdw-choice-card strong{font-size:12.5px;font-weight:1000;line-height:1.3}
.fmdw-choice-card small{font-size:10.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.4}
.fmdw-choice-price{font-size:11px;font-weight:1000;color:var(--fmdw-primary)}
.fmdw-choice-tick{position:absolute;top:9px;right:9px;width:20px;height:20px;border-radius:99px;background:var(--fmdw-primary);color:var(--fmdw-on-primary);display:none;place-items:center;font-size:9px}
.fmdw-choice-card.active .fmdw-choice-tick{display:grid}
/* measurements */
.fmdw-meas-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px}
.fmdw-meas-field{display:flex;flex-direction:column;gap:4px}
.fmdw-meas-field span{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:var(--fmdw-muted)}
.fmdw-meas-field.needed input{border-color:#e8b93c;background:#fffdf4}
.fmdw-meas-note{margin:0;font-size:11px;font-weight:900;color:#b58a00}
.fmdw-stat-grid{display:flex;flex-wrap:wrap;gap:7px}
.fmdw-stat{display:inline-flex;flex-direction:column;gap:1px;border:1px solid var(--fmdw-line);border-radius:9px;padding:6px 9px;background:#fafbfe}
.fmdw-stat i{font-style:normal;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:var(--fmdw-muted)}
.fmdw-stat b{font-size:11.5px;font-weight:1000}
/* photos */
.fmdw-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.fmdw-photo{position:relative;border:2px solid transparent;border-radius:11px;overflow:hidden;background:#eef1f6;padding:0;cursor:pointer;aspect-ratio:1/1}
.fmdw-photo img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-photo.active{border-color:var(--fmdw-primary)}
.fmdw-photo.active i{position:absolute;right:6px;top:6px;color:var(--fmdw-primary);background:#fff;border-radius:99px;font-size:14px}
/* line items */
.fmdw-li-list{display:flex;flex-direction:column;gap:6px}
.fmdw-li-row{display:flex;align-items:center;gap:8px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;padding:8px 10px;min-width:0}
.fmdw-li-row.child{margin-left:22px}
.fmdw-li-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fmdw-li-name strong{font-size:12.5px;font-weight:1000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-name small{font-size:10.5px;font-weight:800;color:var(--fmdw-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-name input{max-width:none;padding:6px 9px;font-size:12px;border-radius:8px}
.fmdw-li-qty{width:74px !important;flex:none;padding:6px 8px !important;font-size:12px !important;border-radius:8px !important;text-align:right}
.fmdw-li-price{width:96px !important;flex:none;padding:6px 8px !important;font-size:12px !important;border-radius:8px !important;text-align:right}
.fmdw-li-unit{flex:none;font-size:10.5px;font-weight:900;color:var(--fmdw-muted);min-width:22px}
.fmdw-li-total{display:flex;align-items:center;justify-content:flex-end;gap:10px;font-size:12px;font-weight:900;color:var(--fmdw-muted)}
.fmdw-li-total b{font-size:14px;font-weight:1000;color:var(--fmdw-ink)}
/* piece select (native "What are we doing?" type cards) */
.fmdw-piece-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.fmdw-piece-type{--fmdw-piece-color:var(--fmdw-primary);gap:8px;padding:15px 14px}
.fmdw-piece-type-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:16px;background:color-mix(in srgb,var(--fmdw-piece-color) 11%,#fff);color:var(--fmdw-piece-color)}
.fmdw-piece-type.active{border-color:var(--fmdw-primary)}
/* line-item review flags */
.fmdw-li-name-line{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.fmdw-li-name-line strong{font-size:12.5px;font-weight:1000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-flag{flex:none;display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:9px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.fmdw-li-flag.optional{background:#fff3dc;color:#b58a00}
.fmdw-li-flag.choice{background:#e8efff;color:#1d4ed8}
.fmdw-li-flag.included{background:#eef0f5;color:#5a6382}
/* line-item media attach */
.fmdw-li-thumb{flex:none;width:26px;height:20px;border-radius:6px;overflow:hidden;background:#eef1f6;border:1px solid var(--fmdw-line);display:inline-grid;place-items:center}
.fmdw-li-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-li-thumb.video{background:#111827;color:#fff;font-size:10px}
.fmdw-icon-btn.has-media{border-color:color-mix(in srgb,var(--fmdw-primary) 55%,var(--fmdw-line));color:var(--fmdw-primary);background:color-mix(in srgb,var(--fmdw-primary) 7%,#fff)}
.fmdw-attach-pop{position:fixed;z-index:2147483550;border:1px solid var(--fmdw-line,#e4e7ec);border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(16,24,40,.22);padding:12px;display:flex;flex-direction:column;gap:9px;max-height:min(520px,80vh);overflow:auto;font-size:12px;color:#111827}
.fmdw-attach-head{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
.fmdw-attach-head i{margin-right:5px}
.fmdw-attach-grid{grid-template-columns:repeat(auto-fill,minmax(64px,1fr));max-height:160px;overflow:auto}
.fmdw-attach-field{display:flex;flex-direction:column;gap:3px}
.fmdw-attach-field span{font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#8a94a6}
.fmdw-attach-field input,.fmdw-attach-field select{width:100%;border:1px solid #d4d9e6;border-radius:9px;background:#fff;color:#111827;padding:7px 9px;font:inherit;font-size:12px;font-weight:800;outline:none}
.fmdw-attach-field input:focus,.fmdw-attach-field select:focus{border-color:var(--fmdw-primary,#2563EB)}
.fmdw-attach-actions{display:flex;align-items:center;gap:8px}
.fmdw-attach-actions [data-fmdw-attach-save]{margin-left:auto}
/* content blocks */
.fmdw-cb-list{display:flex;flex-direction:column;gap:10px}
.fmdw-cb-card{border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:9px}
.fmdw-cb-head{display:flex;align-items:center;gap:8px}
.fmdw-cb-index{flex:none;width:24px;height:24px;border-radius:99px;display:grid;place-items:center;font-size:10.5px;font-weight:1000;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary)}
.fmdw-cb-title{flex:1;min-width:0;max-width:none !important}
.fmdw-cb-body{min-height:64px;max-width:none !important}
.fmdw-cb-media-row{display:flex;align-items:flex-start;gap:10px;min-width:0}
.fmdw-cb-thumb{flex:none;width:76px;height:58px;border-radius:10px;overflow:hidden;background:#eef1f6;border:1px solid var(--fmdw-line);display:grid;place-items:center;color:#98a2b3;font-size:16px}
.fmdw-cb-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-cb-media-controls{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.fmdw-cb-media-controls input{max-width:none !important;padding:7px 9px !important;font-size:12px !important;border-radius:9px !important}
.fmdw-cb-photo-grid{border:1px solid var(--fmdw-line);border-radius:11px;padding:8px;background:#fafbfe;max-height:190px;overflow:auto}
.fmdw-cb-settings{display:flex;gap:10px;flex-wrap:wrap}
.fmdw-cb-settings label{flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:3px;font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#8a94a6}
.fmdw-cb-settings select{max-width:none !important;padding:7px 9px !important;font-size:12px !important;border-radius:9px !important}
/* piece picker / status cards */
.fmdw-piece-card,.fmdw-status-card{flex-direction:row;align-items:center;gap:13px}
.fmdw-piece-icon,.fmdw-status-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:15px;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary)}
.fmdw-status-card.done .fmdw-status-icon{background:#d7f5e3;color:#0c5f36}
.fmdw-piece-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fmdw-piece-copy strong{font-size:12.5px;font-weight:1000}
.fmdw-piece-copy small{font-size:11px;font-weight:800;color:var(--fmdw-muted)}
/* piece picker — embedded scope builder */
.fmdw-piece-embed{padding:0;overflow:hidden;gap:0}
.fmdw-piece-embed-head{display:flex;align-items:center;gap:13px;padding:12px 14px;border-bottom:1px solid var(--fmdw-line);background:#fafbfe}
.fmdw-piece-embed-host{min-height:340px;display:flex;flex-direction:column;background:#fff}
.fmdw-piece-embed-host>*{flex:1;min-height:0}
/* review */
.fmdw-gen-doc{display:flex;align-items:center;gap:11px;border:1px solid #e4e7ec;border-radius:12px;background:#fbfcfe;padding:11px 13px;min-width:0}
.fmdw-gen-doc i{font-size:16px;color:#98a2b3;flex:none}
.fmdw-gen-doc.done{border-color:#b5e3c8;background:#f2fbf6}
.fmdw-gen-doc.done i{color:#12b76a}
.fmdw-gen-doc-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.fmdw-gen-doc-copy strong{font-size:12.5px;font-weight:950;color:#101828;text-transform:none;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-gen-doc-copy small{font-size:10.5px;font-weight:800;color:#8a92ab;text-transform:none;letter-spacing:0}
.fmdw-gen-doc-open{flex:none;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:11.5px;font-weight:900;padding:7px 12px;cursor:pointer}
.fmdw-gen-doc-open:hover{border-color:var(--fmdw-primary,#2563EB);color:var(--fmdw-primary,#2563EB)}
.fmdw-review{gap:0;padding:4px 14px}
.fmdw-review-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #f0f2f7;font-size:12px;font-weight:850}
.fmdw-review-row:last-child{border-bottom:0}
.fmdw-review-row span{color:var(--fmdw-muted);text-transform:none;letter-spacing:0}
.fmdw-review-row span em{font-style:normal;font-size:10px;color:#98a2b3}
.fmdw-review-row b{font-weight:1000;text-align:right;min-width:0;overflow-wrap:anywhere}
.fmdw-review-row.muted{opacity:.65}
/* widgets */
.fmdw-widget-host{min-height:60px}
/* preview pane — same flex basis as the step content (~50/50 after the rail) */
.fmdw-preview{flex:1 1 0;min-width:0;border-left:1px solid var(--fmdw-line);background:#eef1f5;display:flex;flex-direction:column}
.fmdw-preview-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--fmdw-line);background:#fff}
.fmdw-preview-zoom{display:flex;align-items:center;gap:5px}
.fmdw-scg-group{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.fmdw-zoom-pct{min-width:44px;height:28px;border:1px solid var(--fmdw-line);border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:11px;font-weight:800;cursor:pointer;padding:0 6px}
.fmdw-zoom-pct:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-preview-head strong{font-size:11.5px;font-weight:1000;color:var(--fmdw-muted);text-transform:uppercase;letter-spacing:.05em}
.fmdw-preview-head strong i{margin-right:6px}
.fmdw-preview.loading .fmdw-preview-head strong i{animation:fmdw-spin .8s linear infinite}
.fmdw-preview-stage{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
.fmdw-preview-stage .fmdoc-page{box-shadow:0 10px 28px rgba(16,24,40,.14);border-radius:4px;overflow:hidden;background:#fff}
.fmdw-preview-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:#98a2b3;font-size:12px;font-weight:850;text-align:center;padding:22px}
.fmdw-preview-empty i{font-size:26px}
@keyframes fmdw-spin{to{transform:rotate(360deg)}}
/* portal theme */
.fmdw.fmdw-portal{--fmdw-bg:#f6f8fb}
.fmdw.fmdw-portal .fmdw-rail-head strong{color:var(--fmdw-primary)}
/* full-screen overlay chrome (used by portal + any host needing a takeover) */
.fmdw-overlay{position:fixed;inset:0;z-index:2147483540;background:#f6f8fb;display:flex;flex-direction:column}
.fmdw-overlay-head{flex:none;display:flex;align-items:center;gap:12px;padding:12px 18px;background:#fff;border-bottom:1px solid #e4e7ec}
.fmdw-overlay-head strong{font-size:14px;font-weight:1000;color:#101828;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-overlay-head .fmdw-overlay-close{margin-left:auto}
.fmdw-overlay-close{width:36px;height:36px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;color:#5a6382;display:grid;place-items:center;cursor:pointer;font-size:13px}
.fmdw-overlay-close:hover{border-color:#b42318;color:#b42318}
.fmdw-overlay-body{flex:1;min-height:0;display:flex}
.fmdw-overlay-body>*{flex:1;min-width:0}
/* responsive */
@media(max-width:1080px){.fmdw.has-preview .fmdw-preview{display:none}}
@media(max-width:760px){
  .fmdw{flex-direction:column}
  .fmdw-rail{width:100%;max-width:100%;min-width:0;max-height:none;overflow:hidden;border-right:0;border-bottom:1px solid var(--fmdw-line)}
  .fmdw-steps{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:8px;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
  .fmdw-step{flex:none}
  .fmdw-step-title{max-width:120px}
  .fmdw-section-items{grid-template-columns:1fr}
}`;

  function ensureStyles(){
    if (typeof document === 'undefined' || document.getElementById('fmdw-styles')) return;
    const style = document.createElement('style');
    style.id = 'fmdw-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ================================================================ export
  root.FMDocWorkflow = {
    version: 1,
    mount,
    registerKind,
    kinds(){ return [...kindRegistry.keys()]; },
    ensureStyles,
    /** Line-item media/video attach popover — shared with the documents app's
     *  scope editor. openMediaAttach({ anchor, item, services:{media},
     *  onSave(patch) }) where patch = { media:[{media_id|url,caption?}],
     *  video:{url,caption?}|null, display:"inline"|"popup" }. */
    openMediaAttach,
    // exposed for hosts/tests
    helpers: { evalExpr, whenPasses, resolveOptions, formatValue, stepVisibleFor, itemVisibleFor, normalizeScopeItem, scopeItemsTotal, normalizeContentBlock }
  };
})();
