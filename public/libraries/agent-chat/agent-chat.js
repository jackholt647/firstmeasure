/* public/libraries/agent-chat/agent-chat.js
 * Shared rendering engine for agent conversations, so every agent surface
 * (assistant drawer, comms panels, global comms center) draws messages the
 * same way: markdown replies, "What changed" summaries, and navigation
 * action chips. Hosts keep their own containers/classes and pass a prefix.
 */
(function(){
  'use strict';

  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];

  // Minimal markdown: escape everything first, then inline transforms and
  // list/heading blocks. Identical behavior to the assistant drawer.
  function renderMarkdown(raw){
    const inline = (value) => esc(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    String(raw ?? '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
      const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
      if (bullet) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(bullet[1])}</li>`);
      } else if (numbered) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(numbered[1])}</li>`);
      } else if (heading) {
        closeList();
        out.push(`<div class="fmac-md-h">${inline(heading[1])}</div>`);
      } else if (!trimmed) {
        closeList();
        out.push('<div class="fmac-md-gap"></div>');
      } else {
        closeList();
        out.push(`<div>${inline(line)}</div>`);
      }
    });
    closeList();
    return out.join('');
  }

  function changesHtml(message, prefix){
    const changes = array(object(message.data).changes).map(clean).filter(Boolean);
    if (!changes.length) return '';
    return ("<div class=\"" + String(prefix) + "-changes\"><div class=\"" + String(prefix) + "-changes-label\">" + (globalThis.PlatformLanguage?.text("agent-chat","m_c46a636ed38aee","What changed") ?? "What changed") + "</div>" + String(changes.map((entry) =>
      `<div class="${prefix}-changes-row"><i class="fa-solid fa-check"></i><span>${esc(entry)}</span></div>`).join('')) + "</div>");
  }

  function navigableAction(action){
    const record = object(action);
    const kind = clean(record.kind);
    return (kind === 'project' && !!clean(record.project_id))
      || (kind === 'tab' && !!clean(record.tab));
  }

  function actionLabel(action){
    const record = object(action);
    const supplied = clean(record.label);
    if (supplied) return supplied;
    if (clean(record.kind) === 'project') return 'Open project';
    if (clean(record.kind) === 'tab') {
      const tab = clean(record.tab).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
      return tab ? `Open ${tab}` : 'Open section';
    }
    return '';
  }

  function actionsHtml(message, prefix){
    const actions = array(object(message.data).actions)
      .map((action, index) => ({ action: object(action), index }))
      .filter(({ action }) => navigableAction(action));
    if (!actions.length) return '';
    return `<div class="${prefix}-actions" data-agent-actions="${esc(clean(message.id))}">${actions.map(({ action, index }) => {
      const kind = clean(action.kind);
      const icon = kind === 'project' ? 'fa-folder-open' : 'fa-arrow-up-right-from-square';
      const label = actionLabel(action);
      return `<button type="button" class="${prefix}-action" data-agent-action-index="${index}" aria-label="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${esc(label)}</span></button>`;
    }).join('')}</div>`;
  }

  /**
   * Render one agent message. options: { prefix (css class prefix, required),
   * userClass/assistantClass overrides, animateClass }.
   */
  function messageHtml(message, options = {}){
    const prefix = clean(options.prefix) || 'fmac';
    const record = object(message);
    const data = object(record.data);
    const animate = options.animateClass ? ` ${options.animateClass}` : '';
    if (clean(record.role) === 'user') {
      return `<div class="${options.userClass || `${prefix}-msg user`}${animate}">${esc(record.content)}</div>`;
    }
    const failed = clean(data.status) === 'failed';
    const pending = record.pending === true;
    let html = `<div class="${options.assistantClass || `${prefix}-msg assistant`}${failed ? ' failed' : ''}${pending ? ' pending' : ''}${animate}">`;
    html += pending ? esc(record.content) : renderMarkdown(record.content);
    html += changesHtml(record, prefix);
    html += '</div>';
    html += actionsHtml(record, prefix);
    return html;
  }

  /** Wire the action chips inside a container to Portal navigation. */
  function bindActions(container, messages){
    if (!container) return;
    container.querySelectorAll('[data-agent-actions]').forEach((wrap) => {
      const messageId = clean(wrap.getAttribute('data-agent-actions'));
      const message = array(messages).find((entry) => clean(object(entry).id) === messageId);
      const actions = array(object(object(message).data).actions);
      wrap.querySelectorAll('[data-agent-action-index]').forEach((button) => {
        button.addEventListener('click', () => {
          const action = object(actions[Number(button.getAttribute('data-agent-action-index'))]);
          runAction(action);
        });
      });
    });
  }

  function runAction(action){
    const Portal = window.Portal || {};
    const kind = clean(object(action).kind);
    try {
      if (kind === 'project' && clean(action.project_id)) {
        const projectId = clean(action.project_id);
        if (Portal.ProjectModal?.open) { Portal.ProjectModal.open(projectId); return; }
        if (Portal.modules?.request?.openProject) { Portal.modules.request.openProject({ id:projectId }); return; }
        window.dispatchEvent(new CustomEvent('fm:projects:open', { detail:{ id:projectId } }));
        return;
      }
      if (kind === 'tab' && clean(action.tab)) {
        if (Portal.navigation?.navigate) { Portal.navigation.navigate({ tab:clean(action.tab) }); return; }
        Portal.tabs?.activateTab?.(clean(action.tab));
      }
    } catch (error) {
      console.warn('[agent-chat] action failed', error);
    }
  }

  // Shared structural CSS for the markdown/changes/chips fragments. Bubble
  // colors stay with each host's own classes.
  function injectBaseCss(prefix){
    const id = `fm-agent-chat-css-${prefix}`;
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .${prefix}-md-h,.fmac-md-h{font-weight:800;margin:5px 0 2px}
      .${prefix}-md-gap,.fmac-md-gap{height:7px}
      .${prefix}-changes{margin-top:8px;border-top:1px solid #e4e7ec;padding-top:7px;font-size:12px;color:#475467}
      .${prefix}-changes-label{font-size:10.5px;font-weight:800;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
      .${prefix}-changes-row{display:flex;gap:6px;align-items:baseline}
      .${prefix}-changes-row i{font-size:10px;color:#12b76a}
      .${prefix}-actions{display:flex;flex-wrap:wrap;gap:7px;align-self:flex-start;max-width:92%}
      .${prefix}-action{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-weight:700;font-size:12.5px;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease}
      .${prefix}-action:hover{border-color:var(--primary-readable,var(--primary,#175cd3));color:var(--primary-readable,var(--primary,#175cd3));background:rgba(var(--primary-rgb,23,92,211),.06)}
      .${prefix}-action i{font-size:11px}
    `;
    document.head.appendChild(style);
  }

  window.FirstMateAgentChat = { renderMarkdown, messageHtml, bindActions, runAction, injectBaseCss };
})();
