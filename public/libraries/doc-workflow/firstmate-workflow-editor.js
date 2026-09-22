/**
 * FirstMate workflow editor adapter.
 *
 * A workflow is not a second design surface. Each workflow page is an ordinary
 * DocModel `view` mounted in FMVisualEditor. This adapter contributes only the
 * workflow-specific Fields palette, Flow side panel, page adapter, and the
 * projection between visual nodes and the executable workflow definition.
 *
 * Global: FMWorkflowEditor
 */
(function (global) {
  'use strict';

  const STYLE_ID = 'fm-workflow-editor-adapter-styles';
  const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const arrayValue = (value) => Array.isArray(value) ? value : [];
  const cleanText = (value) => String(value === null || value === undefined ? '' : value).trim();
  const firstText = (...values) => values.map(cleanText).find(Boolean) || '';
  const esc = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const FIELD_PRESENTATIONS = new Set(['select', 'multi_select', 'choice_group']);
  const FIELD_MARGIN_PT = 28;
  const FIELD_GUTTER_PT = 12;
  const WORKFLOW_MAX_WIDTH_PX = 600;
  const WORKFLOW_WIDTH_PT = WORKFLOW_MAX_WIDTH_PX * 72 / 96;
  const DEFAULT_KINDS = [
    { id: 'text', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_124287f184b88b","Text") ?? "Text"), icon: 'fa-font' },
    { id: 'textarea', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_4cea0cfc5349a4","Long text") ?? "Long text"), icon: 'fa-align-left' },
    { id: 'number', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_3e7027aa9d65ed","Number") ?? "Number"), icon: 'fa-hashtag' },
    { id: 'currency', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_c267b6350b9781","Currency") ?? "Currency"), icon: 'fa-dollar-sign' },
    { id: 'date', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_2a0b11100c22a4","Date") ?? "Date"), icon: 'fa-calendar' },
    { id: 'select', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_1ce8dae577783a","Multiple choice") ?? "Multiple choice"), icon: 'fa-grid-2' },
    { id: 'multi_select', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_5146a7634e536b","Multiple selection") ?? "Multiple selection"), icon: 'fa-check-double' },
    { id: 'boolean', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_97d47246190075","Yes / no") ?? "Yes / no"), icon: 'fa-toggle-on' },
    { id: 'media_picker', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_49e775f365e4e6","Media") ?? "Media"), icon: 'fa-image' },
    { id: 'signature', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_8625881623433e","Signature") ?? "Signature"), icon: 'fa-signature' },
    { id: 'payment', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_d0f1699dbcd6a5","Payment") ?? "Payment"), icon: 'fa-credit-card' }
  ];

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.fmve-kind-workflow .fmwe-ch-railbtn[data-ch-tab="fields"]{order:-1}
.fmve-kind-workflow .fmwe-ch-panel[data-active-tab="fields"]{flex-basis:270px;max-width:270px}.fmve-kind-workflow .fmwe-ch-panel[data-active-tab="fields"] .fmwe-ch-panel-body{width:270px;flex-basis:270px;padding:0}
.fmwfe-fields-head{padding:8px 7px 6px;display:flex;flex-direction:column;gap:2px}.fmwfe-fields-head strong{font-size:11px}.fmwfe-fields-head span{font-size:7.5px;color:#98a2b3;font-weight:700;line-height:1.3}
.fmwfe-section-card{margin:0 6px 6px;width:calc(100% - 12px);border:1px solid color-mix(in srgb,var(--fm-primary,#2563eb) 28%,#d0d5dd);border-radius:9px;background:color-mix(in srgb,var(--fm-primary,#2563eb) 5%,#fff);padding:6px;display:flex;align-items:center;gap:5px;color:#344054;font:inherit;font-size:8.5px;font-weight:900;cursor:grab;text-align:left;min-width:0}.fmwfe-section-card i{flex:none;color:var(--fm-primary,#2563eb);font-size:12px}.fmwfe-section-card span{min-width:0;display:flex;flex-direction:column;gap:1px}.fmwfe-section-card small{font-size:6.75px;color:#98a2b3;font-weight:700;line-height:1.2}
.fmwfe-field-grid{padding:0 6px 9px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px}.fmwfe-field-card{min-width:0;min-height:48px;border:1px solid #e1e5eb;border-radius:8px;background:#fff;padding:5px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px;color:#475467;font:inherit;font-size:7.5px;font-weight:850;line-height:1.15;text-align:left;overflow-wrap:anywhere;cursor:grab}.fmwfe-field-card:hover{border-color:var(--fm-primary,#2563eb);color:var(--fm-primary,#2563eb)}.fmwfe-field-card i{font-size:11px}.fmwfe-field-card:disabled{filter:grayscale(1);opacity:.45;cursor:not-allowed}
.fmve-kind-workflow .fmwfe-section-card{font-size:8.5px}.fmve-kind-workflow .fmwfe-field-card{font-size:7.5px}
.fmwe-drag-ghost.fmwfe-field-drag-ghost{width:360px;max-width:min(360px,calc(100vw - 28px));padding:0;border:0;border-radius:10px;background:transparent;white-space:normal;overflow:visible;box-shadow:0 16px 38px rgba(15,23,42,.24)}.fmwfe-field-drag-preview{box-sizing:border-box;width:100%;min-height:76px;padding:11px 12px;border:1px solid #cfd6e1;border-radius:10px;background:#fff;display:flex;flex-direction:column;gap:7px;color:#344054}.fmwfe-field-drag-preview strong{font-size:11px}.fmwfe-field-drag-control{min-height:34px;border:1px solid #d0d5dd;border-radius:7px;background:#f9fafb;display:flex;align-items:center;padding:7px 9px;color:#98a2b3;font-size:9px}.fmwfe-field-drag-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.fmwfe-field-drag-options span{min-height:31px;border:1px solid #d6dce5;border-radius:7px;display:grid;place-items:center;background:#fff;color:#667085;font-size:8px;font-weight:800}
.fmwfe-flow{display:flex;flex-direction:column;min-height:100%;color:#344054}.fmwfe-flow-head{padding:12px;border-bottom:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between}.fmwfe-flow-head strong{font-size:12px}.fmwfe-flow-head span{display:block;margin-top:2px;font-size:9px;color:#98a2b3;font-weight:700}.fmwfe-tree{padding:8px;border-bottom:1px solid #eaecf0;display:flex;flex-direction:column;gap:2px;max-height:45vh;overflow:auto}.fmwfe-tree button{width:100%;border:0;border-radius:7px;background:transparent;padding:6px 7px;display:flex;align-items:center;gap:7px;color:#475467;font:inherit;font-size:10px;font-weight:800;text-align:left;cursor:pointer;min-width:0}.fmwfe-tree button:hover,.fmwfe-tree button.active{background:color-mix(in srgb,var(--fm-primary,#2563eb) 8%,#fff);color:var(--fm-primary,#2563eb)}.fmwfe-tree button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmwfe-tree button b{margin-left:auto;padding:2px 4px;border-radius:4px;background:#fef0c7;color:#93370d;font-size:7px}.fmwfe-tree .section{margin-left:11px;border-left:1px solid #d0d5dd;padding-left:4px}.fmwfe-tree .field{margin-left:14px;font-weight:700}.fmwfe-tree .field small{margin-left:auto;color:#98a2b3;font-size:7.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:76px}
.fmwfe-inspector{padding:12px;display:flex;flex-direction:column;gap:11px}.fmwfe-inspector h4{margin:0;font-size:12px;color:#101828}.fmwfe-inspector-group{padding:10px;border:1px solid #eaecf0;border-radius:9px;background:#fff;display:flex;flex-direction:column;gap:9px}.fmwfe-inspector-group>strong{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#667085}.fmwfe-inspector label{display:flex;flex-direction:column;gap:4px}.fmwfe-inspector label>span{font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#8a92ab;font-weight:900}.fmwfe-inspector :is(input,select,textarea){width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:7px;background:#fff;padding:7px 8px;color:#344054;font:inherit;font-size:10px}.fmwfe-inspector textarea{min-height:70px;resize:vertical}.fmwfe-inspector .check{flex-direction:row;align-items:center}.fmwfe-inspector .check input{width:auto}.fmwfe-choice-list{display:flex;flex-direction:column;gap:7px}.fmwfe-choice-row{display:grid;grid-template-columns:1fr 30px;gap:6px;padding:8px;border:1px solid #e4e7ec;border-radius:8px;background:#f9fafb}.fmwfe-choice-row label{grid-column:1}.fmwfe-choice-row label+label{margin-top:2px}.fmwfe-choice-row button{grid-column:2;grid-row:1 / span 2;width:30px;border:0;border-radius:6px;background:transparent;color:#98a2b3;cursor:pointer}.fmwfe-choice-row button:hover{background:#fee4e2;color:#b42318}.fmwfe-add-choice{width:100%;min-height:31px;border:1px dashed #b8c0cc;border-radius:7px;background:#fff;color:var(--fm-primary,#2563eb);font:inherit;font-size:9px;font-weight:850;cursor:pointer}.fmwfe-muted{padding:12px;color:#98a2b3;font-size:10px;line-height:1.45}
.fmve-kind-workflow .fmde-widget-controls-field-settings{padding:12px}.fmve-kind-workflow .fmde-widget-controls-field-settings>.fmde-section-body{gap:11px}.fmve-kind-workflow .fmde-widget-controls-field-settings .fmde-widget-controls-head{padding-bottom:9px;border-bottom:1px solid #eaecf0}.fmve-kind-workflow .fmde-widget-controls-field-settings>.fmde-section-body>.fmde-field{align-items:flex-start}.fmve-kind-workflow .fmde-widget-controls-field-settings>.fmde-section-body>.fmde-field>.fmde-field-label{flex-basis:92px;padding-top:6px}.fmve-kind-workflow .fmde-widget-controls-field-settings .fmde-list-object{background:#f9fafb}
.fmwfe-preview-nav{flex:none;padding:11px 16px;border-top:1px solid #e4e7ec;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px}.fmwfe-preview-nav[hidden]{display:none}.fmwfe-preview-nav button{min-height:34px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:0 13px;color:#344054;font:inherit;font-size:11px;font-weight:850;cursor:pointer}.fmwfe-preview-nav button.primary{border-color:var(--fm-primary,#2563eb);background:var(--fm-primary,#2563eb);color:#fff}.fmwfe-preview-nav button:disabled{opacity:.4;cursor:not-allowed}.fmwfe-preview-nav span{font-size:9.5px;color:#98a2b3;font-weight:750}
.fmwfe-field-actions{position:fixed;z-index:2147483410;display:flex;align-items:center;gap:4px;padding:4px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.18)}.fmwfe-field-actions[hidden]{display:none}.fmwfe-field-actions button{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:#475467;cursor:pointer}.fmwfe-field-actions button:hover{background:color-mix(in srgb,var(--fm-primary,#2563eb) 10%,#fff);color:var(--fm-primary,#2563eb)}
`;
    document.head.appendChild(style);
  }

  function model() {
    if (!global.FMDocModel) throw new Error('FMWorkflowEditor requires FMDocModel.');
    return global.FMDocModel;
  }

  function fieldKindLabel(value) {
    const source = firstText(value).replace(/[_-]+/g, ' ');
    const acronyms = source.replace(/\bbio\b/gi, 'BIO').replace(/\bapi\b/gi, 'API').replace(/\bid\b/gi, 'ID');
    return acronyms ? acronyms.charAt(0).toUpperCase() + acronyms.slice(1) : '';
  }

  function fieldDragPreview(kind) {
    const choiceField = FIELD_PRESENTATIONS.has(kind.id);
    const booleanField = kind.id === 'boolean';
    const control = choiceField || booleanField
      ? `<div class="fmwfe-field-drag-options"><span>${booleanField ? 'Yes' : 'Option 1'}</span><span>${booleanField ? 'No' : 'Option 2'}</span>${booleanField ? '' : `<span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_356cd50e508aeb","Option 3") ?? "Option 3")}</span>`}</div>`
      : `<div class="fmwfe-field-drag-control">${kind.id === 'textarea' ? 'Long-form response' : 'Response'}</div>`;
    return `<div class="fmwfe-field-drag-preview"><strong>${esc(kind.label)}</strong>${control}</div>`;
  }

  function workflowKinds(options) {
    const byId = new Map(DEFAULT_KINDS.map((item) => [item.id, { ...item }]));
    arrayValue(options.itemKinds).forEach((raw) => {
      const item = objectValue(raw);
      const id = firstText(item.id);
      if (!id) return;
      const fallback = byId.get(id) || {};
      byId.set(id, {
        id,
        label: fieldKindLabel(firstText(item.label, fallback.label, id)),
        icon: firstText(item.icon, fallback.icon, 'fa-list-check'),
        disabled: item.disabled === true,
        disabled_reason: firstText(item.disabled_reason),
        disabled_capability: firstText(item.disabled_capability)
      });
    });
    return Array.from(byId.values());
  }

  function createFieldNode(item, kindMeta) {
    const M = model();
    const source = objectValue(item);
    const kind = firstText(source.kind, kindMeta?.id, 'text');
    const presentation = objectValue(source.presentation);
    const transition = objectValue(presentation.transition);
    const choiceStyle = firstText(presentation.style, source.choice_style, 'tiles');
    const options = arrayValue(source.options);
    const height = FIELD_PRESENTATIONS.has(kind) && choiceStyle !== 'dropdown' ? 128 : 82;
    return M.createNode('widget', {
      name: firstText(source.label, kindMeta?.label, 'Field'),
      frame: { x: 0, y: 0, w: FIELD_PRESENTATIONS.has(kind) ? 330 : 260, h: height, z: 1, layout: 'absolute' },
      props: {
        widget: 'doc.workflow_field@1',
        config: {
          workflow_item: clone(source),
          kind,
          label: firstText(source.label, kindMeta?.label, 'Field'),
          description: firstText(source.description, source.help_text),
          writes: firstText(source.writes),
          placeholder: firstText(source.placeholder),
          required: source.required === true,
          options: clone(options.length ? options : (FIELD_PRESENTATIONS.has(kind) ? [
            { value: 'option_1', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_2a4877910d1292","Option one") ?? "Option one"), icon: 'fa-circle' },
            { value: 'option_2', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_a525aeb4662a75","Option two") ?? "Option two"), icon: 'fa-circle' }
          ] : [])),
          choice_style: choiceStyle,
          when: firstText(source.when),
          transition: firstText(transition.type, source.transition, 'fade'),
          transition_duration_ms: Number(transition.duration_ms || 180),
          disabled: source.disabled === true || kindMeta?.disabled === true,
          disabled_reason: firstText(source.disabled_reason, kindMeta?.disabled_reason),
          disabled_capability: firstText(source.disabled_capability, kindMeta?.disabled_capability)
        }
      }
    });
  }

  function createFieldSection(section, index) {
    const M = model();
    const source = objectValue(section);
    const style = objectValue(source.style);
    const node = M.createNode('frame', {
      name: firstText(source.title, `Field section ${index + 1}`),
      frame: { x: 0, y: index * 260, w: 'auto', h: Number(objectValue(source.layout).height_pt || 230), z: index, layout: 'absolute' },
      style: {
        fill: { type: 'solid', color: firstText(style.background, '#ffffff') },
        ...clone(style.node_style || {}),
        radius: 0,
        corner_radius: 0
      },
      props: {
        section_width: M.normalizeSectionWidth ? M.normalizeSectionWidth({ width_percent: 100, max_enabled: true, max_width_px: WORKFLOW_MAX_WIDTH_PX }) : undefined,
        workflow_section: {
          id: firstText(source.id, `section_${index + 1}`),
          title: firstText(source.title, `Field section ${index + 1}`),
          when: firstText(source.when),
          transition: clone(objectValue(source.transition))
        }
      },
      children: []
    });
    const items = arrayValue(source.items);
    let nextY = FIELD_MARGIN_PT;
    items.forEach((item, itemIndex) => {
      const field = createFieldNode(item);
      const layout = objectValue(objectValue(item).layout);
      const x = Number.isFinite(Number(layout.x)) ? Number(layout.x) : FIELD_MARGIN_PT;
      const y = Number.isFinite(Number(layout.y)) ? Number(layout.y) : nextY;
      const availableWidth = Math.max(80, WORKFLOW_WIDTH_PT - x - FIELD_MARGIN_PT);
      const requestedWidth = Number(layout.w);
      const width = Math.min(availableWidth, Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : availableWidth);
      field.frame = {
        ...field.frame,
        x,
        y,
        w: width,
        h: Number(layout.h || field.frame.h),
        z: itemIndex + 1
      };
      node.children.push(field);
      nextY = Math.max(nextY, y + Number(field.frame.h || 82) + FIELD_GUTTER_PT);
    });
    const neededHeight = Math.max(Number(node.frame.h) || 230, (items.length ? nextY - FIELD_GUTTER_PT : 0) + FIELD_MARGIN_PT);
    node.frame.h = neededHeight;
    return node;
  }

  function scaleHorizontal(node, ratio) {
    if (!node || !(ratio > 0) || ratio === 1) return;
    const frame = objectValue(node.frame);
    if (Number.isFinite(Number(frame.x))) frame.x = Math.round(Number(frame.x) * ratio * 100) / 100;
    if (Number.isFinite(Number(frame.w))) frame.w = Math.round(Number(frame.w) * ratio * 100) / 100;
    arrayValue(node.children).forEach((child) => scaleHorizontal(child, ratio));
  }

  function useManualWorkflowPlacement(node, parentWidthPt) {
    if (!node) return;
    const M = model();
    const frame = objectValue(node.frame);
    const parentWidth = Number(parentWidthPt) > 0 ? Number(parentWidthPt) : WORKFLOW_WIDTH_PT;
    if (Number.isFinite(Number(frame.x)) && Number.isFinite(Number(frame.w)) && Number(frame.w) > 0) {
      const basis = objectValue(objectValue(frame.position).x);
      frame.position = {
        ...objectValue(frame.position),
        x: M.horizontalPositionFromLeft(
          Number(frame.x) * 96 / 72,
          Number(frame.w) * 96 / 72,
          parentWidth * 96 / 72,
          Object.keys(basis).length ? basis : { unit: 'percent', anchor: 'center', value: 0 }
        )
      };
      frame.responsive = { ...M.normalizeResponsiveResize(frame.responsive), mode: 'manual' };
    }
    const childWidth = Number(frame.w) > 0 ? Number(frame.w) : parentWidth;
    arrayValue(node.children).forEach((child) => useManualWorkflowPlacement(child, childWidth));
  }

  function constrainWorkflowDesign(document_) {
    const root = objectValue(document_.root);
    const sourceWidth = Number(objectValue(root.frame).w);
    if (Number.isFinite(sourceWidth) && sourceWidth > WORKFLOW_WIDTH_PT) {
      const ratio = WORKFLOW_WIDTH_PT / sourceWidth;
      arrayValue(root.children).forEach((section) => scaleHorizontal(section, ratio));
    }
    root.frame = { ...objectValue(root.frame), w: WORKFLOW_WIDTH_PT };
    // A workflow is an embeddable 600px surface, not a website laid over a
    // wider page. Only its sections paint backgrounds; the coordinate root
    // remains transparent so host tabs/pages supply everything around it.
    root.style = { ...objectValue(root.style), fill: null };
    arrayValue(root.children).forEach((section) => {
      if (objectValue(section).type !== 'frame') return;
      section.frame = { ...objectValue(section.frame), x: 0, w: 'auto' };
      section.style = { ...objectValue(section.style), radius: 0, corner_radius: 0 };
      arrayValue(section.children).forEach((child) => useManualWorkflowPlacement(child, WORKFLOW_WIDTH_PT));
      section.props = {
        ...objectValue(section.props),
        section_width: model().normalizeSectionWidth({
          width_percent: 100,
          max_enabled: true,
          max_width_px: WORKFLOW_MAX_WIDTH_PX
        })
      };
    });
    document_.metadata = { ...objectValue(document_.metadata), workflow_page: true, workflow_max_width_px: WORKFLOW_MAX_WIDTH_PX };
    return document_;
  }

  function blankPageDesign(step) {
    const M = model();
    const document_ = M.createDocument({ kind: 'view', paper: 'letter' });
    document_.root.frame = { ...objectValue(document_.root.frame), layout: 'flow', x: 0, y: 0, w: WORKFLOW_WIDTH_PT, h: 0 };
    const sections = arrayValue(step.sections);
    const legacyItems = arrayValue(step.items);
    const sourceSections = sections.length ? sections : [{ id: 'section_1', title: (globalThis.PlatformLanguage?.text("doc-workflow","m_2128b09a02a1b0","Field section") ?? "Field section"), items: legacyItems }];
    document_.root.children = sourceSections.map(createFieldSection);
    document_.metadata = { ...objectValue(document_.metadata), workflow_page: true };
    return constrainWorkflowDesign(document_);
  }

  function ensureStepDesign(step) {
    const existing = objectValue(step.design);
    if (existing.kind === 'view' && objectValue(existing.root).type === 'frame') {
      return constrainWorkflowDesign(clone(existing));
    }
    return blankPageDesign(step);
  }

  function fieldItemFromNode(node) {
    const config = objectValue(objectValue(node.props).config);
    const base = clone(objectValue(config.workflow_item));
    base.kind = firstText(config.kind, base.kind, 'text');
    if (firstText(config.writes, base.writes)) base.writes = firstText(config.writes, base.writes); else delete base.writes;
    base.label = firstText(config.label, base.label, node.name, 'Field');
    if (firstText(config.description, base.description)) base.description = firstText(config.description, base.description); else delete base.description;
    if (config.required === true) base.required = true; else delete base.required;
    if (firstText(config.when)) base.when = firstText(config.when); else delete base.when;
    if (arrayValue(config.options).length) base.options = clone(config.options); else delete base.options;
    if (FIELD_PRESENTATIONS.has(base.kind)) {
      base.presentation = { ...objectValue(base.presentation), style: firstText(config.choice_style, 'tiles') };
    }
    const transition = firstText(config.transition);
    if (transition) {
      base.presentation = { ...objectValue(base.presentation), transition: {
        ...objectValue(objectValue(base.presentation).transition),
        type: transition,
        duration_ms: Number(config.transition_duration_ms || 180)
      } };
    }
    ['disabled', 'disabled_reason', 'disabled_capability'].forEach((key) => {
      if (config[key]) base[key] = config[key]; else delete base[key];
    });
    base.layout = { ...objectValue(base.layout), x: Number(node.frame?.x || 0), y: Number(node.frame?.y || 0), w: Number(node.frame?.w || 260), h: Number(node.frame?.h || 82) };
    return base;
  }

  function sectionFromNode(node, index) {
    const meta = objectValue(objectValue(node.props).workflow_section);
    const items = [];
    (function visit(value) {
      if (!value) return;
      if (value.type === 'widget' && firstText(objectValue(value.props).widget).split('@')[0] === 'doc.workflow_field') items.push(fieldItemFromNode(value));
      arrayValue(value.children).forEach(visit);
    })(node);
    const section = {
      id: firstText(meta.id, node.id, `section_${index + 1}`),
      title: firstText(meta.title, node.name, `Field section ${index + 1}`),
      items,
      style: {
        background: firstText(objectValue(objectValue(node.style).fill).color, '#ffffff'),
        radius: 0,
        node_style: { ...clone(objectValue(node.style)), radius: 0, corner_radius: 0 }
      },
      layout: { height_pt: Number(objectValue(node.frame).h || 230) }
    };
    if (firstText(meta.when)) section.when = firstText(meta.when);
    if (Object.keys(objectValue(meta.transition)).length) section.transition = clone(meta.transition);
    return section;
  }

  function syncStepFromDesign(step, document_) {
    step.design = clone(document_);
    step.sections = arrayValue(objectValue(document_.root).children)
      .filter((node) => objectValue(node).type === 'frame')
      .map(sectionFromNode);
    delete step.items;
    return step;
  }

  function mount(container, options = {}) {
    ensureStyles();
    if (!container) throw new Error('FMWorkflowEditor.mount: container required.');
    if (!global.FMVisualEditor?.mount) throw new Error('FMWorkflowEditor requires FMVisualEditor.');
    const opts = objectValue(options);
    let definition = clone(objectValue(opts.definition));
    if (!Array.isArray(definition.steps) || !definition.steps.length) definition.steps = [{ id: 'page_1', title: (globalThis.PlatformLanguage?.text("doc-workflow","m_6bb8069fae869e","Page 1") ?? "Page 1"), audience: ['internal'], sections: [] }];
    let activeStepId = firstText(opts.initialStepId, definition.steps[0].id);
    let visualHandle = null;
    let previewNav = null;
    let fieldActions = null;
    let destroyed = false;
    const flowHosts = new Set();
    const kinds = workflowKinds(opts);

    const steps = () => arrayValue(definition.steps);
    const activeStep = () => steps().find((step) => firstText(step.id) === activeStepId) || steps()[0];
    const emitDefinition = (meta) => {
      definition.name = firstText(opts.name, definition.name, 'Workflow');
      try { opts.onChange?.(clone(definition), meta || {}); } catch (error) { global.console?.error?.('[FMWorkflowEditor] onChange failed', error); }
      renderFlowPanels();
    };
    const syncCurrent = () => {
      if (visualHandle && activeStep()) syncStepFromDesign(activeStep(), visualHandle.getDocument());
      return definition;
    };
    const switchStep = (id) => {
      if (destroyed) return;
      syncCurrent();
      const next = steps().find((step) => firstText(step.id) === cleanText(id));
      if (!next) return;
      activeStepId = firstText(next.id);
      visualHandle?.setDocument?.(ensureStepDesign(next), { preserveHistory: false });
      visualHandle?.select?.([]);
      visualHandle?.refreshPages?.();
      renderFlowPanels();
      renderPreviewNav();
    };

    const pages = {
      list() {
        syncCurrent();
        return steps().map((step, index) => ({ id: firstText(step.id, `page_${index + 1}`), title: firstText(step.title, `Page ${index + 1}`), definition: ensureStepDesign(step) }));
      },
      current() { return activeStepId; },
      select(id) { switchStep(id); },
      add(afterId) {
        syncCurrent();
        const index = Math.max(-1, steps().findIndex((step) => firstText(step.id) === cleanText(afterId)));
        const number = steps().length + 1;
        const step = { id: model().generateId('page'), title: ((v0) => globalThis.PlatformLanguage?.text("doc-workflow","m_5cc367ea2b4774",`Page ${v0}`,{v0}) ?? `Page ${v0}`)(number), audience: ['internal'], sections: [] };
        step.design = blankPageDesign(step);
        steps().splice(index + 1, 0, step);
        activeStepId = step.id;
        visualHandle?.setDocument?.(clone(step.design), { preserveHistory: false });
        visualHandle?.refreshPages?.();
        emitDefinition({ source: 'page.add' });
      },
      rename(id, title) {
        const step = steps().find((entry) => firstText(entry.id) === cleanText(id));
        if (!step || !cleanText(title)) return;
        step.title = cleanText(title);
        emitDefinition({ source: 'page.rename' });
      },
      copy(id) {
        syncCurrent();
        const step = steps().find((entry) => firstText(entry.id) === cleanText(id));
        return step ? clone(step) : null;
      },
      paste(afterId, copied) {
        if (!copied) return;
        const index = Math.max(-1, steps().findIndex((step) => firstText(step.id) === cleanText(afterId)));
        const next = clone(copied);
        next.id = model().generateId('page');
        next.title = ((v0) => globalThis.PlatformLanguage?.text("doc-workflow","m_2ec49fdf16087c",`${v0} copy`,{v0}) ?? `${v0} copy`)(firstText(next.title, 'Page'));
        next.design = ensureStepDesign(next);
        next.design.root.children = model().reassignIds(arrayValue(next.design.root.children));
        steps().splice(index + 1, 0, next);
        activeStepId = next.id;
        visualHandle?.setDocument?.(clone(next.design), { preserveHistory: false });
        visualHandle?.refreshPages?.();
        emitDefinition({ source: 'page.paste' });
      },
      duplicate(id) { const copied = this.copy(id); if (copied) this.paste(id, copied); },
      remove(id) {
        if (steps().length < 2) return;
        const index = steps().findIndex((step) => firstText(step.id) === cleanText(id));
        if (index < 0) return;
        steps().splice(index, 1);
        const next = steps()[Math.min(index, steps().length - 1)];
        activeStepId = firstText(next.id);
        visualHandle?.setDocument?.(ensureStepDesign(next), { preserveHistory: false });
        visualHandle?.refreshPages?.();
        emitDefinition({ source: 'page.remove' });
      }
    };

    function newSection() {
      return createFieldSection({ id: model().generateId('section'), title: (globalThis.PlatformLanguage?.text("doc-workflow","m_2128b09a02a1b0","Field section") ?? "Field section"), items: [] }, 0);
    }

    function containsNode(node, id) {
      if (!node || !id) return false;
      if (node.id === id) return true;
      return arrayValue(node.children).some((child) => containsNode(child, id));
    }

    function selectedRootSection(document_) {
      const selectionId = arrayValue(visualHandle?.selection?.())[0];
      const sections = arrayValue(objectValue(document_.root).children).filter((node) => objectValue(node).type === 'frame');
      return sections.find((section) => containsNode(section, selectionId)) || sections[sections.length - 1] || null;
    }

    function insertWorkflowField(node) {
      if (!visualHandle || !node) return null;
      const document_ = visualHandle.getDocument();
      let section = selectedRootSection(document_);
      const commands = [];
      if (!section) {
        section = newSection();
        commands.push({ type: 'node.insert', node: section, parent_id: null });
      }
      const sectionWidth = Number(objectValue(section.frame).w);
      const rootWidth = Number(objectValue(document_.root).frame?.w);
      const width = Math.max(80, (Number.isFinite(sectionWidth) && sectionWidth > 0 ? sectionWidth : (Number.isFinite(rootWidth) && rootWidth > 0 ? rootWidth : 720)) - FIELD_MARGIN_PT * 2);
      const children = arrayValue(section.children);
      const previousBottom = children.reduce((bottom, child) => {
        const frame = objectValue(child.frame);
        return Math.max(bottom, Number(frame.y || 0) + Number(frame.h || 0));
      }, 0);
      const y = children.length ? previousBottom + FIELD_GUTTER_PT : FIELD_MARGIN_PT;
      const nextZ = children.reduce((highest, child) => Math.max(highest, Number(objectValue(child.frame).z || 0)), 0) + 1;
      node.frame = { ...objectValue(node.frame), x: FIELD_MARGIN_PT, y, w: width, z: nextZ, layout: 'absolute' };
      const neededHeight = y + Number(node.frame.h || 82) + FIELD_MARGIN_PT;
      commands.push({ type: 'node.insert', node, parent_id: section.id });
      if (neededHeight > Number(objectValue(section.frame).h || 0)) commands.push({ type: 'node.set', node_id: section.id, prop: 'frame.h', value: neededHeight });
      if (typeof visualHandle.applyBatch === 'function') visualHandle.applyBatch(commands, 'workflow-field-insert');
      else commands.forEach((command) => visualHandle.apply(command));
      visualHandle.select?.([node.id]);
      return node.id;
    }

    const fieldsTab = {
      id: 'fields', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_3fb0ccaf330e5c","Fields") ?? "Fields"), icon: 'fa-list-check', order: 15,
      render(host, api) {
        host.innerHTML = `<div class="fmwfe-fields-head"><strong>${(globalThis.PlatformLanguage?.text("doc-workflow","m_3fb0ccaf330e5c","Fields") ?? "Fields")}</strong><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_af14b8b6b3f8da","Drag a field section onto the page, then arrange fields and visual elements together.") ?? "Drag a field section onto the page, then arrange fields and visual elements together.")}</span></div>
          <button type="button" class="fmwfe-section-card" data-fmwfe-section><i class="fas fa-layer-group"></i><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_2128b09a02a1b0","Field section") ?? "Field section")}<small>${(globalThis.PlatformLanguage?.text("doc-workflow","m_f7014706241e4f","Resizable conditional group") ?? "Resizable conditional group")}</small></span></button>
          <div class="fmwfe-field-grid">${String(kinds.map((kind) => `<button type="button" class="fmwfe-field-card" data-fmwfe-kind="${esc(kind.id)}" ${kind.disabled ? `disabled title="${esc(kind.disabled_reason)}"` : ''}><i class="fas ${esc(kind.icon)}"></i><span>${esc(kind.label)}${kind.disabled ? ' · disabled' : ''}</span></button>`).join(''))}</div>`;
        const sectionButton = host.querySelector('[data-fmwfe-section]');
        api.wireInsertDrag(sectionButton, {
          ghost: '<i class="fas fa-layer-group"></i> Field section',
          onClick: () => api.insertSections([newSection()]),
          onDrop: () => api.insertSections([newSection()])
        });
        host.querySelectorAll('[data-fmwfe-kind]').forEach((button) => {
          const kind = kinds.find((entry) => entry.id === button.dataset.fmwfeKind);
          if (!kind || kind.disabled) return;
          const build = () => createFieldNode({ kind: kind.id, label: kind.label }, kind);
          api.wireInsertDrag(button, {
            ghostClass: 'fmwfe-field-drag-ghost',
            ghost: fieldDragPreview(kind),
            onClick: () => insertWorkflowField(build()),
            onDrop: (point) => api.insertNode(build(), point)
          });
        });
      }
    };

    function nodeById(document_, id) {
      return id ? objectValue(model().findNode(document_, id)).node || null : null;
    }

    function selectedEntity() {
      const step = activeStep();
      const document_ = visualHandle?.getDocument?.() || ensureStepDesign(step);
      const id = arrayValue(visualHandle?.selection?.())[0];
      const node = nodeById(document_, id);
      if (!node) return { type: 'page', step, document_ };
      if (node.type === 'frame' && arrayValue(objectValue(document_.root).children).some((entry) => entry.id === node.id)) return { type: 'section', step, document_, node };
      if (node.type === 'widget' && firstText(objectValue(node.props).widget).split('@')[0] === 'doc.workflow_field') return { type: 'field', step, document_, node };
      return { type: 'element', step, document_, node };
    }

    function isWorkflowField(node) {
      return objectValue(node).type === 'widget' && firstText(objectValue(objectValue(node).props).widget).split('@')[0] === 'doc.workflow_field';
    }

    function openFieldFlow(nodeId, focusCondition) {
      if (nodeId) visualHandle?.select?.([nodeId]);
      visualHandle?.openSidePanel?.('flow');
      renderFlowPanels();
      if (focusCondition) requestAnimationFrame(() => {
        const input = visualHandle?.root?.querySelector?.('[data-fmwfe-inspector] [data-fmwfe-when]');
        input?.focus?.();
        input?.select?.();
      });
    }

    function duplicateWorkflowField(nodeId) {
      const document_ = visualHandle?.getDocument?.();
      const node = nodeById(document_, nodeId);
      if (!isWorkflowField(node)) return null;
      const copy = model().reassignIds(clone(node));
      copy.name = `${firstText(node.name, objectValue(objectValue(node.props).config).label, 'Field')} copy`;
      copy.props = { ...objectValue(copy.props), config: { ...objectValue(objectValue(copy.props).config), label: copy.name } };
      return insertWorkflowField(copy);
    }

    function workflowContextItems(context) {
      const node = objectValue(context).node;
      if (!isWorkflowField(node)) return [];
      return [
        { label: (globalThis.PlatformLanguage?.text("doc-workflow","m_3caa7b4c2c6387","Duplicate below") ?? "Duplicate below"), icon: 'copy', onClick: () => duplicateWorkflowField(node.id) },
        { label: (globalThis.PlatformLanguage?.text("doc-workflow","m_5972d014cecc83","Edit display condition") ?? "Edit display condition"), onClick: () => openFieldFlow(node.id, true) },
        { label: (globalThis.PlatformLanguage?.text("doc-workflow","m_6cec3410f41f6d","Field settings") ?? "Field settings"), icon: 'pencil', onClick: () => openFieldFlow(node.id, false) }
      ];
    }

    function selectedFieldElement() {
      const id = arrayValue(visualHandle?.selection?.())[0];
      if (!id || !isWorkflowField(nodeById(visualHandle?.getDocument?.(), id))) return null;
      return Array.from(visualHandle?.root?.querySelectorAll?.('[data-node-id]') || []).find((element) => firstText(element.getAttribute('data-node-id')).split('::')[0] === id && element.getAttribute('data-chrome') !== 'true') || null;
    }

    function positionFieldActions() {
      if (!fieldActions || destroyed || visualHandle?.getMode?.() !== 'visual') { if (fieldActions) fieldActions.hidden = true; return; }
      const element = selectedFieldElement();
      if (!element) { fieldActions.hidden = true; return; }
      fieldActions.hidden = false;
      const rect = element.getBoundingClientRect();
      const actionRect = fieldActions.getBoundingClientRect();
      const below = rect.bottom + 8;
      const top = below + actionRect.height <= global.innerHeight - 8 ? below : Math.max(8, rect.top - actionRect.height - 8);
      const left = Math.max(8, Math.min(global.innerWidth - actionRect.width - 8, rect.left + (rect.width - actionRect.width) / 2));
      fieldActions.style.left = `${Math.round(left)}px`;
      fieldActions.style.top = `${Math.round(top)}px`;
    }

    function mountFieldActions() {
      fieldActions = document.createElement('div');
      fieldActions.className = 'fmwfe-field-actions';
      fieldActions.hidden = true;
      fieldActions.setAttribute('role', 'toolbar');
      fieldActions.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("doc-workflow","m_cab8b0b1c9517b","Workflow field actions") ?? "Workflow field actions"));
      fieldActions.innerHTML = `<button type="button" data-fmwfe-action="duplicate" title="${(globalThis.PlatformLanguage?.text("doc-workflow","m_3caa7b4c2c6387","Duplicate below") ?? "Duplicate below")}" aria-label="${(globalThis.PlatformLanguage?.text("doc-workflow","m_3caa7b4c2c6387","Duplicate below") ?? "Duplicate below")}"><i class="fas fa-copy"></i></button><button type="button" data-fmwfe-action="condition" title="${(globalThis.PlatformLanguage?.text("doc-workflow","m_5972d014cecc83","Edit display condition") ?? "Edit display condition")}" aria-label="${(globalThis.PlatformLanguage?.text("doc-workflow","m_5972d014cecc83","Edit display condition") ?? "Edit display condition")}"><i class="fas fa-code-branch"></i></button><button type="button" data-fmwfe-action="settings" title="${(globalThis.PlatformLanguage?.text("doc-workflow","m_6cec3410f41f6d","Field settings") ?? "Field settings")}" aria-label="${(globalThis.PlatformLanguage?.text("doc-workflow","m_6cec3410f41f6d","Field settings") ?? "Field settings")}"><i class="fas fa-sliders"></i></button>`;
      fieldActions.addEventListener('pointerdown', (event) => event.stopPropagation());
      fieldActions.addEventListener('click', (event) => {
        const button = event.target.closest('[data-fmwfe-action]');
        if (!button) return;
        const id = arrayValue(visualHandle?.selection?.())[0];
        if (button.dataset.fmwfeAction === 'duplicate') duplicateWorkflowField(id);
        else openFieldFlow(id, button.dataset.fmwfeAction === 'condition');
      });
      document.body.appendChild(fieldActions);
      requestAnimationFrame(positionFieldActions);
    }

    function applyNodeValue(node, prop, value, source) {
      visualHandle?.apply?.({ type: 'node.set', node_id: node.id, prop, value });
      emitDefinition({ source });
    }

    function choiceRowsHtml(options) {
      return arrayValue(options).map((raw, index) => {
        const option = objectValue(raw);
        return `<div class="fmwfe-choice-row" data-fmwfe-choice="${String(index)}">
          <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_9fd79f4276d659","Label") ?? "Label")}</span><input data-fmwfe-choice-label value="${String(esc(firstText(option.label, option.value, `Option ${index + 1}`)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_25e13201551ca4","Choice label") ?? "Choice label")}"></label>
          <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_bdbba2cffe168c","Output value") ?? "Output value")}</span><input data-fmwfe-choice-value value="${String(esc(firstText(option.value)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_5264d36c59e39d","choice_value") ?? "choice_value")}"></label>
          <button type="button" data-fmwfe-choice-remove title="${(globalThis.PlatformLanguage?.text("doc-workflow","m_ed53c026108fd8","Remove choice") ?? "Remove choice")}" aria-label="${(globalThis.PlatformLanguage?.text("doc-workflow","m_ed53c026108fd8","Remove choice") ?? "Remove choice")}"><i class="fas fa-trash"></i></button>
        </div>`;
      }).join('');
    }

    function inspectorHtml(entity) {
      const { type, step, node } = entity;
      if (type === 'page') return `<div class="fmwfe-inspector"><h4>${(globalThis.PlatformLanguage?.text("doc-workflow","m_1d2e0fe66e5761","Page settings") ?? "Page settings")}</h4>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_29dbd3d8b69f55","Title") ?? "Title")}</span><input data-fmwfe-title value="${String(esc(firstText(step.title)))}"></label>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_785881bc8d1731","Page id") ?? "Page id")}</span><input data-fmwfe-page-id value="${String(esc(firstText(step.id)))}"></label>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_386f0bf7477d03","Show when") ?? "Show when")}</span><input data-fmwfe-when value="${String(esc(firstText(step.when)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_e3158515ef4f1b","{{ params.answer == 'yes' }}") ?? "{{ params.answer == 'yes' }}")}"></label>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_efa5eb7c34d75f","Audience") ?? "Audience")}</span><input data-fmwfe-audience value="${String(esc(arrayValue(step.audience).join(', ')))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_960591e2ed87fb","internal, customer") ?? "internal, customer")}"></label></div>`;
      if (type === 'section') {
        const meta = objectValue(objectValue(node.props).workflow_section);
        return `<div class="fmwfe-inspector"><h4>${(globalThis.PlatformLanguage?.text("doc-workflow","m_956b329890836d","Section flow") ?? "Section flow")}</h4><label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_8cf345002184e5","Name") ?? "Name")}</span><input data-fmwfe-title value="${String(esc(firstText(meta.title, node.name)))}"></label>
          <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_386f0bf7477d03","Show when") ?? "Show when")}</span><input data-fmwfe-when value="${String(esc(firstText(meta.when)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_2975b72b690b92","Optional condition") ?? "Optional condition")}"></label>
          <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_db0640bcb0df97","Entrance") ?? "Entrance")}</span><select data-fmwfe-transition>${String(['grow','fade','slide','none'].map((value) => `<option ${firstText(objectValue(meta.transition).type, 'grow') === value ? 'selected' : ''}>${value}</option>`).join(''))}</select></label></div>`;
      }
      if (type === 'field') {
        const cfg = objectValue(objectValue(node.props).config);
        return `<div class="fmwfe-inspector"><h4>${(globalThis.PlatformLanguage?.text("doc-workflow","m_f424dcdf79099f","Field Settings") ?? "Field Settings")}</h4>
          <div class="fmwfe-inspector-group"><strong>${(globalThis.PlatformLanguage?.text("doc-workflow","m_a20b1dbdbc6449","Field") ?? "Field")}</strong><label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_29dbd3d8b69f55","Title") ?? "Title")}</span><input data-fmwfe-title value="${String(esc(firstText(cfg.label, node.name)))}"></label>
            <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_aa136ecb65672f","Description") ?? "Description")}</span><textarea data-fmwfe-description placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_4c36d4672bb9ed","Helpful context shown below the title") ?? "Helpful context shown below the title")}">${String(esc(firstText(cfg.description)))}</textarea></label>
            <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_8802aaa05aaa4a","Variable type") ?? "Variable type")}</span><select data-fmwfe-kind>${String(kinds.map((kind) => `<option value="${esc(kind.id)}" ${kind.id === cfg.kind ? 'selected' : ''}>${esc(kind.label)}</option>`).join(''))}</select></label>
            <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_0ee9789116b880","Output variable") ?? "Output variable")}</span><input data-fmwfe-writes value="${String(esc(firstText(cfg.writes)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_2cd9214f1f578e","params.field_name") ?? "params.field_name")}"></label>
            <label class="check"><input type="checkbox" data-fmwfe-required ${String(cfg.required ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("doc-workflow","m_2b9a93fc89378f"," Required") ?? " Required")}</label></div>
          ${String(FIELD_PRESENTATIONS.has(cfg.kind) ? `<div class="fmwfe-inspector-group"><strong>Choices</strong><label><span>Layout</span><select data-fmwfe-choice-style>${['tiles','radio','dropdown'].map((value) => `<option ${firstText(cfg.choice_style, 'tiles') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><div class="fmwfe-choice-list">${choiceRowsHtml(cfg.options)}</div><button type="button" class="fmwfe-add-choice" data-fmwfe-choice-add><i class="fas fa-plus"></i> Add choice</button></div>` : '')}
          <div class="fmwfe-inspector-group"><strong>${(globalThis.PlatformLanguage?.text("doc-workflow","m_3525af194bf016","Visibility & motion") ?? "Visibility & motion")}</strong><label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_386f0bf7477d03","Show when") ?? "Show when")}</span><input data-fmwfe-when value="${String(esc(firstText(cfg.when)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_2975b72b690b92","Optional condition") ?? "Optional condition")}"></label>
            <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_db0640bcb0df97","Entrance") ?? "Entrance")}</span><select data-fmwfe-transition>${String(['fade','grow','slide','none'].map((value) => `<option ${firstText(cfg.transition, 'fade') === value ? 'selected' : ''}>${value}</option>`).join(''))}</select></label></div></div>`;
      }
      const visibility = objectValue(objectValue(node.props).workflow_visibility);
      return `<div class="fmwfe-inspector"><h4>${(globalThis.PlatformLanguage?.text("doc-workflow","m_eb6d93dcf4a28a","Element flow") ?? "Element flow")}</h4><div class="fmwfe-muted" style="padding:0">${((v0) => globalThis.PlatformLanguage?.text("doc-workflow","m_ac1207164a103f",`${v0} remains a normal visual element. These settings only control when it enters the workflow.`,{v0}) ?? `${v0} remains a normal visual element. These settings only control when it enters the workflow.`)(esc(firstText(node.name, node.type)))}</div>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_386f0bf7477d03","Show when") ?? "Show when")}</span><input data-fmwfe-when value="${String(esc(firstText(visibility.when)))}" placeholder="${(globalThis.PlatformLanguage?.text("doc-workflow","m_2975b72b690b92","Optional condition") ?? "Optional condition")}"></label>
        <label><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_db0640bcb0df97","Entrance") ?? "Entrance")}</span><select data-fmwfe-transition>${String(['fade','grow','slide','none'].map((value) => `<option ${firstText(visibility.transition, 'fade') === value ? 'selected' : ''}>${value}</option>`).join(''))}</select></label></div>`;
    }

    function renderFlowHost(host) {
      if (!host || destroyed) return;
      const selectedId = arrayValue(visualHandle?.selection?.())[0];
      syncCurrent();
      host.innerHTML = `<div class="fmwfe-flow"><div class="fmwfe-flow-head"><div><strong>${(globalThis.PlatformLanguage?.text("doc-workflow","m_ae23b158b6c400","Flow structure") ?? "Flow structure")}</strong><span>${(globalThis.PlatformLanguage?.text("doc-workflow","m_e4323cd0b4bfd7","Pages, dependencies, and entrance order") ?? "Pages, dependencies, and entrance order")}</span></div><i class="fas fa-diagram-project"></i></div><div class="fmwfe-tree">${String(steps().map((step, pageIndex) => {
        const design = ensureStepDesign(step);
        const sections = arrayValue(objectValue(design.root).children).filter((node) => node.type === 'frame');
        return `<div><button data-fmwfe-page="${esc(step.id)}" class="${step.id === activeStepId && !selectedId ? 'active' : ''}"><i class="fas fa-file"></i><span>${esc(firstText(step.title, `Page ${pageIndex + 1}`))}</span>${step.when ? '<b>IF</b>' : ''}</button>${sections.map((section) => {
          const meta = objectValue(objectValue(section.props).workflow_section);
          const fields = [];
          (function visit(node) { if (node.type === 'widget' && firstText(objectValue(node.props).widget).split('@')[0] === 'doc.workflow_field') fields.push(node); arrayValue(node.children).forEach(visit); })(section);
          return `<div class="section"><button data-fmwfe-node="${esc(section.id)}" data-fmwfe-owner="${esc(step.id)}" class="${selectedId === section.id ? 'active' : ''}"><i class="fas fa-layer-group"></i><span>${esc(firstText(meta.title, section.name, 'Field section'))}</span>${meta.when ? '<b>IF</b>' : ''}</button>${fields.map((field) => { const cfg = objectValue(objectValue(field.props).config); return `<button class="field ${selectedId === field.id ? 'active' : ''}" data-fmwfe-node="${esc(field.id)}" data-fmwfe-owner="${esc(step.id)}"><i class="fas ${cfg.when ? 'fa-code-branch' : 'fa-grip-lines'}"></i><span>${esc(firstText(cfg.label, field.name, 'Field'))}</span><small>${esc(firstText(cfg.writes))}</small></button>`; }).join('')}</div>`;
        }).join('')}</div>`;
      }).join(''))}</div><div data-fmwfe-inspector>${String(inspectorHtml(selectedEntity()))}</div></div>`;
      host.querySelectorAll('[data-fmwfe-page]').forEach((button) => button.addEventListener('click', () => switchStep(button.dataset.fmwfePage)));
      host.querySelectorAll('[data-fmwfe-node]').forEach((button) => button.addEventListener('click', () => {
        const select = () => { visualHandle?.select?.([button.dataset.fmwfeNode]); renderFlowPanels(); };
        if (button.dataset.fmwfeOwner !== activeStepId) { switchStep(button.dataset.fmwfeOwner); requestAnimationFrame(select); } else select();
      }));
      wireInspector(host.querySelector('[data-fmwfe-inspector]'), selectedEntity());
    }

    function wireInspector(host, entity) {
      if (!host) return;
      const { type, step, node } = entity;
      const updatePage = (key, value) => { if (value) step[key] = value; else delete step[key]; emitDefinition({ source: `page.${key}` }); visualHandle?.refreshPages?.(); };
      host.querySelector('[data-fmwfe-title]')?.addEventListener('change', (event) => {
        const value = firstText(event.target.value, type === 'page' ? 'Page' : type === 'section' ? 'Field section' : 'Field');
        if (type === 'page') updatePage('title', value);
        else if (type === 'section') { const meta = { ...objectValue(objectValue(node.props).workflow_section), title: value }; applyNodeValue(node, 'props.workflow_section', meta, 'section.title'); applyNodeValue(node, 'name', value, 'section.title'); }
        else if (type === 'field') { applyNodeValue(node, 'props.config.label', value, 'field.label'); applyNodeValue(node, 'name', value, 'field.label'); }
      });
      host.querySelector('[data-fmwfe-page-id]')?.addEventListener('change', (event) => {
        const value = cleanText(event.target.value); if (!value || steps().some((entry) => entry !== step && entry.id === value)) { event.target.value = step.id; return; }
        step.id = value; activeStepId = value; emitDefinition({ source: 'page.id' }); visualHandle?.refreshPages?.();
      });
      host.querySelector('[data-fmwfe-audience]')?.addEventListener('change', (event) => updatePage('audience', event.target.value.split(',').map(cleanText).filter(Boolean)));
      host.querySelector('[data-fmwfe-kind]')?.addEventListener('change', (event) => applyNodeValue(node, 'props.config.kind', event.target.value, 'field.kind'));
      host.querySelector('[data-fmwfe-description]')?.addEventListener('change', (event) => applyNodeValue(node, 'props.config.description', cleanText(event.target.value), 'field.description'));
      host.querySelector('[data-fmwfe-writes]')?.addEventListener('change', (event) => applyNodeValue(node, 'props.config.writes', cleanText(event.target.value), 'field.writes'));
      host.querySelector('[data-fmwfe-required]')?.addEventListener('change', (event) => applyNodeValue(node, 'props.config.required', event.target.checked, 'field.required'));
      host.querySelector('[data-fmwfe-choice-style]')?.addEventListener('change', (event) => applyNodeValue(node, 'props.config.choice_style', event.target.value, 'field.choice_style'));
      const currentChoices = () => arrayValue(objectValue(objectValue(node).props).config?.options).map((option) => ({ ...objectValue(option) }));
      host.querySelectorAll('[data-fmwfe-choice]').forEach((row) => {
        const index = Number(row.dataset.fmwfeChoice);
        const commit = () => {
          const options = currentChoices();
          const label = cleanText(row.querySelector('[data-fmwfe-choice-label]')?.value);
          const existingValue = cleanText(row.querySelector('[data-fmwfe-choice-value]')?.value);
          options[index] = { ...objectValue(options[index]), label: label || `Option ${index + 1}`, value: existingValue || label.toLowerCase().replace(/[^a-z0-9]+/g, '_') || `option_${index + 1}`, icon: firstText(objectValue(options[index]).icon, 'fa-circle') };
          applyNodeValue(node, 'props.config.options', options, 'field.options');
        };
        row.querySelector('[data-fmwfe-choice-label]')?.addEventListener('change', commit);
        row.querySelector('[data-fmwfe-choice-value]')?.addEventListener('change', commit);
        row.querySelector('[data-fmwfe-choice-remove]')?.addEventListener('click', () => {
          const options = currentChoices();
          options.splice(index, 1);
          applyNodeValue(node, 'props.config.options', options, 'field.options');
        });
      });
      host.querySelector('[data-fmwfe-choice-add]')?.addEventListener('click', () => {
        const options = currentChoices();
        const number = options.length + 1;
        options.push({ value: `option_${number}`, label: ((v0) => globalThis.PlatformLanguage?.text("doc-workflow","m_9f35fbe4f31045",`Option ${v0}`,{v0}) ?? `Option ${v0}`)(number), icon: 'fa-circle' });
        applyNodeValue(node, 'props.config.options', options, 'field.options');
      });
      host.querySelector('[data-fmwfe-when]')?.addEventListener('change', (event) => {
        const value = cleanText(event.target.value);
        if (type === 'page') updatePage('when', value);
        else if (type === 'section') applyNodeValue(node, 'props.workflow_section.when', value, 'section.when');
        else if (type === 'field') applyNodeValue(node, 'props.config.when', value, 'field.when');
        else applyNodeValue(node, 'props.workflow_visibility.when', value, 'element.when');
      });
      host.querySelector('[data-fmwfe-transition]')?.addEventListener('change', (event) => {
        if (type === 'section') applyNodeValue(node, 'props.workflow_section.transition.type', event.target.value, 'section.transition');
        else if (type === 'field') applyNodeValue(node, 'props.config.transition', event.target.value, 'field.transition');
        else applyNodeValue(node, 'props.workflow_visibility.transition', event.target.value, 'element.transition');
      });
    }

    function renderFlowPanels() { flowHosts.forEach(renderFlowHost); }
    function renderPreviewNav(mode) {
      if (!previewNav || destroyed) return;
      const currentMode = firstText(mode, visualHandle?.getMode?.(), 'visual');
      previewNav.hidden = currentMode !== 'preview';
      if (previewNav.hidden) return;
      const index = Math.max(0, steps().findIndex((step) => firstText(step.id) === activeStepId));
      previewNav.innerHTML = `<button type="button" data-fmwfe-prev ${String(index === 0 ? 'disabled' : '')}><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("doc-workflow","m_9c5b830c019950"," Previous") ?? " Previous")}</button><span>${((v1,v2) => globalThis.PlatformLanguage?.text("doc-workflow","m_38042c9b59d2e5",`Page ${v1} of ${v2} · preview answers reset when you return to the builder`,{v1,v2}) ?? `Page ${v1} of ${v2} · preview answers reset when you return to the builder`)(index + 1,steps().length)}</span><button type="button" class="primary" data-fmwfe-next>${String(index === steps().length - 1 ? '<i class="fas fa-check"></i> Submit' : 'Next <i class="fas fa-arrow-right"></i>')}</button>`;
      previewNav.querySelector('[data-fmwfe-prev]')?.addEventListener('click', () => { if (index > 0) switchStep(steps()[index - 1].id); });
      previewNav.querySelector('[data-fmwfe-next]')?.addEventListener('click', () => {
        if (index < steps().length - 1) switchStep(steps()[index + 1].id);
        else if (typeof opts.toast === 'function') opts.toast((globalThis.PlatformLanguage?.text("doc-workflow","m_e0e3ad4a347a83","Preview submitted. No data was saved.") ?? "Preview submitted. No data was saved."), true);
        else global.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("doc-workflow","m_cba194e8b06163","Workflow preview") ?? "Workflow preview"), (globalThis.PlatformLanguage?.text("doc-workflow","m_e0e3ad4a347a83","Preview submitted. No data was saved.") ?? "Preview submitted. No data was saved."), true);
      });
    }
    const flowPanel = { id: 'flow', label: (globalThis.PlatformLanguage?.text("doc-workflow","m_6c20fde3fabebb","Flow") ?? "Flow"), render(host) { flowHosts.add(host); renderFlowHost(host); } };
    const suppliedPanels = arrayValue(opts.sidePanels).filter((panel) => panel && panel.id !== 'flow');
    const chrome = {
      ...objectValue(opts.chrome),
      contentKind: 'workflow',
      designWidthPt: WORKFLOW_WIDTH_PT,
      sectionMaxWidthPx: WORKFLOW_MAX_WIDTH_PX,
      sectionWidthLocked: true,
      pages,
      addSection: true,
      customTabs: [fieldsTab, ...arrayValue(objectValue(opts.chrome).customTabs)]
    };
    const first = activeStep();
    first.design = ensureStepDesign(first);
    visualHandle = global.FMVisualEditor.mount(container, {
      ...opts,
      document: clone(first.design),
      profile: firstText(opts.profile, 'designer'),
      mode: firstText(opts.mode, 'visual'),
      allowedModes: arrayValue(opts.allowedModes).length ? opts.allowedModes : ['visual', 'preview'],
      viewResponsiveDefault: 'manual',
      interactivePreview: true,
      sidePanels: [flowPanel, ...suppliedPanels],
      initialSidePanel: firstText(opts.initialSidePanel, 'flow'),
      elementContextItems(context) {
        const workflowItems = workflowContextItems(context);
        if (typeof opts.elementContextItems !== 'function') return workflowItems;
        try { return workflowItems.concat(arrayValue(opts.elementContextItems(context))); }
        catch (error) { global.console?.error?.('[FMWorkflowEditor] context menu extension failed', error); return workflowItems; }
      },
      chrome,
      onChange(document_, meta) {
        if (destroyed) return;
        syncStepFromDesign(activeStep(), document_);
        emitDefinition({ ...objectValue(meta), source: firstText(objectValue(meta).source, 'visual') });
      }
    });
    visualHandle.on?.('selection', () => { renderFlowPanels(); requestAnimationFrame(positionFieldActions); });
    visualHandle.on?.('change', () => requestAnimationFrame(positionFieldActions));
    visualHandle.on?.('mode', (mode) => { renderFlowPanels(); renderPreviewNav(mode); requestAnimationFrame(positionFieldActions); });
    mountFieldActions();
    visualHandle.root?.addEventListener?.('scroll', positionFieldActions, true);
    global.addEventListener('resize', positionFieldActions);
    const canvasColumn = visualHandle.root?.querySelector?.('.fmwe-ch-canvas-column');
    if (canvasColumn) {
      previewNav = document.createElement('div');
      previewNav.className = 'fmwfe-preview-nav';
      previewNav.hidden = true;
      const bottom = canvasColumn.querySelector('[data-ch-bottom]');
      canvasColumn.insertBefore(previewNav, bottom || null);
    }
    requestAnimationFrame(renderFlowPanels);

    return {
      ...visualHandle,
      editor: visualHandle,
      getDefinition() { syncCurrent(); return clone(definition); },
      setDefinition(nextDefinition, setOptions = {}) {
        definition = clone(objectValue(nextDefinition));
        if (!Array.isArray(definition.steps) || !definition.steps.length) definition.steps = [{ id: 'page_1', title: (globalThis.PlatformLanguage?.text("doc-workflow","m_6bb8069fae869e","Page 1") ?? "Page 1"), audience: ['internal'], sections: [] }];
        const requested = firstText(setOptions.stepId, activeStepId);
        activeStepId = steps().some((step) => step.id === requested) ? requested : firstText(steps()[0].id);
        visualHandle.setDocument(ensureStepDesign(activeStep()), { preserveHistory: false });
        visualHandle.refreshPages?.();
        renderFlowPanels();
        renderPreviewNav();
      },
      activeStepId() { return activeStepId; },
      selectStep: switchStep,
      refreshFlow: renderFlowPanels,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        flowHosts.clear();
        visualHandle?.root?.removeEventListener?.('scroll', positionFieldActions, true);
        global.removeEventListener('resize', positionFieldActions);
        fieldActions?.remove?.();
        fieldActions = null;
        visualHandle?.destroy?.();
        visualHandle = null;
      }
    };
  }

  global.FMWorkflowEditor = {
    version: 1,
    mount,
    createFieldNode,
    createFieldSection,
    blankPageDesign,
    syncStepFromDesign
  };
})(window);
