/* public/libraries/apps/checklists/app.js
 * Office-side project checklist workspace. Shows every field checklist for a
 * project (crew and supervisor), who completed each item, and full editing.
 * Desktop-first layout; fully usable on mobile.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!runtime?.registerApp || !Portal) return;

  const clean = (value) => String(value ?? '').trim();
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => runtime.escapeHtml ? runtime.escapeHtml(value) : clean(value).replace(/[&<>"']/g, '');
  const first = (...values) => values.find((value) => clean(value)) ?? '';
  const showToast = (title, message, ok = true) => Portal.ui?.showToast?.(title, message, ok);
  const statusError = (error, fallback) => clean(error?.data?.message || error?.message || fallback || 'Something went wrong.');
  const shortDate = (value) => {
    const date = new Date(clean(value));
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { month:'short', day:'numeric' }) : '';
  };
  const orgId = (context = {}) => clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const projectId = (context = {}) => clean(context.projectId || context.project?.id || context.entityId);
  const userId = (context = {}) => clean(context.currentUser?.id || Portal.currentUser?.id || window.__APP?.userId);
  const labelize = (value) => clean(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const records = (value, ...keys) => {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    return [];
  };
  const assignmentEligibility = (policyValue, legacyRoleIds = []) => {
    const policy = obj(policyValue);
    const tokens = new Set(arr(legacyRoleIds).map((id) => `role:${clean(id)}`).filter((token) => token !== 'role:'));
    const customRules = [];
    arr(policy.rules).forEach((ruleValue) => {
      const rule = obj(ruleValue);
      const complex = arr(rule.subject_ids).length || arr(rule.kind_ids).length || arr(rule.assignment_tag_ids).length || arr(rule.capability_scope_ids).length;
      if (complex) { customRules.push(rule); return; }
      arr(rule.role_ids).forEach((id) => tokens.add(`role:${clean(id)}`));
      arr(rule.group_kind_ids).forEach((id) => tokens.add(`group:${clean(id)}`));
      if (!arr(rule.role_ids).length && !arr(rule.group_kind_ids).length) {
        arr(rule.subject_types).forEach((type) => tokens.add(`subject:${clean(type)}`));
      }
    });
    return { tokens:[...tokens].filter((token) => !token.endsWith(':')), customRules };
  };
  const assignmentRuleForToken = (token, index) => {
    const separator = token.indexOf(':');
    const type = token.slice(0, separator);
    const id = token.slice(separator + 1);
    if (type === 'role') return { id:`eligible_role_${id}`, subject_types:['organization_user'], role_ids:[id] };
    if (type === 'group') return { id:`eligible_group_${id}`, subject_types:['resource_group'], group_kind_ids:[id] };
    if (type === 'subject') return { id:`eligible_${id}_${index + 1}`, subject_types:[id] };
    return null;
  };

  const RATING_ICONS = { good:'fa-check', neutral:'fa-minus', bad:'fa-xmark' };
  const RATING_WORDS = { good:'Good', neutral:'Okay', bad:'Needs work' };
  const markdownInline = (value) => {
    const code = [];
    let source = esc(value).replace(/`([^`\n]+)`/g, (_match, content) => {
      code.push(content);
      return `\u0000FMCL_CODE_${code.length - 1}\u0000`;
    });
    source = source
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    return source.replace(/\u0000FMCL_CODE_(\d+)\u0000/g, (_match, index) => `<code>${code[Number(index)]}</code>`);
  };
  const renderMarkdown = (raw) => {
    const output = [];
    let list = '';
    let fenced = false;
    let fenceLines = [];
    const closeList = () => { if (list) { output.push(`</${list}>`); list = ''; } };
    const closeFence = () => {
      if (!fenced) return;
      output.push(`<pre><code>${esc(fenceLines.join('\n'))}</code></pre>`);
      fenced = false;
      fenceLines = [];
    };
    String(raw ?? '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        closeList();
        if (fenced) closeFence(); else fenced = true;
        return;
      }
      if (fenced) { fenceLines.push(line); return; }
      const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (bullet || numbered) {
        const nextList = bullet ? 'ul' : 'ol';
        if (list !== nextList) { closeList(); output.push(`<${nextList}>`); list = nextList; }
        const content = (bullet || numbered)[1];
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        output.push(task
          ? `<li class="fmcl-md-task"><i class="fas ${task[1].trim() ? 'fa-square-check' : 'fa-square'}"></i><span>${markdownInline(task[2])}</span></li>`
          : `<li>${markdownInline(content)}</li>`);
      } else if (heading) {
        closeList();
        output.push(`<h${heading[1].length + 2}>${markdownInline(heading[2])}</h${heading[1].length + 2}>`);
      } else if (quote) {
        closeList();
        output.push(`<blockquote>${markdownInline(quote[1])}</blockquote>`);
      } else if (/^([-*_])\1\1+$/.test(trimmed)) {
        closeList();
        output.push('<hr>');
      } else if (!trimmed) {
        closeList();
      } else {
        closeList();
        output.push(`<p>${markdownInline(line)}</p>`);
      }
    });
    closeList();
    closeFence();
    return output.join('');
  };
  const formatMarkdown = (textarea, format) => {
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    const replace = (text, selectStart, selectEnd) => {
      textarea.setRangeText(text, start, end, 'end');
      textarea.focus();
      textarea.setSelectionRange(start + selectStart, start + selectEnd);
      textarea.dispatchEvent(new Event('input', { bubbles:true }));
    };
    const wrap = (before, after, placeholder) => {
      const content = selected || placeholder;
      replace(`${before}${content}${after}`, before.length, before.length + content.length);
    };
    const prefixLines = (prefix) => {
      const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const nextBreak = value.indexOf('\n', end);
      const lineEnd = nextBreak < 0 ? value.length : nextBreak;
      const block = value.slice(lineStart, lineEnd);
      const lines = block.split('\n');
      const replacement = lines.map((line, index) => `${typeof prefix === 'function' ? prefix(index) : prefix}${line}`).join('\n');
      textarea.setSelectionRange(lineStart, lineEnd);
      textarea.setRangeText(replacement, lineStart, lineEnd, 'select');
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles:true }));
    };
    if (format === 'bold') wrap('**', '**', 'bold text');
    else if (format === 'italic') wrap('*', '*', 'italic text');
    else if (format === 'strike') wrap('~~', '~~', 'struck text');
    else if (format === 'code') wrap('`', '`', 'code');
    else if (format === 'link') {
      const label = selected || 'link text';
      const replacement = `[${label}](https://)`;
      replace(replacement, label.length + 3, replacement.length - 1);
    } else if (format === 'heading') prefixLines('### ');
    else if (format === 'bullet') prefixLines('- ');
    else if (format === 'number') prefixLines((index) => `${index + 1}. `);
    else if (format === 'quote') prefixLines('> ');
  };

  const css = `
    .fmcl-panel{height:100%;min-height:0;overflow:hidden}
    .fmcl-shell{height:100%;min-height:0;overflow:hidden;background:#f5f7fa;color:#101828;font-family:inherit}
    .fmcl-page{width:100%;height:100%;min-height:0;box-sizing:border-box;display:flex;flex-direction:column}
    .fmcl-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex:none;flex-wrap:wrap;padding:14px 18px;background:transparent}.fmcl-head-title{min-width:0;display:flex;align-items:center;gap:11px}.fmcl-head-title>i{width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:grid;place-items:center;font-size:15px}.fmcl-head-title strong{font-size:18px;line-height:1.15;font-weight:1000}.fmcl-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .fmcl-content{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;display:grid;gap:16px;align-content:start;padding:14px 18px 18px}
    .fmcl-sub{margin:5px 0 0;color:#667085;font-size:12px;font-weight:800}
    .fmcl-btn{min-height:38px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;box-sizing:border-box;transition:border-color .15s,color .15s,background .15s}
    .fmcl-btn:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary-readable,var(--primary,#d93025))}
    .fmcl-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .fmcl-btn.ghost{background:transparent;border-color:transparent}
    .fmcl-btn.danger{color:#b42318;border-color:#fecdca}
    .fmcl-btn.voice{background:#101828;color:#fff;border-color:#101828}.fmcl-btn.new-audio{width:38px;background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);padding:0}
    .fmcl-btn:disabled{opacity:.45;cursor:not-allowed}
    .fmcl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
    .fmcl-masonry-source{display:contents}
    .fmcl-masonry-column{min-width:0;display:flex;flex-direction:column;gap:14px}
    .fmcl-card{position:relative;width:100%;display:block;min-width:0;border:1px solid rgba(15,23,42,.085);border-radius:18px;background:#fff;box-shadow:0 10px 26px rgba(15,23,42,.05);padding:15px;box-sizing:border-box}.fmcl-card:has(.fmcl-assignment.open),.fmcl-card:has(.fmcl-customer.open){z-index:30}
    .fmcl-cl-head{display:flex;align-items:center;gap:11px}
    .fmcl-cl-icon{width:38px;height:38px;border:0;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center;font-size:13px;flex:none;padding:0;cursor:pointer;transition:background .15s,transform .15s}.fmcl-cl-icon:hover{background:rgba(var(--primary-rgb,217,48,37),.15)}
    .fmcl-cl-copy{min-width:0;flex:1}
    .fmcl-list-title{display:block;width:100%;height:30px;margin:0 -7px;box-sizing:border-box;border:1px solid transparent;border-radius:8px;background:transparent;color:#101828;padding:0 6px;font:inherit;font-size:14px;font-weight:1000;outline:none;cursor:text;transition:border-color .15s,background .15s,box-shadow .15s}.fmcl-list-title:hover{border-color:#d0d5dd;background:#fff}.fmcl-list-title:focus{border-color:var(--primary,#d93025);background:#fff;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}.fmcl-list-title.untitled{border-color:#d0d5dd;color:#98a2b3;font-style:italic}.fmcl-list-title::placeholder{color:#98a2b3;opacity:1}
    .fmcl-cl-copy span{display:block;margin-top:2px;color:#667085;font-size:10px;font-weight:850}
    .fmcl-count{font-size:11px;font-weight:1000;color:#475467;font-variant-numeric:tabular-nums}
    .fmcl-pills{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px;align-items:center}
    .fmcl-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 9px;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.03em;border:0;cursor:default}
    .fmcl-pill.blue{background:#eff8ff;color:#175cd3}
    .fmcl-pill.purple{background:#fdf4ff;color:#9f1ab1}
    .fmcl-pill.toggle{cursor:pointer;transition:background .15s,color .15s}
    .fmcl-pill.toggle.on{background:#ecfdf3;color:#067647}
    .fmcl-card-actions{display:flex;align-items:center;gap:9px;flex-wrap:nowrap;margin-top:8px;padding-top:7px;border-top:1px solid #f0f1f3}.fmcl-menu-wrap{position:relative;display:inline-flex;min-width:0}
    .fmcl-status-tag{display:inline-flex;align-items:center;border-radius:999px;background:#f2f4f7;color:#667085;padding:5px 9px;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}
    .fmcl-config-btn{min-width:0;min-height:25px;border:0;border-radius:6px;background:transparent;color:#475467;padding:0 3px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font:inherit;font-size:9px;font-weight:950;cursor:pointer}
    .fmcl-config-btn:hover,.fmcl-config-btn.open{color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05)}
    .fmcl-config-btn.customer.on{color:#067647}
    .fmcl-config-btn i:last-child{font-size:8px;color:#98a2b3}
    .fmcl-cl-tools{margin-left:auto;display:flex;align-items:center;gap:7px;flex:none}.fmcl-icon-btn.voice-update{width:42px;height:42px;border-radius:12px;border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));font-size:16px}.fmcl-icon-btn.voice-update:hover{border-color:var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.13)}
    .fmcl-assignment{display:none;position:absolute;z-index:40;top:calc(100% + 5px);left:0;width:min(450px,calc(100vw - 54px));border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:8px;gap:7px;box-shadow:0 14px 32px rgba(15,23,42,.16)}
    .fmcl-assignment.open{display:grid}
    .fmcl-assignment-top{display:flex;align-items:center;justify-content:flex-end;margin-bottom:2px}.fmcl-assignment-stack{display:grid;gap:11px}.fmcl-assignment-field{display:grid;gap:5px;min-width:0}
    .fmcl-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px 10px}.fmcl-setting-row>span{min-width:0}.fmcl-setting-row strong{display:block;font-size:10px}.fmcl-setting-row small{display:block;margin-top:2px;color:#667085;font-size:8px;font-weight:800;line-height:1.4}
    .fmcl-switch{width:38px;height:22px;flex:none;border:0;border-radius:999px;background:#d0d5dd;padding:3px;cursor:pointer;transition:background .18s}.fmcl-switch:before{content:"";display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.24);transition:transform .18s}.fmcl-switch.on{background:#12b76a}.fmcl-switch.on:before{transform:translateX(16px)}.fmcl-switch:disabled{opacity:.42;cursor:not-allowed}
    .fmcl-assignees{display:flex;gap:5px;flex-wrap:wrap}
    .fmcl-assignee{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;padding:5px 8px;font:inherit;font-size:9px;font-weight:950;cursor:pointer}
    .fmcl-assignee i{margin-left:4px;color:#98a2b3}
    .fmcl-compact-field{min-width:0;display:grid;gap:5px}.fmcl-compact-label{display:flex;align-items:center;gap:5px;color:#475467;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.035em}.fmcl-help{color:#98a2b3;font-size:9px;cursor:help}.fmcl-compact-toggle{height:34px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:0 9px;display:flex;align-items:center;justify-content:space-between;gap:8px;color:#344054;font-size:10px;font-weight:950}.fmcl-eligibility{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.fmcl-type-chip{border:1px solid #b2ddff;border-radius:999px;background:#eff8ff;color:#175cd3;padding:5px 8px;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:9px;font-weight:950}.fmcl-type-chip button{border:0;background:none;color:inherit;padding:0;cursor:pointer}.fmcl-field-editing{display:inline-flex;align-items:center;gap:8px;color:#475467;font-size:9px;font-weight:950}.fmcl-field-editing .fmcl-switch{transform:scale(.9);transform-origin:right center}
    .fmcl-expand-picker{position:relative;width:27px;height:29px;z-index:1;transition:width .24s cubic-bezier(.22,1,.36,1),z-index 0s .24s}.fmcl-expand-picker.open{width:min(220px,100%);z-index:12;transition:width .24s cubic-bezier(.22,1,.36,1),z-index 0s}.fmcl-expand-trigger{width:100%;height:29px;border:1px dashed #98a2b3;border-radius:999px;background:#fff;color:#667085;padding:0;display:flex;align-items:center;justify-content:center;gap:7px;overflow:hidden;cursor:pointer;font:inherit;font-size:9px;font-weight:950;white-space:nowrap;transition:border-color .2s,background .2s,color .2s}.fmcl-expand-trigger i{flex:none;transition:transform .24s}.fmcl-expand-trigger span{max-width:0;opacity:0;overflow:hidden;transition:max-width .24s cubic-bezier(.22,1,.36,1),opacity .14s}.fmcl-expand-picker.open .fmcl-expand-trigger{justify-content:flex-start;padding:0 10px;border-style:solid;border-color:#b2ddff;background:#eff8ff;color:#175cd3}.fmcl-expand-picker.open .fmcl-expand-trigger i{transform:rotate(45deg)}.fmcl-expand-picker.open .fmcl-expand-trigger span{max-width:160px;opacity:1}.fmcl-picker-options{position:absolute;top:calc(100% + 5px);left:0;width:100%;max-height:190px;overflow:auto;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:4px;box-shadow:0 12px 26px rgba(15,23,42,.16);opacity:0;transform:translateY(-5px) scale(.98);transform-origin:top left;pointer-events:none;transition:opacity .16s,transform .2s cubic-bezier(.22,1,.36,1)}.fmcl-expand-picker.open .fmcl-picker-options{opacity:1;transform:none;pointer-events:auto}.fmcl-picker-options button,.fmcl-picker-empty{width:100%;min-height:30px;border:0;border-radius:7px;background:transparent;color:#344054;padding:6px 8px;display:flex;align-items:center;text-align:left;font:inherit;font-size:9px;font-weight:900;cursor:pointer}.fmcl-picker-options button:hover{background:#f2f4f7;color:#101828}.fmcl-picker-empty{color:#98a2b3;cursor:default}
    .fmcl-customer{display:none;position:absolute;z-index:40;top:calc(100% + 5px);left:0;width:min(320px,calc(100vw - 54px));border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:8px;box-shadow:0 14px 32px rgba(15,23,42,.16)}
    .fmcl-customer.open{display:block}
    .fmcl-customer-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:7px}.fmcl-customer-controls.disabled>*:not(:first-child){opacity:.45;pointer-events:none}
    .fmcl-customer-levels{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.fmcl-customer-levels button{min-height:26px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#667085;padding:0 9px;font:inherit;font-size:9px;font-weight:950;cursor:pointer;white-space:nowrap}.fmcl-customer-levels button.on{border-color:#b2ddff;background:#eff8ff;color:#175cd3}
    .fmcl-icon-btn{width:32px;height:32px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;color:#667085;display:grid;place-items:center;cursor:pointer;transition:color .15s,border-color .15s}
    .fmcl-icon-btn:hover{color:#101828;border-color:#c7ced6}
    .fmcl-icon-btn.danger{color:#b42318}
    .fmcl-items{margin-top:7px;display:grid;gap:3px}
    .fmcl-item{border:1px solid #e4e7ec;border-radius:8px;background:#fff;transition:border-color .2s,background .25s}
    .fmcl-item.done{background:#fbfefc}
    .fmcl-item.bad{border-color:#fecdca}
    .fmcl-item-main{min-height:29px;box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:3px 5px}
    .fmcl-check{width:18px;height:18px;flex:none;border:2px solid #d0d5dd;border-radius:5px;background:#fff;display:grid;place-items:center;color:#fff;font-size:8px;cursor:pointer;padding:0;transition:background .18s,border-color .18s,transform .12s}
    .fmcl-check:active{transform:scale(.88)}
    .fmcl-item.done .fmcl-check{background:#12b76a;border-color:#12b76a}
    .fmcl-check i{opacity:0;transform:scale(.4);transition:opacity .15s,transform .22s cubic-bezier(.34,1.56,.64,1)}
    .fmcl-item.done .fmcl-check i{opacity:1;transform:scale(1)}
    .fmcl-item-copy{min-width:0;flex:1}
    .fmcl-item-copy strong{display:block;font-size:10px;font-weight:950;line-height:1.2}
    .fmcl-item-title{display:flex;align-items:center;gap:3px}.fmcl-title-edit-trigger{width:18px;height:18px;border:0;background:transparent;color:#98a2b3;display:grid;place-items:center;cursor:pointer;opacity:0;font-size:9px;transition:opacity .15s,color .15s}.fmcl-item:hover .fmcl-title-edit-trigger,.fmcl-title-edit-trigger:focus{opacity:1}.fmcl-title-edit-trigger:hover{color:#344054}
    .fmcl-inline-title{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:5px;align-items:center}.fmcl-inline-title input{width:100%;height:31px;border:1px solid #b2ddff;border-radius:8px;padding:0 8px;font:inherit;font-size:12px;font-weight:900;box-sizing:border-box}.fmcl-inline-title button{width:28px;height:28px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;cursor:pointer}
    .fmcl-item.done.is-todo .fmcl-item-copy strong{color:#98a2b3;text-decoration:line-through}
    .fmcl-item-copy span{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:850}
    .fmcl-evidence{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 11px 9px;padding-top:1px}
    .fmcl-evidence-chip{border:1px solid #e4e7ec;border-radius:999px;background:#f8fafc;color:#475467;min-height:27px;padding:0 9px;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:9px;font-weight:950;cursor:pointer}
    .fmcl-evidence-chip.met{border-color:#abefc6;background:#ecfdf3;color:#067647}
    .fmcl-evidence-chip i{font-size:10px}
    .fmcl-evidence-count{font-variant-numeric:tabular-nums}
    .fmcl-evidence-recorder:empty{display:none}
    .fmcl-item-action{width:23px;height:23px;border:0;background:transparent;border-radius:6px;padding:0;font-size:10px}.fmcl-item-action:hover{border-color:transparent;background:#f2f4f7}.fmcl-item-tools{display:flex;gap:0;opacity:.48;transition:opacity .15s}.fmcl-item:hover .fmcl-item-tools,.fmcl-item-tools:focus-within{opacity:1}.fmcl-evidence-button.active{background:#fffaeb;color:#b54708}.fmcl-evidence-button.has-files:not(.active){color:#067647}.fmcl-evidence-dot{width:5px;height:5px;border-radius:50%;background:#f79009}
    .fmcl-evidence-drawer{display:none;border-top:1px solid #eaecf0;background:#f8fafc;padding:11px}.fmcl-evidence-drawer.open{display:grid;gap:10px}.fmcl-evidence-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fmcl-evidence-title strong{font-size:11px}.fmcl-evidence-title span{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:800}
    .fmcl-requirement-grid{display:grid;gap:7px}.fmcl-requirement-row{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px}.fmcl-requirement-main{display:flex;align-items:center;justify-content:space-between;gap:10px}.fmcl-requirement-main strong{font-size:10px}.fmcl-requirement-main span{display:block;margin-top:2px;color:#667085;font-size:8px;font-weight:800}.fmcl-media-kinds{display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #eaecf0}.fmcl-check-option{display:flex;align-items:center;gap:5px;color:#475467;font-size:9px;font-weight:900}.fmcl-check-option input{accent-color:var(--primary,#d93025)}
    .fmcl-evidence-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.fmcl-evidence-files{display:flex;gap:5px;flex-wrap:wrap}.fmcl-file-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:5px 8px;font-size:8px;font-weight:900}
    .fmcl-rate{display:inline-flex;flex:none;border:1px solid #e4e7ec;border-radius:999px;padding:1px;gap:1px;background:#f8fafc}
    .fmcl-rate button{width:23px;height:19px;border:0;border-radius:999px;background:transparent;color:#98a2b3;display:grid;place-items:center;font-size:9px;cursor:pointer;padding:0;transition:background .18s,color .18s,transform .12s}
    .fmcl-rate button:active{transform:scale(.9)}
    .fmcl-rate button.on[data-fmcl-rate=good]{background:#12b76a;color:#fff}
    .fmcl-rate button.on[data-fmcl-rate=neutral]{background:#f79009;color:#fff}
    .fmcl-rate button.on[data-fmcl-rate=bad]{background:#d92d20;color:#fff}
    .fmcl-note-line{display:flex;gap:7px;align-items:flex-start;margin:0 11px 9px;padding:8px 10px;border-radius:10px;background:#f8fafc;color:#475467;font-size:11px;font-weight:800;line-height:1.45;cursor:pointer}.fmcl-note-line>i{margin-top:3px;flex:none}.fmcl-note-line .fmcl-markdown{min-width:0;flex:1}
    .fmcl-item.bad .fmcl-note-line{background:#fef3f2;color:#b42318}
    .fmcl-drawer{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.22,1,.36,1)}
    .fmcl-drawer.open{grid-template-rows:1fr}
    .fmcl-drawer>div{overflow:hidden}
    .fmcl-drawer-inner{display:grid;gap:8px;padding:2px 11px 11px}
    .fmcl-note-editor{overflow:hidden;border:1px solid #d0d5dd;border-radius:11px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.03);transition:border-color .15s,box-shadow .15s}.fmcl-note-editor:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}
    .fmcl-md-toolbar{min-height:34px;padding:3px 5px;display:flex;align-items:center;gap:2px;border-bottom:1px solid #eaecf0;background:#f8fafc}.fmcl-md-tools{display:flex;align-items:center;gap:1px;min-width:0;overflow-x:auto}.fmcl-md-tool{width:27px;height:27px;flex:none;border:0;border-radius:6px;background:transparent;color:#667085;display:grid;place-items:center;padding:0;font-size:10px;cursor:pointer}.fmcl-md-tool:hover,.fmcl-md-tool:focus-visible{background:#e9edf3;color:#101828;outline:none}.fmcl-md-tool strong,.fmcl-md-tool em{font-size:11px}.fmcl-md-divider{width:1px;height:17px;background:#d0d5dd;margin:0 3px;flex:none}.fmcl-md-modes{margin-left:auto;display:inline-flex;flex:none;padding:2px;border-radius:7px;background:#eaecf0}.fmcl-md-mode{height:23px;border:0;border-radius:5px;background:transparent;color:#667085;padding:0 7px;font:inherit;font-size:8px;font-weight:950;cursor:pointer}.fmcl-md-mode.on{background:#fff;color:#101828;box-shadow:0 1px 2px rgba(16,24,40,.12)}
    .fmcl-note-editor textarea{display:block;width:100%;box-sizing:border-box;border:0;padding:10px 11px;background:#fff;color:#101828;font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;font-weight:600;line-height:1.55;min-height:94px;resize:vertical;outline:none}.fmcl-note-editor textarea::placeholder{color:#98a2b3;font-family:inherit}
    .fmcl-md-preview{min-height:94px;box-sizing:border-box;padding:10px 11px;background:#fff}.fmcl-md-empty{height:72px;display:grid;place-items:center;color:#98a2b3;font-size:10px;font-weight:800}
    .fmcl-markdown{overflow-wrap:anywhere}.fmcl-markdown p{margin:0 0 5px}.fmcl-markdown p:last-child{margin-bottom:0}.fmcl-markdown ul,.fmcl-markdown ol{margin:2px 0 6px;padding-left:20px}.fmcl-markdown li{margin:1px 0}.fmcl-markdown h3,.fmcl-markdown h4,.fmcl-markdown h5,.fmcl-markdown h6{margin:5px 0 3px;color:#101828;font-size:1em;line-height:1.3}.fmcl-markdown h3{font-size:1.16em}.fmcl-markdown strong{font-weight:1000}.fmcl-markdown a{color:#175cd3;text-decoration:underline;text-underline-offset:2px}.fmcl-markdown code{border-radius:4px;background:#eaecf0;padding:1px 4px;color:#344054;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}.fmcl-markdown pre{overflow:auto;margin:4px 0 6px;border-radius:7px;background:#101828;padding:8px;color:#f2f4f7}.fmcl-markdown pre code{background:transparent;color:inherit;padding:0}.fmcl-markdown blockquote{margin:3px 0 6px;border-left:3px solid #b2ddff;padding:3px 0 3px 8px;color:#475467}.fmcl-markdown hr{height:1px;border:0;background:#e4e7ec;margin:7px 0}.fmcl-markdown .fmcl-md-task{display:flex;align-items:flex-start;gap:5px;list-style:none;margin-left:-16px}.fmcl-markdown .fmcl-md-task i{margin-top:3px;color:#667085}
    .fmcl-md-help{display:flex;align-items:center;gap:5px;color:#98a2b3;font-size:9px;font-weight:800;margin-right:auto}.fmcl-md-help i{font-size:9px}
    .fmcl-drawer-hint{color:#b42318;font-size:10px;font-weight:900}
    .fmcl-drawer-actions{display:flex;justify-content:flex-end;gap:7px}
    .fmcl-card-body{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .26s cubic-bezier(.22,1,.36,1),opacity .18s ease}.fmcl-card-body-inner{min-height:0;overflow:visible}.fmcl-card.collapsed .fmcl-card-body{grid-template-rows:0fr;opacity:0}.fmcl-card.collapsed .fmcl-card-body-inner{overflow:hidden}
    .fmcl-card.deleted{background:#f8fafc;border-style:dashed;box-shadow:none}.fmcl-card.deleted .voice-update,.fmcl-card.deleted .fmcl-menu-wrap,.fmcl-card.deleted [data-fmcl-cl-delete],.fmcl-card.deleted .fmcl-add,.fmcl-card.deleted .fmcl-item-action,.fmcl-card.deleted .fmcl-title-edit-trigger{display:none}.fmcl-card.deleted .fmcl-check,.fmcl-card.deleted .fmcl-rate{pointer-events:none;opacity:.65}.fmcl-card.deleted .fmcl-list-title{cursor:default;color:#667085}.fmcl-cl-copy .fmcl-deleted-tag{display:inline-flex;align-items:center;gap:5px;margin:2px 0 0 0;color:#b42318;font-size:9px;font-weight:950}
    .fmcl-add{margin-top:8px;display:flex;gap:6px;align-items:center}
    .fmcl-add input{flex:1;min-width:0;height:36px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;padding:0 11px;font:inherit;font-size:12px;font-weight:850;outline:none}
    .fmcl-add input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}
    .fmcl-item-type-toggle{height:32px;display:inline-flex;align-items:center;border:1px solid #d0d5dd;border-radius:9px;background:#f2f4f7;padding:2px;box-sizing:border-box}.fmcl-item-type-toggle button{height:26px;border:0;border-radius:7px;background:transparent;color:#667085;padding:0 8px;font:inherit;font-size:9px;font-weight:950;cursor:pointer}.fmcl-item-type-toggle button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.13)}
    .fmcl-tabs{display:flex;align-items:center;gap:6px;overflow-x:auto;flex:none;margin:12px 18px 0;padding:1px 0 3px;scrollbar-width:thin}
    .fmcl-tab{height:34px;max-width:210px;flex:none;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#667085;padding:0 11px;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:10px;font-weight:950;white-space:nowrap;cursor:pointer}
    .fmcl-tab span{overflow:hidden;text-overflow:ellipsis}.fmcl-tab.active{border-color:#101828;background:#101828;color:#fff}
    .fmcl-grid.detail{display:block}.fmcl-grid.detail .fmcl-card{display:block;width:100%}.fmcl-card.detail .fmcl-items{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.fmcl-card.detail .fmcl-add{max-width:620px}
    .fmcl-empty-voice{min-height:180px;margin-top:9px;border:1px dashed rgba(var(--primary-rgb,217,48,37),.32);border-radius:14px;background:linear-gradient(145deg,rgba(var(--primary-rgb,217,48,37),.035),#fff);display:grid;place-items:center;padding:18px;box-sizing:border-box}.fmcl-empty-voice-inner{display:grid;justify-items:center;gap:10px;text-align:center;color:#475467;font-size:12px;font-weight:900}.fmcl-empty-voice-button{width:72px;height:72px;border:0;border-radius:22px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:27px;cursor:pointer;box-shadow:0 13px 28px rgba(var(--primary-rgb,217,48,37),.22)}.fmcl-empty-voice-mount{width:100%}.fmcl-empty-voice:has(.fm-an-inline) .fmcl-empty-voice-inner,.fmcl-empty-voice:has(.fm-as-processing) .fmcl-empty-voice-inner{display:none}
    .fmcl-field{display:grid;gap:5px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}
    .fmcl-field input,.fmcl-field select{height:38px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#101828;padding:0 10px;font:inherit;font-size:12px;font-weight:850;text-transform:none;letter-spacing:0;outline:none}
    .fmcl-state{min-height:150px;display:grid;place-items:center;color:#667085;text-align:center;padding:24px}
    .fmcl-state>div{display:grid;justify-items:center;gap:8px}
    .fmcl-voice-mount:empty{display:none}
    .fmcl-voice-mount{margin-top:10px}
    .fm-as-processing{min-height:54px;border:1px solid #d0d5dd;border-radius:13px;background:#fff;display:flex;align-items:center;justify-content:center;gap:9px;color:#344054;font-size:11px;font-weight:950}
    .fmcl-spinner{width:24px;height:24px;border:3px solid #e4e7ec;border-top-color:var(--primary,#d93025);border-radius:999px;animation:fmcl-spin .8s linear infinite}
    @keyframes fmcl-spin{to{transform:rotate(360deg)}}
    @media(max-width:900px){.fmcl-card.detail .fmcl-items{grid-template-columns:1fr}}
    @media(max-width:760px){.fmcl-grid{grid-template-columns:1fr}.fmcl-card-actions{flex-wrap:wrap}.fmcl-head-actions{width:100%}.fmcl-head-actions .fmcl-btn.primary{flex:1}}
  `;
  Portal.util?.injectCSS?.('checklists_app', css);

  function stateHtml(kind = 'loading', message = ''){
    if (kind === 'loading') return `<div class="fmcl-state"><div><span class="fmcl-spinner"></span><strong>${esc(message || 'Loading checklists')}</strong></div></div>`;
    return `<div class="fmcl-state"><div><i class="fas ${kind === 'error' ? 'fa-triangle-exclamation' : 'fa-list-check'}" style="font-size:24px;color:${kind === 'error' ? '#b42318' : '#98a2b3'}"></i><strong>${esc(message || 'Nothing here yet.')}</strong></div></div>`;
  }

  function mountChecklists(context = {}){
    const outer = context.roots?.main || context.mainRoot || context.root;
    const root = outer?.querySelector?.('[data-fmcl-app]') || outer;
    if (!root) return { destroy(){} };
    let destroyed = false;
    let data = null;
    let focusChecklistId = '';
    let preferredChecklistId = '';
    let scrollNewChecklistToTop = false;
    let resizeTimer = 0;
    let activeView = clean(Portal.navigation?.read?.()?.checklistView) || 'all';
    const noteState = {};
    const assignmentState = {};
    const customerState = {};
    const checklistState = {};
    const state = (id) => noteState[id] || (noteState[id] = {
      open:false,
      draft:null,
      pendingRating:'',
      hint:false,
      focus:false,
      preview:false,
      evidenceOpen:false,
      editingTitle:false,
      titleDraft:''
    });
    const assignment = (id) => assignmentState[id] || (assignmentState[id] = { open:false, loading:false, loaded:false, eligibilityPickerOpen:false, personPickerOpen:false, subjects:[], catalog:[], roles:[], error:'' });
    const customerUi = (id) => customerState[id] || (customerState[id] = { open:false });
    const checklistUi = (id) => checklistState[id] || (checklistState[id] = { collapsed:false });
    const checklists = () => arr(data?.checklists);
    const deletedChecklists = () => arr(data?.deleted_checklists);
    const orderedChecklists = () => checklists().map((checklist, index) => ({ checklist, index })).sort((left, right) => {
      if (left.checklist.id === preferredChecklistId) return -1;
      if (right.checklist.id === preferredChecklistId) return 1;
      const leftCreated = Date.parse(first(left.checklist.created_at, left.checklist.createdAt)) || 0;
      const rightCreated = Date.parse(first(right.checklist.created_at, right.checklist.createdAt)) || 0;
      return rightCreated - leftCreated || left.index - right.index;
    }).map((entry) => entry.checklist);

    const itemSubtitle = (item) => {
      if (!item.completed) return '';
      const label = item.item_type === 'rating' ? (RATING_WORDS[item.rating] || 'Rated') : 'Done';
      const who = clean(item.completed_by_name) || clean(item.completed_by_user_id);
      return [label, who, shortDate(item.completed_at)].filter(Boolean).join(' · ');
    };

    const patchItem = async (checklistId, itemId, patch) => {
      const result = await window.CrewAPI.projects.updateItemInChecklist(orgId(context), projectId(context), checklistId, itemId, patch);
      const list = checklists().find((entry) => entry.id === checklistId);
      const index = arr(list?.items).findIndex((entry) => entry.id === itemId);
      if (list && index >= 0) {
        const previous = list.items[index];
        const updated = { ...obj(result.item) };
        updated.completed_by_name = updated.completed_by_user_id && updated.completed_by_user_id === userId(context)
          ? clean(first(Portal.currentUser?.name, 'You'))
          : (updated.completed_by_user_id === previous.completed_by_user_id ? previous.completed_by_name : '');
        list.items[index] = updated;
      }
      render();
    };

    const itemHtml = (checklist, item) => {
      const rating = item.item_type === 'rating';
      const drawer = state(item.id);
      const classes = ['fmcl-item', item.completed ? 'done' : '', rating ? (item.rating === 'bad' ? 'bad' : '') : 'is-todo'].filter(Boolean).join(' ');
      const control = rating
        ? `<div class="fmcl-rate">${['good','neutral','bad'].map((value) => `<button type="button" data-fmcl-rate="${value}" class="${item.rating === value ? 'on' : ''}" aria-label="${esc(RATING_WORDS[value])}"><i class="fas ${RATING_ICONS[value]}"></i></button>`).join('')}</div>`
        : '';
      const check = rating ? '' : `<button type="button" class="fmcl-check" data-fmcl-toggle aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_892c2703c8b0d7","Complete item") ?? "Complete item")}"><i class="fas fa-check"></i></button>`;
      const noteButton = ("<button class=\"fmcl-icon-btn fmcl-item-action\" type=\"button\" data-fmcl-note-open aria-label=\"" + (globalThis.PlatformLanguage?.text("checklists","m_2badf4ec55e985","Add a note") ?? "Add a note") + "\" title=\"" + (globalThis.PlatformLanguage?.text("checklists","m_2badf4ec55e985","Add a note") ?? "Add a note") + "\" data-fm-tooltip=\"Add a note\" style=\"" + String(item.note ? 'color:#175cd3;' : '') + "\"><i class=\"fas fa-comment" + String(item.note ? '' : '-medical') + "\"></i></button>");
      const noteLine = item.note && !drawer.open ? `<div class="fmcl-note-line" data-fmcl-note-open><i class="fas fa-comment"></i><div class="fmcl-markdown">${renderMarkdown(item.note)}</div></div>` : '';
      const requireNote = (drawer.pendingRating || item.rating) === 'bad';
      const noteDraft = String(drawer.draft ?? item.note ?? '');
      const markdownTools = [
        ['heading', 'fa-heading', 'Heading'], ['bold', 'fa-bold', 'Bold (Ctrl+B)'], ['italic', 'fa-italic', 'Italic (Ctrl+I)'],
        ['strike', 'fa-strikethrough', 'Strike-through'], ['bullet', 'fa-list-ul', 'Bulleted list'], ['number', 'fa-list-ol', 'Numbered list'],
        ['quote', 'fa-quote-left', 'Quote'], ['code', 'fa-code', 'Inline code'], ['link', 'fa-link', 'Link (Ctrl+K)']
      ].map(([format, icon, label], index) => `${index === 4 || index === 7 ? '<span class="fmcl-md-divider"></span>' : ''}<button class="fmcl-md-tool" type="button" data-fmcl-md="${format}" aria-label="${label}" title="${label}" data-fm-tooltip="${label}"><i class="fas ${icon}"></i></button>`).join('');
      const editorBody = drawer.preview
        ? `<div class="fmcl-md-preview fmcl-markdown">${clean(noteDraft) ? renderMarkdown(noteDraft) : `<div class="fmcl-md-empty">${(globalThis.PlatformLanguage?.text("checklists","m_62ba08942f1514","Nothing to preview yet.") ?? "Nothing to preview yet.")}</div>`}</div>`
        : `<textarea data-fmcl-note spellcheck="true" placeholder="${requireNote ? 'Describe what needs attention…' : 'Add a note using Markdown…'}">${esc(noteDraft)}</textarea>`;
      const drawerHtml = `<div class="fmcl-drawer ${String(drawer.open ? 'open' : '')}"><div><div class="fmcl-drawer-inner">
        <div class="fmcl-note-editor">
          <div class="fmcl-md-toolbar" role="toolbar" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_d78d0fabcb7532","Note formatting") ?? "Note formatting")}"><div class="fmcl-md-tools" ${String(drawer.preview ? 'hidden' : '')}>${String(markdownTools)}</div><div class="fmcl-md-modes"><button class="fmcl-md-mode ${String(drawer.preview ? '' : 'on')}" type="button" data-fmcl-md-view="write">${(globalThis.PlatformLanguage?.text("checklists","m_c760a381a3956a","Write") ?? "Write")}</button><button class="fmcl-md-mode ${String(drawer.preview ? 'on' : '')}" type="button" data-fmcl-md-view="preview">${(globalThis.PlatformLanguage?.text("checklists","m_afff48796c3165","Preview") ?? "Preview")}</button></div></div>
          ${String(editorBody)}
        </div>
        ${String(drawer.hint ? '<div class="fmcl-drawer-hint">A note is required before this item can be marked bad.</div>' : '')}
        <div class="fmcl-drawer-actions"><span class="fmcl-md-help"><i class="fab fa-markdown"></i>${(globalThis.PlatformLanguage?.text("checklists","m_e2760453b83d6f"," Markdown supported") ?? " Markdown supported")}</span><button class="fmcl-btn ghost" type="button" data-fmcl-note-cancel>${(globalThis.PlatformLanguage?.text("checklists","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="fmcl-btn primary" type="button" data-fmcl-note-save>${String(drawer.pendingRating ? 'Save rating' : 'Save note')}</button></div>
      </div></div></div>`;
      const metadata = obj(item.metadata);
      const requirements = arr(metadata.required_attachments);
      const attachments = arr(metadata.attachments);
      const mediaRequirement = requirements.find((entry) => clean(entry.kind) === 'media' || arr(entry.allowed_kinds).some((kind) => ['photo','video'].includes(clean(kind))))
        || requirements.find((entry) => ['photo','video'].includes(clean(entry.kind)));
      const documentRequirement = requirements.find((entry) => clean(entry.kind) === 'document');
      const audioRequirement = requirements.find((entry) => clean(entry.kind) === 'audio');
      const mediaAllowed = mediaRequirement
        ? (arr(mediaRequirement.allowed_kinds).length ? arr(mediaRequirement.allowed_kinds).map(clean) : [clean(mediaRequirement.kind) === 'video' ? 'video' : 'photo', 'video'])
        : ['photo','video'];
      const countFor = (requirement) => requirement
        ? attachments.filter((attachment) => !requirement.id || !attachment.requirement_id || attachment.requirement_id === requirement.id).length
        : 0;
      const titleHtml = drawer.editingTitle
        ? `<div class="fmcl-inline-title"><input data-fmcl-title-input value="${String(esc(drawer.titleDraft || item.title))}" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_6ba9f4c970b98a","Checklist item title") ?? "Checklist item title")}"><button type="button" data-fmcl-title-save aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_355f235735b2c7","Save item") ?? "Save item")}"><i class="fas fa-check"></i></button><button type="button" data-fmcl-title-cancel aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_7bb3394461ca4a","Cancel item edit") ?? "Cancel item edit")}"><i class="fas fa-xmark"></i></button></div>`
        : `<div class="fmcl-item-title"><strong>${String(esc(first(item.title, 'Checklist item')))}</strong><button class="fmcl-title-edit-trigger" type="button" data-fmcl-title-edit aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_a53b7016b47ef5","Edit item") ?? "Edit item")}"><i class="fas fa-pen"></i></button></div>`;
      const evidenceDrawer = `<div class="fmcl-evidence-drawer ${String(drawer.evidenceOpen ? 'open' : '')}" data-fmcl-evidence-drawer>
        <div class="fmcl-evidence-title"><div><strong>${(globalThis.PlatformLanguage?.text("checklists","m_22d6acf47e2b46","Evidence and requirements") ?? "Evidence and requirements")}</strong><span>${(globalThis.PlatformLanguage?.text("checklists","m_5bb1ac146b4ed0","Choose accepted evidence types and attach proof from the same place.") ?? "Choose accepted evidence types and attach proof from the same place.")}</span></div><button class="fmcl-icon-btn" type="button" data-fmcl-evidence-close aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_c6a90fd1f43087","Close evidence settings") ?? "Close evidence settings")}"><i class="fas fa-xmark"></i></button></div>
        <div class="fmcl-requirement-grid">
          <div class="fmcl-requirement-row"><div class="fmcl-requirement-main"><span><strong>${(globalThis.PlatformLanguage?.text("checklists","m_67ee91a7366dbe","Require media") ?? "Require media")}</strong><span>${(globalThis.PlatformLanguage?.text("checklists","m_170d8a175669ea","Customer or field user must attach a photo or video.") ?? "Customer or field user must attach a photo or video.")}</span></span><button class="fmcl-switch ${String(mediaRequirement ? 'on' : '')}" type="button" data-fmcl-requirement-toggle="media" aria-pressed="${String(!!mediaRequirement)}"></button></div>${String(mediaRequirement ? `<div class="fmcl-media-kinds"><label class="fmcl-check-option"><input type="checkbox" data-fmcl-media-kind="photo" ${mediaAllowed.includes('photo') ? 'checked' : ''}> Photos</label><label class="fmcl-check-option"><input type="checkbox" data-fmcl-media-kind="video" ${mediaAllowed.includes('video') ? 'checked' : ''}> Videos</label><span class="fmcl-sub" style="margin-left:auto">${countFor(mediaRequirement)}/1 attached</span></div>` : '')}</div>
          <div class="fmcl-requirement-row"><div class="fmcl-requirement-main"><span><strong>${(globalThis.PlatformLanguage?.text("checklists","m_3da85b9b7dac86","Require document") ?? "Require document")}</strong><span>${(globalThis.PlatformLanguage?.text("checklists","m_d45bc06e1c924d","PDF, Word, spreadsheet, or another document.") ?? "PDF, Word, spreadsheet, or another document.")}</span></span><button class="fmcl-switch ${String(documentRequirement ? 'on' : '')}" type="button" data-fmcl-requirement-toggle="document" aria-pressed="${String(!!documentRequirement)}"></button></div>${String(documentRequirement ? `<span class="fmcl-sub">${countFor(documentRequirement)}/1 attached</span>` : '')}</div>
          <div class="fmcl-requirement-row"><div class="fmcl-requirement-main"><span><strong>${(globalThis.PlatformLanguage?.text("checklists","m_d2e13e894b6086","Require audio") ?? "Require audio")}</strong><span>${(globalThis.PlatformLanguage?.text("checklists","m_7a5dae00b3de2b","A recorded voice explanation or uploaded audio file.") ?? "A recorded voice explanation or uploaded audio file.")}</span></span><button class="fmcl-switch ${String(audioRequirement ? 'on' : '')}" type="button" data-fmcl-requirement-toggle="audio" aria-pressed="${String(!!audioRequirement)}"></button></div>${String(audioRequirement ? `<span class="fmcl-sub">${countFor(audioRequirement)}/1 attached</span>` : '')}</div>
        </div>
        <div class="fmcl-evidence-actions"><button class="fmcl-btn" type="button" data-fmcl-attach-evidence><i class="fas fa-paperclip"></i>${(globalThis.PlatformLanguage?.text("checklists","m_175426b21cddb4"," Attach evidence") ?? " Attach evidence")}</button>${String(audioRequirement ? '<button class="fmcl-btn" type="button" data-fmcl-record-evidence><i class="fas fa-microphone"></i> Record audio</button>' : '')}<input type="file" hidden data-fmcl-evidence-input><div class="fmcl-evidence-recorder" data-fmcl-evidence-recorder></div></div>
        ${String(attachments.length ? `<div class="fmcl-evidence-files">${attachments.map((attachment) => `<span class="fmcl-file-chip"><i class="fas fa-paperclip"></i> ${esc(first(attachment.file_name, attachment.kind, 'Evidence'))}</span>`).join('')}</div>` : '<span class="fmcl-sub">No evidence attached yet.</span>')}
      </div>`;
      return `<div class="${String(classes)}" data-fmcl-item="${String(esc(checklist.id))}::${String(esc(item.id))}"><div class="fmcl-item-main">${String(check)}<div class="fmcl-item-copy">${String(titleHtml)}${String(itemSubtitle(item) ? `<span>${esc(itemSubtitle(item))}</span>` : '')}</div>${String(control)}${String(noteButton)}<span class="fmcl-item-tools"><button class="fmcl-icon-btn fmcl-item-action fmcl-evidence-button ${String(drawer.evidenceOpen ? 'active' : '')} ${String(attachments.length ? 'has-files' : '')}" type="button" data-fmcl-evidence-open aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_22d6acf47e2b46","Evidence and requirements") ?? "Evidence and requirements")}" title="${(globalThis.PlatformLanguage?.text("checklists","m_22d6acf47e2b46","Evidence and requirements") ?? "Evidence and requirements")}"><i class="fas fa-paperclip"></i>${String(requirements.length ? '<span class="fmcl-evidence-dot"></span>' : '')}</button><button class="fmcl-icon-btn fmcl-item-action danger" type="button" data-fmcl-item-delete aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_aaf8dbee05f91a","Delete item") ?? "Delete item")}" title="${(globalThis.PlatformLanguage?.text("checklists","m_aaf8dbee05f91a","Delete item") ?? "Delete item")}"><i class="fas fa-trash"></i></button></span></div>${String(evidenceDrawer)}${String(noteLine)}${String(drawerHtml)}</div>`;
    };

    const checklistHtml = (checklist, detail = false, order = 0, deleted = false) => {
      const items = arr(checklist.items);
      const doneCount = items.filter((item) => item.completed).length;
      const assignmentUi = assignment(checklist.id);
      const policy = obj(checklist.assignment_policy);
      const assignedUsers = arr(checklist.assigned_user_ids);
      const assignedRoles = arr(checklist.assigned_role_ids);
      const assignedGroups = arr(checklist.assigned_resource_group_ids);
      const specificCount = assignedUsers.length + assignedGroups.length;
      const currentUserAssigned = assignedUsers.length === 1 && assignedUsers[0] === userId(context) && !assignedGroups.length;
      const eligibility = assignmentEligibility(policy, assignedRoles);
      const roleRows = records(assignmentUi.roles, 'roles', 'access_roles', 'documents', 'items').map((entry) => ({ ...obj(entry?.data), ...obj(entry) }));
      const roleLabels = new Map(roleRows.map((role) => [clean(first(role.id, role.role_id)), first(role.name, role.label, labelize(first(role.id, role.role_id)))]).filter(([id]) => id));
      const groupKinds = new Map();
      arr(assignmentUi.catalog).filter((subject) => clean(subject.subject_type) === 'resource_group').forEach((subject) => {
        const id = clean(first(subject.group_kind_id, subject.kind_id));
        if (id && !groupKinds.has(id)) groupKinds.set(id, first(subject.group_kind_name, subject.kind_name, subject.group_kind_label, labelize(id)));
      });
      const tokenLabel = (token) => {
        const [type, id] = token.split(':');
        if (type === 'role') return first(roleLabels.get(id), labelize(id));
        if (type === 'group') return `Any ${first(groupKinds.get(id), labelize(id))}`;
        if (id === 'organization_user') return 'Any person';
        if (id === 'resource_group') return 'Any group';
        if (id === 'organization_connection') return 'Any subcontractor';
        return labelize(id);
      };
      const assignmentLabel = specificCount
        ? (currentUserAssigned ? "I'm assigned" : `${specificCount} assigned`)
        : eligibility.tokens.length === 1 ? tokenLabel(eligibility.tokens[0])
          : eligibility.tokens.length ? `${eligibility.tokens.length} eligible types` : 'Everyone';
      const selectedSubjects = new Set([...assignedUsers.map((id) => `organization_user:${id}`), ...assignedGroups.map((id) => `resource_group:${id}`)]);
      const subjectChoices = arr(assignmentUi.subjects)
        .filter((subject) => clean(subject.subject_type) === 'organization_user' && !selectedSubjects.has(`${subject.subject_type}:${subject.id}`))
        .map((subject) => ({ value:`${subject.subject_type}:${subject.id}`, label:subject.id === userId(context) ? "I'm assigned" : first(subject.name, subject.user?.name, subject.title, subject.id) }));
      const assigneeChips = [
        ...assignedUsers.map((id) => ({ type:'organization_user', id, label:id === userId(context) ? "I'm assigned" : first(obj(checklist.assigned_user_names)[id], id) })),
        ...assignedGroups.map((id) => ({ type:'resource_group', id, label:first(obj(checklist.assigned_resource_group_names)[id], id) }))
      ].map((entry) => `<button class="fmcl-assignee" type="button" data-fmcl-unassign="${esc(entry.type)}:${esc(entry.id)}">${esc(entry.label)}<i class="fas fa-xmark"></i></button>`).join('');
      const selectedTokens = new Set(eligibility.tokens);
      const eligibilityOptions = [
        ...roleRows.filter((role) => clean(first(role.status, 'active')) !== 'archived').map((role) => ({ token:`role:${clean(first(role.id, role.role_id))}`, label:first(role.name, role.label, labelize(first(role.id, role.role_id))) })),
        ...[...groupKinds].map(([id, label]) => ({ token:`group:${id}`, label:((v0) => globalThis.PlatformLanguage?.text("checklists","m_87360d11b84f32",`Any ${v0}`,{v0}) ?? `Any ${v0}`)(label) })),
        { token:'subject:organization_user', label:(globalThis.PlatformLanguage?.text("checklists","m_0c0dbcd34d342b","Any person") ?? "Any person") },
        { token:'subject:resource_group', label:(globalThis.PlatformLanguage?.text("checklists","m_7d1c70fae3b92e","Any group") ?? "Any group") },
        { token:'subject:organization_connection', label:(globalThis.PlatformLanguage?.text("checklists","m_0694300cbbf617","Any subcontractor") ?? "Any subcontractor") }
      ].filter((option, index, options) => option.token && !selectedTokens.has(option.token) && options.findIndex((entry) => entry.token === option.token) === index);
      const eligibilityChips = eligibility.tokens.map((token) => `<span class="fmcl-type-chip">${String(esc(tokenLabel(token)))}<button type="button" data-fmcl-eligibility-remove="${String(esc(token))}" aria-label="${((v2) => globalThis.PlatformLanguage?.text("checklists","m_b44c243626b37c",`Remove ${v2}`,{v2}) ?? `Remove ${v2}`)(esc(tokenLabel(token)))}"><i class="fas fa-xmark"></i></button></span>`).join('');
      const customer = obj(checklist.customer_access);
      const customerPanel = customerUi(checklist.id);
      const sharedWithCustomer = customer.visible === true;
      const customerLevel = !sharedWithCustomer ? '' : customer.can_edit_items ? 'edit' : customer.can_complete ? 'complete' : 'view';
      const customerLabel = customerLevel ? `Customer can: ${customerLevel === 'view' ? 'View' : customerLevel === 'complete' ? 'Complete' : 'Edit'}` : 'No customer access';
      const untitled = clean(checklist.title).toLowerCase() === 'untitled checklist';
      const collapsed = checklistUi(checklist.id).collapsed;
      return `<section class="fmcl-card ${String(detail ? 'detail' : '')} ${String(collapsed ? 'collapsed' : '')} ${String(deleted ? 'deleted' : '')}" data-fmcl-list="${String(esc(checklist.id))}" data-fmcl-order="${String(order)}" data-fmcl-deleted="${String(deleted)}">
        <div class="fmcl-cl-head"><button class="fmcl-cl-icon" type="button" data-fmcl-collapse aria-expanded="${String(!collapsed)}" aria-label="${((v7) => globalThis.PlatformLanguage?.text("checklists","m_ce48bcc0fd78ab",`${v7} checklist`,{v7}) ?? `${v7} checklist`)(collapsed ? 'Expand' : 'Collapse')}" title="${String(collapsed ? 'Expand checklist' : 'Collapse checklist')}"><i class="fas ${String(collapsed ? 'fa-chevron-down' : 'fa-chevron-up')}"></i></button><div class="fmcl-cl-copy"><input class="fmcl-list-title ${String(untitled ? 'untitled' : '')}" data-fmcl-rename value="${String(untitled ? '' : esc(checklist.title))}" placeholder="${(globalThis.PlatformLanguage?.text("checklists","m_9054974500fee9","Untitled…") ?? "Untitled…")}" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_3bf1f1282b3808","Checklist title") ?? "Checklist title")}" title="${String(deleted ? 'Deleted checklist' : 'Click to rename')}" ${String(deleted ? 'readonly' : '')}>${String(deleted ? `<span class="fmcl-deleted-tag"><i class="fas fa-trash"></i> Deleted ${esc(shortDate(checklist.deleted_at))}</span>` : '')}</div><span class="fmcl-cl-tools"><button class="fmcl-icon-btn voice-update" type="button" data-fmcl-voice-update aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_b794aea060fc8f","Update checklist by voice") ?? "Update checklist by voice")}" title="${(globalThis.PlatformLanguage?.text("checklists","m_8f89b708111629","Update by voice") ?? "Update by voice")}"><i class="fas fa-microphone"></i></button></span></div>
        <div class="fmcl-card-body"><div class="fmcl-card-body-inner">
          <div class="fmcl-card-actions">
            <span class="fmcl-menu-wrap"><button class="fmcl-config-btn ${String(assignmentUi.open ? 'open' : '')}" type="button" data-fmcl-assign><i class="fas fa-user-group"></i>${((v16) => globalThis.PlatformLanguage?.text("checklists","m_467cf3556084e7",` Completes: ${v16} `,{v16}) ?? ` Completes: ${v16} `)(esc(assignmentLabel))}<i class="fas fa-chevron-down"></i></button><div class="fmcl-assignment ${String(assignmentUi.open ? 'open' : '')}" data-fmcl-assignment>
              <div class="fmcl-assignment-top"><div class="fmcl-field-editing"><span>${(globalThis.PlatformLanguage?.text("checklists","m_b983a2145eb15f","Allow field editing") ?? "Allow field editing")}</span><button class="fmcl-switch ${String(checklist.crew_editable ? 'on' : '')}" type="button" data-fmcl-editable-v2 aria-pressed="${String(!!checklist.crew_editable)}"></button></div></div>
              <div class="fmcl-assignment-stack">
                <div class="fmcl-assignment-field"><span class="fmcl-compact-label">${(globalThis.PlatformLanguage?.text("checklists","m_a3b601c625c54a","Eligible type") ?? "Eligible type")}</span><div class="fmcl-eligibility">${String(eligibilityChips || '<span class="fmcl-type-chip">Everyone</span>')}${String(eligibility.customRules.length ? '<span class="fmcl-type-chip" title="Additional filters are inherited from the scope definition.">Scope filters</span>' : '')}<div class="fmcl-expand-picker ${String(assignmentUi.eligibilityPickerOpen ? 'open' : '')}" data-fmcl-picker="eligibility"><button class="fmcl-expand-trigger" type="button" data-fmcl-picker-toggle="eligibility" aria-expanded="${String(assignmentUi.eligibilityPickerOpen)}"><i class="fas fa-plus"></i><span>${(globalThis.PlatformLanguage?.text("checklists","m_7ce48edf7d0424","Add eligible type") ?? "Add eligible type")}</span></button><div class="fmcl-picker-options">${String(assignmentUi.loading ? '<span class="fmcl-picker-empty">Loading types…</span>' : `<button type="button" data-fmcl-eligibility-option="everyone">Everyone</button>${eligibilityOptions.map((option) => `<button type="button" data-fmcl-eligibility-option="${esc(option.token)}">${esc(option.label)}</button>`).join('')}`)}</div></div></div></div>
                <div class="fmcl-assignment-field"><span class="fmcl-compact-label">${(globalThis.PlatformLanguage?.text("checklists","m_6167d42c586703","Assign person") ?? "Assign person")}</span><div class="fmcl-eligibility">${String(assigneeChips || '')}<div class="fmcl-expand-picker ${String(assignmentUi.personPickerOpen ? 'open' : '')}" data-fmcl-picker="person"><button class="fmcl-expand-trigger" type="button" data-fmcl-picker-toggle="person" aria-expanded="${String(assignmentUi.personPickerOpen)}"><i class="fas fa-plus"></i><span>${(globalThis.PlatformLanguage?.text("checklists","m_6167d42c586703","Assign person") ?? "Assign person")}</span></button><div class="fmcl-picker-options">${String(assignmentUi.loading ? '<span class="fmcl-picker-empty">Loading people…</span>' : subjectChoices.length ? subjectChoices.map((subject) => `<button type="button" data-fmcl-person-option="${esc(subject.value)}">${esc(subject.label)}</button>`).join('') : '<span class="fmcl-picker-empty">No eligible people found</span>')}</div></div></div></div>
              </div>
              ${String(assignmentUi.error ? `<div class="fmcl-drawer-hint">${esc(assignmentUi.error)}</div>` : '')}
            </div></span>
            <span class="fmcl-menu-wrap"><button class="fmcl-config-btn customer ${String(sharedWithCustomer ? 'on' : '')} ${String(customerPanel.open ? 'open' : '')}" type="button" data-fmcl-customer><i class="fas fa-user-shield"></i> ${String(esc(customerLabel))} <i class="fas fa-chevron-down"></i></button><div class="fmcl-customer ${String(customerPanel.open ? 'open' : '')}" data-fmcl-customer-panel><div class="fmcl-compact-field"><span class="fmcl-compact-label">${(globalThis.PlatformLanguage?.text("checklists","m_df7c812069f56a","Customer can") ?? "Customer can")}</span><div class="fmcl-customer-levels" role="group" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_8081e27d7264bc","Customer checklist access") ?? "Customer checklist access")}"><button type="button" class="${String(!customerLevel ? 'on' : '')}" data-fmcl-customer-level="private">${(globalThis.PlatformLanguage?.text("checklists","m_2d4ff8a83b1b5c","None") ?? "None")}</button><button type="button" class="${String(customerLevel === 'view' ? 'on' : '')}" data-fmcl-customer-level="view">${(globalThis.PlatformLanguage?.text("checklists","m_f3c2eb85778751","Read-only") ?? "Read-only")}</button><button type="button" class="${String(customerLevel === 'complete' ? 'on' : '')}" data-fmcl-customer-level="complete">${(globalThis.PlatformLanguage?.text("checklists","m_e8e493437c1a17","Complete") ?? "Complete")}</button><button type="button" class="${String(customerLevel === 'edit' ? 'on' : '')}" data-fmcl-customer-level="edit">${(globalThis.PlatformLanguage?.text("checklists","m_5b9378df7220c1","Edit") ?? "Edit")}</button></div></div></div></span>
            <span class="fmcl-cl-tools"><span class="fmcl-count">${String(doneCount)}/${String(items.length)}</span><button class="fmcl-icon-btn danger" type="button" data-fmcl-cl-delete aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_0b91b01a0b286a","Delete checklist") ?? "Delete checklist")}"><i class="fas fa-trash"></i></button></span>
          </div>
          <div class="fmcl-voice-mount" data-fmcl-voice-mount></div>
          ${String(items.length ? `<div class="fmcl-items">${items.map((item) => itemHtml(checklist, item)).join('')}</div>` : `<div class="fmcl-empty-voice"><div class="fmcl-empty-voice-inner"><button class="fmcl-empty-voice-button" type="button" data-fmcl-empty-voice aria-label="Create the list with just your voice"><i class="fas fa-microphone"></i></button><span>Create the list with just your voice.</span></div><div class="fmcl-empty-voice-mount" data-fmcl-empty-voice-mount></div></div>`)}
          <div class="fmcl-add"><input data-fmcl-new-item placeholder="${(globalThis.PlatformLanguage?.text("checklists","m_7b2113cc856add","Add an item…") ?? "Add an item…")}"><div class="fmcl-item-type-toggle" role="group" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_ba5dd11f1bb044","Item type") ?? "Item type")}"><button class="on" type="button" data-fmcl-new-item-type="todo" aria-pressed="true">${(globalThis.PlatformLanguage?.text("checklists","m_d2ab565901fd0a","Task") ?? "Task")}</button><button type="button" data-fmcl-new-item-type="rating" aria-pressed="false">${(globalThis.PlatformLanguage?.text("checklists","m_ff908def5f42c6","Rating") ?? "Rating")}</button></div><button class="fmcl-btn primary" type="button" data-fmcl-add-item><i class="fas fa-plus"></i></button></div>
        </div></div>
      </section>`;
    };

    const layoutChecklistGrid = () => {
      const grid = root.querySelector('.fmcl-grid:not(.detail)');
      if (!grid) return;
      const cards = [...grid.querySelectorAll('.fmcl-card')].sort((left, right) => Number(left.dataset.fmclOrder) - Number(right.dataset.fmclOrder));
      if (!cards.length) return;
      const columnCount = window.matchMedia('(max-width:760px)').matches ? 1 : 2;
      const columns = Array.from({ length:columnCount }, () => {
        const column = document.createElement('div');
        column.className = 'fmcl-masonry-column';
        return column;
      });
      const heights = columns.map(() => 0);
      cards.forEach((card, index) => {
        const height = card.getBoundingClientRect().height;
        const target = index === 0 ? 0 : heights.indexOf(Math.min(...heights));
        columns[target].appendChild(card);
        heights[target] += height + 14;
      });
      grid.replaceChildren(...columns);
    };

    const render = () => {
      const lists = orderedChecklists();
      const deletedLists = deletedChecklists();
      const deletedView = activeView === 'deleted';
      const selectedChecklist = deletedView ? null : lists.find((checklist) => checklist.id === activeView);
      const effectiveView = deletedView ? 'deleted' : selectedChecklist ? selectedChecklist.id : 'all';
      const visibleLists = deletedView ? deletedLists : lists;
      const scrollTop = root.querySelector('.fmcl-content')?.scrollTop || 0;
      root.innerHTML = `<div class="fmcl-shell"><div class="fmcl-page">
        <header class="fmcl-head"><div class="fmcl-head-title"><i class="fas fa-list-check"></i><strong>${((v0,v1) => globalThis.PlatformLanguage?.text("checklists","m_4d94794c7ce022",`${v0} checklist${v1}`,{v0,v1}) ?? `${v0} checklist${v1}`)(lists.length,lists.length === 1 ? '' : 's')}</strong></div><div class="fmcl-head-actions"><button class="fmcl-btn primary" type="button" data-fmcl-new-toggle><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("checklists","m_00fcd79c65b45e"," New checklist") ?? " New checklist")}</button><button class="fmcl-btn new-audio" type="button" data-fmcl-new-audio title="${(globalThis.PlatformLanguage?.text("checklists","m_cf14f596affe83","New from Audio") ?? "New from Audio")}" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_cf14f596affe83","New from Audio") ?? "New from Audio")}"><i class="fas fa-microphone"></i></button></div></header>
        <nav class="fmcl-tabs" aria-label="${(globalThis.PlatformLanguage?.text("checklists","m_93a4e0ee487531","Checklist views") ?? "Checklist views")}"><button class="fmcl-tab ${String(effectiveView === 'all' ? 'active' : '')}" type="button" data-fmcl-view="all"><i class="fas fa-border-all"></i><span>${(globalThis.PlatformLanguage?.text("checklists","m_d47c4b894a4794","All checklists") ?? "All checklists")}</span></button>${String(lists.map((checklist) => `<button class="fmcl-tab ${effectiveView === checklist.id ? 'active' : ''}" type="button" data-fmcl-view="${esc(checklist.id)}" title="${esc(checklist.title)}"><i class="fas fa-list-check"></i><span>${esc(checklist.title)}</span></button>`).join(''))}<button class="fmcl-tab ${String(effectiveView === 'deleted' ? 'active' : '')}" type="button" data-fmcl-view="deleted"><i class="fas fa-trash-can"></i><span>${((v5) => globalThis.PlatformLanguage?.text("checklists","m_97f3e87e187ab6",`Deleted${v5}`,{v5}) ?? `Deleted${v5}`)(deletedLists.length ? ` (${deletedLists.length})` : '')}</span></button></nav>
        <div class="fmcl-content">
          ${String(visibleLists.length ? `<div class="fmcl-grid ${selectedChecklist ? 'detail' : ''}"><div class="fmcl-masonry-source">${selectedChecklist ? checklistHtml(selectedChecklist, true, 0) : visibleLists.map((checklist, index) => checklistHtml(checklist, false, index, deletedView)).join('')}</div></div>` : stateHtml('empty', deletedView ? 'No deleted checklists.' : 'No checklists yet. Create the first one.'))}
        </div>
      </div></div>`;
      layoutChecklistGrid();
      bind();
      const content = root.querySelector('.fmcl-content');
      if (content) content.scrollTop = scrollNewChecklistToTop ? 0 : scrollTop;
      scrollNewChecklistToTop = false;
      const focused = Object.entries(noteState).find(([, value]) => value.focus);
      if (focused) {
        const node = root.querySelector(`[data-fmcl-item$="::${focused[0]}"] [data-fmcl-note]`);
        noteState[focused[0]].focus = false;
        if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); }
      }
      if (focusChecklistId) {
        const title = root.querySelector(`[data-fmcl-list="${focusChecklistId}"] [data-fmcl-rename]`);
        focusChecklistId = '';
        if (title) { title.focus(); title.select(); title.scrollIntoView({ block:'nearest', behavior:'smooth' }); }
      }
    };

    const runVoice = async (mount, checklist = null) => {
      if (!window.FirstMateAudioStructure?.recordAndProcess) {
        return showToast((globalThis.PlatformLanguage?.text("checklists","m_47ee337f6aeaeb","Checklist voice") ?? "Checklist voice"), (globalThis.PlatformLanguage?.text("checklists","m_67d159766a452e","The structured audio library is not available.") ?? "The structured audio library is not available."), false);
      }
      try {
        const result = await window.FirstMateAudioStructure.recordAndProcess({
          mount,
          url:window.CrewAPI.projects.voiceChecklistUrl(orgId(context), projectId(context)),
          processingLabel:checklist ? 'Applying checklist updates…' : 'Building checklist…',
          fields:checklist ? {
            mode:'update',
            checklist_id:checklist.id
          } : {
            mode:'create',
            title:'',
            audience:'crew',
            crew_editable:false
          }
        });
        const applied = arr(result.data?.applied).length;
        showToast((globalThis.PlatformLanguage?.text("checklists","m_47ee337f6aeaeb","Checklist voice") ?? "Checklist voice"), checklist ? `${applied} checklist change${applied === 1 ? '' : 's'} applied.` : 'Checklist created from your recording.');
        await load();
      } catch (error) {
        if (!/cancelled/i.test(clean(error?.message))) showToast((globalThis.PlatformLanguage?.text("checklists","m_47ee337f6aeaeb","Checklist voice") ?? "Checklist voice"), statusError(error), false);
      }
    };

    const createBlankChecklist = async (startVoice = false) => {
      try {
        const result = await window.CrewAPI.projects.createChecklist(orgId(context), projectId(context), {
          title:(globalThis.PlatformLanguage?.text("checklists","m_fe7779543e8858","Untitled checklist") ?? "Untitled checklist"),
          audience:'crew',
          kind:'todo',
          crew_editable:false,
          assignment_policy:{ schema_version:1, mode:'any', allow_unassigned:false, rules:[] },
          assigned_user_ids:[userId(context)].filter(Boolean),
          customer_access:{ schema_version:1, visible:false, can_complete:false, can_edit_items:false, voice_mode:'off' }
        });
        const createdId = clean(result?.checklist?.id);
        preferredChecklistId = createdId;
        scrollNewChecklistToTop = true;
        if (activeView !== 'all') {
          activeView = 'all';
          if (!Portal.navigation?.applying) Portal.navigation?.push?.({ checklistView:null }, { source:'project-checklist-new', ownedKeys:['checklistView'] });
        }
        focusChecklistId = startVoice ? '' : createdId;
        await load();
        const checklist = checklists().find((entry) => entry.id === createdId);
        const section = root.querySelector(`[data-fmcl-list="${createdId}"]`);
        section?.scrollIntoView?.({ block:'nearest', behavior:'smooth' });
        if (startVoice && checklist && section) {
          const mount = section.querySelector('[data-fmcl-empty-voice-mount]');
          if (mount) void runVoice(mount, checklist);
        }
      } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); }
    };

    const fetchAssignmentOptions = async (ui, policyValue, force = false) => {
      if (!force && (ui.loaded || ui.loading)) return;
      ui.loading = true;
      render();
      try {
        const workforce = window.PlatformAPI?.workforce;
        const [resolved, catalog, roles] = await Promise.all([
          workforce?.resolveAssignableSubjects?.(orgId(context), 'default', obj(policyValue), {}) || Promise.resolve({}),
          workforce?.assignableResources?.(orgId(context), 'default', {}) || Promise.resolve({}),
          workforce?.accessRoles?.(orgId(context), {}) || Promise.resolve({})
        ]);
        ui.subjects = records(resolved, 'subjects');
        ui.catalog = records(catalog, 'subjects', 'resources');
        ui.roles = records(roles, 'roles', 'access_roles', 'documents', 'items');
        ui.loaded = true;
        ui.error = '';
      } catch (error) {
        ui.error = statusError(error, 'Could not load assignment options.');
      } finally {
        ui.loading = false;
        render();
      }
    };

    const bind = () => {
      root.querySelector('[data-fmcl-new-toggle]')?.addEventListener('click', () => void createBlankChecklist(false));
      root.querySelector('[data-fmcl-new-audio]')?.addEventListener('click', () => void createBlankChecklist(true));
      root.querySelectorAll('[data-fmcl-view]').forEach((button) => button.addEventListener('click', () => {
        const next = clean(button.dataset.fmclView) || 'all';
        if (next === activeView) return;
        activeView = next;
        render();
        if (!Portal.navigation?.applying) {
          Portal.navigation?.push?.(
            { checklistView:next === 'all' ? null : next },
            { source:'project-checklist-view', ownedKeys:['checklistView'] }
          );
        }
      }));
      root.querySelectorAll('[data-fmcl-list]').forEach((section) => {
        const checklistId = section.dataset.fmclList;
        const deleted = section.dataset.fmclDeleted === 'true';
        const checklist = (deleted ? deletedChecklists() : checklists()).find((entry) => entry.id === checklistId);
        if (!checklist) return;
        section.querySelector('[data-fmcl-collapse]')?.addEventListener('click', (event) => {
          const collapsed = !checklistUi(checklistId).collapsed;
          checklistUi(checklistId).collapsed = collapsed;
          const bodyInner = section.querySelector('.fmcl-card-body-inner');
          if (bodyInner) bodyInner.style.overflow = 'hidden';
          section.classList.toggle('collapsed', collapsed);
          event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
          event.currentTarget.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("checklists","m_ebff9265511202",`${v0} checklist`,{v0}) ?? `${v0} checklist`)(collapsed ? 'Expand' : 'Collapse'));
          event.currentTarget.title = ((v0) => globalThis.PlatformLanguage?.text("checklists","m_ebff9265511202",`${v0} checklist`,{v0}) ?? `${v0} checklist`)(collapsed ? 'Expand' : 'Collapse');
          const icon = event.currentTarget.querySelector('i');
          icon?.classList.toggle('fa-chevron-down', collapsed);
          icon?.classList.toggle('fa-chevron-up', !collapsed);
          window.setTimeout(() => {
            if (!collapsed && bodyInner) bodyInner.style.overflow = '';
            if (!destroyed) layoutChecklistGrid();
          }, 280);
        });
        if (deleted) return;
        const titleInput = section.querySelector('[data-fmcl-rename]');
        const saveTitle = async () => {
          const title = clean(titleInput?.value);
          if (!title || title === checklist.title) { if (!title && clean(checklist.title).toLowerCase() !== 'untitled checklist') titleInput.value = checklist.title; return; }
          try { await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, { title }); await load(); }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); render(); }
        };
        titleInput?.addEventListener('blur', () => void saveTitle());
        titleInput?.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); titleInput.blur(); }
          if (event.key === 'Escape') { titleInput.value = clean(checklist.title).toLowerCase() === 'untitled checklist' ? '' : checklist.title; titleInput.blur(); }
        });
        section.querySelector('[data-fmcl-editable-v2]')?.addEventListener('click', async () => {
          try { await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, { crew_editable: !checklist.crew_editable }); await load(); }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); }
        });
        section.querySelector('[data-fmcl-assign]')?.addEventListener('click', async () => {
          const ui = assignment(checklistId);
          const opening = !ui.open;
          Object.values(assignmentState).forEach((entry) => { entry.open = false; entry.eligibilityPickerOpen = false; entry.personPickerOpen = false; });
          Object.values(customerState).forEach((entry) => { entry.open = false; });
          ui.open = opening;
          render();
          if (ui.open) void fetchAssignmentOptions(ui, checklist.assignment_policy);
        });
        section.querySelector('[data-fmcl-customer]')?.addEventListener('click', () => {
          const ui = customerUi(checklistId);
          const opening = !ui.open;
          Object.values(assignmentState).forEach((entry) => { entry.open = false; entry.eligibilityPickerOpen = false; entry.personPickerOpen = false; });
          Object.values(customerState).forEach((entry) => { entry.open = false; });
          ui.open = opening;
          render();
        });
        const updateCustomerAccess = async (level) => {
          const customerAccess = level === 'edit'
            ? { schema_version:1, visible:true, can_complete:true, can_edit_items:true, voice_mode:'edit' }
            : level === 'complete'
              ? { schema_version:1, visible:true, can_complete:true, can_edit_items:false, voice_mode:'complete' }
              : level === 'view'
                ? { schema_version:1, visible:true, can_complete:false, can_edit_items:false, voice_mode:'off' }
                : { schema_version:1, visible:false, can_complete:false, can_edit_items:false, voice_mode:'off' };
          try {
            await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, { customer_access:customerAccess });
            await load();
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_9b4db3060b8d82","Customer checklist") ?? "Customer checklist"), statusError(error), false); }
        };
        section.querySelectorAll('[data-fmcl-customer-level]').forEach((button) => button.addEventListener('click', () => void updateCustomerAccess(button.dataset.fmclCustomerLevel)));
        section.querySelector('[data-fmcl-customer-remove]')?.addEventListener('click', () => void updateCustomerAccess('private'));
        const updateEligibility = async (tokens) => {
          const current = assignmentEligibility(checklist.assignment_policy, checklist.assigned_role_ids);
          const rules = [
            ...current.customRules,
            ...tokens.map(assignmentRuleForToken).filter(Boolean)
          ];
          const policy = { schema_version:1, mode:'any', ...obj(checklist.assignment_policy), allow_unassigned:true, rules };
          try {
            await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, {
              assignment_policy:policy,
              assigned_user_ids:[],
              assigned_resource_group_ids:[],
              assigned_role_ids:[]
            });
            const ui = assignment(checklistId);
            ui.loaded = false;
            ui.subjects = [];
            await fetchAssignmentOptions(ui, policy, true);
            await load();
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_acc392633ac82a","Checklist assignment") ?? "Checklist assignment"), statusError(error), false); }
        };
        section.querySelectorAll('[data-fmcl-picker-toggle]').forEach((button) => button.addEventListener('click', () => {
          const kind = button.dataset.fmclPickerToggle;
          const ui = assignment(checklistId);
          const opening = kind === 'eligibility' ? !ui.eligibilityPickerOpen : !ui.personPickerOpen;
          ui.eligibilityPickerOpen = kind === 'eligibility' && opening;
          ui.personPickerOpen = kind === 'person' && opening;
          section.querySelectorAll('[data-fmcl-picker]').forEach((picker) => {
            const open = picker.dataset.fmclPicker === kind && opening;
            picker.classList.toggle('open', open);
            picker.querySelector('[data-fmcl-picker-toggle]')?.setAttribute('aria-expanded', String(open));
          });
        }));
        section.querySelectorAll('[data-fmcl-eligibility-option]').forEach((button) => button.addEventListener('click', () => {
          const value = clean(button.dataset.fmclEligibilityOption);
          if (!value) return;
          assignment(checklistId).eligibilityPickerOpen = false;
          button.closest('[data-fmcl-picker]')?.classList.remove('open');
          const current = assignmentEligibility(checklist.assignment_policy, checklist.assigned_role_ids);
          void updateEligibility(value === 'everyone' ? [] : [...new Set([...current.tokens, value])]);
        }));
        section.querySelectorAll('[data-fmcl-eligibility-remove]').forEach((button) => button.addEventListener('click', () => {
          const current = assignmentEligibility(checklist.assignment_policy, checklist.assigned_role_ids);
          void updateEligibility(current.tokens.filter((token) => token !== button.dataset.fmclEligibilityRemove));
        }));
        section.querySelectorAll('[data-fmcl-person-option]').forEach((button) => button.addEventListener('click', async () => {
          const value = clean(button.dataset.fmclPersonOption);
          if (!value) return;
          assignment(checklistId).personPickerOpen = false;
          button.closest('[data-fmcl-picker]')?.classList.remove('open');
          const separator = value.indexOf(':');
          const type = value.slice(0, separator);
          const id = value.slice(separator + 1);
          const policy = { schema_version:1, mode:'any', ...obj(checklist.assignment_policy), allow_unassigned:false };
          const patch = type === 'organization_user'
            ? { assignment_policy:policy, assigned_user_ids:[...new Set([...arr(checklist.assigned_user_ids), id])] }
            : { assignment_policy:policy, assigned_resource_group_ids:[...new Set([...arr(checklist.assigned_resource_group_ids), id])] };
          try {
            await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, patch);
            await load();
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_acc392633ac82a","Checklist assignment") ?? "Checklist assignment"), statusError(error), false); }
        }));
        section.querySelectorAll('[data-fmcl-unassign]').forEach((button) => button.addEventListener('click', async () => {
          const value = clean(button.dataset.fmclUnassign);
          const separator = value.indexOf(':');
          const type = value.slice(0, separator);
          const id = value.slice(separator + 1);
          const nextUsers = type === 'organization_user' ? arr(checklist.assigned_user_ids).filter((entry) => entry !== id) : arr(checklist.assigned_user_ids);
          const nextGroups = type === 'resource_group' ? arr(checklist.assigned_resource_group_ids).filter((entry) => entry !== id) : arr(checklist.assigned_resource_group_ids);
          const nextRoles = type === 'role' ? arr(checklist.assigned_role_ids).filter((entry) => entry !== id) : arr(checklist.assigned_role_ids);
          const policy = { schema_version:1, mode:'any', ...obj(checklist.assignment_policy), allow_unassigned:!nextUsers.length && !nextGroups.length && !nextRoles.length };
          const patch = type === 'organization_user'
            ? { assignment_policy:policy, assigned_user_ids:nextUsers }
            : type === 'resource_group'
              ? { assignment_policy:policy, assigned_resource_group_ids:nextGroups }
              : { assignment_policy:policy, assigned_role_ids:nextRoles };
          try {
            await window.CrewAPI.projects.updateChecklist(orgId(context), projectId(context), checklistId, patch);
            await load();
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_acc392633ac82a","Checklist assignment") ?? "Checklist assignment"), statusError(error), false); }
        }));
        section.querySelector('[data-fmcl-voice-update]')?.addEventListener('click', () => {
          const mount = section.querySelector('[data-fmcl-voice-mount]');
          if (mount) void runVoice(mount, checklist);
        });
        section.querySelector('[data-fmcl-empty-voice]')?.addEventListener('click', () => {
          const mount = section.querySelector('[data-fmcl-empty-voice-mount]');
          if (mount) void runVoice(mount, checklist);
        });
        section.querySelector('[data-fmcl-cl-delete]')?.addEventListener('click', async () => {
          const approved = await (Portal.ui?.confirm?.(((v0) => globalThis.PlatformLanguage?.text("checklists","m_a06b02f7ca731a",`Delete "${v0}" and its items?`,{v0}) ?? `Delete "${v0}" and its items?`)(checklist.title)) || Promise.resolve(window.confirm(((v0) => globalThis.PlatformLanguage?.text("checklists","m_a06b02f7ca731a",`Delete "${v0}" and its items?`,{v0}) ?? `Delete "${v0}" and its items?`)(checklist.title))));
          if (!approved) return;
          try {
            await window.CrewAPI.projects.removeChecklist(orgId(context), projectId(context), checklistId);
            if (activeView === checklistId) {
              activeView = 'all';
              if (!Portal.navigation?.applying) Portal.navigation?.replace?.({ checklistView:null }, { source:'project-checklist-deleted', ownedKeys:['checklistView'] });
            }
            await load();
          }
          catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); }
        });
        section.querySelector('[data-fmcl-add-item]')?.addEventListener('click', async (event) => {
          const input = section.querySelector('[data-fmcl-new-item]');
          const title = clean(input?.value);
          if (!title) return;
          event.currentTarget.disabled = true;
          try {
            await window.CrewAPI.projects.addItemToChecklist(orgId(context), projectId(context), checklistId, {
              title,
              item_type: section.querySelector('[data-fmcl-new-item-type].on')?.dataset.fmclNewItemType || 'todo'
            });
            await load();
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); event.currentTarget.disabled = false; }
        });
        section.querySelector('[data-fmcl-new-item]')?.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') section.querySelector('[data-fmcl-add-item]')?.click();
        });
        section.querySelectorAll('[data-fmcl-new-item-type]').forEach((button) => button.addEventListener('click', () => {
          section.querySelectorAll('[data-fmcl-new-item-type]').forEach((candidate) => {
            const selected = candidate === button;
            candidate.classList.toggle('on', selected);
            candidate.setAttribute('aria-pressed', String(selected));
          });
        }));
        section.querySelectorAll('[data-fmcl-item]').forEach((row) => {
          const [, itemId] = String(row.dataset.fmclItem).split('::');
          const item = arr(checklist.items).find((entry) => entry.id === itemId);
          if (!item) return;
          const drawer = state(itemId);
          const itemMetadata = obj(item.metadata);
          const itemRequirements = arr(itemMetadata.required_attachments);
          const isMediaRequirement = (entry) => clean(entry.kind) === 'media'
            || ['photo','video'].includes(clean(entry.kind))
            || arr(entry.allowed_kinds).some((kind) => ['photo','video'].includes(clean(kind)));
          const saveRequirements = async (next) => {
            try { await patchItem(checklistId, itemId, { metadata:{ ...itemMetadata, required_attachments:next } }); }
            catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_63be2d7b4a99b1","Checklist evidence") ?? "Checklist evidence"), statusError(error), false); }
          };
          row.querySelector('[data-fmcl-evidence-open]')?.addEventListener('click', () => {
            drawer.evidenceOpen = !drawer.evidenceOpen;
            render();
          });
          row.querySelector('[data-fmcl-evidence-close]')?.addEventListener('click', () => {
            drawer.evidenceOpen = false;
            render();
          });
          row.querySelectorAll('[data-fmcl-requirement-toggle]').forEach((button) => button.addEventListener('click', () => {
            const kind = button.dataset.fmclRequirementToggle;
            const matches = (entry) => kind === 'media' ? isMediaRequirement(entry) : clean(entry.kind) === kind;
            const alreadyRequired = itemRequirements.some(matches);
            const remaining = itemRequirements.filter((entry) => !matches(entry));
            if (alreadyRequired) return void saveRequirements(remaining);
            const requirement = kind === 'media'
              ? { id:'required_media', kind:'media', allowed_kinds:['photo','video'], min_count:1, label:(globalThis.PlatformLanguage?.text("checklists","m_4e8ae664ddfee4","Photo or video evidence") ?? "Photo or video evidence") }
              : kind === 'document'
                ? { id:'required_document', kind:'document', min_count:1, label:(globalThis.PlatformLanguage?.text("checklists","m_934b5501b29644","Required document") ?? "Required document") }
                : { id:'required_audio', kind:'audio', min_count:1, label:(globalThis.PlatformLanguage?.text("checklists","m_a512b58093caca","Voice explanation") ?? "Voice explanation") };
            void saveRequirements([...remaining, requirement]);
          }));
          row.querySelectorAll('[data-fmcl-media-kind]').forEach((checkbox) => checkbox.addEventListener('change', () => {
            const media = itemRequirements.find(isMediaRequirement);
            if (!media) return;
            const checked = [...row.querySelectorAll('[data-fmcl-media-kind]:checked')].map((input) => input.dataset.fmclMediaKind);
            const remaining = itemRequirements.filter((entry) => !isMediaRequirement(entry));
            if (!checked.length) return void saveRequirements(remaining);
            void saveRequirements([...remaining, { ...media, id:clean(media.id) || 'required_media', kind:'media', allowed_kinds:checked, min_count:Number(media.min_count) || 1 }]);
          }));
          row.querySelector('[data-fmcl-attach-evidence]')?.addEventListener('click', () => {
            const input = row.querySelector('[data-fmcl-evidence-input]');
            if (!input) return;
            const media = itemRequirements.find(isMediaRequirement);
            const accepted = [];
            if (media) {
              const allowed = arr(media.allowed_kinds).length ? arr(media.allowed_kinds) : ['photo','video'];
              if (allowed.includes('photo')) accepted.push('image/*');
              if (allowed.includes('video')) accepted.push('video/*');
            }
            if (itemRequirements.some((entry) => clean(entry.kind) === 'audio')) accepted.push('audio/*');
            if (itemRequirements.some((entry) => clean(entry.kind) === 'document')) accepted.push('.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt');
            input.accept = accepted.length ? accepted.join(',') : 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt';
            input.click();
          });
          row.querySelector('[data-fmcl-record-evidence]')?.addEventListener('click', async () => {
            if (!window.FirstMateAudioNotes?.recordInline) return showToast((globalThis.PlatformLanguage?.text("checklists","m_63be2d7b4a99b1","Checklist evidence") ?? "Checklist evidence"), (globalThis.PlatformLanguage?.text("checklists","m_b26212316ddd4d","Audio recording is not available.") ?? "Audio recording is not available."), false);
            const audioRequirement = itemRequirements.find((entry) => clean(entry.kind) === 'audio');
            const mount = row.querySelector('[data-fmcl-evidence-recorder]');
            try {
              const recording = await window.FirstMateAudioNotes.recordInline({ mount, maxSeconds:600 });
              mount.innerHTML = `<div class="fm-as-processing"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("checklists","m_9dcf317e5e0b3b","Attaching voice explanation...") ?? "Attaching voice explanation...")}</span></div>`;
              const wav = await window.FirstMateAudioNotes.toWavFile(recording.file, 16_000);
              await window.CrewAPI.projects.attachChecklistEvidence(orgId(context), projectId(context), checklistId, itemId, wav, clean(audioRequirement?.id));
              await load();
            } catch (error) {
              if (!/cancelled/i.test(clean(error?.message))) showToast((globalThis.PlatformLanguage?.text("checklists","m_63be2d7b4a99b1","Checklist evidence") ?? "Checklist evidence"), statusError(error), false);
              if (mount) mount.innerHTML = '';
            }
          });
          row.querySelector('[data-fmcl-evidence-input]')?.addEventListener('change', async (event) => {
            event.stopImmediatePropagation();
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            const mime = clean(file.type).toLowerCase();
            const extension = clean(file.name).split('.').pop().toLowerCase();
            const kind = mime.startsWith('image/') ? 'photo'
              : mime.startsWith('video/') ? 'video'
                : mime.startsWith('audio/') ? 'audio'
                  : ['pdf','doc','docx','xls','xlsx','csv','txt'].includes(extension) ? 'document' : 'any';
            const requirement = kind === 'photo' || kind === 'video'
              ? itemRequirements.find((entry) => isMediaRequirement(entry) && (!arr(entry.allowed_kinds).length || arr(entry.allowed_kinds).includes(kind)))
              : itemRequirements.find((entry) => clean(entry.kind) === kind);
            input.disabled = true;
            try {
              await window.CrewAPI.projects.attachChecklistEvidence(orgId(context), projectId(context), checklistId, itemId, file, clean(requirement?.id));
              await load();
            } catch (error) {
              showToast((globalThis.PlatformLanguage?.text("checklists","m_63be2d7b4a99b1","Checklist evidence") ?? "Checklist evidence"), statusError(error), false);
              input.disabled = false;
              input.value = '';
            }
          });
          row.querySelectorAll('[data-fmcl-evidence]').forEach((button) => button.addEventListener('click', async () => {
            const requirementId = button.dataset.fmclEvidence;
            const kind = button.dataset.kind || 'any';
            if (kind === 'audio' && window.FirstMateAudioNotes?.recordInline) {
              const mount = row.querySelector('[data-fmcl-evidence-recorder]');
              try {
                const recording = await window.FirstMateAudioNotes.recordInline({ mount, maxSeconds:600 });
                mount.innerHTML = `<div class="fm-as-processing"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("checklists","m_0960411ba118b7","Attaching voice explanation…") ?? "Attaching voice explanation…")}</span></div>`;
                const wav = await window.FirstMateAudioNotes.toWavFile(recording.file, 16_000);
                await window.CrewAPI.projects.attachChecklistEvidence(orgId(context), projectId(context), checklistId, itemId, wav, requirementId);
                await load();
              } catch (error) {
                if (!/cancelled/i.test(clean(error?.message))) showToast((globalThis.PlatformLanguage?.text("checklists","m_63be2d7b4a99b1","Checklist evidence") ?? "Checklist evidence"), statusError(error), false);
                if (mount) mount.innerHTML = '';
              }
              return;
            }
            const input = row.querySelector('[data-fmcl-evidence-input]');
            if (!input) return;
            input.dataset.requirementId = requirementId;
            input.accept = kind === 'photo' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : kind === 'document' ? '.pdf,.doc,.docx,.xls,.xlsx,.txt' : 'image/*,video/*,audio/*,.pdf,.doc,.docx';
            input.click();
          }));
          row.querySelector('[data-fmcl-toggle]')?.addEventListener('click', async (event) => {
            event.currentTarget.disabled = true;
            try { await patchItem(checklistId, itemId, { completed: !item.completed }); }
            catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); render(); }
          });
          row.querySelectorAll('[data-fmcl-rate]').forEach((button) => button.addEventListener('click', async () => {
            const value = button.dataset.fmclRate;
            try {
              if (item.rating === value) { await patchItem(checklistId, itemId, { rating: '' }); return; }
              if (value === 'bad' && !clean(drawer.draft ?? item.note)) {
                drawer.open = true; drawer.pendingRating = 'bad'; drawer.hint = false; drawer.focus = true; render(); return;
              }
              await patchItem(checklistId, itemId, { rating: value });
            } catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); }
          }));
          row.querySelectorAll('[data-fmcl-note-open]').forEach((button) => button.addEventListener('click', () => {
            drawer.open = !drawer.open; drawer.pendingRating = ''; drawer.hint = false; drawer.preview = false; drawer.focus = drawer.open; render();
          }));
          row.querySelectorAll('.fmcl-note-line a').forEach((link) => link.addEventListener('click', (event) => event.stopPropagation()));
          row.querySelector('[data-fmcl-title-edit]')?.addEventListener('click', () => {
            drawer.editingTitle = true;
            drawer.titleDraft = clean(item.title);
            render();
            setTimeout(() => root.querySelector(`[data-fmcl-item$="::${itemId}"] [data-fmcl-title-input]`)?.focus(), 0);
          });
          row.querySelector('[data-fmcl-title-input]')?.addEventListener('input', (event) => { drawer.titleDraft = event.currentTarget.value; });
          row.querySelector('[data-fmcl-title-input]')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') row.querySelector('[data-fmcl-title-save]')?.click();
            if (event.key === 'Escape') row.querySelector('[data-fmcl-title-cancel]')?.click();
          });
          row.querySelector('[data-fmcl-title-save]')?.addEventListener('click', async () => {
            const title = clean(drawer.titleDraft);
            if (!title) return showToast((globalThis.PlatformLanguage?.text("checklists","m_acae62bc1e44fc","Checklist item") ?? "Checklist item"), (globalThis.PlatformLanguage?.text("checklists","m_ce722f06631579","Enter an item title.") ?? "Enter an item title."), false);
            drawer.editingTitle = false;
            try { await patchItem(checklistId, itemId, { title }); }
            catch (error) { drawer.editingTitle = true; showToast((globalThis.PlatformLanguage?.text("checklists","m_acae62bc1e44fc","Checklist item") ?? "Checklist item"), statusError(error), false); render(); }
          });
          row.querySelector('[data-fmcl-title-cancel]')?.addEventListener('click', () => {
            drawer.editingTitle = false;
            drawer.titleDraft = '';
            render();
          });
          row.querySelector('[data-fmcl-note]')?.addEventListener('input', (event) => { drawer.draft = event.currentTarget.value; });
          row.querySelector('[data-fmcl-note]')?.addEventListener('keydown', (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            const format = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : event.key.toLowerCase() === 'k' ? 'link' : '';
            if (!format) return;
            event.preventDefault();
            formatMarkdown(event.currentTarget, format);
          });
          row.querySelectorAll('[data-fmcl-md]').forEach((button) => button.addEventListener('click', () => {
            const textarea = row.querySelector('[data-fmcl-note]');
            if (textarea) formatMarkdown(textarea, button.dataset.fmclMd);
          }));
          row.querySelectorAll('[data-fmcl-md-view]').forEach((button) => button.addEventListener('click', () => {
            const preview = button.dataset.fmclMdView === 'preview';
            if (drawer.preview === preview) return;
            const textarea = row.querySelector('[data-fmcl-note]');
            if (textarea) drawer.draft = textarea.value;
            drawer.preview = preview;
            drawer.focus = !preview;
            render();
          }));
          row.querySelector('[data-fmcl-note-cancel]')?.addEventListener('click', () => {
            drawer.open = false; drawer.draft = null; drawer.pendingRating = ''; drawer.hint = false; drawer.preview = false; render();
          });
          row.querySelector('[data-fmcl-note-save]')?.addEventListener('click', async (event) => {
            const note = clean(drawer.draft ?? item.note);
            if ((drawer.pendingRating || item.rating) === 'bad' && !note) { drawer.hint = true; render(); return; }
            event.currentTarget.disabled = true;
            try {
              const patch = { note };
              if (drawer.pendingRating) patch.rating = drawer.pendingRating;
              drawer.open = false; drawer.draft = null; drawer.pendingRating = ''; drawer.hint = false; drawer.preview = false;
              await patchItem(checklistId, itemId, patch);
            } catch (error) { drawer.open = true; showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); render(); }
          });
          row.querySelector('[data-fmcl-item-delete]')?.addEventListener('click', async () => {
            const approved = await (Portal.ui?.confirm?.((globalThis.PlatformLanguage?.text("checklists","m_3dd0af0b6f7be5","Delete this checklist item?") ?? "Delete this checklist item?")) || Promise.resolve(window.confirm((globalThis.PlatformLanguage?.text("checklists","m_3dd0af0b6f7be5","Delete this checklist item?") ?? "Delete this checklist item?"))));
            if (!approved) return;
            try { await window.CrewAPI.projects.removeItemFromChecklist(orgId(context), projectId(context), checklistId, itemId); await load(); }
            catch (error) { showToast((globalThis.PlatformLanguage?.text("checklists","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), statusError(error), false); }
          });
        });
      });
    };

    const load = async () => {
      try {
        data = await window.CrewAPI.projects.checklists(orgId(context), projectId(context));
        if (!destroyed) render();
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="fmcl-shell">${stateHtml('error', statusError(error, 'Could not load checklists.'))}</div>`;
      }
    };
    const unregisterRoute = Portal.navigation?.registerHandler?.(`project-checklists-view:${context.instanceId || projectId(context)}`, {
      priority:650,
      apply:(route) => {
        if (clean(route.project) !== projectId(context) || route.projectTab !== 'checklists') return;
        const next = clean(route.checklistView) || 'all';
        if (next === activeView) return;
        activeView = next;
        if (data && !destroyed) render();
      }
    });
    root.innerHTML = `<div class="fmcl-shell">${stateHtml()}</div>`;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (destroyed) return;
        layoutChecklistGrid();
        window.requestAnimationFrame(() => { if (!destroyed) layoutChecklistGrid(); });
      }, 80);
    };
    const closeOpenMenus = () => {
      let changed = false;
      Object.values(assignmentState).forEach((entry) => {
        if (entry.open) { entry.open = false; changed = true; }
        entry.eligibilityPickerOpen = false;
        entry.personPickerOpen = false;
      });
      Object.values(customerState).forEach((entry) => { if (entry.open) { entry.open = false; changed = true; } });
      if (changed && !destroyed) render();
    };
    const onDocumentPointerDown = (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.fmcl-menu-wrap') && root.contains(target)) return;
      window.setTimeout(closeOpenMenus, 0);
    };
    const onDocumentKeyDown = (event) => { if (event.key === 'Escape') closeOpenMenus(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    load();
    return { destroy(){ destroyed = true; window.clearTimeout(resizeTimer); window.removeEventListener('resize', onResize); document.removeEventListener('pointerdown', onDocumentPointerDown); document.removeEventListener('keydown', onDocumentKeyDown); if (typeof unregisterRoute === 'function') unregisterRoute(); root.innerHTML = ''; } };
  }

  runtime.registerApp({
    id: 'project.checklists',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("checklists","m_4890d3d11dc3eb","Checklists") ?? "Checklists"),
    label: (globalThis.PlatformLanguage?.text("checklists","m_4890d3d11dc3eb","Checklists") ?? "Checklists"),
    icon: 'fa-list-check',
    order: 95,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    access: { applicationsAny: ['management'] },
    panelHtml: () => '<div class="fmcl-panel" data-fmcl-app></div>',
    mount: mountChecklists
  });
})();
