/* public/libraries/visual-editor/firstmate-visual-editor.js
 * FMVisualEditor — the shared "global visual editor": the Canva-style editor
 * chrome (far-left icon rail, slide-out panel, add-section pill, section
 * chrome + popovers, pages strip, bottom bar, markup dock, drag-insert
 * plumbing) wrapped around an FMDocEditor mount, extracted from the Web
 * Editor so document surfaces can reuse the identical visual-editing
 * frontend.
 *
 *   FMVisualEditor.mount(container, options) -> handle
 *
 * `options` passes every FMDocEditor option through untouched; the extra
 * `options.chrome` object configures the chrome (see mount() below). The
 * returned handle delegates the full FMDocEditor handle and adds
 * setChromeTab / sectionRect / setDevice / refreshPages / editor (the inner
 * FMDocEditor handle) / chromeState.
 *
 * Web-only pieces (page templates, customer-portal templates and portal
 * widget items, site-pages adapter, upload owner metadata) live in the
 * consumer (apps/web-editor) and are injected via the chrome adapters —
 * nothing portal- or site-specific lives here.
 *
 * Chrome renders only while the inner editor is in `visual` mode: the
 * library subscribes to the editor's "mode" event and hides every chrome
 * surface for doc/preview modes (doc mode has its own menubar/toolbar,
 * preview stays chromeless).
 *
 * Plain script (no ESM), global FMVisualEditor. All CSS is embedded and
 * self-injected (style element id "fmve-visual-editor-css") — the app
 * runtime never loads standalone .css files. Chrome DOM keeps the existing
 * `fmwe-` class names so the extraction stays mechanical; the wrapper root
 * class is `fmve-chrome`.
 */
