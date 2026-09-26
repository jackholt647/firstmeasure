/* public/libraries/custom-fields/firstmate-custom-fields.js
 * Branch-scoped custom-field definitions and project/contact value helpers.
 */
(function(){
  const root = window;
  if (root.FirstMateCustomFields?.__initialized) return;

  const MODULE_ID = 'custom_fields';
  const VALUE_KEY = 'custom_field_values';
  const PROJECT_COMPAT_VALUE_KEY = 'custom_fields';
  const CONTACT_VALUE_KEY = 'contact_custom_field_values';
  const caches = new Map();
  const loading = new Map();
  const assignableCaches = new Map();

  const cleanText = (value) => String(value ?? '').trim();
  const projectAssignmentsEnabled = () => {
    const flags = root.Portal?.appFlags || root.PlatformAPI?.appFlags;
    return flags?.value?.('platform', 'project_assignments', true) !== false;
  };
  const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clone = (value) => {
    try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return Array.isArray(value) ? value.slice() : { ...objectValue(value) }; }
  };
  const escapeHtml = (value) => cleanText(value).replace(/[&<>"']/g, (match) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[match]));
  const slug = (value, fallback = 'field') => cleanText(value || fallback)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || fallback;
  const uid = () => `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const TYPE_CATALOG = [
    { value:'text', label:(globalThis.PlatformLanguage?.text("custom-fields","m_e9a41937fd46ec","Short text") ?? "Short text"), dataType:'string', icon:'fa-font', hint:'Names, codes, and short answers' },
    { value:'multiline', label:(globalThis.PlatformLanguage?.text("custom-fields","m_4cea0cfc5349a4","Long text") ?? "Long text"), dataType:'string', icon:'fa-align-left', hint:'Notes and longer descriptions' },
    { value:'email', label:(globalThis.PlatformLanguage?.text("custom-fields","m_2fbb4b11eb7b6f","Email address") ?? "Email address"), dataType:'string', icon:'fa-envelope', hint:'Validated email address' },
    { value:'phone', label:(globalThis.PlatformLanguage?.text("custom-fields","m_7ed66a4e107033","Phone number") ?? "Phone number"), dataType:'string', icon:'fa-phone', hint:'Phone number with a call-friendly input' },
    { value:'url', label:(globalThis.PlatformLanguage?.text("custom-fields","m_98de1ec0d6d171","Web address") ?? "Web address"), dataType:'string', icon:'fa-link', hint:'A website or shared link' },
    { value:'number', label:(globalThis.PlatformLanguage?.text("custom-fields","m_3e7027aa9d65ed","Number") ?? "Number"), dataType:'number', icon:'fa-hashtag', hint:'Amounts and measurements' },
    { value:'integer', label:(globalThis.PlatformLanguage?.text("custom-fields","m_bef35d39862f43","Whole number") ?? "Whole number"), dataType:'number', icon:'fa-hashtag', hint:'A count without fractional values' },
    { value:'object', label:(globalThis.PlatformLanguage?.text("custom-fields","m_6b8036f0a8ff49","Structured dictionary") ?? "Structured dictionary"), dataType:'object', icon:'fa-table-list', hint:'Named subfields with individual types and rules' },
    { value:'array', label:(globalThis.PlatformLanguage?.text("custom-fields","m_57ded27157600a","Structured array") ?? "Structured array"), dataType:'array', icon:'fa-list', hint:'Repeated typed values or records' },
    { value:'currency', label:(globalThis.PlatformLanguage?.text("custom-fields","m_c267b6350b9781","Currency") ?? "Currency"), dataType:'number', icon:'fa-dollar-sign', hint:'Money shown in your selected currency' },
    { value:'percentage', label:(globalThis.PlatformLanguage?.text("custom-fields","m_d47e6db8f73d11","Percentage") ?? "Percentage"), dataType:'number', icon:'fa-percent', hint:'A number displayed as a percent' },
    { value:'slider', label:(globalThis.PlatformLanguage?.text("custom-fields","m_4e136d1d9a48e4","Slider") ?? "Slider"), dataType:'number', icon:'fa-sliders', hint:'Choose a number from a clear range' },
    { value:'date', label:(globalThis.PlatformLanguage?.text("custom-fields","m_2a0b11100c22a4","Date") ?? "Date"), dataType:'date', icon:'fa-calendar-day', hint:'A calendar date' },
    { value:'datetime', label:(globalThis.PlatformLanguage?.text("custom-fields","m_080462873352f2","Date and time") ?? "Date and time"), dataType:'datetime', icon:'fa-clock', hint:'A calendar date with time' },
    { value:'boolean', label:(globalThis.PlatformLanguage?.text("custom-fields","m_07e0b1a0e797b1","Checkbox") ?? "Checkbox"), dataType:'boolean', icon:'fa-square-check', hint:'A simple yes or no checkbox' },
    { value:'toggle', label:(globalThis.PlatformLanguage?.text("custom-fields","m_867842cf82c293","On / off toggle") ?? "On / off toggle"), dataType:'boolean', icon:'fa-toggle-on', hint:'A prominent enabled or disabled switch' },
    { value:'select', label:(globalThis.PlatformLanguage?.text("custom-fields","m_6d81716465f7cf","Dropdown") ?? "Dropdown"), dataType:'string', icon:'fa-caret-down', hint:'Choose one option from a list' },
    { value:'radio', label:(globalThis.PlatformLanguage?.text("custom-fields","m_ec47b303b76d48","Choice cards") ?? "Choice cards"), dataType:'string', icon:'fa-list-check', hint:'Show all choices for quick selection' },
    { value:'multiselect', label:(globalThis.PlatformLanguage?.text("custom-fields","m_1ce8dae577783a","Multiple choice") ?? "Multiple choice"), dataType:'array', icon:'fa-check-double', hint:'Choose several options' },
    { value:'tags', label:(globalThis.PlatformLanguage?.text("custom-fields","m_562d2cd3a48b8f","Tags") ?? "Tags"), dataType:'array', icon:'fa-tags', hint:'Enter a flexible list of labels' },
    { value:'list', label:(globalThis.PlatformLanguage?.text("custom-fields","m_db473980ea71b2","List") ?? "List"), dataType:'array', icon:'fa-list-ul', hint:'One reusable item per line' },
    { value:'key_value', label:(globalThis.PlatformLanguage?.text("custom-fields","m_4b6b1f71964f1c","Key-value list") ?? "Key-value list"), dataType:'object', icon:'fa-table-list', hint:'Store named values such as model and serial number' },
    { value:'json', label:(globalThis.PlatformLanguage?.text("custom-fields","m_09a4af5714d1dd","Advanced JSON") ?? "Advanced JSON"), dataType:'json', icon:'fa-code', hint:'Store any valid JSON value' },
    { value:'organization_user', label:(globalThis.PlatformLanguage?.text("custom-fields","m_9a881bf9de0cda","Organization user") ?? "Organization user"), dataType:'reference', icon:'fa-user', hint:'Choose an eligible person in your organization' },
    { value:'resource_group', label:(globalThis.PlatformLanguage?.text("custom-fields","m_04d80605ab674b","User or crew group") ?? "User or crew group"), dataType:'reference', icon:'fa-people-group', hint:'Choose an eligible crew or other resource group' },
    { value:'organization_connection', label:(globalThis.PlatformLanguage?.text("custom-fields","m_a01a5d5c41786f","External connection") ?? "External connection"), dataType:'reference', icon:'fa-building-user', hint:'Choose an eligible connected organization' },
    { value:'assignable_subject', label:(globalThis.PlatformLanguage?.text("custom-fields","m_3487c754d297d0","Person or group") ?? "Person or group"), dataType:'reference', icon:'fa-user-group', hint:'Choose an eligible person, crew, or connected organization' },
    { value:'formula', label:(globalThis.PlatformLanguage?.text("custom-fields","m_e3bf3ce1400b44","Calculated number") ?? "Calculated number"), dataType:'number', icon:'fa-calculator', hint:'Calculate a value from other numeric fields' }
  ];
  const TYPE_BY_VALUE = new Map(TYPE_CATALOG.map((item) => [item.value, item]));
  const optionValue = (item) => cleanText(typeof item === 'object' ? item.value ?? item.label : item);
  const optionalNumber = (value, positive = false) => {
    if (value == null || cleanText(value) === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && (!positive || number > 0) ? number : null;
  };
  const normalizeOptions = (input) => (Array.isArray(input) ? input : cleanText(input).split(/[\n,]/))
    .map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const value = optionValue(item);
        return value ? { value, label:cleanText(item.label || value), color:cleanText(item.color) } : null;
      }
      const value = cleanText(item);
      return value ? { value, label:value, color:'' } : null;
    }).filter(Boolean);
  const defaultForType = (type) => {
    const dataType = TYPE_BY_VALUE.get(type)?.dataType || 'string';
    if (dataType === 'boolean') return false;
    if (dataType === 'array') return [];
    if (dataType === 'object' || dataType === 'json') return {};
    if (dataType === 'reference') return null;
    return '';
  };
  const coerceDefault = (value, type) => {
    const dataType = TYPE_BY_VALUE.get(type)?.dataType || 'string';
    if (value == null || value === '') return clone(defaultForType(type));
    if (dataType === 'boolean') return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
    if (dataType === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : '';
    }
    if (type === 'array') return Array.isArray(value) ? clone(value) : [];
    if (dataType === 'array') return Array.isArray(value) ? value.map((item) => cleanText(item)).filter(Boolean) : cleanText(value).split(/[\n,]/).map(cleanText).filter(Boolean);
    if (dataType === 'object') return objectValue(value);
    if (dataType === 'json') return clone(value);
    if (dataType === 'reference') {
      if (Array.isArray(value)) return value.map(objectValue).filter((item) => cleanText(item.subject_id || item.id));
      const reference = objectValue(value);
      return cleanText(reference.subject_id || reference.id) ? reference : null;
    }
    return cleanText(value);
  };
  const currentOrgId = () => cleanText(root.__APP?.userOrgId || root.__APP?.orgId || root.Portal?.cfg?.userOrgId);
  const currentBranchId = () => cleanText(root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default') || 'default';
  const cacheKey = (orgId = currentOrgId(), branchId = currentBranchId()) => `${cleanText(orgId)}::${cleanText(branchId) || 'default'}`;

  const normalizePath = (value, fallback = 'field') => cleanText(value || fallback)
    .toLowerCase().split('.')
    .map((segment) => segment.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64))
    .filter(Boolean).slice(0, 12).join('.') || fallback;
  const valueAtPath = (value, path) => normalizePath(path).split('.').reduce((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current) ? current[segment] : undefined
  ), value);
  const setValueAtPath = (value, path, nextValue) => {
    const result = clone(objectValue(value));
    const segments = normalizePath(path).split('.');
    let cursor = result;
    segments.slice(0, -1).forEach((segment) => {
      cursor[segment] = clone(objectValue(cursor[segment]));
      cursor = cursor[segment];
    });
    cursor[segments[segments.length - 1]] = nextValue;
    return result;
  };
  const deepMerge = (left, right) => {
    const result = { ...objectValue(left) };
    Object.entries(objectValue(right)).forEach(([key, value]) => {
      result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
        ? deepMerge(result[key], value)
        : value;
    });
    return result;
  };

  function validFormat(format, value) {
    if (format === 'email') return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (format === 'phone') return /^[+\d\s().-]+$/.test(value) && value.replace(/\D/g,'').length >= 7 && value.replace(/\D/g,'').length <= 15;
    if (format === 'url') { try { return ['http:','https:'].includes(new URL(value).protocol); } catch { return false; } }
    if (format === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    if (format === 'datetime') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) && validFormat('date',value.slice(0,10)) && Number.isFinite(Date.parse(value));
    return false;
  }

  function schemaError(schema, value, path = 'Value', depth = 0) {
    if (depth > 12) return `${path} is nested too deeply.`;
    if (schema === false) return `${path} is not allowed.`;
    const s = objectValue(schema), type = s.type;
    const matches = (t) => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t;
    if (type && !(Array.isArray(type) ? type : [type]).some(matches)) return `${path} must be ${Array.isArray(type) ? type.join(' or ') : type}.`;
    if (s.enum && !s.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return `${path} must be one of the declared choices.`;
    if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) return `${path} must match its fixed value.`;
    if (typeof value === 'number') {
      if (s.minimum != null && value < s.minimum || s.maximum != null && value > s.maximum || s.exclusiveMinimum != null && value <= s.exclusiveMinimum || s.exclusiveMaximum != null && value >= s.exclusiveMaximum) return `${path} is outside its allowed range.`;
      if (s.multipleOf && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-8) return `${path} does not match its step.`;
    }
    if (typeof value === 'string') {
      if (s.minLength != null && [...value].length < s.minLength || s.maxLength != null && [...value].length > s.maxLength) return `${path} has an invalid length.`;
      if (s.format && !validFormat(s.format,value)) return `${path} must be a valid ${s.format}.`;
    }
    if (Array.isArray(value)) {
      if (s.minItems != null && value.length < s.minItems || s.maxItems != null && value.length > s.maxItems) return `${path} has an invalid number of items.`;
      for (let i=0;i<value.length;i++) { const error = schemaError(s.items ?? {},value[i],`${path}[${i+1}]`,depth+1); if (error) return error; }
    } else if (value && typeof value === 'object') {
      if (s.minProperties != null && Object.keys(value).length < s.minProperties || s.maxProperties != null && Object.keys(value).length > s.maxProperties) return `${path} has an invalid number of entries.`;
      for (const key of s.required || []) if (!Object.hasOwn(value,key)) return `${path}.${key} is required.`;
      for (const [key,v] of Object.entries(value)) {
        if (['__proto__','constructor','prototype'].includes(key)) return `${path} contains a reserved key.`;
        const error = schemaError(objectValue(s.properties)[key] ?? s.additionalProperties ?? {},v,`${path}.${key}`,depth+1); if (error) return error;
      }
    }
    return '';
  }

  function structuredHtml(schema, value, disabled = false, depth = 0) {
    if (depth > 12) return `<span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a3a60eac02d6c7","Maximum nesting reached.") ?? "Maximum nesting reached.")}</span>`;
    const s = objectValue(schema), off = disabled ? ' disabled' : '';
    const attrs = `data-cf-node="${escapeHtml(s.type || 'json')}" data-node-schema="${escapeHtml(JSON.stringify(s))}"`;
    if (s.type === 'object' || s.type === 'array') {
      const entries = s.type === 'array' ? (Array.isArray(value) ? value : []).map((v,i) => [String(i),v]) : Object.entries({ ...Object.fromEntries(Object.keys(objectValue(s.properties)).map(k => [k, undefined])), ...objectValue(value) });
      const rows = entries.map(([key,v]) => {
        const fixed = s.type === 'object' && Object.hasOwn(objectValue(s.properties),key);
        const child = s.type === 'array' ? s.items || {} : objectValue(s.properties)[key] || s.additionalProperties || {};
        return `<div data-cf-node-row style="display:grid;gap:6px;padding:8px;border:1px solid #e4e7ec;border-radius:8px">${s.type === 'object' ? `<label>${fixed ? escapeHtml(child.title || key) : 'Key'}<input data-node-key value="${escapeHtml(key)}"${fixed ? ' type="hidden"' : ''}${off}></label>` : `<span>${((v0) => globalThis.PlatformLanguage?.htmlText("custom-fields","m_a2e8a87d54d82e",`Item ${v0}`,{v0}) ?? `Item ${v0}`)(Number(key)+1)}</span>`}${structuredHtml(child,v,disabled,depth+1)}${!fixed && !disabled ? `<button type="button" data-node-remove>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_f643f568915438","Remove") ?? "Remove")}</button>` : ''}</div>`;
      }).join('');
      return `<div ${attrs} style="display:grid;gap:8px">${rows}${!disabled && (s.type === 'array' || s.additionalProperties !== false) ? `<button type="button" data-node-add>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_17807234c6caba","Add entry") ?? "Add entry")}</button>` : ''}</div>`;
    }
    if (s.type === 'boolean') return `<input ${attrs} type="checkbox"${value === true ? ' checked' : ''}${off}>`;
    if (s.enum) return `<select ${attrs}${off}><option value="">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_fe069e3d7b9c51","Select…") ?? "Select…")}</option>${s.enum.map(v => `<option value="${escapeHtml(JSON.stringify(v))}"${JSON.stringify(v) === JSON.stringify(value) ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`;
    if (!s.type || Array.isArray(s.type) || s.type === 'null') return `<textarea ${attrs}${off} placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_be0c75317a1197","JSON value") ?? "JSON value")}">${value === undefined ? '' : escapeHtml(JSON.stringify(value,null,2))}</textarea>`;
    const type = ['number','integer'].includes(s.type) ? 'number' : ({date:'date',datetime:'datetime-local',email:'email',phone:'tel',url:'url'}[s.format] || 'text');
    return `<input ${attrs} type="${type}" step="${s.type === 'integer' ? 1 : s.multipleOf || 'any'}"${s.minimum != null ? ` min="${s.minimum}"` : ''}${s.maximum != null ? ` max="${s.maximum}"` : ''} value="${escapeHtml(value ?? '')}"${off}>`;
  }

  function structuredValue(node) {
    if (!node) return undefined;
    delete node.dataset.nodeInvalid;
    const schema = JSON.parse(node.dataset.nodeSchema || '{}'), type = node.dataset.cfNode;
    if (['object','array'].includes(type)) {
      const rows = [...node.children].filter(child => child.hasAttribute('data-cf-node-row'));
      if (type === 'array') return rows.map(row => structuredValue([...row.children].find(c => c.hasAttribute('data-cf-node'))));
      const entries = rows.map(row => [row.querySelector('[data-node-key]').value,structuredValue([...row.children].find(c => c.hasAttribute('data-cf-node')))]);
      const names = entries.map(([key]) => key);
      if (new Set(names).size !== names.length || names.some(key => !key || ['__proto__','constructor','prototype'].includes(key))) node.dataset.nodeInvalid = 'Dictionary keys must be unique, nonempty, and nonreserved.';
      return Object.fromEntries(entries.filter(([key,v]) => key && v !== undefined));
    }
    if (type === 'boolean') return node.checked;
    if (schema.enum) return node.value ? JSON.parse(node.value) : undefined;
    if (['number','integer'].includes(type)) return node.value === '' ? undefined : Number(node.value);
    if (type === 'json' || type === 'null' || Array.isArray(schema.type)) { try { return node.value.trim() ? JSON.parse(node.value) : undefined; } catch { node.dataset.nodeInvalid = 'Enter a valid JSON value.'; return node.value; } }
    return node.value === '' ? undefined : node.value;
  }

  function wireStructured(container) {
    if (container.dataset.cfStructuredWired) return;
    container.dataset.cfStructuredWired = '1';
    container.addEventListener('click',event => {
      const remove = event.target.closest('[data-node-remove]');
      if (remove) { remove.closest('[data-cf-node-row]').remove(); return; }
      const add = event.target.closest('[data-node-add]'); if (!add) return;
      const parent = add.parentElement, schema = JSON.parse(parent.dataset.nodeSchema), value = structuredValue(parent);
      if (schema.type === 'array') value.push(null);
      else { let key='new_key', n=1; while (Object.hasOwn(value,key)) key=`new_key_${++n}`; value[key]=null; }
      parent.outerHTML = structuredHtml(schema,value);
    });
  }

  async function mountOrganizationValues(container, options) {
    const orgId = options.orgId || currentOrgId(), target = {scope:'organization',organizationId:orgId};
    injectSettingsCss();
    injectEditorCss();
    container.innerHTML = `<div data-cf-org-editor role="status">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_381d3151ab93af","Loading value…") ?? "Loading value…")}</div>`;
    const pane = container.querySelector('[data-cf-org-editor]');
    try {
      const [contractResult,valueResult] = await Promise.all(['contract','values'].map(name => root.PlatformAPI.publication.read(orgId,{provider:'custom-fields-organization',export:name,target})));
      const contract = contractResult.result || contractResult, values = valueResult.result || valueResult;
      if (contract.status !== 'ready' || values.status !== 'ready') throw Error(contract.message || values.message || 'Fields could not be loaded.');
      let revision = contract.value.recordRevision;
      const definitions = contract.value.fields.filter(f => !options.fieldPath || f.path === options.fieldPath).map(f => normalizeDefinition({...f, read_only:f.writable !== true || f.read_only}));
      if (!definitions.length) { pane.innerHTML = `<p class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_18b0668b09a1f2","Save this field to enter its value.") ?? "Save this field to enter its value.")}</p>`; return; }

      await renderEditor(pane,{custom_field_values:values.value},'organization',{...options, location:'all', hideWhenEmpty:false, definitions,onSave:async(next) => {
        const changes = Object.fromEntries(contract.value.fields.filter(f => f.writable && (!options.fieldPath || f.path === options.fieldPath)).map(f => [f.path,valueAtPath(next.custom_field_values,f.path)]).filter(([,v]) => v !== undefined));
        if (!Object.keys(changes).length) return;
        const response = await root.PlatformAPI.publication.invoke(orgId,'custom-fields.organization.write',target,{values:changes,expectedRevision:revision},{idempotencyKey:uid()});
        revision = (response.result || response).value.revision;
      }});
      const heading = pane.querySelector('.fm-cf-panel-head'); if (heading) heading.remove();
      const save = pane.querySelector('[data-fm-cf-save]'); if (save) { save.textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_3fee877037bebf","Save value") ?? "Save value"); save.className = 'cf-btn primary'; if (!contract.value.fields.some(f => f.writable && (!options.fieldPath || f.path === options.fieldPath))) save.hidden = true; }
    } catch(error) { pane.innerHTML = `<p class="cf-help" role="alert">${escapeHtml(error.message)}</p><button type="button" class="cf-btn" data-cf-retry>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ef39ad5e614a24","Try again") ?? "Try again")}</button>`; pane.querySelector('[data-cf-retry]').onclick = () => mountOrganizationValues(container,options); }
  }

  function normalizeDefinition(input = {}, index = 0){
    const source = objectValue(input);
    const entity = ['contact', 'organization'].includes(source.entity) ? source.entity : 'project';
    const requestedType = cleanText(source.type || source.presentation || source.widget);
    const type = TYPE_BY_VALUE.has(requestedType) ? requestedType : 'text';
    const typeInfo = TYPE_BY_VALUE.get(type);
    const label = cleanText(source.label || source.name || `Custom field ${index + 1}`) || `Custom field ${index + 1}`;
    const key = normalizePath(source.path || source.key || label, `field_${index + 1}`);
    const backgroundOnly = source.background_only === true;
    const numeric = typeInfo.dataType === 'number' || typeInfo.dataType === 'boolean';
    const layout = ['half', 'full'].includes(source.layout) ? source.layout : (['object', 'array', 'multiline', 'radio', 'multiselect', 'tags', 'list', 'key_value', 'json'].includes(type) ? 'full' : 'half');
    return {
      id: cleanText(source.id) || uid(),
      key,
      path:key,
      formula_key: `custom_${key.replace(/\./g, '_')}`,
      label,
      description: cleanText(source.description),
      entity,
      type,
      data_type: typeInfo.dataType,
      schema:clone(objectValue(source.schema)),
      private:source.private === true,
      read_permission:cleanText(source.read_permission),
      write_permission:cleanText(source.write_permission),
      required: source.required === true,
      enabled: source.enabled !== false,
      read_only: source.read_only === true || type === 'formula',
      placeholder: cleanText(source.placeholder),
      default_value: coerceDefault(source.default_value, type),
      options: normalizeOptions(source.options),
      formula: cleanText(source.formula),
      formula_available: numeric && (source.formula_available == null ? true : source.formula_available === true),
      layout,
      currency: cleanText(source.currency || 'USD').toUpperCase().slice(0, 3) || 'USD',
      min: optionalNumber(source.min),
      max: optionalNumber(source.max),
      step: optionalNumber(source.step, true),
      min_length: optionalNumber(source.min_length),
      max_length: optionalNumber(source.max_length, true),
      pattern: cleanText(source.pattern),
      cardinality:source.cardinality === 'many' ? 'many' : 'one',
      group_path:cleanText(source.group_path || source.group) ? normalizePath(source.group_path || source.group) : (key.includes('.') ? key.split('.').slice(0, -1).join('.') : ''),
      assignment_policy:objectValue(source.assignment_policy),
      default_from:objectValue(source.default_from),
      ui:objectValue(source.ui),
      sources:(Array.isArray(source.sources) ? source.sources : []).map(objectValue),
      background_only: backgroundOnly,
      show_in_overview: backgroundOnly ? false : source.show_in_overview !== false,
      show_in_scope: entity === 'project' && !backgroundOnly && source.show_in_scope === true,
      scope_mode: source.scope_mode === 'selected' ? 'selected' : 'all',
      scopes: (Array.isArray(source.scopes) ? source.scopes : cleanText(source.scopes).split(','))
        .map((item) => cleanText(item).toLowerCase()).filter(Boolean),
      order: Number.isFinite(Number(source.order)) ? Number(source.order) : index
    };
  }

  function normalizeModule(input = {}){
    const source = objectValue(input);
    const fields = (Array.isArray(source.fields) ? source.fields : [])
      .map(normalizeDefinition)
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    return { version: 3, fields };
  }

  async function load(options = {}){
    const orgId = cleanText(options.orgId || currentOrgId());
    const branchId = cleanText(options.branchId || currentBranchId()) || 'default';
    const key = cacheKey(orgId, branchId);
    if (!options.force && caches.has(key)) return clone(caches.get(key));
    if (!options.force && loading.has(key)) return clone(await loading.get(key));
    const promise = (async () => {
      let settings = normalizeModule({});
      try {
        if (!orgId || !root.PlatformAPI?.branchModules?.get) throw new Error('Custom fields API is unavailable.');
        const result = await root.PlatformAPI.branchModules.get(orgId, branchId, MODULE_ID);
        settings = normalizeModule(result?.module?.data || result?.data || result || {});
        if (branchId !== 'default') {
          const company = await root.PlatformAPI.branchModules.get(orgId, 'default', MODULE_ID).catch(error => { if (Number(error.status) === 404) return {}; throw error; });
          const companyFields = normalizeModule(company?.module?.data || company?.data || {}).fields.filter(f => f.entity === 'organization');
          settings.fields = [...settings.fields.filter(f => f.entity !== 'organization'), ...companyFields];
        }
      } catch (error) {
        if (Number(error?.status || 0) !== 404) throw error;
      }
      caches.set(key, settings);
      root.dispatchEvent(new CustomEvent('fm:custom-fields:definitions-loaded', { detail:{ orgId, branchId, fields:clone(settings.fields) } }));
      return settings;
    })();
    loading.set(key, promise);
    try { return clone(await promise); }
    finally { loading.delete(key); }
  }

  async function saveDefinitions(fields, options = {}){
    const orgId = cleanText(options.orgId || currentOrgId());
    const branchId = cleanText(options.branchId || currentBranchId()) || 'default';
    if (!orgId || !root.PlatformAPI?.branchModules?.save) throw new Error('Custom fields API is unavailable.');
    const settings = normalizeModule({ fields });
    if (branchId !== 'default') {
      const company = await root.PlatformAPI.branchModules.get(orgId, 'default', MODULE_ID).catch(error => { if (Number(error.status) === 404) return {}; throw error; });
      const retained = normalizeModule(company?.module?.data || company?.data || {}).fields.filter(f => f.entity !== 'organization');
      const priorOrg = normalizeModule(company?.module?.data || company?.data || {}).fields.filter(f => f.entity === 'organization');
      const nextOrg = settings.fields.filter(f => f.entity === 'organization');
      if (JSON.stringify(priorOrg) !== JSON.stringify(nextOrg)) await root.PlatformAPI.branchModules.save(orgId, 'default', MODULE_ID, { version:4, fields:[...retained, ...nextOrg] });
    }
    await root.PlatformAPI.branchModules.save(orgId, branchId, MODULE_ID, { ...settings, fields:settings.fields.filter(f => branchId === 'default' || f.entity !== 'organization') }, {
      kind:'branch_custom_fields', source:options.source || 'custom_fields_settings'
    });
    caches.set(cacheKey(orgId, branchId), settings);
    root.dispatchEvent(new CustomEvent('fm:custom-fields:definitions-updated', { detail:{ orgId, branchId, fields:clone(settings.fields) } }));
    return clone(settings);
  }

  function cachedFields(options = {}){
    return clone(caches.get(cacheKey(options.orgId, options.branchId))?.fields || []);
  }

  function projectSchema(entity = {}){
    const schema = objectValue(objectValue(entity).custom_field_schema);
    return {
      version:Number(schema.version || 0),
      groups:(Array.isArray(schema.groups) ? schema.groups : []).map((group, index) => ({
        ...objectValue(group),
        path:normalizePath(group?.path || group?.key || `group_${index + 1}`),
        label:cleanText(group?.label || group?.name || group?.path || group?.key || `Group ${index + 1}`),
        order:Number.isFinite(Number(group?.order)) ? Number(group.order) : index,
        collapsed_by_default:group?.collapsed_by_default !== false
      })),
      fields:(Array.isArray(schema.fields || schema.definitions) ? (schema.fields || schema.definitions) : []).map(normalizeDefinition)
    };
  }

  function definitionsFor(entityType, entity = {}, options = {}){
    const fields = [...(options.definitions || cachedFields(options))].filter(f => f.entity === entityType);
    if (entityType === 'project') fields.push(...projectSchema(entity).fields);
    const byPath = new Map();
    fields.forEach((field, index) => {
      const normalized = normalizeDefinition(field, index);
      const existing = byPath.get(normalized.path);
      byPath.set(normalized.path, existing ? {
        ...existing,
        ...normalized,
        sources:[...(existing.sources || []), ...(normalized.sources || [])]
      } : normalized);
    });
    return [...byPath.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }

  function scopeTokens(entity = {}){
    const values = new Set();
    const add = (value) => {
      const text = cleanText(value).toLowerCase();
      if (text) values.add(text);
    };
    add(entity.project_type);
    add(entity.scope_template_id);
    add(entity.scope_template_key);
    const scopes = [entity.scope, entity.project_scope].map(objectValue);
    scopes.forEach((scope) => {
      add(scope.id); add(scope.key); add(scope.name); add(scope.template_id); add(scope.template_key); add(scope.template_name);
      (Array.isArray(scope.pieces) ? scope.pieces : []).forEach((piece) => {
        add(piece?.id); add(piece?.key); add(piece?.name); add(piece?.template_id); add(piece?.template_key); add(piece?.template_name); add(piece?.scope_template_id); add(piece?.scope_template_name);
      });
      (Array.isArray(scope.root_items) ? scope.root_items : []).forEach((item) => {
        add(item?.id); add(item?.key); add(item?.name); add(item?.scope_template_id); add(item?.scope_template_name);
      });
    });
    return values;
  }

  function appliesTo(definition, entity = {}){
    const def = normalizeDefinition(definition);
    if (!def.enabled) return false;
    if (def.entity !== 'project' || def.scope_mode !== 'selected') return true;
    if (!def.scopes.length) return false;
    const tokens = scopeTokens(entity);
    return def.scopes.some((scope) => tokens.has(scope));
  }

  function rawValues(entity = {}, entityType = 'project'){
    const source = objectValue(entity);
    if (entityType === 'contact') {
      return { ...objectValue(source[CONTACT_VALUE_KEY]), ...objectValue(source[VALUE_KEY]) };
    }
    return { ...objectValue(source[PROJECT_COMPAT_VALUE_KEY]), ...objectValue(source[VALUE_KEY]) };
  }

  function numericValue(value){
    if (value === true) return 1;
    if (value === false || value == null || value === '') return 0;
    const parsed = Number(String(value).replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function evaluateCalculated(definition, entity = {}, definitions = cachedFields(), seen = new Set()){
    const expression = cleanText(definition?.formula);
    if (!expression) return 0;
    const definitionKey = normalizePath(definition?.key);
    if (seen.has(definitionKey)) return 0;
    const nextSeen = new Set(seen).add(definitionKey);
    const values = rawValues(entity, definition?.entity);
    const byKey = new Map(definitions.map((field) => [field.key, field]));
    const replaced = expression.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
      const referenced = byKey.get(normalizePath(key));
      if (referenced?.type === 'formula') return String(evaluateCalculated(referenced, entity, definitions, nextSeen));
      return String(numericValue(valueAtPath(values, normalizePath(key))));
    });
    if (!/^[\d\s.+\-*/()%]+$/.test(replaced)) return 0;
    try {
      const result = Number(new Function(`return Number(${replaced}) || 0;`)());
      return Number.isFinite(result) ? result : 0;
    } catch (_) { return 0; }
  }

  function valueFor(definition, entity = {}, definitions = cachedFields()){
    const def = normalizeDefinition(definition);
    if (def.type === 'formula') return evaluateCalculated(def, entity, definitions);
    const values = rawValues(entity, def.entity);
    return valueAtPath(values, def.path) ?? clone(def.default_value);
  }

  function fieldsFor(entityType, entity = {}, options = {}){
    const location = cleanText(options.location || 'overview');
    return definitionsFor(entityType, entity, options).filter((definition) => {
      if (definition.entity !== entityType || !appliesTo(definition, entity)) return false;
      if (entityType === 'project' && definition.group_path === 'assignments' && !projectAssignmentsEnabled()) return false;
      if (location === 'all') return true;
      if (definition.background_only) return false;
      if (location === 'scope') return definition.show_in_scope === true;
      return definition.show_in_overview !== false;
    });
  }

  function valuesForFormula(entity = {}, options = {}){
    const definitions = definitionsFor('project', entity, options);
    return Object.fromEntries(definitions
      .filter((definition) => definition.entity === 'project' && definition.formula_available && appliesTo(definition, entity))
      .map((definition) => [definition.formula_key, numericValue(valueFor(definition, entity, definitions))]));
  }

  function formulaFields(options = {}){
    return cachedFields(options)
      .filter((definition) => definition.entity === 'project' && definition.formula_available && definition.enabled)
      .map((definition) => ({ key:definition.formula_key, label:definition.label, customFieldId:definition.id, customFieldKey:definition.key }));
  }

  function formatValue(definition, value){
    if (value == null || value === '') return 'Not set';
    const def = normalizeDefinition(definition);
    if (def.data_type === 'reference') {
      const references = (Array.isArray(value) ? value : [value]).map(objectValue);
      const knownSubjects = [...assignableCaches.values()].flat();
      const labels = references.map((reference) => {
        const subjectType = cleanText(reference.subject_type);
        const subjectId = cleanText(reference.subject_id || reference.id);
        const subject = knownSubjects.find((candidate) => cleanText(candidate.subject_type) === subjectType && cleanText(candidate.id || candidate.resource_id) === subjectId);
        return cleanText(reference.name || reference.label || reference.subject_name || subject?.name || subject?.label || subject?.email || subjectId);
      }).filter(Boolean);
      return labels.length ? labels.join(', ') : 'Not set';
    }
    if (def.data_type === 'boolean') return value === true || value === 1 || value === '1' ? 'Yes' : 'No';
    if (def.type === 'currency') return new Intl.NumberFormat(undefined, { style:'currency', currency:def.currency || 'USD', maximumFractionDigits:2 }).format(numericValue(value));
    if (def.type === 'percentage') return `${numericValue(value).toLocaleString(undefined, { maximumFractionDigits:2 })}%`;
    if (def.data_type === 'number') return numericValue(value).toLocaleString(undefined, { maximumFractionDigits:4 });
    if (definition.type === 'date') {
      const date = new Date(`${value}T00:00:00`);
      return Number.isFinite(date.getTime()) ? date.toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.()) : cleanText(value);
    }
    if (definition.type === 'datetime') {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()) : cleanText(value);
    }
    if (Array.isArray(value)) return value.length ? value.map(cleanText).filter(Boolean).join(', ') : 'Not set';
    if (value && typeof value === 'object') {
      if (definition.type === 'key_value') {
        const pairs = Object.entries(value).filter(([, item]) => item != null && item !== '');
        return pairs.length ? pairs.map(([key, item]) => `${key}: ${cleanText(item)}`).join(' · ') : 'Not set';
      }
      try { return JSON.stringify(value); } catch (_) { return 'Not set'; }
    }
    const option = def.options.find((item) => item.value === cleanText(value));
    return option?.label || cleanText(value) || 'Not set';
  }

  function injectEditorCss(){
    if (document.getElementById('fm-custom-fields-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-custom-fields-css';
    style.textContent = `
      .fm-cf-panel{border-top:1px solid rgba(15,23,42,.08);padding:14px 15px;display:grid;gap:12px;background:#fff}
      .fm-cf-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fm-cf-panel-head strong{font-size:13px;font-weight:1000;color:#101828}.fm-cf-panel-head span{display:block;margin-top:3px;font-size:11px;font-weight:800;color:#667085}
      .fm-cf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fm-cf-field{display:grid;gap:5px;min-width:0}.fm-cf-field.wide,.fm-cf-field[data-layout="full"]{grid-column:1/-1}.fm-cf-field>label{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}.fm-cf-field>label em{color:#b42318;font-style:normal}
      .fm-cf-input{width:100%;min-width:0;box-sizing:border-box;border:1px solid rgba(15,23,42,.13);border-radius:9px;background:#fff;min-height:38px;padding:8px 10px;font-family:inherit;font-size:13px;font-weight:400;line-height:1.4;color:#101828;outline:none}.fm-cf-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.5);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}textarea.fm-cf-input{min-height:70px;resize:vertical}.fm-cf-check{display:flex;align-items:center;gap:8px;min-height:38px;font-size:12px;font-weight:850;color:#344054}.fm-cf-formula{min-height:38px;border:1px solid #e4e7ec;border-radius:9px;background:#f8fafc;padding:9px 10px;font-size:12px;font-weight:950;color:#344054}
      .fm-cf-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;border:1px solid #e4e7ec;border-radius:10px;padding:7px 9px;font-size:12px;font-weight:900;color:#344054}.fm-cf-switch{position:relative;width:38px;height:22px;flex:0 0 auto}.fm-cf-switch input{position:absolute;opacity:0}.fm-cf-switch span{position:absolute;inset:0;border-radius:999px;background:#d0d5dd;transition:.18s}.fm-cf-switch span:after{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #10182833;transition:.18s}.fm-cf-switch input:checked+span{background:var(--primary,#d93025)}.fm-cf-switch input:checked+span:after{transform:translateX(16px)}
      .fm-cf-options{display:flex;flex-wrap:wrap;gap:7px}.fm-cf-choice{position:relative}.fm-cf-choice input{position:absolute;opacity:0;pointer-events:none}.fm-cf-choice span{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:9px;padding:8px 10px;background:#fff;color:#475467;font-size:11px;font-weight:900;cursor:pointer}.fm-cf-choice input:checked+span{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary,#d93025);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.08)}
      .fm-cf-kv{display:grid;gap:7px}.fm-cf-kv-row{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr) 30px;gap:6px}.fm-cf-kv-remove,.fm-cf-kv-add{border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;cursor:pointer}.fm-cf-kv-add{justify-self:start;min-height:32px;padding:0 10px;font-size:10px;font-weight:950}.fm-cf-invalid{border-color:#f04438!important;box-shadow:0 0 0 3px rgba(240,68,56,.08)!important}.fm-cf-error{font-size:10px;font-weight:850;color:#b42318}
      .fm-cf-field{align-content:start}[data-cf-node] input,[data-cf-node] select,[data-cf-node] textarea{box-sizing:border-box;width:100%;min-height:34px;border:1px solid #d0d5dd;border-radius:6px;padding:6px;font:inherit}[data-cf-node] input[type=checkbox]{width:auto;min-height:0}[data-node-add],[data-node-remove]{border:1px solid #d0d5dd;border-radius:6px;background:#f8fafc;padding:6px 10px;cursor:pointer;font:inherit}.fm-cf-save{justify-self:start;border:0;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);min-height:36px;padding:0 13px;font-size:11px;font-weight:1000;cursor:pointer}.fm-cf-save:disabled{opacity:.6}.fm-cf-status{font-size:11px;font-weight:850;color:#667085}
      .fm-cf-empty{font-size:12px;font-weight:850;color:#98a2b3}.fm-contact-left .fm-cf-panel{padding:0;border-top:0}.fm-contact-left .fm-cf-grid{grid-template-columns:1fr}.fm-contact-left .fm-cf-panel-head span{display:none}
      .fm-cf-flat{display:contents}.fm-cf-flat .fm-cf-field.wide{grid-column:auto}
      #fmContactCustomFields{display:contents}
      #rProjectCustomFields{display:grid;gap:7px;margin-top:3px}
      #rProjectCustomFields:empty{display:none}
      #rProjectCustomFields .r-group{gap:4px}
      #rProjectCustomFields .r-group>label{display:block;font-size:10px;font-weight:1000;color:#667085;letter-spacing:.04em;text-transform:uppercase}
      #rProjectCustomFields .r-inp{min-height:30px;padding:5px 7px;font-size:12px}
      #rProjectCustomFields textarea.r-inp{min-height:58px;resize:vertical}
      .fm-cf-group{border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#fff;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.03)}.fm-cf-group>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;min-height:38px;box-sizing:border-box;padding:9px 11px;color:#344054;font-size:11px;font-weight:1000;outline:none;transition:background .15s ease,box-shadow .15s ease}.fm-cf-group>summary:hover{background:#f8fafc}.fm-cf-group>summary:focus-visible{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.28)}.fm-cf-group>summary::-webkit-details-marker{display:none}.fm-cf-group[open]>summary{border-bottom:1px solid rgba(15,23,42,.07);background:#fbfcfd}.fm-cf-group-title{min-width:0;overflow:hidden;text-overflow:ellipsis}.fm-cf-group-chevron{margin-left:auto;color:#7b8797;font-size:9px!important;transition:transform .16s ease}.fm-cf-group[open]>summary .fm-cf-group-chevron{transform:rotate(180deg)}.fm-cf-group-fields{padding:12px;display:grid;gap:12px;background:#fff}.fm-cf-group-fields>.fm-cf-field,.fm-cf-group-fields>.r-group{gap:6px!important}.fm-cf-label{display:flex!important;align-items:center;gap:6px;margin:0!important}.fm-cf-help-tip{display:inline-grid;place-items:center;width:16px;height:16px;flex:0 0 auto;border-radius:999px;color:#7b8797;font-size:9px;cursor:help;outline:none}.fm-cf-help-tip:hover,.fm-cf-help-tip:focus-visible{background:#eef2f6;color:#344054}.fm-cf-source-tip{margin-left:1px}.fm-cf-select-wrap{position:relative;display:block}.fm-cf-select-wrap>select{appearance:none;padding-right:32px!important;cursor:pointer}.fm-cf-select-chevron{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:#667085;font-size:9px}.fm-cf-input[multiple]{min-height:88px;padding:4px}.fm-cf-input[multiple] option{padding:5px 6px;border-radius:5px}
      @media(max-width:700px){.fm-cf-grid{grid-template-columns:1fr}.fm-cf-field.wide,.fm-cf-field[data-layout="full"]{grid-column:auto}.fm-cf-kv-row{grid-template-columns:1fr 1fr 30px}}
    `;
    document.head.appendChild(style);
  }

  function inputHtml(definition, value, options = {}){
    const inputClass = cleanText(options.inputClass) || 'fm-cf-input';
    const def = normalizeDefinition(definition);
    const bounds = `${def.type === 'integer' && def.step == null ? ' step="1"' : ''}${def.min != null ? ` min="${def.min}"` : ''}${def.max != null ? ` max="${def.max}"` : ''}${def.step != null ? ` step="${def.step}"` : ''}`;
    const textBounds = `${def.min_length != null ? ` minlength="${def.min_length}"` : ''}${def.max_length != null ? ` maxlength="${def.max_length}"` : ''}${def.pattern ? ` pattern="${escapeHtml(def.pattern)}"` : ''}`;
    const placeholder = def.placeholder ? ` placeholder="${escapeHtml(def.placeholder)}"` : '';
    const attrs = `class="${escapeHtml(inputClass)}" data-fm-cf-input="${escapeHtml(def.key)}" data-fm-cf-type="${escapeHtml(def.type)}"${placeholder}${def.read_only ? ' disabled' : ''}`;
    if (['object', 'array'].includes(def.type)) return `<div ${attrs} data-cf-schema="${escapeHtml(JSON.stringify({ ...def.schema, type:def.type }))}">${structuredHtml({ ...def.schema, type:def.type }, value, def.read_only)}</div>`;
    if (def.type === 'formula') return `<div class="fm-cf-formula" data-fm-cf-calculated="${escapeHtml(def.key)}">${escapeHtml(formatValue(def, value))}</div>`;
    if (def.data_type === 'reference') {
      const selected = new Set((Array.isArray(value) ? value : [value]).map(objectValue)
        .map((reference) => `${cleanText(reference.subject_type)}:${cleanText(reference.subject_id || reference.id)}`));
      const subjects = Array.isArray(def.assignable_subjects) ? def.assignable_subjects : [];
      const subjectOptions = subjects.map((subject) => {
        const subjectType = cleanText(subject.subject_type);
        const subjectId = cleanText(subject.id || subject.resource_id);
        const optionValue = `${subjectType}:${subjectId}`;
        const typeLabel = subjectType === 'resource_group' ? 'Group' : subjectType === 'organization_connection' ? 'Connection' : 'Person';
        return `<option value="${escapeHtml(optionValue)}"${selected.has(optionValue) ? ' selected' : ''}>${escapeHtml(subject.name || subject.label || subject.email || subjectId)} · ${typeLabel}</option>`;
      }).join('');
      const select = `<select ${attrs}${def.cardinality === 'many' ? ' multiple size="4"' : ''}><option value="">${subjects.length ? 'Select…' : 'No eligible assignees'}</option>${subjectOptions}</select>`;
      return def.cardinality === 'many' ? select : `<span class="fm-cf-select-wrap">${select}<i class="fas fa-chevron-down fm-cf-select-chevron" aria-hidden="true"></i></span>`;
    }
    if (def.type === 'boolean') return `<label class="fm-cf-check"><input type="checkbox" data-fm-cf-input="${escapeHtml(def.key)}" data-fm-cf-type="boolean"${value === true || value === 1 || value === '1' ? ' checked' : ''}${def.read_only ? ' disabled' : ''}> <span>${escapeHtml(def.placeholder || (globalThis.PlatformLanguage?.text("custom-fields","m_549ccd0e27a3d4","Yes") ?? "Yes"))}</span></label>`;
    if (def.type === 'toggle') return `<label class="fm-cf-toggle"><span>${escapeHtml(def.placeholder || (globalThis.PlatformLanguage?.text("custom-fields","m_f2c77321e731f4","Off / On") ?? "Off / On"))}</span><span class="fm-cf-switch"><input type="checkbox" data-fm-cf-input="${escapeHtml(def.key)}" data-fm-cf-type="toggle"${value === true || value === 1 || value === '1' ? ' checked' : ''}${def.read_only ? ' disabled' : ''}><span></span></span></label>`;
    if (def.type === 'select') return `<span class="fm-cf-select-wrap"><select ${String(attrs)}><option value="">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_fe069e3d7b9c51","Select…") ?? "Select…")}</option>${String(def.options.map((option) => `<option value="${escapeHtml(option.value)}"${cleanText(value) === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join(''))}</select><i class="fas fa-chevron-down fm-cf-select-chevron" aria-hidden="true"></i></span>`;
    if (def.type === 'radio') return `<div class="fm-cf-options">${def.options.map((option) => `<label class="fm-cf-choice"><input type="radio" name="fm_cf_${escapeHtml(def.id)}" value="${escapeHtml(option.value)}" data-fm-cf-input="${escapeHtml(def.key)}" data-fm-cf-type="radio"${cleanText(value) === option.value ? ' checked' : ''}${def.read_only ? ' disabled' : ''}><span>${escapeHtml(option.label)}</span></label>`).join('')}</div>`;
    if (def.type === 'multiselect') {
      const selected = new Set(Array.isArray(value) ? value.map(cleanText) : []);
      return `<div class="fm-cf-options">${def.options.map((option) => `<label class="fm-cf-choice"><input type="checkbox" value="${escapeHtml(option.value)}" data-fm-cf-input="${escapeHtml(def.key)}" data-fm-cf-type="multiselect"${selected.has(option.value) ? ' checked' : ''}${def.read_only ? ' disabled' : ''}><span>${escapeHtml(option.label)}</span></label>`).join('')}</div>`;
    }
    if (def.type === 'multiline') return `<textarea ${attrs}${textBounds}>${escapeHtml(value)}</textarea>`;
    if (['tags', 'list'].includes(def.type)) return `<textarea ${attrs}>${escapeHtml((Array.isArray(value) ? value : []).join(def.type === 'tags' ? ', ' : '\n'))}</textarea>`;
    if (def.type === 'key_value') {
      const entries = Object.entries(objectValue(value));
      const rows = (entries.length ? entries : [['', '']]).map(([key, item]) => `<div class="fm-cf-kv-row"><input class="${String(escapeHtml(inputClass))}" data-fm-cf-kv-key value="${String(escapeHtml(key))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_8cf345002184e5","Name") ?? "Name")}"><input class="${String(escapeHtml(inputClass))}" data-fm-cf-kv-value value="${String(escapeHtml(typeof item === 'object' ? JSON.stringify(item) : item))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ec6b76d100b0ec","Value") ?? "Value")}"><button type="button" class="fm-cf-kv-remove" data-fm-cf-kv-remove aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a916bae1ac393b","Remove row") ?? "Remove row")}"><i class="fas fa-xmark"></i></button></div>`).join('');
      return `<div class="fm-cf-kv" data-fm-cf-input="${String(escapeHtml(def.key))}" data-fm-cf-type="key_value">${String(rows)}<button type="button" class="fm-cf-kv-add" data-fm-cf-kv-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_8e13db264d4c9f"," Add row") ?? " Add row")}</button></div>`;
    }
    if (def.type === 'json') {
      let json = ''; try { json = JSON.stringify(value, null, 2); } catch (_) {}
      return `<textarea ${attrs} spellcheck="false">${escapeHtml(json)}</textarea>`;
    }
    const htmlType = def.type === 'date' ? 'date' : def.type === 'datetime' ? 'datetime-local' : ['integer', 'number', 'currency', 'percentage', 'slider'].includes(def.type) ? (def.type === 'slider' ? 'range' : 'number') : ['email', 'url'].includes(def.type) ? def.type : def.type === 'phone' ? 'tel' : 'text';
    return `<input type="${htmlType}" ${attrs}${['integer', 'number', 'currency', 'percentage', 'slider'].includes(def.type) ? (bounds || ' step="any"') : textBounds} value="${escapeHtml(value)}">`;
  }

  function editorValues(container, entity = {}, entityType = 'project'){
    const values = rawValues(entity, entityType);
    const processed = new Set();
    container?.querySelectorAll?.('[data-fm-cf-input]').forEach((input) => {
      if (input.disabled || input.hasAttribute?.('disabled')) return;
      const key = normalizePath(input.dataset.fmCfInput);
      const type = input.dataset.fmCfType || 'text';
      if (!key || (processed.has(`${key}:${type}`) && !['radio', 'multiselect'].includes(type))) return;
      processed.add(`${key}:${type}`);
      let nextValue;
      if (['object', 'array'].includes(type)) nextValue = structuredValue(input.firstElementChild);
      else if (['boolean', 'toggle'].includes(type)) nextValue = !!input.checked;
      else if (['integer', 'number', 'currency', 'percentage', 'slider'].includes(type)) nextValue = input.value === '' ? '' : Number(input.value);
      else if (type === 'radio') nextValue = container.querySelector(`[data-fm-cf-input="${CSS.escape(key)}"][data-fm-cf-type="radio"]:checked`)?.value || '';
      else if (type === 'multiselect') nextValue = [...container.querySelectorAll(`[data-fm-cf-input="${CSS.escape(key)}"][data-fm-cf-type="multiselect"]:checked`)].map((item) => item.value);
      else if (type === 'tags') nextValue = input.value.split(',').map(cleanText).filter(Boolean);
      else if (type === 'list') nextValue = input.value.split('\n').map(cleanText).filter(Boolean);
      else if (type === 'key_value') nextValue = Object.fromEntries([...input.querySelectorAll('.fm-cf-kv-row')].map((row) => [cleanText(row.querySelector('[data-fm-cf-kv-key]')?.value), cleanText(row.querySelector('[data-fm-cf-kv-value]')?.value)]).filter(([name]) => name));
      else if (type === 'json') {
        try { nextValue = input.value.trim() ? JSON.parse(input.value) : null; input.dataset.jsonInvalid = 'false'; } catch (_) { nextValue = input.value; input.dataset.jsonInvalid = 'true'; }
      } else if (['organization_user', 'resource_group', 'organization_connection', 'assignable_subject'].includes(type)) {
        const selectedOptions = input.multiple ? [...input.selectedOptions].map((option) => option.value).filter(Boolean) : [input.value].filter(Boolean);
        const references = selectedOptions.map((identity) => {
          const separator = identity.indexOf(':');
          const subjectType = identity.slice(0, separator);
          const subjectId = identity.slice(separator + 1);
          const option = [...input.options].find((candidate) => candidate.value === identity);
          return { subject_type:subjectType, subject_id:subjectId, name:cleanText(option?.textContent?.split(' · ')[0]) };
        });
        nextValue = input.multiple ? references : (references[0] || null);
      } else nextValue = input.value;
      Object.assign(values, setValueAtPath(values, key, nextValue));
    });
    return values;
  }

  function applyValues(entity = {}, entityType = 'project', values = {}){

    let merged = deepMerge(rawValues(entity, entityType), values);
    for (const field of definitionsFor(entityType,entity)) { const value = valueAtPath(values,field.path); if (value !== undefined) merged = setValueAtPath(merged,field.path,value); }
    return { ...entity, [VALUE_KEY]:merged, [entityType === 'contact' ? CONTACT_VALUE_KEY : PROJECT_COMPAT_VALUE_KEY]:{ ...merged } };
  }

  function emptyValue(value){
    return value == null || value === '' || (Array.isArray(value) && !value.length) || (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  }

  function validateEditor(container, entity = {}, entityType = 'project', definitions = null){
    if (!container) return { valid:true, values:rawValues(entity, entityType), errors:[] };
    container.querySelectorAll('.fm-cf-invalid').forEach((element) => element.classList.remove('fm-cf-invalid'));
    container.querySelectorAll('[data-fm-cf-error]').forEach((element) => element.remove());
    const fields = definitions || fieldsFor(entityType, entity, { location:'overview' });
    const values = editorValues(container, entity, entityType);
    const errors = [];
    fields.forEach((definition) => {
      if (definition.type === 'formula' || definition.read_only) return;
      const value = valueAtPath(values, definition.path);
      let message = '';
      const structuredError = container.querySelector(`[data-fm-cf-input="${CSS.escape(definition.key)}"] [data-node-invalid]`);
      if (structuredError) message = structuredError.dataset.nodeInvalid;
      if (!message && ['object', 'array', 'json'].includes(definition.type)) message = schemaError({ ...definition.schema, ...(definition.type !== 'json' ? {type:definition.type} : {}) }, value);
      if (!message && definition.required && (value == null || value === '')) message = `${definition.label} is required.`;
      else if (definition.type === 'json' && container.querySelector(`[data-fm-cf-input="${CSS.escape(definition.key)}"]`)?.dataset.jsonInvalid === 'true') message = `${definition.label} must be valid JSON.`;
      else if (definition.data_type === 'number' && value !== '') {
        if (definition.type === 'integer' && !Number.isInteger(value)) message = `${definition.label} must be a whole number.`;
        else if (!Number.isFinite(Number(value))) message = `${definition.label} must be a number.`;
        else if (definition.min != null && Number(value) < definition.min) message = `${definition.label} must be at least ${definition.min}.`;
        else if (definition.max != null && Number(value) > definition.max) message = `${definition.label} must be no more than ${definition.max}.`;
      } else if (typeof value === 'string' && value) {
        if (definition.min_length != null && value.length < definition.min_length) message = `${definition.label} is too short.`;
        else if (definition.max_length != null && value.length > definition.max_length) message = `${definition.label} is too long.`;
        else if (definition.pattern) {
          try { if (!new RegExp(definition.pattern).test(value)) message = `${definition.label} does not match the expected format.`; } catch (_) {}
        }
      }
      if (!message && value != null && value !== '') message = schemaError(definition.schema,value,definition.label);
      if (!message && typeof value === 'string' && value && ['date','datetime','email','phone','url'].includes(definition.type) && !validFormat(definition.type,value)) message = `${definition.label} must be a valid ${definition.type}.`;
      if (!message) { const native = container.querySelector(`[data-fm-cf-input="${CSS.escape(definition.key)}"]`); if (native?.validity && !native.validity.valid) message = native.validationMessage; }
      if (!message) return;
      errors.push({ key:definition.key, message });
      const input = container.querySelector(`[data-fm-cf-input="${CSS.escape(definition.key)}"]`);
      input?.classList?.add('fm-cf-invalid');
      const field = input?.closest?.('.fm-cf-field,.r-group,.fm-contact-field');
      field?.insertAdjacentHTML?.('beforeend', `<span class="fm-cf-error" data-fm-cf-error>${escapeHtml(message)}</span>`);
    });
    return { valid:errors.length === 0, values, errors, first:errors[0] || null };
  }

  function assignmentPolicyForDefinition(definition){
    const def = normalizeDefinition(definition);
    if (Object.keys(def.assignment_policy).length) return def.assignment_policy;
    const subjectTypes = def.type === 'assignable_subject'
      ? ['organization_user', 'resource_group', 'organization_connection']
      : [def.type];
    return { allow_unassigned:def.required !== true, rules:[{ subject_types:subjectTypes }] };
  }

  async function hydrateAssignableDefinitions(definitions, options = {}){
    const references = definitions.filter((definition) => definition.data_type === 'reference');
    if (!references.length) return definitions;
    const orgId = cleanText(options.orgId || currentOrgId());
    const branchId = cleanText(options.branchId || currentBranchId()) || 'default';
    await Promise.all(references.map(async (definition) => {
      const policy = assignmentPolicyForDefinition(definition);
      const key = `${orgId}:${branchId}:${JSON.stringify(policy)}`;
      let subjects = assignableCaches.get(key);
      if (!subjects && root.PlatformAPI?.workforce?.resolveAssignableSubjects && orgId) {
        const result = await root.PlatformAPI.workforce.resolveAssignableSubjects(orgId, branchId, policy, {
          scope_template_id:cleanText(definition.sources?.[0]?.scope_template_id)
        }).catch(() => ({ subjects:[] }));
        subjects = Array.isArray(result?.subjects) ? result.subjects : [];
        assignableCaches.set(key, subjects);
      }
      definition.assignable_subjects = clone(subjects || []);
    }));
    return definitions;
  }

  async function renderEditor(container, entity = {}, entityType = 'project', options = {}){
    if (!container) return null;
    injectEditorCss();
    const location = cleanText(options.location || 'overview');
    if (!caches.has(cacheKey(options.orgId, options.branchId))) {
      container.innerHTML = options.flat === true ? '' : `<div class="fm-cf-panel"><div class="fm-cf-empty">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_b7b7212c084051","Loading custom fields…") ?? "Loading custom fields…")}</div></div>`;
      await load(options).catch((error) => {
        container.innerHTML = options.flat === true ? '' : `<div class="fm-cf-panel"><div class="fm-cf-empty">${escapeHtml(error?.message || 'Custom fields are unavailable.')}</div></div>`;
      });
    }
    const definitions = fieldsFor(entityType, entity, { ...options, location });
    await hydrateAssignableDefinitions(definitions, options);
    if (!definitions.length) {
      container.innerHTML = options.hideWhenEmpty === false ? `<div class="fm-cf-panel"><div class="fm-cf-empty">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a1bfa740917210","No custom fields apply here.") ?? "No custom fields apply here.")}</div></div>` : '';
      return { entity, definitions:[] };
    }
    const values = rawValues(entity, entityType);
    const fieldHtml = (definition) => {
      const value = valueFor(definition, entity, definitions);
      const fieldClass = cleanText(options.fieldClass) || 'fm-cf-field';
      const description = cleanText(definition.description);
      const help = description ? `<span class="fm-cf-help-tip" tabindex="0" role="img" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("custom-fields","m_05919cc51cd244",`About ${v0}`,{v0}) ?? `About ${v0}`)(escapeHtml(definition.label))}" data-fm-tooltip="${String(escapeHtml(description))}"><i class="fas fa-circle-info" aria-hidden="true"></i></span>` : '';
      return `<div class="${escapeHtml(fieldClass)}${definition.layout === 'full' ? ' wide' : ''}" data-layout="${escapeHtml(definition.layout)}" data-custom-field-path="${escapeHtml(definition.path)}"><label class="fm-cf-label"><span>${escapeHtml(definition.label)}${definition.required ? ' <em>*</em>' : ''}</span>${help}</label>${inputHtml(definition, value, options)}</div>`;
    };
    const schema = projectSchema(entity);
    const groupedPaths = new Set(definitions.map((definition) => definition.group_path).filter(Boolean));
    const groups = schema.groups.filter((group) => groupedPaths.has(group.path));
    groupedPaths.forEach((path) => {
      if (!groups.some((group) => group.path === path)) groups.push({ path, label:path.split('.').pop().replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), collapsed_by_default:true, order:0 });
    });
    const groupedFields = new Set();
    const groupHtml = groups.sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((group) => {
      const children = definitions.filter((definition) => definition.group_path === group.path);
      children.forEach((definition) => groupedFields.add(definition.path));
      const sourceTip = group.sources?.length ? `<span class="fm-cf-help-tip fm-cf-source-tip" tabindex="0" role="img" aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_c580f7786ef337","Scope-provided fields") ?? "Scope-provided fields")}" data-fm-tooltip="These fields are provided by the active project scope."><i class="fas fa-circle-info" aria-hidden="true"></i></span>` : '';
      return `<details class="fm-cf-group" data-custom-field-group="${escapeHtml(group.path)}"${group.collapsed_by_default === false ? ' open' : ''}><summary>${group.icon ? `<i class="fas ${escapeHtml(group.icon)}"></i>` : '<i class="fas fa-user-group"></i>'}<span class="fm-cf-group-title">${escapeHtml(group.label)}</span>${sourceTip}<i class="fas fa-chevron-down fm-cf-group-chevron" aria-hidden="true"></i></summary><div class="fm-cf-group-fields">${children.map(fieldHtml).join('')}</div></details>`;
    }).join('');
    const fieldsHtml = definitions.filter((definition) => !groupedFields.has(definition.path)).map(fieldHtml).join('');
    container.innerHTML = options.flat === true ? `<div class="fm-cf-flat">${groupHtml}${fieldsHtml}</div>` : `<section class="fm-cf-panel">
      <div class="fm-cf-panel-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_2d1233007f5250","Custom fields") ?? "Custom fields")}</strong><span>${String(entityType === 'organization' ? 'Organization-wide information' : entityType === 'contact' ? 'Contact-specific information' : 'Project-specific information and formula variables')}</span></div></div>
      <div class="fm-cf-grid">${String(groupHtml)}${String(fieldsHtml)}</div>
      ${String(options.showSave === false ? '' : `<div><button type="button" class="fm-cf-save" data-fm-cf-save>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_afe31578587330","Save custom fields") ?? "Save custom fields")}</button> <span class="fm-cf-status" data-fm-cf-status></span></div>`)}
    </section>`;
    container.querySelectorAll('.fm-cf-help-tip').forEach((tip) => tip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }));
    container.querySelectorAll('[data-fm-cf-kv-add]').forEach((button) => button.addEventListener('click', () => {
      button.insertAdjacentHTML('beforebegin', `<div class="fm-cf-kv-row"><input class="${String(escapeHtml(cleanText(options.inputClass) || 'fm-cf-input'))}" data-fm-cf-kv-key placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_8cf345002184e5","Name") ?? "Name")}"><input class="${String(escapeHtml(cleanText(options.inputClass) || 'fm-cf-input'))}" data-fm-cf-kv-value placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ec6b76d100b0ec","Value") ?? "Value")}"><button type="button" class="fm-cf-kv-remove" data-fm-cf-kv-remove aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a916bae1ac393b","Remove row") ?? "Remove row")}"><i class="fas fa-xmark"></i></button></div>`);
      button.closest('.fm-cf-kv')?.dispatchEvent?.(new Event('change', { bubbles:true }));
    }));
    if (container.dataset.fmCfEvents !== '1') {
      container.dataset.fmCfEvents = '1';
      container.addEventListener('click', (event) => {
        const remove = event.target.closest?.('[data-fm-cf-kv-remove]');
        if (remove && container.contains(remove)) {
          const wrapper = remove.closest('.fm-cf-kv');
          remove.closest('.fm-cf-kv-row')?.remove();
          wrapper?.dispatchEvent?.(new Event('change', { bubbles:true }));
        }
      });
      container.addEventListener('input', (event) => {
        const wrapper = event.target.closest?.('.fm-cf-kv[data-fm-cf-input]');
        if (wrapper && event.target !== wrapper) wrapper.dispatchEvent(new Event('change', { bubbles:true }));
      });
    }
    wireStructured(container);
    const saveButton = container.querySelector('[data-fm-cf-save]');
    saveButton?.addEventListener('click', async () => {
      const validation = validateEditor(container, entity, entityType, definitions);
      const status = container.querySelector('[data-fm-cf-status]');
      if (!validation.valid) {
        if (status) status.textContent = validation.first.message;
        container.querySelector(`[data-fm-cf-input="${CSS.escape(validation.first.key)}"]`)?.focus?.();
        return;
      }
      const next = applyValues(entity, entityType, validation.values);
      saveButton.disabled = true;
      if (status) status.textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_ea600c018fb36c","Saving…") ?? "Saving…");
      try {
        if (typeof options.onSave === 'function') await options.onSave(next);
        else if (entityType === 'project' && root.Portal?.ProjectStore?.saveRemote) await root.Portal.ProjectStore.saveRemote(next);
        entity = next;
        if (status) status.textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_47bbabb50774cf","Saved.") ?? "Saved.");
        root.dispatchEvent(new CustomEvent('fm:custom-fields:values-updated', { detail:{ entityType, entity:next, values:rawValues(next, entityType) } }));
      } catch (error) {
        if (status) status.textContent = error?.message || 'Could not save custom fields.';
      } finally { saveButton.disabled = false; }
    });
    return { entity, definitions, values };
  }

  function scopeEntries(entity = {}, options = {}){
    const definitions = fieldsFor('project', entity, { ...options, location:'scope' });
    return definitions.map((definition) => ({
      key:definition.key,
      label:definition.label,
      value:valueFor(definition, entity, definitions),
      display:formatValue(definition, valueFor(definition, entity, definitions)),
      definition
    }));
  }

  function injectSettingsCss(){
    if (document.getElementById('fm-custom-field-settings-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-custom-field-settings-css';
    style.textContent = `
      .cf-settings{display:grid;gap:14px}.cf-settings-head{display:grid;gap:10px;min-width:0}.cf-settings-head>div:first-child{min-width:0}.cf-settings-head h3{margin:0;font-size:18px}.cf-settings-head p{margin:5px 0 0;color:#667085;font-size:12px;font-weight:800;line-height:1.45}.cf-adds{display:flex;gap:7px;flex-wrap:wrap}.cf-btn{border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;min-height:36px;padding:0 11px;font-family:inherit;font-size:13px;font-weight:600;line-height:1.2;cursor:pointer}.cf-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}.cf-btn.danger{color:#b42318}.cf-layout{display:grid;grid-template-columns:minmax(250px,.7fr) minmax(420px,1.3fr);gap:12px;align-items:start}.cf-list,.cf-editor{border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden}.cf-list{display:grid}.cf-card{border:0;border-bottom:1px solid #eaecf0;background:#fff;padding:12px;text-align:left;cursor:pointer;display:grid;gap:4px}.cf-card:last-child{border-bottom:0}.cf-card.active{background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:inset 3px 0 var(--primary,#d93025)}.cf-card strong{font-size:13px;color:#101828}.cf-card span{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase}.cf-editor{padding:14px;display:grid;gap:12px}.cf-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.cf-row{display:grid;gap:5px}.cf-row.wide{grid-column:1/-1}.cf-row>label{font-size:11px;font-weight:1000;color:#475467}.cf-in{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;min-height:38px;padding:8px 10px;font-family:inherit;font-size:13px;font-weight:400;line-height:1.4}.cf-toggles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cf-toggle{border:1px solid #e4e7ec;border-radius:9px;padding:9px;display:flex;align-items:flex-start;gap:8px;font-size:11px;font-weight:850;color:#344054}.cf-help{font-size:11px;font-weight:800;color:#667085;line-height:1.4}.cf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cf-empty{padding:22px;color:#667085;font-size:12px;font-weight:850;text-align:center}.cf-badge{display:inline-flex;width:max-content;border-radius:999px;background:#f2f4f7;padding:4px 7px;font-size:9px!important}.cf-badge.project{background:#eef2ff;color:#3730a3}.cf-badge.contact{background:#ecfdf3;color:#047857}
      .cf-row[hidden],.cf-toggle[hidden],.cf-section[hidden]{display:none!important}
      .cf-settings{--cf-ink:#182230;--cf-muted:#667085;--cf-line:#e4e7ec}.cf-settings-head{border:1px solid var(--cf-line);border-radius:16px;padding:18px;background:linear-gradient(135deg,#fff 0%,#f8fafc 100%);grid-template-columns:minmax(0,1fr) auto;align-items:center}.cf-settings-head h3{font-size:22px;color:var(--cf-ink);letter-spacing:-.02em}.cf-settings-head p{max-width:700px}.cf-kicker{color:var(--primary,#d93025);font-size:10px;font-weight:1000;letter-spacing:.09em;text-transform:uppercase;margin-bottom:5px}.cf-adds .cf-btn{box-shadow:0 1px 2px #10182812}.cf-layout{grid-template-columns:minmax(260px,.72fr) minmax(520px,1.55fr);gap:16px}.cf-list-shell{border:1px solid var(--cf-line);border-radius:14px;background:#fff;overflow:hidden;position:sticky;top:12px}.cf-list-title{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:1px solid var(--cf-line);font-size:11px;font-weight:1000;color:var(--cf-muted)}.cf-list{border:0;border-radius:0;max-height:680px;overflow:auto}.cf-card{grid-template-columns:34px minmax(0,1fr);column-gap:9px;padding:11px 12px;align-items:center}.cf-card-icon{grid-row:1/4;width:32px;height:32px;border-radius:9px;background:#f2f4f7;display:grid;place-items:center;color:#475467;font-size:12px}.cf-card.active .cf-card-icon{background:rgba(var(--primary-rgb,217,48,37),.12);color:var(--primary,#d93025)}.cf-card strong,.cf-card span{grid-column:2}.cf-card strong{font-size:12px}.cf-card-meta{text-transform:none!important}.cf-editor{padding:0;border-radius:14px}.cf-editor-head{padding:16px 18px;border-bottom:1px solid var(--cf-line);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.cf-editor-head h4{margin:0;font-size:16px;color:var(--cf-ink)}.cf-editor-head p{margin:4px 0 0;font-size:11px;font-weight:750;color:var(--cf-muted)}.cf-editor-body{padding:16px 18px;display:grid;gap:16px}.cf-section{display:grid;gap:10px}.cf-section-title{display:flex;align-items:center;gap:8px;color:#344054;font-size:11px;font-weight:1000}.cf-section-title i{width:24px;height:24px;border-radius:7px;background:#f2f4f7;display:grid;place-items:center;color:#667085}.cf-type-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.cf-type-choice{position:relative}.cf-type-choice input{position:absolute;opacity:0}.cf-type-choice span{height:100%;box-sizing:border-box;border:1px solid var(--cf-line);border-radius:10px;padding:9px;display:grid;grid-template-columns:22px 1fr;gap:2px 7px;align-items:center;cursor:pointer;background:#fff}.cf-type-choice i{grid-row:1/3;color:#667085}.cf-type-choice strong{font-size:10px;color:#344054}.cf-type-choice small{font-size:9px;line-height:1.25;color:#98a2b3}.cf-type-choice input:checked+span{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.07)}.cf-type-choice input:checked+span i,.cf-type-choice input:checked+span strong{color:var(--primary,#d93025)}.cf-preview{border:1px dashed #cfd4dc;border-radius:12px;padding:13px;background:#f8fafc}.cf-preview-label{font-size:9px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}.cf-preview .fm-cf-field{max-width:520px}.cf-advanced{border:1px solid var(--cf-line);border-radius:11px;overflow:hidden}.cf-advanced summary{cursor:pointer;list-style:none;padding:11px 12px;font-size:11px;font-weight:1000;color:#475467;display:flex;align-items:center;justify-content:space-between}.cf-advanced summary::-webkit-details-marker{display:none}.cf-advanced-body{padding:0 12px 12px}.cf-actions{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--cf-line);padding:12px 18px;z-index:2}.cf-toggle{background:#fff;transition:.15s}.cf-toggle:has(input:checked){border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.035)}.cf-empty-state{padding:48px 24px;text-align:center}.cf-empty-state i{width:48px;height:48px;border-radius:14px;background:#f2f4f7;display:grid;place-items:center;margin:0 auto 12px;color:#667085}.cf-empty-state strong{display:block;color:#344054;font-size:14px}.cf-empty-state span{display:block;color:#98a2b3;font-size:11px;margin-top:5px}
      .cf-choice-builder{display:grid;gap:8px}.cf-choice-head{display:grid;grid-template-columns:26px minmax(0,1fr) minmax(110px,.65fr) 34px;gap:7px;padding:0 2px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.cf-choice-row{display:grid;grid-template-columns:26px minmax(0,1fr) minmax(110px,.65fr) 34px;gap:7px;align-items:center;border:1px solid var(--cf-line);border-radius:11px;padding:8px;background:#fff}.cf-choice-grip{color:#98a2b3;text-align:center}.cf-choice-row .cf-in{min-height:34px;padding:6px 8px}.cf-choice-remove{width:32px;height:32px;border:0;border-radius:8px;background:#fff1f0;color:#b42318;cursor:pointer}.cf-choice-add{justify-self:start}.cf-choice-empty{border:1px dashed #d0d5dd;border-radius:11px;padding:15px;text-align:center;color:#98a2b3;font-size:11px;font-weight:850}
      @media(max-width:1180px){.cf-layout{grid-template-columns:1fr}.cf-form-grid,.cf-toggles{grid-template-columns:1fr}.cf-row.wide{grid-column:auto}}
      @media(max-width:760px){.cf-settings-head{grid-template-columns:1fr}.cf-type-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cf-editor-head{padding:14px}.cf-editor-body{padding:14px}.cf-actions{padding:12px 14px}.cf-choice-head{display:none}.cf-choice-row{grid-template-columns:20px minmax(0,1fr) 32px}.cf-choice-row [data-cf-option-value]{grid-column:2}.cf-choice-remove{grid-column:3;grid-row:1/3}}
    `;
    style.textContent += `
      .cf-settings{gap:16px;max-width:1160px;margin:0 auto;padding:4px;color:#182230;font-size:14px}
      .cf-settings .cf-settings-head{display:flex;justify-content:space-between;gap:20px;padding:0;border:0;border-radius:0;background:none}
      .cf-settings .cf-settings-head h3{font-size:20px;font-weight:650;line-height:1.3}.cf-settings .cf-settings-head p{font-size:13px;font-weight:400;margin-top:6px}
      .cf-settings .cf-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;min-height:36px;min-width:0;width:auto;flex:none;padding:0 12px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;line-height:1;white-space:nowrap;box-shadow:none}
      .cf-settings button:focus-visible,.cf-settings input:focus-visible,.cf-settings select:focus-visible{outline:2px solid #d93025;outline-offset:3px}
      .cf-scope-bar{display:flex;gap:20px;border-bottom:1px solid #e4e7ec}.cf-settings .cf-scope-tab{display:flex;align-items:center;gap:8px;height:42px;padding:0 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:#667085;font:inherit;font-size:13px;font-weight:500;cursor:pointer}.cf-settings .cf-scope-tab[aria-selected=true]{border-bottom-color:var(--primary,#d93025);color:#182230;font-weight:600}.cf-scope-tab span{font-size:11px;padding:2px 6px;background:#f2f4f7;border-radius:5px;color:#667085}.cf-scope-description{margin:0;font-size:13px;color:#667085;line-height:1.5}
      .cf-settings .cf-layout{grid-template-columns:260px minmax(0,1fr);gap:20px}.cf-settings .cf-layout.is-empty{grid-template-columns:1fr}.cf-layout.is-empty .cf-list-shell{display:none}.cf-settings .cf-detail{display:grid;gap:16px;min-width:0}.cf-settings .cf-list-shell{border-radius:10px}.cf-settings .cf-list-title{font-size:12px;font-weight:600;padding:12px}.cf-settings .cf-card{width:100%;font-family:inherit}.cf-settings .cf-card .cf-badge{display:none}.cf-settings .cf-card-icon{grid-column:1;grid-row:1/3}.cf-settings .cf-card strong{grid-row:1;font-size:13px;font-weight:600}.cf-settings .cf-card-meta{grid-row:2;font-size:12px;font-weight:400}.cf-settings .cf-empty-state{padding:28px 18px}.cf-settings .cf-empty-state i{display:none}.cf-settings .cf-empty-state strong{font-size:14px;font-weight:600}.cf-settings .cf-empty-state span{font-size:13px;color:#667085;line-height:1.5}.cf-settings .cf-editor-head{padding:14px 16px}.cf-settings .cf-editor-head p{font-size:12px;font-weight:400}.cf-settings .cf-editor-body{padding:16px;gap:20px}.cf-settings .cf-section-title{font-size:13px;font-weight:600}.cf-settings .cf-section-title i{display:none}.cf-settings .cf-row>label{font-size:12px;font-weight:500}.cf-settings .cf-help{font-size:12px;font-weight:400}.cf-settings .cf-toggle{font-size:12px;font-weight:400;line-height:1.5}.cf-settings .cf-toggle strong{font-weight:500}.cf-settings .cf-in{font-family:inherit;font-size:13px;font-weight:400}.cf-settings .cf-actions{position:static;padding:12px 16px}.cf-settings .cf-value-card{border:1px solid #e4e7ec;border-radius:10px;padding:16px}.cf-definition{border:1px solid #e4e7ec;border-radius:10px;overflow:hidden}.cf-definition>summary{padding:14px 16px;cursor:pointer;font-weight:600;font-size:13px}.cf-definition>summary span{font-weight:400;color:#667085;margin-left:10px}.cf-definition .cf-editor{border:0;border-top:1px solid #e4e7ec;border-radius:0}.cf-value-title{font-size:14px;font-weight:600;margin-bottom:12px}.cf-settings .cf-value-card .fm-cf-panel{padding:0;border:0;box-shadow:none;background:none}.cf-settings .cf-value-card .fm-cf-grid{grid-template-columns:1fr}.cf-settings .cf-value-card .fm-cf-field{grid-column:1/-1}.cf-settings .cf-value-card input,.cf-settings .cf-value-card textarea,.cf-settings .cf-value-card select{font-family:inherit;font-size:14px;font-weight:400}.cf-settings [hidden]{display:none!important}
      @media(max-width:760px){.cf-settings .cf-layout{grid-template-columns:1fr}.cf-settings .cf-list-shell{position:static}.cf-settings .cf-list{max-height:220px}.cf-settings .cf-settings-head{align-items:flex-start}.cf-settings .cf-settings-head h3{font-size:18px}.cf-settings .cf-form-grid,.cf-settings .cf-toggles{grid-template-columns:1fr}.cf-scope-bar{gap:16px}}
`;
    document.head.appendChild(style);
  }

  async function mountSettings(container, options = {}){
    if (!container) return;
    injectSettingsCss();
    injectEditorCss();
    container.innerHTML = `<div class="cf-settings" data-settings-autosave="off"><div class="cf-empty">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_b7b7212c084051","Loading custom fields…") ?? "Loading custom fields…")}</div></div>`;
    let settings;
    try { settings = await load(options); }
    catch (error) { container.innerHTML = `<div class="cf-empty">${escapeHtml(error?.message || 'Custom fields are unavailable.')}</div>`; return; }
    let fields = settings.fields;
    let scope = options.entity || 'project';
    let selectedId = fields.find(f => f.entity === scope)?.id || '';
    const drafts = new Set();

    const render = () => {
      const visible = fields.filter(field => field.entity === scope);
      const selected = fields.find((field) => field.id === selectedId) || null;
      const selectedType = selected ? TYPE_BY_VALUE.get(selected.type) : null;
      const optionTypes = new Set(['select', 'radio', 'multiselect']);
      const numericTypes = new Set(['integer', 'number', 'currency', 'percentage', 'slider']);
      container.innerHTML = `<div class="cf-settings" data-settings-autosave="off">
        <div class="cf-settings-head"><div><h3>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_2d1233007f5250","Custom fields") ?? "Custom fields")}</h3><p>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_de761ed0e7c3f1","Manage the information saved for your organization, projects, and contacts.") ?? "Manage the information saved for your organization, projects, and contacts.")}</p></div><button type="button" class="cf-btn primary" data-cf-add="${scope}"><span aria-hidden="true">+</span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_d20af8e8ec43c2"," Add field") ?? " Add field")}</button></div>
        <div class="cf-scope-bar" role="tablist" aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_c201cfcf3ec944","Field scope") ?? "Field scope")}">${[['project','Projects'],['contact','Contacts'],['organization','Organization']].map(([id,label]) => `<button type="button" role="tab" aria-selected="${scope === id}" class="cf-scope-tab" data-cf-scope="${id}">${label}<span>${fields.filter(f => f.entity === id).length}</span></button>`).join('')}</div>
        <p class="cf-scope-description">${scope === 'organization' ? 'Shared company information. Add a field, then enter its value here.' : `Define the fields people fill in on individual ${scope === 'project' ? 'projects' : 'contacts'}.`}</p>
        <div class="cf-layout${visible.length ? '' : ' is-empty'}"><aside class="cf-list-shell"><div class="cf-list-title"><span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_b6878598aff8e0","Your fields") ?? "Your fields")}</span><span>${String(visible.length)}</span></div><div class="cf-list">${String(visible.length ? visible.map((field) => {
          const type = TYPE_BY_VALUE.get(field.type) || TYPE_BY_VALUE.get('text');
          return `<button type="button" class="cf-card${field.id === selectedId ? ' active' : ''}" data-cf-select="${escapeHtml(field.id)}"><span class="cf-card-icon"><i class="fas ${escapeHtml(type.icon)}"></i></span><span class="cf-badge ${field.entity}">${escapeHtml(field.entity)}</span><strong>${escapeHtml(field.label)}</strong><span class="cf-card-meta">${escapeHtml(type.label)}${field.enabled ? '' : ' · Paused'}</span></button>`;
        }).join('') : `<div class="cf-empty-state"><i class="fas fa-wand-magic-sparkles"></i><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_760d07fa7dc65f","No fields yet") ?? "No fields yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_3518958e29f544","Use Add field to create your first field.") ?? "Use Add field to create your first field.")}</span></div>`)}</div></aside>
        <div class="cf-detail">${selected?.entity === 'organization' ? `<section class="cf-value-card"><div class="cf-value-title">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_9a288b62f4362e","Current value") ?? "Current value")}</div><div data-cf-value-host></div></section>` : ''}${String(selected ? `${selected.entity === 'organization' ? `<details class="cf-definition"${drafts.has(selectedId) ? ' open' : ''}><summary>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a98c12675bc2ba","Field settings ") ?? "Field settings ")}<span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_034318a364da0f","Name, type, and validation") ?? "Name, type, and validation")}</span></summary>` : ''}<form class="cf-editor" data-cf-editor>
          <div class="cf-editor-head"><div><h4>${escapeHtml(selected.label)}</h4><p>${escapeHtml(selectedType.hint)}</p></div><span class="cf-badge ${selected.entity}">${escapeHtml(selected.entity)}</span></div>
          <div class="cf-editor-body">
            <section class="cf-section"><div class="cf-section-title"><i class="fas fa-pen"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_f070f5aa3901f5"," What should people see?") ?? " What should people see?")}</div><div class="cf-form-grid">
              <div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_e41c9b6634e3aa","Field name") ?? "Field name")}</label><input class="cf-in" name="label" value="${escapeHtml(selected.label)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_8e1fd88e019325","Example: Roof material") ?? "Example: Roof material")}" required></div>
              <div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_30d69f0bb84476","Used on") ?? "Used on")}</label><select class="cf-in" name="entity"><option value="project"${selected.entity === 'project' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_19156e80fc8a6e","Projects") ?? "Projects")}</option><option value="organization"${selected.entity === 'organization' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_84b7f792c9d048","Organization") ?? "Organization")}</option><option value="contact"${selected.entity === 'contact' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_6fe082da60f3b0","Contacts") ?? "Contacts")}</option></select></div>
              <div class="cf-row wide"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_67b299ee8d0d62","Helpful description ") ?? "Helpful description ")}<span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></label><input class="cf-in" name="description" value="${escapeHtml(selected.description)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ccd3ead388103e","Explain what to enter or why it matters") ?? "Explain what to enter or why it matters")}"></div>
              <div class="cf-row wide"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_f0ebd864567d9e","Placeholder or toggle wording ") ?? "Placeholder or toggle wording ")}<span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></label><input class="cf-in" name="placeholder" value="${escapeHtml(selected.placeholder)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_5a60afabbd0833","Example answer or short instruction") ?? "Example answer or short instruction")}"></div>
            </div></section>
            <section class="cf-section"><div class="cf-section-title"><i class="fas fa-shapes"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_817b5495dbf621"," How should people answer?") ?? " How should people answer?")}</div><select class="cf-in" name="type" aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_d71bdb1b5e587a","Field type") ?? "Field type")}">${TYPE_CATALOG.map(type => `<option value="${escapeHtml(type.value)}"${selected.type === type.value ? ' selected' : ''}>${escapeHtml(type.label)}</option>`).join('')}</select></section>
            <section class="cf-section" data-cf-options-row${optionTypes.has(selected.type) ? '' : ' hidden'}><div class="cf-section-title"><i class="fas fa-list"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_c77ecb33d21e44"," Choices") ?? " Choices")}</div><div class="cf-choice-builder"><div class="cf-choice-head"><span></span><span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_12f838600d730e","Choice shown to people") ?? "Choice shown to people")}</span><span>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_2c078b4e5e3896","Saved value ") ?? "Saved value ")}<em>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_82710819dd8da8","(optional)") ?? "(optional)")}</em></span><span></span></div><div data-cf-option-list>${selected.options.length ? selected.options.map((option) => `<div class="cf-choice-row" data-cf-option-row><span class="cf-choice-grip"><i class="fas fa-grip-vertical"></i></span><input class="cf-in" data-cf-option-label value="${escapeHtml(option.label)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_13ecdbd26d94c0","Choice name") ?? "Choice name")}"><input class="cf-in" data-cf-option-value value="${option.label === option.value ? '' : escapeHtml(option.value)}" placeholder="${escapeHtml(slug(option.label, 'saved_value'))}"><button type="button" class="cf-choice-remove" data-cf-option-remove aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("custom-fields","m_f2da0f4d54d9d9",`Remove ${v3}`,{v3}) ?? `Remove ${v3}`)(escapeHtml(option.label))}"><i class="fas fa-trash"></i></button></div>`).join('') : `<div class="cf-choice-empty" data-cf-choice-empty>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_cfbf5fb58f8468","Add the first choice below.") ?? "Add the first choice below.")}</div>`}</div><button type="button" class="cf-btn cf-choice-add" data-cf-option-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_9843402d556eeb"," Add choice") ?? " Add choice")}</button><span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_9c08edb112c438","The saved value is filled automatically from the choice name unless you provide one.") ?? "The saved value is filled automatically from the choice name unless you provide one.")}</span></div></section>
            <section class="cf-section" data-cf-formula-row${selected.type === 'formula' ? '' : ' hidden'}><div class="cf-section-title"><i class="fas fa-calculator"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_3116869bf8a647"," Calculation") ?? " Calculation")}</div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_f10e6b2e02d839","Formula") ?? "Formula")}</label><input class="cf-in" name="formula" value="${escapeHtml(selected.formula)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_3adc861bca73f6","{{labor_hours}} * {{hourly_rate}}") ?? "{{labor_hours}} * {{hourly_rate}}")}"><span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_bb19a5edd19102","Use another numeric field’s key inside double braces. Basic arithmetic and parentheses are supported.") ?? "Use another numeric field’s key inside double braces. Basic arithmetic and parentheses are supported.")}</span></div></section>
            <section class="cf-section" data-cf-number-row${numericTypes.has(selected.type) ? '' : ' hidden'}><div class="cf-section-title"><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_e401a18d1f0811"," Number limits ") ?? " Number limits ")}<span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></div><div class="cf-form-grid"><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a98b9d676a49f1","Minimum") ?? "Minimum")}</label><input class="cf-in" type="number" step="any" name="min" value="${selected.min ?? ''}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_47cfe16c393bbc","Maximum") ?? "Maximum")}</label><input class="cf-in" type="number" step="any" name="max" value="${selected.max ?? ''}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_87cb6fb0a41c03","Step") ?? "Step")}</label><input class="cf-in" type="number" step="any" min="0" name="step" value="${selected.step ?? ''}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_61708f5a2ce411","Any") ?? "Any")}"></div><div class="cf-row" data-cf-currency${selected.type === 'currency' ? '' : ' hidden'}><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_c267b6350b9781","Currency") ?? "Currency")}</label><select class="cf-in" name="currency">${['USD','CAD','EUR','GBP','AUD'].map((currency) => `<option value="${currency}"${selected.currency === currency ? ' selected' : ''}>${currency}</option>`).join('')}</select></div></div></section>
            <section class="cf-section" data-cf-schema-row${['object','array','json'].includes(selected.type) ? '' : ' hidden'}><div class="cf-section-title">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_05fb7dcb3179a3","Subfields and item rules") ?? "Subfields and item rules")}</div><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_0e91ac64aa1bcc","JSON Schema") ?? "JSON Schema")}<textarea class="cf-in" name="schema" rows="8" spellcheck="false">${escapeHtml(JSON.stringify(selected.schema,null,2))}</textarea></label><span class="cf-help">Dictionary example: {"properties":{"count":{"type":"integer","minimum":0}},"required":["count"],"additionalProperties":false}. Array example: {"items":{"type":"object","properties":{"name":{"type":"string"}}}}. Formats: date, datetime, email, phone, url.</span></section>
            <section class="cf-section"><div class="cf-section-title"><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a48897118cb076"," Preview") ?? " Preview")}</div><div class="cf-preview"><div class="cf-preview-label">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_5b36a7157336fc","People will see") ?? "People will see")}</div><div class="fm-cf-field" data-cf-preview><label>${escapeHtml(selected.label)}${selected.required ? ' <em>*</em>' : ''}</label>${inputHtml(selected, selected.default_value)}</div></div></section>
            <section class="cf-section"><div class="cf-section-title"><i class="fas fa-location-dot"></i> <span data-cf-display-heading>${selected.entity === 'organization' ? 'Field behavior' : 'Where should it appear?'}</span></div><div class="cf-toggles">
              <label class="cf-toggle" data-cf-overview-toggle${selected.entity === 'organization' ? ' hidden' : ''}><input type="checkbox" name="show_in_overview"${selected.show_in_overview ? ' checked' : ''}> <span><strong data-cf-overview-label>${selected.entity === 'contact' ? 'Contact details' : 'Project details'}</strong><br><span data-cf-overview-help>${selected.entity === 'contact' ? 'Show this field while viewing and editing a contact.' : 'Show this field while viewing and editing a project.'}</span></span></label>
              <label class="cf-toggle" data-cf-scope-toggle${selected.entity === 'project' ? '' : ' hidden'}><input type="checkbox" name="show_in_scope"${selected.show_in_scope ? ' checked' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_737026ffd48d0a","Scope workspace") ?? "Scope workspace")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_51346fc718fb3c","Show a read-only value alongside measurements.") ?? "Show a read-only value alongside measurements.")}</span></label>
              <label class="cf-toggle"><input type="checkbox" name="background_only"${selected.background_only ? ' checked' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_bbcc1c701ee884","Store in the background") ?? "Store in the background")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_5b23cea3dc5736","Keep integration data without showing an input.") ?? "Keep integration data without showing an input.")}</span></label>
              <label class="cf-toggle" data-cf-formula-toggle${['integer', 'number', 'currency', 'percentage', 'slider', 'boolean', 'toggle', 'formula'].includes(selected.type) ? '' : ' hidden'}><input type="checkbox" name="formula_available"${selected.formula_available ? ' checked' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_10bd4359b657f4","Available in calculations") ?? "Available in calculations")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a524481aeb415c","Use ") ?? "Use ")}<code>${escapeHtml(selected.formula_key)}</code>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_efe46e192e9efa"," in project formulas.") ?? " in project formulas.")}</span></label>
              <label class="cf-toggle"><input type="checkbox" name="required"${selected.required ? ' checked' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ae555ec13b612d","Answer required") ?? "Answer required")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_b0099c7536de33","Prompt for an answer when this field is shown.") ?? "Prompt for an answer when this field is shown.")}</span></label>
              <label class="cf-toggle"><input type="checkbox" name="read_only"${selected.read_only ? ' checked' : ''}${selected.type === 'formula' ? ' disabled' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_65ed6dd2cd3755","Read only") ?? "Read only")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_b47971b986d6f1","Show the value without allowing manual changes.") ?? "Show the value without allowing manual changes.")}</span></label>
              <label class="cf-toggle"><input type="checkbox" name="enabled"${selected.enabled ? ' checked' : ''}> <span><strong>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_d73cb459adbb79","Field is active") ?? "Field is active")}</strong><br>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_0273e24524d849","Turn this off to hide it without deleting data.") ?? "Turn this off to hide it without deleting data.")}</span></label>
            </div></section>
            <details class="cf-advanced"><summary><span><i class="fas fa-gear"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ad2fdd51513838"," Advanced setup") ?? " Advanced setup")}</span><i class="fas fa-chevron-down"></i></summary><div class="cf-advanced-body"><div class="cf-form-grid">
              <div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_a70257a3773b55","Read permission (optional)") ?? "Read permission (optional)")}</label><input class="cf-in" name="read_permission" value="${escapeHtml(selected.read_permission)}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_6a55e0cf2d90e8","Write permission (optional)") ?? "Write permission (optional)")}</label><input class="cf-in" name="write_permission" value="${escapeHtml(selected.write_permission)}"></div><label class="cf-toggle"><input type="checkbox" name="private"${selected.private ? ' checked' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_20b337b2d236d1"," Private publication (company settings permission unless a read permission is specified)") ?? " Private publication (company settings permission unless a read permission is specified)")}</label><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_f303576609f833","Minimum length") ?? "Minimum length")}</label><input class="cf-in" type="number" min="0" name="min_length" value="${selected.min_length ?? ''}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_d260f7efa1371a","Maximum length") ?? "Maximum length")}</label><input class="cf-in" type="number" min="1" name="max_length" value="${selected.max_length ?? ''}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_6b51a8a26cde66","Validation pattern (optional)") ?? "Validation pattern (optional)")}</label><input class="cf-in" name="pattern" value="${escapeHtml(selected.pattern)}"></div><div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_1e626e43ebe1a7","Stable data path") ?? "Stable data path")}</label><input class="cf-in" name="key" value="${escapeHtml(selected.key)}" pattern="[a-z0-9_-]+(.[a-z0-9_-]+)*" required><span class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_d1dcac9d0b262a","Dots create nested groups, such as ") ?? "Dots create nested groups, such as ")}<code>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_c9af278c1e5a3d","assignments.estimator") ?? "assignments.estimator")}</code>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_1f7b0d62df0233",". Avoid changing this after launch.") ?? ". Avoid changing this after launch.")}</span></div>
              <div class="cf-row"><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_11dd4e12ef3854","Field width") ?? "Field width")}</label><select class="cf-in" name="layout"><option value="half"${selected.layout === 'half' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_6cf6e1c920f030","Half row") ?? "Half row")}</option><option value="full"${selected.layout === 'full' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_7e336e8ad529f7","Full row") ?? "Full row")}</option></select></div>
              <div class="cf-row" data-cf-scope-mode${selected.entity === 'project' ? '' : ' hidden'}><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_e659fc78c53999","Which project scopes?") ?? "Which project scopes?")}</label><select class="cf-in" name="scope_mode"><option value="all"${selected.scope_mode === 'all' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_9878efb1fc52a8","All scopes") ?? "All scopes")}</option><option value="selected"${selected.scope_mode === 'selected' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_e7bcd589e08dd7","Only selected scopes") ?? "Only selected scopes")}</option></select></div>
              <div class="cf-row" data-cf-scopes${selected.entity === 'project' && selected.scope_mode === 'selected' ? '' : ' hidden'}><label>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_57ae77c753c6bf","Scope IDs, keys, or names") ?? "Scope IDs, keys, or names")}</label><input class="cf-in" name="scopes" value="${escapeHtml(selected.scopes.join(', '))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_da7c1c116de3fd","roofing, siding") ?? "roofing, siding")}"></div>
            </div></div></details>
          </div>
          <div class="cf-actions"><button type="submit" class="cf-btn primary"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_bfcbd339764266"," Save changes") ?? " Save changes")}</button><button type="button" class="cf-btn danger" data-cf-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ddcb58dfb35c6f"," Delete field") ?? " Delete field")}</button><span class="cf-help" data-cf-status></span></div>
        </form>${selected.entity === 'organization' ? '</details>' : ''}` : `<div class="cf-editor"><div class="cf-empty-state"><strong>${visible.length ? 'Select a field' : 'No ' + scope + ' fields yet'}</strong><span>${visible.length ? 'Choose a field to edit its settings.' : 'Use Add field to name the information you want to save.'}</span></div></div>`)}</div></div>
      </div>`;

      container.querySelectorAll('[data-cf-scope]').forEach(button => button.addEventListener('click', () => { scope = button.dataset.cfScope; selectedId = fields.find(f => f.entity === scope)?.id || ''; render(); }));
      const valueHost = container.querySelector('[data-cf-value-host]');
      if (valueHost) {
        if (drafts.has(selectedId)) valueHost.innerHTML = `<p class="cf-help">${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_671579c4c003f4","Save the field below, then enter its value here.") ?? "Save the field below, then enter its value here.")}</p>`;
        else mountOrganizationValues(valueHost, {...options, fieldPath:selected.path});
      }
      container.querySelectorAll('[data-cf-select]').forEach((button) => button.addEventListener('click', () => { selectedId = button.dataset.cfSelect; render(); }));
      container.querySelectorAll('[data-cf-add]').forEach((button) => button.addEventListener('click', () => {
        const entity = ['contact','organization'].includes(button.dataset.cfAdd) ? button.dataset.cfAdd : 'project';
        const field = normalizeDefinition({ id:uid(), entity, label:((v0) => globalThis.PlatformLanguage?.text("custom-fields","m_0b54d9361ff7b4",`New ${v0} field`,{v0}) ?? `New ${v0} field`)(entity), key:`new_${entity}_field_${fields.length + 1}`, type:'text', show_in_overview:true, order:fields.length });
        fields.push(field); drafts.add(field.id); selectedId = field.id; render();
      }));
      const form = container.querySelector('[data-cf-editor]');
      const optionList = form?.querySelector('[data-cf-option-list]');
      const optionRows = () => [...(optionList?.querySelectorAll('[data-cf-option-row]') || [])];
      const readOptionRows = () => optionRows().map((row) => {
        const label = cleanText(row.querySelector('[data-cf-option-label]')?.value);
        const savedValue = cleanText(row.querySelector('[data-cf-option-value]')?.value);
        return label ? { label, value:savedValue || label } : null;
      }).filter(Boolean);
      const addOptionRow = (option = {}) => {
        if (!optionList) return;
        optionList.querySelector('[data-cf-choice-empty]')?.remove();
        const label = cleanText(option.label);
        const value = cleanText(option.value);
        optionList.insertAdjacentHTML('beforeend', `<div class="cf-choice-row" data-cf-option-row><span class="cf-choice-grip"><i class="fas fa-grip-vertical"></i></span><input class="cf-in" data-cf-option-label value="${String(escapeHtml(label))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_13ecdbd26d94c0","Choice name") ?? "Choice name")}"><input class="cf-in" data-cf-option-value value="${String(escapeHtml(value && value !== label ? value : ''))}" placeholder="${String(escapeHtml(slug(label, 'saved_value')))}"><button type="button" class="cf-choice-remove" data-cf-option-remove aria-label="${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_ed53c026108fd8","Remove choice") ?? "Remove choice")}"><i class="fas fa-trash"></i></button></div>`);
        const rows = optionRows();
        rows[rows.length - 1]?.querySelector('[data-cf-option-label]')?.focus?.();
      };
      const syncConditionalRows = () => {
        if (!form) return;
        const type = form.elements.type.value;
        const entity = form.elements.entity.value;
        const scopeMode = form.elements.scope_mode.value;
        const typeInfo = TYPE_BY_VALUE.get(type) || TYPE_BY_VALUE.get('text');
        form.querySelector('[data-cf-schema-row]').hidden = !['object','array','json'].includes(type);
        form.querySelector('[data-cf-options-row]').hidden = !['select', 'radio', 'multiselect'].includes(type);
        form.querySelector('[data-cf-formula-row]').hidden = type !== 'formula';
        form.querySelector('[data-cf-number-row]').hidden = !['integer', 'number', 'currency', 'percentage', 'slider'].includes(type);
        form.querySelector('[data-cf-currency]').hidden = type !== 'currency';
        form.querySelector('[data-cf-scope-mode]').hidden = entity !== 'project';
        form.querySelector('[data-cf-scopes]').hidden = entity !== 'project' || scopeMode !== 'selected';
        form.querySelector('[data-cf-scope-toggle]').hidden = entity !== 'project';
        form.querySelector('[data-cf-overview-toggle]').hidden = entity === 'organization';
        form.querySelector('[data-cf-overview-label]').textContent = entity === 'contact' ? 'Contact details' : 'Project details';
        form.querySelector('[data-cf-overview-help]').textContent = ((v0) => globalThis.PlatformLanguage?.text("custom-fields","m_c5a59651e9ca2f",`Show this field while viewing and editing a ${v0}.`,{v0}) ?? `Show this field while viewing and editing a ${v0}.`)(entity === 'contact' ? 'contact' : 'project');
        form.querySelector('[data-cf-display-heading]').textContent = entity === 'organization' ? 'Field behavior' : 'Where should it appear?';
        form.querySelector('[data-cf-formula-toggle]').hidden = !['integer', 'number', 'currency', 'percentage', 'slider', 'boolean', 'toggle', 'formula'].includes(type);
        const label = cleanText(form.elements.label.value) || 'Untitled field';
        const draft = normalizeDefinition({
          ...selected,
          label,
          type,
          placeholder:form.elements.placeholder.value,
          options:readOptionRows(),
          min:form.elements.min.value,
          max:form.elements.max.value,
          step:form.elements.step.value,
          currency:form.elements.currency.value,
          required:form.elements.required.checked,
          read_only:form.elements.read_only.checked
        });
        const preview = form.querySelector('[data-cf-preview]');
        if (preview) preview.innerHTML = `<label>${escapeHtml(label)}${draft.required ? ' <em>*</em>' : ''}</label>${inputHtml(draft, draft.default_value)}`;
        preview?.querySelectorAll('input,select,textarea,button').forEach(control => { control.disabled = true; });
        const subtitle = form.querySelector('.cf-editor-head p');
        if (subtitle) subtitle.textContent = typeInfo.hint;
      };
      form?.querySelectorAll('[name="type"]').forEach((input) => input.addEventListener('change', () => {
        if (['integer', 'number', 'currency', 'percentage', 'slider', 'boolean', 'toggle', 'formula'].includes(form.elements.type.value)) form.elements.formula_available.checked = true;
        if (form.elements.type.value === 'formula') form.elements.read_only.checked = true;
        if (['select', 'radio', 'multiselect'].includes(form.elements.type.value) && !optionRows().length) addOptionRow();
        syncConditionalRows();
      }));
      ['label', 'placeholder', 'min', 'max', 'step', 'currency', 'required', 'read_only'].forEach((name) => form?.elements[name]?.addEventListener('input', syncConditionalRows));
      form?.querySelector('[data-cf-option-add]')?.addEventListener('click', () => { addOptionRow(); syncConditionalRows(); });
      optionList?.addEventListener('input', (event) => {
        if (!event.target.matches('[data-cf-option-label],[data-cf-option-value]')) return;
        const row = event.target.closest('[data-cf-option-row]');
        const label = cleanText(row?.querySelector('[data-cf-option-label]')?.value);
        const saved = row?.querySelector('[data-cf-option-value]');
        if (saved) saved.placeholder = slug(label, 'saved_value');
        syncConditionalRows();
      });
      optionList?.addEventListener('click', (event) => {
        const remove = event.target.closest?.('[data-cf-option-remove]');
        if (!remove) return;
        remove.closest('[data-cf-option-row]')?.remove();
        if (!optionRows().length) optionList.innerHTML = `<div class="cf-choice-empty" data-cf-choice-empty>${(globalThis.PlatformLanguage?.htmlText("custom-fields","m_cfbf5fb58f8468","Add the first choice below.") ?? "Add the first choice below.")}</div>`;
        syncConditionalRows();
      });
      form?.elements.entity?.addEventListener('change', syncConditionalRows);
      form?.elements.scope_mode?.addEventListener('change', syncConditionalRows);
      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const key = normalizePath(data.get('key') || data.get('label'));
        if (fields.some((field) => field.id !== selectedId && field.key === key && field.entity === data.get('entity'))) {
          form.querySelector('[data-cf-status]').textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_b6dffbcdc9e835","That key is already used for this record type.") ?? "That key is already used for this record type."); return;
        }
        const current = fields.find((field) => field.id === selectedId);
        let schema; try { schema = JSON.parse(String(data.get('schema') || '{}')); if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error(); } catch { form.querySelector('[data-cf-status]').textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_f128466a8caddb","The schema must be valid JSON.") ?? "The schema must be valid JSON."); return; }
        const next = normalizeDefinition({
          ...current, schema, private:form.elements.private.checked, read_permission:data.get('read_permission'), write_permission:data.get('write_permission'), min_length:data.get('min_length'), max_length:data.get('max_length'), pattern:data.get('pattern'),
          label:data.get('label'), key, path:key, entity:data.get('entity'), type:data.get('type'), description:data.get('description'), placeholder:data.get('placeholder'),
          options:readOptionRows(), formula:data.get('formula'), scope_mode:data.get('scope_mode'), scopes:cleanText(data.get('scopes')).split(','),
          layout:data.get('layout'), currency:data.get('currency'), min:data.get('min'), max:data.get('max'), step:data.get('step'),
          show_in_overview:form.elements.show_in_overview.checked, show_in_scope:form.elements.show_in_scope.checked,
          background_only:form.elements.background_only.checked, formula_available:form.elements.formula_available.checked,
          required:form.elements.required.checked, read_only:form.elements.read_only.checked, enabled:form.elements.enabled.checked
        }, fields.indexOf(current));
        fields = fields.map((field) => field.id === selectedId ? next : field);
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        form.querySelector('[data-cf-status]').textContent = (globalThis.PlatformLanguage?.text("custom-fields","m_ea600c018fb36c","Saving…") ?? "Saving…");
        try { fields = (await saveDefinitions(fields, options)).fields; drafts.delete(selectedId); scope = next.entity; render(); root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("custom-fields","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("custom-fields","m_d66c043b6a8789","Custom field updated.") ?? "Custom field updated."), true); }
        catch (error) { button.disabled = false; form.querySelector('[data-cf-status]').textContent = error?.message || 'Could not save.'; }
      });
      form?.querySelector('[data-cf-delete]')?.addEventListener('click', async () => {
        const okay = root.Portal?.ui?.confirm ? await root.Portal.ui.confirm(((v0) => globalThis.PlatformLanguage?.text("custom-fields","m_e95c0ed36ba264",`Delete “${v0}”? Existing stored values will be retained but hidden.`,{v0}) ?? `Delete “${v0}”? Existing stored values will be retained but hidden.`)(selected?.label)) : root.confirm(((v0) => globalThis.PlatformLanguage?.text("custom-fields","m_d0987286fd2869",`Delete “${v0}”?`,{v0}) ?? `Delete “${v0}”?`)(selected?.label));
        if (!okay) return;
        fields = fields.filter((field) => field.id !== selectedId);
        selectedId = '';
        try { fields = (await saveDefinitions(fields, options)).fields; render(); }
        catch (error) { root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("custom-fields","m_cf2c70cfda409b","Delete failed") ?? "Delete failed"), error?.message || 'Could not delete custom field.', false); }
      });
      syncConditionalRows();
    };
    render();
  }

  root.FirstMateCustomFields = {
    __initialized:true,
    MODULE_ID,
    VALUE_KEY,
    PROJECT_COMPAT_VALUE_KEY,
    CONTACT_VALUE_KEY,
    TYPE_CATALOG:clone(TYPE_CATALOG),
    schemaError, validFormat, structuredHtml, structuredValue, inputHtml, wireStructured, mountOrganizationValues,
    normalizeDefinition,
    normalizeModule,
    normalizePath,
    load,
    saveDefinitions,
    cachedFields,
    definitionsFor,
    projectSchema,
    fieldsFor,
    formulaFields,
    valuesForFormula,
    valueFor,
    rawValues,
    valueAtPath,
    setValueAtPath,
    editorValues,
    validateEditor,
    applyValues,
    renderEditor,
    formatValue,
    scopeEntries,
    mountSettings,
    appliesTo,
    scopeTokens
  };
  load().catch(() => null);
})();