(function (global) {
  'use strict';
  if (global.FMVisualEditor) return;

  const doc = global.document;
  const PT_TO_PX = 96 / 72;

  // ------------------------------------------------------------- utilities
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  function clone(value){
    try { return structuredClone(value); } catch (e) { return JSON.parse(JSON.stringify(value ?? null)); }
  }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function arrayValue(value){ return Array.isArray(value) ? value : []; }
  function numberValue(...values){
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }
  const round2 = (v) => Math.round(Number(v) * 100) / 100;
  const M = () => global.FMDocModel;

  function lsGet(key){ try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value){ try { global.localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

  function parseCssColor(value){
    const text = cleanText(value);
    if (!text) return null;
    let m = text.match(/^#([0-9a-f]{3})$/i);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
    m = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    m = text.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    return null;
  }
  function relativeLuminance(r, g, b){
    const channels = [r / 255, g / 255, b / 255].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function readableOnColor(color){
    const rgb = parseCssColor(color);
    if (!rgb) return '#fff';
    return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.40 ? '#111827' : '#fff';
  }
  function defaultBranding(){
    return objectValue(global.Portal?.cfg?.branding || global.__APP?.orgBranding);
  }
  function brandPrimaryOf(branding){
    const b = objectValue(branding);
    const colors = objectValue(b.colors);
    return firstText(colors.primary, b.primary, colors.brand, b.brand, colors.accent, b.accent, '#2563eb');
  }
  function syncOnPrimaryVar(el, branding){
    if (!el) return;
    try {
      const styles = global.getComputedStyle(el);
      const primary = firstText(styles.getPropertyValue('--primary'), brandPrimaryOf(branding), '#d93025');
      el.style.setProperty('--fmwe-on-primary', readableOnColor(primary));
    } catch (e) { /* CSS #fff fallback */ }
  }
  async function copyText(text){
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const holder = doc.createElement('textarea');
        holder.value = text;
        holder.style.position = 'fixed';
        holder.style.opacity = '0';
        doc.body.appendChild(holder);
        holder.select();
        doc.execCommand('copy');
        holder.remove();
        return true;
      } catch (err) { return false; }
    }
  }
  function portalLogoHtml(branding, orgName){
    const b = objectValue(branding);
    const logo = firstText(b.logo_url, b.logoUrl, typeof b.logo === 'string' ? b.logo : '', objectValue(b.logo).url);
    if (logo && /^(https?:\/\/|\/|data:)/i.test(logo)) {
      return `<img class="cp-logo" src="${esc(logo)}" alt="${esc(orgName || 'Company logo')}">`;
    }
    return `<div class="cp-logo-fallback">${esc(cleanText(orgName).slice(0, 1).toUpperCase() || 'C')}</div>`;
  }

  // ---------------------------------------------------------- built-in confirm
  // Standalone styled confirm so the library has zero dependency on any app
  // CSS; consumers may override via chrome.confirm to keep their own dialogs.
  function builtinConfirm(message, options = {}){
    return new Promise((resolve) => {
      const back = doc.createElement('div');
      back.className = 'fmve-confirm-back';
      back.innerHTML = `
        <div class="fmve-confirm" role="dialog" aria-modal="true">
          <h2><i class="fas ${String(esc(options.icon || 'fa-circle-question'))}"></i> ${String(esc(options.title || 'Are you sure?'))}</h2>
          <p>${String(esc(message))}</p>
          <div class="foot">
            <button type="button" data-fmve-cancel>${(globalThis.PlatformLanguage?.text("visual-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="${String(options.danger ? 'danger' : 'primary')}" data-fmve-ok>${String(esc(options.confirmLabel || 'Confirm'))}</button>
          </div>
        </div>`;
      const close = (value) => { back.remove(); resolve(value); };
      back.addEventListener('mousedown', (event) => { if (event.target === back) close(false); });
      back.querySelector('[data-fmve-cancel]').addEventListener('click', () => close(false));
      back.querySelector('[data-fmve-ok]').addEventListener('click', () => close(true));
      doc.body.appendChild(back);
      syncOnPrimaryVar(back);
    });
  }

  const CHROME_TABS = [
    { id: 'templates', label: (globalThis.PlatformLanguage?.text("visual-editor","m_6831430b8abcaa","Templates") ?? "Templates"), icon: 'fa-clone' },
    { id: 'elements', label: (globalThis.PlatformLanguage?.text("visual-editor","m_f1fa67d1bce90f","Elements") ?? "Elements"), icon: 'fa-shapes' },
    { id: 'widgets', label: (globalThis.PlatformLanguage?.text("visual-editor","m_f5d5649c9ab16a","Widgets") ?? "Widgets"), icon: 'fa-puzzle-piece' },
    { id: 'media', label: (globalThis.PlatformLanguage?.text("visual-editor","m_49e775f365e4e6","Media") ?? "Media"), icon: 'fa-photo-video' },
    { id: 'text', label: (globalThis.PlatformLanguage?.text("visual-editor","m_124287f184b88b","Text") ?? "Text"), icon: 'fa-font' },
    { id: 'brand', label: (globalThis.PlatformLanguage?.text("visual-editor","m_b94bc3a936ee5a","Brand") ?? "Brand"), icon: 'fa-swatchbook' },
    { id: 'markup', label: (globalThis.PlatformLanguage?.text("visual-editor","m_0099dbecb99781","Markup") ?? "Markup"), icon: 'fa-highlighter' }
  ];

  const MARKUP_TOOLS = [
    { id: 'pen', name: 'Pen', icon: 'fa-pen' },
    { id: 'arrow', name: 'Arrow', icon: 'fa-arrow-right' },
    { id: 'text', name: 'Text', icon: 'fa-font' },
    { id: 'eraser', name: 'Eraser', icon: 'fa-eraser' }
  ];

  const NODE_TYPE_ICONS = {
    text: 'fa-font', image: 'fa-image', shape: 'fa-shapes', frame: 'fa-square-full',
    widget: 'fa-th-large', table: 'fa-table', markup_overlay: 'fa-highlighter'
  };


  const PRIMARY_VAR = 'var(--fm-primary, #2563eb)';
  const BODY_FONT_VAR = 'var(--fm-font-body, var(--fm-body-font, Inter, system-ui, sans-serif))';
  const BUTTON_VARIANTS = Object.freeze({
    primary: Object.freeze({ fill: PRIMARY_VAR, color: '#ffffff', cornerRadius: 8, widthPt: 170, heightPt: 44, padding: Object.freeze([10, 16, 10, 16]) }),
    outline: Object.freeze({ fill: '#ffffff', color: '#111827', cornerRadius: 8, widthPt: 160, heightPt: 44, padding: Object.freeze([10, 16, 10, 16]), stroke: Object.freeze({ color: '#111827', width_pt: 1.5 }) }),
    dark: Object.freeze({ fill: '#111827', color: '#ffffff', cornerRadius: 999, widthPt: 150, heightPt: 42, padding: Object.freeze([9, 16, 9, 16]) })
  });

  function buttonPresentation(options = {}){
    const preset = BUTTON_VARIANTS[cleanText(options.variant)] || BUTTON_VARIANTS.primary;
    const suppliedRadius = Number(options.cornerRadius);
    return {
      fill: options.fill || preset.fill,
      color: options.color || preset.color,
      cornerRadius: Number.isFinite(suppliedRadius) ? suppliedRadius : preset.cornerRadius,
      stroke: options.stroke === null ? null : (options.stroke || preset.stroke || null),
      fontFamily: options.fontFamily || BODY_FONT_VAR,
      fontSizePt: Number(options.fontSizePt) || 12,
      fontWeight: Number(options.fontWeight) || 500,
      widthPt: Number(options.widthPt) || preset.widthPt,
      heightPt: Number(options.heightPt) || preset.heightPt,
      padding: Array.isArray(options.padding) ? options.padding : preset.padding
    };
  }

  // localStorage keys are kept from the Web Editor so existing user
  // preferences survive the extraction unchanged.
  const RECENT_ELEMENTS_KEY = 'fm_webeditor_recent_elements';
  const EL_GROUPS_KEY = 'fm_webeditor_el_groups';
  const TEMPLATE_GROUPS_KEY = 'fm_webeditor_template_groups';
  const PAGES_STRIP_KEY = 'fm_webeditor_pages_strip';

  // ------------------------------------------------------ node factories
  // Generic engine-node builders (they build FMDocModel nodes; nothing
  // web-specific). tplWidget seeds from a catalog definition when one is
  // passed.
  function tplText(text, frame, font = {}, extra = {}){
    return M().createNode('text', {
      name: extra.name || 'Text',
      frame: { x: 0, y: 0, w: 200, h: 30, z: 1, ...frame },
      style: { font: { size_pt: 12, ...font } },
      props: {
        blocks: [{
          id: M().generateId('blk'),
          type: cleanText(extra.blockType) || 'paragraph',
          align: cleanText(extra.align) || 'left',
          runs: [{ text }]
        }]
      }
    });
  }

  function tplButton(label, frame, options = {}){
    const presentation = buttonPresentation(options);
    const inner = M().createNode('text', {
      name: 'Label',
      frame: { x: 0, y: 0, w: 'auto', h: 'auto', layout: 'flow' },
      style: { font: { family: presentation.fontFamily, size_pt: presentation.fontSizePt, weight: presentation.fontWeight, color: presentation.color } },
      props: { valign: 'center', line_height: 1.2, blocks: [{ id: M().generateId('blk'), type: 'paragraph', align: 'center', runs: [{ text: label }] }] }
    });
    return M().createNode('frame', {
      name: options.name || 'Button',
      frame: { x: 0, y: 0, w: presentation.widthPt, h: presentation.heightPt, z: 2, layout: 'flow', ...frame },
      style: {
        fill: { type: 'solid', color: presentation.fill },
        radius: presentation.cornerRadius,
        ...(presentation.stroke ? { stroke: presentation.stroke } : {})
      },
      props: {
        flow: { direction: 'column', gap: 0, padding: presentation.padding, align: 'center', justify: 'center', wrap: false },
        ...(options.link ? { link: options.link } : {})
      },
      children: [inner]
    });
  }

  function tplSection(name, h, children, style){
    return M().createNode('frame', {
      name,
      frame: { x: 0, y: 0, w: 'auto', h, z: 0, layout: 'absolute' },
      style: style || { fill: { type: 'solid', color: '#ffffff' } },
      props: { section_width: M().normalizeSectionWidth() },
      children: children || []
    });
  }

  function tplImage(frame, media){
    return M().createNode('image', {
      name: 'Image',
      frame: { x: 0, y: 0, w: 200, h: 140, z: 1, ...frame },
      props: { media: media || null, fit: 'cover', alt: '' }
    });
  }

  /** Widget node seeded from the catalog definition when available. */
  function tplWidget(widgetId, frame, options = {}, catalog){
    const defs = arrayValue(objectValue(catalog).widgets);
    const catalogDef = objectValue(defs.find((d) => cleanText(objectValue(d).id) === widgetId));
    let registeredDef = {};
    try { registeredDef = objectValue(global.FMDocWidgets?.get?.(widgetId, numberValue(catalogDef.version) || 1)); } catch (e) { /* catalog defaults are enough */ }
    const def = { ...registeredDef, ...catalogDef };
    const defaults = objectValue(Object.keys(objectValue(catalogDef.defaults)).length ? catalogDef.defaults : registeredDef.defaults);
    const defFrame = objectValue(defaults.frame);
    return M().createNode('widget', {
      name: firstText(options.name, def.title, widgetId),
      frame: { x: 0, y: 0, w: numberValue(defFrame.w) || 240, h: numberValue(defFrame.h) || 120, z: 1, ...frame },
      props: {
        widget: `${widgetId}@${numberValue(def.version) || 1}`,
        config: { ...clone(objectValue(defaults.config)), ...objectValue(options.config) }
      }
    });
  }

  // ---------------------------------------------------- built-in sections
  // Generic section templates (hero/about/services/gallery/testimonial/cta/
  // contact/faq). They build engine nodes only — widget ids are data, the
  // catalog just supplies default config when present.
  function sectionBuilders(catalog){
    const W = (id, frame, options) => tplWidget(id, frame, options, catalog);
    function heroSection(){
      return tplSection('Hero', 250, [
        tplText('Your headline goes here', { x: 48, y: 60, w: 500, h: 44, z: 1 }, { size_pt: 32, weight: 900, color: '#ffffff' }, { blockType: 'heading' }),
        tplText('Tell visitors what you do and why it matters — one crisp sentence.', { x: 48, y: 114, w: 480, h: 36, z: 2 }, { size_pt: 13, color: 'rgba(255,255,255,0.92)' }),
        tplButton('Get in touch', { x: 48, y: 168, w: 160, h: 42, z: 3 }, { fill: '#ffffff', color: PRIMARY_VAR })
      ], { fill: { type: 'solid', color: PRIMARY_VAR } });
    }
    function aboutSection(){
      return tplSection('About', 190, [
        tplText('About us', { x: 48, y: 34, w: 400, h: 32, z: 1 }, { size_pt: 22, weight: 800 }, { blockType: 'heading' }),
        tplText('We are a local team that takes pride in doing the job right the first time. From the first walkthrough to the final cleanup, we keep you informed at every step.', { x: 48, y: 76, w: 620, h: 80, z: 2 }, { size_pt: 12, color: '#344054' })
      ]);
    }
    function servicesSection(){
      // Cards are authored in ABSOLUTE geometry (title at the top, blurb
      // clearly below it) — the old flow-inside-card layout collapsed both
      // text nodes onto the same y on view pages.
      const card = (x, title, blurb) => M().createNode('frame', {
        name: title,
        frame: { x, y: 84, w: 196, h: 140, z: 2, layout: 'absolute' },
        style: { fill: { type: 'solid', color: '#f8f9fb' }, radius: 10 },
        children: [
          tplText(title, { x: 16, y: 18, w: 164, h: 22, z: 1 }, { size_pt: 13, weight: 800 }),
          tplText(blurb, { x: 16, y: 50, w: 164, h: 72, z: 2 }, { size_pt: 10.5, color: '#667085' })
        ]
      });
      return tplSection('Services', 258, [
        tplText('What we do', { x: 48, y: 30, w: 400, h: 32, z: 1 }, { size_pt: 20, weight: 800 }, { blockType: 'heading' }),
        card(48, 'Service one', 'A sentence on the first thing you offer.'),
        card(262, 'Service two', 'A sentence on the second thing you offer.'),
        card(476, 'Service three', 'A sentence on the third thing you offer.')
      ]);
    }
    function gallerySection(){
      return tplSection('Gallery', 240, [
        tplText('Recent work', { x: 48, y: 28, w: 400, h: 30, z: 1 }, { size_pt: 20, weight: 800 }, { blockType: 'heading' }),
        tplImage({ x: 48, y: 74, w: 196, h: 132, z: 2 }),
        tplImage({ x: 262, y: 74, w: 196, h: 132, z: 3 }),
        tplImage({ x: 476, y: 74, w: 196, h: 132, z: 4 })
      ]);
    }
    function testimonialSection(){
      return tplSection('Testimonial', 170, [
        tplText('“They showed up on time, did beautiful work, and left the place cleaner than they found it.”', { x: 88, y: 44, w: 544, h: 52, z: 1 }, { size_pt: 15, weight: 700 }, { align: 'center' }),
        tplText('— A happy customer', { x: 88, y: 108, w: 544, h: 22, z: 2 }, { size_pt: 11, color: '#667085' }, { align: 'center' })
      ], { fill: { type: 'solid', color: '#f8f9fb' } });
    }
    function ctaSection(){
      return tplSection('Call to action', 140, [
        tplText('Ready to get started?', { x: 48, y: 42, w: 380, h: 34, z: 1 }, { size_pt: 20, weight: 900, color: '#ffffff' }, { blockType: 'heading' }),
        tplText('Reach out for a free estimate.', { x: 48, y: 82, w: 380, h: 22, z: 2 }, { size_pt: 11.5, color: 'rgba(255,255,255,0.8)' }),
        tplButton('Contact us', { x: 512, y: 48, w: 160, h: 44, z: 3 }, { fill: '#ffffff', color: '#111827' })
      ], { fill: { type: 'solid', color: '#111827' } });
    }
    function contactSection(){
      return tplSection('Contact', 280, [
        tplText('Get in touch', { x: 48, y: 30, w: 400, h: 30, z: 1 }, { size_pt: 20, weight: 800 }, { blockType: 'heading' }),
        W('web.lead_form', { x: 48, y: 74, w: 420, h: 180, z: 2 }, { name: 'Lead form' }),
        tplText('Prefer the phone? Call us any weekday, 8am–5pm.', { x: 492, y: 80, w: 180, h: 60, z: 3 }, { size_pt: 11, color: '#667085' })
      ]);
    }
    function faqSection(){
      const qa = (y, q, a) => [
        tplText(q, { x: 48, y, w: 620, h: 20, z: 1 }, { size_pt: 12.5, weight: 800 }),
        tplText(a, { x: 48, y: y + 24, w: 620, h: 24, z: 2 }, { size_pt: 11, color: '#667085' })
      ];
      return tplSection('FAQ', 270, [
        tplText('Frequently asked questions', { x: 48, y: 28, w: 460, h: 30, z: 1 }, { size_pt: 20, weight: 800 }, { blockType: 'heading' }),
        ...qa(74, 'How soon can you start?', 'Most projects start within two weeks of an accepted proposal.'),
        ...qa(140, 'Are you licensed and insured?', 'Yes — fully licensed and insured. Documentation available on request.'),
        ...qa(206, 'Do you offer free estimates?', 'Always. Reach out and we will schedule a walkthrough.')
      ]);
    }
    return {
      hero: heroSection, about: aboutSection, services: servicesSection, gallery: gallerySection,
      testimonial: testimonialSection, cta: ctaSection, contact: contactSection, faq: faqSection
    };
  }

  /** The built-in section-template registry (kind:"section" entries). */
  function sectionTemplates(catalog){
    if (!M()) return [];
    const s = sectionBuilders(catalog);
    return [
      { id: 'tpl_hero', kind: 'section', group: 'sections', name: 'Hero', keywords: 'banner headline intro top', build: () => s.hero() },
      { id: 'tpl_about', kind: 'section', group: 'sections', name: 'About', keywords: 'story company team text', build: () => s.about() },
      { id: 'tpl_services', kind: 'section', group: 'sections', name: 'Services grid', keywords: 'features cards offer grid', build: () => s.services() },
      { id: 'tpl_gallery', kind: 'section', group: 'sections', name: 'Gallery', keywords: 'photos images portfolio work', build: () => s.gallery() },
      { id: 'tpl_testimonial', kind: 'section', group: 'sections', name: 'Testimonial', keywords: 'quote review social proof', build: () => s.testimonial() },
      { id: 'tpl_cta', kind: 'section', group: 'sections', name: 'CTA banner', keywords: 'call to action contact banner', build: () => s.cta() },
      { id: 'tpl_contact', kind: 'section', group: 'sections', name: 'Contact', keywords: 'form lead email phone', build: () => s.contact() },
      { id: 'tpl_faq', kind: 'section', group: 'sections', name: 'FAQ', keywords: 'questions answers help', build: () => s.faq() }
    ];
  }

  /** Wrap sections in a throwaway view doc for card previews. */
  function templatePreviewDoc(sections, designWidthPt){
    const widthPt = numberValue(designWidthPt) || 720;
    const previewDoc = M().createDocument({ kind: 'view' });
    previewDoc.root.frame = { ...objectValue(previewDoc.root.frame), w: widthPt, h: 0, layout: 'flow' };
    previewDoc.root.children = sections;
    previewDoc.settings = { ...objectValue(previewDoc.settings), paper: { size: { w_pt: widthPt } } };
    return previewDoc;
  }

  // ------------------------------------------------------- element previews
  // Panel previews are VISUAL SAMPLES of the element being inserted (Canva
  // style): the rectangle item IS a rectangle, a button looks like the
  // button. No borders, no labels — the tooltip carries the name.
  const EL_INK = '#1f2937';
  function elSvg(inner, viewBox){
    return `<svg viewBox="${viewBox || '0 0 48 40'}" xmlns="http://www.w3.org/2000/svg" fill="${EL_INK}" aria-hidden="true">${inner}</svg>`;
  }
  const EL_PREVIEWS = {
    rect: elSvg('<rect x="5" y="7" width="38" height="26"/>'),
    rounded: elSvg('<rect x="5" y="7" width="38" height="26" rx="7"/>'),
    ellipse: elSvg('<circle cx="24" cy="20" r="15"/>'),
    line: elSvg(`<line x1="5" y1="20" x2="43" y2="20" stroke="${EL_INK}" stroke-width="2.5" stroke-linecap="round"/>`),
    triangle: elSvg('<polygon points="24,5 43,35 5,35"/>'),
    leadForm: elSvg(
      `<rect x="6" y="6" width="52" height="7" rx="2.5" fill="none" stroke="#98a2b3" stroke-width="1.6"/>` +
      `<rect x="6" y="17" width="52" height="7" rx="2.5" fill="none" stroke="#98a2b3" stroke-width="1.6"/>` +
      `<rect x="6" y="28" width="24" height="8" rx="4" fill="var(--fmwe-primary, #2563eb)"/>`,
      '0 0 64 42'),
    navMenu: elSvg(
      `<circle cx="8" cy="8" r="4" fill="var(--fmwe-primary, #2563eb)"/>` +
      `<rect x="24" y="5.5" width="10" height="5" rx="2.5" fill="#98a2b3"/>` +
      `<rect x="38" y="5.5" width="10" height="5" rx="2.5" fill="#98a2b3"/>` +
      `<rect x="52" y="5.5" width="10" height="5" rx="2.5" fill="#98a2b3"/>`,
      '0 0 64 16'),
    image: elSvg(
      `<rect x="4" y="4" width="56" height="36" rx="3" fill="#eef1f5"/>` +
      `<circle cx="20" cy="15" r="4.5" fill="#cbd2dc"/>` +
      `<path d="M10 34 L24 21 L34 30 L44 20 L54 30 V37 a3 3 0 0 1 -3 3 H13 a3 3 0 0 1 -3 -3 Z" fill="#cbd2dc"/>`,
      '0 0 64 44'),
    photo: elSvg(
      `<rect x="4" y="4" width="56" height="36" rx="3" fill="#dbe4f5"/>` +
      `<circle cx="22" cy="16" r="5" fill="#9db4dd"/>` +
      `<path d="M8 36 L24 22 L36 32 L46 23 L56 32 V37 a3 3 0 0 1 -3 3 H11 a3 3 0 0 1 -3 -3 Z" fill="#9db4dd"/>`,
      '0 0 64 44'),
    photoGrid: elSvg(
      `<rect x="4" y="4" width="26" height="17" rx="2" fill="#cbd2dc"/>` +
      `<rect x="34" y="4" width="26" height="17" rx="2" fill="#e2e6ec"/>` +
      `<rect x="4" y="25" width="26" height="17" rx="2" fill="#e2e6ec"/>` +
      `<rect x="34" y="25" width="26" height="17" rx="2" fill="#cbd2dc"/>`,
      '0 0 64 46'),
    video: elSvg(
      `<rect x="4" y="4" width="56" height="36" rx="4" fill="#1f2937"/>` +
      `<polygon points="27,14 27,30 41,22" fill="#ffffff"/>`,
      '0 0 64 44'),
    secShort: elSvg('<rect x="2" y="12" width="60" height="10" rx="2" fill="#e2e6ec"/>', '0 0 64 34'),
    secTall: elSvg('<rect x="2" y="4" width="60" height="26" rx="2" fill="#e2e6ec"/>', '0 0 64 34'),
    secColor: elSvg('<rect x="2" y="8" width="60" height="18" rx="2" fill="var(--fmwe-primary, #2563eb)"/>', '0 0 64 34'),
    table: elSvg(
      `<rect x="4" y="6" width="56" height="9" rx="1.5" fill="#d4dae3"/>` +
      `<rect x="4" y="18" width="56" height="8" fill="#eef1f5"/>` +
      `<rect x="4" y="29" width="56" height="8" fill="#eef1f5"/>` +
      `<line x1="24" y1="6" x2="24" y2="37" stroke="#ffffff" stroke-width="2"/>` +
      `<line x1="43" y1="6" x2="43" y2="37" stroke="#ffffff" stroke-width="2"/>`,
      '0 0 64 42')
  };
  function elBtnSample(label, variant){
    const presentation = buttonPresentation({ variant });
    const stroke = objectValue(presentation.stroke);
    const previewStyle = [
      `--fmwe-button-fill:${presentation.fill}`,
      `--fmwe-button-color:${presentation.color}`,
      `--fmwe-button-radius:${presentation.cornerRadius}px`,
      `--fmwe-button-font:${presentation.fontFamily}`,
      `--fmwe-button-weight:${presentation.fontWeight}`,
      `--fmwe-button-aspect:${presentation.widthPt} / ${presentation.heightPt}`,
      `--fmwe-button-stroke-color:${firstText(stroke.color, 'transparent')}`,
      `--fmwe-button-stroke-width:${numberValue(stroke.width_pt) || 0}px`
    ].join(';');
    return `<span class="fmwe-ch-btnsample ${esc(variant)}" style="${esc(previewStyle)}">${esc(label)}</span>`;
  }

  // --------------------------------------------------------------- styles
  // Chrome CSS moved from apps/web-editor/web-editor.css (class names are
  // unchanged so the extraction stays mechanical). Scoping changes only: the
  // wrapper root class .fmve-chrome replaces .fmwe-editor as the scope for
  // the doc-editor rail overrides and the markup-live rules, and the design
  // tokens are declared on the wrapper root so the chrome works without any
  // app stylesheet.
  const STYLE_ID = 'fmve-visual-editor-css';
  const CSS = `
/* ============================= FMVisualEditor (shared editor chrome) ==== */
.fmve-chrome, .fmve-confirm-back {
  --fmwe-primary: var(--primary-readable, var(--primary, #d93025));
  --fmwe-primary-raw: var(--primary, #d93025);
  --fmwe-tint: rgba(var(--primary-rgb, 217, 48, 37), .08);
  --fmwe-on-primary: #fff;
}
.fmve-chrome {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  color: #101828;
  font-size: 13px;
}
.fmve-chrome *, .fmve-chrome *::before, .fmve-chrome *::after,
.fmve-confirm-back *, .fmve-confirm-back *::before, .fmve-confirm-back *::after { box-sizing: border-box; }
.fmve-chrome button, .fmve-confirm-back button { font: inherit; }
.fmve-main {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}
.fmve-chrome .fmwe-editor-canvas {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  position: relative;
}
/* Chrome renders only in the inner editor's visual mode — doc mode has its
   own menubar/toolbar and preview stays chromeless. */
.fmve-chrome.fmve-nochrome .fmwe-ch-rail,
.fmve-chrome.fmve-nochrome .fmwe-ch-panel,
.fmve-chrome.fmve-nochrome .fmwe-ch-under,
.fmve-chrome.fmve-nochrome .fmwe-ch-bottom,
.fmve-chrome.fmve-nochrome .fmwe-ch-notes,
.fmve-chrome.fmve-nochrome .fmwe-mkdock,
.fmve-chrome.fmve-nochrome .fmwe-sec-actions,
.fmve-chrome.fmve-nochrome .fmwe-sec-mobile-actions,
.fmve-chrome.fmve-nochrome .fmwe-sec-pill { display: none !important; }

/* Preview deliberately hides the editing bottom bar, but fullscreen is most
   useful there. Keep one small, persistent control over the lower-right of
   the preview and fullscreen only this website surface (not portal chrome). */
.fmwe-preview-fullscreen-toggle {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 1200;
  display: none;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid #d7dce3;
  border-radius: 10px;
  background: rgba(255,255,255,.96);
  box-shadow: 0 7px 20px rgba(15,23,42,.18);
  color: #344054;
  font: inherit;
  cursor: pointer;
  transition: transform .12s ease, background .12s ease, color .12s ease, box-shadow .12s ease;
}
.fmve-chrome.fmve-kind-web.fmve-preview-mode .fmwe-preview-fullscreen-toggle { display: grid; }
.fmwe-preview-fullscreen-toggle:hover {
  transform: scale(1.05);
  background: #fff;
  color: var(--fmwe-primary);
  box-shadow: 0 9px 24px rgba(15,23,42,.23);
}
.fmwe-preview-fullscreen-toggle:focus-visible { outline: 2px solid var(--fmwe-primary); outline-offset: 2px; }
.fmve-chrome.fmve-preview-fullscreen {
  width: 100vw;
  height: 100vh;
  background: #fff;
}
.fmve-chrome.fmve-preview-fullscreen .fmde-toolbar,
.fmve-chrome.fmve-preview-fullscreen .fmde-menubar { display: none !important; }
.fmve-chrome.fmve-preview-fullscreen .fmde-root,
.fmve-chrome.fmve-preview-fullscreen .fmde-body,
.fmve-chrome.fmve-preview-fullscreen .fmwe-ch-canvas-column,
.fmve-chrome.fmve-preview-fullscreen .fmde-canvas { min-height: 0; height: 100%; }
.fmve-chrome.fmve-kind-web.fmve-preview-mode .fmde-stage {
  min-width: 0;
  min-height: 100%;
  padding: 0;
  gap: 0;
  align-items: stretch;
}

/* The doc-editor's internal left rail is replaced by the chrome's icon rail +
   slide-out panel. Scoped to .fmve-chrome only — surfaces without chrome keep
   the built-in rail. The right inspector and fmde toolbar stay untouched. */
.fmve-chrome .fmde-rail,
.fmve-chrome .fmde-side-expand-left { display: none; }

/* ---- shared primitives used by the chrome panels ---- */
.fmve-chrome .fmwe-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 13px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  color: #344054;
  font-size: 12px;
  font-weight: 850;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.fmve-chrome .fmwe-btn:hover { background: #f8f9fb; border-color: #d6dae2; }
.fmve-chrome .fmwe-btn:disabled { opacity: .5; cursor: not-allowed; }
.fmve-chrome .fmwe-btn.primary {
  background: var(--fmwe-primary-raw);
  border-color: var(--fmwe-primary-raw);
  color: var(--fmwe-on-primary);
  box-shadow: 0 6px 14px rgba(var(--primary-rgb, 217, 48, 37), .22);
}
.fmve-chrome .fmwe-btn.primary:hover { filter: brightness(.96); background: var(--fmwe-primary-raw); }
.fmve-chrome .fmwe-btn.danger { color: #b42318; border-color: #fecdca; }
.fmve-chrome .fmwe-btn.danger:hover { background: #fef3f2; }
.fmve-chrome .fmwe-btn.active { border-color: var(--fmwe-primary); color: var(--fmwe-primary); background: var(--fmwe-tint); }
.fmve-chrome .fmwe-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid #e4e7ec;
  border-radius: 9px;
  background: #fff;
  color: #475467;
  font-size: 12px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.fmve-chrome .fmwe-icon-btn:hover { background: #f8f9fb; border-color: #d6dae2; color: #101828; }
.fmve-chrome .fmwe-micro-label {
  margin: 18px 0 10px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: #98a2b3;
  display: flex;
  align-items: center;
  gap: 7px;
}
.fmve-chrome .fmwe-micro-label:first-child { margin-top: 4px; }
.fmve-chrome .fmwe-micro-label .count {
  background: #f2f4f7;
  color: #667085;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 9.5px;
}
.fmve-chrome .fmwe-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.fmve-chrome .fmwe-field > span {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #98a2b3;
}
.fmve-chrome .fmwe-field input[type="text"], .fmve-chrome .fmwe-field input[type="search"], .fmve-chrome .fmwe-field textarea, .fmve-chrome .fmwe-field select {
  border: 1px solid #d6dae2;
  border-radius: 10px;
  min-height: 36px;
  padding: 7px 11px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  color: #101828;
  background: #fff;
  width: 100%;
}
.fmve-chrome .fmwe-field input:focus, .fmve-chrome .fmwe-field textarea:focus, .fmve-chrome .fmwe-field select:focus {
  outline: none;
  border-color: var(--fmwe-primary);
  box-shadow: 0 0 0 3px var(--fmwe-tint);
}
.fmve-chrome .fmwe-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid #e4e7ec;
  border-top-color: var(--fmwe-primary);
  border-radius: 999px;
  animation: fmveSpin .8s linear infinite;
}
@keyframes fmveSpin { to { transform: rotate(360deg); } }
/* ---- far-left icon rail ---- */
/* Wide enough that every label renders in full — labels may wrap to two
   lines ("QR codes") but NEVER truncate with an ellipsis. */
.fmwe-ch-rail {
  /* Wide enough that the longest single-word label ("Templates") fits on one
     line at 9.5px/800 — labels never break mid-word and never ellipsize. */
  flex: 0 0 94px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 8px 6px;
  background: #fff;
  border-right: 1px solid #e4e7ec;
  overflow-y: auto;
  z-index: 24;
}
.fmwe-ch-railbtn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 9px 3px 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #475467;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: .01em;
  cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.fmwe-ch-railbtn i { font-size: 15px; }
.fmwe-ch-railbtn span {
  max-width: 100%;
  white-space: normal;
  /* Wrap only between words ("QR codes") — never split a word ("Templates"). */
  overflow-wrap: normal;
  word-break: keep-all;
  text-align: center;
  line-height: 1.2;
}
.fmwe-ch-railbtn:hover { background: #f4f5f8; color: #101828; }
.fmwe-ch-railbtn.active {
  background: var(--fmwe-tint);
  color: var(--fmwe-primary);
}

/* ---- slide-out panel ---- */
/* Opens/closes with a slide + width transition; the inner clip keeps the
   panel content at full width during the animation (no reflow jank). */
.fmwe-ch-panel {
  position: relative;
  flex: 0 0 400px;
  max-width: 400px;
  background: #fff;
  border-right: 1px solid #e4e7ec;
  display: flex;
  min-height: 0;
  z-index: 23;
  transition: flex-basis .2s ease, max-width .2s ease, border-right-color .2s ease;
}
.fmwe-ch-panel.hidden {
  flex-basis: 0;
  max-width: 0;
  border-right-color: transparent;
}
.fmwe-ch-panel.hidden .fmwe-ch-collapse { opacity: 0; pointer-events: none; }
.fmwe-ch-panel-clip {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
}
.fmwe-ch-panel-body {
  width: 400px;
  flex: 0 0 400px;
  overflow-y: auto;
  padding: 14px 16px 20px;
}
.fmwe-ch-collapse {
  position: absolute;
  right: -15px;
  top: 50%;
  transform: translateY(-50%);
  width: 15px;
  height: 72px;
  border: 1px solid #e4e7ec;
  border-left: 0;
  border-radius: 0 9px 9px 0;
  background: #fff;
  color: #98a2b3;
  font-size: 9px;
  cursor: pointer;
  display: grid;
  place-items: center;
  z-index: 25;
  box-shadow: 3px 0 8px rgba(16, 24, 40, .05);
  transition: opacity .18s ease;
}
.fmwe-ch-collapse:hover { color: var(--fmwe-primary); }

.fmwe-ch-head {
  margin: 2px 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fmwe-ch-head strong { font-size: 14.5px; font-weight: 900; letter-spacing: -.01em; }
.fmwe-ch-search { margin-bottom: 14px; }
.fmwe-ch-search input[type="search"] {
  width: 100%;
  border: 1px solid #d6dae2;
  border-radius: 10px;
  min-height: 36px;
  padding: 7px 11px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  color: #101828;
}
.fmwe-ch-search input:focus { outline: none; border-color: var(--fmwe-primary); box-shadow: 0 0 0 3px var(--fmwe-tint); }
.fmwe-ch-search .row { display: flex; gap: 8px; margin-top: 9px; }
.fmwe-ch-search .row .fmwe-btn { flex: 1; justify-content: center; }
.fmwe-ch-quiet {
  margin: 8px 0 12px;
  color: #98a2b3;
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.5;
}
.fmwe-ch-bigbtn { width: 100%; justify-content: center; min-height: 40px; margin-bottom: 6px; }

/* template cards */
.fmwe-ch-cardgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.fmwe-ch-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid #e4e7ec;
  border-radius: 11px;
  background: #fff;
  overflow: hidden;
  padding: 0;
  cursor: pointer;
  text-align: left;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.fmwe-ch-card:hover { border-color: var(--fmwe-primary); box-shadow: 0 6px 16px rgba(16, 24, 40, .08); }
.fmwe-ch-card .thumb {
  position: relative;
  display: block;
  height: 84px;
  background: #f2f4f7;
  overflow: hidden;
  pointer-events: none;
}
.fmwe-ch-card .thumb.tall { height: 128px; }
.fmwe-ch-card .name {
  display: block;
  padding: 7px 10px 8px;
  font-size: 11px;
  font-weight: 850;
  color: #344054;
  border-top: 1px solid #f2f4f7;
}

.fmwe-ch-template-groups { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.fmwe-ch-template-group { border-top: 1px solid #eef0f4; padding-top: 7px; }
.fmwe-ch-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 1px 9px;
  border: 0;
  background: transparent;
  color: #344054;
  text-align: left;
  cursor: pointer;
}
.fmwe-ch-group-head > span:first-child { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 1px; }
.fmwe-ch-group-head strong { font-size: 11.5px; font-weight: 900; }
.fmwe-ch-group-head small { color: #98a2b3; font-size: 9.5px; font-weight: 700; }
.fmwe-ch-group-head .count { display: grid; min-width: 20px; height: 20px; place-items: center; border-radius: 999px; background: #f2f4f7; color: #667085; font-size: 9.5px; font-weight: 900; }
.fmwe-ch-group-head > i { color: #98a2b3; font-size: 9px; transition: transform .14s ease; }
.fmwe-ch-template-group.collapsed:not(.search-open) .fmwe-ch-group-head > i { transform: rotate(-90deg); }
.fmwe-ch-template-group.collapsed:not(.search-open) .fmwe-ch-group-body { display: none; }

/* element categories + items */
.fmwe-ch-catgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.fmwe-ch-cat {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  padding: 10px 11px;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 850;
  color: #344054;
  text-align: left;
  transition: border-color .12s ease;
}
.fmwe-ch-cat:hover { border-color: var(--fmwe-primary); color: var(--fmwe-primary); }
.fmwe-ch-cat .ic {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--fmwe-tint);
  color: var(--fmwe-primary);
  font-size: 12px;
}
.fmwe-ch-cat .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmwe-ch-cat .count { color: #98a2b3; font-size: 10px; font-weight: 900; }
.fmwe-ch-itemgrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.fmwe-ch-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  padding: 12px 6px 9px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
  color: #344054;
  transition: border-color .12s ease, color .12s ease;
}
.fmwe-ch-item:hover { border-color: var(--fmwe-primary); color: var(--fmwe-primary); }
.fmwe-ch-item.active { border-color: var(--fmwe-primary); background: var(--fmwe-tint); color: var(--fmwe-primary); }
.fmwe-ch-item .ic { font-size: 15px; color: #667085; }
.fmwe-ch-item:hover .ic, .fmwe-ch-item.active .ic { color: var(--fmwe-primary); }
.fmwe-ch-item .name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Elements panel: visual samples (Canva style) — the sample IS the button.
   No borders or labels; the tooltip carries the name. */
.fmwe-ch-elgrid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 18px) / 4);
  grid-template-rows: 56px;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scroll-snap-type: inline proximity;
  scrollbar-width: none;
}
.fmwe-ch-elgrid::-webkit-scrollbar { display: none; }
.fmwe-ch-widgetgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: auto;
  gap: 8px;
  min-width: 0;
  padding: 3px;
  align-items: start;
}
.fmwe-ch-widgetgrid .fmwe-ch-el {
  height: auto;
  aspect-ratio: 1 / 1;
  flex-direction: column;
  gap: 5px;
  overflow: hidden;
  padding: 7px 4px 5px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  color: #475467;
}
.fmwe-ch-widgetgrid .fmwe-ch-el:hover {
  border-color: var(--fmwe-primary);
  background: var(--fmwe-tint);
  color: var(--fmwe-primary);
}
.fmwe-ch-widget-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  color: currentColor;
  font-size: 27px;
  line-height: 1;
}
.fmwe-ch-widget-icon > i,
.fmwe-ch-widget-icon > svg {
  display: block;
  width: 30px;
  height: 30px;
  font-size: 27px;
  line-height: 30px;
}
.fmwe-ch-widget-name {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  color: currentColor;
  font-size: 9px;
  font-weight: 800;
  line-height: 1.12;
  text-align: center;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.fmwe-ch-el-scroll { position: relative; min-width: 0; padding-block: 3px; }
.fmwe-ch-el-scroll::before,
.fmwe-ch-el-scroll::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 3;
  width: 34px;
  opacity: 0;
  pointer-events: none;
  transition: opacity .14s ease;
}
.fmwe-ch-el-scroll::before { left: 0; background: linear-gradient(90deg, #fff 8%, rgba(255,255,255,0)); }
.fmwe-ch-el-scroll::after { right: 0; background: linear-gradient(270deg, #fff 8%, rgba(255,255,255,0)); }
.fmwe-ch-el-scroll.can-left::before,
.fmwe-ch-el-scroll.can-right::after { opacity: 1; }
.fmwe-ch-shelf-arrow {
  position: absolute;
  top: 50%;
  z-index: 4;
  display: none;
  place-items: center;
  width: 24px;
  height: 32px;
  padding: 0;
  border: 1px solid #e4e7ec;
  border-radius: 999px;
  background: rgba(255,255,255,.94);
  color: #475467;
  box-shadow: 0 3px 10px rgba(16,24,40,.14);
  transform: translateY(-50%);
  cursor: pointer;
}
.fmwe-ch-shelf-arrow.left { left: 3px; }
.fmwe-ch-shelf-arrow.right { right: 3px; }
.fmwe-ch-el-scroll.can-left .fmwe-ch-shelf-arrow.left,
.fmwe-ch-el-scroll.can-right .fmwe-ch-shelf-arrow.right { display: grid; }
.fmwe-ch-shelf-arrow:hover { color: var(--fmwe-primary); }
.fmwe-ch-el {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 56px;
  min-width: 0;
  overflow: visible;
  box-sizing: border-box;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  scroll-snap-align: start;
  transition: transform .1s ease;
}
.fmwe-ch-el[data-ch-el-span="2"] { grid-column: span 2; }
.fmwe-ch-el[data-ch-el-span="3"] { grid-column: span 3; }
.fmwe-ch-el[data-ch-el-span="4"] { grid-column: span 4; }
.fmwe-ch-el:hover { background: transparent; }
.fmwe-ch-el:active { transform: scale(0.98); }
.fmwe-ch-el > svg,
.fmwe-ch-el > .ic,
.fmwe-ch-el > .fmwe-ch-btnsample {
  transform: scale(.96);
  transition: transform .12s ease, filter .12s ease;
  transform-origin: center;
}
.fmwe-ch-el:hover > svg,
.fmwe-ch-el:hover > .ic,
.fmwe-ch-el:hover > .fmwe-ch-btnsample { transform: scale(1.03); filter: drop-shadow(0 3px 4px rgba(16,24,40,.14)); }
.fmwe-ch-el svg { display: block; width: 100%; height: 100%; max-width: none; max-height: none; }
.fmwe-ch-el .ic { display: grid; place-items: center; width: 100%; height: 100%; font-size: 38px; color: #475467; line-height: 1; }
.fmwe-ch-btnsample {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: auto;
  aspect-ratio: var(--fmwe-button-aspect, 170 / 44);
  min-width: 0;
  max-width: none;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0 12px;
  border-radius: var(--fmwe-button-radius, 8px);
  background: var(--fmwe-button-fill, var(--fmwe-primary, #2563eb));
  color: var(--fmwe-button-color, #fff);
  box-shadow: inset 0 0 0 var(--fmwe-button-stroke-width, 0) var(--fmwe-button-stroke-color, transparent);
  font-family: var(--fmwe-button-font, var(--fm-font-body, var(--fm-body-font, inherit)));
  font-size: 12.5px;
  font-weight: var(--fmwe-button-weight, 500);
  line-height: 1.2;
  text-align: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none; /* clicks land on the button cell */
}
.fmwe-ch-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: #667085;
  font-size: 11.5px;
  font-weight: 850;
  cursor: pointer;
  padding: 2px 0 8px;
}
.fmwe-ch-back:hover { color: var(--fmwe-primary); }

/* text styles */
.fmwe-ch-textstyles { display: flex; flex-direction: column; gap: 8px; }
.fmwe-ch-textstyle {
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  padding: 12px 14px;
  text-align: left;
  color: #101828;
  cursor: pointer;
  transition: border-color .12s ease;
}
.fmwe-ch-textstyle:hover { border-color: var(--fmwe-primary); }
.fmwe-ch-textstyle.heading { font-size: 21px; font-weight: 900; letter-spacing: -.01em; }
.fmwe-ch-textstyle.subheading { font-size: 15px; font-weight: 800; }
.fmwe-ch-textstyle.body { font-size: 12px; font-weight: 500; }

/* brand */
.fmwe-ch-brandlogo {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 74px;
  border: 1px solid #e4e7ec;
  border-radius: 11px;
  background: #f8f9fb;
  margin-bottom: 6px;
  padding: 12px;
}
.fmwe-ch-brandlogo img.cp-logo, .fmwe-ch-brandlogo img { max-height: 52px; max-width: 80%; object-fit: contain; }
.fmwe-ch-brandlogo .cp-logo-fallback {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--fmwe-tint);
  color: var(--fmwe-primary);
  display: grid;
  place-items: center;
  font-size: 19px;
  font-weight: 950;
}
.fmwe-ch-swatches { display: flex; flex-wrap: wrap; gap: 9px; margin: 2px 0 6px; }
.fmwe-ch-swatch {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid rgba(16, 24, 40, .12);
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .4);
  transition: transform .1s ease;
  padding: 0;
}
.fmwe-ch-swatch:hover { transform: scale(1.08); }
.fmwe-ch-swatch.active { outline: 2px solid var(--fmwe-primary); outline-offset: 2px; }
.fmwe-ch-altlogos { display: flex; flex-wrap: wrap; gap: 8px; }
.fmwe-ch-altlogos .alt {
  width: 84px;
  height: 56px;
  border: 1px solid #e4e7ec;
  border-radius: 9px;
  background: #f8f9fb;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.fmwe-ch-altlogos .alt img { max-width: 90%; max-height: 80%; object-fit: contain; }

/* uploads */
.fmwe-ch-subtabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid #eef0f4;
  margin: 10px 0 12px;
}
.fmwe-ch-subtabs button {
  border: 0;
  background: transparent;
  padding: 7px 11px 9px;
  font-size: 11.5px;
  font-weight: 850;
  color: #667085;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.fmwe-ch-subtabs button.active { color: var(--fmwe-primary); border-bottom-color: var(--fmwe-primary); }
.fmwe-ch-upgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.fmwe-ch-upthumb {
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #f2f4f7;
  overflow: hidden;
  height: 108px;
  padding: 0;
  cursor: pointer;
  transition: border-color .12s ease;
}
.fmwe-ch-upthumb:hover { border-color: var(--fmwe-primary); }
.fmwe-ch-upthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fmwe-ch-video-thumb { width: 100%; height: 100%; min-height: 92px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; background: linear-gradient(145deg,#111827,#344054); color: #fff; padding: 8px; box-sizing: border-box; }
.fmwe-ch-video-thumb i { font-size: 25px; }
.fmwe-ch-video-thumb small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.fmwe-ch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 34px 16px;
  border: 1px dashed #e4e7ec;
  border-radius: 11px;
  color: #98a2b3;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}
.fmwe-ch-empty i { font-size: 22px; color: #c2c9d4; }

/* ---- elements panel: flat collapsible groups ---- */
.fmwe-ch-elgroup { margin: 2px 0 14px; }
.fmwe-ch-elgroup-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 6px 2px 8px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: #667085;
  cursor: pointer;
}
.fmwe-ch-elgroup-head:hover { color: #101828; }
.fmwe-ch-elgroup-head > i:first-child { color: var(--fmwe-primary); font-size: 11px; width: 14px; text-align: center; }
.fmwe-ch-elgroup-head .count {
  background: #f2f4f7;
  color: #667085;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 9.5px;
}
.fmwe-ch-elgroup-head .chev { margin-left: auto; color: #98a2b3; transition: transform .15s ease; }
.fmwe-ch-elgroup.collapsed .chev { transform: rotate(-90deg); }
.fmwe-ch-elgroup.collapsed [data-ch-el-group-items] { display: none; }

/* ---- media panel: project search rows ---- */
.fmwe-ch-projlist { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 10px; }
.fmwe-ch-projrow {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  padding: 9px 11px;
  font-size: 12px;
  font-weight: 800;
  color: #344054;
  cursor: pointer;
  text-align: left;
  transition: border-color .12s ease, color .12s ease;
}
.fmwe-ch-projrow:hover { border-color: var(--fmwe-primary); color: var(--fmwe-primary); }
.fmwe-ch-projrow > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmwe-ch-projrow .chev { color: #98a2b3; font-size: 10px; }
.fmwe-ch-altlogos button.alt { cursor: pointer; padding: 0; transition: border-color .12s ease; }
.fmwe-ch-altlogos button.alt:hover { border-color: var(--fmwe-primary); }
/* ---- drag-from-panel ghost + image-fill drop highlight ---- */
.fmwe-drag-ghost {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2147483390;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border-radius: 10px;
  border: 1px solid #e4e7ec;
  background: #fff;
  color: #344054;
  font-size: 11.5px;
  font-weight: 850;
  white-space: nowrap;
  max-width: 190px;
  overflow: hidden;
  box-shadow: 0 14px 30px rgba(16, 24, 40, .2);
}
.fmwe-drag-ghost i { color: var(--primary, #d93025); }
.fmwe-fill-target { outline: 3px solid var(--primary, #2563eb) !important; outline-offset: -1px; }
.fmwe-fill-target-box { position:fixed;z-index:9490;pointer-events:none;border:3px solid var(--primary,#2563eb);background:color-mix(in srgb,var(--primary,#2563eb) 8%,transparent);box-sizing:border-box; }
/* ---- slim markup dock (mirrors the photo viewer's markup dock) ---- */
.fmwe-mkdock {
  position: absolute;
  left: 10px;
  top: 12px;
  /* Above the doc-editor's .fmde-overlay (z 500) so the dock stays clickable. */
  z-index: 640;
  width: 58px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, .08);
  background: rgba(255, 255, 255, .92);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 34px rgba(15, 23, 42, .12);
}
.fmwe-mkdock-btn {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, .08);
  background: rgba(255, 255, 255, .94);
  color: #475467;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: .18s ease;
}
.fmwe-mkdock-btn:hover { background: #fff; color: #101828; transform: translateY(-1px); }
.fmwe-mkdock-btn.active,
.fmwe-mkdock-btn.done:not(:disabled):hover {
  background: var(--fmwe-primary-raw);
  border-color: var(--fmwe-primary-raw);
  color: var(--fmwe-on-primary);
}
.fmwe-mkdock-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.fmwe-mkdock-btn .dot { width: 20px; height: 20px; border-radius: 8px; border: 1px solid rgba(15, 23, 42, .14); }
.fmwe-mkdock-sep { width: 26px; height: 1px; background: #eef0f4; }
.fmwe-mkdock-colorwrap { position: relative; }
.fmwe-mkdock-pop {
  position: absolute;
  left: 52px;
  top: 0;
  z-index: 641;
  padding: 12px;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, .08);
  background: rgba(255, 255, 255, .97);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 34px rgba(15, 23, 42, .12);
  display: none;
}
.fmwe-mkdock-pop.visible { display: block; }
.fmwe-mkdock-pop .r-proposal-markup-colorbox,
.fmwe-mkdock-pop .r-proposal-markup-recent { display: grid; grid-template-columns: repeat(6, 28px); gap: 8px; }
.fmwe-mkdock-pop .r-proposal-markup-recent { margin-bottom: 8px; min-height: 28px; }
.fmwe-mkdock-pop .r-proposal-markup-recent.empty { display: none; }
.fmwe-mkdock-pop .r-proposal-markup-color {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(15, 23, 42, .08);
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .45);
}
.fmwe-mkdock-pop .r-proposal-markup-color.custom {
  position: relative;
  background: conic-gradient(#ff6b6b, #ffd166, #06d6a0, #118ab2, #9b5de5, #ff6b6b);
}
.fmwe-mkdock-pop .r-proposal-markup-color input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
/* ---- section-management chrome ---- */
.fmwe-sec-actions {
  position: absolute;
  /* Above the doc-editor's .fmde-overlay (z 500) — it spans the canvas and
     would otherwise swallow every click on the section chrome. */
  z-index: 620;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Hidden until positionSectionChrome() has real coordinates — a fresh
     chrome otherwise flashes at the canvas's top-left corner. */
  visibility: hidden;
}
.fmwe-sec-actions button {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  border: 1px solid #e4e7ec;
  background: #fff;
  color: #475467;
  display: grid;
  place-items: center;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(16, 24, 40, .1);
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.fmwe-sec-actions button:hover { color: #101828; border-color: #d6dae2; }
.fmwe-sec-actions button.active { color: var(--fmwe-primary); border-color: var(--fmwe-primary); background: var(--fmwe-tint); }
.fmwe-sec-actions button:disabled { opacity:.38;cursor:default; }
.fmwe-sec-actions button.danger:hover { color: #b42318; border-color: #fecdca; background: #fef3f2; }
.fmwe-sec-mobile-actions { position:absolute;z-index:620;display:flex;flex-direction:column;gap:6px;visibility:hidden; }
.fmwe-sec-mobile-actions button { width:34px;height:34px;border-radius:11px;border:1px solid #e4e7ec;background:#fff;color:#475467;display:grid;place-items:center;font-size:12px;cursor:pointer;box-shadow:0 8px 18px rgba(16,24,40,.1);transition:color .12s ease,border-color .12s ease,background .12s ease; }
.fmwe-sec-mobile-actions button:hover,.fmwe-sec-mobile-actions button.active { color:var(--fmwe-primary);border-color:var(--fmwe-primary);background:var(--fmwe-tint); }
.fmwe-sec-width-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: 270px;
  padding: 13px 14px;
  border: 1px solid #e4e7ec;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 16px 40px rgba(16, 24, 40, .18);
  color: #344054;
  font: 600 11.5px/1.35 Montserrat, Inter, ui-sans-serif, system-ui, sans-serif;
}
.fmwe-sec-width-pop.hidden { display: none; }
.fmwe-sec-width-head,.fmwe-sec-width-row { display:flex;align-items:center;justify-content:space-between;gap:10px; }
.fmwe-sec-width-head { margin-bottom:12px;font-size:12px;font-weight:850;color:#101828; }
.fmwe-sec-width-row + .fmwe-sec-width-row { margin-top:12px; }
.fmwe-sec-width-row label { flex:1;min-width:0; }
.fmwe-sec-width-row output { min-width:52px;text-align:right;font-variant-numeric:tabular-nums;color:#475467; }
.fmwe-sec-width-pop output.snapped { color:var(--fmwe-primary);font-weight:850; }
.fmwe-sec-width-pop input[type="range"] { width:100%;margin:7px 0 0;accent-color:var(--fmwe-primary); }
.fmwe-sec-width-toggle { width:36px!important;height:20px!important;border:0!important;border-radius:999px!important;background:#d0d5dd!important;box-shadow:none!important;position:relative; }
.fmwe-sec-width-toggle::after { content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.25);transition:left .14s ease; }
.fmwe-sec-width-toggle.active { background:var(--fmwe-primary)!important; }
.fmwe-sec-width-toggle.active::after { left:18px; }
.fmwe-sec-width-max.disabled { opacity:.45;pointer-events:none; }
.fmwe-sec-pill {
  position: absolute;
  z-index: 621;
  visibility: hidden; /* shown once positioned (see .fmwe-sec-actions) */
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  border: 1px solid #e4e7ec;
  background: #fff;
  box-shadow: 0 10px 26px rgba(16, 24, 40, .14);
}
.fmwe-sec-pill > button {
  border: 0;
  background: transparent;
  border-radius: 999px;
  min-height: 28px;
  padding: 0 12px;
  font-size: 11.5px;
  font-weight: 850;
  color: #344054;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.fmwe-sec-pill > button:hover { background: #f4f5f8; color: #101828; }
.fmwe-sec-pill > button.active { background: var(--fmwe-tint); color: var(--fmwe-primary); }
.fmwe-sec-pill > button i { font-size: 11px; }
.fmwe-sec-pill.below .fmwe-sec-pop,
.fmwe-sec-pill.below .fmwe-sec-width-pop {
  top: auto;
  bottom: calc(100% + 8px);
}
.fmwe-sec-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: 268px;
  background: #fff;
  border: 1px solid #e4e7ec;
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(16, 24, 40, .16);
  padding: 12px 14px;
  text-align: left;
  cursor: default;
}
.fmwe-sec-pop.hidden { display: none; }
.fmwe-sec-layers {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow: auto;
  margin-bottom: 4px;
}
.fmwe-sec-layer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  color: #344054;
}
.fmwe-sec-layer:hover { background: #f4f5f8; }
.fmwe-sec-layer.active { background: var(--fmwe-tint); color: var(--fmwe-primary); }
.fmwe-sec-layer > i { width: 14px; text-align: center; color: #98a2b3; font-size: 11px; }
.fmwe-sec-layer.active > i { color: var(--fmwe-primary); }
.fmwe-sec-layer .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmwe-sec-layer .ops { display: flex; gap: 2px; }
.fmwe-sec-layer .ops button {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #98a2b3;
  cursor: pointer;
  font-size: 10px;
  display: grid;
  place-items: center;
}
.fmwe-sec-layer .ops button:hover { background: #e9ebf0; color: #101828; }
.fmwe-sec-align { display: flex; gap: 6px; }
.fmwe-sec-align .fmwe-btn { flex: 1; justify-content: center; min-height: 30px; }
/* ---- centre column: canvas + under-canvas area ---- */
.fmwe-ch-center {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.fmwe-ch-center .fmwe-editor-canvas { flex: 1; }
.fmwe-ch-canvas-column {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.fmwe-ch-canvas-column > .fmde-canvas { flex: 1 1 auto; min-height: 0; min-width: 0; }
.fmwe-device-layout {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
  padding: 14px;
  background: #eef1f5;
}
.fmwe-device-tools {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 12;
  display: grid;
  gap: 6px;
  width: 142px;
  max-height: calc(100% - 28px);
  overflow-y: auto;
}
.fmwe-device-tool,.fmwe-device-preset {
  min-height: 34px;
  border: 1px solid #d0d5dd;
  border-radius: 8px;
  background: #fff;
  color: #344054;
  font: 700 11px/1.2 Montserrat,Inter,ui-sans-serif,sans-serif;
  box-shadow: 0 1px 2px rgba(16,24,40,.05);
}
.fmwe-device-tool { display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:0 10px;cursor:pointer; }
.fmwe-device-tool:hover { color:var(--fmwe-primary);border-color:var(--fmwe-primary);transform:translateX(2px); }
.fmwe-device-tool i { width:14px;text-align:center; }
.fmwe-device-preset { width:100%;padding:0 26px 0 9px;cursor:pointer; }
.fmwe-device-zoomrow { display:grid;grid-template-columns:1fr 1fr;gap:6px; }
.fmwe-device-zoomrow .fmwe-device-tool { justify-content:center;padding:0; }
.fmwe-device-readout { text-align:center;color:#667085;font:700 10px Montserrat,Inter,sans-serif; }
.fmwe-device-frame {
  position: relative;
  flex: 0 0 auto;
  /* Auto cross-axis margins split any unused fitted-preview height evenly.
     When a manually zoomed/custom frame overflows they collapse to zero, so
     the top remains reachable instead of being centered into negative space. */
  margin-block: auto;
  border: 7px solid #202630;
  border-radius: 24px;
  background: #202630;
  box-shadow: 0 16px 38px rgba(15,23,42,.24);
}
.fmwe-device-frame::before { content:"";position:absolute;z-index:3;top:3px;left:50%;width:44px;height:4px;transform:translateX(-50%);border-radius:999px;background:#555d69;pointer-events:none; }
.fmwe-device-screen { position:absolute;inset:7px;overflow:hidden;border-radius:16px;background:#fff; }
.fmwe-device-screen > .fmde-canvas { position:absolute;left:0;top:0;max-width:none;transform-origin:top left; }
.fmwe-device-frame.custom .fmwe-device-resize { display:block; }
.fmwe-device-resize { display:none;position:absolute;z-index:8;touch-action:none; }
.fmwe-device-resize.e { top:18px;right:-9px;bottom:18px;width:12px;cursor:ew-resize; }
.fmwe-device-resize.s { left:18px;right:18px;bottom:-9px;height:12px;cursor:ns-resize; }
.fmwe-device-resize.se { right:-10px;bottom:-10px;width:18px;height:18px;border:2px solid #fff;border-radius:50%;background:var(--fmwe-primary);cursor:nwse-resize;box-shadow:0 2px 6px rgba(15,23,42,.3); }
.fmve-device-mobile .fmde-stage { padding:0!important;gap:0!important; }
.fmve-device-mobile .fmwe-site-chrome-preview { width:100%!important; }
.fmve-device-mobile .fmwe-device-screen > .fmde-canvas { overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none; }
.fmve-device-mobile .fmwe-device-screen > .fmde-canvas::-webkit-scrollbar { width:0;height:0; }
.fmve-device-mobile .fmdoc-view { overflow-x:clip!important;overflow-y:visible!important; }
/* Mobile preview has one zoom: the device controls scale frame + contents.
   Hide the inner editor zoom so it cannot imply or create a second scale. */
.fmve-device-mobile .fmde-editor-zoom { display:none!important; }
/* Phone-width authoring chrome stays usable without consuming a large share
   of the simulated screen. Geometry remains host-owned and unscaled. */
.fmve-device-mobile .fmwe-sec-actions { gap:4px; }
.fmve-device-mobile .fmwe-sec-actions button { width:28px;height:28px;border-radius:9px;font-size:10px; }
.fmve-device-mobile .fmwe-sec-mobile-actions { gap:4px; }
.fmve-device-mobile .fmwe-sec-mobile-actions button { width:28px;height:28px;border-radius:9px;font-size:10px; }
.fmve-device-mobile .fmwe-sec-pill { gap:0;padding:2px; }
.fmve-device-mobile .fmwe-sec-pill > button { min-height:23px;padding:0 7px;font-size:9px;gap:4px; }
.fmve-device-mobile .fmwe-sec-pill > button i { font-size:9px; }
.fmve-device-mobile .fmde-handle { width:calc(8*var(--fmde-px,1px));height:calc(8*var(--fmde-px,1px)); }
.fmve-device-mobile .fmde-handle-n,
.fmve-device-mobile .fmde-handle-s { width:calc(13*var(--fmde-px,1px));height:calc(5*var(--fmde-px,1px)); }
.fmve-device-mobile .fmde-handle-e,
.fmve-device-mobile .fmde-handle-w { width:calc(5*var(--fmde-px,1px));height:calc(13*var(--fmde-px,1px)); }
.fmwe-device-calibration {
  display:grid;
  gap:7px;
  padding:9px;
  border:1px solid #d0d5dd;
  border-radius:8px;
  background:#fff;
  color:#475467;
  box-shadow:0 5px 14px rgba(16,24,40,.12);
  font:600 10px/1.35 Montserrat,Inter,ui-sans-serif,sans-serif;
}
.fmwe-device-calibration[hidden] { display:none; }
.fmwe-device-calibration label { display:flex;align-items:center;justify-content:space-between;gap:6px;color:#344054;font-weight:800; }
.fmwe-device-calibration input { width:100%;accent-color:var(--fmwe-primary); }
.fmwe-device-calibration button { border:0;background:transparent;color:var(--fmwe-primary);font:800 10px Montserrat,Inter,sans-serif;cursor:pointer; }
.fmwe-ch-under {
  flex: 0 0 auto;
  padding: 8px 12px 9px;
  background: #fbfbfd;
  border-top: 1px solid #eef0f4;
}
.fmwe-ch-addsection {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  border: 1px dashed #d0d5dd;
  border-radius: 999px;
  background: #fff;
  color: #667085;
  font-size: 12px;
  font-weight: 850;
  cursor: pointer;
  transition: color .12s ease, border-color .12s ease;
}
.fmwe-ch-addsection:hover { color: var(--fmwe-primary); border-color: var(--fmwe-primary); }
.fmwe-ch-pstrip {
  display: flex;
  justify-content: safe center;
  gap: 9px;
  overflow-x: auto;
  padding: 9px 2px 2px;
}
.fmwe-ch-pstrip.hidden { display: none; }
.fmwe-ch-pagecard {
  flex: 0 0 auto;
  width: 104px;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.fmwe-ch-pagecard .thumb {
  position: relative;
  display: block;
  align-self: center;
  width: auto;
  height: 68px;
  max-width: 100%;
  max-height: 68px;
  aspect-ratio: var(--fmwe-page-ratio, 16 / 9);
  border: 2px solid #e4e7ec;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  cursor: pointer;
}
.fmwe-ch-pagecard.active .thumb { border-color: var(--fmwe-primary); box-shadow: 0 0 0 2px var(--fmwe-tint); }
.fmwe-ch-pagecard:hover .thumb { border-color: #c2c9d4; }
.fmwe-ch-pagecard.active:hover .thumb { border-color: var(--fmwe-primary); }
.fmwe-ch-pagecard .thumb .stage { position: absolute; inset: 0; overflow: hidden; pointer-events: none; display:flex; align-items:flex-start; justify-content:center; background:#fff; }
.fmwe-ch-pagecard .thumb .stage .fmdoc-page { flex:0 0 auto; box-shadow:none; }
.fmve-kind-workflow .fmwe-ch-pagecard { width: 82px; }
.fmve-kind-workflow .fmwe-ch-pagecard .thumb { width: 68px; height: 68px; max-width: 68px; aspect-ratio: 1 / 1; }
.fmve-kind-workflow .fmwe-ch-pagecard .thumb .stage { align-items: center; justify-content: center; }
.fmwe-ch-pagecard .thumb.plus {
  display: grid;
  place-items: center;
  color: #98a2b3;
  font-size: 14px;
  border-style: dashed;
}
.fmwe-ch-pagecard:hover .thumb.plus { color: var(--fmwe-primary); }
.fmwe-ch-pagecard .label {
  font-size: 10px;
  font-weight: 800;
  color: #667085;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
.fmwe-ch-pagecard.active .label { color: var(--fmwe-primary); }
.fmwe-ch-page-more {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  display: none;
  place-items: center;
  width: 24px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--fmwe-primary);
  color: #fff;
  box-shadow: 0 2px 7px rgba(16, 24, 40, .2);
  cursor: pointer;
  font-size: 11px;
}
.fmwe-ch-pagecard:hover .fmwe-ch-page-more,
.fmwe-ch-pagecard.active .fmwe-ch-page-more,
.fmwe-ch-page-more:focus-visible { display: grid; }
.fmwe-ch-page-more:hover { filter: brightness(.94); }
.fmwe-page-menu {
  position: fixed;
  z-index: 2147483425;
  width: min(286px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 24px));
  overflow-y: auto;
  padding: 10px;
  border: 1px solid #e4e7ec;
  border-radius: 14px;
  background: #fff;
  color: #101828;
  box-shadow: 0 18px 50px rgba(16, 24, 40, .2);
  font-family: Montserrat, Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
}
.fmwe-page-menu-head { display: flex; align-items: center; gap: 5px; padding: 0 2px 6px; }
.fmwe-page-menu-title {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #101828;
  font: inherit;
  font-size: 16px;
  font-weight: 800;
}
.fmwe-page-menu-title:hover,
.fmwe-page-menu-title:focus { border-color: #d0d5dd; outline: none; background: #f9fafb; }
.fmwe-page-menu-edit { flex: 0 0 auto; width: 26px; height: 26px; border: 0; border-radius: 7px; background: transparent; color: #344054; cursor: pointer; }
.fmwe-page-menu-edit:hover { background: #f2f4f7; }
.fmwe-page-menu-kind { display: flex; align-items: center; gap: 7px; padding: 0 7px 8px; color: #667085; font-size: 11.5px; }
.fmwe-page-menu-kind i { color: var(--fmwe-primary); }
.fmwe-page-menu-sep { height: 1px; margin: 0 3px 5px; background: #e4e7ec; }
.fmwe-page-menu-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 34px;
  padding: 4px 7px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #101828;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.fmwe-page-menu-row:hover:not(:disabled) { background: #f2f4f7; }
.fmwe-page-menu-row:disabled { opacity: .4; cursor: default; }
.fmwe-page-menu-row > i { width: 17px; text-align: center; font-size: 14px; }
.fmwe-page-menu-row .shortcut { margin-left: auto; padding: 3px 6px; border-radius: 6px; background: #f2f4f7; color: #475467; font-size: 9.5px; }
.fmwe-page-menu-row.danger { color: #b42318; }

/* ---- bottom bar ---- */
.fmwe-ch-bottom {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 12px;
  background: #fff;
  border-top: 1px solid #e4e7ec;
  z-index: 22;
}
.fmwe-ch-bbtn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  min-height: 27px;
  padding: 0 9px;
  font-size: 11.5px;
  font-weight: 850;
  color: #475467;
  cursor: pointer;
  white-space: nowrap;
}
.fmwe-ch-bbtn:hover { background: #f4f5f8; color: #101828; }
.fmwe-ch-bbtn.active { color: var(--fmwe-primary); background: var(--fmwe-tint); }
.fmwe-ch-bbtn.icon { padding: 0 7px; }
.fmwe-ch-bspacer { flex: 1; }
.fmwe-ch-bsep { width: 1px; height: 18px; background: #eef0f4; }
.fmwe-ch-zoom { width: 130px; accent-color: var(--fmwe-primary-raw); }
.fmwe-ch-zoomval {
  min-width: 40px;
  text-align: right;
  font-size: 11px;
  font-weight: 850;
  color: #667085;
  font-variant-numeric: tabular-nums;
}

/* ---- notes drawer ---- */
.fmwe-ch-notes {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 38px;
  background: #fff;
  border-top: 1px solid #e4e7ec;
  box-shadow: 0 -14px 30px rgba(16, 24, 40, .08);
  padding: 12px 16px 14px;
  z-index: 26;
}
.fmwe-ch-notes.hidden { display: none; }
.fmwe-ch-notes .head { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
.fmwe-ch-notes .head strong {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 900;
}
.fmwe-ch-notes .head strong i { color: var(--fmwe-primary); }
.fmwe-ch-notes .head .state { font-size: 11px; font-weight: 850; color: #067647; }
.fmwe-ch-notes .head .fmwe-icon-btn { margin-left: auto; width: 26px; height: 26px; }
.fmwe-ch-notes textarea {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  border: 1px solid #d6dae2;
  border-radius: 10px;
  padding: 9px 11px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.5;
  color: #101828;
}
.fmwe-ch-notes textarea:focus { outline: none; border-color: var(--fmwe-primary); box-shadow: 0 0 0 3px var(--fmwe-tint); }
/* ---- markup session ---- */
/* PhotoMarkup mounts inside this host over .fmdoc-page. The markup library
   only injects its CSS when the media viewer opens, and scopes activation to
   .fm-photo-modal — so the essential layer styles are replicated here,
   scoped to the web editor's markup host. */
.fmwe-markup-host {
  position: absolute;
  left: 0;
  top: 0;
  /* width/height set inline in pt to match the markup node's frame exactly
     (fluid pages render .fmdoc-page at 0 CSS width, so inset:0 collapses) */
  z-index: 950;
}
.fmwe-markup-host .r-proposal-markupdock { display: none; }
.fmwe-markup-host .fm-photo-markup-layer {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
}
.fmwe-markup-host .fm-photo-markup-layer svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.fmwe-markup-host .fm-photo-markup-path { fill: none; stroke: #111; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.fmwe-markup-host .fm-photo-markup-arrow { fill: none; stroke-linecap: round; }
.fmwe-markup-host .fm-photo-markup-text {
  position: absolute;
  min-width: 40px;
  min-height: 20px;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, .72);
  color: #111;
  font-size: 13px;
  line-height: 1.2;
  white-space: pre-wrap;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(15, 23, 42, .08);
}
.fmwe-markup-host .fm-photo-markup-text[contenteditable="true"] { outline: 0; cursor: text; overflow-wrap: anywhere; }
.fmwe-markup-host .fm-photo-markup-handle {
  position: absolute;
  width: 21px;
  height: 21px;
  border-radius: 999px;
  background: #fff;
  border: 2px solid var(--fmwe-primary-raw, #d93025);
  box-shadow: 0 6px 12px rgba(15, 23, 42, .14);
  transform: translate(-50%, -50%);
  display: block;
  cursor: grab;
  z-index: 12;
  opacity: .55;
}
.fmwe-markup-host .fm-photo-markup-text-size {
  position: absolute;
  width: 21px;
  height: 21px;
  border-radius: 5px;
  background: #fff;
  border: 2px solid var(--fmwe-primary-raw, #d93025);
  box-shadow: 0 6px 12px rgba(15, 23, 42, .14);
  display: block;
  cursor: nwse-resize;
  z-index: 12;
  opacity: .55;
}
.fmwe-markup-host .fm-photo-markup-handle:hover,
.fmwe-markup-host .fm-photo-markup-text-size:hover { opacity: 1; }
/* While a markup session is live the editor's own pointer layer stands down. */
.fmve-chrome.fmwe-markup-live .fmde-overlay { pointer-events: none !important; }
.fmve-chrome.fmwe-markup-live .fmde-canvas { cursor: crosshair; }

/* ---- built-in confirm dialog (used when chrome.confirm is not supplied) */
.fmve-confirm-back {
  position: fixed;
  inset: 0;
  z-index: 2147483380;
  background: rgba(16, 24, 40, .45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px;
  color: #101828;
  font-size: 13px;
}
.fmve-confirm {
  width: min(440px, 100%);
  background: #fff;
  border-radius: 14px;
  padding: 20px 22px 22px;
  box-shadow: 0 24px 60px rgba(16, 24, 40, .25);
}
.fmve-confirm h2 {
  margin: 0 0 10px;
  font-size: 15.5px;
  font-weight: 900;
  letter-spacing: -.01em;
  display: flex;
  align-items: center;
  gap: 9px;
}
.fmve-confirm h2 i { color: var(--fmwe-primary); }
.fmve-confirm p { margin: 0 0 14px; color: #667085; font-size: 12px; font-weight: 700; line-height: 1.55; }
.fmve-confirm .foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.fmve-confirm .foot button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 13px;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  background: #fff;
  color: #344054;
  font-size: 12px;
  font-weight: 850;
  cursor: pointer;
}
.fmve-confirm .foot button.primary {
  background: var(--fmwe-primary-raw);
  border-color: var(--fmwe-primary-raw);
  color: var(--fmwe-on-primary);
}
.fmve-confirm .foot button.danger { color: #b42318; border-color: #fecdca; }
.fmve-confirm .foot button.danger:hover { background: #fef3f2; }

@media (max-width: 760px) {
  .fmwe-ch-panel { flex-basis: 300px; max-width: 300px; }
  .fmwe-ch-panel.hidden { flex-basis: 0; max-width: 0; }
  .fmwe-ch-panel-body { width: 300px; flex-basis: 300px; }
}
`;

  function ensureStyles(){
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  // ================================================================= mount
  /**
   * FMVisualEditor.mount(container, options) -> handle
   *
   * Every FMDocEditor option passes through untouched (document, profile,
   * mode, allowedModes, catalog, media, resolveScope, themeContext,
   * widgetData, widgetContext, onChange, onCommand, sidePanels,
   * documentActions, versionsApi, collab, editPolicy, dataPreview,
   * viewportWidth, collaboration, agentEnabled, onDictate, …).
   *
   * options.chrome = {
   *   contentKind: 'web' | 'workflow' | 'document', // default 'document'
   *   tabs: ['templates', …],                   // subset of the 7; default all
   *   customTabs: [{ id, label, icon, order?, render(host, api) }],
   *                                                // wrapper-owned additions to the shared left rail
   *   state: {},              // optional external chrome-state carrier (persists across remounts; also how hosts expose test hooks)
   *   orgId, orgName,         // platform context (default: Portal/__APP globals)
   *   designWidthPt: number|fn,                 // canvas design width (default: doc paper width, else 720 for views / 612 for documents)
   *   toast(message, ok), confirm(message, opts) -> Promise<bool>,
   *   banner: '<html>' | { html },              // optional host banner above the canvas
   *   templates: { groups(helpers) -> [{id,label,description,entries}] },   // default: built-in section registry
   *   elements: { widgets(helpers) -> [items] },                            // host-specific items appended to the shared Widgets tab/group
   *   pages: 'document' | { list(), current(), select(id), add?(), grid?() } | null,
   *   device: true|false,                       // enables handle.setDevice/getDevice (mobile 390pt / desktop)
   *   addSection: true|false|'auto',            // 'auto' (default): only when the mounted doc kind === 'view'
   *   markup: { persist?(items, session) } | null,   // null removes the tab; default persists into a page-level markup_overlay node
   *   brand: { branding } | null,               // null removes the tab; default org branding
   *   qr: { defaultUrl } | null,                // null removes the tab
   *   notes: { get(), save(text, setStatus) } | null,   // bottom-bar notes hook; null (default) hides Notes
   *   upload: { ownerType, ownerId, collection },       // media-upload owner metadata
   *   fullscreenEl: element | fn                // what the ⤢ button fullscreens (default: the chrome root)
   * }
   */
  function mount(container, options = {}){
    ensureStyles();
    if (!container) throw new Error('FMVisualEditor.mount: container required');
    if (!global.FMDocEditor || typeof global.FMDocEditor.mount !== 'function') {
      throw new Error('FMVisualEditor.mount: the FMDocEditor library is not loaded.');
    }
    const opts = objectValue(options);
    const chromeOpts = objectValue(opts.chrome);
    const requestedContentKind = cleanText(chromeOpts.contentKind);
    const contentKind = ['web', 'workflow'].includes(requestedContentKind) ? requestedContentKind : 'document';

    // ---- chrome state (survives remounts when the host passes a carrier;
    // the carrier is also how hosts expose the chrome to their test hooks) --
    const state = chromeOpts.state && typeof chromeOpts.state === 'object' ? chromeOpts.state : {};
    const stateDefaults = {
      chromeTab: '',                 // '' closed | templates|elements|media|text|brand|markup|qr
      chromeSearch: {},              // per-tab search text
      elementGroupsCollapsed: null,  // Set of collapsed Elements group ids (persisted)
      templateGroupsCollapsed: null,
      uploadsSubtab: 'images',
      uploadsList: null,
      uploadsLoading: false,
      uploadsError: null,
      mediaProjects: null,           // cached projects.list result [{id,name}]
      mediaProjectsLoading: false,
      mediaProject: null,            // { id, name } while browsing a project's photos
      mediaProjectPhotos: null,
      mediaProjectPhotosLoading: false,
      brandKit: null,                // { branding, logo, media } cache
      brandKitLoading: false,
      sectionChromeId: '',           // selected root-section node id ('' = hidden)
      sectionPopover: '',            // '' | 'position'
      sectionWidthOpen: false,
      dragGhost: null,
      notesOpen: false,
      notesTimer: 0,
      markupSession: null,           // { instance, overlay, tool, color, nodeId, timer, pendingItems }
      markupColor: '#d93025',
      chromeThumbHandles: [],
      chromePageThumbHandles: [],
      zoomTimer: 0,
      devicePreview: null
    };
    Object.keys(stateDefaults).forEach((key) => {
      if (state[key] === undefined) state[key] = stateDefaults[key];
    });
    if (state.pagesStripOpen === undefined) state.pagesStripOpen = lsGet(PAGES_STRIP_KEY) !== 'closed';

    let destroyed = false;
    let editorHandle = null;
    let resizeObs = null;
    let resizeObservedSectionEl = null;
    let deviceLayout = null;
    let deviceResizeObserver = null;

    // ---------------------------------------------------------- adapters
    const orgId = () => firstText(chromeOpts.orgId, global.Portal?.cfg?.userOrgId, global.__APP?.userOrgId, global.__APP?.orgId);
    const orgName = () => firstText(chromeOpts.orgName, global.__APP?.orgName, global.Portal?.cfg?.orgName, 'Your Company');
    const orgBranding = () => {
      const provided = objectValue(objectValue(chromeOpts.brand).branding);
      return Object.keys(provided).length ? provided : defaultBranding();
    };
    const brandPrimary = () => brandPrimaryOf(orgBranding());
    const toast = (message, ok) => {
      if (typeof chromeOpts.toast === 'function') { chromeOpts.toast(message, ok !== false); return; }
      try { global.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("visual-editor","m_e5fc53b0655b30","Editor") ?? "Editor"), message, ok !== false); } catch (e) { /* silent */ }
    };
    const confirmFn = typeof chromeOpts.confirm === 'function' ? chromeOpts.confirm : builtinConfirm;
    const mediaUrl = (ref, variant) => {
      const fn = objectValue(opts.media).url;
      if (typeof fn === 'function') { try { return fn(ref, variant); } catch (e) { return ''; } }
      const obj = typeof ref === 'string' ? { media_id: ref } : objectValue(ref);
      if (obj.url) return obj.url;
      if (!global.PlatformAPI?.media?.fileUrl) return '';
      const id = firstText(obj.media_id, obj.id);
      return id ? global.PlatformAPI.media.fileUrl(orgId(), id, variant || obj.variant || 'original') : '';
    };
    const thumbTheme = () => objectValue(opts.themeContext).branding || objectValue(opts.themeContext).overrides
      ? opts.themeContext
      : { branding: orgBranding() };
    const uploadMeta = () => ({
      ownerType: firstText(objectValue(chromeOpts.upload).ownerType, 'visual_editor'),
      ownerId: firstText(objectValue(chromeOpts.upload).ownerId, 'editor'),
      collection: firstText(objectValue(chromeOpts.upload).collection, 'media')
    });

    const docDefaultWidthPt = (() => {
      const document_ = objectValue(opts.document);
      const paper = objectValue(objectValue(objectValue(document_.settings).paper).size);
      return numberValue(paper.w_pt) || (cleanText(document_.kind) === 'view' ? 720 : 612);
    })();
    const designWidthPt = () => {
      const cfg = chromeOpts.designWidthPt;
      if (typeof cfg === 'function') {
        const v = Number(cfg());
        if (Number.isFinite(v) && v > 0) return v;
      }
      const n = Number(cfg);
      if (Number.isFinite(n) && n > 0) return n;
      return docDefaultWidthPt;
    };
    const designWidthPx = () => designWidthPt() * PT_TO_PX;
    const sectionMaxWidthPx = () => {
      const value = Number(chromeOpts.sectionMaxWidthPx);
      return Number.isFinite(value) && value >= 160 ? Math.min(3840, Math.round(value)) : null;
    };
    const constrainSectionWidth = (value) => {
      const sizing = M().normalizeSectionWidth(value);
      const maximum = sectionMaxWidthPx();
      if (maximum === null) return sizing;
      if (chromeOpts.sectionWidthLocked === true) {
        return { ...sizing, width_percent: 100, max_enabled: true, max_width_px: maximum };
      }
      return { ...sizing, max_enabled: true, max_width_px: Math.min(maximum, sizing.max_width_px) };
    };

    const boundTplWidget = (widgetId, frame, widgetOptions = {}) => tplWidget(widgetId, frame, widgetOptions, opts.catalog);
    const boundSections = sectionBuilders(opts.catalog);
    const builtinTemplateGroups = () => [
      { id: 'sections', label: (globalThis.PlatformLanguage?.text("visual-editor","m_6c6dbe9fc5a8cd","Reusable sections") ?? "Reusable sections"), description: (globalThis.PlatformLanguage?.text("visual-editor","m_0e629ae9d4413d","Hero, CTA, gallery, contact and more") ?? "Hero, CTA, gallery, contact and more"), entries: sectionTemplates(opts.catalog) }
    ];
    const adapterHelpers = {
      M: M(),
      catalog: opts.catalog || null,
      builders: { tplText, tplButton, tplSection, tplImage, tplWidget: boundTplWidget },
      sections: boundSections,
      sectionGroups: builtinTemplateGroups(),
      previews: EL_PREVIEWS,
      elSvg,
      PRIMARY_VAR
    };

    const templatesOpts = chromeOpts.templates;
    function templateGroups(){
      const groups = templatesOpts && typeof templatesOpts.groups === 'function'
        ? arrayValue(templatesOpts.groups(adapterHelpers))
        : builtinTemplateGroups();
      return groups
        .map((group) => ({
          ...objectValue(group),
          entries: arrayValue(objectValue(group).entries).filter((entry) => contentKind !== 'document' || cleanText(objectValue(entry).kind) !== 'section')
        }))
        .filter((group) => group.entries.length);
    }
    function templateEntries(){
      const out = [];
      templateGroups().forEach((group) => group.entries.forEach((entry) => out.push(entry)));
      return out;
    }

    // Pages adapter: 'document' (default for contentKind 'document') = a
    // built-in adapter over the mounted doc's pages.
    function documentPagesAdapter(){
      const list = () => {
        const d = editorHandle ? editorHandle.getDocument() : clone(objectValue(opts.document));
        return arrayValue(objectValue(d).pages).map((page, index) => {
          const definition = clone(objectValue(d));
          definition.pages = [clone(objectValue(page))];
          return {
            id: firstText(objectValue(page).id, String(index)),
            title: firstText(objectValue(page).name, `Page ${index + 1}`),
            masterRef: firstText(objectValue(page).master_ref),
            definition
          };
        });
      };
      return {
        list,
        current(){ return firstText(state.fmveActivePageId, (list()[0] || {}).id); },
        select(id){
          const pages = list();
          const index = pages.findIndex((page) => page.id === cleanText(id));
          if (index < 0) return;
          state.fmveActivePageId = pages[index].id;
          const pageEl = root.querySelectorAll('.fmde-stage .fmdoc-page')[index];
          editorHandle?.prepareExplicitScroll?.();
          try { pageEl?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* noop */ }
          renderPagesStrip();
        },
        add(afterId){
          if (!editorReady()) return;
          const document_ = editorHandle.getDocument();
          const after = cleanText(afterId) ? M().findPage(document_, cleanText(afterId)) : null;
          const page = M().createPage('body');
          const res = editorHandle.apply({ type: 'page.insert', page, index: after ? after.index + 1 : undefined });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_06ab2bd77022b4","Could not add a page here.") ?? "Could not add a page here."), false); return; }
          state.fmveActivePageId = page.id;
          renderPagesStrip();
        },
        rename(id, title){
          if (!editorReady()) return;
          const value = cleanText(title);
          if (!value) return;
          const res = editorHandle.apply({ type: 'page.set', page_id: cleanText(id), prop: 'name', value });
          if (res && res.ok === false) toast((globalThis.PlatformLanguage?.text("visual-editor","m_2dfe4d98a587a5","Could not rename this page.") ?? "Could not rename this page."), false);
        },
        removeStyling(id){
          if (!editorReady()) return;
          const res = editorHandle.apply({ type: 'page.set', page_id: cleanText(id), prop: 'master_ref', value: 'none' });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_c2ecb62ee9359a","Could not remove styling from this page.") ?? "Could not remove styling from this page."), false); return; }
          toast((globalThis.PlatformLanguage?.text("visual-editor","m_da9cf11ebf6eb1","Page styling removed.") ?? "Page styling removed."), true);
        },
        copy(id){
          if (!editorReady()) return null;
          const found = M().findPage(editorHandle.getDocument(), cleanText(id));
          return found ? clone(found.page) : null;
        },
        paste(afterId, copiedPage){
          if (!editorReady() || !copiedPage) return;
          const document_ = editorHandle.getDocument();
          const after = M().findPage(document_, cleanText(afterId));
          const page = clone(objectValue(copiedPage));
          page.id = M().generateId('pg');
          page.name = `${firstText(page.name, 'Page')} copy`;
          page.children = M().reassignIds(arrayValue(page.children));
          const res = editorHandle.apply({ type: 'page.insert', page, index: after ? after.index + 1 : undefined });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_2a28864914bf5b","Could not paste this page.") ?? "Could not paste this page."), false); return; }
          state.fmveActivePageId = page.id;
        },
        duplicate(id){
          const copied = this.copy(id);
          if (copied) this.paste(id, copied);
        },
        remove(id){
          if (!editorReady()) return;
          const document_ = editorHandle.getDocument();
          const found = M().findPage(document_, cleanText(id));
          if (!found) return;
          const next = document_.pages[found.index + 1] || document_.pages[found.index - 1];
          const res = editorHandle.apply({ type: 'page.remove', page_id: cleanText(id) });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_f30d197112f2db","Could not delete this page.") ?? "Could not delete this page."), false); return; }
          state.fmveActivePageId = firstText(objectValue(next).id);
        }
      };
    }

    // Website views are a single route made from vertically stacked root
    // sections. Their editor navigation must never be backed by the site's
    // route/page list: Home and About are separate editing surfaces, while
    // Hero, Features, CTA, etc. are the collection being arranged here.
    function documentSectionsAdapter(){
      const sections = () => {
        const document_ = editorHandle ? editorHandle.getDocument() : clone(objectValue(opts.document));
        // A mobile variant is an alternate projection of its desktop section,
        // never another section in navigation. The strip therefore owns only
        // canonical desktop sections (Gallery, not Gallery + Gallery Mobile).
        return arrayValue(objectValue(objectValue(document_).root).children).filter((node) => node && node.type === 'frame' && !M().isMobileViewSection?.(node));
      };
      const list = () => {
        const document_ = editorHandle ? editorHandle.getDocument() : clone(objectValue(opts.document));
        return sections().map((section, index) => {
          const definition = clone(objectValue(document_));
          const previewSection = clone(objectValue(section));
          previewSection.frame = { ...objectValue(previewSection.frame), y: 0 };
          definition.root = clone(objectValue(definition.root));
          definition.root.children = [previewSection];
          definition.root.frame = {
            ...objectValue(definition.root.frame),
            h: Math.max(1, numberValue(objectValue(previewSection.frame).h) || numberValue(objectValue(objectValue(definition.root).frame).h) || 160)
          };
          return {
            id: firstText(objectValue(section).id, String(index)),
            title: firstText(objectValue(section).name, `Section ${index + 1}`),
            definition
          };
        });
      };
      const indexOf = (id) => sections().findIndex((section) => cleanText(section.id) === cleanText(id));
      const focus = (id) => {
        if (!editorReady() || indexOf(id) < 0) return;
        state.fmveActiveSectionId = cleanText(id);
        const active = rootSections().find((section) => cleanText(section.id) === cleanText(id) || cleanText(objectValue(section).props?.variant_of) === cleanText(id));
        const activeId = firstText(objectValue(active).id, id);
        editorHandle.select([activeId]);
        scrollNodeIntoView(activeId);
        renderPagesStrip();
      };
      return {
        list,
        current(){
          const entries = list();
          const selected = editorHandle ? editorHandle.selection()[0] : '';
          const candidate = firstText(state.fmveActiveSectionId, selected);
          return entries.some((entry) => entry.id === candidate) ? candidate : firstText(objectValue(entries[0]).id);
        },
        select: focus,
        add(afterId){
          if (!editorReady()) return;
          const items = sections();
          const after = cleanText(afterId);
          const afterIndex = after ? indexOf(after) : items.length - 1;
          const node = tplSection('Section', 160, []);
          const res = editorHandle.apply({ type: 'node.insert', node, parent_id: null, index: Math.max(0, afterIndex + 1) });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_2b77fda212d7c1","Could not add a section here.") ?? "Could not add a section here."), false); return; }
          focus(node.id);
        },
        rename(id, title){
          const value = cleanText(title);
          if (!editorReady() || !value) return;
          const res = editorHandle.apply({ type: 'node.set', node_id: cleanText(id), prop: 'name', value });
          if (res && res.ok === false) toast((globalThis.PlatformLanguage?.text("visual-editor","m_9c77a0bdb92937","Could not rename this section.") ?? "Could not rename this section."), false);
        },
        copy(id){
          const item = sections().find((section) => cleanText(section.id) === cleanText(id));
          return item ? clone(item) : null;
        },
        paste(afterId, copiedSection){
          if (!editorReady() || !copiedSection) return;
          const node = M().reassignIds(clone(copiedSection));
          node.name = `${firstText(node.name, 'Section')} copy`;
          const afterIndex = indexOf(afterId);
          const res = editorHandle.apply({ type: 'node.insert', node, parent_id: null, index: afterIndex < 0 ? sections().length : afterIndex + 1 });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_676bad8aef3214","Could not paste this section.") ?? "Could not paste this section."), false); return; }
          focus(node.id);
        },
        duplicate(id){
          const copied = this.copy(id);
          if (copied) this.paste(id, copied);
        },
        remove(id){
          if (!editorReady()) return;
          const items = sections();
          const index = indexOf(id);
          if (index < 0 || items.length < 2) return;
          const next = items[index + 1] || items[index - 1];
          const res = editorHandle.apply({ type: 'node.remove', node_id: cleanText(id) });
          if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_350430f36734e6","Could not delete this section.") ?? "Could not delete this section."), false); return; }
          state.fmveActiveSectionId = firstText(objectValue(next).id);
          if (next) focus(next.id);
        }
      };
    }

    const collectionIsSections = contentKind === 'web';
    const collectionNoun = collectionIsSections ? 'Section' : 'Page';
    const collectionPlural = collectionIsSections ? 'Sections' : 'Pages';
    let pagesApi = collectionIsSections ? chromeOpts.sections : chromeOpts.pages;
    if (collectionIsSections && (pagesApi === undefined || pagesApi === 'document')) pagesApi = documentSectionsAdapter();
    else if (!collectionIsSections && (pagesApi === 'document' || (pagesApi === undefined && contentKind === 'document'))) pagesApi = documentPagesAdapter();
    else if (!pagesApi || typeof pagesApi.list !== 'function') pagesApi = null;

    const notesOpts = chromeOpts.notes && typeof chromeOpts.notes === 'object' ? chromeOpts.notes : null;
    const markupOpts = chromeOpts.markup === null ? null : objectValue(chromeOpts.markup);
    const qrOpts = chromeOpts.qr === null ? null : objectValue(chromeOpts.qr);
    const brandOpts = chromeOpts.brand === null ? null : objectValue(chromeOpts.brand);
    const elementsOpts = chromeOpts.elements && typeof chromeOpts.elements === 'object' ? chromeOpts.elements : null;
    if (state.chromeSearch.qr === undefined && qrOpts && cleanText(qrOpts.defaultUrl)) {
      state.chromeSearch.qr = cleanText(qrOpts.defaultUrl);
    }

    const customTabs = arrayValue(chromeOpts.customTabs)
      .map((tab, index) => ({
        ...objectValue(tab),
        id: cleanText(objectValue(tab).id),
        label: firstText(objectValue(tab).label, objectValue(tab).id),
        icon: firstText(objectValue(tab).icon, 'fa-puzzle-piece'),
        order: Number.isFinite(Number(objectValue(tab).order)) ? Number(objectValue(tab).order) : 100 + index
      }))
      .filter((tab) => tab.id && typeof tab.render === 'function' && !CHROME_TABS.some((builtin) => builtin.id === tab.id));
    const allTabs = CHROME_TABS.map((tab, index) => ({ ...tab, order: (index + 1) * 10 })).concat(customTabs)
      .sort((a, b) => a.order - b.order);
    let tabIds = Array.isArray(chromeOpts.tabs) && chromeOpts.tabs.length
      ? chromeOpts.tabs.map(cleanText).filter((id) => allTabs.some((tab) => tab.id === id))
      : allTabs.map((tab) => tab.id);
    // Widgets are a shared editor concept. Hosts supply different catalogs
    // (documents, public sites, customer portals), but keep the same tiled tab.
    if (!templateGroups().length) tabIds = tabIds.filter((id) => id !== 'templates');
    if (!brandOpts) tabIds = tabIds.filter((id) => id !== 'brand');
    if (!markupOpts) tabIds = tabIds.filter((id) => id !== 'markup');
    if (!qrOpts) tabIds = tabIds.filter((id) => id !== 'qr');
    const tabs = allTabs.filter((tab) => tabIds.includes(tab.id));
    if (state.chromeTab && !tabIds.includes(state.chromeTab)) state.chromeTab = '';

    const addSectionEnabled = (() => {
      if (contentKind === 'document') return false;
      const cfg = chromeOpts.addSection;
      if (cfg === true || cfg === false) return cfg;
      return cleanText(objectValue(opts.document).kind) === 'view'; // 'auto'
    })();

    // ------------------------------------------------------------ DOM
    const bannerHtml = typeof chromeOpts.banner === 'string'
      ? chromeOpts.banner
      : firstText(objectValue(chromeOpts.banner).html);
    const rootEl = doc.createElement('div');
    rootEl.className = `fmve-chrome fmve-kind-${contentKind}`;
    rootEl.innerHTML = `
      <div class="fmve-main">
        <nav class="fmwe-ch-rail" data-ch-rail aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_f334262d9394a1","Editor tools") ?? "Editor tools")}">
          ${String(tabs.map((tab) => `
            <button type="button" class="fmwe-ch-railbtn ${state.chromeTab === tab.id ? 'active' : ''}" data-ch-tab="${esc(tab.id)}" title="${esc(tab.label)}">
              <i class="fas ${esc(tab.icon)}"></i><span>${esc(tab.label)}</span>
            </button>`).join(''))}
        </nav>
        <aside class="fmwe-ch-panel ${String(state.chromeTab && state.chromeTab !== 'markup' ? '' : 'hidden')}" data-ch-panel>
          <div class="fmwe-ch-panel-clip">
            <div class="fmwe-ch-panel-body" data-ch-panel-body></div>
          </div>
          <button type="button" class="fmwe-ch-collapse" data-ch-collapse title="${(globalThis.PlatformLanguage?.text("visual-editor","m_fc21a1d372a9b3","Close panel") ?? "Close panel")}"><i class="fas fa-chevron-left"></i></button>
        </aside>
        <div class="fmwe-ch-center">
          ${String(bannerHtml || '')}
          <div class="fmwe-editor-canvas" data-ed-canvas></div>
          <div class="fmwe-ch-under" data-ch-under>
            ${String(addSectionEnabled ? '<button type="button" class="fmwe-ch-addsection" data-ch-add-section><i class="fas fa-plus"></i> Add section</button>' : '')}
            ${String(pagesApi ? `<div class="fmwe-ch-pstrip ${state.pagesStripOpen ? '' : 'hidden'}" data-ch-pages-strip></div>` : '')}
          </div>
        </div>
      </div>
      <footer class="fmwe-ch-bottom" data-ch-bottom>
        ${String(notesOpts ? '<button type="button" class="fmwe-ch-bbtn" data-ch-notes><i class="fas fa-edit"></i> Notes</button><span class="fmwe-ch-bsep"></span>' : '')}
        <div class="fmwe-ch-bspacer"></div>
        <button type="button" class="fmwe-ch-bbtn icon" data-ch-zoom-fit title="${(globalThis.PlatformLanguage?.text("visual-editor","m_5dc062b98b043b","Fit to width") ?? "Fit to width")}"><i class="fas fa-compress-arrows-alt"></i></button>
        <input type="range" class="fmwe-ch-zoom" min="10" max="200" step="5" value="100" data-ch-zoom aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_e847735cf5a416","Zoom") ?? "Zoom")}">
        <span class="fmwe-ch-zoomval" data-ch-zoom-readout>100%</span>
        <span class="fmwe-ch-bsep"></span>
        ${String(pagesApi ? `<button type="button" class="fmwe-ch-bbtn ${state.pagesStripOpen ? 'active' : ''}" data-ch-pages-toggle><i class="fas ${collectionIsSections ? 'fa-layer-group' : 'fa-file'}"></i> <span data-ch-pages-label>${collectionPlural}</span></button>` : '')}
        ${String(pagesApi && typeof pagesApi.grid === 'function' ? `<button type="button" class="fmwe-ch-bbtn icon" data-ch-grid title="All ${collectionPlural.toLowerCase()}"><i class="fas fa-th"></i></button>` : '')}
        <button type="button" class="fmwe-ch-bbtn icon" data-ch-expand title="${(globalThis.PlatformLanguage?.text("visual-editor","m_d54b8cc1b1dd49","Fullscreen") ?? "Fullscreen")}"><i class="fas fa-expand"></i></button>
      </footer>
      ${String(contentKind !== 'document' ? '<button type="button" class="fmwe-preview-fullscreen-toggle" data-ch-preview-expand aria-label="Enter fullscreen preview" title="Fullscreen preview"><i class="fas fa-expand"></i></button>' : '')}
      ${String(notesOpts ? `
      <div class="fmwe-ch-notes ${state.notesOpen ? '' : 'hidden'}" data-ch-notes-drawer>
        <div class="head">
          <strong><i class="fas fa-edit"></i> Page notes</strong>
          <span class="state" data-ch-notes-state></span>
          <button type="button" class="fmwe-icon-btn" data-ch-notes-close title="Close notes"><i class="fas fa-xmark"></i></button>
        </div>
        <textarea data-ch-notes-input placeholder="Working notes for this page — visible to your team only, never on the live page."></textarea>
      </div>` : '')}`;
    container.appendChild(rootEl);
    syncOnPrimaryVar(rootEl, orgBranding());
    syncChromeThemeVars(opts.document);

    const root = rootEl; // moved chrome code below keeps its `root.querySelector` shape
    const stage = rootEl.querySelector('[data-ed-canvas]');

    const canvasHolder = () => stage;
    const chromeCanvasEl = () => root.querySelector('.fmde-canvas');
    const chromePageEl = () => root.querySelector('.fmde-stage .fmdoc-page');
    const editorReady = () => !!(editorHandle && M());
    const modeNow = () => {
      try { return editorHandle && typeof editorHandle.getMode === 'function' ? editorHandle.getMode() : 'visual'; }
      catch (e) { return 'visual'; }
    };
    const chromeActive = () => modeNow() === 'visual';
    function requireEditor(){
      if (editorReady() && chromeActive()) return true;
      toast((globalThis.PlatformLanguage?.text("visual-editor","m_8344ad349ef254","Switch to the visual editor to make changes.") ?? "Switch to the visual editor to make changes."), false);
      return false;
    }

    function destroyChromeThumbs(){
      state.chromeThumbHandles.forEach((handle) => { try { handle?.destroy?.(); } catch (e) { /* noop */ } });
      state.chromeThumbHandles = [];
      state.chromePageThumbHandles.forEach((handle) => { try { handle?.destroy?.(); } catch (e) { /* noop */ } });
      state.chromePageThumbHandles = [];
    }

    function themeForDefinition(definition){
      const themeId = cleanText(objectValue(definition).theme_ref?.theme_id);
      const themes = arrayValue(objectValue(opts.catalog).themes);
      const entry = themes.find((theme) => firstText(theme.id, theme.theme_id) === themeId);
      return objectValue(entry).definition || entry || opts.theme || null;
    }

    function syncChromeThemeVars(definition){
      if (!M() || typeof M().resolveThemeTokens !== 'function') return;
      Array.from(rootEl.style).forEach((name) => {
        if (name.startsWith('--fm-')) rootEl.style.removeProperty(name);
      });
      const vars = objectValue(M().resolveThemeTokens(themeForDefinition(definition) || {}, thumbTheme()));
      Object.keys(vars).forEach((name) => rootEl.style.setProperty(name, vars[name]));
    }

    function scrollNodeIntoView(nodeId){
      editorHandle?.prepareExplicitScroll?.();
      requestAnimationFrame(() => {
        try { root.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* noop */ }
      });
    }

    // ----------------------------------------------------------- inserting
    /** Append prebuilt sections to the page root (fresh ids), select the last. */
    function appendSections(sections, options = {}){
      if (!requireEditor()) return null;
      const editor = editorHandle;
      let lastId = '';
      sections.forEach((section) => {
        const node = M().reassignIds(clone(section));
        const maximum = sectionMaxWidthPx();
        if (maximum !== null) node.props = { ...objectValue(node.props), section_width: constrainSectionWidth(objectValue(node.props).section_width) };
        const res = editor.apply({ type: 'node.insert', node, parent_id: null });
        if (res && res.ok !== false) lastId = node.id;
      });
      if (lastId && !options.silent) {
        editor.select([lastId]);
        scrollNodeIntoView(lastId);
      }
      return lastId || null;
    }

    function addBlankSection(options = {}){
      return appendSections([tplSection('Section', numberValue(options.h) || 160, [])], options);
    }

    /** Effective on-screen box for a section. Fluid ("fill") pages render the
     *  section ELEMENT at 0 CSS width even though its content paints — the
     *  horizontal extent falls back to the section's own origin + the design
     *  width at the section's px/pt scale (correct at any zoom). */
    function sectionScreenRect(section, el){
      const target = el || root.querySelector(`[data-node-id="${cleanText(objectValue(section).id)}"]`);
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      if (!rect.height) return null;
      if (rect.width > 2) return rect;
      const hPt = numberValue(objectValue(objectValue(section).frame).h);
      const pxPerPt = hPt ? rect.height / hPt : PT_TO_PX;
      const width = designWidthPt() * pxPerPt;
      return {
        left: rect.left, x: rect.left, right: rect.left + width,
        top: rect.top, y: rect.top, bottom: rect.bottom,
        width, height: rect.height
      };
    }

    /** The section frame under the canvas viewport centre (nearest fallback). */
    function sectionForViewportCenter(){
      if (!editorReady()) return null;
      const d = editorHandle.getDocument();
      const sections = arrayValue(objectValue(d.root).children).filter((n) => n && n.type === 'frame');
      const canvas = chromeCanvasEl();
      if (!sections.length || !canvas) return null;
      const canvasRect = canvas.getBoundingClientRect();
      const cx = canvasRect.left + canvasRect.width / 2;
      const cy = canvasRect.top + canvasRect.height / 2;
      let best = null;
      sections.forEach((section) => {
        const rect = sectionScreenRect(section);
        if (!rect) return;
        const dist = cy >= rect.top && cy <= rect.bottom ? 0 : Math.min(Math.abs(cy - rect.top), Math.abs(cy - rect.bottom));
        if (!best || dist < best.dist) best = { section, rect, dist, cx, cy };
      });
      return best;
    }

    /** The root section whose (effective) rendered box contains the point. */
    function sectionAtClientPoint(clientX, clientY){
      if (!editorReady()) return null;
      const d = editorHandle.getDocument();
      const sections = arrayValue(objectValue(d.root).children).filter((n) => n && n.type === 'frame');
      for (const section of sections) {
        const rect = sectionScreenRect(section);
        if (!rect) continue;
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return { section, rect, cx: clientX, cy: clientY, dist: 0 };
        }
      }
      return null;
    }

    function authoredPageTargets(){
      if (!editorReady()) return [];
      const d = editorHandle.getDocument();
      if (!d || d.kind === 'view') return [];
      const byId = new Map(arrayValue(d.pages).map((page) => [cleanText(page.id), page]));
      return Array.from(root.querySelectorAll('.fmde-stage .fmdoc-page[data-page-id]')).map((pageEl) => {
        const displayId = cleanText(pageEl.getAttribute('data-page-id'));
        const sourceId = displayId.replace(/__cont\d+$/, '');
        const page = byId.get(sourceId);
        return page ? { page, pageEl, rect: pageEl.getBoundingClientRect() } : null;
      }).filter(Boolean);
    }

    function pageInsertionTarget(clientX, clientY){
      const pages = authoredPageTargets();
      if (!pages.length) return null;
      const canvasRect = chromeCanvasEl()?.getBoundingClientRect();
      const cx = Number.isFinite(clientX) ? clientX : (canvasRect ? canvasRect.left + canvasRect.width / 2 : pages[0].rect.left);
      const cy = Number.isFinite(clientY) ? clientY : (canvasRect ? canvasRect.top + canvasRect.height / 2 : pages[0].rect.top);
      let best = null;
      pages.forEach((candidate) => {
        const r = candidate.rect;
        const inside = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
        const dx = inside ? 0 : Math.max(r.left - cx, 0, cx - r.right);
        const dy = inside ? 0 : Math.max(r.top - cy, 0, cy - r.bottom);
        const distance = Math.hypot(dx, dy);
        if (!best || distance < best.distance) best = { ...candidate, cx, cy, distance };
      });
      return best;
    }

    /** Insert a built node centred on a target point (viewport centre by
     *  default, or an explicit client point for drag-drops): section-relative
     *  coords, topmost z, clamped inside, fully numeric. */
    function insertNodeAtCenter(node, options = {}){
      if (!requireEditor() || !node) return null;
      const at = options.clientX !== undefined && options.clientY !== undefined
        ? { x: numberValue(options.clientX), y: numberValue(options.clientY) }
        : null;
      const editor = editorHandle;
      const currentDoc = editor.getDocument();
      if (currentDoc && currentDoc.kind !== 'view') {
        const targetPage = pageInsertionTarget(at?.x, at?.y);
        if (!targetPage) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_81b4bb3c5fb323","The page canvas is still loading.") ?? "The page canvas is still loading."), false); return null; }
        const paper = M().paperDimensions(currentDoc);
        const rect = targetPage.rect;
        const pxPerPt = rect.width > 2 && paper.w_pt ? rect.width / paper.w_pt : PT_TO_PX;
        const frame = { ...objectValue(node.frame) };
        const w = Math.min(numberValue(frame.w) || 120, Math.max(24, paper.w_pt));
        const h = Math.min(numberValue(frame.h) || 80, Math.max(16, paper.h_pt));
        const cx = Math.min(Math.max(targetPage.cx, rect.left), rect.right);
        const cy = Math.min(Math.max(targetPage.cy, rect.top), rect.bottom);
        const x = Math.max(0, Math.min((cx - rect.left) / pxPerPt - w / 2, Math.max(0, paper.w_pt - w)));
        const y = Math.max(0, Math.min((cy - rect.top) / pxPerPt - h / 2, Math.max(0, paper.h_pt - h)));
        let topZ = 0;
        arrayValue(targetPage.page.children).forEach((kid) => { topZ = Math.max(topZ, numberValue(objectValue(objectValue(kid).frame).z) || 0); });
        node.anchor = 'page';
        node.frame = { ...frame, x: round2(x), y: round2(y), w: round2(w), h: round2(h), z: topZ + 1, layout: 'absolute' };
        if (node.type === 'widget') node.props = { ...objectValue(node.props), object_layout: 'front' };
        const result = editor.apply({ type: 'node.insert', node, page_id: targetPage.page.id });
        if (result && result.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_e01894a7e800ff","Could not insert that element here.") ?? "Could not insert that element here."), false); return null; }
        state.fmveActivePageId = targetPage.page.id;
        editor.select([node.id]);
        return node;
      }
      let target = at ? sectionAtClientPoint(at.x, at.y) : sectionForViewportCenter();
      if (!target && at) target = sectionForViewportCenter();
      if (!target) {
        addBlankSection({ silent: true });
        target = sectionForViewportCenter();
      }
      if (!target) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_3775191c84afaa","Add a section first, then insert elements into it.") ?? "Add a section first, then insert elements into it."), false); return null; }
      if (at) { target.cx = at.x; target.cy = at.y; }
      const { section, rect } = target;
      const hPt = numberValue(objectValue(section.frame).h) || 160;
      const pxPerPt = rect.height && hPt ? rect.height / hPt : PT_TO_PX;
      const sectionWPt = rect.width / pxPerPt;
      const frame = { ...objectValue(node.frame) };
      const w = Math.min(numberValue(frame.w) || 120, Math.max(24, sectionWPt));
      const h = Math.min(numberValue(frame.h) || 80, Math.max(16, hPt));
      const cx = Math.min(Math.max(target.cx, rect.left), rect.right);
      const cy = Math.min(Math.max(target.cy, rect.top), rect.bottom);
      let x = (cx - rect.left) / pxPerPt - w / 2;
      let y = (cy - rect.top) / pxPerPt - h / 2;
      x = Math.max(0, Math.min(x, Math.max(0, sectionWPt - w)));
      y = Math.max(0, Math.min(y, Math.max(0, hPt - h)));
      let topZ = 0;
      arrayValue(section.children).forEach((kid) => { topZ = Math.max(topZ, numberValue(objectValue(objectValue(kid).frame).z) || 0); });
      node.frame = { ...frame, x: round2(x), y: round2(y), w: round2(w), h: round2(h), z: topZ + 1 };
      ['x', 'y', 'w', 'h', 'z'].forEach((key) => {
        if (!Number.isFinite(Number(node.frame[key]))) node.frame[key] = key === 'z' ? 1 : (key === 'w' ? 120 : (key === 'h' ? 80 : 0));
      });
      const res = editor.apply({ type: 'node.insert', node, parent_id: section.id });
      if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_e01894a7e800ff","Could not insert that element here.") ?? "Could not insert that element here."), false); return null; }
      editor.select([node.id]);
      return node;
    }

    // ------------------------------------------------------- element items
    function elementCategories(){
      if (!M()) return [];
      const shape = (name, overrides) => M().createNode('shape', {
        name,
        frame: { x: 0, y: 0, w: 140, h: 100, z: 1 },
        style: { fill: { type: 'solid', color: PRIMARY_VAR } },
        ...overrides
      });
      const extraWidgets = elementsOpts && typeof elementsOpts.widgets === 'function'
        ? arrayValue(elementsOpts.widgets(adapterHelpers))
        : [];
      const catalogDocumentWidgets = arrayValue(objectValue(opts.catalog).widgets);
      const documentWidgetDefs = catalogDocumentWidgets.length
        ? catalogDocumentWidgets
        : arrayValue(global.FMDocWidgets?.list?.());
      const documentWidgetIcons = {
        'doc.line_items': 'fa-receipt',
        'doc.payment_schedule': 'fa-calendar-days',
        'doc.pay_now': 'fa-credit-card',
        'doc.signature': 'fa-file-signature',
        'doc.form_field': 'fa-pen-to-square',
        'doc.choice_group': 'fa-square-check',
        'doc.qr': 'fa-qrcode',
        'doc.photo_grid': 'fa-images',
        'doc.photo_carousel': 'fa-photo-film',
        'doc.page_number': 'fa-hashtag',
        'doc.audio': 'fa-volume-high',
        'doc.media_popup': 'fa-magnifying-glass-plus',
        'doc.layers_diagram': 'fa-layer-group',
        'doc.measurement_report': 'fa-ruler-combined',
        'doc.money_metrics': 'fa-coins',
        'doc.expense_breakdown': 'fa-chart-pie',
        'doc.payment_history': 'fa-money-bill-transfer'
      };
      const documentWidgets = documentWidgetDefs
        .map(objectValue)
        // A single photo or video is media, not a widget. Keep the registry
        // definitions for existing documents, but do not offer them in the
        // Widgets palettes (including the registry fallback used offline).
        .filter((def) => {
          const id = cleanText(def.id);
          return id.startsWith('doc.') && id !== 'doc.photo' && id !== 'doc.video';
        })
        .map((def) => {
          let registered = {};
          try { registered = objectValue(global.FMDocWidgets?.get?.(def.id, numberValue(def.version) || 1)); } catch (e) { /* use catalog descriptor */ }
          const defaults = objectValue(Object.keys(objectValue(def.defaults)).length ? def.defaults : registered.defaults);
          const widgetFrame = objectValue(defaults.frame);
          const widgetId = cleanText(def.id);
          return {
            id: `el_widget_${widgetId.replace(/[^a-z0-9]+/gi, '_')}`,
            name: firstText(def.title, registered.title, widgetId),
            icon: firstText(documentWidgetIcons[widgetId], registered.icon, def.icon, 'fa-puzzle-piece'),
            build: () => boundTplWidget(widgetId, {
              w: numberValue(widgetFrame.w) || 300,
              h: numberValue(widgetFrame.h) || 120
            }, { name: firstText(def.title, registered.title, widgetId) })
          };
        });
      const widgetItems = (contentKind === 'document' ? documentWidgets : [
        { id: 'el_lead_form', name: 'Lead form', icon: 'fa-address-card', preview: EL_PREVIEWS.leadForm, build: () => boundTplWidget('web.lead_form', { w: 420, h: 200 }, { name: 'Lead form' }) },
        { id: 'el_nav_menu', name: 'Nav menu', icon: 'fa-bars', preview: EL_PREVIEWS.navMenu, build: () => boundTplWidget('web.nav_menu', { w: 420, h: 32 }, { name: 'Nav menu' }) },
        { id: 'el_qr_widget', name: 'QR code', icon: 'fa-qrcode', build: () => boundTplWidget('doc.qr', { w: 96, h: 96 }, { name: 'QR code' }) }
      ]).concat(extraWidgets).filter((item, index, items) => items.findIndex((entry) => cleanText(entry.id) === cleanText(item.id)) === index);
      if (!widgetItems.some((item) => cleanText(item.id) === 'el_table')) widgetItems.push({
        id: 'el_table', name: 'Basic table', icon: 'fa-table', preview: EL_PREVIEWS.table,
        build: () => {
          const cell = (text) => ({ blocks: [{ id: M().generateId('blk'), type: 'paragraph', align: 'left', runs: [{ text }] }] });
          const row = (a, b, c) => ({ id: M().generateId('row'), cells: [cell(a), cell(b), cell(c)] });
          return M().createNode('table', {
            name: 'Table',
            frame: { x: 0, y: 0, w: 420, h: 120, z: 1 },
            props: {
              columns: [{ id: M().generateId('col'), width_frac: 0.34 }, { id: M().generateId('col'), width_frac: 0.44 }, { id: M().generateId('col'), width_frac: 0.22 }],
              rows: [row('Item', 'Details', 'Price'), row('First item', 'A short description', '$100'), row('Second item', 'Another description', '$250')],
              header: true,
              row_stripe: false
            }
          });
        }
      });
      return [
        {
          id: 'shapes', name: 'Shapes', icon: 'fa-shapes', layout: 'shapes',
          items: [
            { id: 'el_rect', name: 'Rectangle', icon: 'fa-square-full', preview: EL_PREVIEWS.rect, build: () => shape('Rectangle', { props: { shape: 'rect', corner_radius: 2 } }) },
            { id: 'el_rounded', name: 'Rounded rectangle', icon: 'fa-square', preview: EL_PREVIEWS.rounded, build: () => shape('Rounded rectangle', { props: { shape: 'rect', corner_radius: 14 } }) },
            { id: 'el_ellipse', name: 'Ellipse', icon: 'fa-circle', preview: EL_PREVIEWS.ellipse, build: () => shape('Ellipse', { frame: { x: 0, y: 0, w: 120, h: 120, z: 1 }, props: { shape: 'ellipse' } }) },
            { id: 'el_line', name: 'Line', icon: 'fa-slash', preview: EL_PREVIEWS.line, build: () => shape('Line', { frame: { x: 0, y: 0, w: 180, h: 2, z: 1 }, props: { shape: 'line', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }, style: { stroke: { color: '#111827', width_pt: 2 }, fill: null } }) },
            { id: 'el_triangle', name: 'Triangle', icon: 'fa-caret-up', preview: EL_PREVIEWS.triangle, build: () => shape('Triangle', { frame: { x: 0, y: 0, w: 130, h: 110, z: 1 }, props: { shape: 'polygon', points: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } }) }
          ]
        },
        {
          id: 'buttons', name: 'Buttons', icon: 'fa-hand-pointer', layout: 'rows',
          items: [
            { id: 'el_btn_primary', name: 'Primary button', icon: 'fa-hand-pointer', span: 2, preview: elBtnSample('Get in touch', 'primary'), build: () => tplButton('Get in touch', { w: 170, h: 44 }, { name: 'Primary button', variant: 'primary', link: { page: 'contact' } }) },
            { id: 'el_btn_outline', name: 'Outline button', icon: 'fa-hand-pointer', span: 2, preview: elBtnSample('Learn more', 'outline'), build: () => tplButton('Learn more', { w: 160, h: 44 }, { name: 'Outline button', variant: 'outline' }) },
            { id: 'el_btn_dark', name: 'Dark pill', icon: 'fa-hand-pointer', span: 2, preview: elBtnSample('Call now', 'dark'), build: () => tplButton('Call now', { w: 150, h: 42 }, { name: 'Dark pill', variant: 'dark' }) }
          ]
        },
        {
          id: 'widgets', name: 'Widgets', icon: 'fa-th-large', layout: 'cards',
          items: widgetItems
        },
        {
          id: 'media', name: 'Media', icon: 'fa-photo-video', layout: 'cards',
          items: [
            { id: 'el_image', name: 'Image placeholder', icon: 'fa-image', preview: EL_PREVIEWS.image, build: () => tplImage({ w: 220, h: 150 }) },
            { id: 'el_video', name: 'Video player', icon: 'fa-video', preview: EL_PREVIEWS.video, build: () => boundTplWidget('doc.video', { w: 400, h: 225 }, { name: 'Video' }) }
          ]
        },
        {
          id: 'sections', name: 'Sections', icon: 'fa-layer-group', layout: 'rows',
          items: [
            { id: 'el_sec_short', name: 'Short band', icon: 'fa-minus', preview: EL_PREVIEWS.secShort, section: true, build: () => tplSection('Section', 120, []) },
            { id: 'el_sec_tall', name: 'Tall band', icon: 'fa-layer-group', preview: EL_PREVIEWS.secTall, section: true, build: () => tplSection('Section', 280, []) },
            { id: 'el_sec_color', name: 'Colored band', icon: 'fa-fill-drip', preview: EL_PREVIEWS.secColor, section: true, build: () => tplSection('Section', 180, [], { fill: { type: 'solid', color: PRIMARY_VAR } }) }
          ]
        }
      ].filter((category) => contentKind !== 'document' || category.id !== 'sections');
    }

    function allElementItems(){
      const out = [];
      elementCategories().forEach((cat) => cat.items.forEach((item) => out.push({ ...item, category: cat.name, categoryId: cat.id })));
      return out;
    }

    function recentElementIds(){
      try {
        const parsed = JSON.parse(lsGet(RECENT_ELEMENTS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.map(cleanText).filter(Boolean) : [];
      } catch (e) { return []; }
    }
    function recordRecentElement(id){
      const next = [cleanText(id), ...recentElementIds().filter((x) => x !== cleanText(id))].slice(0, 8);
      lsSet(RECENT_ELEMENTS_KEY, JSON.stringify(next));
    }

    function insertElementItem(item){
      if (!item || !requireEditor()) return;
      const node = item.build();
      if (item.section) {
        appendSections([node]);
      } else {
        insertNodeAtCenter(node);
      }
      recordRecentElement(item.id);
      if (state.chromeTab === 'elements') renderChromePanel();
    }

    // ---------------------------------------------------------- rail/panel
    function setChromeTab(tabId){
      const next = state.chromeTab === tabId ? '' : cleanText(tabId);
      if (state.chromeTab === 'markup' && next !== 'markup') endMarkupSession();
      state.chromeTab = next;
      renderChromePanel();
    }

    function renderChromePanel(){
      const panel = root.querySelector('[data-ch-panel]');
      const body = root.querySelector('[data-ch-panel-body]');
      if (!panel || !body) return;
      destroyChromeThumbs();
      // Markup opens the slim canvas dock, never the wide panel.
      const panelOpen = !!state.chromeTab && state.chromeTab !== 'markup';
      panel.classList.toggle('hidden', !panelOpen);
      panel.dataset.activeTab = panelOpen ? state.chromeTab : '';
      root.querySelectorAll('[data-ch-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.chTab === state.chromeTab));
      if (state.chromeTab === 'markup') renderMarkupDock();
      else removeMarkupDock();
      body.innerHTML = '';
      if (!panelOpen) return;
      if (state.chromeTab === 'templates') renderTemplatesPanel(body);
      else if (state.chromeTab === 'elements') renderElementsPanel(body);
      else if (state.chromeTab === 'widgets') renderWidgetsPanel(body);
      else if (state.chromeTab === 'media') renderMediaPanel(body);
      else if (state.chromeTab === 'text') renderTextPanel(body);
      else if (state.chromeTab === 'brand') renderBrandPanel(body);
      else if (state.chromeTab === 'qr') renderQrPanel(body);
      else {
        const customTab = customTabs.find((tab) => tab.id === state.chromeTab);
        if (customTab) {
          const customApi = {
            ...adapterHelpers,
            state,
            contentKind,
            editor: () => editorHandle,
            document: () => editorHandle ? editorHandle.getDocument() : clone(objectValue(opts.document)),
            insertNode(node, point){ return insertNodeAtCenter(node, objectValue(point)); },
            insertSections(nodes){ return appendSections(arrayValue(nodes)); },
            wireInsertDrag,
            toast,
            refresh: renderChromePanel,
            close(){ setChromeTab(''); }
          };
          try { customTab.render(body, customApi); }
          catch (error) {
            body.innerHTML = `<div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_55216de254c0ca","Panel unavailable") ?? "Panel unavailable")}</strong></div><p class="fmwe-ch-quiet">${(globalThis.PlatformLanguage?.text("visual-editor","m_65737bf2a12b5b","This editor extension could not be opened.") ?? "This editor extension could not be opened.")}</p>`;
            try { global.console?.error?.('[FMVisualEditor] custom tab render failed', error); } catch (e) { /* noop */ }
          }
        }
      }
    }

    // ---------------------------------------------------- panel: templates
    function collapsedTemplateGroups(){
      if (state.templateGroupsCollapsed instanceof Set) return state.templateGroupsCollapsed;
      let ids = [];
      try {
        const parsed = JSON.parse(lsGet(TEMPLATE_GROUPS_KEY) || '[]');
        if (Array.isArray(parsed)) ids = parsed.map(cleanText).filter(Boolean);
      } catch (e) { /* all groups start open */ }
      state.templateGroupsCollapsed = new Set(ids);
      return state.templateGroupsCollapsed;
    }

    function renderTemplatesPanel(body){
      const groups = templateGroups();
      const entries = [];
      groups.forEach((group) => group.entries.forEach((entry) => entries.push(entry)));
      const collapsed = collapsedTemplateGroups();
      const card = (t) => `
        <button type="button" class="fmwe-ch-card" data-ch-tpl-card="${esc(t.id)}" data-tpl-match="${esc((t.name + ' ' + (t.keywords || '')).toLowerCase())}" title="${esc(t.name)}">
          <span class="thumb ${t.kind === 'page' ? 'tall' : ''}" data-ch-tpl-thumb="${esc(t.id)}"></span>
          <span class="name">${esc(t.name)}</span>
        </button>`;
      const groupHtml = (group) => `
        <section class="fmwe-ch-template-group ${collapsed.has(group.id) ? 'collapsed' : ''}" data-ch-tpl-group="${esc(group.id)}">
          <button type="button" class="fmwe-ch-group-head" data-ch-tpl-group-toggle="${esc(group.id)}" aria-expanded="${collapsed.has(group.id) ? 'false' : 'true'}">
            <span><strong>${esc(group.label)}</strong><small>${esc(group.description || '')}</small></span>
            <span class="count">${group.entries.length}</span><i class="fas fa-chevron-down"></i>
          </button>
          <div class="fmwe-ch-cardgrid fmwe-ch-group-body">${group.entries.map(card).join('')}</div>
        </section>`;
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_6831430b8abcaa","Templates") ?? "Templates")}</strong></div>
        <div class="fmwe-ch-search">
          <input type="search" data-ch-tpl-search placeholder="${(globalThis.PlatformLanguage?.text("visual-editor","m_32b44508ef586b","Describe your ideal design") ?? "Describe your ideal design")}" value="${String(esc(firstText(state.chromeSearch.templates)))}">
          <div class="row">
            <button type="button" class="fmwe-btn primary fmwe-ch-generate" data-ch-tpl-generate><i class="fas fa-magic"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_a4303b8472a90b"," Generate ") ?? " Generate ")}<i class="fas fa-caret-down" style="opacity:.7"></i></button>
            <button type="button" class="fmwe-btn" data-ch-tpl-searchbtn><i class="fas fa-search"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_df7ced82563784"," Search") ?? " Search")}</button>
          </div>
        </div>
        <div class="fmwe-ch-template-groups">${String(groups.map(groupHtml).join(''))}</div>`;
      const applyFilter = () => {
        const q = cleanText(state.chromeSearch.templates).toLowerCase();
        body.querySelectorAll('[data-ch-tpl-group]').forEach((groupEl) => {
          let visible = 0;
          groupEl.querySelectorAll('[data-ch-tpl-card]').forEach((el) => {
            const matches = !q || (el.dataset.tplMatch || '').includes(q);
            el.style.display = matches ? '' : 'none';
            if (matches) visible += 1;
          });
          groupEl.hidden = visible === 0;
          groupEl.classList.toggle('search-open', Boolean(q));
        });
      };
      const search = body.querySelector('[data-ch-tpl-search]');
      search?.addEventListener('input', () => { state.chromeSearch.templates = search.value; applyFilter(); });
      body.querySelector('[data-ch-tpl-searchbtn]')?.addEventListener('click', applyFilter);
      body.querySelector('[data-ch-tpl-generate]')?.addEventListener('click', () => {
        toast((globalThis.PlatformLanguage?.text("visual-editor","m_40094867d03df4","Design generation arrives with Smart Media — coming soon.") ?? "Design generation arrives with Smart Media — coming soon."), true);
      });
      body.querySelectorAll('[data-ch-tpl-group-toggle]').forEach((button) => button.addEventListener('click', () => {
        if (cleanText(state.chromeSearch.templates)) return;
        const id = cleanText(button.dataset.chTplGroupToggle);
        const group = body.querySelector(`[data-ch-tpl-group="${id}"]`);
        if (!group) return;
        const willCollapse = !group.classList.contains('collapsed');
        group.classList.toggle('collapsed', willCollapse);
        button.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
        if (willCollapse) collapsed.add(id); else collapsed.delete(id);
        lsSet(TEMPLATE_GROUPS_KEY, JSON.stringify([...collapsed]));
      }));
      body.querySelectorAll('[data-ch-tpl-card]').forEach((el) => el.addEventListener('click', () => {
        const entry = entries.find((t) => t.id === el.dataset.chTplCard);
        if (!entry) return;
        if (entry.kind === 'page') applyPageTemplate(entry);
        else appendSections([entry.build()]);
      }));
      applyFilter();
      renderTemplateThumbs(body, entries);
    }

    function renderTemplateThumbs(body, entries){
      if (!global.FMDocRenderer?.render || !M()) return;
      requestAnimationFrame(() => {
        if (destroyed || state.chromeTab !== 'templates') return;
        body.querySelectorAll('[data-ch-tpl-thumb]').forEach((thumbStage) => {
          const entry = entries.find((t) => t.id === thumbStage.dataset.chTplThumb);
          if (!entry) return;
          try {
            const built = entry.build();
            const previewDoc = templatePreviewDoc(Array.isArray(built) ? built : [built], designWidthPt());
            const width = thumbStage.clientWidth || 164;
            const scale = Math.max(0.04, Math.min(1, width / (designWidthPt() * PT_TO_PX)));
            const handle = global.FMDocRenderer.render(thumbStage, {
              document: previewDoc,
              mode: 'static',
              widgetData: {},
              widgetContext: { preview: true },
              themeContext: thumbTheme(),
              mediaUrl,
              scale
            });
            state.chromeThumbHandles.push(handle);
          } catch (e) { /* card keeps its neutral background */ }
        });
      });
    }

    async function applyPageTemplate(entry){
      if (!requireEditor()) return;
      const confirmed = await confirmFn(
        `Replace everything on this page with the "${entry.name}" layout? You can undo this from the editor.`,
        { title: (globalThis.PlatformLanguage?.text("visual-editor","m_a495f3a40467b2","Apply page template") ?? "Apply page template"), confirmLabel: 'Replace page', icon: 'fa-clone' }
      );
      if (!confirmed || !editorReady()) return;
      const editor = editorHandle;
      const nextRoot = clone(objectValue(editor.getDocument()).root);
      nextRoot.children = entry.build().map((section) => M().reassignIds(section));
      const res = editor.apply({ type: 'doc.set', prop: 'root', value: nextRoot });
      if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_8ee5039210b554","Could not apply that template.") ?? "Could not apply that template."), false); return; }
      const first = nextRoot.children[0];
      if (first) { editor.select([first.id]); scrollNodeIntoView(first.id); }
    }

    // ----------------------------------------------------- panel: elements
    // Flat scroll (Canva-style): search, "Recently used", then every group
    // expanded with collapsible headers. Collapse state persists.
    function collapsedElementGroups(){
      if (state.elementGroupsCollapsed instanceof Set) return state.elementGroupsCollapsed;
      let ids = [];
      try {
        const parsed = JSON.parse(lsGet(EL_GROUPS_KEY) || '[]');
        if (Array.isArray(parsed)) ids = parsed.map(cleanText).filter(Boolean);
      } catch (e) { /* default: all expanded */ }
      state.elementGroupsCollapsed = new Set(ids);
      return state.elementGroupsCollapsed;
    }
    function toggleElementGroup(id){
      const set = collapsedElementGroups();
      if (set.has(id)) set.delete(id);
      else set.add(id);
      lsSet(EL_GROUPS_KEY, JSON.stringify([...set]));
    }

    function horizontalShelfHtml(gridClassName, contents, gridAttrs = ''){
      return `<div class="fmwe-ch-el-scroll" data-ch-el-scroll>
        <button type="button" class="fmwe-ch-shelf-arrow left" data-ch-shelf-scroll="-1" aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_0312ab1d677d3d","Scroll left") ?? "Scroll left")}"><i class="fas fa-chevron-left"></i></button>
        <div class="${String(gridClassName)}" ${String(gridAttrs)}>${String(contents)}</div>
        <button type="button" class="fmwe-ch-shelf-arrow right" data-ch-shelf-scroll="1" aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_2606b7b2e58796","Scroll right") ?? "Scroll right")}"><i class="fas fa-chevron-right"></i></button>
      </div>`;
    }

    function wireHorizontalShelves(scope){
      scope.querySelectorAll('[data-ch-el-scroll]').forEach((shelf) => {
        const scroller = shelf.querySelector('.fmwe-ch-elgrid');
        if (!scroller) return;
        const update = () => {
          const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          shelf.classList.toggle('can-left', scroller.scrollLeft > 2);
          shelf.classList.toggle('can-right', scroller.scrollLeft < max - 2);
        };
        scroller.addEventListener('scroll', update, { passive: true });
        scroller.addEventListener('wheel', (event) => {
          // These shelves have no vertical content. Let a normal mouse wheel
          // move through the horizontal row, but hand scrolling back to the
          // surrounding panel once the requested edge has been reached.
          if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          if (max <= 2) return;
          const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
          const distance = event.deltaY * multiplier;
          const canMove = distance < 0 ? scroller.scrollLeft > 2 : scroller.scrollLeft < max - 2;
          if (!canMove) return;
          event.preventDefault();
          scroller.scrollBy({ left: distance, behavior: 'auto' });
        }, { passive: false });
        shelf.querySelectorAll('[data-ch-shelf-scroll]').forEach((button) => button.addEventListener('click', () => {
          scroller.scrollBy({ left: Number(button.dataset.chShelfScroll) * Math.max(80, scroller.clientWidth * .75), behavior: 'smooth' });
        }));
        requestAnimationFrame(update);
      });
    }

    function renderElementsPanel(body){
      const q = cleanText(state.chromeSearch.elements).toLowerCase();
      const cats = elementCategories();
      const collapsed = collapsedElementGroups();
      const matches = (item, cat) => !q || (item.name + ' ' + cat.name).toLowerCase().includes(q);
      // The sample itself is the button: no border, no label — hover tint +
      // tooltip only, like Canva's shape shelf.
      const itemButton = (item) => `
        <button type="button" class="fmwe-ch-el" data-ch-el-item="${esc(item.id)}" data-ch-el-span="${Math.max(1, Math.min(4, numberValue(item.span) || 1))}" title="${esc(item.name)}" aria-label="${esc(item.name)}">
          ${item.preview || `<span class="ic"><i class="fas ${esc(item.icon)}"></i></span>`}
        </button>`;
      const gridClass = (layout) => `fmwe-ch-elgrid ${esc(layout || 'cards')}`;
      const recent = q ? [] : recentElementIds()
        .map((id) => allElementItems().find((item) => item.id === id))
        .filter(Boolean);
      const groupsHtml = cats.map((cat) => {
        const visible = cat.items.filter((item) => matches(item, cat));
        if (!visible.length) return '';
        const isCollapsed = !q && collapsed.has(cat.id);
        return `
          <section class="fmwe-ch-elgroup ${isCollapsed ? 'collapsed' : ''}" data-ch-el-group="${esc(cat.id)}">
            <button type="button" class="fmwe-ch-elgroup-head" data-ch-el-group-toggle="${esc(cat.id)}" aria-expanded="${isCollapsed ? 'false' : 'true'}">
              <span>${esc(cat.name)}</span>
              <span class="count">${visible.length}</span>
              <i class="fas fa-chevron-down chev"></i>
            </button>
            ${horizontalShelfHtml(gridClass(cat.layout), visible.map(itemButton).join(''), 'data-ch-el-group-items')}
          </section>`;
      }).join('');
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_f1fa67d1bce90f","Elements") ?? "Elements")}</strong></div>
        <div class="fmwe-ch-search">
          <input type="search" data-ch-el-search placeholder="${(globalThis.PlatformLanguage?.text("visual-editor","m_b73cc83b8d6bae","Search elements") ?? "Search elements")}" value="${String(esc(firstText(state.chromeSearch.elements)))}">
        </div>
        ${String(recent.length ? `
          <p class="fmwe-micro-label">Recently used</p>
          ${horizontalShelfHtml('fmwe-ch-elgrid cards', recent.map(itemButton).join(''), 'data-ch-el-recent')}` : '')}
        ${String(groupsHtml || '<span class="fmwe-ch-quiet">Nothing matches that search.</span>')}`;
      wireHorizontalShelves(body);
      const search = body.querySelector('[data-ch-el-search]');
      search?.addEventListener('input', () => {
        state.chromeSearch.elements = search.value;
        renderElementsPanel(body);
        const next = body.querySelector('[data-ch-el-search]');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });
      body.querySelectorAll('[data-ch-el-group-toggle]').forEach((el) => el.addEventListener('click', () => {
        toggleElementGroup(el.dataset.chElGroupToggle);
        renderElementsPanel(body);
      }));
      body.querySelectorAll('[data-ch-el-item]').forEach((el) => {
        const item = allElementItems().find((entry) => entry.id === el.dataset.chElItem);
        if (!item) return;
        wireInsertDrag(el, {
          onClick: () => insertElementItem(item),
          ghost: `<i class="fas ${esc(item.icon)}"></i> ${esc(item.name)}`,
          onDrop: (drop) => {
            if (!requireEditor()) return;
            if (item.section) { appendSections([item.build()]); recordRecentElement(item.id); return; }
            const node = insertNodeAtCenter(item.build(), { clientX: drop.clientX, clientY: drop.clientY });
            if (node) recordRecentElement(item.id);
          }
        });
      });
    }

    function renderWidgetsPanel(body){
      const q = cleanText(state.chromeSearch.widgets).toLowerCase();
      const category = elementCategories().find((entry) => entry.id === 'widgets');
      const widgets = arrayValue(objectValue(category).items).filter((item) => !q || cleanText(item.name).toLowerCase().includes(q));
      const itemButton = (item) => `
        <button type="button" class="fmwe-ch-el" data-ch-widget-item="${esc(item.id)}" title="${esc(item.name)}" aria-label="${esc(item.name)}">
          <span class="fmwe-ch-widget-icon" aria-hidden="true"><i class="fas ${esc(firstText(item.icon, 'fa-puzzle-piece'))}"></i></span>
          <span class="fmwe-ch-widget-name">${esc(item.name)}</span>
        </button>`;
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_f5d5649c9ab16a","Widgets") ?? "Widgets")}</strong></div>
        <div class="fmwe-ch-search">
          <input type="search" data-ch-widget-search placeholder="${(globalThis.PlatformLanguage?.text("visual-editor","m_8e598201cad5db","Search widgets") ?? "Search widgets")}" value="${String(esc(firstText(state.chromeSearch.widgets)))}">
        </div>
        <div class="fmwe-ch-widgetgrid cards" data-ch-widget-grid>${String(widgets.map(itemButton).join(''))}</div>
        ${String(widgets.length ? '' : '<span class="fmwe-ch-quiet">No widgets match that search.</span>')}`;
      const search = body.querySelector('[data-ch-widget-search]');
      search?.addEventListener('input', () => {
        state.chromeSearch.widgets = search.value;
        renderWidgetsPanel(body);
        const next = body.querySelector('[data-ch-widget-search]');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });
      body.querySelectorAll('[data-ch-widget-item]').forEach((el) => {
        const item = arrayValue(objectValue(category).items).find((entry) => entry.id === el.dataset.chWidgetItem);
        if (!item) return;
        wireInsertDrag(el, {
          onClick: () => insertElementItem(item),
          ghost: `<i class="fas ${esc(item.icon)}"></i> ${esc(item.name)}`,
          onDrop: (drop) => {
            if (!requireEditor()) return;
            if (item.section) { appendSections([item.build()]); recordRecentElement(item.id); return; }
            const node = insertNodeAtCenter(item.build(), { clientX: drop.clientX, clientY: drop.clientY });
            if (node) recordRecentElement(item.id);
          }
        });
      });
    }

    // -------------------------------------------------- drag-from-panel
    // Any insertable panel item can be pointer-dragged onto the canvas: after
    // ~6px of travel a small ghost follows the cursor; releasing over the
    // canvas inserts at the drop point, anywhere else cancels. A plain click
    // (no drag) keeps the click-to-place behavior.
    function removeDragGhost(){
      try { state.dragGhost?.remove(); } catch (e) { /* noop */ }
      state.dragGhost = null;
    }
    function clearFillHighlight(){
      root.querySelectorAll('.fmwe-fill-target').forEach((el) => el.classList.remove('fmwe-fill-target'));
      doc.querySelectorAll('.fmwe-fill-target-box[data-fmwe-drag-highlight]').forEach((el) => el.remove());
    }
    function highlightFillTarget(target){
      if (!target) return;
      if ((target.section || target.background) && target.rect) {
        const box = doc.createElement('div');
        box.className = 'fmwe-fill-target-box';
        box.setAttribute('data-fmwe-drag-highlight', '');
        box.style.left = `${target.rect.left}px`;
        box.style.top = `${target.rect.top}px`;
        box.style.width = `${target.rect.width}px`;
        box.style.height = `${target.rect.height}px`;
        doc.body.appendChild(box);
        return;
      }
      target.el?.classList.add('fmwe-fill-target');
    }
    /** Deepest explicit artwork under the pointer. Section root frames are
     *  valid background targets; nested web frames are layout containers, so
     *  blank layout space resolves to the containing section instead. */
    function fillTargetAtPoint(clientX, clientY){
      if (!editorReady()) return null;
      const d = editorHandle.getDocument();
      const sectionIds = new Set(arrayValue(objectValue(d.root).children).map((n) => cleanText(objectValue(n).id)).filter(Boolean));
      const authoredNodeId = (entry) => cleanText(entry?.getAttribute?.('data-node-id')).replace(/::part\d+$/, '');
      const authoredNodeIds = new Set();
      M().walkNodes(d, (node) => { if (node?.id) authoredNodeIds.add(cleanText(node.id)); });
      const rootBackgroundTarget = () => {
        if (cleanText(d.kind) !== 'view' || !objectValue(d.root).id) return null;
        const canvas = chromeCanvasEl();
        const rect = canvas?.getBoundingClientRect();
        if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
        return { el: canvas, nodeId: cleanText(d.root.id), nodeType: 'frame', background: true, rect };
      };
      const pointStack = doc.elementsFromPoint(clientX, clientY) || [];
      const stack = pointStack
        .filter((el) => el.getAttribute && el.getAttribute('data-node-id') && el.closest('.fmdoc-page'))
        // Site header/footer previews are read-only documents rendered beside
        // the editable body. Their node ids are not targets in this document.
        .filter((el) => authoredNodeIds.has(authoredNodeId(el)))
        .filter((el) => ['image', 'shape', 'frame'].includes(el.getAttribute('data-node-type')))
        // Header/body/footer region frames are the document's editing
        // scaffolding, not visible artwork. Dropping media on their otherwise
        // blank area means "fill the page", while a real shape/frame still
        // remains the more specific target.
        .filter((el) => !el.hasAttribute('data-page-region') && !el.hasAttribute('data-fmde-doc-placeholder'));
      const el = stack.find((entry) => {
        if (sectionIds.has(authoredNodeId(entry))) return false;
        // Website templates commonly wrap all section content in one or more
        // full-size frames. Treating those wrappers as artwork prevents the
        // section from ever receiving a background drop. Real images and
        // shapes remain specific replacement/fill targets.
        return contentKind === 'document' || entry.getAttribute('data-node-type') !== 'frame';
      });
      if (el) return { el, nodeId: authoredNodeId(el), nodeType: el.getAttribute('data-node-type') };
      // Selecting the full-canvas background makes the intent explicit. In
      // that state, blank space inside a section belongs to the selected root
      // background; real images/shapes above still retain first priority.
      const selection = arrayValue(editorHandle.selection?.());
      const rootSelected = selection.length === 1 && cleanText(selection[0]) === cleanText(objectValue(d.root).id);
      if (rootSelected) {
        const background = rootBackgroundTarget();
        if (background) return background;
      }
      // Fluid pages render sections with no hit box — fall back to effective
      // section geometry so section backgrounds stay valid drop targets.
      const hit = sectionAtClientPoint(clientX, clientY);
      if (hit) {
        const sectionEl = root.querySelector(`[data-node-id="${hit.section.id}"]`);
        if (sectionEl) return { el: sectionEl, nodeId: hit.section.id, nodeType: 'frame', section: true, rect: hit.rect };
      }
      // The canvas background is an authored root frame for view documents.
      // Gutters, header/footer space and blank space beyond the sections all
      // remain valid drop targets even when it was not already selected.
      if (cleanText(d.kind) === 'view') return rootBackgroundTarget();
      // A blank area of a paged document is the page itself. Pages are
      // structural background targets, never ordinary reorderable elements.
      const pageTarget = authoredPageTargets().find((entry) => clientX >= entry.rect.left && clientX <= entry.rect.right && clientY >= entry.rect.top && clientY <= entry.rect.bottom);
      return pageTarget ? { el: pageTarget.pageEl, pageId: cleanText(pageTarget.page.id), page: true } : null;
    }
    function wireInsertDrag(el, options = {}){
      el.addEventListener('click', (event) => {
        if (el.dataset.fmweDragged === '1') { event.preventDefault(); event.stopPropagation(); return; }
        options.onClick?.(event);
      });
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        let finished = false;
        const cleanup = () => {
          global.removeEventListener('pointermove', move);
          global.removeEventListener('pointerup', up);
          global.removeEventListener('keydown', keydown, true);
          clearFillHighlight();
          removeDragGhost();
        };
        const cancel = () => {
          if (finished) return;
          finished = true;
          cleanup();
          if (dragging) {
            el.dataset.fmweDragged = '1';
            const releaseSuppression = () => setTimeout(() => { delete el.dataset.fmweDragged; }, 0);
            global.addEventListener('pointerup', releaseSuppression, { once: true });
            // Safety release for a pointer cancelled outside the window.
            setTimeout(() => { delete el.dataset.fmweDragged; }, 2000);
          }
        };
        const move = (ev) => {
          if (!dragging) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
            dragging = true;
            el.dataset.fmweDragged = '1';
            removeDragGhost();
            const ghost = doc.createElement('div');
            ghost.className = `fmwe-drag-ghost${options.ghostClass ? ` ${cleanText(options.ghostClass)}` : ''}`;
            ghost.innerHTML = options.ghost || '<i class="fas fa-plus"></i>';
            doc.body.appendChild(ghost);
            state.dragGhost = ghost;
          }
          if (state.dragGhost) {
            state.dragGhost.style.left = `${ev.clientX + 14}px`;
            state.dragGhost.style.top = `${ev.clientY + 14}px`;
          }
          if (options.media) {
            clearFillHighlight();
            const target = fillTargetAtPoint(ev.clientX, ev.clientY);
            highlightFillTarget(target);
          }
        };
        const up = (ev) => {
          if (finished) return;
          finished = true;
          cleanup();
          if (!dragging) return; // plain click — the click listener handles it
          setTimeout(() => { delete el.dataset.fmweDragged; }, 0);
          const overTray = (doc.elementsFromPoint(ev.clientX, ev.clientY) || []).some((entry) => entry.closest && entry.closest('.fmwe-ch-panel,.fmwe-ch-rail'));
          if (overTray) return;
          const canvas = canvasHolder();
          const rect = canvas ? canvas.getBoundingClientRect() : null;
          const over = !!rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
          if (!over) return;
          const fillTarget = options.media ? fillTargetAtPoint(ev.clientX, ev.clientY) : null;
          options.onDrop?.({ clientX: ev.clientX, clientY: ev.clientY, fillTarget });
        };
        const keydown = (ev) => {
          if (ev.key !== 'Escape' || !dragging) return;
          ev.preventDefault();
          ev.stopPropagation();
          cancel();
        };
        global.addEventListener('pointermove', move);
        global.addEventListener('pointerup', up);
        global.addEventListener('keydown', keydown, true);
      });
    }

    /** Media drop: over a shape/frame → image FILL on that node (no new
     *  node); anywhere else → a regular image node at the drop point. */
    function retainedImageOverlay(node){
      const fill = objectValue(objectValue(objectValue(node).style).fill);
      if (fill.type === 'image' && cleanText(fill.overlay_color)) {
        return { color: cleanText(fill.overlay_color), opacity: Math.max(0, Math.min(1, Number(fill.overlay_opacity ?? 1))) };
      }
      if (fill.type !== 'solid' || !cleanText(fill.color)) return null;
      const opacity = Math.max(0, Math.min(1, Number(fill.opacity ?? 1)));
      // An ordinary opaque color is replaced by the dropped image. A color
      // the author deliberately made translucent is retained above it.
      return opacity < 1 ? { color: cleanText(fill.color), opacity } : null;
    }
    function applyImageFill(nodeId, mediaRef){
      if (!requireEditor()) return false;
      const editor = editorHandle;
      const found = M().findNode(editor.getDocument(), nodeId);
      if (!found) return false;
      if (found.node.type === 'image') {
        const props = { ...objectValue(found.node.props), media: mediaRef };
        if (props.crop) props.crop = null;
        const result = editor.apply({ type: 'node.set', node_id: nodeId, prop: 'props', value: props });
        if (result && result.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_bb1fbab1cbf958","Could not replace the image.") ?? "Could not replace the image."), false); return false; }
        editor.select([nodeId]);
        return true;
      }
      const overlay = retainedImageOverlay(found.node);
      const value = {
        type: 'image', media: mediaRef, fit: 'cover',
        ...(overlay ? { overlay_color: overlay.color, overlay_opacity: overlay.opacity } : {})
      };
      const res = editor.apply({ type: 'node.set', node_id: nodeId, prop: 'style.fill', value });
      if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_8ecf4da8ba08f7","Could not apply the image fill.") ?? "Could not apply the image fill."), false); return false; }
      editor.select([nodeId]);
      return true;
    }
    function applyPageImageFill(pageId, mediaRef){
      if (!requireEditor() || !pageId) return false;
      const found = M().findPage(editorHandle.getDocument(), pageId);
      if (!found) return false;
      const current = objectValue(objectValue(found.page).style).fill;
      const overlay = current.type === 'image' && cleanText(current.overlay_color)
        ? { color: cleanText(current.overlay_color), opacity: Math.max(0, Math.min(1, Number(current.overlay_opacity ?? 1))) }
        : (current.type === 'solid' && cleanText(current.color) && Number(current.opacity ?? 1) < 1
          ? { color: cleanText(current.color), opacity: Math.max(0, Math.min(1, Number(current.opacity ?? 1))) }
          : null);
      const value = {
        type: 'image', media: mediaRef, fit: 'cover',
        ...(overlay ? { overlay_color: overlay.color, overlay_opacity: overlay.opacity } : {})
      };
      const res = editorHandle.apply({ type: 'page.set', page_id: pageId, prop: 'style.fill', value });
      if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_fb811ade814c76","Could not apply the page background.") ?? "Could not apply the page background."), false); return false; }
      return true;
    }
    function handleMediaDrop(drop, mediaRef){
      if (drop.fillTarget?.page && applyPageImageFill(drop.fillTarget.pageId, mediaRef)) return;
      if (drop.fillTarget && applyImageFill(drop.fillTarget.nodeId, mediaRef)) return;
      insertNodeAtCenter(tplImage({ w: 220, h: 150 }, mediaRef), { clientX: drop.clientX, clientY: drop.clientY });
    }
    function mediaRefFromItem(item){
      const id = firstText(item.media_id, item.id);
      if (id && !/^(https?:|data:|blob:)/i.test(id)) return { media_id: id, variant: 'original' };
      const url = firstText(item.src, item.url, item.thumb);
      return url ? { url } : null;
    }

    // -------------------------------------------------------- panel: media
    // Single Media tab: upload button + org media library (Images | Designs |
    // Folders) PLUS project media browsing via search.
    async function loadMediaProjects(){
      if (state.mediaProjects || state.mediaProjectsLoading) return;
      if (!global.PlatformAPI?.projects?.list) { state.mediaProjects = []; return; }
      state.mediaProjectsLoading = true;
      try {
        const res = await global.PlatformAPI.projects.list(orgId());
        state.mediaProjects = arrayValue(objectValue(res).documents).map((entry) => {
          const data = objectValue(objectValue(entry).data);
          const name = firstText(data.title, data.project_title, data.project_name, data.name, data.address);
          return { id: cleanText(objectValue(entry).id), name };
        }).filter((p) => p.id && p.name);
      } catch (error) {
        state.mediaProjects = [];
      } finally {
        state.mediaProjectsLoading = false;
      }
    }

    async function openMediaProject(project){
      state.mediaProject = project;
      state.mediaProjectPhotos = null;
      state.mediaProjectPhotosLoading = true;
      renderChromePanel();
      try {
        state.mediaProjectPhotos = await global.PlatformAPI.projectMedia.listPhotos(orgId(), project.id);
      } catch (error) {
        state.mediaProjectPhotos = [];
      } finally {
        state.mediaProjectPhotosLoading = false;
        if (!destroyed && state.chromeTab === 'media' && state.mediaProject) renderChromePanel();
      }
    }

    function wireMediaThumb(el, item){
      const ref = mediaRefFromItem(item);
      if (!ref) return;
      const type = firstText(item.content_type, item.mime_type, item.type, objectValue(item.metadata).content_type).toLowerCase();
      const isVideo = type.startsWith('video/') || type.includes('video');
      const build = () => isVideo
        ? boundTplWidget('doc.video', { w: 400, h: 225 }, { name: 'Video', config: { media: ref } })
        : tplImage({ w: 220, h: 150 }, ref);
      wireInsertDrag(el, {
        media: true,
        ghost: `<i class="fas ${isVideo ? 'fa-video' : 'fa-image'}"></i>`,
        onClick: () => insertNodeAtCenter(build()),
        onDrop: (drop) => isVideo ? insertNodeAtCenter(build()) : handleMediaDrop(drop, ref)
      });
    }

    function renderMediaPanel(body){
      if (state.mediaProject) { renderMediaProjectView(body); return; }
      const subtab = state.uploadsSubtab || 'images';
      const originalUrl = (item) => {
        const id = firstText(item.id, item.media_id);
        if (!id || !global.PlatformAPI?.media?.fileUrl) return '';
        try { return global.PlatformAPI.media.fileUrl(orgId(), id, 'original'); } catch (e) { return ''; }
      };
      const thumbUrl = (item) => {
        const id = firstText(item.id, item.media_id);
        if (!id || !global.PlatformAPI?.media) return '';
        // Not every upload has a thumb variant — the <img> falls back to the
        // original via data-fallback + the error listener wired below.
        try { return global.PlatformAPI.media.thumbnailUrl ? global.PlatformAPI.media.thumbnailUrl(orgId(), id, 320) : originalUrl(item); } catch (e) { return ''; }
      };
      let gridHtml = '';
      if (!['images', 'videos'].includes(subtab)) {
        gridHtml = `<div class="fmwe-ch-empty"><i class="fas ${subtab === 'designs' ? 'fa-object-group' : 'fa-folder'}"></i><span>${subtab === 'designs' ? 'Saved designs will appear here.' : 'Folders will appear here.'}</span></div>`;
      } else if (state.uploadsLoading && !state.uploadsList) {
        gridHtml = '<div class="fmwe-ch-empty"><div class="fmwe-spinner"></div></div>';
      } else {
        const items = arrayValue(state.uploadsList).filter((item) => {
          const type = firstText(item.content_type, item.mime_type, item.type, objectValue(item.file).content_type).toLowerCase();
          const isVideo = type.startsWith('video/') || type.includes('video');
          return subtab === 'videos' ? isVideo : !isVideo;
        });
        gridHtml = items.length
          ? `<div class="fmwe-ch-upgrid">${items.map((item) => `
              <button type="button" class="fmwe-ch-upthumb" data-ch-up-item="${esc(firstText(item.id, item.media_id))}" title="${esc(firstText(item.name, 'Image'))}">
                ${subtab === 'videos'
                  ? `<span class="fmwe-ch-video-thumb"><i class="fas fa-circle-play"></i><small>${esc(firstText(item.name, 'Video'))}</small></span>`
                  : `<img src="${esc(thumbUrl(item))}" data-fallback="${esc(originalUrl(item))}" alt="${esc(firstText(item.name, 'Image'))}" loading="lazy" draggable="false">`}
              </button>`).join('')}</div>`
          : `<div class="fmwe-ch-empty"><i class="fas fa-images"></i><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_528572eb1ea92b","Nothing uploaded yet — your images will appear here.") ?? "Nothing uploaded yet — your images will appear here.")}</span></div>`;
      }
      const projectQuery = cleanText(state.chromeSearch.mediaProjects);
      let projectResultsHtml = '';
      if (projectQuery) {
        if (state.mediaProjectsLoading && !state.mediaProjects) {
          projectResultsHtml = `<div class="fmwe-ch-quiet">${(globalThis.PlatformLanguage?.text("visual-editor","m_5432ae3d406a83","Searching projects…") ?? "Searching projects…")}</div>`;
        } else {
          const q = projectQuery.toLowerCase();
          const hits = arrayValue(state.mediaProjects).filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
          projectResultsHtml = hits.length
            ? `<div class="fmwe-ch-projlist">${hits.map((p) => `
                <button type="button" class="fmwe-ch-projrow" data-ch-media-project="${esc(p.id)}" title="${esc(p.name)}">
                  <i class="fas fa-briefcase"></i><span>${esc(p.name)}</span><i class="fas fa-chevron-right chev"></i>
                </button>`).join('')}</div>`
            : `<div class="fmwe-ch-quiet">${(globalThis.PlatformLanguage?.text("visual-editor","m_0ca179bdb87766","No projects match that search.") ?? "No projects match that search.")}</div>`;
        }
      }
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_49e775f365e4e6","Media") ?? "Media")}</strong></div>
        <button type="button" class="fmwe-btn primary fmwe-ch-bigbtn" data-ch-up-btn><i class="fas fa-cloud-upload-alt"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_09c2e180e4119b"," Upload files") ?? " Upload files")}</button>
        <div class="fmwe-ch-search" style="margin-top:8px">
          <input type="search" data-ch-media-projsearch placeholder="${(globalThis.PlatformLanguage?.text("visual-editor","m_af80d9cead6991","Search projects") ?? "Search projects")}" value="${String(esc(projectQuery))}">
        </div>
        <div data-ch-media-projresults>${String(projectResultsHtml)}</div>
        <div class="fmwe-ch-subtabs">
          ${String(['images', 'videos', 'designs', 'folders'].map((id) => `
            <button type="button" class="${subtab === id ? 'active' : ''}" data-ch-up-tab="${id}">${id.charAt(0).toUpperCase() + id.slice(1)}</button>`).join(''))}
        </div>
        ${String(gridHtml)}`;
      body.querySelector('[data-ch-up-btn]')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        try {
          btn.disabled = true;
          const item = await uploadMediaFile(subtab === 'videos' ? 'video/*' : 'image/*');
          const mediaId = firstText(item.id, item.media_id);
          if (mediaId) {
            state.uploadsList = [item, ...arrayValue(state.uploadsList)];
            if (subtab === 'videos') insertNodeAtCenter(boundTplWidget('doc.video', { w: 400, h: 225 }, { name: 'Video', config: { media: { media_id: mediaId, variant: 'original' } } }));
            else insertNodeAtCenter(tplImage({ w: 220, h: 150 }, { media_id: mediaId, variant: 'original' }));
          }
          if (state.chromeTab === 'media') renderChromePanel();
        } catch (error) {
          if (!/No file selected/i.test(String(error?.message))) toast(firstText(error?.message, 'Upload failed.'), false);
          btn.disabled = false;
        }
      });
      const projSearch = body.querySelector('[data-ch-media-projsearch]');
      projSearch?.addEventListener('input', () => {
        state.chromeSearch.mediaProjects = projSearch.value;
        loadMediaProjects().then(() => {
          if (!destroyed && state.chromeTab === 'media' && !state.mediaProject) renderChromePanel();
        });
        renderChromePanel();
        const next = root.querySelector('[data-ch-media-projsearch]');
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });
      body.querySelectorAll('[data-ch-media-project]').forEach((el) => el.addEventListener('click', () => {
        const project = arrayValue(state.mediaProjects).find((p) => p.id === el.dataset.chMediaProject);
        if (project) openMediaProject(project);
      }));
      body.querySelectorAll('[data-ch-up-tab]').forEach((el) => el.addEventListener('click', () => {
        state.uploadsSubtab = el.dataset.chUpTab;
        renderChromePanel();
      }));
      body.querySelectorAll('[data-ch-up-item]').forEach((el) => {
        const item = arrayValue(state.uploadsList).find((entry) => firstText(entry.id, entry.media_id) === el.dataset.chUpItem) || { media_id: el.dataset.chUpItem };
        wireMediaThumb(el, item);
        const img = el.querySelector('img');
        if (img) img.addEventListener('error', () => {
          const fallback = cleanText(img.dataset.fallback);
          if (fallback && img.src !== fallback) img.src = fallback;
        }, { once: true });
      });
      if (!state.uploadsList && !state.uploadsLoading) {
        loadUploadsList().then(() => { if (!destroyed && state.chromeTab === 'media') renderChromePanel(); });
      }
    }

    function renderMediaProjectView(body){
      const project = objectValue(state.mediaProject);
      const photos = arrayValue(state.mediaProjectPhotos).filter((p) => global.PlatformAPI?.projectMedia?.isImage ? global.PlatformAPI.projectMedia.isImage(p) : true);
      let gridHtml;
      if (state.mediaProjectPhotosLoading) {
        gridHtml = '<div class="fmwe-ch-empty"><div class="fmwe-spinner"></div></div>';
      } else if (!photos.length) {
        gridHtml = `<div class="fmwe-ch-empty"><i class="fas fa-images"></i><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_d8dbfdeabae6ba","No photos on this project yet.") ?? "No photos on this project yet.")}</span></div>`;
      } else {
        gridHtml = `<div class="fmwe-ch-upgrid">${photos.map((photo, index) => `
          <button type="button" class="fmwe-ch-upthumb" data-ch-media-photo="${esc(firstText(photo.id, String(index)))}" title="${esc(firstText(photo.label, 'Photo'))}">
            <img src="${esc(firstText(photo.thumb, photo.src))}" alt="${esc(firstText(photo.alt, 'Photo'))}" loading="lazy" draggable="false">
          </button>`).join('')}</div>`;
      }
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_49e775f365e4e6","Media") ?? "Media")}</strong></div>
        <button type="button" class="fmwe-ch-back" data-ch-media-back><i class="fas fa-chevron-left"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_899b0e7d1286f7"," Back to media library") ?? " Back to media library")}</button>
        <p class="fmwe-micro-label"><i class="fas fa-briefcase"></i> ${String(esc(firstText(project.name, 'Project')))} <span class="count">${String(photos.length)}</span></p>
        ${String(gridHtml)}`;
      body.querySelector('[data-ch-media-back]')?.addEventListener('click', () => {
        state.mediaProject = null;
        state.mediaProjectPhotos = null;
        renderChromePanel();
      });
      body.querySelectorAll('[data-ch-media-photo]').forEach((el) => {
        const photo = photos.find((p, index) => firstText(p.id, String(index)) === el.dataset.chMediaPhoto);
        if (photo) wireMediaThumb(el, photo);
      });
    }

    // --------------------------------------------------------- panel: text
    function renderTextPanel(body){
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_124287f184b88b","Text") ?? "Text")}</strong></div>
        <button type="button" class="fmwe-btn primary fmwe-ch-bigbtn" data-ch-text-add><i class="fas fa-font"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_b4eed681c89576"," Add a text box") ?? " Add a text box")}</button>
        <p class="fmwe-micro-label">${(globalThis.PlatformLanguage?.text("visual-editor","m_e59ed8c37894a1","Default text styles") ?? "Default text styles")}</p>
        <div class="fmwe-ch-textstyles">
          <button type="button" class="fmwe-ch-textstyle heading" data-ch-text-style="heading">${(globalThis.PlatformLanguage?.text("visual-editor","m_50a1e467512d0d","Add a heading") ?? "Add a heading")}</button>
          <button type="button" class="fmwe-ch-textstyle subheading" data-ch-text-style="subheading">${(globalThis.PlatformLanguage?.text("visual-editor","m_c815e22524bcb6","Add a subheading") ?? "Add a subheading")}</button>
          <button type="button" class="fmwe-ch-textstyle body" data-ch-text-style="body">${(globalThis.PlatformLanguage?.text("visual-editor","m_c9fd1ce5ba3834","Add a little bit of body text") ?? "Add a little bit of body text")}</button>
        </div>`;
      const textBuilders = {
        add: () => tplText('Your text', { w: 220, h: 30 }, { size_pt: 14, weight: 700 }, { name: 'Text' }),
        heading: () => tplText('Add a heading', { w: 340, h: 42 }, { size_pt: 28, weight: 900 }, { name: 'Text' }),
        subheading: () => tplText('Add a subheading', { w: 280, h: 30 }, { size_pt: 18, weight: 800 }, { name: 'Text' }),
        body: () => tplText('Add a little bit of body text', { w: 260, h: 24 }, { size_pt: 12, weight: 400 }, { name: 'Text' })
      };
      const wireText = (el, key) => {
        if (!el) return;
        wireInsertDrag(el, {
          ghost: '<i class="fas fa-font"></i> Text',
          onClick: () => { if (requireEditor()) insertNodeAtCenter(textBuilders[key]()); },
          onDrop: (drop) => { if (requireEditor()) insertNodeAtCenter(textBuilders[key](), { clientX: drop.clientX, clientY: drop.clientY }); }
        });
      };
      wireText(body.querySelector('[data-ch-text-add]'), 'add');
      wireText(body.querySelector('[data-ch-text-style="heading"]'), 'heading');
      wireText(body.querySelector('[data-ch-text-style="subheading"]'), 'subheading');
      wireText(body.querySelector('[data-ch-text-style="body"]'), 'body');
    }

    // -------------------------------------------------------- panel: brand
    /** Load the org's REAL saved branding the same way settings/company.js
     *  does: organization.branding < global.branding < branch.branding (colors
     *  merged per-key), plus branding media assets for alternate logos. */
    async function loadBrandKit(force){
      if (state.brandKit && !force) return state.brandKit;
      if (state.brandKitLoading) return null;
      state.brandKitLoading = true;
      try {
        const oid = orgId();
        let branding = objectValue(orgBranding());
        if (global.PlatformAPI?.orgs?.portalState) {
          try {
            const ps = await global.PlatformAPI.orgs.portalState(oid);
            const layers = [
              objectValue(objectValue(objectValue(ps).organization).data).branding,
              objectValue(objectValue(objectValue(ps).global).data).branding,
              objectValue(objectValue(objectValue(ps).branch).data).branding
            ].map(objectValue);
            const merged = Object.assign({}, branding, ...layers);
            merged.colors = Object.assign({}, objectValue(branding.colors), ...layers.map((layer) => objectValue(layer.colors)));
            branding = merged;
          } catch (e) { /* keep the boot-time branding */ }
        }
        let media = [];
        if (global.PlatformAPI?.brandingMedia?.list) {
          try {
            const res = await global.PlatformAPI.brandingMedia.list(oid);
            media = arrayValue(objectValue(res).media).map((item) =>
              global.PlatformAPI.brandingMedia.imageRef ? global.PlatformAPI.brandingMedia.imageRef(oid, item) : objectValue(item));
          } catch (e) { /* empty state */ }
        }
        state.brandKit = { branding, media, logo: brandKitLogoUrl(branding) };
      } finally {
        state.brandKitLoading = false;
      }
      return state.brandKit;
    }

    /** Same resolution ladder as settings/company.js logoFromBranding. */
    function brandKitLogoUrl(branding){
      const b = objectValue(branding);
      const canonical = cleanText(typeof b.logo === 'string' ? b.logo : objectValue(b.logo).url);
      if (canonical === '/images/logo_red.png') return '';
      if (/^(https?:|blob:|data:|\/)/i.test(canonical)) return canonical;
      const direct = cleanText(firstText(b.logo_node_url, b.logoNodeUrl, b.logo_url, b.logoUrl, b.companyLogo, b.brandLogo));
      if (direct) return direct === '/images/logo_red.png' ? '' : direct;
      const mediaId = firstText(b.logo_media_id, b.logoMediaId, b.logo_media, b.logoMedia);
      if (mediaId && global.PlatformAPI?.media?.fileUrl) return global.PlatformAPI.media.fileUrl(orgId(), mediaId, 'original');
      return canonical;
    }

    function brandColorEntries(branding){
      const b = objectValue(branding || (state.brandKit ? state.brandKit.branding : orgBranding()));
      const colors = objectValue(b.colors);
      const out = [];
      const push = (label, value) => {
        const hex = cleanText(value);
        if (!hex || !parseCssColor(hex)) return;
        if (out.some((entry) => entry.hex.toLowerCase() === hex.toLowerCase())) return;
        out.push({ label, hex });
      };
      push('Primary', firstText(colors.primary, b.primary));
      push('Secondary', firstText(colors.secondary, b.secondary));
      arrayValue(colors.palette).forEach((value, index) => {
        push(index === 0 ? 'Primary' : index === 1 ? 'Secondary' : `Support ${index - 1}`, value);
      });
      push('Accent', firstText(colors.accent, b.accent));
      Object.keys(colors).forEach((key) => {
        if (['primary', 'secondary', 'accent', 'palette'].includes(key)) return;
        push(key.charAt(0).toUpperCase() + key.slice(1), colors[key]);
      });
      if (!out.length) push('Primary', brandPrimary());
      return out;
    }

    function renderBrandPanel(body){
      const kit = state.brandKit;
      if (!kit) {
        body.innerHTML = `
          <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_38e15f7a2dd540","Brand Kit") ?? "Brand Kit")}</strong></div>
          <div class="fmwe-ch-empty"><div class="fmwe-spinner"></div></div>`;
        loadBrandKit().then((loaded) => {
          if (loaded && !destroyed && state.chromeTab === 'brand') renderChromePanel();
        });
        return;
      }
      const branding = objectValue(kit.branding);
      const swatches = brandColorEntries(branding);
      const logoHtml = kit.logo && /^(https?:\/\/|\/|data:|blob:)/i.test(kit.logo)
        ? ("<img class=\"cp-logo\" src=\"" + String(esc(kit.logo)) + "\" alt=\"" + ((v1) => globalThis.PlatformLanguage?.text("visual-editor","m_284af142776c08",`${v1} logo`,{v1}) ?? `${v1} logo`)(esc(orgName())) + "\">")
        : portalLogoHtml(branding, orgName());
      const mediaItems = arrayValue(kit.media);
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_38e15f7a2dd540","Brand Kit") ?? "Brand Kit")}</strong></div>
        <p class="fmwe-micro-label">${(globalThis.PlatformLanguage?.text("visual-editor","m_177f1dc4fdc914","Company logo") ?? "Company logo")}</p>
        <div class="fmwe-ch-brandlogo" data-ch-brand-logo>${String(logoHtml)}</div>
        <p class="fmwe-micro-label">${(globalThis.PlatformLanguage?.text("visual-editor","m_606bb067eca1c7","Brand colors") ?? "Brand colors")}</p>
        <div class="fmwe-ch-swatches">
          ${String(swatches.map((entry) => `
            <button type="button" class="fmwe-ch-swatch" data-ch-brand-swatch="${esc(entry.hex)}" title="${esc(entry.label)} · ${esc(entry.hex)}" style="background:${esc(entry.hex)}"></button>`).join(''))}
        </div>
        <p class="fmwe-ch-quiet">${(globalThis.PlatformLanguage?.text("visual-editor","m_b61b8ea89f39ff","Click a swatch to color the selected element — with nothing selected it copies the hex.") ?? "Click a swatch to color the selected element — with nothing selected it copies the hex.")}</p>
        <p class="fmwe-micro-label">${(globalThis.PlatformLanguage?.text("visual-editor","m_c0838c60ccd34f","Alternate logos ") ?? "Alternate logos ")}<span class="count">${String(mediaItems.length)}</span></p>
        <div data-ch-brand-media-grid>
          ${String(mediaItems.length
            ? `<div class="fmwe-ch-altlogos">${mediaItems.map((item) => `
                <button type="button" class="alt" data-ch-brand-media="${esc(firstText(item.media_id, item.id))}" title="${esc(firstText(item.label, 'Branding image'))}">
                  <img src="${esc(firstText(item.thumb, item.src))}" alt="${esc(firstText(item.label, 'Branding image'))}" draggable="false">
                </button>`).join('')}</div>`
            : '<p class="fmwe-ch-quiet">Upload alternate logo versions under Settings → Company and they appear here.</p>')}
        </div>`;
      body.querySelectorAll('[data-ch-brand-swatch]').forEach((el) => el.addEventListener('click', () => applyBrandColor(el.dataset.chBrandSwatch)));
      body.querySelectorAll('[data-ch-brand-media]').forEach((el) => {
        const item = mediaItems.find((entry) => firstText(entry.media_id, entry.id) === el.dataset.chBrandMedia);
        if (item) wireMediaThumb(el, item);
      });
    }

    function applyBrandColor(hex){
      const editor = editorHandle;
      const selection = editor && typeof editor.selection === 'function' ? editor.selection() : [];
      if (!editor || !selection.length) {
        copyText(hex).then((ok) => toast(ok ? `${hex} copied to your clipboard.` : 'Could not copy the color.', ok));
        return;
      }
      const d = editor.getDocument();
      let applied = 0;
      selection.forEach((id) => {
        const found = M().findNode(d, id);
        if (!found) return;
        const node = found.node;
        if (node.type === 'text') {
          const blocks = clone(arrayValue(objectValue(node.props).blocks));
          if (blocks.length) {
            blocks.forEach((block) => arrayValue(block.runs).forEach((run) => { run.color = hex; }));
            const res = editor.apply({ type: 'node.set', node_id: id, prop: 'props.blocks', value: blocks });
            if (res && res.ok !== false) applied += 1;
            return;
          }
        }
        const res = editor.apply({ type: 'node.set', node_id: id, prop: 'style.fill', value: { type: 'solid', color: hex } });
        if (res && res.ok !== false) applied += 1;
      });
      if (applied) toast((globalThis.PlatformLanguage?.text("visual-editor","m_61fa2f411f5866","Brand color applied.") ?? "Brand color applied."), true);
    }

    // ------------------------------------------------------ media library
    async function loadUploadsList(force){
      if (state.uploadsList && !force) return;
      if (!global.PlatformAPI?.media?.list) { state.uploadsList = []; return; }
      state.uploadsLoading = true;
      try {
        const res = await global.PlatformAPI.media.list(orgId());
        const items = arrayValue(objectValue(res).media || objectValue(res).items).map(objectValue)
          .sort((a, b) => new Date(b.created_at || b.uploaded_at || 0) - new Date(a.created_at || a.uploaded_at || 0))
          .slice(0, 40);
        state.uploadsList = items;
        state.uploadsError = null;
      } catch (error) {
        state.uploadsList = [];
        state.uploadsError = error;
      } finally {
        state.uploadsLoading = false;
      }
    }

    function uploadMediaFile(accept = 'image/*'){
      return new Promise((resolve, reject) => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) { reject(new Error('No file selected.')); return; }
          try {
            if (!global.PlatformAPI?.media?.upload) throw new Error('Media uploads are unavailable.');
            const result = await global.PlatformAPI.media.upload(orgId(), file, uploadMeta());
            resolve(objectValue(objectValue(result).media || result));
          } catch (error) { reject(error); }
        };
        input.click();
      });
    }

    // ------------------------------------------------------- panel: markup
    /** Slim vertical markup dock hugging the canvas's left edge (mirrors the
     *  photo viewer's markup dock look). */
    function removeMarkupDock(){
      root.querySelector('[data-ch-mk-dock]')?.remove();
    }

    function renderMarkupDock(){
      removeMarkupDock();
      const canvas = chromeCanvasEl();
      const editorBody = canvas?.parentElement;
      if (!canvas || !editorBody || !markupOpts || !chromeActive()) return;
      const session = state.markupSession;
      const paletteHtml = global.FirstMateMarkup?.markupColorPaletteHtml
        ? global.FirstMateMarkup.markupColorPaletteHtml(state.markupColor)
        : '';
      const dock = doc.createElement('div');
      dock.className = 'fmwe-mkdock';
      dock.setAttribute('data-ch-mk-dock', '');
      dock.innerHTML = `
        ${String(MARKUP_TOOLS.map((tool) => `
          <button type="button" class="fmwe-mkdock-btn ${session && session.tool === tool.id ? 'active' : ''}" data-ch-mk-tool="${tool.id}" title="${tool.name}">
            <i class="fas ${tool.icon}"></i>
          </button>`).join(''))}
        <div class="fmwe-mkdock-colorwrap">
          <button type="button" class="fmwe-mkdock-btn swatch" data-ch-mk-colortoggle title="${(globalThis.PlatformLanguage?.text("visual-editor","m_db7002926d9977","Color") ?? "Color")}">
            <span class="dot" style="background:${String(esc(state.markupColor))}"></span>
          </button>
          <div class="fmwe-mkdock-pop" data-ch-mk-colorpop>${String(paletteHtml)}</div>
        </div>
        <button type="button" class="fmwe-mkdock-btn" data-ch-mk-undo title="${(globalThis.PlatformLanguage?.text("visual-editor","m_4004b71744b54e","Undo") ?? "Undo")}" ${String(session ? '' : 'disabled')}><i class="fas fa-undo"></i></button>
        <span class="fmwe-mkdock-sep"></span>
        <button type="button" class="fmwe-mkdock-btn done" data-ch-mk-done title="${(globalThis.PlatformLanguage?.text("visual-editor","m_8cb6b086a0e69c","Done") ?? "Done")}" ${String(session ? '' : 'disabled')}><i class="fas fa-check"></i></button>`;
      // .fmde-body starts below the editor toolbar. Offset from its canvas
      // child so the dock sits just beyond the Visual rail without becoming
      // part of the canvas's scrolling content.
      dock.style.left = `${canvas.offsetLeft + 10}px`;
      editorBody.appendChild(dock);
      dock.querySelectorAll('[data-ch-mk-tool]').forEach((el) => el.addEventListener('click', () => {
        startMarkupSession(el.dataset.chMkTool);
      }));
      const pop = dock.querySelector('[data-ch-mk-colorpop]');
      dock.querySelector('[data-ch-mk-colortoggle]')?.addEventListener('click', () => {
        pop?.classList.toggle('visible');
      });
      const setDockColor = (hex) => {
        const color = cleanText(hex);
        if (!color) return;
        state.markupColor = color;
        if (state.markupSession) {
          try { state.markupSession.instance.setColor(color); } catch (e) { /* noop */ }
          state.markupSession.color = color;
        }
        renderChromePanel();
      };
      pop?.querySelectorAll('[data-markup-color]').forEach((el) => el.addEventListener('click', () => setDockColor(el.dataset.markupColor)));
      pop?.querySelector('input[type="color"]')?.addEventListener('input', (event) => setDockColor(event.target.value));
      dock.querySelector('[data-ch-mk-undo]')?.addEventListener('click', () => {
        try { state.markupSession?.instance?.undo?.(); } catch (e) { /* noop */ }
      });
      dock.querySelector('[data-ch-mk-done]')?.addEventListener('click', () => endMarkupSession());
    }

    function markupNodeFromDoc(pageId){
      if (!editorReady()) return null;
      const d = editorHandle.getDocument();
      if (d && d.kind !== 'view') {
        const found = M().findPage(d, pageId || state.fmveActivePageId);
        return arrayValue(objectValue(objectValue(found).page).children).find((n) => n && n.type === 'markup_overlay') || null;
      }
      return arrayValue(objectValue(d.root).children).find((n) => n && n.type === 'markup_overlay') || null;
    }

    function pagePxPerPt(){
      // Derive from a rendered section (rect height / frame.h) — correct at
      // any zoom and for fluid ("fill") pages.
      if (editorReady()) {
        const d = editorHandle.getDocument();
        if (d && d.kind !== 'view') {
          const target = pageInsertionTarget();
          const paper = M().paperDimensions(d);
          if (target && target.rect.width > 2 && paper.w_pt) return target.rect.width / paper.w_pt;
        }
        for (const section of arrayValue(objectValue(d.root).children)) {
          if (!section || section.type !== 'frame') continue;
          const h = numberValue(objectValue(section.frame).h);
          if (!h) continue;
          const el = root.querySelector(`[data-node-id="${section.id}"]`);
          const rect = el ? el.getBoundingClientRect() : null;
          if (rect && rect.height > 2) return rect.height / h;
        }
      }
      return PT_TO_PX;
    }

    function startMarkupSession(tool){
      if (!requireEditor()) return;
      if (!global.FirstMateMarkup?.PhotoMarkup) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_5ae6c4c1ee9f3f","The markup library is not loaded.") ?? "The markup library is not loaded."), false); return; }
      if (state.markupSession) { setMarkupTool(tool); return; }
      const pageTarget = pageInsertionTarget();
      const page = pageTarget?.pageEl || chromePageEl();
      if (!page) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_81b4bb3c5fb323","The page canvas is still loading.") ?? "The page canvas is still loading."), false); return; }
      const pageId = pageTarget?.page?.id || '';
      const existing = markupNodeFromDoc(pageId);
      // Geometry: the overlay must exactly match the markup node's frame so
      // the normalized 0..1 items line up between the session and the
      // renderer. Nodes are laid out in CSS pt units, so the overlay is sized
      // in pt too (fluid "fill" pages render .fmdoc-page at 0 CSS width — an
      // inset:0 overlay would collapse there).
      const existingFrame = objectValue(objectValue(existing).frame);
      const pageRect = page.getBoundingClientRect();
      const pxPerPt = pagePxPerPt();
      const framePt = {
        w: numberValue(existingFrame.w) || (pageRect.width > 2 ? round2(pageRect.width / pxPerPt) : designWidthPt()),
        h: numberValue(existingFrame.h) || (pageRect.height > 2 ? round2(pageRect.height / pxPerPt) : 400)
      };
      if (!Number.isFinite(framePt.w) || framePt.w <= 0) framePt.w = designWidthPt();
      if (!Number.isFinite(framePt.h) || framePt.h <= 0) framePt.h = 400;
      const overlay = doc.createElement('div');
      overlay.className = 'fmwe-markup-host';
      overlay.setAttribute('data-ch-mk-overlay', '');
      overlay.style.width = `${framePt.w}pt`;
      overlay.style.height = `${framePt.h}pt`;
      page.appendChild(overlay);
      rootEl.classList.add('fmwe-markup-live');
      let instance = null;
      try {
        instance = new global.FirstMateMarkup.PhotoMarkup(overlay, {
          items: clone(arrayValue(objectValue(objectValue(existing).props).items)),
          onChange: (items) => scheduleMarkupPersist(items)
        });
      } catch (error) {
        overlay.remove();
        rootEl.classList.remove('fmwe-markup-live');
        toast(firstText(error?.message, 'Could not start markup.'), false);
        return;
      }
      instance.tool = MARKUP_TOOLS.some((t) => t.id === tool) ? tool : 'pen';
      instance.setActive(true);
      try { instance.setColor(state.markupColor); } catch (e) { /* noop */ }
      state.markupSession = {
        instance,
        overlay,
        framePt,
        tool: instance.tool,
        color: instance.color,
        nodeId: existing ? existing.id : '',
        pageId,
        timer: 0,
        pendingItems: null
      };
      removeSectionChrome();
      renderChromePanel();
    }

    function setMarkupTool(tool){
      const session = state.markupSession;
      if (!session) return;
      session.tool = MARKUP_TOOLS.some((t) => t.id === tool) ? tool : session.tool;
      session.instance.tool = session.tool;
      session.instance.setActive(true);
      renderChromePanel();
    }

    function scheduleMarkupPersist(items){
      const session = state.markupSession;
      if (!session) return;
      session.pendingItems = clone(Array.isArray(items) ? items : []);
      clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = 0;
        persistMarkup();
      }, 500);
    }

    /** Persist the session's items into ONE page-level markup_overlay node
     *  (anchor:"page" escapes flow — it renders absolutely in page space).
     *  chrome.markup.persist(items, session) overrides this default. */
    function persistMarkup(){
      const session = state.markupSession;
      if (!session || !editorReady() || !session.pendingItems) return;
      const items = session.pendingItems;
      session.pendingItems = null;
      if (markupOpts && typeof markupOpts.persist === 'function') {
        try { markupOpts.persist(items, session); } catch (e) { /* host handles */ }
        return;
      }
      const editor = editorHandle;
      if (session.nodeId && M().findNode(editor.getDocument(), session.nodeId)) {
        editor.apply({ type: 'node.set', node_id: session.nodeId, prop: 'props.items', value: items });
        return;
      }
      const framePt = objectValue(session.framePt);
      const w = numberValue(framePt.w) || designWidthPt();
      const h = numberValue(framePt.h) || 400;
      const node = M().createNode('markup_overlay', {
        name: 'Markup',
        anchor: 'page',
        frame: { x: 0, y: 0, w, h, z: 9000, layout: 'absolute' },
        props: { items }
      });
      const command = { type: 'node.insert', node, parent_id: null };
      if (editor.getDocument().kind !== 'view') command.page_id = session.pageId || state.fmveActivePageId;
      const res = editor.apply(command);
      if (res && res.ok !== false) session.nodeId = node.id;
    }

    function endMarkupSession(options = {}){
      const session = state.markupSession;
      if (!session) return;
      clearTimeout(session.timer);
      session.timer = 0;
      if (session.pendingItems) persistMarkup();
      try { session.instance?.destroy?.(); } catch (e) { /* noop */ }
      try { session.overlay?.remove(); } catch (e) { /* noop */ }
      rootEl.classList.remove('fmwe-markup-live');
      state.markupSession = null;
      if (!options.silent && state.chromeTab === 'markup') renderChromePanel();
      if (!options.silent) updateSectionChrome();
    }

    // ----------------------------------------------------------- panel: qr
    function renderQrPanel(body){
      body.innerHTML = `
        <div class="fmwe-ch-head"><strong>${(globalThis.PlatformLanguage?.text("visual-editor","m_afe7e75cbcc4c9","QR codes") ?? "QR codes")}</strong></div>
        <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_b90b7e637a2076","URL") ?? "URL")}</span>
          <input type="text" data-ch-qr-url placeholder="https://example.com" spellcheck="false" value="${String(esc(firstText(state.chromeSearch.qr)))}">
        </label>
        <button type="button" class="fmwe-btn primary fmwe-ch-bigbtn" data-ch-qr-insert><i class="fas fa-qrcode"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_d47d525aca0fda"," Insert QR code") ?? " Insert QR code")}</button>
        <p class="fmwe-ch-quiet">${(globalThis.PlatformLanguage?.text("visual-editor","m_6f53b52a5d182f","The code updates live — change the URL later from the element's settings.") ?? "The code updates live — change the URL later from the element's settings.")}</p>`;
      const input = body.querySelector('[data-ch-qr-url]');
      input?.addEventListener('input', () => { state.chromeSearch.qr = input.value; });
      body.querySelector('[data-ch-qr-insert]')?.addEventListener('click', () => {
        if (!requireEditor()) return;
        const url = cleanText(input?.value);
        insertNodeAtCenter(boundTplWidget('doc.qr', { w: 96, h: 96 }, { name: 'QR code', config: { url } }));
      });
    }

    // ---------------------------------------------- section management chrome
    // Canva-style section controls: floating mini-buttons at the selected
    // section's left edge (copy / lock / delete) plus a centered pill above
    // or below it ([Ask][Position][Width]). Appearance editing deliberately
    // stays in the shared top bar and right-click menu so sections and inserted
    // elements use the same background, image, opacity, border, and corner UI.
    // Positions track the section
    // through selection changes, document changes, scroll and zoom.
    function allRootSections(){
      if (!editorReady()) return [];
      const d = editorHandle.getDocument();
      return arrayValue(objectValue(d.root).children).filter((n) => n && n.type === 'frame');
    }
    function mobileVariantActive(){
      try { return !!editorHandle.getViewportWidth?.(); } catch (e) { return false; }
    }
    function rootSections(){
      if (!editorReady()) return [];
      const d = editorHandle.getDocument();
      return typeof M().activeViewSections === 'function'
        ? M().activeViewSections(d, mobileVariantActive() ? 'mobile' : 'desktop')
        : allRootSections();
    }
    function sectionById(id){
      return rootSections().find((n) => cleanText(n.id) === cleanText(id)) || null;
    }
    function anySectionById(id){
      return allRootSections().find((n) => cleanText(n.id) === cleanText(id)) || null;
    }
    function desktopSection(section){
      const d = editorHandle.getDocument();
      return typeof M().desktopViewSection === 'function' ? M().desktopViewSection(d, section) : section;
    }
    function mobileSection(section){
      const d = editorHandle.getDocument();
      return typeof M().mobileViewSection === 'function' ? M().mobileViewSection(d, section) : null;
    }
    function findDescendant(rootNode, predicate){
      let match = null;
      (function walk(node){
        if (!node || match) return;
        if (predicate(node)) { match = node; return; }
        arrayValue(node.children).forEach(walk);
      })(rootNode);
      return match;
    }
    function sectionContainingNode(nodeId){
      return allRootSections().find((section) => !!findDescendant(section, (node) => cleanText(node.id) === cleanText(nodeId))) || null;
    }
    function variantCounterpartId(nodeId, variant){
      const d = editorHandle.getDocument();
      const sourceSection = sectionContainingNode(nodeId);
      if (!sourceSection) return nodeId;
      const desktop = M().desktopViewSection(d, sourceSection);
      const mobile = M().mobileViewSection(d, desktop);
      if (variant === 'desktop') {
        const selected = findDescendant(sourceSection, (node) => cleanText(node.id) === cleanText(nodeId));
        return firstText(objectValue(selected).props?.variant_source_id, desktop && desktop.id, nodeId);
      }
      if (!mobile || objectValue(desktop.props).mobile_variant_enabled !== true || objectValue(mobile.props).mobile_enabled !== true) return nodeId;
      const target = findDescendant(mobile, (node) => cleanText(objectValue(node).props?.variant_source_id) === cleanText(nodeId));
      return firstText(objectValue(target).id, mobile.id);
    }
    function nodeWithinSection(nodeId, sectionId){
      const section = sectionById(sectionId);
      if (!section) return false;
      let found = false;
      (function walk(n){
        if (!n || found) return;
        if (cleanText(n.id) === cleanText(nodeId)) { found = true; return; }
        arrayValue(n.children).forEach(walk);
      })(section);
      return found;
    }

    function removeSectionChrome(){
      if (resizeObs && resizeObservedSectionEl) {
        try { resizeObs.unobserve(resizeObservedSectionEl); } catch (e) { /* detached during render */ }
      }
      resizeObservedSectionEl = null;
      state.sectionChromeId = '';
      state.sectionPopover = '';
      state.sectionWidthOpen = false;
      root.querySelector('[data-ch-sec-actions]')?.remove();
      root.querySelector('[data-ch-sec-mobile-actions]')?.remove();
      root.querySelector('[data-ch-sec-pill]')?.remove();
    }

    function onSectionWidthOutsideClick(event){
      if (!state.sectionWidthOpen) return;
      const target = event && event.target;
      if (target && typeof target.closest === 'function'
        && target.closest('[data-ch-sec-width], [data-ch-sec-width-pop]')) return;
      // Let the outside target finish its own click work before rebuilding the
      // section chrome; removing it during capture can swallow that click.
      global.setTimeout(() => {
        if (destroyed || !state.sectionWidthOpen) return;
        state.sectionWidthOpen = false;
        renderSectionChrome();
      }, 0);
    }

    function updateSectionChrome(){
      if (!editorReady() || !chromeActive() || state.markupSession) { removeSectionChrome(); return; }
      const selection = editorHandle.selection();
      if (collectionIsSections && selection.length === 1) {
        const activeSection = rootSections().find((section) => cleanText(section.id) === cleanText(selection[0]) || nodeWithinSection(selection[0], section.id));
        if (activeSection) {
          const canonical = desktopSection(activeSection) || activeSection;
          if (cleanText(canonical.id) !== cleanText(state.fmveActiveSectionId)) {
            state.fmveActiveSectionId = cleanText(canonical.id);
            renderPagesStrip();
          }
          const changed = cleanText(state.sectionChromeId) !== cleanText(activeSection.id);
          state.sectionChromeId = cleanText(activeSection.id);
          if (changed) { state.sectionPopover = ''; state.sectionWidthOpen = false; }
          // Section controls remain available while editing any descendant;
          // they describe the containing section without replacing the item
          // selection or its own transform controls.
          renderSectionChrome();
          return;
        }
      }
      // Keep the Position popover alive while the user works through its
      // layer rows (row click selects the child, which changes selection).
      if (state.sectionPopover === 'position' && state.sectionChromeId
        && selection.length === 1 && nodeWithinSection(selection[0], state.sectionChromeId)) {
        renderSectionChrome();
        return;
      }
      removeSectionChrome();
    }

    function renderSectionChrome(){
      const canvas = canvasHolder();
      const section = sectionById(state.sectionChromeId);
      if (!canvas || !section) { removeSectionChrome(); return; }
      root.querySelector('[data-ch-sec-actions]')?.remove();
      root.querySelector('[data-ch-sec-mobile-actions]')?.remove();
      root.querySelector('[data-ch-sec-pill]')?.remove();
      const locks = objectValue(section.locks);
      const locked = locks.move === true;
      const actions = doc.createElement('div');
      actions.className = 'fmwe-sec-actions';
      actions.setAttribute('data-ch-sec-actions', '');
      actions.innerHTML = `
        <button type="button" data-ch-sec-duplicate title="${(globalThis.PlatformLanguage?.text("visual-editor","m_8adbae212858a1","Copy section") ?? "Copy section")}"><i class="fas fa-clone"></i></button>
        <button type="button" data-ch-sec-lock title="${String(locked ? 'Unlock section' : 'Lock section')}" class="${String(locked ? 'active' : '')}"><i class="fas ${String(locked ? 'fa-lock' : 'fa-lock-open')}"></i></button>
        <button type="button" data-ch-sec-delete title="${(globalThis.PlatformLanguage?.text("visual-editor","m_7b78fd90e05b38","Delete section") ?? "Delete section")}" class="danger"><i class="fas fa-trash-can"></i></button>`;
      const desktop = desktopSection(section) || section;
      const mobile = mobileSection(desktop);
      const mobileEnabled = objectValue(desktop.props).mobile_variant_enabled === true && objectValue(objectValue(mobile).props).mobile_enabled === true;
      const mobileActions = doc.createElement('div');
      mobileActions.className = 'fmwe-sec-mobile-actions';
      mobileActions.setAttribute('data-ch-sec-mobile-actions', '');
      mobileActions.innerHTML = `
        <button type="button" data-ch-sec-mobile-toggle title="${(globalThis.PlatformLanguage?.text("visual-editor","m_c68951a4723d6e","Use a different mobile version") ?? "Use a different mobile version")}" aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_c68951a4723d6e","Use a different mobile version") ?? "Use a different mobile version")}" class="${String(mobileEnabled ? 'active' : '')}" aria-pressed="${String(mobileEnabled ? 'true' : 'false')}"><i class="fas fa-mobile-screen-button"></i></button>
        <button type="button" data-ch-sec-mobile-magic title="${(globalThis.PlatformLanguage?.text("visual-editor","m_0230b566c446cb","Magic Mobile") ?? "Magic Mobile")}" aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_0230b566c446cb","Magic Mobile") ?? "Magic Mobile")}"><i class="fas fa-wand-magic-sparkles"></i></button>`;
      const pill = doc.createElement('div');
      pill.className = 'fmwe-sec-pill';
      pill.setAttribute('data-ch-sec-pill', '');
      const widthControl = chromeOpts.sectionWidthLocked === true ? '' : `
        <button type="button" data-ch-sec-width title="${(globalThis.PlatformLanguage?.text("visual-editor","m_13e5dfb1725bac","Section width") ?? "Section width")}" class="${String(state.sectionWidthOpen ? 'active' : '')}" ${String(locks.resize === true ? 'disabled' : '')}><i class="fas fa-arrows-left-right"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_16686f0c64b5ec"," Width") ?? " Width")}</button>
        <div class="fmwe-sec-width-pop ${String(state.sectionWidthOpen ? '' : 'hidden')}" data-ch-sec-width-pop></div>`;
      pill.innerHTML = `
        <button type="button" data-ch-sec-ask><i class="fas fa-magic"></i>${(globalThis.PlatformLanguage?.text("visual-editor","m_c1a1d7a1aa68bd"," Ask") ?? " Ask")}</button>
        <button type="button" data-ch-sec-position class="${String(state.sectionPopover === 'position' ? 'active' : '')}">${(globalThis.PlatformLanguage?.text("visual-editor","m_78ff1aaef0c389","Position") ?? "Position")}</button>
        ${String(widthControl)}
        <div class="fmwe-sec-pop ${String(state.sectionPopover ? '' : 'hidden')}" data-ch-sec-pop></div>`;
      canvas.appendChild(actions);
      canvas.appendChild(mobileActions);
      canvas.appendChild(pill);
      wireSectionChrome(section, actions, mobileActions, pill);
      if (state.sectionWidthOpen) renderSectionWidthPopover(section, pill.querySelector('[data-ch-sec-width-pop]'));
      if (state.sectionPopover === 'position') renderSectionPositionPopover(section, pill.querySelector('[data-ch-sec-pop]'));
      positionSectionChrome();
    }

    function positionSectionChrome(isRetry){
      const canvas = canvasHolder();
      if (!canvas) return;
      const actions = canvas.querySelector('[data-ch-sec-actions]');
      const mobileActions = canvas.querySelector('[data-ch-sec-mobile-actions]');
      const pill = canvas.querySelector('[data-ch-sec-pill]');
      if (!actions && !mobileActions && !pill) return;
      const section = sectionById(state.sectionChromeId);
      if (!section) { removeSectionChrome(); return; }
      const sectionEl = root.querySelector(`[data-node-id="${cleanText(section.id)}"]`);
      if (resizeObs && sectionEl !== resizeObservedSectionEl) {
        if (resizeObservedSectionEl) {
          try { resizeObs.unobserve(resizeObservedSectionEl); } catch (e) { /* replaced by renderer */ }
        }
        resizeObservedSectionEl = sectionEl || null;
        if (resizeObservedSectionEl) resizeObs.observe(resizeObservedSectionEl);
      }
      const rect = sectionScreenRect(section);
      if (!rect) {
        // Section exists in the model but hasn't painted yet — retry once.
        if (!isRetry) requestAnimationFrame(() => positionSectionChrome(true));
        return;
      }
      const cRect = canvas.getBoundingClientRect();
      const viewport = chromeCanvasEl() || canvas;
      const viewportRect = viewport.getBoundingClientRect();
      const left = rect.left - cRect.left + canvas.scrollLeft;
      const top = rect.top - cRect.top + canvas.scrollTop;
      const deviceFrameRect = deviceLayout?.querySelector('[data-device-frame]')?.getBoundingClientRect();
      const constraintRect = deviceFrameRect || viewportRect;
      const constraintTop = constraintRect.top - cRect.top + canvas.scrollTop + 6;
      const constraintBottom = constraintRect.bottom - cRect.top + canvas.scrollTop - 6;
      const clampChromeTop = (desired, height) => {
        const maximum = Math.max(constraintTop, constraintBottom - Math.max(1, height));
        return Math.max(constraintTop, Math.min(maximum, desired));
      };
      if (actions) {
        // Copy, lock and delete follow the selected section's left edge. Width
        // lives in the centered pill, so resizing cannot move its slider.
        const actionWidth = actions.offsetWidth || 34;
        // In mobile preview the section lives inside a bordered device shell.
        // Anchor its action rail outside the SHELL (including the bezel), not
        // beside the responsive section where it can cover the phone border
        // or collide with the viewport-level device tools.
        const outside = deviceFrameRect
          ? deviceFrameRect.left - cRect.left - actionWidth - 12
          : left - actionWidth - 8;
        actions.style.left = `${deviceFrameRect ? Math.max(2, outside) : (outside >= 2 ? outside : left + 6)}px`;
        actions.style.top = `${clampChromeTop(top + 6, actions.offsetHeight || 114)}px`;
        actions.style.visibility = 'visible';
      }
      if (mobileActions) {
        const actionWidth = mobileActions.offsetWidth || 34;
        const outside = deviceFrameRect
          ? deviceFrameRect.right - cRect.left + 10
          : left + rect.width + 8;
        mobileActions.style.left = `${Math.min(canvas.scrollWidth - actionWidth - 2, Math.max(2, outside))}px`;
        mobileActions.style.top = `${clampChromeTop(top + 6, mobileActions.offsetHeight || 74)}px`;
        mobileActions.style.visibility = 'visible';
      }
      if (pill) {
        // canvasHolder includes the editor toolbar; the inner .fmde-canvas is
        // the actual visible document viewport. Measuring against the outer
        // holder mistakenly treated toolbar space as available and let this
        // pill cover the toolbar when the first section reached the top.
        const visibleAbove = rect.top - constraintRect.top;
        pill.classList.remove('below');
        const horizontalHeight = pill.offsetHeight || 38;
        const placeAbove = visibleAbove >= horizontalHeight + 8;
        pill.classList.toggle('below', !placeAbove);
        const pillWidth = pill.offsetWidth || 210;
        const constraintLeft = constraintRect.left - cRect.left + canvas.scrollLeft + pillWidth / 2 + 6;
        const constraintRight = constraintRect.right - cRect.left + canvas.scrollLeft - pillWidth / 2 - 6;
        const desiredCenter = left + rect.width / 2;
        pill.style.left = `${Math.max(constraintLeft, Math.min(Math.max(constraintLeft, constraintRight), desiredCenter))}px`;
        const desiredTop = placeAbove ? top - horizontalHeight - 8 : top + rect.height + 8;
        pill.style.top = `${clampChromeTop(desiredTop, horizontalHeight)}px`;
        pill.style.visibility = 'visible';
      }
    }

    function requestDevice(device){
      const action = objectValue(opts.documentActions).device;
      if (typeof action === 'function') {
        try { action({ device }); return; } catch (e) { /* use local preview fallback */ }
      }
      setDevicePreview({ device });
    }

    function selectSectionAfterVariantChange(sectionId){
      requestAnimationFrame(() => {
        if (!editorReady()) return;
        const section = sectionById(sectionId) || rootSections().find((item) => cleanText(objectValue(item).props?.variant_of) === cleanText(sectionId));
        if (!section) return;
        editorHandle.select([section.id]);
        state.sectionChromeId = section.id;
        renderSectionChrome();
      });
    }

    function setSectionMobileVariant(section, enabled){
      const editor = editorHandle;
      const d = editor.getDocument();
      const desktop = M().desktopViewSection(d, section);
      if (!desktop) return null;
      let mobile = M().mobileViewSection(d, desktop);
      const commands = [{ type: 'node.set', node_id: desktop.id, prop: 'props.mobile_variant_enabled', value: !!enabled }];
      if (!mobile && enabled) {
        mobile = M().createMobileViewSection(desktop, { magic: false, parent_width_pt: designWidthPt() });
        const index = arrayValue(objectValue(d.root).children).findIndex((item) => cleanText(item.id) === cleanText(desktop.id));
        commands.push({ type: 'node.insert', node: mobile, parent_id: null, index: index + 1 });
      } else if (mobile) {
        commands.push({ type: 'node.set', node_id: mobile.id, prop: 'props.mobile_enabled', value: !!enabled });
      }
      const result = editor.applyBatch(commands, enabled ? 'enable mobile section' : 'disable mobile section');
      if (result && result.ok === false) return result;
      if (enabled) requestDevice('mobile');
      selectSectionAfterVariantChange(desktop.id);
      return result;
    }

    function regenerateMagicMobile(section){
      const editor = editorHandle;
      const d = editor.getDocument();
      const desktop = M().desktopViewSection(d, section);
      if (!desktop) return null;
      const previous = M().mobileViewSection(d, desktop);
      const mobile = M().createMobileViewSection(desktop, { magic: true, parent_width_pt: designWidthPt() });
      const rootChildren = arrayValue(objectValue(d.root).children);
      const desktopIndex = rootChildren.findIndex((item) => cleanText(item.id) === cleanText(desktop.id));
      const commands = [{ type: 'node.set', node_id: desktop.id, prop: 'props.mobile_variant_enabled', value: true }];
      if (previous) {
        if (objectValue(previous.locks).delete === true) commands.push({ type: 'node.set', node_id: previous.id, prop: 'locks', value: {} });
        commands.push({ type: 'node.remove', node_id: previous.id });
      }
      commands.push({ type: 'node.insert', node: mobile, parent_id: null, index: desktopIndex + 1 });
      const result = editor.applyBatch(commands, 'Magic Mobile');
      if (result && result.ok === false) return result;
      requestDevice('mobile');
      selectSectionAfterVariantChange(desktop.id);
      return result;
    }

    function wireSectionChrome(section, actions, mobileActions, pill){
      const editor = editorHandle;
      mobileActions.querySelector('[data-ch-sec-mobile-toggle]')?.addEventListener('click', () => {
        const current = anySectionById(section.id) || section;
        const desktop = desktopSection(current) || current;
        const mobile = mobileSection(desktop);
        const enabled = objectValue(desktop.props).mobile_variant_enabled === true && objectValue(objectValue(mobile).props).mobile_enabled === true;
        const result = setSectionMobileVariant(desktop, !enabled);
        if (result && result.ok === false) toast((globalThis.PlatformLanguage?.text("visual-editor","m_a00890a4ca9e28","Could not update the mobile section.") ?? "Could not update the mobile section."), false);
      });
      mobileActions.querySelector('[data-ch-sec-mobile-magic]')?.addEventListener('click', () => {
        const result = regenerateMagicMobile(anySectionById(section.id) || section);
        if (result && result.ok === false) toast((globalThis.PlatformLanguage?.text("visual-editor","m_2f8dcd576d6505","Could not generate the mobile section.") ?? "Could not generate the mobile section."), false);
      });
      pill.querySelector('[data-ch-sec-width]')?.addEventListener('click', () => {
        state.sectionWidthOpen = !state.sectionWidthOpen;
        if (state.sectionWidthOpen) state.sectionPopover = '';
        renderSectionChrome();
      });
      actions.querySelector('[data-ch-sec-lock]')?.addEventListener('click', () => {
        const current = sectionById(section.id);
        const locked = objectValue(objectValue(current).locks).move === true;
        const res = editor.apply({
          type: 'node.set', node_id: section.id, prop: 'locks',
          value: locked ? {} : { move: true, resize: true, delete: true }
        });
        if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_7e491eeb2e10a8","Could not update the lock.") ?? "Could not update the lock."), false); return; }
        state.sectionWidthOpen = false;
        renderSectionChrome();
      });
      actions.querySelector('[data-ch-sec-duplicate]')?.addEventListener('click', () => {
        const d = editor.getDocument();
        const current = anySectionById(section.id);
        const desktop = M().desktopViewSection(d, current);
        if (!desktop) return;
        const mobile = M().mobileViewSection(d, desktop);
        const copy = M().reassignIds(clone(desktop));
        copy.props = objectValue(copy.props);
        copy.props.mobile_variant_enabled = !!(mobile && objectValue(desktop.props).mobile_variant_enabled === true);
        const children = arrayValue(objectValue(d.root).children);
        const desktopIndex = children.findIndex((item) => cleanText(item.id) === cleanText(desktop.id));
        const mobileIndex = mobile ? children.findIndex((item) => cleanText(item.id) === cleanText(mobile.id)) : -1;
        const commands = [{ type: 'node.insert', node: copy, parent_id: null, index: Math.max(desktopIndex, mobileIndex) + 1 }];
        let mobileCopy = null;
        if (mobile) {
          mobileCopy = M().reassignIds(clone(mobile));
          mobileCopy.props = objectValue(mobileCopy.props);
          mobileCopy.props.variant_of = copy.id;
          M().linkMobileVariantSources(copy, mobileCopy);
          commands.push({ type: 'node.insert', node: mobileCopy, parent_id: null, index: Math.max(desktopIndex, mobileIndex) + 2 });
        }
        const res = editor.applyBatch(commands, 'duplicate section');
        if (res && res.ok === false) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_8815a2ea2303d2","Could not duplicate the section.") ?? "Could not duplicate the section."), false); return; }
        const selectedCopy = mobileVariantActive() && mobileCopy && copy.props.mobile_variant_enabled ? mobileCopy : copy;
        editor.select([selectedCopy.id]);
        scrollNodeIntoView(selectedCopy.id);
      });
      actions.querySelector('[data-ch-sec-delete]')?.addEventListener('click', async () => {
        const confirmed = await confirmFn('Delete this section and everything in it? You can undo from the editor.', {
          title: (globalThis.PlatformLanguage?.text("visual-editor","m_1699bafef29f0c","Delete section?") ?? "Delete section?"), confirmLabel: 'Delete section', icon: 'fa-trash-can', danger: true
        });
        if (!confirmed || !editorReady()) return;
        const d = editor.getDocument();
        const current = anySectionById(section.id);
        const desktop = M().desktopViewSection(d, current);
        const mobile = M().mobileViewSection(d, desktop);
        const commands = [];
        if (mobile) commands.push({ type: 'node.remove', node_id: mobile.id });
        if (desktop) commands.push({ type: 'node.remove', node_id: desktop.id });
        const res = editor.applyBatch(commands, 'delete section');
        if (res && res.ok === false) {
          toast(/locked/i.test(cleanText(res.reason)) ? 'This section is locked — unlock it first.' : 'Could not delete the section.', false);
          return;
        }
        removeSectionChrome();
      });
      pill.querySelector('[data-ch-sec-ask]')?.addEventListener('click', () => {
        if (global.PlatformAssistant?.open) global.PlatformAssistant.open();
        else toast((globalThis.PlatformLanguage?.text("visual-editor","m_2f2e6d7cbef6b8","The assistant isn't available in this session.") ?? "The assistant isn't available in this session."), false);
      });
      pill.querySelector('[data-ch-sec-position]')?.addEventListener('click', () => {
        state.sectionPopover = state.sectionPopover === 'position' ? '' : 'position';
        state.sectionWidthOpen = false;
        renderSectionChrome();
      });
    }

    function renderSectionWidthPopover(section, pop){
      if (!pop) return;
      const current = sectionById(section.id) || section;
      const sizing = constrainSectionWidth(objectValue(objectValue(current).props).section_width);
      const maximum = sectionMaxWidthPx();
      const otherSizing = arrayValue(objectValue(editorHandle.getDocument()).root?.children)
        .filter((candidate) => cleanText(objectValue(candidate).id) !== cleanText(section.id))
        .map((candidate) => constrainSectionWidth(objectValue(objectValue(candidate).props).section_width));
      const nearestSnap = (value, candidates, tolerance) => {
        let nearest = value;
        let distance = tolerance + 1;
        candidates.forEach((candidate) => {
          const nextDistance = Math.abs(Number(candidate) - value);
          if (Number.isFinite(Number(candidate)) && nextDistance <= tolerance && nextDistance < distance) {
            nearest = Number(candidate);
            distance = nextDistance;
          }
        });
        return { value: nearest, snapped: distance <= tolerance };
      };
      pop.innerHTML = `
        <div class="fmwe-sec-width-head"><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_13e5dfb1725bac","Section width") ?? "Section width")}</span><output data-ch-sec-width-value>${String(sizing.width_percent)}%</output></div>
        <label>${(globalThis.PlatformLanguage?.text("visual-editor","m_86b2dc58d632dc","Target width (% of visible area)\n          ") ?? "Target width (% of visible area)\n          ")}<input type="range" min="10" max="100" step="1" value="${String(sizing.width_percent)}" data-ch-sec-width-range>
        </label>
        <div class="fmwe-sec-width-row">
          <label for="fmwe-sec-max-${String(esc(section.id))}">${(globalThis.PlatformLanguage?.text("visual-editor","m_849f69855a36d7","Maximum width") ?? "Maximum width")}</label>
          <button type="button" id="fmwe-sec-max-${String(esc(section.id))}" class="fmwe-sec-width-toggle ${String(sizing.max_enabled ? 'active' : '')}" data-ch-sec-max-toggle role="switch" aria-checked="${String(sizing.max_enabled ? 'true' : 'false')}" ${String(maximum !== null ? 'disabled' : '')} title="${String(maximum !== null ? `Workflows cannot exceed ${maximum}px` : 'Toggle maximum width')}"></button>
        </div>
        <div class="fmwe-sec-width-max ${String(sizing.max_enabled ? '' : 'disabled')}" data-ch-sec-max-row>
          <div class="fmwe-sec-width-row"><input type="range" min="160" max="3840" step="10" value="${String(sizing.max_width_px)}" data-ch-sec-max-range aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_849f69855a36d7","Maximum width") ?? "Maximum width")}"><output data-ch-sec-max-value>${((v10) => globalThis.PlatformLanguage?.text("visual-editor","m_1816f808d0e9b7",`${v10}px`,{v10}) ?? `${v10}px`)(sizing.max_width_px)}</output></div>
        </div>`;
      const applySizing = (next) => editorHandle.apply({ type: 'node.set', node_id: section.id, prop: 'props.section_width', value: constrainSectionWidth(next) });
      const widthRange = pop.querySelector('[data-ch-sec-width-range]');
      const widthValue = pop.querySelector('[data-ch-sec-width-value]');
      widthRange?.addEventListener('input', (event) => {
        const match = event.altKey
          ? { value: Number(widthRange.value), snapped: false }
          : nearestSnap(Number(widthRange.value), otherSizing.map((item) => item.width_percent), 2);
        widthRange.value = String(match.value);
        const next = M().normalizeSectionWidth({ ...sizing, width_percent: match.value });
        sizing.width_percent = next.width_percent;
        if (widthValue) widthValue.textContent = `${next.width_percent}%`;
        widthValue?.classList.toggle('snapped', match.snapped);
        if (widthValue) widthValue.title = match.snapped ? 'Matched another section' : '';
        applySizing(next);
      });
      pop.querySelector('[data-ch-sec-max-toggle]')?.addEventListener('click', () => {
        if (maximum !== null) return;
        sizing.max_enabled = !sizing.max_enabled;
        applySizing(sizing);
        renderSectionChrome();
      });
      const maxRange = pop.querySelector('[data-ch-sec-max-range]');
      const maxValue = pop.querySelector('[data-ch-sec-max-value]');
      if (maxRange && maximum !== null) maxRange.max = String(maximum);
      maxRange?.addEventListener('input', (event) => {
        const match = event.altKey
          ? { value: Number(maxRange.value), snapped: false }
          : nearestSnap(Number(maxRange.value), otherSizing.filter((item) => item.max_enabled).map((item) => item.max_width_px), 30);
        maxRange.value = String(match.value);
        const next = M().normalizeSectionWidth({ ...sizing, max_width_px: match.value });
        sizing.max_width_px = next.max_width_px;
        if (maxValue) maxValue.textContent = ((v0) => globalThis.PlatformLanguage?.text("visual-editor","m_0888cfd878af79",`${v0}px`,{v0}) ?? `${v0}px`)(next.max_width_px);
        maxValue?.classList.toggle('snapped', match.snapped);
        if (maxValue) maxValue.title = match.snapped ? 'Matched another section' : '';
        applySizing(next);
      });
    }

    /** Position popover — the Layers home for the selected section. */
    function renderSectionPositionPopover(section, pop){
      if (!pop) return;
      const editor = editorHandle;
      const current = sectionById(section.id) || section;
      const selection = editor.selection();
      const kids = arrayValue(current.children)
        .map((kid) => objectValue(kid))
        .filter((kid) => kid.id)
        .sort((a, b) => (numberValue(objectValue(b.frame).z) || 0) - (numberValue(objectValue(a.frame).z) || 0));
      pop.innerHTML = `
        <p class="fmwe-micro-label" style="margin-top:0">${(globalThis.PlatformLanguage?.text("visual-editor","m_0baf9bb42d638a","Layers ") ?? "Layers ")}<span class="count">${String(kids.length)}</span></p>
        ${String(kids.length ? `
          <div class="fmwe-sec-layers" data-ch-sec-layers>
            ${kids.map((kid) => `
              <div class="fmwe-sec-layer ${selection.includes(kid.id) ? 'active' : ''}" data-ch-sec-layer="${esc(kid.id)}">
                <i class="fas ${esc(NODE_TYPE_ICONS[kid.type] || 'fa-square')}"></i>
                <span class="name">${esc(firstText(kid.name, kid.type, 'Element'))}</span>
                <span class="ops">
                  <button type="button" data-ch-sec-z="forward" title="Bring forward"><i class="fas fa-arrow-up"></i></button>
                  <button type="button" data-ch-sec-z="backward" title="Send backward"><i class="fas fa-arrow-down"></i></button>
                  <button type="button" data-ch-sec-z="front" title="Bring to front"><i class="fas fa-angle-double-up"></i></button>
                  <button type="button" data-ch-sec-z="back" title="Send to back"><i class="fas fa-angle-double-down"></i></button>
                </span>
              </div>`).join('')}
          </div>` : '<p class="fmwe-ch-quiet">Nothing in this section yet.</p>')}
        <p class="fmwe-micro-label">${(globalThis.PlatformLanguage?.text("visual-editor","m_1512191d63c6f4","Align selected") ?? "Align selected")}</p>
        <div class="fmwe-sec-align">
          <button type="button" class="fmwe-btn" data-ch-sec-align="left"><i class="fas fa-align-left"></i></button>
          <button type="button" class="fmwe-btn" data-ch-sec-align="center"><i class="fas fa-align-center"></i></button>
          <button type="button" class="fmwe-btn" data-ch-sec-align="right"><i class="fas fa-align-right"></i></button>
        </div>`;
      pop.querySelectorAll('[data-ch-sec-layer]').forEach((row) => {
        const kidId = row.dataset.chSecLayer;
        row.addEventListener('click', (event) => {
          if (event.target.closest('[data-ch-sec-z]')) return;
          editor.select([kidId]);
        });
        row.querySelectorAll('[data-ch-sec-z]').forEach((btn) => btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const res = editor.apply({ type: 'node.reorder', node_id: kidId, mode: btn.dataset.chSecZ });
          if (res && res.ok === false) toast((globalThis.PlatformLanguage?.text("visual-editor","m_302e4feb8b2872","Could not change the stacking order.") ?? "Could not change the stacking order."), false);
          renderSectionChrome();
        }));
      });
      pop.querySelectorAll('[data-ch-sec-align]').forEach((btn) => btn.addEventListener('click', () => {
        alignWithinSection(current, btn.dataset.chSecAlign);
      }));
    }

    function alignWithinSection(section, mode){
      const editor = editorHandle;
      const selection = editor.selection().filter((id) => nodeWithinSection(id, section.id) && cleanText(id) !== cleanText(section.id));
      if (!selection.length) { toast((globalThis.PlatformLanguage?.text("visual-editor","m_19ef11912f8923","Pick an element in the list first, then align it.") ?? "Pick an element in the list first, then align it."), false); return; }
      const rect = sectionScreenRect(section);
      const hPt = numberValue(objectValue(section.frame).h) || 160;
      const pxPerPt = rect && rect.height && hPt ? rect.height / hPt : PT_TO_PX;
      const sectionWPt = rect ? rect.width / pxPerPt : designWidthPt();
      selection.forEach((id) => {
        const found = M().findNode(editor.getDocument(), id);
        if (!found) return;
        const frame = objectValue(found.node.frame);
        const w = numberValue(frame.w) || 100;
        let x = 0;
        if (mode === 'center') x = Math.max(0, (sectionWPt - w) / 2);
        else if (mode === 'right') x = Math.max(0, sectionWPt - w);
        editor.apply({ type: 'node.set', node_id: id, prop: 'frame.x', value: round2(x) });
      });
    }

    // ------------------------------------------------------- pages strip
    let pageClipboard = null;
    let pageMenuEl = null;
    let pageMenuPageId = '';
    let pageMenuOutsideHandler = null;
    let pageMenuKeyHandler = null;
    let pageMenuOutsideTimer = 0;

    function closePageMenu(){
      clearTimeout(pageMenuOutsideTimer);
      pageMenuOutsideTimer = 0;
      if (pageMenuOutsideHandler) doc.removeEventListener('pointerdown', pageMenuOutsideHandler, true);
      if (pageMenuKeyHandler) doc.removeEventListener('keydown', pageMenuKeyHandler, true);
      pageMenuOutsideHandler = null;
      pageMenuKeyHandler = null;
      try { pageMenuEl?.remove?.(); } catch (e) { /* noop */ }
      pageMenuEl = null;
      pageMenuPageId = '';
    }

    function pageMenuRow(action, icon, label, shortcut, disabled, danger){
      return `<button type="button" class="fmwe-page-menu-row ${danger ? 'danger' : ''}" data-ch-page-action="${esc(action)}" ${disabled ? 'disabled' : ''}>
        <i class="fas ${esc(icon)}"></i><span>${esc(label)}</span>${shortcut ? `<span class="shortcut">${esc(shortcut)}</span>` : ''}
      </button>`;
    }

    function openPageMenu(page, anchor){
      const pageId = cleanText(objectValue(page).id);
      if (!pageId || !anchor) return;
      if (pageMenuEl && pageMenuPageId === pageId) { closePageMenu(); return; }
      closePageMenu();
      const pages = pageEntries();
      const canRename = typeof pagesApi?.rename === 'function';
      const canCopy = typeof pagesApi?.copy === 'function';
      const canPaste = typeof pagesApi?.paste === 'function';
      const canAdd = typeof pagesApi?.add === 'function';
      const canDuplicate = typeof pagesApi?.duplicate === 'function';
      const canRemoveStyling = typeof pagesApi?.removeStyling === 'function' && cleanText(page.masterRef) !== 'none';
      const canRemove = typeof pagesApi?.remove === 'function' && pages.length > 1;
      const menu = doc.createElement('div');
      menu.className = 'fmwe-page-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = `
        <div class="fmwe-page-menu-head">
          <input class="fmwe-page-menu-title" data-ch-page-title value="${String(esc(firstText(page.title, collectionNoun)))}" aria-label="${((v1) => globalThis.PlatformLanguage?.text("visual-editor","m_404b170675049a",`${v1} title`,{v1}) ?? `${v1} title`)(collectionNoun)}" ${String(canRename ? '' : 'readonly')}>
          ${String(canRename ? `<button type="button" class="fmwe-page-menu-edit" data-ch-page-edit-title title="Rename ${collectionNoun.toLowerCase()}"><i class="fas fa-pencil"></i></button>` : '')}
        </div>
        <div class="fmwe-page-menu-kind"><i class="fas ${String(collectionIsSections ? 'fa-layer-group' : 'fa-file-lines')}"></i><span>${((v5) => globalThis.PlatformLanguage?.text("visual-editor","m_4ca92454ba70d3",`Visual ${v5}`,{v5}) ?? `Visual ${v5}`)(collectionNoun.toLowerCase())}</span></div>
        <div class="fmwe-page-menu-sep"></div>
        ${String(pageMenuRow('copy', 'fa-copy', 'Copy', 'Ctrl+C', !canCopy))}
        ${String(pageMenuRow('paste', 'fa-clipboard', 'Paste', 'Ctrl+V', !canPaste || !pageClipboard))}
        ${String(pageMenuRow('add', collectionIsSections ? 'fa-square-plus' : 'fa-file-circle-plus', `Add ${collectionNoun.toLowerCase()}`, 'Ctrl+Enter', !canAdd))}
        ${String(pageMenuRow('duplicate', 'fa-clone', `Duplicate ${collectionNoun.toLowerCase()}`, 'Ctrl+D', !canDuplicate))}
        ${String(pageMenuRow('remove-styling', 'fa-eraser', 'Remove styling', '', !canRemoveStyling))}
        ${String(pageMenuRow('delete', 'fa-trash-can', `Delete ${collectionNoun.toLowerCase()}`, 'Delete', !canRemove, true))}
        ${String(notesOpts ? `<div class="fmwe-page-menu-sep"></div>${pageMenuRow('notes', 'fa-pen-to-square', 'Notes')}` : '')}`;
      menu.style.visibility = 'hidden';
      doc.body.appendChild(menu);
      pageMenuEl = menu;
      pageMenuPageId = pageId;

      const titleInput = menu.querySelector('[data-ch-page-title]');
      let titleCommitted = false;
      const commitTitle = () => {
        if (titleCommitted || !canRename) return;
        titleCommitted = true;
        const title = cleanText(titleInput?.value);
        if (title && title !== cleanText(page.title)) pagesApi.rename(pageId, title);
      };
      titleInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commitTitle(); closePageMenu(); }
        else if (event.key === 'Escape') { event.preventDefault(); closePageMenu(); }
      });
      titleInput?.addEventListener('blur', commitTitle);
      menu.querySelector('[data-ch-page-edit-title]')?.addEventListener('click', () => { titleInput?.focus(); titleInput?.select(); });
      menu.querySelectorAll('[data-ch-page-action]').forEach((button) => button.addEventListener('click', async () => {
        const action = button.dataset.chPageAction;
        if (action === 'copy') {
          pageClipboard = pagesApi.copy(pageId);
          toast(((v0) => globalThis.PlatformLanguage?.text("visual-editor","m_0cffc999944a5d",`${v0} copied.`,{v0}) ?? `${v0} copied.`)(collectionNoun), true);
          closePageMenu();
        } else if (action === 'paste') {
          closePageMenu();
          pagesApi.paste(pageId, pageClipboard);
        } else if (action === 'add') {
          closePageMenu();
          pagesApi.add(pageId);
        } else if (action === 'duplicate') {
          closePageMenu();
          pagesApi.duplicate(pageId);
        } else if (action === 'remove-styling') {
          closePageMenu();
          pagesApi.removeStyling(pageId);
        } else if (action === 'delete') {
          closePageMenu();
          const confirmed = await confirmFn(`Delete this ${collectionNoun.toLowerCase()}? You can undo from the editor.`, {
            title: ((v0) => globalThis.PlatformLanguage?.text("visual-editor","m_3f871dddfbad58",`Delete ${v0}?`,{v0}) ?? `Delete ${v0}?`)(collectionNoun.toLowerCase()), confirmLabel: `Delete ${collectionNoun.toLowerCase()}`, icon: 'fa-trash-can', danger: true
          });
          if (!confirmed) return;
          pagesApi.remove(pageId);
        } else if (action === 'notes') {
          closePageMenu();
          root.querySelector('[data-ch-notes]')?.click();
        }
      }));

      const rect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(12, Math.min(global.innerWidth - menuRect.width - 12, rect.left));
      const above = rect.top - menuRect.height - 10;
      const top = above >= 12 ? above : Math.min(global.innerHeight - menuRect.height - 12, rect.bottom + 10);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.max(12, Math.round(top))}px`;
      menu.style.visibility = 'visible';
      pageMenuOutsideHandler = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closePageMenu(); };
      pageMenuKeyHandler = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closePageMenu(); return; }
        if (event.target === titleInput) return;
        let action = '';
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') action = 'copy';
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') action = 'paste';
        else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') action = 'add';
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') action = 'duplicate';
        else if (event.key === 'Delete') action = 'delete';
        const actionButton = action ? menu.querySelector(`[data-ch-page-action="${action}"]:not(:disabled)`) : null;
        if (!actionButton) return;
        event.preventDefault();
        event.stopPropagation();
        actionButton.click();
      };
      pageMenuOutsideTimer = setTimeout(() => {
        pageMenuOutsideTimer = 0;
        if (pageMenuOutsideHandler) doc.addEventListener('pointerdown', pageMenuOutsideHandler, true);
        if (pageMenuKeyHandler) doc.addEventListener('keydown', pageMenuKeyHandler, true);
      }, 0);
    }

    function pageEntries(){
      if (!pagesApi) return [];
      try { return arrayValue(pagesApi.list()).map(objectValue).filter((p) => cleanText(p.id)); }
      catch (e) { return []; }
    }
    function currentPageId(){
      if (!pagesApi) return '';
      try { return cleanText(typeof pagesApi.current === 'function' ? pagesApi.current() : ''); }
      catch (e) { return ''; }
    }

    function pageThumbnailMetrics(page){
      const definition = objectValue(objectValue(page).definition);
      if (contentKind === 'workflow' && isViewDefinition(definition)) {
        const root = objectValue(definition.root);
        const widthPt = Math.max(1, numberValue(objectValue(root.frame).w) || designWidthPt());
        const heightPt = Math.max(1, arrayValue(root.children).reduce((total, section) => total + Math.max(0, numberValue(objectValue(section).frame?.h)), 0) || widthPt);
        return { widthPt, heightPt, ratio: '1 / 1' };
      }
      const paper = M().paperDimensions(definition);
      const widthPt = Math.max(1, numberValue(paper.w_pt) || designWidthPt());
      let heightPt = numberValue(paper.h_pt);
      if (!heightPt) {
        const rootFrame = objectValue(objectValue(definition.root).frame);
        heightPt = numberValue(rootFrame.h) || (widthPt * 9 / 16);
      }
      return { widthPt, heightPt: Math.max(1, heightPt), ratio: `${round2(widthPt)} / ${round2(Math.max(1, heightPt))}` };
    }

    function renderPagesStrip(){
      const strip = root.querySelector('[data-ch-pages-strip]');
      if (!strip) return;
      closePageMenu();
      state.chromePageThumbHandles.forEach((handle) => { try { handle?.destroy?.(); } catch (e) { /* noop */ } });
      state.chromePageThumbHandles = [];
      const pages = pageEntries();
      const activeId = currentPageId();
      const canAdd = !!(pagesApi && typeof pagesApi.add === 'function');
      const addPageRatio = pages.length ? pageThumbnailMetrics(pages[0]).ratio : '16 / 9';
      strip.innerHTML = pages.map((p) => `
        <div class="fmwe-ch-pagecard ${String(cleanText(p.id) === activeId ? 'active' : '')}" data-ch-page-card="${String(esc(p.id))}" title="${String(esc(firstText(p.title, collectionNoun)))}">
          <span class="thumb" style="--fmwe-page-ratio:${String(esc(pageThumbnailMetrics(p).ratio))}"><span class="stage" data-ch-page-thumb="${String(esc(p.id))}"></span><button type="button" class="fmwe-ch-page-more" data-ch-page-more="${String(esc(p.id))}" title="${((v6) => globalThis.PlatformLanguage?.text("visual-editor","m_af1e1314b94173",`${v6} options`,{v6}) ?? `${v6} options`)(collectionNoun)}" aria-label="${((v7) => globalThis.PlatformLanguage?.text("visual-editor","m_ead26974d2238b",`${v7} options`,{v7}) ?? `${v7} options`)(collectionNoun)}"><i class="fas fa-ellipsis"></i></button></span>
          <span class="label">${String(esc(firstText(p.title, collectionNoun)))}</span>
        </div>`).join('') + (canAdd ? `
        <button type="button" class="fmwe-ch-pagecard new" data-ch-page-new title="${((v0) => globalThis.PlatformLanguage?.text("visual-editor","m_eaf7ef3b5e4c26",`New ${v0}`,{v0}) ?? `New ${v0}`)(collectionNoun.toLowerCase())}">
          <span class="thumb plus" style="--fmwe-page-ratio:${String(esc(addPageRatio))}"><i class="fas fa-plus"></i></span>
          <span class="label">${((v2) => globalThis.PlatformLanguage?.text("visual-editor","m_53e45476126aba",`Add ${v2}`,{v2}) ?? `Add ${v2}`)(collectionNoun.toLowerCase())}</span>
        </button>` : '');
      strip.querySelectorAll('[data-ch-page-card]').forEach((el) => el.addEventListener('click', () => {
        try { pagesApi.select(el.dataset.chPageCard); } catch (e) { /* host handles */ }
      }));
      strip.querySelectorAll('[data-ch-page-more]').forEach((button) => button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const page = pages.find((entry) => cleanText(entry.id) === cleanText(button.dataset.chPageMore));
        if (page) openPageMenu(page, button);
      }));
      strip.querySelector('[data-ch-page-new]')?.addEventListener('click', () => {
        try { pagesApi.add(); } catch (e) { /* host handles */ }
      });
      updatePagesLabel();
      if (!global.FMDocRenderer?.render) return;
      requestAnimationFrame(() => {
        if (destroyed) return;
        strip.querySelectorAll('[data-ch-page-thumb]').forEach((thumbStage) => {
          const page = pages.find((p) => cleanText(p.id) === thumbStage.dataset.chPageThumb);
          const definition = objectValue(objectValue(page).definition);
          if (!isViewDefinition(definition)) return;
          const width = thumbStage.clientWidth || 100;
          const height = thumbStage.clientHeight || 100;
          const metrics = pageThumbnailMetrics(page);
          const naturalW = metrics.widthPt * PT_TO_PX;
          const naturalH = metrics.heightPt * PT_TO_PX;
          const fitW = Math.max(0.03, width / naturalW);
          const fitH = Math.max(0.03, height / naturalH);
          const scale = Math.min(1, fitW, fitH);
          try {
            state.chromePageThumbHandles.push(global.FMDocRenderer.render(thumbStage, {
              document: clone(definition),
              theme: themeForDefinition(definition),
              mode: 'static',
              widgetData: {},
              widgetContext: { preview: true },
              themeContext: thumbTheme(),
              mediaUrl,
              scale
            }));
          } catch (e) { /* neutral card */ }
        });
      });
    }

    function isViewDefinition(definition){
      const def = objectValue(definition);
      return cleanText(def.kind) === 'view' || !!def.root || arrayValue(def.pages).length > 0;
    }

    function updatePagesLabel(){
      const label = root.querySelector('[data-ch-pages-label]');
      if (!label) return;
      const pages = pageEntries();
      const index = pages.findIndex((p) => cleanText(p.id) === currentPageId());
      label.textContent = pages.length ? `${collectionPlural} ${Math.max(1, index + 1)}/${pages.length}` : collectionPlural;
    }

    // ----------------------------------------------- bottom bar + notes
    function setNotesState(html){
      const el = root.querySelector('[data-ch-notes-state]');
      if (el) el.innerHTML = html;
    }

    function syncChromeZoomDisplay(value, deviceMode){
      const z = Number(value);
      if (!Number.isFinite(z)) return;
      const zoomSlider = root.querySelector('[data-ch-zoom]');
      const zoomReadout = root.querySelector('[data-ch-zoom-readout]');
      const pct = Math.round(z * 100);
      if (zoomReadout) zoomReadout.textContent = `${pct}%`;
      if (zoomSlider) {
        zoomSlider.min = deviceMode ? '25' : '10';
        zoomSlider.max = deviceMode ? '140' : '200';
        zoomSlider.step = deviceMode ? '1' : '5';
        if (doc.activeElement !== zoomSlider) zoomSlider.value = String(Math.min(Number(zoomSlider.max), Math.max(Number(zoomSlider.min), pct)));
      }
    }

    function wireChrome(){
      root.querySelectorAll('[data-ch-tab]').forEach((btn) => btn.addEventListener('click', () => setChromeTab(btn.dataset.chTab)));
      root.querySelector('[data-ch-collapse]')?.addEventListener('click', () => setChromeTab(state.chromeTab));
      root.querySelector('[data-ch-add-section]')?.addEventListener('click', () => {
        if (!requireEditor()) return;
        addBlankSection();
        renderPagesStrip();
      });
      // Bottom bar.
      root.querySelector('[data-ch-notes]')?.addEventListener('click', () => {
        state.notesOpen = !state.notesOpen;
        const drawer = root.querySelector('[data-ch-notes-drawer]');
        drawer?.classList.toggle('hidden', !state.notesOpen);
        if (state.notesOpen) {
          const input = root.querySelector('[data-ch-notes-input]');
          if (input) { input.value = firstText(notesOpts && typeof notesOpts.get === 'function' ? notesOpts.get() : ''); input.focus(); }
        }
      });
      root.querySelector('[data-ch-notes-close]')?.addEventListener('click', () => {
        state.notesOpen = false;
        root.querySelector('[data-ch-notes-drawer]')?.classList.add('hidden');
      });
      const notesInput = root.querySelector('[data-ch-notes-input]');
      notesInput?.addEventListener('input', () => {
        setNotesState('');
        clearTimeout(state.notesTimer);
        state.notesTimer = setTimeout(() => {
          state.notesTimer = 0;
          if (notesOpts && typeof notesOpts.save === 'function') notesOpts.save(notesInput.value, setNotesState);
        }, 800);
      });
      if (notesInput && state.notesOpen) notesInput.value = firstText(notesOpts && typeof notesOpts.get === 'function' ? notesOpts.get() : '');
      const zoomSlider = root.querySelector('[data-ch-zoom]');
      const zoomReadout = root.querySelector('[data-ch-zoom-readout]');
      const syncZoomUi = () => {
        if (deviceLayout) {
          syncChromeZoomDisplay(devicePreviewState().renderedZoom || 1, true);
          return;
        }
        if (!editorHandle || typeof editorHandle.zoom !== 'function') return;
        try {
          const z = editorHandle.zoom();
          syncChromeZoomDisplay(z, false);
        } catch (e) { /* noop */ }
      };
      zoomSlider?.addEventListener('input', () => {
        if (!editorHandle) return;
        if (deviceLayout) {
          const preview = devicePreviewState();
          preview.zoom = Math.max(.25, Math.min(1.4, Number(zoomSlider.value) / 100));
          renderDevicePreview(false);
          return;
        }
        try {
          const z = editorHandle.zoom(Number(zoomSlider.value) / 100);
          if (zoomReadout && Number.isFinite(z)) zoomReadout.textContent = `${Math.round(z * 100)}%`;
        } catch (e) { /* noop */ }
        requestAnimationFrame(() => positionSectionChrome());
      });
      root.querySelector('[data-ch-zoom-fit]')?.addEventListener('click', () => {
        if (!editorHandle) return;
        if (deviceLayout) {
          devicePreviewState().zoom = null;
          renderDevicePreview(false);
          return;
        }
        try { editorHandle.zoom('fit-width'); } catch (e) { /* noop */ }
        syncZoomUi();
      });
      clearInterval(state.zoomTimer);
      state.zoomTimer = setInterval(() => {
        if (destroyed || doc.hidden) return;
        syncZoomUi();
        positionSectionChrome();
      }, 1200);
      root.querySelector('[data-ch-pages-toggle]')?.addEventListener('click', (event) => {
        state.pagesStripOpen = !state.pagesStripOpen;
        lsSet(PAGES_STRIP_KEY, state.pagesStripOpen ? 'open' : 'closed');
        root.querySelector('[data-ch-pages-strip]')?.classList.toggle('hidden', !state.pagesStripOpen);
        event.currentTarget.classList.toggle('active', state.pagesStripOpen);
      });
      root.querySelector('[data-ch-grid]')?.addEventListener('click', () => {
        try { pagesApi.grid(); } catch (e) { /* host handles */ }
      });
      const visualFullscreenTarget = () => {
        let target = chromeOpts.fullscreenEl;
        if (typeof target === 'function') { try { target = target(); } catch (e) { target = null; } }
        return target && target.nodeType === 1 ? target : rootEl;
      };
      const toggleFullscreen = (previewOnly) => {
        const operation = doc.fullscreenElement
          ? doc.exitFullscreen?.()
          : (previewOnly ? rootEl : visualFullscreenTarget())?.requestFullscreen?.();
        // Some embedded browser shells settle their fullscreen state one task
        // after the native event. Reconcile both immediately and once settled
        // so the button can never remain stuck showing the wrong action.
        Promise.resolve(operation).catch(() => {}).then(() => {
          syncFullscreenChrome();
          setTimeout(syncFullscreenChrome, 120);
          setTimeout(syncFullscreenChrome, 500);
        });
      };
      root.querySelector('[data-ch-expand]')?.addEventListener('click', () => toggleFullscreen(false));
      root.querySelector('[data-ch-preview-expand]')?.addEventListener('click', () => toggleFullscreen(true));
      renderChromePanel();
      renderPagesStrip();
    }

    // ------------------------------------------------------------ editor
    const editorOpts = {};
    Object.keys(opts).forEach((key) => { if (key !== 'chrome') editorOpts[key] = opts[key]; });
    if (!editorOpts.mode) editorOpts.mode = 'visual';
    try {
      editorHandle = global.FMDocEditor.mount(stage, editorOpts);
    } catch (error) {
      try { rootEl.remove(); } catch (e) { /* noop */ }
      throw error;
    }

    /* Keep the visual palette below the editor's combined control row. It
       used to sit beside the entire FMDocEditor, which pushed the controls
       to the right. Inside .fmde-body it begins alongside the canvas. */
    function dockChromePaletteBelowEditorHeaders(){
      const editorBody = stage.querySelector('.fmde-body');
      const editorCanvas = editorBody?.querySelector(':scope > .fmde-canvas');
      const rail = root.querySelector('[data-ch-rail]');
      const panel = root.querySelector('[data-ch-panel]');
      const under = root.querySelector('[data-ch-under]');
      const bottom = root.querySelector('[data-ch-bottom]');
      if (!editorBody || !editorCanvas || !rail || !panel || !under || !bottom) return false;
      editorBody.insertBefore(rail, editorCanvas);
      editorBody.insertBefore(panel, editorCanvas);
      // The pages strip and bottom controls belong to the document viewport,
      // not beneath the side panels. A real flex column makes this remain true
      // as either side opens, closes, or changes width.
      const canvasColumn = doc.createElement('div');
      canvasColumn.className = 'fmwe-ch-canvas-column';
      editorBody.insertBefore(canvasColumn, editorCanvas);
      canvasColumn.appendChild(editorCanvas);
      canvasColumn.appendChild(under);
      canvasColumn.appendChild(bottom);
      return true;
    }
    dockChromePaletteBelowEditorHeaders();

    // ------------------------------------------------ mobile device preview
    const DEVICE_PRESETS = [
      { id: 'iphone-se', label: (globalThis.PlatformLanguage?.text("visual-editor","m_0ad3e59566ace1","iPhone SE") ?? "iPhone SE"), width: 375, height: 667, body_width_mm: 67.3, body_height_mm: 138.4 },
      { id: 'iphone-15', label: (globalThis.PlatformLanguage?.text("visual-editor","m_36e65ff3909e50","iPhone 15") ?? "iPhone 15"), width: 393, height: 852, body_width_mm: 71.6, body_height_mm: 147.6 },
      { id: 'pixel-8', label: (globalThis.PlatformLanguage?.text("visual-editor","m_0178dbd3bfcd97","Pixel 8") ?? "Pixel 8"), width: 412, height: 915, body_width_mm: 70.8, body_height_mm: 150.5 },
      { id: 'galaxy-s24', label: (globalThis.PlatformLanguage?.text("visual-editor","m_be08f2f5a3bbcd","Galaxy S24") ?? "Galaxy S24"), width: 360, height: 780, body_width_mm: 70.6, body_height_mm: 147.0 }
    ];

    function devicePreviewState(){
      if (!state.devicePreview || typeof state.devicePreview !== 'object') {
        let calibration = 1;
        try { calibration = Number(localStorage.getItem('fmwe-device-physical-calibration')) || 1; } catch (e) { /* storage can be unavailable */ }
        state.devicePreview = { preset: 'iphone-15', width: 393, height: 852, landscape: false, zoom: null, custom: false, physicalCalibration: Math.max(.6, Math.min(1.8, calibration)) };
      }
      return state.devicePreview;
    }

    function notifyDeviceViewport(preview){
      const action = objectValue(opts.documentActions).deviceViewport;
      if (typeof action === 'function') {
        try { action({ width: preview.width, height: preview.height, preset: preview.preset, landscape: !!preview.landscape, custom: !!preview.custom }); } catch (e) { /* host hook is optional */ }
      }
    }

    function devicePhysicalScale(preview){
      const calibration = Math.max(.6, Math.min(1.8, Number(preview.physicalCalibration) || 1));
      if (preview.custom && Number(preview.physicalScale) > 0) return Number(preview.physicalScale) * calibration;
      const preset = DEVICE_PRESETS.find((item) => item.id === preview.preset) || DEVICE_PRESETS[1];
      const widthMm = preview.landscape ? preset.body_height_mm : preset.body_width_mm;
      const heightMm = preview.landscape ? preset.body_width_mm : preset.body_height_mm;
      // CSS defines 1in as 96px. Subtract our visual bezel before deriving
      // the content transform so a 100% frame has the preset's real body size.
      const physicalWidthPx = widthMm * 96 / 25.4;
      const physicalHeightPx = heightMm * 96 / 25.4;
      return Math.max(.2, Math.min((physicalWidthPx - 28) / preview.width, (physicalHeightPx - 28) / preview.height)) * calibration;
    }

    function renderDevicePreview(reflow){
      if (!deviceLayout) return;
      const preview = devicePreviewState();
      // The device surface owns the only active zoom. Keep the embedded
      // editor at 100% even if a toolbar shortcut or Ctrl+wheel fires.
      try { editorHandle.setZoomLock?.(1); } catch (e) { /* older editor handle */ }
      const tools = deviceLayout.querySelector('[data-device-tools]');
      const frame = deviceLayout.querySelector('[data-device-frame]');
      const screen = deviceLayout.querySelector('[data-device-screen]');
      const canvas = chromeCanvasEl();
      if (!frame || !screen || !canvas) return;
      const layoutStyle = getComputedStyle(deviceLayout);
      const padX = (parseFloat(layoutStyle.paddingLeft) || 0) + (parseFloat(layoutStyle.paddingRight) || 0);
      const padY = (parseFloat(layoutStyle.paddingTop) || 0) + (parseFloat(layoutStyle.paddingBottom) || 0);
      // Device tools are viewport chrome anchored in the top-left. They do
      // not participate in centering or shrink the simulated device area.
      const availableWidth = Math.max(220, deviceLayout.clientWidth - padX - 2);
      const availableHeight = Math.max(280, deviceLayout.clientHeight - padY - 2);
      const physicalScale = devicePhysicalScale(preview);
      const physicalFrameWidth = preview.width * physicalScale + 28;
      const physicalFrameHeight = preview.height * physicalScale + 28;
      const fittedZoom = Math.min(1, availableWidth / physicalFrameWidth, availableHeight / physicalFrameHeight);
      const zoom = Math.max(.25, Math.min(1.4, Number(preview.zoom) || fittedZoom));
      const scale = physicalScale * zoom;
      preview.renderedZoom = zoom;
      syncChromeZoomDisplay(zoom, true);
      const visibleWidth = Math.round(preview.width * scale);
      const visibleHeight = Math.round(preview.height * scale);
      frame.style.width = (visibleWidth + 28) + 'px';
      frame.style.height = (visibleHeight + 28) + 'px';
      frame.classList.toggle('custom', !!preview.custom);
      screen.style.width = visibleWidth + 'px';
      screen.style.height = visibleHeight + 'px';
      canvas.style.width = preview.width + 'px';
      canvas.style.height = preview.height + 'px';
      canvas.style.transform = 'scale(' + scale + ')';
      const readout = deviceLayout.querySelector('[data-device-readout]');
      if (readout) readout.textContent = preview.width + ' × ' + preview.height + ' · ' + Math.round(zoom * 100) + '%';
      if (reflow !== false) {
        try { editorHandle.setViewportWidth?.(preview.width); } catch (e) { /* noop */ }
        notifyDeviceViewport(preview);
      }
    }

    function syncSelectionToVariant(variant){
      if (!editorReady()) return;
      const current = editorHandle.selection();
      const mapped = current.map((id) => variantCounterpartId(id, variant)).filter(Boolean);
      requestAnimationFrame(() => {
        if (!editorReady()) return;
        editorHandle.select(mapped);
        state.sectionChromeId = mapped.length === 1 && sectionById(mapped[0]) ? mapped[0] : '';
        updateSectionChrome();
      });
    }

    function teardownDevicePreview(){
      const preview = devicePreviewState();
      const desktopSelection = editorReady() ? editorHandle.selection().map((id) => variantCounterpartId(id, 'desktop')).filter(Boolean) : [];
      if (!deviceLayout) {
        rootEl.classList.remove('fmve-device-mobile');
        try { editorHandle.setZoomLock?.(null); } catch (e) { /* noop */ }
        try { editorHandle.setViewportWidth?.(null); } catch (e) { /* noop */ }
        if (Number.isFinite(preview.desktopZoom)) {
          try { editorHandle.zoom?.(preview.desktopZoom); } catch (e) { /* noop */ }
          delete preview.desktopZoom;
        }
        syncChromeZoomDisplay(editorHandle.zoom?.() || 1, false);
        requestAnimationFrame(() => { if (editorReady()) editorHandle.select(desktopSelection); });
        return;
      }
      const canvas = chromeCanvasEl();
      const column = root.querySelector('.fmwe-ch-canvas-column');
      if (canvas && column) {
        canvas.style.width = '';
        canvas.style.height = '';
        canvas.style.transform = '';
        column.insertBefore(canvas, deviceLayout);
      }
      try { deviceResizeObserver?.disconnect?.(); } catch (e) { /* noop */ }
      deviceResizeObserver = null;
      deviceLayout.remove();
      deviceLayout = null;
      rootEl.classList.remove('fmve-device-mobile');
      try { editorHandle.setZoomLock?.(null); } catch (e) { /* noop */ }
      try { editorHandle.setViewportWidth?.(null); } catch (e) { /* noop */ }
      if (Number.isFinite(preview.desktopZoom)) {
        try { editorHandle.zoom?.(preview.desktopZoom); } catch (e) { /* noop */ }
        delete preview.desktopZoom;
      }
      syncChromeZoomDisplay(editorHandle.zoom?.() || 1, false);
      requestAnimationFrame(() => {
        if (!editorReady()) return;
        editorHandle.select(desktopSelection);
        updateSectionChrome();
      });
    }

    function beginCustomDeviceResize(event, axes){
      const preview = devicePreviewState();
      if (!preview.custom) return;
      event.preventDefault();
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (e) { /* synthetic/legacy pointer */ }
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = preview.width;
      const startHeight = preview.height;
      const scaleMatch = /scale\(([^)]+)\)/.exec(chromeCanvasEl()?.style.transform || '');
      const scale = Math.max(.25, Number(scaleMatch?.[1]) || 1);
      const move = (next) => {
        if (axes.includes('x')) preview.width = Math.max(240, Math.min(1024, Math.round(startWidth + (next.clientX - startX) / scale)));
        if (axes.includes('y')) preview.height = Math.max(320, Math.min(1400, Math.round(startHeight + (next.clientY - startY) / scale)));
        renderDevicePreview(true);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    }

    function ensureDevicePreview(){
      if (deviceLayout) return;
      const canvas = chromeCanvasEl();
      const column = root.querySelector('.fmwe-ch-canvas-column');
      if (!canvas || !column) return;
      const preview = devicePreviewState();
      const desktopZoom = Number(editorHandle.zoom?.());
      if (Number.isFinite(desktopZoom)) preview.desktopZoom = desktopZoom;
      try { editorHandle.setZoomLock?.(1); } catch (e) { /* older editor handle */ }
      deviceLayout = doc.createElement('div');
      deviceLayout.className = 'fmwe-device-layout';
      deviceLayout.innerHTML = `
        <aside class="fmwe-device-tools" data-device-tools aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_5fa7f02ba31afe","Mobile preview controls") ?? "Mobile preview controls")}">
          <button type="button" class="fmwe-device-tool" data-device-rotate title="${(globalThis.PlatformLanguage?.text("visual-editor","m_ed5e3d916ea4a5","Rotate device") ?? "Rotate device")}"><i class="fas fa-rotate"></i><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_fc42f4452e070c","Rotate") ?? "Rotate")}</span></button>
          <select class="fmwe-device-preset" data-device-preset aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_8a12668467f09a","Preview device") ?? "Preview device")}">
            ${String(DEVICE_PRESETS.map((item) => `<option value="${item.id}">${item.label}</option>`).join(''))}
            <option value="custom">${(globalThis.PlatformLanguage?.text("visual-editor","m_aa8339bdd1228b","Custom size") ?? "Custom size")}</option>
          </select>
          <div class="fmwe-device-zoomrow">
            <button type="button" class="fmwe-device-tool" data-device-zoom-out title="${(globalThis.PlatformLanguage?.text("visual-editor","m_acf282d479dddf","Zoom out") ?? "Zoom out")}"><i class="fas fa-minus"></i></button>
            <button type="button" class="fmwe-device-tool" data-device-zoom-in title="${(globalThis.PlatformLanguage?.text("visual-editor","m_a593d968057ce9","Zoom in") ?? "Zoom in")}"><i class="fas fa-plus"></i></button>
          </div>
          <button type="button" class="fmwe-device-tool" data-device-fit title="${(globalThis.PlatformLanguage?.text("visual-editor","m_8829c3be8f32be","Fit full device") ?? "Fit full device")}"><i class="fas fa-expand"></i><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_4b866bd1497eb4","Fit device") ?? "Fit device")}</span></button>
          <button type="button" class="fmwe-device-tool" data-device-calibrate title="${(globalThis.PlatformLanguage?.text("visual-editor","m_c3d1e6af0b83a6","Calibrate physical size") ?? "Calibrate physical size")}"><i class="fas fa-ruler-horizontal"></i><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_deee5f8bdf8738","Actual size") ?? "Actual size")}</span></button>
          <div class="fmwe-device-calibration" data-device-calibration hidden>
            <label><span>${(globalThis.PlatformLanguage?.text("visual-editor","m_58d87bdfc7ae2a","Screen calibration") ?? "Screen calibration")}</span><output data-device-calibration-output>100%</output></label>
            <input type="range" min="60" max="180" step="1" value="100" data-device-calibration-range aria-label="${(globalThis.PlatformLanguage?.text("visual-editor","m_59e5dfc107e498","Physical size calibration") ?? "Physical size calibration")}">
            <span>${(globalThis.PlatformLanguage?.text("visual-editor","m_70675272c920dc","At 100% zoom, adjust until the frame matches the selected phone held against this display.") ?? "At 100% zoom, adjust until the frame matches the selected phone held against this display.")}</span>
            <button type="button" data-device-calibration-reset>${(globalThis.PlatformLanguage?.text("visual-editor","m_40fcb9427ac9a3","Reset calibration") ?? "Reset calibration")}</button>
          </div>
          <div class="fmwe-device-readout" data-device-readout></div>
        </aside>
        <div class="fmwe-device-frame" data-device-frame>
          <div class="fmwe-device-screen" data-device-screen></div>
          <span class="fmwe-device-resize e" data-device-resize="x"></span>
          <span class="fmwe-device-resize s" data-device-resize="y"></span>
          <span class="fmwe-device-resize se" data-device-resize="xy"></span>
        </div>`;
      column.insertBefore(deviceLayout, canvas);
      deviceLayout.querySelector('[data-device-screen]').appendChild(canvas);
      rootEl.classList.add('fmve-device-mobile');
      const select = deviceLayout.querySelector('[data-device-preset]');
      select.value = preview.custom ? 'custom' : preview.preset;
      select.addEventListener('change', () => {
        if (select.value === 'custom') {
          preview.physicalScale = devicePhysicalScale(preview);
          preview.custom = true;
          preview.preset = 'custom';
        } else {
          const preset = DEVICE_PRESETS.find((item) => item.id === select.value) || DEVICE_PRESETS[1];
          preview.custom = false;
          preview.preset = preset.id;
          preview.width = preview.landscape ? preset.height : preset.width;
          preview.height = preview.landscape ? preset.width : preset.height;
        }
        preview.zoom = null;
        renderDevicePreview(true);
      });
      deviceLayout.querySelector('[data-device-rotate]').addEventListener('click', () => {
        const width = preview.width;
        preview.width = preview.height;
        preview.height = width;
        preview.landscape = !preview.landscape;
        preview.zoom = null;
        renderDevicePreview(true);
      });
      deviceLayout.querySelector('[data-device-zoom-out]').addEventListener('click', () => {
        const current = Number(preview.renderedZoom) || 1;
        const next = Math.round((current - .1) * 100) / 100;
        preview.zoom = Math.max(.25, current > 1 && next < 1 ? 1 : next);
        renderDevicePreview(false);
      });
      deviceLayout.querySelector('[data-device-zoom-in]').addEventListener('click', () => {
        const current = Number(preview.renderedZoom) || 1;
        const next = Math.round((current + .1) * 100) / 100;
        preview.zoom = Math.min(1.4, current < 1 && next > 1 ? 1 : next);
        renderDevicePreview(false);
      });
      deviceLayout.querySelector('[data-device-fit]').addEventListener('click', () => { preview.zoom = null; renderDevicePreview(false); });
      const calibrationPanel = deviceLayout.querySelector('[data-device-calibration]');
      const calibrationRange = deviceLayout.querySelector('[data-device-calibration-range]');
      const calibrationOutput = deviceLayout.querySelector('[data-device-calibration-output]');
      const syncCalibration = (value) => {
        const percent = Math.max(60, Math.min(180, Math.round(Number(value) || 100)));
        preview.physicalCalibration = percent / 100;
        calibrationRange.value = String(percent);
        calibrationOutput.textContent = percent + '%';
        try { localStorage.setItem('fmwe-device-physical-calibration', String(preview.physicalCalibration)); } catch (e) { /* storage can be unavailable */ }
        renderDevicePreview(false);
      };
      calibrationRange.value = String(Math.round((Number(preview.physicalCalibration) || 1) * 100));
      calibrationOutput.textContent = calibrationRange.value + '%';
      deviceLayout.querySelector('[data-device-calibrate]').addEventListener('click', () => { calibrationPanel.hidden = !calibrationPanel.hidden; });
      calibrationRange.addEventListener('input', () => syncCalibration(calibrationRange.value));
      deviceLayout.querySelector('[data-device-calibration-reset]').addEventListener('click', () => syncCalibration(100));
      deviceLayout.querySelectorAll('[data-device-resize]').forEach((handle) => handle.addEventListener('pointerdown', (event) => beginCustomDeviceResize(event, handle.dataset.deviceResize)));
      if (typeof ResizeObserver === 'function') {
        deviceResizeObserver = new ResizeObserver(() => { if (!Number(devicePreviewState().zoom)) renderDevicePreview(false); });
        deviceResizeObserver.observe(deviceLayout);
      }
      requestAnimationFrame(() => renderDevicePreview(true));
    }

    function setDevicePreview(config){
      const next = objectValue(config);
      if (next.device !== 'mobile') { teardownDevicePreview(); return; }
      const preview = devicePreviewState();
      if (Number(next.width) > 0) preview.width = Number(next.width);
      if (Number(next.height) > 0) preview.height = Number(next.height);
      ensureDevicePreview();
      renderDevicePreview(true);
      syncSelectionToVariant('mobile');
    }

    // MODE BEHAVIOR: chrome renders only while the inner editor is in
    // 'visual' mode. The editor's own segmented Visual/Doc/Preview control
    // keeps working — we just listen.
    function applyModeChrome(mode){
      const off = mode !== 'visual';
      rootEl.classList.toggle('fmve-nochrome', off);
      rootEl.classList.toggle('fmve-preview-mode', mode === 'preview');
      if (off) {
        endMarkupSession({ silent: true });
        removeSectionChrome();
      } else {
        updateSectionChrome();
        positionSectionChrome();
      }
    }

    function syncFullscreenChrome(){
      const previewFullscreen = doc.fullscreenElement === rootEl && modeNow() === 'preview';
      rootEl.classList.toggle('fmve-preview-fullscreen', previewFullscreen);
      root.querySelectorAll('[data-ch-expand], [data-ch-preview-expand]').forEach((button) => {
        const active = !!doc.fullscreenElement;
        const icon = button.querySelector('i');
        if (icon) icon.className = `fas ${active ? 'fa-compress' : 'fa-expand'}`;
        button.setAttribute('aria-label', active ? 'Exit fullscreen' : (button.hasAttribute('data-ch-preview-expand') ? 'Enter fullscreen preview' : 'Enter fullscreen'));
        button.setAttribute('title', active ? 'Exit fullscreen' : (button.hasAttribute('data-ch-preview-expand') ? 'Fullscreen preview' : 'Fullscreen'));
      });
    }

    function exitFullscreenOnEscape(event){
      if (event.key !== 'Escape' || !doc.fullscreenElement) return;
      doc.exitFullscreen?.();
    }

    doc.addEventListener('fullscreenchange', syncFullscreenChrome);
    doc.addEventListener('keydown', exitFullscreenOnEscape, true);

    if (typeof editorHandle.on === 'function') {
      editorHandle.on('mode', (mode) => { if (!destroyed) applyModeChrome(mode); });
      // Section-management chrome tracks selection, document changes,
      // scroll and zoom.
      editorHandle.on('selection', () => { if (!destroyed) updateSectionChrome(); });
      editorHandle.on('change', () => requestAnimationFrame(() => {
        if (destroyed || !editorHandle) return;
        renderPagesStrip();
        if (state.sectionChromeId && !sectionById(state.sectionChromeId)) { removeSectionChrome(); return; }
        // A selection event can fire before the inserted section paints
        // (chrome skipped) — re-evaluate once the change lands in the DOM.
        const selection = editorHandle.selection();
        if (!state.sectionChromeId && selection.length === 1 && sectionById(selection[0])) { updateSectionChrome(); return; }
        positionSectionChrome();
      }));
    }
    stage.addEventListener('scroll', () => positionSectionChrome(), { passive: true });
    // The real scroll container is the editor's INTERNAL .fmde-canvas — the
    // outer stage never scrolls, so chrome anchored there went stale until
    // the next timer tick and looked glued to the wrong spot.
    chromeCanvasEl()?.addEventListener('scroll', () => positionSectionChrome(), { passive: true });
    doc.addEventListener('click', onSectionWidthOutsideClick, true);
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(() => positionSectionChrome());
      resizeObs.observe(stage);
      // The palette rail and its tray live inside the mounted editor body, so
      // they resize the inner canvas without necessarily resizing `stage`.
      // Track that real visible viewport as well so section chrome follows the
      // responsive fit while panels open and close.
      const visibleCanvas = chromeCanvasEl();
      if (visibleCanvas) resizeObs.observe(visibleCanvas);
      // The selected section changes width continuously during a pointer
      // resize without committing model changes on every frame. Observe its
      // rendered box directly so the adjacent action rail moves in lockstep.
      positionSectionChrome();
    }

    wireChrome();
    applyModeChrome(modeNow());

    // ------------------------------------------------------------ handle
    function destroyInstance(){
      if (destroyed) return;
      destroyed = true;
      clearInterval(state.zoomTimer);
      state.zoomTimer = 0;
      clearTimeout(state.notesTimer);
      state.notesTimer = 0;
      endMarkupSession({ silent: true });
      closePageMenu();
      doc.removeEventListener('click', onSectionWidthOutsideClick, true);
      doc.removeEventListener('fullscreenchange', syncFullscreenChrome);
      doc.removeEventListener('keydown', exitFullscreenOnEscape, true);
      destroyChromeThumbs();
      removeDragGhost();
      try { resizeObs?.disconnect?.(); } catch (e) { /* noop */ }
      resizeObs = null;
      try { deviceResizeObserver?.disconnect?.(); } catch (e) { /* noop */ }
      deviceResizeObserver = null;
      try { editorHandle?.destroy?.(); } catch (e) { /* noop */ }
      editorHandle = null;
      try { rootEl.remove(); } catch (e) { /* noop */ }
    }

    // Delegate the full FMDocEditor handle, then layer the chrome surface on
    // top. `handle.editor` is the raw inner handle for hosts/tests that need
    // the unwrapped editor.
    const handle = {};
    Object.keys(editorHandle).forEach((key) => { handle[key] = editorHandle[key]; });
    handle.editor = editorHandle;
    handle.root = rootEl;
    handle.chromeState = state;
    handle.setDocument = (nextDoc, setOptions) => {
      editorHandle.setDocument(nextDoc, setOptions);
      syncChromeThemeVars(nextDoc);
      updateSectionChrome();
      renderPagesStrip();
    };
    handle.destroy = destroyInstance;
    handle.setChromeTab = setChromeTab;
    handle.getChromeTab = () => state.chromeTab;
    handle.refreshChrome = () => { renderChromePanel(); renderPagesStrip(); };
    handle.refreshPages = renderPagesStrip;
    handle.sectionRect = (id) => {
      const rect = sectionScreenRect(sectionById(id));
      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    // Device handling: mobile uses a complete width × height testing viewport;
    // desktop restores the unconstrained canvas.
    handle.setDevice = (device) => {
      if (chromeOpts.device === false) return;
      setDevicePreview({ device });
    };
    handle.setDevicePreview = setDevicePreview;
    handle.getDevicePreview = () => ({ ...devicePreviewState() });
    handle.getDevice = () => {
      try { return editorHandle.getViewportWidth && editorHandle.getViewportWidth() ? 'mobile' : 'desktop'; }
      catch (e) { return 'desktop'; }
    };
    return handle;
  }

  // ------------------------------------------------------------- exports
  global.FMVisualEditor = {
    version: 1,
    mount,
    CHROME_TABS: CHROME_TABS.map((tab) => ({ ...tab })),
    // Generic engine-node builders + the built-in section registry, exposed
    // so consumers can compose their own template groups (page templates,
    // portal templates, …) from the same primitives — usable off-mount too
    // (e.g. new-page modals, headless template audits).
    builders: { tplText, tplButton, tplSection, tplImage, tplWidget },
    sections: sectionBuilders,          // sections(catalog) -> { hero(), about(), … }
    sectionTemplates,                   // sectionTemplates(catalog) -> [entries]
    templatePreviewDoc,                 // templatePreviewDoc(sections, designWidthPt) -> view doc
    previews: EL_PREVIEWS,
    elSvg,
    PRIMARY_VAR
  };
})(window);
