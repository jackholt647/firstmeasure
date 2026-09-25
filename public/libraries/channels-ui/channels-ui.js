/* libraries/channels-ui/channels-ui.js
 * FirstMateChannels — the reusable Slack-style messaging UI.
 *
 * One library, many surfaces: the Channels portal tab mounts it in `full`
 * mode (sidebar, DMs, search, pins, saved); the project-notes surfaces mount
 * it in `embedded` mode pointed at a project channel with a trimmed feature
 * set. Every capability is a constructor option so a surface can switch any
 * of it off without forking the UI.
 *
 *   const instance = FirstMateChannels.create(containerEl, {
 *     orgId, currentUser: { id, name, email },
 *     mode: 'full' | 'conversation' | 'embedded' | 'list', // conversation = full channel without its own rail
 *                                           // channel calls onOpenChannel(id, opts)
 *                                           // instead of loading messages
 *     context: { kind: 'channel'|'project', channelId?, projectId?, projectTitle? },
 *     features: { threads, reactions, dms, attachments, pins, saved, editHistory,
 *                 deleteRestore, typing, search, channelCreate, channelSettings,
 *                 audienceSelector, tagOptions: [] },
 *     defaults: { audience: [], tags: [] },
 *     realtime: true, density: 'comfortable'|'compact',
 *     composerPlaceholder, emptyStateText,
 *     onNavigate(route){}, onSettings(){}
 *   });
 *   instance -> { destroy, setChannel, revealMessage, refresh, setFeatures, update }
 *
 * Depends on: window.ChannelsAPI, window.PlatformRealtime (optional),
 * window.FirstMateTags (optional, mention autocomplete).
 */
(function(){
  const root = window;
  if (root.FirstMateChannels) return;

  const DEFAULT_FEATURES = {
    threads: true,
    reactions: true,
    dms: true,
    attachments: true,
    audioNotes: true,
    pins: true,
    saved: true,
    editHistory: true,
    deleteRestore: true,
    typing: true,
    search: true,
    channelCreate: true,
    channelSettings: true,
    attention: true,
    richMessages: true,
    resources: true,
    clips: true,
    workflows: true,
    ai: true,
    huddles: true,
    recording: false,
    recordVideo: true,
    audienceSelector: false,
    tagOptions: []
  };

  const AUDIENCE_GROUPS = [
    { id: 'office', label: (globalThis.PlatformLanguage?.text("channels-ui","m_aa20efe27f3230","Office") ?? "Office") },
    { id: 'crew', label: (globalThis.PlatformLanguage?.text("channels-ui","m_5b8ee9e9110e54","Crew") ?? "Crew") },
    { id: 'sales', label: (globalThis.PlatformLanguage?.text("channels-ui","m_2680c31facb03d","Sales") ?? "Sales") }
  ];

  const EMOJI_SET = [
    { group: 'Reactions', items: ['👍','👎','❤️','🔥','🎉','😂','😊','😮','😢','😡','🙏','👏','💯','✅','❌','👀','🤝','🫡','🤔','😅','🥳','😍','🚀','⭐'] },
    { group: 'Faces', items: ['😀','😄','😁','😆','🙂','😉','😌','😎','🤩','🥲','😴','🤯','🤢','🥶','😱','😳','🙄','😬','🤐','😇','🤠','🤡','👻','💀'] },
    { group: 'Hands', items: ['👋','✌️','🤞','🤟','👌','🤌','✋','🖐️','💪','🦾','🖖','👈','👉','👆','👇','☝️','✍️','🤙','🙌','🫶'] },
    { group: 'Work', items: ['🏠','🏗️','🧰','🔨','🪜','📐','📏','🧱','🪵','🏡','🚧','⚒️','🛠️','📸','📋','📝','📞','📧','💰','🧾','📦','🚚','🗓️','⏰'] },
    { group: 'Weather', items: ['☀️','⛅','☁️','🌧️','⛈️','🌨️','❄️','🌪️','🌈','💨','🌊','🌡️'] }
  ];

  // --- tiny DOM + format helpers ---------------------------------------------

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function el(tag, className, html){
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function fmtTime(iso){
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDay(iso){
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(date, today)) return 'Today';
    if (sameDay(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function fmtDateTime(iso){
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${fmtDay(iso)} at ${fmtTime(iso)}`;
  }

  function dayKey(iso){
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function initials(name){
    return cleanText(name).split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  function avatarHtml(user, size){
    const cls = `fm-ch-avatar${size === 'sm' ? ' fm-ch-avatar--sm' : ''}`;
    // AI agents wear the colorized square FirstMate mark, like the app logo.
    if (String(user?.id || '').startsWith('agent_')) {
      return `<span class="${cls} fm-ch-avatar--agent" title="${esc(user?.name || 'AI agent')}"></span>`;
    }
    if (user?.avatar) return `<span class="${cls}"><img src="${esc(user.avatar)}" alt=""></span>`;
    const hue = [...cleanText(user?.name || '?')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
    return `<span class="${cls}" style="background:hsl(${hue},45%,42%)">${esc(initials(user?.name))}</span>`;
  }

  function renderBody(message, textValue){
    const source = String(textValue == null ? message.text || '' : textValue);
    const inline = (value) => {
      const tokens = [];
      const keep = html => `\u0000${tokens.push(html) - 1}\u0000`;
      const html = esc(value)
      .replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
      .replace(/https?:\/\/[^\s<>\u0000]+/g, url => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`))
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
      return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
    };
    const lines = source.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) {
        const code = [];
        while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
        blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
        const cells = (row, tag) => '<tr>' + row.trim().replace(/^\||\|$/g, '').split('|').map(cell => `<${tag}>${inline(cell.trim())}</${tag}>`).join('') + '</tr>';
        let table = '<table><thead>' + cells(line, 'th') + '</thead><tbody>';
        i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|')) table += cells(lines[++i], 'td');
        blocks.push(table + '</tbody></table>');
      } else if (/^\s*([-*] |\d+\. )/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
        let items = `<li>${inline(line.replace(pattern, ''))}</li>`;
        while (i + 1 < lines.length && pattern.test(lines[i + 1])) items += `<li>${inline(lines[++i].replace(pattern, ''))}</li>`;
        blocks.push(`<${ordered ? 'ol' : 'ul'}>${items}</${ordered ? 'ol' : 'ul'}>`);
      } else if (line.startsWith('> ')) blocks.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      else blocks.push(`<div>${inline(line) || '<br>'}</div>`);
    }
    let html = blocks.join('');
    for (const user of (message.mention_users || [])) {
      const name = cleanText(user.name);
      if (!name) continue;
      html = html.split(`@${esc(name)}`).join(`<span class="fm-ch-mention">@${esc(name)}</span>`);
    }
    return html;
  }

  // The wire format remains Markdown, so drafts, search, edits, scheduled sends,
  // and agent context use the same portable representation as older messages.
  function createMessageEditor(placeholder){
    const editor = el('div', 'fm-ch-rich-editor');
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', placeholder);
    editor.dataset.placeholder = placeholder;
    editor.mentionUsers = [];
    const serialize = node => {
      if (node.nodeType === 3) return node.textContent;
      const tag = node.tagName;
      const children = () => [...node.childNodes].map(serialize).join('');
      if (tag === 'BR') return '\n';
      if (tag === 'B' || tag === 'STRONG') return `**${children()}**`;
      if (tag === 'I' || tag === 'EM') return `_${children()}_`;
      if (tag === 'S' || tag === 'STRIKE') return `~~${children()}~~`;
      if (tag === 'PRE') return '\n```\n' + node.textContent + '\n```\n';
      if (tag === 'CODE') return '`' + children() + '`';
      if (tag === 'A') return /^https?:\/\//i.test(node.getAttribute('href') || '') ? `[${children()}](${node.getAttribute('href')})` : children();
      if (tag === 'TABLE') {
        const rows = [...node.rows].map(row => '| ' + [...row.cells].map(cell => [...cell.childNodes].map(serialize).join('').replace(/\|/g, '¦').replace(/\n/g, ' ')).join(' | ') + ' |');
        if (rows.length) rows.splice(1, 0, '| ' + [...node.rows[0].cells].map(() => '---').join(' | ') + ' |');
        return '\n' + rows.join('\n') + '\n';
      }
      if (tag === 'LI') return (node.parentElement.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}. ` : '- ') + children().trim() + '\n';
      if (tag === 'BLOCKQUOTE') return '> ' + children().trim() + '\n';
      return children() + (['DIV', 'P', 'UL', 'OL'].includes(tag) ? '\n' : '');
    };
    Object.defineProperty(editor, 'value', {
      get: () => [...editor.childNodes].map(serialize).join('').replace(/\n{3,}/g, '\n\n').trim(),
      set: value => { editor.innerHTML = value ? renderBody({ text:String(value) }) : ''; }
    });
    editor.insertText = text => { editor.focus(); document.execCommand('insertText', false, text); };
    editor.setRangeText = text => editor.insertText(text);
    editor.addEventListener('paste', event => {
      event.preventDefault();
      // Never accept executable or styled HTML from the clipboard.
      const text = event.clipboardData.getData('text/plain');
      document.execCommand('insertHTML', false, renderBody({ text }));
    });
    editor.addEventListener('keydown', event => {
      if (event.key === 'Tab' && root.getSelection()?.anchorNode?.parentElement?.closest('td,th')) {
        event.preventDefault();
        const cell = root.getSelection()?.anchorNode?.parentElement?.closest('td,th');
        const cells = [...editor.querySelectorAll('td,th')];
        const next = cells[cells.indexOf(cell) + (event.shiftKey ? -1 : 1)];
        if (next) { const range = document.createRange(); range.selectNodeContents(next); root.getSelection().removeAllRanges(); root.getSelection().addRange(range); }
      }
    });
    return editor;
  }

  function messageFormatBar(editor){
    const bar = el('div', 'fm-ch-formatbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_f4dce57ac0bb0e","Message formatting") ?? "Message formatting"));
    const commands = [['Bold', '<b>B</b>', 'bold'], ['Italic', '<i>I</i>', 'italic'], ['Strikethrough', '<s>S</s>', 'strikeThrough'], ['Bulleted list', '• List', 'insertUnorderedList'], ['Numbered list', '1. List', 'insertOrderedList'], ['Quote', '❞', 'formatBlock', 'blockquote'], ['Code block', '&lt;/&gt;', 'formatBlock', 'pre'], ['Link', 'Link', 'link'], ['Table', 'Table', 'table'], ['Clear formatting', 'Tx', 'removeFormat']];
    for (const [title, icon, command, value] of commands) {
      const button = el('button', '', icon);
      button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        editor.focus();
        if (command === 'table') {
          showPopover(button, pop => {
            pop.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_9cc744f8d3e3a9","Rows ") ?? "Rows ")}<input type="number" min="2" max="20" value="3" data-rows></label><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_911191f5b684ff","Columns ") ?? "Columns ")}<input type="number" min="2" max="8" value="3" data-columns></label>`;
            const range = root.getSelection()?.rangeCount ? root.getSelection().getRangeAt(0).cloneRange() : null;
            const insert = el('button', 'fm-ch-btn', 'Insert table');
            insert.onclick = () => {
              const rows = Math.max(2, Math.min(20, Number(pop.querySelector('[data-rows]').value) || 3));
              const columns = Math.max(2, Math.min(8, Number(pop.querySelector('[data-columns]').value) || 3));
              editor.focus(); if (range) { root.getSelection().removeAllRanges(); root.getSelection().addRange(range); }
              document.execCommand('insertHTML', false, '<table>' + Array.from({length:rows}, (_, r) => '<tr>' + Array.from({length:columns}, () => r ? '<td><br></td>' : `<th>${(globalThis.PlatformLanguage?.text("channels-ui","m_a81c579f34f382","Heading") ?? "Heading")}</th>`).join('') + '</tr>').join('') + '</table><div><br></div>');
              editor.dispatchEvent(new Event('input', {bubbles:true})); closePopover();
            }; pop.append(insert);
          });
        } else if (command === 'link') {
          const range = root.getSelection()?.rangeCount ? root.getSelection().getRangeAt(0).cloneRange() : null;
          showModal('Insert link', body => { body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_b90b7e637a2076","URL") ?? "URL")}</label><input type="url" placeholder="https://" data-url>`; }, [{label:(globalThis.PlatformLanguage?.text("channels-ui","m_900227393b1fd1","Insert") ?? "Insert"), primary:true, onClick:(close, body) => {
            const url = body.querySelector('[data-url]').value.trim();
            if (!/^https?:\/\/\S+$/i.test(url)) return body.querySelector('[data-url]').setCustomValidity('Enter an http or https URL.');
            editor.focus(); if (range) { root.getSelection().removeAllRanges(); root.getSelection().addRange(range); }
            if (root.getSelection()?.isCollapsed) document.execCommand('insertText', false, url);
            document.execCommand('createLink', false, url); editor.dispatchEvent(new Event('input', {bubbles:true})); close();
          }}]);
        } else { document.execCommand(command, false, value); editor.dispatchEvent(new Event('input', {bubbles:true})); }
      });
      bar.append(button);
    }
    return bar;
  }

  function debounce(fn, ms){
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // --- shared styles -----------------------------------------------------------

  function ensureStyles(){
    if (document.getElementById('fm-channels-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'fm-channels-ui-styles';
    style.textContent = `
.fm-ch,.fm-ch-popover,.fm-ch-modal-backdrop{--ch-bg:#fff;--ch-border:#e4e7ec;--ch-muted:#667085;--ch-text:#101828;--ch-accent:var(--primary-readable,var(--primary,#d93025));--ch-accent-soft:rgba(var(--primary-rgb,217,48,37),.08);--ch-danger:#d92d20;--ch-hover:#f7f8fa;--ch-sidebar:#f9fafb}
.fm-ch{display:flex;height:100%;min-height:0;background:var(--ch-bg);color:var(--ch-text);font-size:13.5px;line-height:1.45;border:1px solid var(--ch-border);border-radius:12px;overflow:hidden}
.fm-ch *,.fm-ch-popover *,.fm-ch-modal-backdrop *{box-sizing:border-box}
.fm-ch--embedded{border:none;border-radius:0}
.fm-ch--conversation{border:none;border-radius:0}
.fm-ch--list{border:none;border-radius:0;background:transparent}
.fm-ch--list .fm-ch-sidebar{width:100%;min-width:0;border-right:none;background:transparent;padding:0}
:where(.fm-ch,.fm-ch-popover,.fm-ch-modal-backdrop) button{font:inherit;cursor:pointer;border:none;background:none;color:inherit;padding:0}
.fm-ch-sidebar{width:240px;min-width:200px;background:var(--ch-sidebar);border-right:1px solid var(--ch-border);display:flex;flex-direction:column;overflow-y:auto;padding:10px 0;flex-shrink:0}
.fm-ch-side-section{padding:8px 10px 2px}
.fm-ch-side-head{display:flex;align-items:center;gap:2px;padding:2px 8px;color:var(--ch-muted);font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.06em;cursor:pointer}
.fm-ch-side-head button{color:var(--ch-muted);font-size:11px;line-height:1;padding:4px 7px;border-radius:7px}
.fm-ch-side-head button:hover{background:#eef1f5;color:var(--ch-accent)}
.fm-ch-side-title{min-width:0;flex:1;text-align:left}
.fm-ch-side-toggle{display:grid;place-items:center;flex:0 0 auto}
.fm-ch-side-toggle i{width:8px;font-size:8px;transition:transform .16s ease}
.fm-ch-side-section.collapsed .fm-ch-side-toggle i{transform:rotate(-90deg)}
.fm-ch-side-head>.fm-ch-group-badge{margin:0 3px 0 6px}
.fm-ch-group-badge{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--ch-accent);color:#fff;font-size:9px;font-weight:950;letter-spacing:0}
.fm-ch-side-items[hidden]{display:none}
.fm-ch-side-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:5px 10px;border-radius:9px;color:#344054;min-height:30px;font-size:12px;font-weight:500}
.fm-ch-side-item:hover{background:#eef1f5}
.fm-ch-side-item.active{background:var(--ch-accent-soft);color:var(--ch-accent);font-weight:650}
.fm-ch-side-item .fm-ch-side-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-ch-side-item.unread .fm-ch-side-label{font-weight:750;color:var(--ch-text)}
.fm-ch-side-item .fm-ch-hash{color:var(--ch-muted);width:16px;text-align:center;flex-shrink:0;font-size:11px}
.fm-ch-side-item.active .fm-ch-hash{color:var(--ch-accent)}
.fm-ch-badge{background:var(--ch-accent);color:#fff;font-size:10px;font-weight:900;border-radius:999px;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px;flex-shrink:0}
.fm-ch-main{position:relative;flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.fm-ch-header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--ch-border);min-height:52px}
.fm-ch-header-title{font-weight:900;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:8px}
.fm-ch-header-title i{color:var(--ch-muted);font-size:12px}
.fm-ch-header-topic{color:var(--ch-muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:40px}
.fm-ch-header-actions{display:flex;gap:4px;margin-left:auto;flex-shrink:0}
.fm-ch-tabs{display:flex;align-items:center;gap:4px;padding:0 14px;border-bottom:1px solid var(--ch-border);min-height:38px;overflow-x:auto}
.fm-ch-tabs[hidden]{display:none}
.fm-ch-tab{align-self:stretch;padding:0 10px!important;border-bottom:2px solid transparent!important;color:var(--ch-muted)!important;font-size:11.5px!important;font-weight:750!important;white-space:nowrap}
.fm-ch-tab:hover{color:var(--ch-text)!important}.fm-ch-tab.active{border-bottom-color:var(--ch-accent)!important;color:var(--ch-accent)!important}
.fm-ch-quick{padding:4px 10px 8px;display:flex;flex-direction:column;gap:2px}
.fm-ch-resource-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;padding:14px}
.fm-ch-resource{display:flex;align-items:center;gap:10px;border:1px solid var(--ch-border);border-radius:10px;padding:10px;background:#fff;min-width:0}
.fm-ch-resource-icon{width:36px;height:36px;border-radius:8px;background:var(--ch-accent-soft);color:var(--ch-accent);display:grid;place-items:center;flex:0 0 auto}
.fm-ch-resource-copy{min-width:0;flex:1}.fm-ch-resource-copy strong,.fm-ch-resource-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-ch-resource-copy span{font-size:10.5px;color:var(--ch-muted)}
.fm-ch-workflow-list{display:flex;flex-direction:column;gap:10px}
.fm-ch-workflow-list .fm-ch-resource{width:100%;align-items:flex-start;gap:14px;padding:12px 14px;text-align:left}
.fm-ch-workflow-list .fm-ch-resource:hover{border-color:#cfd6e1;background:var(--ch-hover)}
.fm-ch-workflow-list .fm-ch-resource:disabled{cursor:default;opacity:.5}
.fm-ch-workflow-list .fm-ch-resource-icon{margin-top:1px}
.fm-ch-workflow-list .fm-ch-resource-copy{text-align:left}
.fm-ch-workflow-list .fm-ch-resource-copy strong{margin-bottom:3px;font-size:13px;font-weight:750;line-height:1.3}
.fm-ch-workflow-list .fm-ch-resource-copy span{font-size:11.5px;line-height:1.45;white-space:normal}
.fm-ch-formatbar{display:flex;align-items:center;gap:2px;padding-bottom:5px;border-bottom:1px solid #f0f2f5;margin-bottom:5px}.fm-ch-formatbar button{width:26px;height:24px;border-radius:6px;color:var(--ch-muted)}.fm-ch-formatbar button:hover{background:var(--ch-hover);color:var(--ch-accent)}
.fm-ch-huddle{position:relative;min-width:0;min-height:0;overflow:auto;background:#111827;color:#fff;padding:14px;display:flex;flex-direction:column;gap:8px}

.fm-ch-huddle-head,.fm-ch-huddle-actions{display:flex;align-items:center;gap:8px}
.fm-ch-huddle-head{min-height:20px}.fm-ch-huddle-head strong{flex:1}
.fm-ch-huddle-head>span{font-size:11px;color:#d0d5dd;white-space:nowrap}
.fm-ch-huddle-head button{width:28px;height:28px;border-radius:8px;color:#d0d5dd;display:grid;place-items:center;flex:0 0 auto}.fm-ch-huddle-head button:hover{background:#344054;color:#fff}
.fm-ch-huddle-recording{display:inline-flex;align-items:center;gap:5px;color:#fda29b!important;font-weight:750}.fm-ch-huddle-recording i{font-size:7px;color:#f04438;animation:fm-ch-rec-pulse 1.4s ease-in-out infinite}
@keyframes fm-ch-rec-pulse{50%{opacity:.35}}
.fm-ch-huddle-actions{margin-top:10px;justify-content:center}.fm-ch-huddle-actions button{width:36px;height:36px;border-radius:999px;background:#344054;color:#fff;display:grid;place-items:center}.fm-ch-huddle-actions button:hover{background:#475467}.fm-ch-huddle-actions button.danger{background:#d92d20}.fm-ch-huddle-actions button:disabled{opacity:.55;cursor:default}
.fm-ch-huddle video{display:block;width:100%;max-height:220px;object-fit:contain;border-radius:9px;background:#000;margin-top:9px}


.fm-ch-huddle-remotes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.fm-ch-huddle-remotes:empty{display:none}.fm-ch-huddle-remotes video{height:118px;object-fit:cover}
.fm-ch-huddle-roster{display:flex;flex-direction:column;gap:5px;margin-top:9px;padding:8px;border-radius:9px;background:#1d2939}
.fm-ch-huddle-person{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;color:#eaecf0}
.fm-ch-huddle-person .fm-ch-avatar{width:25px;height:25px;font-size:9px}
.fm-ch-huddle-person-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.fm-ch-huddle-person-media{display:flex;gap:7px;color:#98a2b3;font-size:10px}.fm-ch-huddle-person-media .on{color:#75e0a7}.fm-ch-huddle-person-media .off{color:#fda29b}
.fm-ch-huddle-status{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:10px;color:#98a2b3}.fm-ch-huddle-status i{font-size:7px;color:#12b76a}


.fm-ch-huddle [hidden]{display:none!important}

.fm-ch-call-stage{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;flex:1;min-height:160px;overflow:auto}
.fm-ch-call-tile{position:relative;background:linear-gradient(145deg,#293347,#182233);border:1px solid #344054;border-radius:12px;min-height:180px;overflow:hidden;display:grid;place-items:center}
.fm-ch-call-tile.screen{grid-column:1/-1;min-height:240px}
.fm-ch-call-tile video{margin:0;width:100%;height:100%;max-height:none;object-fit:cover;border-radius:0}
.fm-ch-call-tile.screen video{object-fit:contain}
.fm-ch-call-identity{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:30px 15px}
.fm-ch-call-identity .fm-ch-avatar{width:64px;height:64px;font-size:24px;border-radius:18px}
.fm-ch-call-identity small{color:#98a2b3}
.fm-ch-call-name{position:absolute;bottom:9px;left:9px;max-width:calc(100% - 18px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#101828cc;border-radius:5px;padding:4px 7px;font-size:11px}

.fm-ch-huddle-actions{flex-wrap:wrap;flex-shrink:0}
.fm-ch-call-reaction{position:absolute;left:50%;top:22%;display:flex;flex-direction:column;align-items:center;pointer-events:none;background:#101828cc;border-radius:20px;padding:10px;z-index:5;animation:fm-ch-call-reaction 4s ease-out forwards}.fm-ch-call-reaction span{font-size:54px}
@keyframes fm-ch-call-reaction{0%{opacity:0;transform:translateY(20px)}15%,80%{opacity:1}100%{opacity:0;transform:translateY(-35px)}}
@media(prefers-reduced-motion:reduce){.fm-ch-call-reaction{animation:none}}
.fm-ch-call-settings-tabs{display:flex;gap:4px;border-bottom:1px solid #e4e7ec;margin-bottom:16px}.fm-ch-call-settings-tabs button{padding:10px 8px;color:#667085}.fm-ch-call-settings-tabs button[aria-selected=true]{color:var(--ch-accent);border-bottom:2px solid currentColor;font-weight:700}
.fm-ch-call-settings-panel>label{display:block;margin-top:12px}.fm-ch-call-settings-panel>.fm-ch-btn{margin:6px 6px 0 0}.fm-ch-call-settings-panel p{line-height:1.5;color:#667085}
.fm-ch-huddle-actions button{width:52px;height:50px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;font-size:15px}.fm-ch-huddle-actions button small{font-size:10px;font-weight:500}
.fm-ch-huddle-actions button[aria-pressed=false]{background:#293347;color:#d0d5dd}.fm-ch-huddle-actions button[aria-pressed=true]{background:#475467;color:#fff}
.fm-ch-huddle-roster>button{padding:8px;background:#d92d20;border-radius:6px;margin-top:8px}
.fm-ch-shortcut{font-size:9px;color:#98a2b3;margin-left:auto}
.fm-ch-icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;color:var(--ch-muted);font-size:12.5px}
.fm-ch-icon-btn:hover{background:var(--ch-hover);color:var(--ch-accent)}
.fm-ch-icon-btn.on{background:var(--ch-accent-soft);color:var(--ch-accent)}
.fm-ch-body{flex:1;display:flex;min-height:0}
.fm-ch-list-wrap{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.fm-ch-list{flex:1;overflow-y:auto;padding:10px 0 4px}
.fm-ch-day{display:flex;align-items:center;gap:10px;margin:12px 16px 4px;color:var(--ch-muted);font-size:12px;font-weight:600}
.fm-ch-day::before,.fm-ch-day::after{content:'';flex:1;height:1px;background:var(--ch-border)}
.fm-ch-new-divider{display:flex;align-items:center;gap:8px;margin:8px 16px;color:var(--ch-danger);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.fm-ch-new-divider::after{content:'';flex:1;height:1px;background:var(--ch-danger)}
.fm-ch-msg{position:relative;display:flex;gap:10px;padding:3px 16px}
.fm-ch-msg:hover{background:var(--ch-hover)}
.fm-ch-msg.highlight{background:#fef4e6;animation:fm-ch-flash 2.4s ease forwards}
@keyframes fm-ch-flash{0%,60%{background:#fef4e6}100%{background:transparent}}
.fm-ch-msg-gutter{width:36px;flex-shrink:0;display:flex;justify-content:center;align-items:flex-start}
.fm-ch-msg-time-hover{visibility:hidden;color:var(--ch-muted);font-size:11px;align-self:center}
.fm-ch-msg:hover .fm-ch-msg-time-hover{visibility:visible}
.fm-ch-avatar{width:34px;height:34px;border-radius:8px;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;flex-shrink:0}
.fm-ch-avatar--agent{background:var(--primary-readable,var(--primary,#d93025));-webkit-mask:url('/images/logo_square.png') center / 82% no-repeat;mask:url('/images/logo_square.png') center / 82% no-repeat;border-radius:0}
.fm-ch-avatar img{width:100%;height:100%;object-fit:cover}
.fm-ch-avatar--sm{width:22px;height:22px;font-size:10px;border-radius:6px}
.fm-ch-msg-content{flex:1;min-width:0}
.fm-ch-msg-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.fm-ch-msg-author{font-weight:850}
.fm-ch-msg-time{color:var(--ch-muted);font-size:11px}
.fm-ch-msg-edited{color:var(--ch-muted);font-size:11px;cursor:pointer;text-decoration:none}
.fm-ch-msg-edited:hover{text-decoration:underline}
.fm-ch-msg-body{word-wrap:break-word;overflow-wrap:break-word;white-space:normal}
.fm-ch-msg-body a{color:var(--ch-accent)}
.fm-ch-translate{width:22px;height:20px;margin-left:-2px;border-radius:6px!important;display:inline-flex;align-items:center;justify-content:center;color:var(--ch-muted)!important;font-size:10px!important;align-self:center}
.fm-ch-translate:hover,.fm-ch-translate.on{background:var(--ch-accent-soft)!important;color:var(--ch-accent)!important}
.fm-ch-translate.loading i{animation:fm-ch-spin .75s linear infinite}
@keyframes fm-ch-spin{to{transform:rotate(360deg)}}
.fm-ch-translation-note{display:inline-flex;align-items:center;gap:5px;margin-top:2px;color:var(--ch-muted);font-size:9.5px;font-weight:700}
.fm-ch-translation-note i{font-size:9px}
.fm-ch-mention{background:var(--ch-accent-soft);color:var(--ch-accent);border-radius:4px;padding:0 3px;font-weight:600}
.fm-ch-msg-deleted{color:var(--ch-muted);font-style:italic;display:flex;align-items:center;gap:8px}
.fm-ch-restore-link{color:var(--ch-muted);font-size:12px;font-style:normal;text-decoration:underline;opacity:.7}
.fm-ch-restore-link:hover{color:var(--ch-accent);opacity:1}
.fm-ch-tags{display:inline-flex;gap:4px;margin-left:2px}
.fm-ch-tag{display:inline-flex;align-items:center;gap:4px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:1px 7px;font-size:9px;font-weight:800;letter-spacing:.03em;text-transform:uppercase}
.fm-ch-audience-note{color:var(--ch-muted);font-size:10px;border:1px solid var(--ch-border);padding:0 6px;border-radius:999px}
.fm-ch-reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.fm-ch-reaction{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--ch-border);background:#fff;border-radius:999px;padding:1px 8px;font-size:12px}
.fm-ch-reaction:hover{border-color:var(--ch-accent)}
.fm-ch-reaction.mine{background:var(--ch-accent-soft);border-color:var(--ch-accent);color:var(--ch-accent)}
.fm-ch-thread-link{display:inline-flex;align-items:center;gap:6px;margin-top:4px;color:var(--ch-accent);font-size:12px;font-weight:600;border-radius:6px;padding:2px 6px}
.fm-ch-thread-link:hover{background:var(--ch-accent-soft)}
.fm-ch-attachments{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.fm-ch-attachment{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ch-border);border-radius:8px;padding:6px 10px;font-size:12px;color:#344054;text-decoration:none;max-width:260px}
.fm-ch-attachment:hover{background:var(--ch-hover)}
.fm-ch-attachment-img{max-width:260px;max-height:180px;border-radius:8px;border:1px solid var(--ch-border);display:block}
.fm-ch-toolbar{position:absolute;top:-14px;right:14px;display:none;background:#fff;border:1px solid var(--ch-border);border-radius:8px;box-shadow:0 2px 8px rgba(15,23,42,.1);z-index:6}
.fm-ch-msg:hover .fm-ch-toolbar{display:inline-flex}
.fm-ch-toolbar button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--ch-muted)}
.fm-ch-toolbar button:hover{background:var(--ch-hover);color:var(--ch-accent)}
.fm-ch-toolbar button.danger:hover{color:var(--ch-danger)}
.fm-ch-toolbar button.on{color:var(--ch-accent)}
.fm-ch-typing{min-height:20px;color:var(--ch-muted);font-size:11px;padding:0 16px 4px;font-style:italic}
.fm-ch-composer{border-top:1px solid var(--ch-border);padding:10px 16px 12px}
.fm-ch-composer-box{border:1px solid var(--ch-border);border-radius:10px;padding:8px 10px;background:#fff}
.fm-ch-composer-box:focus-within{border-color:var(--ch-accent)}
.fm-ch-composer textarea{width:100%;border:none;outline:none;resize:none;font:inherit;background:transparent;max-height:180px;min-height:22px;color:var(--ch-text)}
.fm-ch-composer-row{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.fm-ch-audio-mount:not(:empty){width:100%;animation:fm-ch-audio-in .18s ease-out}.fm-ch-audio-mount .fm-an-inline{margin-top:7px}
@keyframes fm-ch-audio-in{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
.fm-ch-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--ch-border);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600;color:var(--ch-muted);background:#fff}
.fm-ch-chip.on{border-color:var(--ch-accent);color:var(--ch-accent);background:var(--ch-accent-soft)}
.fm-ch-send{margin-left:auto;background:var(--ch-accent);color:#fff;border-radius:9px;padding:6px 15px;font-weight:850;font-size:12.5px}
.fm-ch-send:hover{filter:brightness(1.06)}
.fm-ch-send:disabled{opacity:.45;cursor:default}
.fm-ch-rich-editor{min-height:64px;max-height:220px;overflow:auto;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 2px;font-size:14px;line-height:1.5}
.fm-ch-rich-editor:empty:before{content:attr(data-placeholder);color:var(--ch-muted);pointer-events:none}
.fm-ch-rich-editor table,.fm-ch-msg-body table{border-collapse:collapse;margin:8px 0;width:100%;table-layout:fixed}
.fm-ch-rich-editor td,.fm-ch-rich-editor th,.fm-ch-msg-body td,.fm-ch-msg-body th{border:1px solid var(--ch-border);padding:7px;min-width:60px;text-align:left;white-space:pre-wrap}
.fm-ch-rich-editor th,.fm-ch-msg-body th{background:var(--ch-hover);font-weight:700}
.fm-ch-rich-editor blockquote,.fm-ch-msg-body blockquote{border-left:3px solid #98a2b3;margin:6px 0;padding:4px 12px;color:var(--ch-muted)}
.fm-ch-rich-editor pre,.fm-ch-msg-body pre{padding:10px;background:#f2f4f7;border-radius:6px;white-space:pre-wrap}
.fm-ch-formatbar{flex-wrap:wrap}.fm-ch-formatbar button{width:auto;min-width:28px;white-space:nowrap;padding:4px 7px!important}
.fm-ch-send-pair{margin-left:auto;display:flex;align-items:center;gap:4px;border-left:1px solid var(--ch-border);padding-left:8px}
.fm-ch-send-pair .fm-ch-send{margin-left:0}
.fm-ch-message-menu{min-width:210px;padding:5px;display:flex;flex-direction:column}
.fm-ch-message-menu button{text-align:left;padding:8px 10px;border-radius:6px;display:flex;gap:10px;align-items:center}
.fm-ch-message-menu button:hover,.fm-ch-message-menu button:focus{background:var(--ch-hover)}
.fm-ch-toolbar:focus-within{opacity:1;pointer-events:auto}
.fm-ch-msg:focus-within .fm-ch-toolbar{display:inline-flex}
.fm-ch-edit-note{color:var(--ch-muted);font-size:11px;display:flex;gap:8px;align-items:center;margin-bottom:4px}
.fm-ch-edit-note button{color:var(--ch-accent);text-decoration:underline;font-size:11px}
.fm-ch-pending-files{display:flex;gap:6px;flex-wrap:wrap}
.fm-ch-panel{width:340px;min-width:280px;border-left:1px solid var(--ch-border);display:flex;flex-direction:column;min-height:0;background:#fff;flex-shrink:0}
.fm-ch-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--ch-border);font-weight:900;font-size:13px}
.fm-ch-panel-head i{color:var(--ch-muted);font-size:11px;margin-right:5px}
.fm-ch-panel-body{flex:1;overflow-y:auto;padding:8px 0}
.fm-ch-panel .fm-ch-composer{padding:8px 12px 10px}
.fm-ch-empty{color:var(--ch-muted);text-align:center;padding:32px 20px;font-size:13px}
.fm-ch-popover{position:fixed;z-index:1601;background:#fff;border:1px solid var(--ch-border);border-radius:10px;box-shadow:0 8px 28px rgba(15,23,42,.16);max-width:360px;min-width:240px;max-height:340px;overflow-y:auto}
.fm-ch-popover-head{padding:8px 12px;border-bottom:1px solid var(--ch-border);font-weight:700;font-size:12px;color:var(--ch-muted)}
.fm-ch-revision{padding:8px 12px;border-bottom:1px solid var(--ch-border)}
.fm-ch-revision:last-child{border-bottom:none}
.fm-ch-revision-meta{color:var(--ch-muted);font-size:11px;margin-bottom:2px}
.fm-ch-revision.current .fm-ch-revision-meta{color:var(--ch-accent);font-weight:700}
.fm-ch-emoji-grid{display:grid;grid-template-columns:repeat(8,1fr)}
.fm-ch-emoji-grid button{font-size:18px;padding:4px;border-radius:6px}
.fm-ch-emoji-grid button:hover{background:var(--ch-hover)}
.fm-ch-emoji-group{padding:6px 10px 0;color:var(--ch-muted);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.fm-ch-emoji-search{width:calc(100% - 16px);margin:8px;padding:5px 8px;border:1px solid var(--ch-border);border-radius:8px;font:inherit;font-size:12px;outline:none}
.fm-ch-modal-backdrop{position:fixed;inset:0;background:rgba(16,24,40,.4);z-index:1600;display:flex;align-items:center;justify-content:center}
.fm-ch-modal,.fm-ch-popover{color:var(--ch-text);font-family:inherit;font-size:13.5px;line-height:1.45;box-sizing:border-box}.fm-ch-profile-trigger{border:0;background:none;padding:0;cursor:pointer;color:inherit;font:inherit;text-align:left}.fm-ch-msg-author.fm-ch-profile-trigger{font-weight:700}.fm-ch-profile-trigger:focus-visible{outline:2px solid #2563eb;outline-offset:3px}.fm-ch-profile-card{padding:18px;display:grid;gap:12px;overflow-wrap:anywhere}.fm-ch-modal{background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(15,23,42,.24);width:420px;max-width:calc(100vw - 32px);max-height:80vh;display:flex;flex-direction:column}
.fm-ch-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--ch-border);font-weight:900;font-size:14.5px}
.fm-ch-modal-body{padding:14px 16px;overflow-y:auto}
.fm-ch-modal-body label{display:block;font-size:12px;font-weight:600;color:#344054;margin:10px 0 4px}
.fm-ch-modal-body input[type=text],.fm-ch-modal-body select{width:100%;padding:7px 10px;border:1px solid var(--ch-border);border-radius:8px;font:inherit;outline:none}
.fm-ch-modal-body input[type=text]:focus{border-color:var(--ch-accent)}
.fm-ch-setting-group{margin-top:16px;padding:13px;border:1px solid var(--ch-border);border-radius:10px;background:#f9fafb}
.fm-ch-setting-group>strong{display:block;font-size:12.5px;color:var(--ch-text)}
.fm-ch-setting-group>p{margin:4px 0 8px;color:var(--ch-muted);font-size:11px;line-height:1.45}
.fm-ch-modal-body .fm-ch-check-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0;padding:9px 0;border-top:1px solid #eaecf0;cursor:pointer}
.fm-ch-check-row>span{min-width:0}.fm-ch-check-row strong,.fm-ch-check-row small{display:block}.fm-ch-check-row strong{font-size:12px;color:#344054}.fm-ch-check-row small{margin-top:2px;color:var(--ch-muted);font-size:10.5px;font-weight:500;line-height:1.35}
.fm-ch-check-row input[type=checkbox]{width:17px;height:17px;flex:0 0 auto;accent-color:var(--ch-accent)}
.fm-ch-check-row:has(input:disabled){cursor:default;opacity:.55}
.fm-ch-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--ch-border)}
.fm-ch-btn{border-radius:9px;padding:8px 15px;font-weight:850;font-size:12.5px;border:1px solid #d8dee8;color:#344054;background:#fff}
.fm-ch-btn:hover{background:var(--ch-hover)}
.fm-ch-btn.primary{background:var(--ch-accent);border-color:var(--ch-accent);color:#fff}
.fm-ch-btn.primary:hover{filter:brightness(1.06)}
.fm-ch-member-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:8px}
.fm-ch-member-row:hover{background:var(--ch-hover)}
.fm-ch-member-row .name{flex:1}
.fm-ch-member-choice{width:100%;min-height:46px;padding:7px 9px;border:1px solid transparent;text-align:left;transition:background .14s ease,border-color .14s ease,color .14s ease}
.fm-ch-member-choice+.fm-ch-member-choice{margin-top:5px}
.fm-ch-member-choice:hover{border-color:var(--ch-border)}
.fm-ch-member-choice.selected{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:var(--ch-accent-soft);color:var(--ch-accent)}
.fm-ch-member-choice .name{color:#344054;font-weight:800}
.fm-ch-member-choice .fm-ch-member-check{width:22px;height:22px;border:1px solid #cbd3dd;border-radius:7px;background:#fff;color:#fff;display:grid;place-items:center;flex:0 0 auto;font-size:10px;transition:.14s ease}
.fm-ch-member-choice .fm-ch-member-check i{opacity:0;transform:scale(.7);transition:.14s ease}
.fm-ch-member-choice.selected .fm-ch-member-check{border-color:var(--ch-accent);background:var(--ch-accent)}
.fm-ch-member-choice.selected .fm-ch-member-check i{opacity:1;transform:scale(1)}
.fm-ch-dm-help{margin:0 0 9px;color:var(--ch-muted);font-size:11.5px;line-height:1.45}
.fm-ch-result{padding:8px 14px;border-bottom:1px solid var(--ch-border);cursor:pointer}
.fm-ch-result:hover{background:var(--ch-hover)}
.fm-ch-result-meta{color:var(--ch-muted);font-size:11px;margin-bottom:2px}
.fm-ch-view-toolbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;padding:9px 14px;background:rgba(255,255,255,.96);border-bottom:1px solid var(--ch-border);backdrop-filter:blur(8px);flex-wrap:wrap}
.fm-ch-filter{padding:5px 9px!important;border:1px solid var(--ch-border)!important;border-radius:999px!important;color:var(--ch-muted)!important;font-size:11px!important;font-weight:700!important}.fm-ch-filter:hover{background:var(--ch-hover)!important}.fm-ch-filter.on{border-color:var(--ch-accent)!important;background:var(--ch-accent-soft)!important;color:var(--ch-accent)!important}
.fm-ch-view-summary{margin-left:auto;color:var(--ch-muted);font-size:10.5px}
.fm-ch-attention-row{display:grid;grid-template-columns:32px minmax(0,1fr) 54px;gap:12px;align-items:center;padding:11px 14px;border-bottom:1px solid var(--ch-border);cursor:pointer}.fm-ch-attention-row:hover{background:var(--ch-hover)}.fm-ch-attention-row.unread{background:#fffaf5}.fm-ch-attention-row.unread:hover{background:#fef6ed}
.fm-ch-attention-icon{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--ch-accent-soft);color:var(--ch-accent)}
.fm-ch-attention-main{display:block;min-width:0}.fm-ch-attention-heading{display:flex;align-items:baseline;gap:10px;min-width:0;flex-wrap:wrap}.fm-ch-attention-title{font-size:12px;font-weight:750;color:var(--ch-text);line-height:1.35}.fm-ch-attention-heading .fm-ch-result-meta{margin:0;white-space:nowrap;line-height:1.35}.fm-ch-attention-copy{display:block;margin-top:4px;font-size:12px;line-height:1.45;color:#344054;overflow:hidden;text-overflow:ellipsis}
.fm-ch-attention-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;align-self:center;min-height:30px}.fm-ch-attention-actions .fm-ch-icon-btn{width:28px;height:28px;border:1px solid #b8c7d9;background:#e2ebf5;color:#244f78;border-radius:8px}.fm-ch-attention-actions .fm-ch-icon-btn:hover{border-color:#91a9c2;background:#cfdeed;color:#153a5b}.fm-ch-attention-dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#3478a9;box-shadow:0 0 0 2px #fff;transform:translateY(1px)}
.fm-ch-unread-group{border-bottom:1px solid var(--ch-border)}.fm-ch-unread-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#f9fafb;position:sticky;top:47px;z-index:2}.fm-ch-unread-head strong{flex:1;font-size:12px}.fm-ch-unread-count{font-size:10px;color:var(--ch-muted)}
.fm-ch-thread-card{margin:10px 14px;border:1px solid var(--ch-border);border-radius:11px;overflow:hidden;background:#fff;cursor:pointer}.fm-ch-thread-card:hover{border-color:#cfd6e1;box-shadow:0 3px 10px rgba(16,24,40,.05)}.fm-ch-thread-card.unread{border-left:3px solid var(--ch-accent)}.fm-ch-thread-card-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f9fafb;border-bottom:1px solid var(--ch-border);font-size:10.5px;color:var(--ch-muted)}.fm-ch-thread-card-head strong{color:var(--ch-text);font-size:11.5px}.fm-ch-thread-card-body{padding:6px 0}.fm-ch-thread-latest{padding:8px 12px;border-top:1px solid #f0f2f5;color:#344054;font-size:12px}
.fm-ch--compact .fm-ch-msg{padding:2px 12px}
.fm-ch--compact .fm-ch-list{padding:6px 0 2px}
.fm-ch--compact .fm-ch-composer{padding:8px 12px 10px}
.fm-ch--compact .fm-ch-header{min-height:42px;padding:6px 12px}
.fm-ch-mobile-back{display:none;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:9px;color:var(--ch-muted);font-size:15px}
.fm-ch-mobile-back:hover{background:#eef1f5;color:var(--ch-accent)}
.fm-ch-header-actions--menu-wrap{position:relative;margin-left:auto}
.fm-ch-header-menu{position:absolute;top:40px;right:0;z-index:40;display:none;flex-direction:column;min-width:224px;background:var(--ch-bg);border:1px solid var(--ch-border);border-radius:12px;box-shadow:0 16px 40px rgba(15,23,42,.16);padding:6px}
.fm-ch-header-menu.open{display:flex}
.fm-ch-header-menu-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;font-size:13px;font-weight:650;text-align:left;color:var(--ch-text)}
.fm-ch-header-menu-item:hover{background:var(--ch-hover)}
.fm-ch-header-menu-item i{width:18px;text-align:center;color:var(--ch-muted)}
/* Slack-style mobile navigation for the full workspace: the channel rail and
   the conversation are alternating full-width screens. fm-ch--mobile-list
   shows the rail; selecting anything navigates to the conversation, whose
   header gains a back button. */
@media (max-width:760px){
.fm-ch--full{position:relative;border:none;border-radius:0}
.fm-ch--full .fm-ch-sidebar{position:absolute;inset:0;width:100%;min-width:0;z-index:5;display:none;border-right:none;background:var(--ch-sidebar)}
.fm-ch--full.fm-ch--mobile-list .fm-ch-sidebar{display:flex}
.fm-ch--full .fm-ch-mobile-back{display:inline-flex}
.fm-ch--full .fm-ch-header{padding:10px 12px}
.fm-ch-panel{position:absolute;inset:0;width:100%;min-width:0;z-index:6}
.fm-ch-huddle{min-width:0;width:min(440px,calc(100vw - 20px))}
.fm-ch-popover{max-width:min(360px,calc(100vw - 16px))}
}
`;
    style.textContent += `
.fm-ch{position:relative}
.fm-ch-profile-card{width:320px;max-width:calc(100vw - 16px);padding:22px;gap:16px;box-shadow:0 12px 40px #10182824;border-radius:14px}
.fm-ch-profile-summary{display:flex;gap:14px;align-items:center;padding-right:12px}.fm-ch-profile-summary .fm-ch-avatar{width:64px;height:64px;border-radius:12px;font-size:24px}
.fm-ch-profile-summary strong,.fm-ch-profile-hero strong{display:block;font-size:18px;line-height:1.3;letter-spacing:-.3px}.fm-ch-profile-summary span:not(.fm-ch-avatar),.fm-ch-profile-summary small{display:block;color:#667085;margin-top:4px}
.fm-ch-profile-email{font-size:12px;color:#475467;text-decoration:none;overflow-wrap:anywhere}
.fm-ch-profile-actions{display:flex;gap:8px}.fm-ch-profile-actions .fm-ch-btn{flex:1;white-space:nowrap;padding:8px 10px}
.fm-ch-profile-close{position:absolute;right:8px;top:8px;width:24px;height:24px;color:#667085!important;border-radius:6px}
.fm-ch-profile-panel{flex:0 0 320px;width:320px;min-width:0;max-width:100%;background:#fff;border-left:1px solid #e4e7ec;display:flex;flex-direction:column;z-index:8}
.fm-ch-profile-panel-head{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #e4e7ec}
.fm-ch-profile-panel-body{overflow:auto;padding:24px;display:flex;flex-direction:column;gap:20px}
.fm-ch-profile-hero .fm-ch-avatar{width:112px;height:112px;font-size:40px;border-radius:20px;margin-bottom:18px}.fm-ch-profile-hero span:not(.fm-ch-avatar),.fm-ch-profile-hero small{display:block;color:#667085;margin-top:6px}
.fm-ch-profile-details{margin:0;padding-top:20px;border-top:1px solid #eaecf0;overflow-wrap:anywhere}.fm-ch-profile-details dt{font-size:11px;color:#667085;margin-top:16px}.fm-ch-profile-details dt:first-child{margin-top:0}.fm-ch-profile-details dd{margin:4px 0 0;font-size:13px}.fm-ch-profile-details a{color:#175cd3;text-decoration:none}.fm-ch-profile-panel-body h3{margin:0;font-size:13px}.fm-ch-profile-about{white-space:pre-wrap;margin:0}.fm-ch-profile-empty{color:#667085;font-size:12px}
.fm-ch.fm-ch-profile-narrow .fm-ch-profile-panel{position:absolute;inset:0 0 0 auto;width:min(360px,100%);box-shadow:-12px 0 32px #1018281a}
`;
    style.textContent += `
:where(.fm-call-window) button{font:inherit;cursor:pointer;border:0}
.fm-call-window .fm-ch-huddle{width:100%;height:100%;flex:1}
.fm-call-window .fm-ch-call-stage{flex:1;min-height:120px}.fm-call-window .fm-ch-huddle-head{flex:none;min-height:20px}.fm-call-window .fm-ch-huddle-head>span{margin-left:0}.fm-call-window .fm-ch-huddle-actions{flex:none;flex-wrap:wrap}
`;
    document.head.appendChild(style);
  }

  // --- popover / modal plumbing -------------------------------------------------

  let openPopover = null;
  function closePopover(){
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
      document.removeEventListener('mousedown', popoverOutside, true);
    }
  }
  function popoverOutside(event){
    if (openPopover && !openPopover.contains(event.target)) closePopover();
  }
  function showPopover(anchor, build){
    closePopover();
    const pop = el('div', 'fm-ch-popover');
    build(pop);
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - popRect.height - 6);
    let left = Math.min(rect.left, window.innerWidth - popRect.width - 8);
    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.left = `${Math.max(8, left)}px`;
    openPopover = pop;
    setTimeout(() => document.addEventListener('mousedown', popoverOutside, true), 0);
    return pop;
  }

  function showModal(title, buildBody, buttons){
    const backdrop = el('div', 'fm-ch-modal-backdrop');
    const modal = el('div', 'fm-ch-modal');
    const head = el('div', 'fm-ch-modal-head', `<span>${esc(title)}</span>`);
    const closeBtn = el('button', 'fm-ch-icon-btn', '<i class="fas fa-xmark"></i>');
    head.appendChild(closeBtn);
    const body = el('div', 'fm-ch-modal-body');
    const foot = el('div', 'fm-ch-modal-foot');
    modal.append(head, body, foot);
    backdrop.appendChild(modal);
    const previousFocus = document.activeElement;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
    closeBtn.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_a21847cfbafe98","Close dialog") ?? "Close dialog"));
    const keydown = event => {
      if (backdrop !== [...document.querySelectorAll('.fm-ch-modal-backdrop')].at(-1)) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const nodes = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const close = () => { document.removeEventListener('keydown', keydown); backdrop.remove(); if (previousFocus?.isConnected) previousFocus.focus(); };
    document.addEventListener('keydown', keydown);
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
    for (const button of buttons || []) {
      const node = el('button', `fm-ch-btn${button.primary ? ' primary' : ''}`, esc(button.label));
      node.addEventListener('click', () => button.onClick(close, body));
      foot.appendChild(node);
    }
    buildBody(body, close);
    document.body.appendChild(backdrop);
    closeBtn.focus();
    return { close, body };
  }

  // --- instance ------------------------------------------------------------------

  function create(container, options = {}){
    if (!container) throw new Error('FirstMateChannels.create needs a container element');
    const api = root.ChannelsAPI;
    if (!api) throw new Error('FirstMateChannels requires window.ChannelsAPI');
    ensureStyles();

    const orgId = cleanText(options.orgId || root.__APP?.userOrgId);
    const currentUser = options.currentUser || {
      id: cleanText(root.__APP?.userId || root.Portal?.currentUser?.id),
      name: cleanText(root.__APP?.userName || root.__APP?.userEmail),
      email: cleanText(root.__APP?.userEmail).toLowerCase()
    };
    // A missing current-user id must never disable self-filters (own typing
    // indicator, unread divider); resolve it lazily once the session loads.
    if (!currentUser.id) {
      const claim = () => {
        const resolved = cleanText(root.__APP?.userId || root.Portal?.currentUser?.id);
        if (resolved) currentUser.id = resolved;
        else setTimeout(claim, 1500);
      };
      claim();
    }
    const mode = ['conversation', 'embedded', 'list'].includes(options.mode) ? options.mode : 'full';
    const features = { ...DEFAULT_FEATURES, ...(options.features || {}) };
    const defaults = { audience: [], tags: [], ...(options.defaults || {}) };
    const collapsedGroupsStorageKey = `fm_channels_collapsed_groups_v1:${orgId || 'default'}`;
    const loadCollapsedGroups = () => {
      try {
        const stored = JSON.parse(root.localStorage?.getItem?.(collapsedGroupsStorageKey) || '[]');
        return new Set(Array.isArray(stored) ? stored.map(cleanText).filter(Boolean) : []);
      } catch (_) {
        return new Set();
      }
    };

    const state = {
      destroyed: false,
      channels: [],
      sidebarSections: [],
      channelsById: new Map(),
      activeChannelId: '',
      activeChannel: null,
      messages: [],
      unreadDividerSeq: 0,
      threadRootId: '',
      thread: null,
      view: 'channel', // 'channel' | 'saved' | 'search'
      editingMessageId: '',
      editingThread: false,
      replyDrafts: new Map(),
      pendingAttachments: [],
      pendingAudioNote: null,
      typing: new Map(), // userId -> { name, expires }
      searchResults: [],
      searchQuery: '',
      activityFilter: 'all',
      activityUnreadOnly: false,
      threadsUnreadOnly: false,
      tabs: [],
      activeTab: 'messages',
      resources: [],
      huddle: null,
      huddleStreams: [],
      huddlePeerId: '',
      huddleSignalCursor: 0,
      huddleSignalTimer: null,
      huddlePeers: new Map(),
      huddleRemoteStreams: new Map(),
      huddleLivekitRoom: null,
      huddleMinimized: false,
      huddleFullscreen: false,
      huddlePanel: '',
      huddleNoiseSuppression: true,
      huddlePoll: null,
      huddleRecording: null,
      collaborationPreferences: { send_mode: 'enter' },
      unsubscribe: null,
      markReadTimer: null,
      revealTarget: '',
      collapsedGroups: loadCollapsedGroups()
    };
    const translationPending = new Map();
    const translationQueue = [];
    let translationActive = 0;

    // --- skeleton ---------------------------------------------------------------

    container.innerHTML = '';
    const shell = el('div', `fm-ch fm-ch--${mode}${options.density === 'compact' ? ' fm-ch--compact' : ''}`);
    const sidebar = el('div', 'fm-ch-sidebar');
    const main = el('div', 'fm-ch-main');
    const header = el('div', 'fm-ch-header');
    const externalHeaderActions = options.headerActionsTarget instanceof HTMLElement
      ? options.headerActionsTarget
      : null;
    const tabsBar = el('div', 'fm-ch-tabs');
    const bodyWrap = el('div', 'fm-ch-body');
    const listWrap = el('div', 'fm-ch-list-wrap');
    const list = el('div', 'fm-ch-list');
    const typingBar = el('div', 'fm-ch-typing');
    const composer = el('div', 'fm-ch-composer');
    const panel = el('div', 'fm-ch-panel');
    panel.style.display = 'none';

    listWrap.append(list, typingBar, composer);
    bodyWrap.append(listWrap, panel);
    main.append(header, tabsBar, bodyWrap);
    if (mode !== 'embedded' && mode !== 'conversation') shell.appendChild(sidebar);
    if (mode !== 'list') shell.appendChild(main);
    container.appendChild(shell);
    list.addEventListener('scroll', debounce(scheduleMarkRead, 180), { passive:true });

    // Slack-style mobile navigation for the full workspace (see the 760px
    // media block in ensureStyles): the rail and the conversation alternate
    // as full-width screens.
    const mobileMedia = typeof root.matchMedia === 'function' ? root.matchMedia('(max-width:760px)') : null;
    const isMobileFull = () => mode === 'full' && mobileMedia?.matches === true;
    function showMobileList(){
      if (!isMobileFull()) return;
      shell.classList.add('fm-ch--mobile-list');
      renderSidebar();
    }
    function showMobileConversation(){
      shell.classList.remove('fm-ch--mobile-list');
    }
    const onMobileMediaChange = () => {
      if (!isMobileFull()) shell.classList.remove('fm-ch--mobile-list');
      renderHeader();
    };
    mobileMedia?.addEventListener?.('change', onMobileMediaChange);
    if (isMobileFull()) shell.classList.add('fm-ch--mobile-list');
    const onDocumentClickCloseHeaderMenu = (event) => {
      if (event.target.closest?.('.fm-ch-header-actions--menu-wrap')) return;
      shell.querySelectorAll('.fm-ch-header-menu.open').forEach((menu) => menu.classList.remove('open'));
    };
    document.addEventListener('click', onDocumentClickCloseHeaderMenu);

    // --- data loading -------------------------------------------------------------

    async function loadChannels(){
      if (mode === 'embedded') return;
      try {
        const [data, sectionsData] = await Promise.all([
          api.channels.list(orgId),
          features.attention ? api.sidebarSections?.list?.(orgId).catch(() => ({ sections:[] })) : Promise.resolve({ sections:[] })
        ]);
        state.channels = data.channels || [];
        state.sidebarSections = sectionsData?.sections || [];
        state.channelsById = new Map(state.channels.map((channel) => [channel.id, channel]));
        renderSidebar();
        if (mode === 'list') return;
        if (mode === 'conversation') {
          if (state.activeChannelId) {
            state.activeChannel = state.channelsById.get(state.activeChannelId) || state.activeChannel;
            renderHeader();
          }
          return;
        }
        if (!state.activeChannelId && state.channels.length) {
          // On mobile the workspace opens on the channel list; auto-selecting
          // a channel would navigate straight into a conversation.
          if (isMobileFull()) { showMobileList(); return; }
          const preferred = state.channels.find((channel) => channel.name === 'general' && channel.type === 'public') || state.channels[0];
          await setChannel(preferred.id);
        } else if (state.activeChannelId) {
          state.activeChannel = state.channelsById.get(state.activeChannelId) || state.activeChannel;
          renderHeader();
        }
      } catch (error) {
        console.warn('[FirstMateChannels] failed to list channels', error);
      }
    }

    async function setChannel(channelId, { reveal } = {}){
      if (state.destroyed) return;
      if (mode === 'list') {
        // The rail never loads messages — the host decides where the
        // conversation opens (the portal pops it over the active app).
        state.view = 'channel';
        state.activeChannelId = channelId;
        renderSidebar();
        if (channelId) options.onOpenChannel?.(channelId, { reveal });
        return;
      }
      state.view = 'channel';
      state.activeChannelId = channelId;
      state.threadRootId = '';
      state.thread = null;
      state.editingMessageId = '';
      state.typing = new Map();
      state.revealTarget = reveal || '';
      state.activeTab = 'messages';
      showMobileConversation();
      renderPanel();
      try {
        const [data, tabsData] = await Promise.all([
          api.messages.list(orgId, channelId, { limit: 60 }),
          features.resources ? api.tabs?.list?.(orgId, channelId).catch(() => ({ tabs:[] })) : Promise.resolve({ tabs:[] })
        ]);
        if (state.destroyed || state.activeChannelId !== channelId) return;
        state.activeChannel = data.channel;
        state.channelsById.set(channelId, data.channel);
        state.messages = data.messages || [];
        state.tabs = tabsData?.tabs || [];
        state.unreadDividerSeq = Number(data.channel?.unread?.last_read_seq ?? 0);
        renderHeader();
        renderTabs();
        renderMessages();
        renderComposer();
        renderSidebar();
        const profileRoute = root.Portal?.navigation?.read?.();
        if (profileRoute?.channelProfile && profileRoute.channelProfileChannel === channelId && mode !== 'list' && profilePanel?.dataset.userId !== profileRoute.channelProfile) showFullProfile({id:profileRoute.channelProfile}, {silent:true});
        scheduleMarkRead();
        if (state.revealTarget) revealMessage(state.revealTarget);
        options.onNavigate?.({ channel: channelId });
      } catch (error) {
        list.innerHTML = `<div class="fm-ch-empty">${esc(error?.message || 'This conversation could not be loaded.')}</div>`;
        header.innerHTML = '';
        if (externalHeaderActions) externalHeaderActions.replaceChildren();
      }
    }

    async function refreshActiveMessages(){
      if (!state.activeChannelId || state.view !== 'channel') return;
      try {
        const data = await api.messages.list(orgId, state.activeChannelId, { limit: 60 });
        if (state.destroyed) return;
        state.activeChannel = data.channel;
        state.messages = data.messages || [];
        renderMessages();
        scheduleMarkRead();
      } catch (error) {}
    }
    const handlePreferencesUpdated = () => refreshActiveMessages();
    root.addEventListener('fm:user-preferences:updated', handlePreferencesUpdated);

    async function loadOlder(){
      if (!state.messages.length) return;
      const oldest = state.messages[0];
      try {
        const data = await api.messages.list(orgId, state.activeChannelId, { before: oldest.seq, limit: 60 });
        if (!data.messages?.length) return;
        const prevHeight = list.scrollHeight;
        state.messages = [...data.messages, ...state.messages];
        renderMessages({ keepScroll: true, prevHeight });
      } catch (error) {}
    }

    // --- realtime ------------------------------------------------------------------

    function connectRealtime(){
      if (options.realtime === false || !root.PlatformRealtime) return;
      state.unsubscribe = root.PlatformRealtime.subscribe(orgId, 'channels.', (event) => {
        if (state.destroyed) return;
        const payload = event.payload || {};
        const topic = event.topic || '';
        if (topic === 'channels.typing') return mode === 'list' ? undefined : handleTypingEvent(payload);
        if (mode === 'list') {
          // The rail only cares about names and unread badges.
          debouncedLoadChannels();
          return;
        }
        if (topic === 'channels.channel.updated' || topic === 'channels.unreads.changed' || topic === 'channels.read.updated') {
          debouncedLoadChannels();
          return;
        }
        if (topic.startsWith('channels.huddle.') && state.huddle?.id === payload.huddle_id) {
          const expectedHuddleId = state.huddle.id;
          api.huddles.get(orgId, expectedHuddleId).then((data) => {
            // Leaving can finish while this request is in flight. Never allow
            // a stale realtime refresh to resurrect the locally closed card.
            if (state.huddle?.id !== expectedHuddleId) return;
            state.huddle = data.huddle;
            if (state.huddle?.state === 'ended' || state.huddle?.participants?.some(item => item.user_id === currentUser.id && item.role === 'removed')) stopHuddleSession();
            else renderHuddle();
          }).catch(() => {});
          return;
        }
        if (!payload.channel_id) return;
        if (payload.channel_id !== state.activeChannelId) {
          debouncedLoadChannels();
          return;
        }
        if (payload.stub) {
          refreshActiveMessages();
          if (state.threadRootId) openThread(state.threadRootId, { silent: true });
          return;
        }
        const message = payload.message;
        if (!message) return;
        applyIncomingMessage(topic, message, payload);
        // Rehydrate viewer-specific saved/translation state. The realtime
        // envelope is shared by channel members and is intentionally not the
        // source of truth for personal preferences.
        if (message.translation) refreshActiveMessages();
      }, { onResync: () => { loadChannels(); refreshActiveMessages(); } });
    }

    function applyIncomingMessage(topic, message, payload){
      const inThread = Boolean(message.parent_id);
      if (topic === 'channels.message.created' && !inThread) {
        const existing = state.messages.findIndex((item) => item.id === message.id);
        if (existing >= 0) state.messages[existing] = message;
        else state.messages.push(message);
        renderMessages();
        scheduleMarkRead();
      } else if (!inThread) {
        const index = state.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) {
          state.messages[index] = message;
          renderMessages();
        }
      }
      if (state.threadRootId && (message.parent_id === state.threadRootId || message.id === state.threadRootId)) {
        openThread(state.threadRootId, { silent: true });
      }
      if (inThread && !state.threadRootId) {
        const rootIndex = state.messages.findIndex((item) => item.id === message.parent_id);
        if (rootIndex >= 0) refreshActiveMessages();
      }
    }

    function handleTypingEvent(payload){
      if (payload.channel_id !== state.activeChannelId || payload.user_id === currentUser.id) return;
      state.typing.set(payload.user_id, { name: payload.user_name || 'Someone', expires: Date.now() + (payload.expires_in_ms || 6000) });
      renderTyping();
      setTimeout(renderTyping, (payload.expires_in_ms || 6000) + 200);
    }

    const debouncedLoadChannels = debounce(loadChannels, 800);

    // --- mark read -------------------------------------------------------------------

    function scheduleMarkRead(){
      clearTimeout(state.markReadTimer);
      state.markReadTimer = setTimeout(async () => {
        if (state.destroyed || !state.activeChannelId || document.hidden || !document.hasFocus?.()) return;
        const listRect = list.getBoundingClientRect();
        let maxSeq = 0;
        list.querySelectorAll('[data-message-id]').forEach((row) => {
          const rect = row.getBoundingClientRect();
          const visiblePixels = Math.min(rect.bottom, listRect.bottom) - Math.max(rect.top, listRect.top);
          if (visiblePixels < Math.min(24, Math.max(1, rect.height * .5))) return;
          const message = state.messages.find((item) => item.id === row.dataset.messageId);
          maxSeq = Math.max(maxSeq, Number(message?.seq) || 0);
        });
        const lastRead = Number(state.activeChannel?.unread?.last_read_seq ?? 0);
        if (maxSeq > lastRead) {
          try {
            await api.readState.markRead(orgId, state.activeChannelId, maxSeq);
            if (state.activeChannel?.unread) state.activeChannel.unread = { ...state.activeChannel.unread, last_read_seq: maxSeq, unread_count: 0, mention_count: 0 };
            renderSidebar();
          } catch (error) {}
        }
      }, 800);
    }

    // --- sidebar ---------------------------------------------------------------------

    function channelIcon(channel){
      if (channel.type === 'private') return '<i class="fas fa-lock"></i>';
      if (channel.type === 'project') return '<i class="fas fa-diagram-project"></i>';
      if (channel.type === 'dm' || channel.type === 'group_dm') return '';
      return '<i class="fas fa-hashtag"></i>';
    }

    function sideItem(channel){
      const unread = channel.unread || {};
      const item = el('button', `fm-ch-side-item${channel.id === state.activeChannelId && state.view === 'channel' ? ' active' : ''}${unread.unread_count ? ' unread' : ''}`);
      const isDm = channel.type === 'dm' || channel.type === 'group_dm';
      const label = channel.display_name || channel.name || 'untitled';
      item.innerHTML = `${isDm
        ? avatarHtml((channel.members || []).find((member) => member.id !== currentUser.id) || { name: label }, 'sm')
        : `<span class="fm-ch-hash">${channelIcon(channel)}</span>`}
        <span class="fm-ch-side-label">${esc(label)}</span>
        ${unread.mention_count ? `<span class="fm-ch-badge">${unread.mention_count}</span>` : ''}`;
      item.addEventListener('click', () => setChannel(channel.id));
      return item;
    }

    function renderSidebar(){
      if (mode === 'embedded') return;
      sidebar.innerHTML = '';
      const assigned = new Set(state.sidebarSections.flatMap((section) => section.channel_ids || []));
      const starredSection = state.sidebarSections.find((section) => section.id === 'starred');
      const customSections = state.sidebarSections.filter((section) => section.id !== 'starred');
      const groups = [
        ...(starredSection ? [{
          key:'custom:starred',
          title:(globalThis.PlatformLanguage?.text("channels-ui","m_239e04fad247dd","Starred") ?? "Starred"),
          icon:'fa-star',
          filter:(channel) => (starredSection.channel_ids || []).includes(channel.id),
          add:null
        }] : []),
        ...customSections.map((section) => ({
          key:`custom:${section.id}`,
          title:section.label,
          filter:(channel) => (section.channel_ids || []).includes(channel.id),
          add:null
        })),
        { key: 'channels', title: (globalThis.PlatformLanguage?.text("channels-ui","m_dc8b4f6c066b30","Channels") ?? "Channels"), filter: (channel) => !assigned.has(channel.id) && (channel.type === 'public' || channel.type === 'private'), add: features.channelCreate ? () => openCreateChannelModal() : null },
        ...(features.dms ? [{ key: 'dms', title: (globalThis.PlatformLanguage?.text("channels-ui","m_f304f7d46421ed","Direct messages") ?? "Direct messages"), filter: (channel) => !assigned.has(channel.id) && (channel.type === 'dm' || channel.type === 'group_dm'), add: () => openNewDmModal() }] : []),
        { key: 'projects', title: (globalThis.PlatformLanguage?.text("channels-ui","m_c53bfe8bfab030","Project messages") ?? "Project messages"), filter: (channel) => !assigned.has(channel.id) && channel.type === 'project', add: null }
      ];

      const quick = el('div', 'fm-ch-quick');
      const quickItems = [
        ...(features.attention ? [
          ['unreads', 'All Unreads', 'fa-inbox', openUnreadsView],
          ['activity', 'Activity', 'fa-bell', openActivityView],
          ['threads', 'Threads', 'fa-comments', openThreadsView]
        ] : []),
        ...(features.saved ? [['saved', 'Later', 'fa-bookmark', openSavedView]] : [])
      ];
      for (const [view, label, icon, handler] of quickItems) {
        const item = el('button', `fm-ch-side-item${state.view === view ? ' active' : ''}`, `<span class="fm-ch-hash"><i class="fas ${icon}"></i></span><span class="fm-ch-side-label">${label}</span>`);
        item.addEventListener('click', mode === 'list' && typeof options.onOpenView === 'function'
          ? () => options.onOpenView(view)
          : handler);
        quick.appendChild(item);
      }
      if (mode === 'full' && features.attention) {
        const sections = el('button', 'fm-ch-side-item', `<span class="fm-ch-hash"><i class="fas fa-layer-group"></i></span><span class="fm-ch-side-label">${(globalThis.PlatformLanguage?.text("channels-ui","m_49091612e47337","Edit sections") ?? "Edit sections")}</span>`);
        sections.addEventListener('click', openSidebarSectionsModal);
        quick.appendChild(sections);
      }
      sidebar.appendChild(quick);

      for (const group of groups) {
        const channels = state.channels.filter(group.filter);
        if (!channels.length && !group.add) continue;
        const collapsed = state.collapsedGroups.has(group.key);
        const unreadCount = channels.reduce((sum, channel) => sum + Number(channel.unread?.unread_count || 0), 0);
        const section = el('div', `fm-ch-side-section${collapsed ? ' collapsed' : ''}`);
        const head = el('div', 'fm-ch-side-head');
        const title = el('span', 'fm-ch-side-title', `${group.icon ? `<i class="fas ${group.icon}" aria-hidden="true"></i> ` : ''}${esc(group.title)}`);
        const toggle = el('button', 'fm-ch-side-toggle', '<i class="fas fa-chevron-down" aria-hidden="true"></i>');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${group.title}`);
        const toggleGroup = () => {
          if (state.collapsedGroups.has(group.key)) state.collapsedGroups.delete(group.key);
          else state.collapsedGroups.add(group.key);
          try {
            root.localStorage?.setItem?.(collapsedGroupsStorageKey, JSON.stringify([...state.collapsedGroups]));
          } catch (_) {}
          renderSidebar();
        };
        head.addEventListener('click', toggleGroup);
        head.appendChild(title);
        if (unreadCount) head.appendChild(el('span', 'fm-ch-group-badge', unreadCount));
        if (group.add) {
          const addBtn = el('button', 'fm-ch-side-add', '+');
          addBtn.title = group.key === 'dms' ? 'New direct message' : 'Create a channel';
          addBtn.setAttribute('aria-label', addBtn.title);
          addBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            group.add();
          });
          head.appendChild(addBtn);
        }
        head.appendChild(toggle);
        section.appendChild(head);
        const items = el('div', 'fm-ch-side-items');
        items.hidden = collapsed;
        for (const channel of channels) items.appendChild(sideItem(channel));
        section.appendChild(items);
        sidebar.appendChild(section);
      }
    }

    // --- header ------------------------------------------------------------------------

    function renderHeader(){
      header.innerHTML = '';
      if (externalHeaderActions) externalHeaderActions.replaceChildren();
      // Embedded surfaces (project notes and the like) supply their own
      // heading — repeating the channel/project name here is duplication.
      if (mode === 'embedded') {
        header.style.display = 'none';
        return;
      }
      header.style.display = options.compactHeader && externalHeaderActions ? 'none' : '';
      if (isMobileFull()) {
        const back = el('button', 'fm-ch-mobile-back', '<i class="fas fa-chevron-left"></i>');
        back.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_ee38d534903602","Back to channels") ?? "Back to channels"));
        back.addEventListener('click', showMobileList);
        header.appendChild(back);
      }
      const channel = state.activeChannel;
      if (state.view === 'saved') {
        header.append(el('div', 'fm-ch-header-title', '<i class="fas fa-bookmark"></i> Later'));
        return;
      }
      if (state.view === 'unreads') {
        header.append(el('div', 'fm-ch-header-title', '<i class="fas fa-inbox"></i> All Unreads'));
        const actions = el('div', 'fm-ch-header-actions');
        const markAll = el('button', 'fm-ch-btn', 'Mark all read');
        markAll.addEventListener('click', markAllReadWithUndo);
        actions.appendChild(markAll);
        (externalHeaderActions || header).appendChild(actions);
        return;
      }
      if (state.view === 'activity') {
        header.append(el('div', 'fm-ch-header-title', '<i class="fas fa-bell"></i> Activity'));
        const actions = el('div', 'fm-ch-header-actions');
        const markAll = el('button', 'fm-ch-btn', 'Mark all read');
        markAll.addEventListener('click', async () => {
          await api.activity.readAll?.(orgId);
          await openActivityView();
        });
        actions.appendChild(markAll);
        (externalHeaderActions || header).appendChild(actions);
        return;
      }
      if (state.view === 'threads') {
        header.append(el('div', 'fm-ch-header-title', '<i class="fas fa-comments"></i> Threads'));
        return;
      }
      if (state.view === 'search') {
        header.append(el('div', 'fm-ch-header-title', `Search: “${esc(state.searchQuery)}”`));
        return;
      }
      if (!channel) return;
      const icon = channelIcon(channel);
      if (!options.compactHeader) {
        header.appendChild(el('div', 'fm-ch-header-title', `${icon ? `${icon} ` : ''}${esc(channel.display_name || channel.name)}`));
        if (channel.topic) header.appendChild(el('div', 'fm-ch-header-topic', esc(channel.topic)));
        else header.appendChild(el('div', 'fm-ch-header-topic', ''));
      }

      const actions = el('div', 'fm-ch-header-actions');
      const addAction = (title, icon2, onClick) => {
        const button = el('button', 'fm-ch-icon-btn', icon2);
        button.title = title;
        button.addEventListener('click', onClick);
        actions.appendChild(button);
        return button;
      };
      if (mode === 'full' && !['dm', 'group_dm'].includes(channel.type) && channel.type !== 'project') {
        addAction(`${channel.member_count || 0} members`, '<i class="fas fa-user-group"></i>', () => openMembersModal());
      }
      if (features.attention) addAction('Conversation notifications', '<i class="fas fa-bell"></i>', openChannelNotificationModal);
      if (features.search && mode === 'full') addAction('Search messages', '<i class="fas fa-magnifying-glass"></i>', () => openSearchPrompt());
      if (features.workflows) addAction('Workflow shortcuts', '<i class="fas fa-bolt"></i>', openWorkflowShortcuts);
      if (features.ai) addAction('Ask FirstMate for a recap', '<i class="fas fa-wand-magic-sparkles"></i>', requestChannelRecap);
      if (features.ai && channel.type === 'dm' && channel.members?.some(member => String(member.id).startsWith('agent_'))) {
        addAction('New assistant conversation', '<i class="fas fa-comment-medical"></i>', () => {
          showModal('New assistant conversation', body => {
            body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_352a847350c8e8","Conversation name") ?? "Conversation name")}</label><input data-name maxlength="80" placeholder="${(globalThis.PlatformLanguage?.text("channels-ui","m_687b63fdcdf9a9","What are you working on?") ?? "What are you working on?")}">`;
          }, [{label:(globalThis.PlatformLanguage?.text("channels-ui","m_91c3716587c959","Create conversation") ?? "Create conversation"), primary:true, onClick:async (close, body) => {
            try {
              const data = await api.channels.create(orgId, {type:'dm', new_conversation:true, name:body.querySelector('[data-name]').value.trim() || 'New assistant conversation', member_user_ids:channel.members.filter(member => String(member.id).startsWith('agent_')).map(member => member.id)});
              close(); await loadChannels(); await setChannel(data.channel.id);
            } catch (error) { showError(error); }
          }}]);
        });
      }
      if (api.sidebarSections?.save) {
        const starred = state.sidebarSections.find((section) => section.id === 'starred')?.channel_ids?.includes(channel.id);
        const starButton = addAction(starred ? 'Remove from Starred' : 'Add to Starred', `<i class="${starred ? 'fas' : 'far'} fa-star"></i>`, () => toggleStarredChannel(channel.id));
        starButton.classList.toggle('on', starred);
        starButton.setAttribute('aria-pressed', starred ? 'true' : 'false');
      }
      if (features.pins) addAction('Pinned messages', '<i class="fas fa-thumbtack"></i>', () => openPinsPanel());
      if (mode === 'full' && ['public', 'private'].includes(channel.type)) {
        if (!channel.is_member) {
          addAction('Join channel', '<i class="fas fa-user-plus"></i>', async () => {
            try { await api.channels.addMembers(orgId, channel.id, [currentUser.id]); await setChannel(channel.id); } catch (error) { showError(error); }
          });
        } else if (channel.name !== 'general') {
          addAction('Leave channel', '<i class="fas fa-arrow-right-from-bracket"></i>', async () => {
            try {
              await api.channels.removeMember(orgId, channel.id, currentUser.id);
              state.activeChannelId = '';
              await loadChannels();
            } catch (error) { showError(error); }
          });
        }
      }
      if (features.channelSettings && channel.can_manage && !['dm', 'group_dm', 'project'].includes(channel.type)) {
        addAction('Channel settings', '<i class="fas fa-gear"></i>', () => openChannelSettingsModal());
      }
      if (mode === 'full' && typeof options.onSettings === 'function') addAction('Channels settings', '<i class="fas fa-sliders"></i>', () => options.onSettings());
      if (features.huddles) addAction('Start or join huddle', '<i class="fas fa-headphones"></i>', () => openHuddleStartModal());
      // On phones a row of icon actions crowds the title out of the header;
      // collapse them into a single kebab menu with labeled entries.
      if (isMobileFull() && actions.children.length > 1) {
        const wrap = el('div', 'fm-ch-header-actions fm-ch-header-actions--menu-wrap');
        const kebab = el('button', 'fm-ch-icon-btn', '<i class="fas fa-ellipsis-vertical"></i>');
        kebab.title = (globalThis.PlatformLanguage?.text("channels-ui","m_6131de4ee6c3cf","Conversation actions") ?? "Conversation actions");
        const menu = el('div', 'fm-ch-header-menu');
        [...actions.children].forEach((source) => {
          const item = el('button', 'fm-ch-header-menu-item',
            `${source.querySelector('i')?.outerHTML || ''}<span>${esc(source.title || (globalThis.PlatformLanguage?.text("channels-ui","m_1561bf1f3d2922","Action") ?? "Action"))}</span>`);
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            menu.classList.remove('open');
            source.click();
          });
          menu.appendChild(item);
        });
        kebab.addEventListener('click', (event) => {
          event.stopPropagation();
          menu.classList.toggle('open');
        });
        actions.style.display = 'none';
        wrap.append(kebab, menu, actions);
        header.appendChild(wrap);
        return;
      }
      (externalHeaderActions || header).appendChild(actions);
    }

    async function toggleStarredChannel(channelId){
      const existing = state.sidebarSections.find((section) => section.id === 'starred');
      const channelIds = new Set(existing?.channel_ids || []);
      const removing = channelIds.has(channelId);
      if (removing) channelIds.delete(channelId);
      else channelIds.add(channelId);
      const nextSection = {
        id:'starred',
        label:(globalThis.PlatformLanguage?.text("channels-ui","m_239e04fad247dd","Starred") ?? "Starred"),
        position:0,
        collapsed:false,
        channel_ids:[...channelIds]
      };
      try {
        const result = await api.sidebarSections.save(orgId, 'starred', nextSection);
        const saved = result?.section || nextSection;
        state.sidebarSections = [
          saved,
          ...state.sidebarSections.filter((section) => section.id !== 'starred')
        ];
        renderHeader();
        renderSidebar();
        root.dispatchEvent(new CustomEvent('fm:channels-sidebar-sections-updated', {
          detail:{ source:container }
        }));
        root.Portal?.ui?.showToast?.(
          removing ? 'Removed from Starred' : 'Added to Starred',
          removing ? 'The conversation is back in its regular section.' : 'The conversation now appears at the top of Channels.',
          true
        );
      } catch (error) {
        showError(error);
      }
    }

    async function requestChannelRecap(){
      try {
        const agents = await (root.FirstMateTags?.listAgentParticipants?.(orgId) || Promise.resolve([]));
        const agent = agents?.[0];
        if (!agent?.id) throw new Error('Turn on the FirstMate Assistant in AI Agents to use channel recaps.');
        await api.messages.post(orgId, state.activeChannelId, {
          text:'Please summarize the recent conversation, decisions, open questions, and action items. Reference relevant project resources when useful.',
          mention_users:[{ id:agent.id, name:agent.name }],
          client_msg_id:`recap_${Date.now().toString(36)}`
        });
        root.Portal?.ui?.showToast?.(
          (globalThis.PlatformLanguage?.text("channels-ui","m_37203cd3f91687","FirstMate recap requested") ?? "FirstMate recap requested"),
          (globalThis.PlatformLanguage?.text("channels-ui","m_6522a8013848af","The recap will appear in this conversation when it is ready.") ?? "The recap will appear in this conversation when it is ready."),
          true
        );
      } catch (error) { showError(error); }
    }

    function openChannelNotificationModal(){
      const current = state.activeChannel?.members?.find((member) => member.id === currentUser.id)?.notify_level
        || state.collaborationPreferences.default_notify_level
        || 'mentions';
      showModal('Conversation notifications', (body) => {
        body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_06b46f515eff14","Notify me about") ?? "Notify me about")}</label><select data-notify-level><option value="all">${(globalThis.PlatformLanguage?.text("channels-ui","m_6275935eadd8a4","All new messages") ?? "All new messages")}</option><option value="mentions">${(globalThis.PlatformLanguage?.text("channels-ui","m_722ecd47834278","Mentions and replies") ?? "Mentions and replies")}</option><option value="muted">${(globalThis.PlatformLanguage?.text("channels-ui","m_3c7c4f2cd743b8","Nothing") ?? "Nothing")}</option></select>`;
        body.querySelector('[data-notify-level]').value = current;
      }, [{ label:(globalThis.PlatformLanguage?.text("channels-ui","m_5bab3e72de1ebf","Save") ?? "Save"), primary:true, onClick:async (close, body) => {
        try {
          const level = body.querySelector('[data-notify-level]')?.value || 'mentions';
          await api.channels.setNotifyLevel(orgId, state.activeChannelId, currentUser.id, level);
          const member = state.activeChannel?.members?.find((item) => item.id === currentUser.id);
          if (member) member.notify_level = level;
          close();
        } catch (error) { showError(error); }
      } }]);
    }

    function openWorkflowShortcuts(){
      showModal('Workflow shortcuts', (body, close) => {
        const latest = [...state.messages].reverse().find((message) => !message.deleted_at && message.kind !== 'system');
        const shortcuts = el('div', 'fm-ch-workflow-list');
        const todo = el('button', 'fm-ch-resource', `<span class="fm-ch-resource-icon"><i class="fas fa-square-check"></i></span><span class="fm-ch-resource-copy"><strong>${(globalThis.PlatformLanguage?.text("channels-ui","m_cf158e3d6b6368","Create To Do from latest message") ?? "Create To Do from latest message")}</strong><span>${(globalThis.PlatformLanguage?.text("channels-ui","m_95f15902640767","Keep the channel and project context attached.") ?? "Keep the channel and project context attached.")}</span></span>`);
        todo.disabled = !latest;
        todo.addEventListener('click', () => {
          close();
          if (latest) openCreateTodoModal(latest);
        });
        const recap = el('button', 'fm-ch-resource', `<span class="fm-ch-resource-icon"><i class="fas fa-wand-magic-sparkles"></i></span><span class="fm-ch-resource-copy"><strong>${(globalThis.PlatformLanguage?.text("channels-ui","m_7c97c63718af8a","Generate a channel recap") ?? "Generate a channel recap")}</strong><span>${(globalThis.PlatformLanguage?.text("channels-ui","m_1d0527c667a73b","Ask FirstMate for decisions and action items.") ?? "Ask FirstMate for decisions and action items.")}</span></span>`);
        recap.addEventListener('click', () => {
          close();
          requestChannelRecap();
        });
        shortcuts.append(todo, recap);
        body.appendChild(shortcuts);
      });
    }

    function renderTabs(){
      tabsBar.innerHTML = '';
      if (!features.resources || mode === 'embedded' || state.view !== 'channel' || !state.activeChannel) {
        tabsBar.hidden = true;
        return;
      }
      tabsBar.hidden = false;
      const tabs = state.tabs.length ? state.tabs : [
        { id:'messages', kind:'messages', label:(globalThis.PlatformLanguage?.text("channels-ui","m_820b9cb136d6ed","Messages") ?? "Messages") },
        { id:'files', kind:'files', label:(globalThis.PlatformLanguage?.text("channels-ui","m_357a58f2b3675d","Files") ?? "Files") },
        { id:'documents', kind:'documents', label:(globalThis.PlatformLanguage?.text("channels-ui","m_5d7c7ad6033624","Documents") ?? "Documents") },
        { id:'todos', kind:'todos', label:(globalThis.PlatformLanguage?.text("channels-ui","m_4bec39f8fa90dd","To Dos") ?? "To Dos") },
        { id:'pins', kind:'pins', label:(globalThis.PlatformLanguage?.text("channels-ui","m_576cd53c8d929f","Pins") ?? "Pins") }
      ];
      for (const tab of tabs) {
        const kind = cleanText(tab.kind || tab.id);
        const button = el('button', `fm-ch-tab${state.activeTab === kind ? ' active' : ''}`, esc(tab.label || kind));
        button.type = 'button';
        button.addEventListener('click', () => openChannelTab(kind));
        tabsBar.appendChild(button);
      }
    }

    async function openChannelTab(kind){
      state.activeTab = cleanText(kind) || 'messages';
      renderTabs();
      if (state.activeTab === 'messages') {
        renderMessages();
        renderComposer();
        return;
      }
      composer.innerHTML = '';
      typingBar.textContent = '';
      if (state.activeTab === 'pins') {
        const data = await api.pins.list(orgId, state.activeChannelId).catch((error) => ({ error }));
        if (data.error) return showError(data.error);
        renderResourceLikeMessages(data.messages || []);
        return;
      }
      list.innerHTML = `<div class="fm-ch-empty"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("channels-ui","m_c5b83d77acbf15"," Loading resources...") ?? " Loading resources...")}</div>`;
      try {
        const type = state.activeTab === 'files' ? 'files'
          : state.activeTab === 'documents' ? 'documents'
            : state.activeTab === 'todos' ? 'todos'
              : state.activeTab === 'media' ? 'media'
                : state.activeTab;
        const data = await api.resources.list(orgId, state.activeChannelId, { type });
        state.resources = data.resources || [];
        renderResources(state.resources, state.activeTab);
      } catch (error) {
        showError(error);
      }
    }

    function renderResourceLikeMessages(messages){
      list.innerHTML = '';
      if (!messages.length) {
        list.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_8c9f8b0c815337","Nothing here yet.") ?? "Nothing here yet.")}</div>`;
        return;
      }
      for (const message of messages) list.appendChild(messageRow(message));
    }

    function resourceIcon(type){
      if (type === 'media') return 'fa-photo-film';
      if (type === 'document') return 'fa-file-lines';
      if (type === 'action_item') return 'fa-square-check';
      if (type === 'link') return 'fa-link';
      return 'fa-paperclip';
    }

    function renderResources(resources, tabKind){
      list.innerHTML = '';
      if (!resources.length) {
        list.innerHTML = `<div class="fm-ch-empty">${((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_1d86dd5d32c030",`No ${v0} have been shared here yet.`,{v0}) ?? `No ${v0} have been shared here yet.`)(esc(tabKind))}</div>`;
        return;
      }
      const grid = el('div', 'fm-ch-resource-grid');
      for (const entry of resources) {
        const resource = entry.resource || {};
        const type = cleanText(entry.resource_type);
        const title = cleanText(resource.label || resource.title || resource.file_name || resource.name || entry.display_note)
          || (type === 'action_item' ? 'To Do' : type === 'document' ? 'Document' : 'Media');
        const subtitle = cleanText(resource.status || resource.content_type || resource.updated_at || entry.source);
        const card = el('div', 'fm-ch-resource');
        card.innerHTML = `<span class="fm-ch-resource-icon"><i class="fas ${resourceIcon(type)}"></i></span><span class="fm-ch-resource-copy"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></span>`;
        if (type === 'media' && entry.resource_id) {
          card.style.cursor = 'pointer';
          card.addEventListener('click', () => root.open(api.mediaFileUrl(orgId, entry.resource_id), '_blank', 'noopener'));
        }
        grid.appendChild(card);
      }
      list.appendChild(grid);
    }

    function channelHuddleDefaults(channel = state.activeChannel){
      const settings = channel?.settings && typeof channel.settings === 'object' ? channel.settings : {};
      return {
        recordingEnabled:settings.huddle_recording_enabled !== false,
        recordVideo:settings.huddle_record_video !== false
      };
    }

    function openHuddleStartModal(){
      if (state.huddle) {
        renderHuddle();
        return;
      }
      const defaults = channelHuddleDefaults();
      showModal('Start or join huddle', (body) => {
        body.innerHTML = `
          <p style="margin:0;color:#667085;font-size:11.5px;line-height:1.5">${(globalThis.PlatformLanguage?.text("channels-ui","m_7a57f0bd2cce89","Huddles begin audio-only. Anyone can turn on a camera or share a screen after joining.") ?? "Huddles begin audio-only. Anyone can turn on a camera or share a screen after joining.")}</p>
          ${String(features.recording ? `<div class="fm-ch-setting-group">
            <strong>Recording for this huddle</strong>
            <p>These choices apply if this starts a new huddle. An existing huddle keeps the recording policy it started with.</p>
            <label class="fm-ch-check-row">
              <span><strong>Record this huddle</strong><small>Everyone sees a recording indicator while retention is active.</small></span>
              <input type="checkbox" data-huddle-record ${defaults.recordingEnabled && features.recording ? 'checked' : ''} ${features.recording ? '' : 'disabled'}>
            </label>
            <label class="fm-ch-check-row">
              <span><strong>Include video and shared screens</strong><small>When off, the retained recording contains mixed audio only.</small></span>
              <input type="checkbox" data-huddle-record-video ${defaults.recordVideo && features.recordVideo ? 'checked' : ''}>
            </label>
          </div>` : '')}`;
        const record = body.querySelector('[data-huddle-record]');
        const video = body.querySelector('[data-huddle-record-video]');
        if (!record || !video) return;
        const sync = () => {
          video.disabled = !features.recordVideo || !record.checked;
          if (!record.checked) video.checked = false;
        };
        record.addEventListener('change', sync);
        sync();
      }, [
        { label:(globalThis.PlatformLanguage?.text("channels-ui","m_cbef679b21abb4","Cancel") ?? "Cancel"), onClick:(close) => close() },
        { label:(globalThis.PlatformLanguage?.text("channels-ui","m_dbfccd94e07ada","Start or join") ?? "Start or join"), primary:true, onClick:async (close, body) => {
          const recordingEnabled = Boolean(body.querySelector('[data-huddle-record]')?.checked) && features.recording;
          const recordVideo = recordingEnabled && Boolean(body.querySelector('[data-huddle-record-video]')?.checked) && features.recordVideo;
          close();
          await startHuddle({ recordingEnabled, recordVideo });
        } }
      ]);
    }

    async function startHuddle(recordingOptions = {}){
      if (!state.activeChannelId || !navigator.mediaDevices?.getUserMedia || !root.RTCPeerConnection) {
        return showError(new Error('Huddles are not supported in this browser.'));
      }
      const defaults = channelHuddleDefaults();
      const recordingEnabled = recordingOptions.recordingEnabled ?? (features.recording && defaults.recordingEnabled);
      const recordVideo = recordingOptions.recordVideo ?? (recordingEnabled && features.recordVideo && defaults.recordVideo);
      let stream = null;
      try {
        // Acquire permission before creating server state so a denied or
        // unavailable microphone cannot leave an empty active huddle behind.
        stream = await navigator.mediaDevices.getUserMedia({ audio:{echoCancellation:true, noiseSuppression:state.huddleNoiseSuppression, autoGainControl:true}, video:false });
        const data = await api.huddles.create(orgId, state.activeChannelId, {
          audio:true,
          video:true,
          recording_enabled:Boolean(recordingEnabled),
          record_video:Boolean(recordVideo)
        });
        state.huddle = (await api.huddles.join(orgId, data.huddle.id)).huddle;
        state.huddleStreams.push(stream);
        if (state.huddle.signaling?.mode === 'livekit') {
          await connectLiveKitHuddle(state.huddle.signaling, stream);
        } else {
          state.huddlePeerId = `${currentUser.id || 'guest'}_${root.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
          state.huddleSignalCursor = 0;
        }
        startHuddleRecording();
        renderHuddle();
        const joinedId = state.huddle.id;
        state.huddlePoll = setInterval(async () => {
          try {
            const data = await api.huddles.get(orgId, joinedId);
            if (state.huddle?.id !== joinedId) return;
            const removed = data.huddle?.participants?.some(item => item.user_id === currentUser.id && item.role === 'removed');
            if (data.huddle?.state === 'ended' || removed) {
              stopHuddleSession();
              if (removed) showError(new Error('The host removed you from this call.'));
            } else {
              const changed = JSON.stringify(state.huddle.participants) !== JSON.stringify(data.huddle.participants);
              state.huddle = {...data.huddle, signaling:state.huddle.signaling};
              if (changed) renderHuddle();
              else {
                const elapsed = Math.floor((Date.now() - new Date(state.huddle.started_at).getTime()) / 1000);
                const status = (state.huddleWindowRoot || main).querySelector('.fm-ch-huddle-status span');
                if (status) status.textContent = `${state.huddleLivekitRoom?.state || ([...state.huddlePeers.values()].some(peer => peer.connectionState === 'connected') ? 'Connected' : 'Waiting for connection')} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
              }
            }
          } catch (_) {}
        }, 5000);
        if (state.huddle.signaling?.mode !== 'livekit') {
          await sendHuddleSignal('hello', {});
          pollHuddleSignals();
        }
      } catch (error) {
        stream?.getTracks?.().forEach((track) => track.stop());
        if (state.huddle?.id) { api.huddles.leave(orgId, state.huddle.id).catch(() => {}); stopHuddleSession(); }
        showError(error);
      }
    }

    async function connectLiveKitHuddle(connection, stream){
      const LK = root.LivekitClient;
      if (!LK?.Room || !connection?.url || !connection?.token) {
        throw new Error('The production call client is unavailable.');
      }
      const room = new LK.Room({
        adaptiveStream:true,
        dynacast:true,
        disconnectOnPageLeave:true
      });
      const rememberTrack = (track, publication, participant) => {
        const mediaTrack = track?.mediaStreamTrack;
        if (!mediaTrack) return;
        mediaTrack._callSource = [LK.Track.Source.ScreenShare, LK.Track.Source.ScreenShareAudio].includes(publication?.source || track.source) ? 'screen' : track.kind === 'video' ? 'camera' : 'microphone';
        mediaTrack._callMuted = Boolean(track.isMuted);
        const peerId = cleanText(participant?.identity || participant?.sid || mediaTrack.id);
        const existing = state.huddleRemoteStreams.get(peerId) || new root.MediaStream();
        if (!existing.getTracks().some((item) => item.id === mediaTrack.id)) existing.addTrack(mediaTrack);
        state.huddleRemoteStreams.set(peerId, existing);
        addHuddleRecordingStream(existing);
        renderHuddle();
      };
      room.on(LK.RoomEvent.TrackSubscribed, rememberTrack);
      room.on(LK.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        const stream = state.huddleRemoteStreams.get(cleanText(participant?.identity || participant?.sid));
        if (stream && track?.mediaStreamTrack) stream.removeTrack(track.mediaStreamTrack);
        renderHuddle();
      });
      const updateTrackMute = publication => {
        if (publication?.track?.mediaStreamTrack) publication.track.mediaStreamTrack._callMuted = Boolean(publication.isMuted);
        renderHuddle();
      };
      room.on(LK.RoomEvent.TrackMuted, updateTrackMute);
      room.on(LK.RoomEvent.TrackUnmuted, updateTrackMute);
      room.on(LK.RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (topic !== 'firstmate.reaction') return;
        try { showHuddleReaction(JSON.parse(new TextDecoder().decode(bytes)).emoji, participant?.name || 'Participant'); } catch (_) {}
      });
      room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
        state.huddleRemoteStreams.delete(cleanText(participant?.identity || participant?.sid));
        renderHuddle();
      });
      room.on(LK.RoomEvent.Disconnected, () => {
        if (state.huddle && state.huddleLivekitRoom === room) stopHuddleSession();
      });
      await room.connect(connection.url, connection.token);
      state.huddleLivekitRoom = room;
      const audioTrack = stream?.getAudioTracks?.()[0];
      if (audioTrack) {
        await room.localParticipant.publishTrack(audioTrack, { source:LK.Track.Source.Microphone });
      } else {
        await room.localParticipant.setMicrophoneEnabled(true);
      }
    }

    function syncHuddleMediaState(patch){
      const huddleId = state.huddle?.id;
      if (!huddleId || !api.huddles.mediaState) return;
      const participant = state.huddle.participants?.find(person => person.user_id === currentUser.id);
      if (participant) Object.assign(participant, patch);
      renderHuddle();
      api.huddles.mediaState(orgId, huddleId, patch).then((data) => {
        if (state.huddle?.id !== huddleId) return;
        state.huddle = data.huddle || state.huddle;
        renderHuddle();
      }).catch(showError);
    }

    async function sendHuddleSignal(kind, payload, targetPeerId){
      if (!state.huddle?.id || !state.huddlePeerId) return;
      await api.huddles.signal(orgId, state.huddle.id, {
        sender_peer_id:state.huddlePeerId,
        ...(targetPeerId ? { target_peer_id:targetPeerId } : {}),
        kind,
        payload
      });
    }

    function closeHuddlePeer(peerId){
      state.huddlePeers.get(peerId)?.close?.();
      state.huddlePeers.delete(peerId);
      state.huddleRemoteStreams.delete(peerId);
      renderHuddle();
    }

    function ensureHuddlePeer(peerId){
      if (!peerId || peerId === state.huddlePeerId) return null;
      if (state.huddlePeers.has(peerId)) return state.huddlePeers.get(peerId);
      const iceServers = state.huddle?.signaling?.ice_servers || (Array.isArray(root.__APP?.webrtcIceServers) && root.__APP.webrtcIceServers.length
        ? root.__APP.webrtcIceServers
        : [{ urls:'stun:stun.l.google.com:19302' }]);
      const peer = new root.RTCPeerConnection({ iceServers });
      peer._makingOffer = false;
      peer._ignoreOffer = false;
      peer._settingRemoteAnswer = false;
      peer._pendingIce = [];
      peer.addEventListener('negotiationneeded', () => offerToHuddlePeer(peerId).catch(showError));
      // Reserve camera and screen slots at connection setup. replaceTrack then
      // switches media without racing a new SDP offer on each camera toggle.
      peer._mediaSenders = new Map(); peer._mediaSources = new Map();
      const initialSources = state.huddlePeerId.localeCompare(peerId) < 0 ? [['microphone','audio'], ['camera','video'], ['screen','video'], ['screen_audio','audio']] : [];
      for (const [source, kind] of initialSources) {
        const stream = state.huddleStreams.find(item => source.startsWith('screen') ? item._screen : source === 'camera' ? item._camera : !item._screen && !item._camera);
        const track = stream?.getTracks().find(item => item.kind === kind && item.readyState === 'live');
        const transceiver = peer.addTransceiver(track || kind, {direction:'sendrecv', ...(track ? {streams:[stream]} : {})});
        peer._mediaSenders.set(source, transceiver.sender); peer._mediaSources.set(transceiver, source);
      }
      peer.addEventListener('icecandidate', (event) => {
        if (event.candidate) sendHuddleSignal('ice', { candidate:event.candidate.toJSON?.() || event.candidate }, peerId).catch(() => {});
      });
      peer.addEventListener('track', (event) => {
        event.track._callSource = peer._mediaSources.get(event.transceiver) || ['microphone','camera','screen','screen_audio'][peer.getTransceivers().indexOf(event.transceiver)];
        const stream = state.huddleRemoteStreams.get(peerId) || new MediaStream();
        if (!stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
        event.track.addEventListener('ended', () => { stream.removeTrack(event.track); renderHuddle(); });
        event.track.addEventListener('mute', renderHuddle);
        event.track.addEventListener('unmute', renderHuddle);
        state.huddleRemoteStreams.set(peerId, stream);
        addHuddleRecordingStream(stream);
        renderHuddle();
      });
      peer.addEventListener('connectionstatechange', () => {
        if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) closeHuddlePeer(peerId);
      });
      state.huddlePeers.set(peerId, peer);
      return peer;
    }

    async function offerToHuddlePeer(peerId){
      const peer = ensureHuddlePeer(peerId);
      if (!peer || peer._makingOffer || peer.signalingState !== 'stable') return;
      if (!peer.remoteDescription && state.huddlePeerId.localeCompare(peerId) > 0) return;
      try {
        peer._makingOffer = true;
        await peer.setLocalDescription();
        await sendHuddleSignal('offer', { description:peer.localDescription?.toJSON?.() || peer.localDescription }, peerId);
      } finally { peer._makingOffer = false; }
    }

    async function handleHuddleSignal(signal){
      const peerId = cleanText(signal.sender_peer_id);
      if (!peerId || peerId === state.huddlePeerId) return;
      const payload = signal.payload || {};
      if (signal.kind === 'bye') return closeHuddlePeer(peerId);
      if (signal.kind === 'reaction') return showHuddleReaction(payload.emoji, payload.name || 'Participant');
      if (signal.kind === 'hello') {
        ensureHuddlePeer(peerId);
        if (state.huddlePeerId.localeCompare(peerId) < 0) await offerToHuddlePeer(peerId);
        return;
      }
      const peer = ensureHuddlePeer(peerId);
      if (!peer) return;
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        // Deterministic polite/impolite roles resolve simultaneous camera and
        // screen changes without both sides rejecting each other's SDP offer.
        const polite = state.huddlePeerId.localeCompare(peerId) > 0;
        const ready = !peer._makingOffer && (peer.signalingState === 'stable' || peer._settingRemoteAnswer);
        const collision = signal.kind === 'offer' && !ready;
        peer._ignoreOffer = !polite && collision;
        if (peer._ignoreOffer) { peer._pendingIce = []; return; }
        if (signal.kind === 'answer' && peer.signalingState !== 'have-local-offer') return;
        peer._settingRemoteAnswer = signal.kind === 'answer';
        try { await peer.setRemoteDescription(payload.description); }
        finally { peer._settingRemoteAnswer = false; }
        if (!peer._mediaSenders.size) {
          // The answerer adopts the offered transceivers. Pre-creating its own
          // would append duplicate m-lines instead of establishing duplex media.
          const transceivers = peer.getTransceivers();
          for (const [index, source] of ['microphone','camera','screen','screen_audio'].entries()) {
            const transceiver = transceivers[index]; if (!transceiver) continue;
            const stream = state.huddleStreams.find(item => source.startsWith('screen') ? item._screen : source === 'camera' ? item._camera : !item._screen && !item._camera);
            const kind = source === 'microphone' || source === 'screen_audio' ? 'audio' : 'video';
            const track = stream?.getTracks().find(item => item.kind === kind && item.readyState === 'live');
            transceiver.direction = 'sendrecv';
            await transceiver.sender.replaceTrack(track || null);
            peer._mediaSenders.set(source, transceiver.sender); peer._mediaSources.set(transceiver, source);
          }
        }
        for (const candidate of peer._pendingIce.splice(0)) await peer.addIceCandidate(candidate);
        if (signal.kind === 'offer') {
          await peer.setLocalDescription();
          await sendHuddleSignal('answer', { description:peer.localDescription?.toJSON?.() || peer.localDescription }, peerId);
        }
      } else if (signal.kind === 'ice' && payload.candidate) {
        if (peer._ignoreOffer) return;
        if (!peer.remoteDescription) peer._pendingIce.push(payload.candidate);
        else await peer.addIceCandidate(payload.candidate);
      }
    }

    async function pollHuddleSignals(){
      clearTimeout(state.huddleSignalTimer);
      if (!state.huddle?.id || !state.huddlePeerId) return;
      try {
        const data = await api.huddles.signals(orgId, state.huddle.id, state.huddlePeerId, state.huddleSignalCursor);
        state.huddleSignalCursor = Number(data.cursor || state.huddleSignalCursor);
        for (const signal of data.signals || []) {
          try { await handleHuddleSignal(signal); } catch (error) { console.warn('[FirstMateChannels] huddle signal failed', error); }
        }
        state.huddleSignalTimer = setTimeout(pollHuddleSignals, 750);
      } catch (_) {
        state.huddleSignalTimer = setTimeout(pollHuddleSignals, 2000);
      }
    }

    function addTracksToHuddlePeers(stream){
      addHuddleRecordingStream(stream);
      for (const peer of state.huddlePeers.values()) {
        for (const track of stream.getTracks()) {
          const source = stream._screen ? (track.kind === 'audio' ? 'screen_audio' : 'screen') : (track.kind === 'audio' ? 'microphone' : 'camera');
          peer._mediaSenders.get(source)?.replaceTrack(track).catch(showError);
        }
      }
    }

    function detachHuddleStream(stream){
      for (const peer of state.huddlePeers.values()) for (const sender of peer.getSenders()) {
        if (stream.getTracks().some(track => track.id === sender.track?.id)) sender.replaceTrack(null).catch(showError);
      }
      stream.getTracks().forEach(track => track.stop());
      state.huddleStreams = state.huddleStreams.filter(item => item !== stream);
    }

    function stopHuddleStreams(){
      for (const stream of state.huddleStreams) stream?.getTracks?.().forEach((track) => track.stop());
      state.huddleStreams = [];
    }

    function preferredHuddleRecordingType(video){
      const candidates = video
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        : ['audio/webm;codecs=opus', 'audio/webm', 'video/webm;codecs=opus', 'video/webm'];
      return candidates.find((type) => root.MediaRecorder?.isTypeSupported?.(type)) || '';
    }

    function attachHuddleCompositeVideo(recording){
      if (!state.huddle?.settings?.record_video || !document.createElement('canvas').captureStream) return;
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(15);
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) recording.stream.addTrack(videoTrack);
      const draw = () => {
        if (recording.stopping) return;
        context.fillStyle = '#101828';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const videos = [...(state.huddleWindowRoot || main).querySelectorAll('.fm-ch-huddle video')].filter((video) => {
          const source = video.srcObject;
          return source?.getVideoTracks?.().some((track) => track.readyState === 'live') && video.readyState >= 2;
        });
        if (videos.length) {
          const columns = videos.length === 1 ? 1 : 2;
          const rows = Math.ceil(videos.length / columns);
          const cellWidth = canvas.width / columns;
          const cellHeight = canvas.height / rows;
          videos.slice(0, 6).forEach((video, index) => {
            const col = index % columns;
            const row = Math.floor(index / columns);
            const ratio = Math.min(cellWidth / Math.max(1, video.videoWidth), cellHeight / Math.max(1, video.videoHeight));
            const width = video.videoWidth * ratio;
            const height = video.videoHeight * ratio;
            context.drawImage(video, col * cellWidth + (cellWidth - width) / 2, row * cellHeight + (cellHeight - height) / 2, width, height);
          });
        } else {
          context.fillStyle = '#fff';
          context.font = '700 42px Arial';
          context.textAlign = 'center';
          context.fillText('FirstMate Huddle', canvas.width / 2, canvas.height / 2 - 15);
          context.fillStyle = '#98a2b3';
          context.font = '26px Arial';
          context.fillText('Audio-only conversation', canvas.width / 2, canvas.height / 2 + 35);
        }
        recording.animationFrame = root.requestAnimationFrame(draw);
      };
      recording.canvas = canvas;
      recording.canvasStream = stream;
      draw();
    }

    function addHuddleRecordingStream(stream){
      const recording = state.huddleRecording;
      if (!recording || recording.stopping || !stream?.getAudioTracks) return;
      for (const track of stream.getAudioTracks()) {
        if (recording.trackIds.has(track.id)) continue;
        recording.trackIds.add(track.id);
        if (recording.audioContext && recording.destination) {
          const sourceStream = new root.MediaStream([track]);
          const source = recording.audioContext.createMediaStreamSource(sourceStream);
          source.connect(recording.destination);
          recording.sources.push(source);
        } else {
          recording.stream.addTrack(track);
        }
      }
    }

    function startHuddleRecording(){
      if (!features.recording
        || !state.huddle?.settings?.recording_enabled
        || cleanText(state.huddle.started_by) !== cleanText(currentUser.id)
        || !root.MediaRecorder
        || !root.MediaStream
        || state.huddleRecording) return;
      try {
        const AudioContextType = root.AudioContext || root.webkitAudioContext;
        const audioContext = AudioContextType ? new AudioContextType() : null;
        const destination = audioContext?.createMediaStreamDestination?.() || null;
        const stream = destination?.stream || new root.MediaStream();
        const wantsVideo = state.huddle.settings?.record_video === true;
        const recording = {
          huddleId:state.huddle.id,
          channelId:state.activeChannelId,
          startedAt:Date.now(),
          stream,
          audioContext,
          destination,
          sources:[],
          trackIds:new Set(),
          chunks:[],
          stopping:false,
          video:wantsVideo,
          animationFrame:0,
          canvas:null,
          canvasStream:null
        };
        if (wantsVideo) attachHuddleCompositeVideo(recording);
        const mimeType = preferredHuddleRecordingType(wantsVideo);
        const recorder = new root.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recording.recorder = recorder;
        state.huddleRecording = recording;
        for (const localStream of state.huddleStreams) addHuddleRecordingStream(localStream);
        for (const remoteStream of state.huddleRemoteStreams.values()) addHuddleRecordingStream(remoteStream);
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size) recording.chunks.push(event.data);
        });
        recorder.start(1000);
        audioContext?.resume?.().catch(() => {});
      } catch (error) {
        state.huddleRecording = null;
        console.warn('[FirstMateChannels] huddle recording unavailable', error);
      }
    }

    function finishHuddleRecording(){
      const recording = state.huddleRecording;
      if (!recording || recording.stopping) return;
      recording.stopping = true;
      state.huddleRecording = null;
      if (recording.animationFrame) root.cancelAnimationFrame(recording.animationFrame);
      recording.canvasStream?.getTracks?.().forEach((track) => track.stop());
      const upload = async () => {
        try {
          await recording.audioContext?.close?.().catch(() => {});
          const type = recording.recorder.mimeType || 'audio/webm';
          const blob = new Blob(recording.chunks, { type });
          if (!blob.size) return;
          const stamp = new Date(recording.startedAt).toISOString().replace(/[:.]/g, '-');
          const file = new File([blob], `Huddle ${recording.video ? 'video' : 'audio'} recording ${stamp}.webm`, { type });
          const uploaded = await api.uploads.send(orgId, file, recording.channelId);
          await api.huddles.recording(orgId, recording.huddleId, uploaded.attachment.id);
          if (state.activeChannelId === recording.channelId) refreshActiveMessages();
          root.Portal?.ui?.showToast?.(
            (globalThis.PlatformLanguage?.text("channels-ui","m_e3cf1f291b77ca","Huddle recording saved") ?? "Huddle recording saved"),
            ((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_b5fbd07409bba8",`The ${v0} recording is attached to the huddle conversation.`,{v0}) ?? `The ${v0} recording is attached to the huddle conversation.`)(recording.video ? 'video' : 'audio'),
            true
          );
        } catch (error) {
          showError(error);
        }
      };
      if (recording.recorder.state === 'inactive') {
        void upload();
        return;
      }
      recording.recorder.addEventListener('stop', () => { void upload(); }, { once:true });
      recording.recorder.stop();
    }

    function stopHuddleSession(){
      const hadCall = Boolean(state.huddle);
      if (state.huddleFullscreen) {
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        if (!root.Portal?.navigation?.applying) root.Portal?.navigation?.replace?.({huddleFullscreen:null});
      }
      clearInterval(state.huddlePoll); state.huddlePoll = null;
      const cameraToStop = state.huddleCameraTrack; state.huddleCameraTrack = null;
      if (cameraToStop) {
        // Tear down the processor before its input track; stopping the camera
        // first can race a pending GPU frame during call teardown.
        state.huddleStreams = state.huddleStreams.filter(stream => !stream._camera);
        Promise.resolve(cameraToStop.stopProcessor?.()).catch(() => {}).finally(() => cameraToStop.stop());
      }
      state.huddleProcessor = null;
      if (state.huddleBackgroundUrl) URL.revokeObjectURL(state.huddleBackgroundUrl);
      state.huddleBackgroundUrl = ''; state.huddleBackground = 'off';
      state.huddleFullscreen = false;
      finishHuddleRecording();
      clearTimeout(state.huddleSignalTimer);
      state.huddleSignalTimer = null;
      const livekitRoom = state.huddleLivekitRoom;
      state.huddleLivekitRoom = null;
      livekitRoom?.disconnect?.();
      for (const peer of state.huddlePeers.values()) peer.close?.();
      state.huddlePeers.clear();
      state.huddleRemoteStreams.clear();
      stopHuddleStreams();
      state.huddle = null;
      state.huddlePeerId = '';
      state.huddleMinimized = false;
      state.huddleWindow?.destroy(); state.huddleWindow=null;
      state.huddleWindowRoot?.remove(); state.huddleWindowRoot=null; state.huddleWindowBody=null; state.huddleDetached=false;
      if (!root.Portal?.navigation?.applying) root.Portal?.navigation?.replace?.({huddleWindow:null,huddlePinned:null,huddleFullscreen:null});
      if (hadCall) options.onCallEnded?.();
    }

    function detachCall(){
      if (!state.huddleWindow) return;
      const workspace = document.querySelector('main.main') || document.querySelector('.main');
      if (!workspace) return;
      state.huddleDetached = true;
      state.huddleWindow.rehost(workspace, workspace.querySelector(':scope > #mainPanels, :scope > #app'));
    }
    function ensureHuddleWindow(){
      if (state.huddleWindow) return;
      const workspace = document.querySelector('main.main') || document.querySelector('.main');
      const conversation = container.closest('.fm-channels-overlay');
      const detached = !!workspace && (state.huddleDetached || (conversation && conversation.dataset.window !== 'full'));
      const host = detached ? workspace : main;
      const windowRoot = el('div', 'fm-call-window'); windowRoot.dataset.theme='dark';
      const header = el('div','');
      const title = el('div','',`<i class="fas fa-headphones"></i> Call${state.activeChannel?.display_name ? ` · ${esc(state.activeChannel.display_name)}` : ''}`);
      const body = el('div','fm-call-window-body'); header.append(title); windowRoot.append(header,body); host.append(windowRoot);
      state.huddleWindowRoot=windowRoot; state.huddleWindowBody=body;
      state.huddleWindow = root.FirstMateWindows.attach({
        element:windowRoot, header, title, body, host, contentTarget:detached ? workspace.querySelector(':scope > #mainPanels, :scope > #app') : null,
        name:'call', label:(globalThis.PlatformLanguage?.text("channels-ui","m_a51c881ef80973","Call window") ?? "Call window"), mode:'floating', width:700, height:440, dockWidth:440, minWidth:320, minHeight:260,
        topInset:parent => { const bar=document.getElementById('platformTopbar'); return parent === workspace && bar?.offsetParent ? bar.offsetHeight : 0; },
        onChange:({mode,pinned}) => {
          state.huddleFullscreen=mode === 'full'; state.huddleMinimized=mode === 'minimized';
          if (mode === 'docked') detachCall();
          if (!root.Portal?.navigation?.applying) root.Portal?.navigation?.replace?.({huddleWindow:mode,huddlePinned:pinned ? '1' : null,huddleFullscreen:mode === 'full' ? '1' : null});
        },
        onClose:async () => {
          const id=state.huddle?.id; if (!id) return;
          await sendHuddleSignal('bye',{}).catch(() => {});
          try { await api.huddles.leave(orgId,id); } catch(error) { showError(error); }
          finally { if (state.huddle?.id === id) stopHuddleSession(); }
        }
      });
    }

    function showHuddleReaction(emoji, name){
      if (!EMOJI_SET.some(group => group.items.includes(emoji))) return;
      const card = (state.huddleWindowRoot || main).querySelector('.fm-ch-huddle');
      if (!card) return;
      const reaction = el('div', 'fm-ch-call-reaction', `<span>${esc(emoji)}</span><small>${esc(name)}</small>`);
      reaction.setAttribute('role', 'status'); card.append(reaction);
      setTimeout(() => reaction.remove(), 4000);
    }

    async function toggleHuddleCamera(){
      const existing = state.huddleCameraTrack;
      if (existing) {
        const track = existing.mediaStreamTrack;
        if (state.huddleLivekitRoom) await state.huddleLivekitRoom.localParticipant.unpublishTrack(existing);
        for (const peer of state.huddlePeers.values()) for (const sender of peer.getSenders()) if (sender.track?.id === track.id) await sender.replaceTrack(null);
        state.huddleStreams = state.huddleStreams.filter(stream => !stream._camera);
        await existing.stopProcessor?.(); existing.stop(); state.huddleCameraTrack = null; state.huddleProcessor = null;
        syncHuddleMediaState({camera_enabled:false}); renderHuddle(); return;
      }
      const LK = root.LivekitClient;
      if (!LK?.createLocalVideoTrack) throw new Error('The camera runtime is unavailable. Reload FirstMate and try again.');
      const joinedId = state.huddle?.id;
      const camera = await LK.createLocalVideoTrack({deviceId:state.huddleCameraDevice || undefined, resolution:{width:1280, height:720, frameRate:24}});
      if (!joinedId || state.huddle?.id !== joinedId) { camera.stop(); return; }
      state.huddleCameraTrack = camera;
      try {
        if (state.huddleBackground && state.huddleBackground !== 'off') await applyHuddleBackground(state.huddleBackground);
        if (state.huddleLivekitRoom) await state.huddleLivekitRoom.localParticipant.publishTrack(camera, {source:LK.Track.Source.Camera});
        const stream = new MediaStream([camera.mediaStreamTrack]); stream._camera = true;
        state.huddleStreams.push(stream); addTracksToHuddlePeers(stream);
        syncHuddleMediaState({camera_enabled:true}); renderHuddle();
      } catch (error) { camera.stop(); state.huddleCameraTrack = null; state.huddleProcessor = null; throw error; }
    }

    async function applyHuddleBackground(mode){
      const camera = state.huddleCameraTrack;
      state.huddleBackground = mode;
      if (!camera) return;
      const before = camera.mediaStreamTrack;
      if (mode === 'off' && !state.huddleProcessor) return;
      if (!state.huddleProcessor) {
        const effects = await import('../calls-runtime/effects/track-processors.mjs');
        if (!effects.supportsBackgroundProcessors()) throw new Error('Background effects require a browser with WebGL2 support. Try current Chrome or Edge.');
        // CPU segmentation avoids platform-specific GPU teardown stalls; the
        // final composition still uses the processor's supported canvas path.
        state.huddleProcessor = effects.BackgroundProcessor({mode:'disabled', maxFps:15, segmenterOptions:{delegate:'CPU'}, assetPaths:{tasksVisionFileSet:'/libraries/calls-runtime/effects/wasm', modelAssetPath:'/libraries/calls-runtime/effects/selfie_segmenter.tflite'}});
        await camera.setProcessor(state.huddleProcessor);
        if (state.huddleCameraTrack !== camera) { await camera.stopProcessor(); camera.stop(); return; }
      }
      await state.huddleProcessor.switchTo(mode === 'off' ? {mode:'disabled'} : mode === 'blur' ? {mode:'background-blur', blurRadius:12} : {mode:'virtual-background', imagePath:state.huddleBackgroundUrl});
      const after = camera.mediaStreamTrack;
      if (before.id !== after.id) {
        for (const peer of state.huddlePeers.values()) for (const sender of peer.getSenders()) if (sender.track?.id === before.id) await sender.replaceTrack(after);
        for (const stream of state.huddleStreams.filter(stream => stream._camera)) { stream.getTracks().forEach(track => stream.removeTrack(track)); stream.addTrack(after); }
      }
      renderHuddle();
    }

    function openHuddleInvite(){
      if (!state.huddle) return;
      const channelId = state.huddle.channel_id;
      const link = `${String(root.location.href).split(/[?#]/)[0]}?tab=channels&channel=${encodeURIComponent(channelId)}`;
      showModal('Invite to this call', body => {
        body.innerHTML = `<p>${(globalThis.PlatformLanguage?.text("channels-ui","m_6c8a4c405347f8","Share this link with a teammate. They can open the conversation and choose Join call. Channel access is still required.") ?? "Share this link with a teammate. They can open the conversation and choose Join call. Channel access is still required.")}</p><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_2f7e0e85304cb2","Conversation link") ?? "Conversation link")}</label><input data-call-link readonly><p data-copy-status role="status"></p>`;
        body.querySelector('input').value = link;
      }, [{label:(globalThis.PlatformLanguage?.text("channels-ui","m_978593789ac461","Copy invite link") ?? "Copy invite link"), primary:true, onClick:async (_close, body) => {
        try { await navigator.clipboard.writeText(link); body.querySelector('[data-copy-status]').textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_58f26b2d816185","Invite link copied.") ?? "Invite link copied."); }
        catch (_) { body.querySelector('input').select(); body.querySelector('[data-copy-status]').textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_3478f6639730e7","Select and copy the link above.") ?? "Select and copy the link above."); }
      }}]);
    }

    function openHuddleSettings(){
      if (!state.huddle) return;
      showModal('Call settings', body => {
        const tabs = el('div', 'fm-ch-call-settings-tabs'); tabs.setAttribute('role', 'tablist');
        const panel = el('div', 'fm-ch-call-settings-panel'); panel.setAttribute('role', 'tabpanel');
        body.append(tabs, panel);
        const status = () => { const note = el('p', '', ''); note.setAttribute('role', 'status'); panel.append(note); return note; };
        const choose = async kind => {
          panel.innerHTML = '';
          for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.tab === kind));
          if (kind === 'audio') {
            panel.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_cedfacd7206bc5","Microphone") ?? "Microphone")}</label><select data-mic></select><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_543edcbe09e9aa","Speaker") ?? "Speaker")}</label><select data-speaker></select><label class="fm-ch-check-row"><span><strong>${(globalThis.PlatformLanguage?.text("channels-ui","m_b6c695bc2ccfc9","Noise suppression") ?? "Noise suppression")}</strong><small>${(globalThis.PlatformLanguage?.text("channels-ui","m_b783439dfb8937","Reduce background sound and echo using your browser's audio processing.") ?? "Reduce background sound and echo using your browser's audio processing.")}</small></span><input type="checkbox" data-noise ${String(state.huddleNoiseSuppression ? 'checked' : '')}></label>`;
            const note = status();
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              if (!panel.querySelector('[data-mic]')) return;
              for (const [selector, deviceKind, selected] of [['[data-mic]', 'audioinput', state.huddleMicrophone], ['[data-speaker]', 'audiooutput', state.huddleSpeaker]]) {
                const select = panel.querySelector(selector);
                select.append(new Option('System default', ''));
                devices.filter(device => device.kind === deviceKind).forEach((device, index) => select.append(new Option(device.label || `${deviceKind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}`, device.deviceId)));
                select.value = selected || '';
              }
              const speaker = panel.querySelector('[data-speaker]');
              speaker.disabled = !('setSinkId' in HTMLMediaElement.prototype);
              if (speaker.disabled) note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_194d3058386bd1","This browser uses the system speaker. Change output in your operating system.") ?? "This browser uses the system speaker. Change output in your operating system.");
              speaker.onchange = async () => {
                try { await Promise.all([...(state.huddleWindowRoot || main).querySelectorAll('.fm-ch-huddle audio')].map(audio => audio.setSinkId(speaker.value))); state.huddleSpeaker = speaker.value; }
                catch (error) { note.textContent = error.message; }
              };
              const updateMicrophone = async () => {
                const noise = panel.querySelector('[data-noise]').checked;
                const deviceId = panel.querySelector('[data-mic]').value;
                try {
                  const constraints = {deviceId:deviceId ? {exact:deviceId} : undefined, noiseSuppression:noise, echoCancellation:true, autoGainControl:true};
                  const publication = state.huddleLivekitRoom?.localParticipant.getTrackPublication(root.LivekitClient.Track.Source.Microphone);
                  if (publication?.track?.restartTrack) await publication.track.restartTrack(constraints);
                  else {
                    const stream = await navigator.mediaDevices.getUserMedia({audio:constraints});
                    const next = stream.getAudioTracks()[0];
                    const previousStream = state.huddleStreams.find(source => !source._screen && source.getAudioTracks().length);
                    const previous = previousStream?.getAudioTracks()[0];
                    next.enabled = previous?.enabled !== false;
                    for (const peer of state.huddlePeers.values()) for (const sender of peer.getSenders()) if (sender.track?.id === previous?.id) await sender.replaceTrack(next);
                    if (previous) { previousStream.removeTrack(previous); previous.stop(); previousStream.addTrack(next); }
                    else state.huddleStreams.push(stream);
                  }
                  state.huddleMicrophone = deviceId; state.huddleNoiseSuppression = noise; note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_f14c3788c42990","Audio settings applied.") ?? "Audio settings applied.");
                } catch (error) { note.textContent = error.message; }
              };
              panel.querySelector('[data-mic]').onchange = updateMicrophone;
              panel.querySelector('[data-noise]').onchange = updateMicrophone;
            } catch (error) { note.textContent = error.message; }
          } else if (kind === 'video') {
            panel.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_4fc089007391b2","Camera") ?? "Camera")}</label><select data-camera></select><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_986685f23ed459","Background") ?? "Background")}</label><select data-background><option value="off">${(globalThis.PlatformLanguage?.text("channels-ui","m_2d4ff8a83b1b5c","None") ?? "None")}</option><option value="blur">${(globalThis.PlatformLanguage?.text("channels-ui","m_25e31e6df3932b","Blur background") ?? "Blur background")}</option><option value="image">${(globalThis.PlatformLanguage?.text("channels-ui","m_dded30d0d11aa4","Custom image") ?? "Custom image")}</option></select><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_ba52df24a42201","Background image") ?? "Background image")}</label><input type="file" data-background-file accept="image/png,image/jpeg,image/webp"><p>${(globalThis.PlatformLanguage?.text("channels-ui","m_6b53ab1f380683","Effects are applied to the video other people see. Your image stays on this device for this call.") ?? "Effects are applied to the video other people see. Your image stays on this device for this call.")}</p>`;
            const note = status();
            panel.querySelector('[data-background]').value = state.huddleBackground || 'off';
            const apply = async mode => {
              if (mode === 'image' && !state.huddleBackgroundUrl) { note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_e9533d60edb911","Choose a background image first.") ?? "Choose a background image first."); return; }
              note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_c6c8674cb454c2","Applying background…") ?? "Applying background…");
              try { await applyHuddleBackground(mode); note.textContent = state.huddleCameraTrack ? 'Background applied.' : 'Background will apply when you turn on your camera.'; }
              catch (error) { note.textContent = error.message; }
            };
            panel.querySelector('[data-background]').onchange = event => apply(event.target.value);
            panel.querySelector('[data-background-file]').onchange = async event => {
              const file = event.target.files[0]; if (!file) return;
              if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_d73822bd85f3bb","Choose a PNG, JPEG, or WebP image under 10 MB.") ?? "Choose a PNG, JPEG, or WebP image under 10 MB."); return; }
              if (state.huddleBackgroundUrl) URL.revokeObjectURL(state.huddleBackgroundUrl);
              state.huddleBackgroundUrl = URL.createObjectURL(file);
              panel.querySelector('[data-background]').value = 'image'; await apply('image');
            };
            const select = panel.querySelector('[data-camera]'); select.append(new Option('System default', ''));
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              devices.filter(device => device.kind === 'videoinput').forEach((device, index) => select.append(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
              select.value = state.huddleCameraDevice || '';
              select.onchange = async () => {
                state.huddleCameraDevice = select.value;
                try { if (state.huddleCameraTrack) { await toggleHuddleCamera(); await toggleHuddleCamera(); } note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_10952f493a2ade","Camera selected.") ?? "Camera selected."); }
                catch (error) { note.textContent = error.message; }
              };
            } catch (error) { note.textContent = error.message; }
          } else {
            panel.innerHTML = `<p>${(globalThis.PlatformLanguage?.text("channels-ui","m_04f8c6b251c5a9","Check browser permissions and the selected devices first. If screen sharing stops, choose the window or tab again. Headphones can help prevent echo.") ?? "Check browser permissions and the selected devices first. If screen sharing stops, choose the window or tab again. Headphones can help prevent echo.")}</p><ul><li>${(globalThis.PlatformLanguage?.text("channels-ui","m_a902b5e18d940f","Microphone or camera blocked: allow access using the browser address bar.") ?? "Microphone or camera blocked: allow access using the browser address bar.")}</li><li>${(globalThis.PlatformLanguage?.text("channels-ui","m_475289e103df8d","No screen audio: choose a browser tab and enable the browser’s share-audio option.") ?? "No screen audio: choose a browser tab and enable the browser’s share-audio option.")}</li><li>${(globalThis.PlatformLanguage?.text("channels-ui","m_9bdc55fd8ac4a4","Choppy video: stop sharing, turn off background effects, or turn off your camera.") ?? "Choppy video: stop sharing, turn off background effects, or turn off your camera.")}</li></ul>`;
            const run = el('button', 'fm-ch-btn', 'Run connection check');
            const speakerTest = el('button', 'fm-ch-btn', 'Test speaker');
            const microphoneTest = el('button', 'fm-ch-btn', 'Test microphone level');
            const note = status(); panel.append(run, speakerTest, microphoneTest);
            run.onclick = async () => {
              const results = [`Secure browser: ${root.isSecureContext ? 'yes' : 'no'}`, `Network: ${navigator.onLine ? 'online' : 'offline'}`, `Connection: ${state.huddleLivekitRoom?.state || [...state.huddlePeers.values()].map(peer => peer.connectionState).join(', ') || 'Waiting for others'}`];
              try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                results.push(`Microphones: ${devices.filter(device => device.kind === 'audioinput').length}`, `Cameras: ${devices.filter(device => device.kind === 'videoinput').length}`);
                for (const peer of state.huddlePeers.values()) {
                  const stats = await peer.getStats();
                  stats.forEach(report => { if (report.type === 'inbound-rtp') results.push(`${report.kind}: ${report.packetsLost || 0} packets lost, ${Math.round((report.jitter || 0) * 1000)} ms jitter`); });
                }
                if (state.huddleLivekitRoom) results.push(`Media quality: ${state.huddleLivekitRoom.localParticipant.connectionQuality || 'unknown'}`);
              } catch (error) { results.push(error.message); }
              note.textContent = results.join('\n'); note.style.whiteSpace = 'pre-line';
            };
            speakerTest.onclick = async () => {
              const context = new (root.AudioContext || root.webkitAudioContext)();
              try {
                if (state.huddleSpeaker && context.setSinkId) await context.setSinkId(state.huddleSpeaker);
                await context.resume(); const oscillator = context.createOscillator(); const gain = context.createGain();
                gain.gain.value = 0.08; oscillator.frequency.value = 440; oscillator.connect(gain).connect(context.destination);
                oscillator.start(); oscillator.stop(context.currentTime + 0.5); oscillator.onended = () => context.close();
                note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_d52bf5eb932218","A short tone played through your speaker.") ?? "A short tone played through your speaker.");
              } catch (error) { note.textContent = error.message; context.close(); }
            };
            microphoneTest.onclick = async () => {
              const track = state.huddleLivekitRoom?.localParticipant.getTrackPublication(root.LivekitClient.Track.Source.Microphone)?.track?.mediaStreamTrack || state.huddleStreams.find(stream => !stream._screen)?.getAudioTracks()[0];
              if (!track || !track.enabled) { note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_08e3b0260b731d","Unmute your microphone to test it.") ?? "Unmute your microphone to test it."); return; }
              const context = new (root.AudioContext || root.webkitAudioContext)();
              await context.resume(); const analyser = context.createAnalyser(); context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
              const values = new Uint8Array(analyser.fftSize); let count = 0;
              note.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_147f0c7c427062","Speak for five seconds…") ?? "Speak for five seconds…");
              const timer = setInterval(() => {
                if (!note.isConnected || ++count > 25) { clearInterval(timer); context.close(); return; }
                analyser.getByteTimeDomainData(values);
                const level = Math.round(Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length) * 100);
                note.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("channels-ui","m_73dc65de8b8fbc",`Microphone level: ${v0}% — ${v1}`,{v0,v1}) ?? `Microphone level: ${v0}% — ${v1}`)(level,level > 1 ? 'Voice detected' : 'Speak into the selected microphone');
              }, 200);
            };
          }
        };
        for (const [id, label] of [['audio','Audio'], ['video','Video & backgrounds'], ['troubleshooting','Troubleshooting']]) {
          const tab = el('button', '', label); tab.dataset.tab = id; tab.setAttribute('role','tab'); tab.onclick = () => choose(id); tabs.append(tab);
        }
        choose('audio');
      }, [{label:(globalThis.PlatformLanguage?.text("channels-ui","m_8cb6b086a0e69c","Done") ?? "Done"), primary:true, onClick:close => close()}]);
    }

    function renderHuddle(){
      (state.huddleWindowRoot || main).querySelector('.fm-ch-huddle')?.remove();
      if (!state.huddle) return;
      ensureHuddleWindow();
      const card = el('div', 'fm-ch-huddle');
      card.setAttribute('role','region'); card.setAttribute('aria-label',(globalThis.PlatformLanguage?.text("channels-ui","m_a50a39d598d13a","Video call") ?? "Video call"));
      const head = el('div','fm-ch-huddle-head','');
      if (state.huddle.settings?.recording_enabled) {
        head.appendChild(el('span', 'fm-ch-huddle-recording', `<i class="fas fa-circle"></i> ${state.huddle.settings?.record_video ? 'Video recording' : 'Recording'}`));
      }
      const activeParticipants = (state.huddle.participants || []).filter((item) => !item.left_at);
      head.appendChild(el('span', '', `${activeParticipants.length || 1} joined`));
      const preview = document.createElement('video');
      preview.className = 'fm-ch-huddle-preview';
      preview.autoplay = true;
      preview.muted = true;
      preview.playsInline = true;
      const localVideoStream = state.huddleCameraTrack ? new MediaStream([state.huddleCameraTrack.mediaStreamTrack]) : null;
      if (localVideoStream) preview.srcObject = localVideoStream;
      preview.hidden = !localVideoStream;
      const remotes = el('div', 'fm-ch-huddle-remotes');
      const stage = el('div', 'fm-ch-call-stage');
      const addTile = (person, stream, self = false, screen = false) => {
        const tile = el('div', `fm-ch-call-tile${screen ? ' screen' : ''}`);
        const name = person.display_name || person.name || (self ? currentUser.name || 'You' : 'Participant');
        const profile = state.activeChannel?.members?.find(member => member.id === (person.user_id || person.id)) || person;
        const visual = stream?.getVideoTracks().find(track => track.readyState === 'live' && track.enabled && !track.muted && !track._callMuted);
        const identity = el('div', 'fm-ch-call-identity', avatarHtml({...profile, name}, '') + `<strong>${esc(name)}</strong><small>${self ? 'You' : 'Camera off'}</small>`);
        if (visual) {
          const video = self && !screen ? preview : document.createElement('video');
          video.autoplay = true; video.playsInline = true; video.muted = true;
          video.srcObject = new MediaStream([visual]); video.hidden = false; tile.append(video);
        } else tile.append(identity);
        tile.append(el('span', 'fm-ch-call-name', `${esc(name)}${self ? ' · You' : ''}${screen ? ' · Screen' : ''}${person.microphone_enabled === false ? ' · Muted' : ''}`));
        stage.append(tile);
      };
      const me = activeParticipants.find(person => person.user_id === currentUser.id) || {...currentUser, user_id:currentUser.id};
      addTile(me, localVideoStream, true);
      for (const stream of state.huddleStreams) if (stream._screen) addTile(me, stream, true, true);
      const lkScreen = state.huddleLivekitRoom?.localParticipant.getTrackPublication(root.LivekitClient.Track.Source.ScreenShare)?.track;
      if (lkScreen) addTile(me, new MediaStream([lkScreen.mediaStreamTrack]), true, true);
      const rendered = new Set();
      for (const [peerId, stream] of state.huddleRemoteStreams) {
        const participant = activeParticipants.find(person => peerId === person.user_id || peerId.startsWith(`${person.user_id}_`)) || {user_id:peerId, name:'Participant'};
        rendered.add(participant.user_id);
        const tracks = stream.getVideoTracks().filter(track => track.readyState === 'live' && track.enabled && !track.muted && !track._callMuted
          && !(track._callSource === 'screen' && participant.screen_enabled !== true)
          && !(track._callSource === 'camera' && participant.camera_enabled !== true));
        if (!tracks.some(track => track._callSource !== 'screen')) addTile(participant, null);
        tracks.forEach((track, index) => addTile(participant, new MediaStream([track]), false, track._callSource === 'screen' || (!track._callSource && index > 0) || Boolean(track.getSettings?.().displaySurface)));
        if (stream.getAudioTracks().length) {
          const audio = document.createElement('audio'); audio.autoplay = true;
          audio.srcObject = new MediaStream(stream.getAudioTracks());
          if (state.huddleSpeaker && audio.setSinkId) audio.setSinkId(state.huddleSpeaker).catch(() => {});
          remotes.append(audio);
        }
      }
      for (const participant of activeParticipants) if (participant.user_id !== currentUser.id && !rendered.has(participant.user_id)) addTile(participant, null);
      const roster = el('div', 'fm-ch-huddle-roster');
      for (const participant of activeParticipants) {
        const name = cleanText(participant.display_name || participant.name || participant.user_id) || 'Participant';
        const person = el('div', 'fm-ch-huddle-person');
        person.innerHTML = `${avatarHtml({ id:participant.user_id, name }, 'sm')}<span class="fm-ch-huddle-person-name">${esc(name)}${cleanText(participant.user_id) === cleanText(state.huddle.started_by) ? ` <small>${(globalThis.PlatformLanguage?.text("channels-ui","m_523563ae2fd488","Host") ?? "Host")}</small>` : ''}</span><span class="fm-ch-huddle-person-media"><i class="fas fa-microphone${participant.microphone_enabled === false ? '-slash off' : ' on'}" title="${participant.microphone_enabled === false ? 'Muted' : 'Microphone on'}"></i><i class="fas fa-video${participant.camera_enabled ? ' on' : '-slash off'}" title="${participant.camera_enabled ? 'Camera on' : 'Camera off'}"></i>${participant.screen_enabled ? ("<i class=\"fas fa-desktop on\" title=\"" + (globalThis.PlatformLanguage?.text("channels-ui","m_b7aad2d2258653","Sharing screen") ?? "Sharing screen") + "\"></i>") : ''}</span>`;
        roster.appendChild(person);
        if (state.huddle.started_by === currentUser.id && participant.user_id !== currentUser.id) {
          const remove = el('button', '', 'Remove'); remove.title = ((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_9d9046b4248149",`Remove ${v0}`,{v0}) ?? `Remove ${v0}`)(name);
          remove.onclick = () => showModal(`Remove ${name}?`, body => { body.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_fc150c2dd1023b","They will leave this call and cannot rejoin it.") ?? "They will leave this call and cannot rejoin it."); }, [{label:(globalThis.PlatformLanguage?.text("channels-ui","m_cbef679b21abb4","Cancel") ?? "Cancel"), onClick:close => close()}, {label:(globalThis.PlatformLanguage?.text("channels-ui","m_f643f568915438","Remove") ?? "Remove"), primary:true, onClick:async close => {
            try { const data = await api.huddles.removeParticipant(orgId, state.huddle.id, participant.user_id); state.huddle = data.huddle; close(); renderHuddle(); } catch (error) { showError(error); }
          }}]);
          person.append(remove);
        }
      }
      if (!roster.childElementCount) {
        roster.innerHTML = `<div class="fm-ch-huddle-person">${String(avatarHtml(currentUser, 'sm'))}<span class="fm-ch-huddle-person-name">${String(esc(currentUser.name || 'You'))} <small>${(globalThis.PlatformLanguage?.text("channels-ui","m_523563ae2fd488","Host") ?? "Host")}</small></span></div>`;
      }
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(state.huddle.started_at || Date.now()).getTime()) / 1000));
      const connection = state.huddleLivekitRoom?.state || ([...state.huddlePeers.values()].some(peer => peer.connectionState === 'connected') ? 'connected' : activeParticipants.length > 1 ? 'connecting' : 'Waiting for others');
      const status = el('div', 'fm-ch-huddle-status', `<span>${esc(connection)} · ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}</span>`);
      const actions = el('div', 'fm-ch-huddle-actions');
      const mic = el('button', '', '<i class="fas fa-microphone"></i>');
      mic.title = me.microphone_enabled === false ? 'Unmute microphone' : 'Mute microphone';
      mic.innerHTML = `<i class="fas fa-microphone${me.microphone_enabled === false ? '-slash' : ''}"></i>`;
      mic.setAttribute('aria-pressed', String(me.microphone_enabled !== false));
      mic.setAttribute('aria-label', mic.title);
      mic.addEventListener('click', async () => {
        try {
        if (state.huddleLivekitRoom) {
          const enabled = state.huddleLivekitRoom.localParticipant.isMicrophoneEnabled;
          await state.huddleLivekitRoom.localParticipant.setMicrophoneEnabled(!enabled);
          syncHuddleMediaState({ microphone_enabled:!enabled });
          return;
        }
        const tracks = state.huddleStreams.filter(stream => !stream._screen).flatMap((stream) => stream.getAudioTracks());
        const enabled = tracks.some((track) => track.enabled);
        tracks.forEach((track) => { track.enabled = !enabled; });
        mic.innerHTML = `<i class="fas fa-microphone${enabled ? '-slash' : ''}"></i>`;
        syncHuddleMediaState({ microphone_enabled:!enabled });
        } catch (error) { showError(error); }
      });
      const camera = el('button', '', '<i class="fas fa-video"></i>');
      camera.title = (globalThis.PlatformLanguage?.text("channels-ui","m_c899ea2cdeb3f4","Toggle camera") ?? "Toggle camera");
      camera.dataset.huddleVisual = 'camera';
      camera.setAttribute('aria-label', camera.title);
      camera.setAttribute('aria-pressed', String(Boolean(state.huddleCameraTrack)));
      camera.innerHTML = `<i class="fas fa-video${state.huddleCameraTrack ? '' : '-slash'}"></i>`;
      camera.addEventListener('click', async () => {
        camera.disabled = true;
        try { await toggleHuddleCamera(); } catch (error) { showError(error); }
        finally { if (camera.isConnected) camera.disabled = false; }
      });
      const share = el('button', '', '<i class="fas fa-desktop"></i>');
      share.title = (globalThis.PlatformLanguage?.text("channels-ui","m_ceb8082c94a6e3","Share screen") ?? "Share screen");
      share.title = me.screen_enabled ? 'Stop sharing' : 'Share screen';
      share.setAttribute('aria-pressed', String(Boolean(me.screen_enabled)));
      share.dataset.huddleVisual = 'screen';
      share.setAttribute('aria-label', share.title);
      share.addEventListener('click', async () => {
        try {
        if (state.huddleLivekitRoom) {
          const enabled = state.huddleLivekitRoom.localParticipant.isScreenShareEnabled;
          await state.huddleLivekitRoom.localParticipant.setScreenShareEnabled(!enabled, { audio:true });
          syncHuddleMediaState({ screen_enabled:!enabled });
          return;
        }
          const existing = state.huddleStreams.find(stream => stream._screen && stream.getVideoTracks().some(track => track.readyState === 'live'));
          if (existing) {
            detachHuddleStream(existing);
            syncHuddleMediaState({screen_enabled:false}); return;
          }
          const display = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
          display._screen = true;
          state.huddleStreams.push(display);
          addTracksToHuddlePeers(display);
          preview.srcObject = display;
          preview.hidden = false;
          syncHuddleMediaState({ screen_enabled:true });
          display.getVideoTracks()[0]?.addEventListener('ended', () => {
            detachHuddleStream(display);
            syncHuddleMediaState({ screen_enabled:false });
          });
        } catch (error) {
          if (error?.name !== 'NotAllowedError') showError(error);
        }
      });
      const leave = el('button', 'danger', '<i class="fas fa-phone-slash"></i>');
      leave.title = (globalThis.PlatformLanguage?.text("channels-ui","m_36784735ba32be","Leave huddle") ?? "Leave huddle");
      leave.setAttribute('aria-label', leave.title);
      leave.addEventListener('click', async () => {
        const huddleId = state.huddle?.id;
        if (!huddleId || leave.disabled) return;
        leave.disabled = true;
        leave.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
        await sendHuddleSignal('bye', {}).catch(() => {});
        try {
          await api.huddles.leave(orgId, huddleId);
        } catch (error) {
          showError(error);
        } finally {
          if (state.huddle?.id === huddleId) stopHuddleSession();
        }
      });
      actions.append(mic, camera, share);
      const control = (label, icon, fn) => {
        const button = el('button', '', `<i class="fas fa-${icon}"></i>`);
        button.title = label; button.setAttribute('aria-label', label);
        button.onclick = fn; actions.append(button); return button;
      };
      const reaction = control('React', 'face-smile', () => openEmojiPicker(reaction, async emoji => {
        showHuddleReaction(emoji, currentUser.name || 'You');
        try {
          if (state.huddleLivekitRoom) await state.huddleLivekitRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({emoji})), {reliable:true, topic:'firstmate.reaction'});
          else await sendHuddleSignal('reaction', {emoji, name:currentUser.name || 'Participant'});
        } catch (error) { showError(error); }
      }));
      control('Invite people', 'user-plus', openHuddleInvite);
      control('Participants', 'users', () => { state.huddlePanel = state.huddlePanel === 'participants' ? '' : 'participants'; renderHuddle(); });
      control('Call settings and troubleshooting', 'gear', openHuddleSettings);

      if (cleanText(state.huddle.started_by) === cleanText(currentUser.id)) {
        const end = el('button', 'danger', '<i class="fas fa-stop"></i>');
        end.title = (globalThis.PlatformLanguage?.text("channels-ui","m_120afc23be66f7","End huddle for everyone") ?? "End huddle for everyone");
        end.setAttribute('aria-label', end.title);
        end.addEventListener('click', () => {
          const huddleId = state.huddle?.id;
          showModal('End call for everyone?', body => { body.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_2d6a28a2311585","Everyone will be disconnected. To leave without ending the call, use Leave instead.") ?? "Everyone will be disconnected. To leave without ending the call, use Leave instead."); }, [
            {label:(globalThis.PlatformLanguage?.text("channels-ui","m_cbef679b21abb4","Cancel") ?? "Cancel"), onClick:close => close()},
            {label:(globalThis.PlatformLanguage?.text("channels-ui","m_458f381dce8803","End call") ?? "End call"), primary:true, onClick:async close => {
              try { await api.huddles.end(orgId, huddleId); close(); if (state.huddle?.id === huddleId) stopHuddleSession(); }
              catch (error) { showError(error); }
            }}
          ]);
        });
        end.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_e6652445454fa7","End call for everyone") ?? "End call for everyone");
        roster.appendChild(end);
      }
      actions.appendChild(leave);
      const labels = new Map([[mic,'Mic'], [camera,'Camera'], [share,'Share'], [reaction,'React'], [leave,'Leave']]);
      for (const button of actions.children) button.append(el('small', '', labels.get(button) || ({'Invite people':'Invite','Participants':'People','Call settings and troubleshooting':'Settings'}[button.title] || button.title)));
      roster.hidden = state.huddlePanel !== 'participants';
      card.append(head, stage, remotes, roster, status, actions);
      state.huddleWindowBody.append(card);
    }

    async function recordClip(mode, onPrepared){
      const channelId = state.activeChannelId;
      const capture = mode === 'screen'
        ? navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices)
        : navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (!capture || !root.MediaRecorder) throw new Error('Clip recording is not supported in this browser.');
      const stream = await capture({ video:true, audio:true });
      if (state.destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
      const sourceStreams = [stream];
      let audioContext = null;
      if (mode === 'screen') {
        try {
          const microphone = await navigator.mediaDevices.getUserMedia({ audio:{echoCancellation:true, noiseSuppression:true}, video:false });
          sourceStreams.push(microphone);
          audioContext = new (root.AudioContext || root.webkitAudioContext)();
          const destination = audioContext.createMediaStreamDestination();
          for (const source of sourceStreams) if (source.getAudioTracks().length) audioContext.createMediaStreamSource(source).connect(destination);
          // Keep the display stream's source tracks for cleanup, but record one mixed audio track.
          sourceStreams.push(new MediaStream([...stream.getTracks()]));
          stream.getAudioTracks().forEach(track => stream.removeTrack(track));
          destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
          await audioContext.resume();
        } catch (error) {
          sourceStreams.forEach(source => source.getTracks().forEach(track => track.stop()));
          await audioContext?.close();
          throw error;
        }
      }
      const chunks = [];
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
      const backdrop = el('div', 'fm-ch-modal-backdrop');
      const modal = el('div', 'fm-ch-modal');
      const head = el('div', 'fm-ch-modal-head', `<span>${mode === 'screen' ? 'Screen clip' : 'Video clip'}</span>`);
      const body = el('div', 'fm-ch-modal-body');
      const preview = document.createElement('video');
      preview.autoplay = true;
      preview.muted = true;
      preview.playsInline = true;
      preview.srcObject = stream;
      preview.style.width = '100%';
      preview.style.maxHeight = '48vh';
      preview.style.background = '#000';
      preview.style.borderRadius = '9px';
      const status = el('div', 'fm-ch-result-meta', 'Preview ready. Start when you are ready.');
      status.setAttribute('role', 'status');
      status.style.marginTop = '8px';
      body.append(preview, status);
      const foot = el('div', 'fm-ch-modal-foot');
      const cancel = el('button', 'fm-ch-btn', 'Discard');
      const start = el('button', 'fm-ch-btn primary', 'Start recording');
      start.disabled = true;
      preview.addEventListener('loadeddata', () => { start.disabled = false; }, {once:true});
      const stop = el('button', 'fm-ch-btn', 'Stop recording');
      const attach = el('button', 'fm-ch-btn primary', 'Attach clip');
      const retake = el('button', 'fm-ch-btn', 'Record again'); retake.hidden = true;
      stop.hidden = true; attach.hidden = true;
      foot.append(cancel, retake, start, stop, attach);
      modal.append(head, body, foot);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      let playbackUrl = '';
      let timer = null;
      let discarded = false;
      const releaseTracks = () => {
        sourceStreams.forEach(source => source.getTracks().forEach(track => track.stop()));
        audioContext?.close().catch(() => {}); audioContext = null;
        clearInterval(timer);
      };
      const cleanup = () => {
        releaseTracks();
        if (playbackUrl) URL.revokeObjectURL(playbackUrl);
        backdrop.remove();
        if (state.clipCleanup === discardClip) state.clipCleanup = null;
      };
      const discardClip = () => {
        discarded = true;
        if (recorder.state !== 'inactive') recorder.stop();
        cleanup();
      };
      state.clipCleanup?.(); state.clipCleanup = discardClip;
      cancel.addEventListener('click', discardClip);
      retake.onclick = () => { discardClip(); recordClip(mode, onPrepared).catch(showError); };
      recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_2c640a7cfa3b34","Recording failed. Discard this clip and try again.") ?? "Recording failed. Discard this clip and try again.");
        releaseTracks(); start.hidden = true; stop.hidden = true;
      });
      recorder.addEventListener('stop', () => {
        if (discarded || !backdrop.isConnected) return cleanup();
        releaseTracks();
        start.hidden = true; stop.hidden = true;
        if (!chunks.length) { retake.hidden = false; status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_8913da361938b8","No video was captured. Choose Record again to retry.") ?? "No video was captured. Choose Record again to retry."); return; }
        playbackUrl = URL.createObjectURL(new Blob(chunks, {type:recorder.mimeType}));
        preview.srcObject = null; preview.src = playbackUrl;
        preview.controls = true; preview.muted = false; preview.autoplay = false;
        attach.hidden = false;
        retake.hidden = false;
        status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_f1485215a43d2a","Review your clip, then attach it to your draft. Send it when ready.") ?? "Review your clip, then attach it to your draft. Send it when ready.");
      });
      attach.addEventListener('click', async () => {
        attach.disabled = true;
        status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_f29c3f0af21be8","Uploading clip...") ?? "Uploading clip...");
        try {
          const type = recorder.mimeType || 'video/webm';
          if (state.activeChannelId !== channelId) throw new Error('Return to the original conversation before attaching this clip.');
          const file = new File(chunks, `${mode}-clip-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type });
          const uploaded = await api.uploads.send(orgId, file, channelId);
          if (state.destroyed || state.activeChannelId !== channelId) throw new Error('The conversation changed. Return to it before attaching your clip.');
          onPrepared(uploaded.attachment);
          cleanup();
        } catch (error) {
          status.textContent = cleanText(error?.message) || 'Upload failed.';
          attach.disabled = false;
        }
      });
      stop.addEventListener('click', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      });
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      });
      start.addEventListener('click', () => {
        if (!stream.getVideoTracks().some(track => track.readyState === 'live')) { status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_3630e6c31b9a9c","Screen or camera capture ended. Discard and try again.") ?? "Screen or camera capture ended. Discard and try again."); return; }
        recorder.start(1000);
        start.hidden = true; stop.hidden = false;
        const startedAt = Date.now();
        status.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_045c368e96af64","Recording · 0:00") ?? "Recording · 0:00");
        timer = setInterval(() => {
          const seconds = Math.floor((Date.now() - startedAt) / 1000);
          status.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("channels-ui","m_fcfb7b5e997465",`Recording · ${v0}:${v1}`,{v0,v1}) ?? `Recording · ${v0}:${v1}`)(Math.floor(seconds / 60),String(seconds % 60).padStart(2, '0'));
        }, 500);
      });
    }

    // --- message list --------------------------------------------------------------------

    function tagChipHtml(tagId){
      const option = (features.tagOptions || []).find((tag) => tag.id === tagId);
      return `<span class="fm-ch-tag">${esc(option?.label || tagId.replace(/[_-]+/g, ' '))}</span>`;
    }

    function audienceLabel(audience){
      if (!audience?.length || audience.length >= AUDIENCE_GROUPS.length) return '';
      return audience.map((group) => AUDIENCE_GROUPS.find((item) => item.id === group)?.label || group).join(', ');
    }

    function translationLabel(code){
      return ({ en:'English', 'en-US':'English (US)', 'en-GB':'English (UK)', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', it:'Italian', nl:'Dutch', pl:'Polish', ru:'Russian', uk:'Ukrainian', ar:'Arabic', hi:'Hindi', bn:'Bengali', ur:'Urdu', zh:'Chinese', ja:'Japanese', ko:'Korean', vi:'Vietnamese', th:'Thai', id:'Indonesian', tl:'Filipino', tr:'Turkish', he:'Hebrew' })[code] || code || 'another language';
    }

    function runTranslationQueue(){
      while (translationActive < 2 && translationQueue.length) {
        const message = translationQueue.shift();
        if (!message || translationPending.has(message.id) || message.translation?.cached_text) continue;
        translationActive += 1;
        message._translation_loading = true;
        const pending = api.messages.translate(orgId, message.id)
          .then((data) => {
            const translated = data?.translation?.translated_text;
            if (!translated) return;
            message.translation = { ...(message.translation || {}), ...data.translation, cached_text:translated, available:true };
            message._show_translation = true;
          })
          .catch((error) => {
            message._show_translation = false;
            if (!message._auto_translation_requested) showError(error);
          })
          .finally(() => {
            message._translation_loading = false;
            translationPending.delete(message.id);
            translationActive -= 1;
            replaceMessage(message);
            runTranslationQueue();
          });
        translationPending.set(message.id, pending);
      }
    }

    function requestTranslation(message, automatic = false){
      if (!message?.translation?.available) return;
      if (message.translation.cached_text) {
        message._show_translation = true;
        replaceMessage(message);
        return;
      }
      if (translationPending.has(message.id) || translationQueue.some((item) => item.id === message.id)) return;
      message._auto_translation_requested = automatic;
      translationQueue.push(message);
      runTranslationQueue();
    }

    let profilePanel = null;
    const profileWidthObserver = root.ResizeObserver ? new ResizeObserver(() => shell.classList.toggle('fm-ch-profile-narrow', shell.clientWidth <= 680)) : null;
    profileWidthObserver?.observe(shell);
    const profileSummary = user => `${avatarHtml(user)}<div><strong>${esc(user.name || 'Team member')}</strong>${user.title ? `<span>${esc(user.title)}</span>` : ''}${user.pronouns ? `<small>${esc(user.pronouns)}</small>` : ''}</div>`;
    async function messageProfile(user, button){
      button.disabled = true;
      try {
        const data = await api.channels.create(orgId, {type:'dm', member_user_ids:[user.id]});
        closePopover(); closeProfilePanel(); await loadChannels(); await setChannel(data.channel.id);
      } catch (error) { button.disabled = false; showError(error); }
    }
    function closeProfilePanel({silent = false} = {}){
      if (!silent && root.Portal?.navigation?.read?.().channelProfile) {
        const result = root.Portal.navigation.backOrClose(['channelProfile'], {channelProfile:null,channelProfileChannel:null});
        if (result?.backed) return;
      }
      profilePanel?.remove(); profilePanel = null;
    }
    function showFullProfile(user, {silent = false} = {}){
      closePopover(); profilePanel?.remove();
      const panel = el('aside', 'fm-ch-profile-panel'); panel.dataset.userId = user.id; profilePanel = panel;
      panel.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_489a5044534481","Member profile") ?? "Member profile"));
      panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeProfilePanel(); } });
      const header = el('div', 'fm-ch-profile-panel-head', `<strong>${(globalThis.PlatformLanguage?.text("channels-ui","m_6f5dea53bf13f4","Profile") ?? "Profile")}</strong>`);
      const close = el('button', 'fm-ch-icon-btn', '<i class="fas fa-xmark"></i>'); close.setAttribute('aria-label',(globalThis.PlatformLanguage?.text("channels-ui","m_c0934dcff7a79f","Close profile") ?? "Close profile")); close.onclick = () => closeProfilePanel(); header.append(close);
      const body = el('div', 'fm-ch-profile-panel-body'); panel.append(header,body); shell.append(panel);
      const render = person => {
        body.innerHTML = `<div class="fm-ch-profile-hero">${profileSummary(person)}</div>`;
        if (person.id !== currentUser.id && !person.disabled) {
          const message = el('button','fm-ch-btn primary','<i class="fas fa-comment"></i> Message'); message.onclick = () => messageProfile(person,message); body.append(message);
        }
        const details = el('dl','fm-ch-profile-details');
        for (const [label,value,link] of [['Email',person.email,person.email ? `mailto:${person.email}` : ''],['Phone',person.phone,person.phone ? `tel:${person.phone}` : ''],['Department',person.department],['Location',person.location],['Time zone',person.time_zone]]) {
          if (!value) continue;
          details.append(el('dt','',esc(label)),el('dd','',link ? `<a href="${esc(link)}">${esc(value)}</a>` : esc(value)));
        }
        if (details.childElementCount) body.append(details);
        if (person.bio) body.append(el('h3','','About'),el('p','fm-ch-profile-about',esc(person.bio)));
        if (!details.childElementCount && !person.bio) body.append(el('p','fm-ch-profile-empty','No additional profile details have been shared.'));
      };
      render(user); close.focus();
      api.directory?.list(orgId).then(data => { if (panel.isConnected) render({...user,...data?.users?.find(person => person.id === user.id)}); }).catch(() => {});
      if (!silent && !root.Portal?.navigation?.applying) root.Portal?.navigation?.push?.({channelProfile:user.id,channelProfileChannel:state.activeChannelId}, {ownedKeys:['channelProfile']});
    }
    function openUserProfile(author, anchor){
      if (!author?.id) return;
      const pop = showPopover(anchor, node => {
        node.setAttribute('role','dialog'); node.setAttribute('aria-label',((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_6a58adc10a30f7",`${v0} profile`,{v0}) ?? `${v0} profile`)(author.name || 'User')); node.classList.add('fm-ch-profile-card');
      });
      const render = user => {
        pop.innerHTML = `<div class="fm-ch-profile-summary">${profileSummary(user)}</div>${user.email ? `<a class="fm-ch-profile-email" href="mailto:${esc(user.email)}">${esc(user.email)}</a>` : ''}`;
        const actions = el('div','fm-ch-profile-actions');
        if (user.id !== currentUser.id && !user.disabled) {
          const message = el('button','fm-ch-btn primary','Message'); message.onclick = () => messageProfile(user,message); actions.append(message);
        }
        const full = el('button','fm-ch-btn','View profile'); full.onclick = () => showFullProfile(user); actions.append(full); pop.append(actions);
        const close = el('button','fm-ch-profile-close','<i class="fas fa-xmark"></i>'); close.setAttribute('aria-label',(globalThis.PlatformLanguage?.text("channels-ui","m_3742924668fb10","Close") ?? "Close")); close.onclick = closePopover; pop.append(close);
        const rect = anchor.getBoundingClientRect(), bounds = pop.getBoundingClientRect();
        pop.style.top = `${Math.max(8,rect.bottom + bounds.height + 6 <= innerHeight - 8 ? rect.bottom + 6 : rect.top - bounds.height - 6)}px`;
        pop.style.left = `${Math.max(8,Math.min(rect.left,innerWidth - bounds.width - 8))}px`;
      };
      render(author);
      api.directory?.list(orgId).then(data => { if (pop.isConnected) render({...author,...data?.users?.find(user => user.id === author.id)}); }).catch(() => {});
      pop.addEventListener('keydown', event => { if (event.key === 'Escape') { closePopover(); anchor.focus(); } }); pop.tabIndex = -1; pop.focus();
    }

    function messageRow(message, { inThread } = {}){
      const row = el('div', 'fm-ch-msg');
      row.tabIndex = 0;
      row.dataset.messageId = message.id;
      const gutter = el('div', 'fm-ch-msg-gutter');
      const content = el('div', 'fm-ch-msg-content');
      row.append(gutter, content);

      if (message.deleted_at) {
        gutter.innerHTML = '';
        const tomb = el('div', 'fm-ch-msg-deleted');
        tomb.innerHTML = `<span>${(globalThis.PlatformLanguage?.text("channels-ui","m_98170a72aa7e52","Message removed") ?? "Message removed")}</span>${String(message.can_restore && features.deleteRestore ? '<button class="fm-ch-restore-link" data-act="restore">Restore</button>' : '')}`;
        content.appendChild(tomb);
        wireRowActions(row, message);
        return row;
      }

      const avatarButton = el('button', 'fm-ch-profile-trigger', avatarHtml(message.author));
      avatarButton.type = 'button'; avatarButton.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_b49557609481cb",`View ${v0} profile`,{v0}) ?? `View ${v0} profile`)(message.author?.name || 'user'));
      avatarButton.addEventListener('click', () => openUserProfile(message.author, avatarButton));
      gutter.append(avatarButton);
      const audience = audienceLabel(message.audience);
      const translation = message.translation || {};
      const translatedText = translation.cached_text;
      const shouldShowTranslation = translation.available && (message._show_translation === true || (message._show_translation !== false && translation.auto_translate && translatedText));
      if (translation.auto_translate && translation.available && !translatedText && !message._auto_translation_requested) {
        message._auto_translation_requested = true;
        queueMicrotask(() => requestTranslation(message, true));
      }
      const head = el('div', 'fm-ch-msg-head', `
        <button type="button" class="fm-ch-msg-author fm-ch-profile-trigger">${esc(message.author?.name || 'Unknown')}</button>
        <span class="fm-ch-msg-time">${esc(fmtTime(message.created_at))}</span>
        ${message.edited_at && features.editHistory ? `<a class="fm-ch-msg-edited" data-act="history">${(globalThis.PlatformLanguage?.text("channels-ui","m_cd7e9c529b0a41","(edited)") ?? "(edited)")}</a>` : (message.edited_at ? `<span class="fm-ch-msg-edited">${(globalThis.PlatformLanguage?.text("channels-ui","m_cd7e9c529b0a41","(edited)") ?? "(edited)")}</span>` : '')}
        ${(message.tags || []).map(tagChipHtml).join('')}
        ${audience ? `<span class="fm-ch-audience-note">${esc(audience)}</span>` : ''}
        ${translation.available ? `<button type="button" class="fm-ch-translate${shouldShowTranslation ? ' on' : ''}${message._translation_loading ? ' loading' : ''}" data-act="translate" title="${shouldShowTranslation ? 'Show original' : `Translate to ${esc(translationLabel(translation.target_language))}`}" aria-label="${shouldShowTranslation ? 'Show original message' : 'Translate message'}" aria-pressed="${shouldShowTranslation ? 'true' : 'false'}"><i class="fas ${message._translation_loading ? 'fa-circle-notch' : 'fa-language'}"></i></button>` : ''}
      `);
      head.querySelector('.fm-ch-msg-author').addEventListener('click', event => openUserProfile(message.author, event.currentTarget));
      const body = el('div', 'fm-ch-msg-body', renderBody(message, shouldShowTranslation ? translatedText : message.text));
      content.append(head, body);
      if (shouldShowTranslation) {
        content.appendChild(el('div', 'fm-ch-translation-note', `<i class="fas fa-language"></i> Translated from ${esc(translationLabel(translation.source_language))}`));
      }

      const attachments = message.attachments || [];
      if (attachments.length) {
        const wrap = el('div', 'fm-ch-attachments');
        const audioNote = message.metadata?.audio_note;
        let audioRendered = false;
        for (const attachment of attachments) {
          const fileUrl = api.mediaFileUrl(orgId, attachment.media_id);
          if (!audioRendered && audioNote && String(attachment.content_type || '').startsWith('audio/') && root.FirstMateAudioNotes?.createPlayer) {
            wrap.appendChild(root.FirstMateAudioNotes.createPlayer({
              url:fileUrl,
              duration:Number(audioNote.duration_seconds) || 0,
              peaks:Array.isArray(audioNote.peaks) ? audioNote.peaks : []
            }));
            audioRendered = true;
            continue;
          }
          if (String(attachment.content_type || '').startsWith('image/')) {
            wrap.appendChild(el('a', '', `<img class="fm-ch-attachment-img" src="${esc(fileUrl)}" alt="${esc(attachment.file_name)}">`)).href = fileUrl;
            wrap.lastChild.target = '_blank';
          } else if (String(attachment.content_type || '').startsWith('video/')) {
            const video = document.createElement('video');
            video.className = 'fm-ch-attachment-img';
            video.src = fileUrl;
            video.controls = true;
            video.preload = 'metadata';
            wrap.appendChild(video);
          } else {
            const link = el('a', 'fm-ch-attachment', `<i class="fas fa-paperclip"></i> <span>${esc(attachment.file_name || 'attachment')}</span>`);
            link.href = fileUrl;
            link.target = '_blank';
            wrap.appendChild(link);
          }
        }
        content.appendChild(wrap);
      }
      if (message.metadata?.resource_ref) {
        const ref = message.metadata.resource_ref;
        const card = el('div', 'fm-ch-resource');
        card.innerHTML = `<span class="fm-ch-resource-icon"><i class="fas ${resourceIcon(cleanText(ref.resource_type))}"></i></span><span class="fm-ch-resource-copy"><strong>${esc(ref.label || 'Shared resource')}</strong><span>${esc(ref.resource_type || '')}</span></span>`;
        content.appendChild(card);
      }

      if (features.reactions && (message.reactions || []).length) {
        const wrap = el('div', 'fm-ch-reactions');
        for (const reaction of message.reactions) {
          const chip = el('button', `fm-ch-reaction${reaction.reacted ? ' mine' : ''}`, `${esc(reaction.emoji)} ${reaction.count}`);
          chip.title = (globalThis.PlatformLanguage?.text("channels-ui","m_29b8fde38dbb7a","Toggle reaction") ?? "Toggle reaction");
          chip.addEventListener('click', () => api.messages.react(orgId, message.id, reaction.emoji, !reaction.reacted).then((data) => replaceMessage(data.message)).catch(showError));
          wrap.appendChild(chip);
        }
        content.appendChild(wrap);
      }

      if (features.threads && !inThread && message.reply_count > 0) {
        const link = el('button', 'fm-ch-thread-link', `<i class="fas fa-comment-dots"></i> ${message.reply_count} ${message.reply_count === 1 ? 'reply' : 'replies'}`);
        link.addEventListener('click', () => openThread(message.id));
        content.appendChild(link);
      }

      // hover toolbar
      const toolbar = el('div', 'fm-ch-toolbar');
      const tools = [];
      if (features.reactions) tools.push({ act: 'react', icon: '<i class="fas fa-face-smile"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_b9ef31beb43d75","Add reaction") ?? "Add reaction") });
      if (features.threads && !inThread) tools.push({ act: 'thread', icon: '<i class="fas fa-comment-dots"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_2630a6ec2a8192","Reply in thread") ?? "Reply in thread") });
      if (features.threads && !inThread) tools.push({ act: 'follow', icon: '<i class="fas fa-bell"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_3ea2ab183fad0b","Follow thread") ?? "Follow thread") });
      if (features.saved) tools.push({ act: 'save', icon: '<i class="fas fa-bookmark"></i>', title: message.is_saved ? 'Remove from saved' : 'Save for later', on: message.is_saved });
      if (features.richMessages) tools.push({ act: 'remind', icon: '<i class="fas fa-clock"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_a3718df1119c03","Remind me about this") ?? "Remind me about this") });
      if (features.richMessages) tools.push({ act: 'forward', icon: '<i class="fas fa-share"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_2ac9359a61d42d","Forward message") ?? "Forward message") });
      tools.push({ act: 'copy-link', icon: '<i class="fas fa-link"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_c84df5383df857","Copy message link") ?? "Copy message link") });
      tools.push({ act: 'todo', icon: '<i class="fas fa-square-check"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_ffae27506c46f3","Create To Do") ?? "Create To Do") });
      tools.push({ act: 'unread', icon: '<i class="fas fa-envelope"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_5d57431152ad0a","Mark unread from here") ?? "Mark unread from here") });
      if (features.pins) tools.push({ act: 'pin', icon: '<i class="fas fa-thumbtack"></i>', title: message.pinned_at ? 'Unpin' : 'Pin to channel', on: !!message.pinned_at });
      if (message.can_edit) tools.push({ act: 'edit', icon: '<i class="fas fa-pen"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_b5c26cfdc21ae1","Edit message") ?? "Edit message") });
      if (message.can_delete && features.deleteRestore) tools.push({ act: 'delete', icon: '<i class="fas fa-trash"></i>', title: (globalThis.PlatformLanguage?.text("channels-ui","m_6d961bac26bd8e","Remove message") ?? "Remove message"), danger: true });
      const primary = tools.filter(tool => ['react', 'thread', 'save'].includes(tool.act));
      const overflow = tools.filter(tool => !primary.includes(tool));
      for (const tool of primary) {
        toolbar.insertAdjacentHTML('beforeend', `<button data-act="${tool.act}" title="${esc(tool.title)}" aria-label="${esc(tool.title)}" class="${tool.on ? 'on' : ''}">${tool.icon}</button>`);
      }
      if (overflow.length) {
        const more = el('button', '', '<i class="fas fa-ellipsis"></i>');
        more.title = (globalThis.PlatformLanguage?.text("channels-ui","m_0092f30ae15099","More message actions") ?? "More message actions"); more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
        more.onclick = event => {
          event.stopPropagation();
          const pop = showPopover(more, pop => {
            pop.classList.add('fm-ch-message-menu'); pop.setAttribute('role', 'menu');
            for (const tool of overflow) {
              const item = el('button', tool.danger ? 'danger' : '', tool.icon + `<span>${esc(tool.title)}</span>`);
              item.setAttribute('role', 'menuitem'); item.dataset.act = tool.act;
              pop.append(item);
            }
            wireRowActions(pop, message, { inThread });
            pop.addEventListener('click', () => { closePopover(); more.focus(); });
            pop.addEventListener('keydown', event => {
              const items = [...pop.querySelectorAll('button')];
              const index = items.indexOf(document.activeElement);
              if (event.key === 'Escape') { closePopover(); more.focus(); }
              if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
            });
          });
          pop.querySelector('button')?.focus();
        };
        toolbar.append(more);
      }
      if (tools.length) row.appendChild(toolbar);
      wireRowActions(row, message, { inThread });
      return row;
    }

    function wireRowActions(row, message, { inThread } = {}){
      row.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-act]');
        if (!target || !row.contains(target)) return;
        const act = target.dataset.act;
        try {
          if (act === 'restore') replaceMessage((await api.messages.restore(orgId, message.id)).message);
          else if (act === 'react') openEmojiPicker(target, (emoji) => api.messages.react(orgId, message.id, emoji, true).then((data) => replaceMessage(data.message)).catch(showError));
          else if (act === 'thread') openThread(message.id);
          else if (act === 'follow') {
            await api.threads.subscribe(orgId, message.parent_id || message.id, true);
            target.classList.add('on');
            target.title = (globalThis.PlatformLanguage?.text("channels-ui","m_85514549901d20","Following thread") ?? "Following thread");
          }
          else if (act === 'save') {
            if (message.is_saved) await api.saved.remove(orgId, message.id);
            else await api.saved.add(orgId, message.id);
            message.is_saved = !message.is_saved;
            replaceMessage(message);
          }
          else if (act === 'pin') replaceMessage((message.pinned_at ? await api.messages.unpin(orgId, message.id) : await api.messages.pin(orgId, message.id)).message);
          else if (act === 'unread') {
            await api.readState.markUnread(orgId, message.channel_id, message.seq);
            await loadChannels();
          }
          else if (act === 'todo') openCreateTodoModal(message);
          else if (act === 'remind') openReminderModal(message);
          else if (act === 'forward') openForwardModal(message);
          else if (act === 'copy-link') {
            const base = String(root.location.href).split(/[?#]/)[0];
            const query = `tab=channels&channel=${encodeURIComponent(message.channel_id)}&channelMessage=${encodeURIComponent(message.id)}`;
            await navigator.clipboard.writeText(`${base}?${query}`);
            root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("channels-ui","m_886008ad2522eb","Message link copied") ?? "Message link copied"), '', true);
          }
          else if (act === 'edit') startEdit(message, { inThread });
          else if (act === 'delete') {
            replaceMessage((await api.messages.remove(orgId, message.id)).message);
          }
          else if (act === 'history') openHistoryPopover(target, message);
          else if (act === 'translate') {
            if (message._show_translation === true || (message._show_translation !== false && message.translation?.auto_translate && message.translation?.cached_text)) {
              message._show_translation = false;
              replaceMessage(message);
            } else if (message.translation?.cached_text) {
              message._show_translation = true;
              replaceMessage(message);
            } else {
              requestTranslation(message, false);
              replaceMessage(message);
            }
          }
        } catch (error) {
          showError(error);
        }
      });
    }

    function replaceMessage(message){
      if (!message) return;
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        state.messages[index] = message;
        renderMessages();
      }
      if (state.thread) {
        if (state.thread.root?.id === message.id) state.thread.root = message;
        const replyIndex = state.thread.replies.findIndex((item) => item.id === message.id);
        if (replyIndex >= 0) state.thread.replies[replyIndex] = message;
        renderPanel();
      }
    }

    function renderMessages(scrollOptions = {}){
      if (state.view !== 'channel' || state.activeTab !== 'messages') return;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.innerHTML = '';
      if (!state.messages.length) {
        list.innerHTML = `<div class="fm-ch-empty">${esc(options.emptyStateText || 'No messages yet. Say something!')}</div>`;
        return;
      }
      let lastDay = '';
      let dividerPlaced = false;
      for (const message of state.messages) {
        const day = dayKey(message.created_at);
        if (day !== lastDay) {
          list.appendChild(el('div', 'fm-ch-day', esc(fmtDay(message.created_at))));
          lastDay = day;
        }
        if (!dividerPlaced && state.unreadDividerSeq > 0 && message.seq > state.unreadDividerSeq && message.author?.id !== currentUser.id) {
          list.appendChild(el('div', 'fm-ch-new-divider', 'New'));
          dividerPlaced = true;
        }
        list.appendChild(messageRow(message));
      }
      if (scrollOptions.keepScroll && scrollOptions.prevHeight) {
        list.scrollTop = list.scrollHeight - scrollOptions.prevHeight;
      } else if (nearBottom || !scrollOptions.keepScroll) {
        list.scrollTop = list.scrollHeight;
      }
    }

    list.addEventListener('scroll', debounce(() => {
      if (list.scrollTop < 40 && state.view === 'channel') loadOlder();
    }, 200));

    function renderTyping(){
      const now = Date.now();
      const names = [...state.typing.values()].filter((entry) => entry.expires > now).map((entry) => entry.name);
      typingBar.textContent = !features.typing || !names.length
        ? ''
        : names.length === 1 ? `${names[0]} is typing…` : `${names.slice(0, 2).join(' and ')}${names.length > 2 ? ' and others' : ''} are typing…`;
    }

    function revealMessage(messageId){
      state.revealTarget = '';
      const row = list.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('highlight');
        setTimeout(() => row.classList.remove('highlight'), 2600);
        return true;
      }
      // Might live in a thread — try opening its thread root.
      api.messages.get(orgId, messageId).then((data) => {
        const message = data.message;
        if (message?.parent_id) openThread(message.parent_id);
      }).catch(() => {});
      return false;
    }

    // --- edit history popover --------------------------------------------------------

    async function openHistoryPopover(anchor, message){
      try {
        const data = await api.messages.revisions(orgId, message.id);
        showPopover(anchor, (pop) => {
          pop.appendChild(el('div', 'fm-ch-popover-head', 'Edit history'));
          const current = el('div', 'fm-ch-revision current');
          current.append(
            el('div', 'fm-ch-revision-meta', `Current · ${esc(fmtDateTime(data.current.edited_at || data.current.created_at))}`),
            el('div', '', esc(data.current.text).replace(/\n/g, '<br>'))
          );
          pop.appendChild(current);
          for (const revision of data.revisions || []) {
            const node = el('div', 'fm-ch-revision');
            node.append(
              el('div', 'fm-ch-revision-meta', `${esc(revision.edited_by_user?.name || 'Unknown')} · ${esc(fmtDateTime(revision.edited_at))}`),
              el('div', '', esc(revision.text).replace(/\n/g, '<br>'))
            );
            pop.appendChild(node);
          }
        });
      } catch (error) {
        showError(error);
      }
    }

    // --- emoji picker ------------------------------------------------------------------

    function openEmojiPicker(anchor, onPick){
      showPopover(anchor, (pop) => {
        const search = el('input', 'fm-ch-emoji-search');
        search.type = 'text';
        search.placeholder = (globalThis.PlatformLanguage?.text("channels-ui","m_cd02d20f00360e","Search emoji…") ?? "Search emoji…");
        pop.appendChild(search);
        const holder = el('div');
        pop.appendChild(holder);
        const renderGroups = (filter) => {
          holder.innerHTML = '';
          for (const group of EMOJI_SET) {
            const items = filter ? group.items : group.items;
            if (!items.length) continue;
            if (!filter) holder.appendChild(el('div', 'fm-ch-emoji-group', esc(group.group)));
            const grid = el('div', 'fm-ch-emoji-grid');
            for (const emoji of items) {
              const button = el('button', '', emoji);
              button.addEventListener('click', () => { closePopover(); onPick(emoji); });
              grid.appendChild(button);
            }
            holder.appendChild(grid);
            if (filter) break; // single flat grid when filtering
          }
        };
        renderGroups('');
        search.addEventListener('input', () => renderGroups(cleanText(search.value)));
        setTimeout(() => search.focus(), 0);
      });
    }

    // --- composer ------------------------------------------------------------------------

    const composerState = {
      audience: [...(defaults.audience || [])],
      tags: [...(defaults.tags || [])]
    };

    let textarea = null;
    let mentionApi = null;

    function mentionMenuOpen(){
      return Boolean(document.getElementById('fmMentionMenu')?.classList.contains('visible'));
    }

    function collectMentions(text){
      const confirmed = mentionApi?.confirmedMentions?.() || textarea?.mentionUsers?.filter(user => text.includes(`@${user.name}`)) || [];
      if (Array.isArray(confirmed) && confirmed.length) {
        return confirmed.map((user) => ({
          id: cleanText(user.id || user.user_id),
          name: cleanText(user.name || user.label),
          email: cleanText(user.email).toLowerCase(),
          avatar: cleanText(user.avatar || '')
        })).filter((user) => user.id || user.email);
      }
      return [];
    }

    function bindRichMentions(editor, box){
      const button = el('button', '', '@'); button.type = 'button'; button.title = (globalThis.PlatformLanguage?.text("channels-ui","m_c5226e930e6ce6","Mention a teammate") ?? "Mention a teammate"); button.setAttribute('aria-label', button.title);
      button.onmousedown = event => event.preventDefault();
      button.onclick = async () => {
        const range = root.getSelection()?.rangeCount && editor.contains(root.getSelection().anchorNode) ? root.getSelection().getRangeAt(0).cloneRange() : null;
        try {
          const users = await orgUsers();
          showPopover(button, pop => {
            const search = el('input', 'fm-ch-emoji-search'); search.placeholder = (globalThis.PlatformLanguage?.text("channels-ui","m_2263d8ccee3221","Find a teammate…") ?? "Find a teammate…"); search.setAttribute('aria-label', search.placeholder);
            const results = el('div', 'fm-ch-message-menu'); pop.append(search, results);
            const render = () => {
              results.innerHTML = '';
              for (const user of users.filter(user => user.id !== currentUser.id && String(user.name).toLowerCase().includes(search.value.toLowerCase())).slice(0, 30)) {
                const item = el('button', '', esc(user.name)); item.onclick = () => {
                  editor.focus(); if (range) { root.getSelection().removeAllRanges(); root.getSelection().addRange(range); }
                  editor.insertText(`@${user.name} `);
                  if (!editor.mentionUsers.some(person => person.id === user.id)) editor.mentionUsers.push(user);
                  closePopover();
                }; results.append(item);
              }
            }; search.oninput = render; render(); search.focus();
          });
        } catch (error) { showError(error); }
      };
      box.querySelector('.fm-ch-formatbar')?.append(button);
    }

    function renderComposer(){
      composer.innerHTML = '';
      if (state.view !== 'channel' || state.activeTab !== 'messages' || !state.activeChannel) return;
      if (state.activeChannel.archived_at) {
        composer.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_14199c5517db0f","This channel is archived.") ?? "This channel is archived.")}</div>`;
        return;
      }
      const editNote = el('div', 'fm-ch-edit-note');
      editNote.style.display = 'none';
      const box = el('div', 'fm-ch-composer-box');
      const audioMount = el('div', 'fm-ch-audio-mount');
      textarea = createMessageEditor(cleanText(options.composerPlaceholder)
        || (state.activeChannel.type === 'project' ? 'Add a note…' : `Message ${state.activeChannel.display_name || '#' + state.activeChannel.name}`));
      if (features.richMessages) box.appendChild(messageFormatBar(textarea));
      box.appendChild(textarea);
      bindRichMentions(textarea, box);

      const row = el('div', 'fm-ch-composer-row');
      const pendingWrap = el('div', 'fm-ch-pending-files');

      // audience chips (project surfaces)
      if (features.audienceSelector && state.activeChannel.type === 'project') {
        for (const group of AUDIENCE_GROUPS) {
          const chip = el('button', `fm-ch-chip${composerState.audience.includes(group.id) ? ' on' : ''}`, esc(group.label));
          chip.title = (globalThis.PlatformLanguage?.text("channels-ui","m_1e8712c5d8783c","Who can see this message") ?? "Who can see this message");
          chip.addEventListener('click', () => {
            const index = composerState.audience.indexOf(group.id);
            if (index >= 0) composerState.audience.splice(index, 1);
            else composerState.audience.push(group.id);
            chip.classList.toggle('on');
          });
          row.appendChild(chip);
        }
      }

      // tag chips
      for (const tag of (features.tagOptions || [])) {
        const chip = el('button', `fm-ch-chip${composerState.tags.includes(tag.id) ? ' on' : ''}`, esc(tag.label));
        chip.addEventListener('click', () => {
          const index = composerState.tags.indexOf(tag.id);
          if (index >= 0) composerState.tags.splice(index, 1);
          else composerState.tags.push(tag.id);
          chip.classList.toggle('on');
        });
        row.appendChild(chip);
      }

      const emojiBtn = el('button', 'fm-ch-icon-btn', '<i class="fas fa-face-smile"></i>');
      emojiBtn.title = (globalThis.PlatformLanguage?.text("channels-ui","m_1832447bbc385c","Insert emoji") ?? "Insert emoji");
      emojiBtn.addEventListener('click', () => openEmojiPicker(emojiBtn, (emoji) => {
        textarea.insertText(emoji);
        textarea.focus();
      }));
      row.appendChild(emojiBtn);

      if (features.attachments) {
        const fileBtn = el('button', 'fm-ch-icon-btn', '<i class="fas fa-paperclip"></i>');
        fileBtn.title = (globalThis.PlatformLanguage?.text("channels-ui","m_281fbe3da74b11","Attach a file") ?? "Attach a file");
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          for (const file of fileInput.files || []) {
            const chip = el('span', 'fm-ch-chip', `<i class="fas fa-circle-notch fa-spin"></i> ${esc(file.name)}`);
            pendingWrap.appendChild(chip);
            try {
              const data = await api.uploads.send(orgId, file, state.activeChannelId);
              state.pendingAttachments.push(data.attachment);
              chip.innerHTML = `<i class="fas fa-paperclip"></i> ${String(esc(file.name))} <button title="${(globalThis.PlatformLanguage?.text("channels-ui","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`;
              chip.querySelector('button').addEventListener('click', () => {
                state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== data.attachment.id);
                chip.remove();
              });
            } catch (error) {
              chip.remove();
              showError(error);
            }
          }
          fileInput.value = '';
        });
        row.append(fileBtn, fileInput);
      }

      if (features.audioNotes && root.FirstMateAudioNotes?.prepareInline) {
        const audioBtn = el('button', 'fm-ch-icon-btn', '<i class="fas fa-microphone"></i>');
        audioBtn.title = (globalThis.PlatformLanguage?.text("channels-ui","m_eb0aa857e4778b","Record an audio note") ?? "Record an audio note");
        audioBtn.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_eb0aa857e4778b","Record an audio note") ?? "Record an audio note"));
        audioBtn.addEventListener('click', async () => {
          if (audioBtn.disabled || state.pendingAudioNote || state.editingMessageId) return;
          audioBtn.disabled = true;
          let attachmentId = '';
          const removeAudio = () => {
            if (attachmentId) state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== attachmentId);
            state.pendingAudioNote = null;
            attachmentId = '';
            audioBtn.disabled = false;
          };
          try {
            const prepared = await root.FirstMateAudioNotes.prepareInline(orgId, state.activeChannelId, {
              mount:audioMount,
              onRemove:removeAudio
            });
            attachmentId = prepared.attachment.id;
            state.pendingAudioNote = prepared.metadata;
            state.pendingAttachments.push(prepared.attachment);
            textarea.value = prepared.text;
            textarea.dispatchEvent(new Event('input', { bubbles:true }));
          } catch (error) {
            if (!String(error?.message || '').toLowerCase().includes('cancelled')) showError(error);
            if (!state.pendingAudioNote) audioBtn.disabled = false;
          }
        });
        row.appendChild(audioBtn);
      }

      if (features.resources) {
        const resourceBtn = el('button', 'fm-ch-icon-btn', '<i class="fas fa-folder-open"></i>');
        resourceBtn.title = (globalThis.PlatformLanguage?.text("channels-ui","m_bfd557857ade7c","Share a project or channel resource") ?? "Share a project or channel resource");
        resourceBtn.addEventListener('click', openResourcePickerModal);
        row.appendChild(resourceBtn);
      }

      if (features.clips && features.attachments && root.MediaRecorder && navigator.mediaDevices) {
        const addClipAttachment = (attachment) => {
          state.pendingAttachments.push(attachment);
          const chip = el('span', 'fm-ch-chip', `<i class="fas fa-video"></i> ${String(esc(attachment.file_name || 'Clip'))} <button title="${(globalThis.PlatformLanguage?.text("channels-ui","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`);
          chip.querySelector('button').addEventListener('click', () => {
            state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== attachment.id);
            chip.remove();
          });
          pendingWrap.appendChild(chip);
        };
        const videoClip = el('button', 'fm-ch-icon-btn', '<i class="fas fa-video"></i>');
        videoClip.title = (globalThis.PlatformLanguage?.text("channels-ui","m_f9d80bb65553c0","Record video clip") ?? "Record video clip");
        videoClip.addEventListener('click', () => recordClip('camera', addClipAttachment).catch(showError));
        const screenClip = el('button', 'fm-ch-icon-btn', '<i class="fas fa-display"></i>');
        screenClip.title = (globalThis.PlatformLanguage?.text("channels-ui","m_be0922566fcacc","Record screen clip") ?? "Record screen clip");
        screenClip.addEventListener('click', () => recordClip('screen', addClipAttachment).catch(showError));
        row.append(videoClip, screenClip);
      }

      const schedule = features.richMessages ? el('button', 'fm-ch-icon-btn', '<i class="fas fa-clock"></i>') : null;
      if (schedule) {
        schedule.title = (globalThis.PlatformLanguage?.text("channels-ui","m_dc866baaa05168","Schedule message") ?? "Schedule message");
        schedule.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_dc866baaa05168","Schedule message") ?? "Schedule message"));
      }
      const send = el('button', 'fm-ch-send', 'Send');
      const sendPair = el('div', 'fm-ch-send-pair');
      if (schedule) sendPair.appendChild(schedule);
      sendPair.appendChild(send);
      row.appendChild(sendPair);
      composer.append(editNote, box, audioMount, pendingWrap, row);

      const autosize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`;
      };
      textarea.addEventListener('input', autosize);
      const draftKey = `channel:${state.activeChannelId}`;
      const saveDraft = debounce(() => {
        if (state.editingMessageId) return;
        const value = textarea.value;
        if (!value.trim() && !state.pendingAttachments.length) {
          api.drafts?.remove?.(orgId, draftKey).catch(() => {});
          return;
        }
        api.drafts?.save?.(orgId, draftKey, {
          channel_id:state.activeChannelId,
          text:value,
          content:{ type:'doc', blocks:[{ type:'paragraph', text:value }] },
          attachment_ids:state.pendingAttachments.map((attachment) => attachment.id)
        }).catch(() => {});
      }, 450);
      if (features.richMessages) textarea.addEventListener('input', saveDraft);
      if (features.richMessages) api.drafts?.get?.(orgId, draftKey).then((data) => {
        if (!textarea.value && data?.draft?.text && state.activeChannelId === data.draft.channel_id) {
          textarea.value = data.draft.text;
          autosize();
        }
      }).catch(() => {});

      // mention autocomplete via the shared tags library
      mentionApi = null;
      try {
        if (root.FirstMateTags?.attachMentionTextarea && textarea?.tagName === 'TEXTAREA') {
          mentionApi = root.FirstMateTags.attachMentionTextarea(textarea, { orgId, source: 'channels' }) || null;
        }
      } catch (error) {}

      const notifyTyping = debounce(() => {
        if (features.typing && textarea.value.trim()) api.typing.note(orgId, state.activeChannelId).catch(() => {});
      }, 1200);
      textarea.addEventListener('input', notifyTyping);

      const doSend = async () => {
        const text = textarea.value.trim();
        if (!text && !state.pendingAttachments.length) return;
        send.disabled = true;
        try {
          if (state.editingMessageId && !state.editingThread) {
            const data = await api.messages.edit(orgId, state.editingMessageId, {
              text,
              mention_users: collectMentions(text),
              ...(features.audienceSelector && state.activeChannel.type === 'project' ? { audience: composerState.audience } : {})
            });
            replaceMessage(data.message);
            cancelEdit();
          } else {
            const clientMsgId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            const data = await api.messages.post(orgId, state.activeChannelId, {
              text: text || '(attachment)',
              content:{ type:'doc', blocks:[{ type:'paragraph', text:text || '' }] },
              content_schema_version:1,
              client_msg_id: clientMsgId,
              mention_users: collectMentions(text),
              attachment_ids: state.pendingAttachments.map((attachment) => attachment.id),
              ...(state.pendingAudioNote ? { metadata:{ audio_note:state.pendingAudioNote } } : {}),
              ...(features.audienceSelector && state.activeChannel.type === 'project' ? { audience: composerState.audience } : {}),
              ...(composerState.tags.length ? { tags: composerState.tags } : {})
            });
            if (!state.messages.some((item) => item.id === data.message.id)) state.messages.push(data.message);
            state.pendingAttachments = [];
            state.pendingAudioNote = null;
            audioMount.innerHTML = '';
            pendingWrap.innerHTML = '';
            if (features.richMessages) api.drafts?.remove?.(orgId, draftKey).catch(() => {});
            renderMessages();
            scheduleMarkRead();
          }
          textarea.value = '';
          autosize();
          mentionApi?.setSelectedMentions?.([]);
        } catch (error) {
          showError(error);
        } finally {
          send.disabled = false;
          textarea.focus();
        }
      };
      send.addEventListener('click', doSend);
      schedule?.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (!text && !state.pendingAttachments.length) return;
        showModal('Schedule message', (body) => {
          const defaultDate = new Date(Date.now() + 60 * 60_000);
          defaultDate.setMinutes(Math.ceil(defaultDate.getMinutes() / 15) * 15, 0, 0);
          body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_3d9611987867da","Send at") ?? "Send at")}</label><input type="datetime-local" data-field="scheduled" value="${String(new Date(defaultDate.getTime() - defaultDate.getTimezoneOffset() * 60000).toISOString().slice(0,16))}">`;
        }, [{ label:(globalThis.PlatformLanguage?.text("channels-ui","m_fc05a804bd034c","Schedule") ?? "Schedule"), primary:true, onClick:async (close, body) => {
          try {
            const date = new Date(body.querySelector('[data-field=scheduled]')?.value);
            if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Choose a future date and time.');
            await api.scheduled.create(orgId, {
              channel_id:state.activeChannelId,
              text,
              content:{ type:'doc', blocks:[{ type:'paragraph', text }] },
              attachment_ids:state.pendingAttachments.map((attachment) => attachment.id),
              scheduled_at:date.toISOString(),
              timezone:Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || 'UTC',
              client_operation_id:`schedule_${Date.now().toString(36)}`
            });
            textarea.value = '';
            state.pendingAttachments = [];
            pendingWrap.innerHTML = '';
            api.drafts?.remove?.(orgId, draftKey).catch(() => {});
            close();
            root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("channels-ui","m_adcf3157ee531f","Message scheduled") ?? "Message scheduled"), ((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_030b85747ce9b2",`It will send ${v0}.`,{v0}) ?? `It will send ${v0}.`)(date.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())), true);
          } catch (error) { showError(error); }
        } }]);
      });
      textarea.addEventListener('keydown', (event) => {
        const modifiedSend = state.collaborationPreferences.send_mode === 'modified_enter';
        const sendKey = event.key === 'Enter'
          && !event.shiftKey
          && !event.isComposing
          && !mentionMenuOpen()
          && (modifiedSend ? (event.ctrlKey || event.metaKey) : !(event.ctrlKey || event.metaKey));
        if (sendKey) {
          event.preventDefault();
          doSend();
        }
        if (event.key === 'Escape' && state.editingMessageId) cancelEdit();
      });

      function cancelEdit(){
        state.editingMessageId = '';
        editNote.style.display = 'none';
        textarea.value = '';
        autosize();
      }

      composer._startEdit = (message) => {
        state.editingMessageId = message.id;
        state.editingThread = false;
        editNote.style.display = 'flex';
        editNote.innerHTML = `<span>${(globalThis.PlatformLanguage?.text("channels-ui","m_6a6c0d2dcfcb47","Editing message") ?? "Editing message")}</span><button>${(globalThis.PlatformLanguage?.text("channels-ui","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>`;
        editNote.querySelector('button').addEventListener('click', cancelEdit);
        textarea.value = message.text;
        composerState.audience = [...(message.audience || [])];
        autosize();
        textarea.focus();
      };
    }

    function startEdit(message, { inThread } = {}){
      if (inThread && state.thread) {
        panel._startEdit?.(message);
        return;
      }
      composer._startEdit?.(message);
    }

    // --- side panel: thread / pins ----------------------------------------------------

    async function openThread(rootId, { silent } = {}){
      if (!features.threads) return;
      try {
        const data = await api.messages.thread(orgId, rootId);
        state.threadRootId = rootId;
        state.thread = { root: data.root, replies: data.replies || [] };
        renderPanel({ scrollToEnd: !silent });
        const lastReplySeq = Math.max(0, ...(state.thread.replies || []).map((reply) => Number(reply.seq) || 0));
        api.threads.markRead?.(orgId, rootId, lastReplySeq).catch(() => {});
        if (!silent) options.onNavigate?.({ channel: state.activeChannelId, thread: rootId });
      } catch (error) {
        showError(error);
      }
    }

    function closePanel(){
      state.threadRootId = '';
      state.thread = null;
      state.panelMode = '';
      renderPanel();
      options.onNavigate?.({ channel: state.activeChannelId, thread: '' });
    }

    async function openPinsPanel(){
      try {
        const data = await api.pins.list(orgId, state.activeChannelId);
        state.panelMode = 'pins';
        state.pinned = data.messages || [];
        state.threadRootId = '';
        state.thread = null;
        renderPanel();
      } catch (error) {
        showError(error);
      }
    }

    function renderPanel(panelOptions = {}){
      if (state.thread) {
        panel.style.display = 'flex';
        panel.innerHTML = '';
        const head = el('div', 'fm-ch-panel-head', `<span>${(globalThis.PlatformLanguage?.text("channels-ui","m_13f4d69b6c2991","Thread") ?? "Thread")}</span>`);
        const close = el('button', 'fm-ch-icon-btn', '<i class="fas fa-xmark"></i>');
        close.addEventListener('click', closePanel);
        head.appendChild(close);
        const body = el('div', 'fm-ch-panel-body');
        body.appendChild(messageRow(state.thread.root, { inThread: true }));
        if (state.thread.replies.length) {
          body.appendChild(el('div', 'fm-ch-day', `${state.thread.replies.length} ${state.thread.replies.length === 1 ? 'reply' : 'replies'}`));
        }
        for (const reply of state.thread.replies) body.appendChild(messageRow(reply, { inThread: true }));
        const threadComposer = el('div', 'fm-ch-composer');
        buildThreadComposer(threadComposer);
        panel.append(head, body, threadComposer);
        if (panelOptions.scrollToEnd !== false) body.scrollTop = body.scrollHeight;
        return;
      }
      if (state.panelMode === 'pins') {
        panel.style.display = 'flex';
        panel.innerHTML = '';
        const head = el('div', 'fm-ch-panel-head', `<span><i class="fas fa-thumbtack"></i>${(globalThis.PlatformLanguage?.text("channels-ui","m_55feed3cbfa4d3"," Pinned") ?? " Pinned")}</span>`);
        const close = el('button', 'fm-ch-icon-btn', '<i class="fas fa-xmark"></i>');
        close.addEventListener('click', closePanel);
        head.appendChild(close);
        const body = el('div', 'fm-ch-panel-body');
        if (!state.pinned?.length) body.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_e630876ee9eca9","Nothing pinned yet.") ?? "Nothing pinned yet.")}</div>`;
        for (const message of state.pinned || []) {
          const result = el('div', 'fm-ch-result');
          result.innerHTML = `<div class="fm-ch-result-meta">${esc(message.author?.name || '')} · ${esc(fmtDateTime(message.created_at))}</div><div>${renderBody(message)}</div>`;
          result.addEventListener('click', () => { closePanel(); revealMessage(message.id); });
          body.appendChild(result);
        }
        panel.append(head, body);
        return;
      }
      panel.style.display = 'none';
      panel.innerHTML = '';
    }

    function buildThreadComposer(node){
      const box = el('div', 'fm-ch-composer-box');
      const threadInput = createMessageEditor('Reply…');
      if (features.richMessages) box.appendChild(messageFormatBar(threadInput));
      box.appendChild(threadInput);
      bindRichMentions(threadInput, box);
      const row = el('div', 'fm-ch-composer-row');
      const send = el('button', 'fm-ch-send', 'Reply');
      row.appendChild(send);
      node.append(box, row);
      let threadMentionApi = null;
      try {
        if (root.FirstMateTags?.attachMentionTextarea && threadInput.tagName === 'TEXTAREA') {
          threadMentionApi = root.FirstMateTags.attachMentionTextarea(threadInput, { orgId, source: 'channels' }) || null;
        }
      } catch (error) {}
      const editNote = el('div', 'fm-ch-edit-note');
      editNote.style.display = 'none';
      node.prepend(editNote);
      let editingId = '';
      const doSend = async () => {
        const text = threadInput.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          const mentions = threadMentionApi?.confirmedMentions?.() || threadInput.mentionUsers.filter(user => text.includes(`@${user.name}`));
          if (editingId) {
            const data = await api.messages.edit(orgId, editingId, { text, mention_users: mentions });
            replaceMessage(data.message);
            editingId = '';
            editNote.style.display = 'none';
          } else {
            await api.messages.post(orgId, state.activeChannelId, {
              text,
              parent_id: state.threadRootId,
              client_msg_id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
              mention_users: mentions
            });
            await openThread(state.threadRootId, { silent: true });
            await refreshActiveMessages();
          }
          threadInput.value = '';
          threadMentionApi?.setSelectedMentions?.([]);
        } catch (error) {
          showError(error);
        } finally {
          send.disabled = false;
        }
      };
      send.addEventListener('click', doSend);
      threadInput.addEventListener('keydown', (event) => {
        const modifiedSend = state.collaborationPreferences.send_mode === 'modified_enter';
        const sendKey = event.key === 'Enter'
          && !event.shiftKey
          && !event.isComposing
          && !mentionMenuOpen()
          && (modifiedSend ? (event.ctrlKey || event.metaKey) : !(event.ctrlKey || event.metaKey));
        if (sendKey) {
          event.preventDefault();
          doSend();
        }
      });
      panel._startEdit = (message) => {
        editingId = message.id;
        editNote.style.display = 'flex';
        editNote.innerHTML = `<span>${(globalThis.PlatformLanguage?.text("channels-ui","m_34e633033239eb","Editing reply") ?? "Editing reply")}</span><button>${(globalThis.PlatformLanguage?.text("channels-ui","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>`;
        editNote.querySelector('button').addEventListener('click', () => {
          editingId = '';
          editNote.style.display = 'none';
          threadInput.value = '';
        });
        threadInput.value = message.text;
        threadInput.focus();
      };
    }

    // --- attention / saved / search views -----------------------------------------------

    function beginStandaloneView(view){
      state.view = view;
      state.threadRootId = '';
      state.thread = null;
      state.activeTab = '';
      showMobileConversation();
      renderPanel();
      renderHeader();
      renderTabs();
      renderSidebar();
      composer.innerHTML = '';
      typingBar.textContent = '';
      list.innerHTML = `<div class="fm-ch-empty"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("channels-ui","m_b0f32b15b02e72"," Loading...") ?? " Loading...")}</div>`;
    }

    async function openUnreadsView(){
      beginStandaloneView('unreads');
      try {
        const data = await api.readState.messages(orgId, { limit:100 });
        list.innerHTML = '';
        const toolbar = el('div', 'fm-ch-view-toolbar');
        toolbar.innerHTML = `<span><strong>${String(Number(data.total_unread || 0))}</strong>${(globalThis.PlatformLanguage?.text("channels-ui","m_d6f1ae5e7d9a04"," unread messages") ?? " unread messages")}</span><span class="fm-ch-view-summary">${(globalThis.PlatformLanguage?.text("channels-ui","m_7f3dff4cdd30a9","Grouped by conversation") ?? "Grouped by conversation")}</span>`;
        list.appendChild(toolbar);
        if (!data.conversations?.length) {
          list.appendChild(el('div', 'fm-ch-empty', '<i class="fas fa-circle-check"></i><br>You are all caught up.'));
          return;
        }
        for (const group of data.conversations) {
          const section = el('section', 'fm-ch-unread-group');
          const heading = el('div', 'fm-ch-unread-head');
          const toggle = el('button', 'fm-ch-icon-btn', '<i class="fas fa-chevron-down"></i>');
          const title = el('strong', '', esc(group.channel?.display_name || group.channel?.name || 'Conversation'));
          title.style.cursor = 'pointer';
          title.addEventListener('click', () => setChannel(group.channel.id));
          const count = el('span', 'fm-ch-unread-count', `${(group.messages || []).length} unread`);
          const messages = el('div', 'fm-ch-unread-messages');
          for (const message of group.messages || []) messages.appendChild(messageRow(message));
          toggle.addEventListener('click', () => {
            messages.hidden = !messages.hidden;
            toggle.innerHTML = `<i class="fas fa-chevron-${messages.hidden ? 'right' : 'down'}"></i>`;
          });
          const done = el('button', 'fm-ch-btn', 'Mark conversation read');
          done.addEventListener('click', async () => {
            await api.readState.markRead(orgId, group.channel.id, Number(group.channel.message_seq || group.messages.at(-1)?.seq || 0));
            section.remove();
          });
          heading.append(toggle, title, count, done);
          section.append(heading, messages);
          list.appendChild(section);
        }
      } catch (error) { showError(error); }
    }

    async function markAllReadWithUndo(){
      try {
        const result = await api.readState.markAllRead(orgId);
        await openUnreadsView();
        const undo = async () => {
          await api.readState.undo(orgId, result.operation_id);
          await loadChannels();
          await openUnreadsView();
        };
        if (root.Portal?.ui?.showToast) {
          root.Portal.ui.showToast((globalThis.PlatformLanguage?.text("channels-ui","m_70757cc690568f","All messages marked read") ?? "All messages marked read"), (globalThis.PlatformLanguage?.text("channels-ui","m_9664a34f6e1e30","Use Undo within 30 seconds from the Channels header.") ?? "Use Undo within 30 seconds from the Channels header."), true);
        }
        const button = el('button', 'fm-ch-btn', 'Undo mark all read');
        button.style.margin = '12px auto';
        button.addEventListener('click', undo);
        list.prepend(button);
      } catch (error) { showError(error); }
    }

    async function openActivityView(){
      beginStandaloneView('activity');
      try {
        const data = await api.activity.list(orgId, { limit:150 });
        list.innerHTML = '';
        const items = data.items || [];
        const toolbar = el('div', 'fm-ch-view-toolbar');
        const results = el('div');
        const filters = [['all', 'All'], ['mention', 'Mentions'], ['thread_reply', 'Threads'], ['reaction', 'Reactions'], ['huddle', 'Huddles']];
        const render = () => {
          results.innerHTML = '';
          const visible = items.filter((item) => {
            const kind = cleanText(item.kind);
            const kindMatches = state.activityFilter === 'all'
              || (state.activityFilter === 'huddle' ? kind.startsWith('huddle_') : kind === state.activityFilter);
            return kindMatches && (!state.activityUnreadOnly || !item.read_at);
          });
          toolbar.querySelector('.fm-ch-view-summary').textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("channels-ui","m_edf6b0d1b49ce8",`${v0} shown · ${v1} unread`,{v0,v1}) ?? `${v0} shown · ${v1} unread`)(visible.length,items.filter((item) => !item.read_at).length);
          for (const button of toolbar.querySelectorAll('[data-activity-filter]')) {
            button.classList.toggle('on', button.dataset.activityFilter === state.activityFilter);
          }
          toolbar.querySelector('[data-activity-unread]')?.classList.toggle('on', state.activityUnreadOnly);
          if (!visible.length) {
            results.appendChild(el('div', 'fm-ch-empty', state.activityUnreadOnly ? 'No unread activity in this category.' : 'No activity in this category yet.'));
            return;
          }
          let lastDay = '';
          for (const item of visible) {
            const day = dayKey(item.created_at);
            if (day !== lastDay) {
              results.appendChild(el('div', 'fm-ch-day', esc(fmtDay(item.created_at))));
              lastDay = day;
            }
            const kind = cleanText(item.kind);
            const labels = {
              mention:['Mention', 'fa-at'],
              direct_message:['Direct message', 'fa-message'],
              thread_reply:['Thread reply', 'fa-comments'],
              reaction:['Reaction', 'fa-face-smile'],
              huddle_started:['Huddle started', 'fa-headphones'],
              huddle_ended:['Huddle ended', 'fa-phone-slash']
            };
            const [label, icon] = labels[kind] || [kind.replace(/_/g, ' ') || 'Activity', 'fa-bell'];
            const previewText = cleanText(item.text);
            const showPreview = previewText && previewText.toLocaleLowerCase() !== label.toLocaleLowerCase();
            const row = el('div', `fm-ch-attention-row${item.read_at ? '' : ' unread'}`);
            row.innerHTML = `<span class="fm-ch-attention-icon"><i class="fas ${String(icon)}"></i></span><span class="fm-ch-attention-main"><span class="fm-ch-attention-heading"><span class="fm-ch-attention-title">${((v1,v2) => globalThis.PlatformLanguage?.text("channels-ui","m_c59a4df2d5e7e9",`${v1} in ${v2}`,{v1,v2}) ?? `${v1} in ${v2}`)(esc(label),esc(item.channel_name || 'a conversation'))}</span><span class="fm-ch-result-meta">${String(esc(fmtDateTime(item.created_at)))}</span></span>${String(showPreview ? `<span class="fm-ch-attention-copy">${renderBody({ text:previewText })}</span>` : '')}</span><span class="fm-ch-attention-actions">${String(item.read_at ? '' : '<span class="fm-ch-attention-dot" title="Unread"></span>')}</span>`;
            row.addEventListener('click', async (event) => {
              if (event.target.closest('button')) return;
              await api.activity.update(orgId, item.id, { read:true }).catch(() => {});
              item.read_at = new Date().toISOString();
              await setChannel(item.channel_id, { reveal:item.message_id });
              if (item.root_message_id) await openThread(item.root_message_id);
            });
            const actions = row.querySelector('.fm-ch-attention-actions');
            if (!item.read_at) {
              const read = el('button', 'fm-ch-icon-btn', '<i class="fas fa-check"></i>');
              read.title = (globalThis.PlatformLanguage?.text("channels-ui","m_3ade71c99c71d0","Mark read") ?? "Mark read");
              read.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("channels-ui","m_1ec8982748eb43","Mark activity read") ?? "Mark activity read"));
              read.addEventListener('click', async (event) => {
                event.stopPropagation();
                await api.activity.update(orgId, item.id, { read:true });
                item.read_at = new Date().toISOString();
                render();
              });
              actions.appendChild(read);
            }
            results.appendChild(row);
          }
        };
        for (const [value, label] of filters) {
          const button = el('button', 'fm-ch-filter', esc(label));
          button.dataset.activityFilter = value;
          button.addEventListener('click', () => { state.activityFilter = value; render(); });
          toolbar.appendChild(button);
        }
        const unread = el('button', 'fm-ch-filter', 'Unread');
        unread.dataset.activityUnread = 'true';
        unread.addEventListener('click', () => { state.activityUnreadOnly = !state.activityUnreadOnly; render(); });
        toolbar.append(unread, el('span', 'fm-ch-view-summary'));
        list.append(toolbar, results);
        render();
      } catch (error) { showError(error); }
    }

    async function openThreadsView(){
      beginStandaloneView('threads');
      try {
        const data = await api.threads.list(orgId);
        list.innerHTML = '';
        const threads = data.threads || [];
        const toolbar = el('div', 'fm-ch-view-toolbar');
        const all = el('button', 'fm-ch-filter on', 'All threads');
        const unread = el('button', 'fm-ch-filter', 'Unread');
        const summary = el('span', 'fm-ch-view-summary');
        toolbar.append(all, unread, summary);
        const results = el('div');
        const render = () => {
          results.innerHTML = '';
          all.classList.toggle('on', !state.threadsUnreadOnly);
          unread.classList.toggle('on', state.threadsUnreadOnly);
          const visible = threads.filter((thread) => !state.threadsUnreadOnly || Number(thread.unread_count) > 0);
          summary.textContent = ((v0,v1,v2) => globalThis.PlatformLanguage?.text("channels-ui","m_6dfc68be1187f5",`${v0} thread${v1} · ${v2} unread replies`,{v0,v1,v2}) ?? `${v0} thread${v1} · ${v2} unread replies`)(visible.length,visible.length === 1 ? '' : 's',threads.reduce((sum, thread) => sum + Number(thread.unread_count || 0), 0));
          if (!visible.length) {
            results.appendChild(el('div', 'fm-ch-empty', state.threadsUnreadOnly ? 'No unread thread replies.' : 'Threads you participate in or follow will appear here.'));
            return;
          }
          for (const thread of visible) {
            const channel = state.channelsById.get(thread.root.channel_id);
            const latest = (thread.replies || []).at(-1);
            const card = el('article', `fm-ch-thread-card${Number(thread.unread_count) ? ' unread' : ''}`);
            const head = el('div', 'fm-ch-thread-card-head', `<strong>${String(esc(channel?.display_name || channel?.name || 'Conversation'))}</strong><span>${((v1) => globalThis.PlatformLanguage?.text("channels-ui","m_4d41aac4ff52eb",`${v1} replies`,{v1}) ?? `${v1} replies`)(Number(thread.root.reply_count || thread.replies?.length || 0))}</span><span>${String(esc(fmtDateTime(thread.root.last_reply_at || latest?.created_at || thread.root.created_at)))}</span>`);
            if (Number(thread.unread_count)) {
              const markRead = el('button', 'fm-ch-btn', 'Mark read');
              markRead.style.marginLeft = 'auto';
              markRead.addEventListener('click', async (event) => {
                event.stopPropagation();
                await api.threads.markRead(orgId, thread.root.id, Number(thread.last_reply_seq || latest?.seq || 0));
                thread.unread_count = 0;
                render();
              });
              head.appendChild(markRead);
            }
            const body = el('div', 'fm-ch-thread-card-body');
            body.appendChild(messageRow(thread.root, { inThread:true }));
            if (latest) body.appendChild(el('div', 'fm-ch-thread-latest', `<strong>${esc(latest.author?.name || 'Someone')}</strong> ${renderBody(latest)}<div class="fm-ch-result-meta">${esc(fmtDateTime(latest.created_at))}</div>`));
            card.append(head, body);
            card.addEventListener('click', (event) => {
              if (!event.target.closest('button,a')) setChannel(thread.root.channel_id, { reveal:thread.root.id }).then(() => openThread(thread.root.id));
            });
            results.appendChild(card);
          }
        };
        all.addEventListener('click', () => { state.threadsUnreadOnly = false; render(); });
        unread.addEventListener('click', () => { state.threadsUnreadOnly = true; render(); });
        list.append(toolbar, results);
        render();
      } catch (error) { showError(error); }
    }

    async function openSavedView(){
      try {
        const [data, reminderData] = await Promise.all([
          api.saved.list(orgId),
          features.richMessages ? api.reminders.list(orgId).catch(() => ({ reminders:[] })) : Promise.resolve({ reminders:[] })
        ]);
        beginStandaloneView('saved');
        list.innerHTML = '';
        const reminders = reminderData.reminders || [];
        if (!data.messages?.length && !reminders.length) {
          list.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_b96e086a77005b","Nothing saved yet. Hover a message and choose the bookmark to save it.") ?? "Nothing saved yet. Hover a message and choose the bookmark to save it.")}</div>`;
          return;
        }
        for (const reminder of reminders) {
          const message = reminder.message || {};
          const result = el('div', `fm-ch-result${reminder.due ? ' unread' : ''}`);
          result.innerHTML = `<div class="fm-ch-result-meta"><i class="fas fa-clock"></i> ${reminder.due ? 'Due now' : `Reminder ${esc(fmtDateTime(reminder.remind_at))}`} · ${esc(reminder.channel?.name || '')}</div><div>${renderBody(message)}</div>`;
          result.addEventListener('click', () => setChannel(message.channel_id, { reveal:message.id }));
          list.appendChild(result);
        }
        for (const message of data.messages) {
          if (reminders.some((reminder) => reminder.message?.id === message.id)) continue;
          const result = el('div', 'fm-ch-result');
          const channelName = message.channel?.type === 'project' ? `${message.channel?.name || 'Project'}` : `#${message.channel?.name || ''}`;
          result.innerHTML = `<div class="fm-ch-result-meta">${esc(channelName)} · ${esc(message.author?.name || '')} · ${esc(fmtDateTime(message.created_at))}</div><div>${renderBody(message)}</div>`;
          result.addEventListener('click', () => setChannel(message.channel_id, { reveal: message.id }));
          list.appendChild(result);
        }
      } catch (error) {
        showError(error);
      }
    }

    function openSearchPrompt(){
      showModal('Search messages', (body, close) => {
        const input = el('input');
        input.type = 'text';
        input.placeholder = (globalThis.PlatformLanguage?.text("channels-ui","m_466cd309589c55","Search…") ?? "Search…");
        input.className = '';
        body.appendChild(el('label', '', 'Search all channels you can see'));
        body.appendChild(input);
        input.style.width = '100%';
        input.style.padding = '8px 10px';
        input.style.border = '1px solid #e4e7ec';
        input.style.borderRadius = '8px';
        const run = async () => {
          const q = input.value.trim();
          if (!q) return;
          close();
          await runSearch(q);
        };
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
        setTimeout(() => input.focus(), 0);
      }, [{ label: (globalThis.PlatformLanguage?.text("channels-ui","m_55524759bb89e3","Search") ?? "Search"), primary: true, onClick: (close, body) => {
        const input = body.querySelector('input');
        const q = input?.value.trim();
        if (q) { close(); runSearch(q); }
      } }]);
    }

    async function runSearch(q){
      try {
        const data = await api.search(orgId, q);
        state.view = 'search';
        state.searchQuery = q;
        showMobileConversation();
        renderHeader();
        renderTabs();
        composer.innerHTML = '';
        typingBar.textContent = '';
        list.innerHTML = '';
        if (!data.messages?.length) {
          list.innerHTML = `<div class="fm-ch-empty">${((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_b6f14625c56412",`No matches for “${v0}”.`,{v0}) ?? `No matches for “${v0}”.`)(esc(q))}</div>`;
          return;
        }
        for (const message of data.messages) {
          const result = el('div', 'fm-ch-result');
          const channelName = message.channel?.type === 'project' ? `${message.channel?.name || 'Project'}` : `#${message.channel?.name || ''}`;
          result.innerHTML = `<div class="fm-ch-result-meta">${esc(channelName)} · ${esc(message.author?.name || '')} · ${esc(fmtDateTime(message.created_at))}</div><div>${renderBody(message)}</div>`;
          result.addEventListener('click', () => setChannel(message.channel_id, { reveal: message.id }));
          list.appendChild(result);
        }
      } catch (error) {
        showError(error);
      }
    }

    // --- modals: create channel / dm / members / settings ---------------------------------

    async function orgUsers(){
      try {
        if (api?.directory?.list) {
          const data = await api.directory.list(orgId);
          return (data?.users || [])
            .map((user) => ({
              id: user.id,
              name: cleanText(user.name || user.email) || 'Unknown',
              email: cleanText(user.email).toLowerCase(),
              disabled: user.disabled === true
            }))
            .filter((user) => user.id && user.id !== currentUser.id && !user.disabled);
        }
        const platform = root.PlatformAPI;
        const data = platform?.users?.list ? await platform.users.list(orgId) : await platform.request(`/organizations/${encodeURIComponent(orgId)}/users`);
        const documents = data?.users || data?.documents || [];
        return documents.map((doc) => ({
          id: doc.id,
          name: cleanText(doc.data?.name || doc.data?.email || doc.name || doc.email) || 'Unknown',
          email: cleanText(doc.data?.email || doc.email).toLowerCase(),
          disabled: doc.disabled === true || doc.data?.disabled === true || cleanText(doc.data?.status || doc.status).toLowerCase() === 'disabled'
        })).filter((user) => user.id && user.id !== currentUser.id && !user.disabled);
      } catch (error) {
        return [];
      }
    }

    function openSidebarSectionsModal(){
      const modal = showModal('Edit sidebar sections', (body) => {
        body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_586f9a248e27e5","Section") ?? "Section")}</label><select data-section-id></select><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_59ef362ab40231","Section name") ?? "Section name")}</label><input data-section-label maxlength="80" placeholder="${(globalThis.PlatformLanguage?.text("channels-ui","m_12978eee46da51","For example: Install team") ?? "For example: Install team")}"><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_ee81752261cfa1","Conversations") ?? "Conversations")}</label><div data-section-channels></div>`;
        const select = body.querySelector('[data-section-id]');
        select.innerHTML = `<option value="">${(globalThis.PlatformLanguage?.text("channels-ui","m_3eea1424539334","New section") ?? "New section")}</option>`;
        for (const section of state.sidebarSections) {
          const option = document.createElement('option');
          option.value = section.id;
          option.textContent = section.label;
          select.appendChild(option);
        }
        const render = () => {
          const section = state.sidebarSections.find((item) => item.id === select.value);
          body.querySelector('[data-section-label]').value = section?.label || '';
          const selected = new Set(section?.channel_ids || []);
          const holder = body.querySelector('[data-section-channels]');
          holder.innerHTML = '';
          for (const channel of state.channels) {
            const row = el('label', 'fm-ch-member-row', `<input type="checkbox" value="${esc(channel.id)}"${selected.has(channel.id) ? ' checked' : ''}><span class="name">${esc(channel.display_name || channel.name)}</span>`);
            holder.appendChild(row);
          }
        };
        select.addEventListener('change', render);
        render();
      }, [
        { label:(globalThis.PlatformLanguage?.text("channels-ui","m_7b78fd90e05b38","Delete section") ?? "Delete section"), onClick:async (close, body) => {
          const id = cleanText(body.querySelector('[data-section-id]')?.value);
          if (!id) return;
          try {
            await api.sidebarSections.remove(orgId, id);
            close();
            await loadChannels();
          } catch (error) { showError(error); }
        } },
        { label:(globalThis.PlatformLanguage?.text("channels-ui","m_c62df86c349814","Save section") ?? "Save section"), primary:true, onClick:async (close, body) => {
          try {
            const label = cleanText(body.querySelector('[data-section-label]')?.value);
            if (!label) throw new Error('Give the section a name.');
            const existingId = cleanText(body.querySelector('[data-section-id]')?.value);
            const id = existingId || `section_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
            const channelIds = [...body.querySelectorAll('[data-section-channels] input:checked')].map((input) => input.value);
            await api.sidebarSections.save(orgId, id, {
              id,
              label,
              position:existingId ? Number(state.sidebarSections.find((item) => item.id === existingId)?.position || 0) : state.sidebarSections.length,
              collapsed:false,
              channel_ids:channelIds
            });
            close();
            await loadChannels();
          } catch (error) { showError(error); }
        } }
      ]);
      return modal;
    }

    function openCreateChannelModal(){
      showModal('Create a channel', (body) => {
        body.innerHTML = `
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_8cf345002184e5","Name") ?? "Name")}</label>
          <input type="text" data-field="name" placeholder="${(globalThis.PlatformLanguage?.text("channels-ui","m_764c04db3ecb32","e.g. installs") ?? "e.g. installs")}">
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_e23660d62b184c","Topic (optional)") ?? "Topic (optional)")}</label>
          <input type="text" data-field="topic" placeholder="${(globalThis.PlatformLanguage?.text("channels-ui","m_726dc4834a1366","What is this channel about?") ?? "What is this channel about?")}">
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_d1621d1dbd55f1","Visibility") ?? "Visibility")}</label>
          <select data-field="type">
            <option value="public">${(globalThis.PlatformLanguage?.text("channels-ui","m_605d0d4be17eba","Public — anyone in the company can join") ?? "Public — anyone in the company can join")}</option>
            <option value="private">${(globalThis.PlatformLanguage?.text("channels-ui","m_577f103c68de9e","Private — invite only") ?? "Private — invite only")}</option>
          </select>`;
      }, [{ label: (globalThis.PlatformLanguage?.text("channels-ui","m_3c21a9590eb762","Create") ?? "Create"), primary: true, onClick: async (close, body) => {
        try {
          const name = body.querySelector('[data-field=name]').value;
          const topic = body.querySelector('[data-field=topic]').value;
          const type = body.querySelector('[data-field=type]').value;
          const data = await api.channels.create(orgId, { type, name, topic, member_user_ids: [] });
          close();
          await loadChannels();
          await setChannel(data.channel.id);
        } catch (error) {
          showError(error);
        }
      } }]);
    }

    function openResourcePickerModal(){
      showModal('Share a resource', (body, close) => {
        body.innerHTML = `<div class="fm-ch-empty"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("channels-ui","m_e67b602876c30e"," Loading project and channel resources...") ?? " Loading project and channel resources...")}</div>`;
        api.resources.list(orgId, state.activeChannelId).then((data) => {
          body.innerHTML = '';
          const resources = data.resources || [];
          if (!resources.length) {
            body.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_b95c74804804aa","No resources are available in this conversation yet.") ?? "No resources are available in this conversation yet.")}</div>`;
            return;
          }
          const grid = el('div', 'fm-ch-resource-grid');
          for (const entry of resources) {
            const resource = entry.resource || {};
            const type = cleanText(entry.resource_type);
            const label = cleanText(resource.label || resource.title || resource.file_name || resource.name || entry.display_note) || 'Shared resource';
            const button = el('button', 'fm-ch-resource');
            button.innerHTML = `<span class="fm-ch-resource-icon"><i class="fas ${resourceIcon(type)}"></i></span><span class="fm-ch-resource-copy"><strong>${esc(label)}</strong><span>${esc(type)}</span></span>`;
            button.addEventListener('click', async () => {
              try {
                await api.messages.post(orgId, state.activeChannelId, {
                  text:`Shared ${label}`,
                  content:{ type:'doc', blocks:[{ type:'resource', resource_type:type, resource_id:entry.resource_id, label }] },
                  content_schema_version:1,
                  metadata:{ resource_ref:{ resource_type:type, resource_id:entry.resource_id, label } },
                  client_msg_id:`resource_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`
                });
                close();
              } catch (error) { showError(error); }
            });
            grid.appendChild(button);
          }
          body.appendChild(grid);
        }).catch(showError);
      });
    }

    function openReminderModal(message){
      showModal('Remind me', (body) => {
        const date = new Date(Date.now() + 60 * 60_000);
        date.setSeconds(0, 0);
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_5d0ffda53615be","Reminder time") ?? "Reminder time")}</label><input type="datetime-local" data-reminder-at value="${String(local)}">`;
      }, [{ label:(globalThis.PlatformLanguage?.text("channels-ui","m_9b6a0832346dfa","Save reminder") ?? "Save reminder"), primary:true, onClick:async (close, body) => {
        try {
          const value = body.querySelector('[data-reminder-at]')?.value;
          const date = new Date(value);
          if (!value || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Choose a future reminder time.');
          await api.reminders.create(orgId, message.id, date.toISOString());
          if (!message.is_saved) {
            await api.saved.add(orgId, message.id);
            message.is_saved = true;
            replaceMessage(message);
          }
          close();
          root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("channels-ui","m_32afb1444d63bb","Reminder saved") ?? "Reminder saved"), date.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()), true);
        } catch (error) { showError(error); }
      } }]);
    }

    function openForwardModal(message){
      showModal('Forward message', (body) => {
        body.innerHTML = `<label>${(globalThis.PlatformLanguage?.text("channels-ui","m_8ea15c3c9b6b15","Send to") ?? "Send to")}</label><select data-forward-channel></select><label>${(globalThis.PlatformLanguage?.text("channels-ui","m_2badf4ec55e985","Add a note") ?? "Add a note")}</label><textarea data-forward-note rows="3" placeholder="${(globalThis.PlatformLanguage?.text("channels-ui","m_532cbb7a6d1e29","Optional context") ?? "Optional context")}"></textarea>`;
        const select = body.querySelector('[data-forward-channel]');
        for (const channel of state.channels.filter((item) => !item.archived_at)) {
          const option = document.createElement('option');
          option.value = channel.id;
          option.textContent = channel.display_name || channel.name;
          select.appendChild(option);
        }
      }, [{ label:(globalThis.PlatformLanguage?.text("channels-ui","m_7f4460f41d3633","Forward") ?? "Forward"), primary:true, onClick:async (close, body) => {
        try {
          const targetChannelId = cleanText(body.querySelector('[data-forward-channel]')?.value);
          const note = cleanText(body.querySelector('[data-forward-note]')?.value);
          if (!targetChannelId) throw new Error('Choose a conversation.');
          const actor = cleanText(message.author?.name) || 'a teammate';
          const forwardedText = `${note ? `${note}\n\n` : ''}Forwarded from ${actor}:\n${message.text}`;
          await api.messages.post(orgId, targetChannelId, {
            text:forwardedText,
            content:{ type:'doc', blocks:[{ type:'quote', text:message.text }] },
            content_schema_version:1,
            metadata:{ forwarded_message_id:message.id, forwarded_channel_id:message.channel_id },
            client_msg_id:`forward_${message.id}_${Date.now().toString(36)}`
          });
          close();
          root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("channels-ui","m_3a50ebb2d7acc4","Message forwarded") ?? "Message forwarded"), '', true);
        } catch (error) { showError(error); }
      } }]);
    }

    function openCreateTodoModal(message){
      showModal('Create To Do from message', (body) => {
        const title = cleanText(message.text).split(/\r?\n/).find(Boolean)?.slice(0, 120) || 'Message follow-up';
        body.innerHTML = `
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_29dbd3d8b69f55","Title") ?? "Title")}</label>
          <input type="text" data-field="title" value="${String(esc(title))}">
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_b08ed1ca094f1a","Due date (optional)") ?? "Due date (optional)")}</label>
          <input type="datetime-local" data-field="due">
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_6484e03a4531ae","Priority") ?? "Priority")}</label>
          <select data-field="priority"><option value="normal">${(globalThis.PlatformLanguage?.text("channels-ui","m_9a27adafe8f638","Normal") ?? "Normal")}</option><option value="high">${(globalThis.PlatformLanguage?.text("channels-ui","m_56935738631420","High") ?? "High")}</option><option value="urgent">${(globalThis.PlatformLanguage?.text("channels-ui","m_dc457ed9b0546e","Urgent") ?? "Urgent")}</option><option value="low">${(globalThis.PlatformLanguage?.text("channels-ui","m_faf9ac4c2c4b3f","Low") ?? "Low")}</option></select>`;
      }, [{ label:(globalThis.PlatformLanguage?.text("channels-ui","m_ffae27506c46f3","Create To Do") ?? "Create To Do"), primary:true, onClick:async (close, body) => {
        try {
          const dueValue = body.querySelector('[data-field=due]')?.value;
          await api.todos.fromMessage(orgId, message.id, {
            title:body.querySelector('[data-field=title]')?.value,
            due_at:dueValue ? new Date(dueValue).toISOString() : undefined,
            priority:body.querySelector('[data-field=priority]')?.value,
            client_operation_id:`ui_${Date.now().toString(36)}`
          });
          close();
          root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("channels-ui","m_c527ae64bd7bca","To Do created") ?? "To Do created"), (globalThis.PlatformLanguage?.text("channels-ui","m_489fda8af18a36","The message is linked to the new To Do.") ?? "The message is linked to the new To Do."), true);
        } catch (error) { showError(error); }
      } }]);
    }

    async function openNewDmModal(){
      const users = await orgUsers();
      // The AI agent(s) can be DMed like teammates.
      const agents = await (root.FirstMateTags?.listAgentParticipants?.(orgId) || Promise.resolve([])).catch(() => []);
      for (const agent of agents) {
        if (!users.some((user) => user.id === agent.id)) users.push({ id: agent.id, name: agent.name, email: '', agent: true });
      }
      const selected = new Set();
      showModal('New direct message', (body) => {
        if (!users.length) {
          body.innerHTML = `<div class="fm-ch-empty">${(globalThis.PlatformLanguage?.text("channels-ui","m_a9019ea1900564","No teammates found.") ?? "No teammates found.")}</div>`;
          return;
        }
        body.appendChild(el('p', 'fm-ch-dm-help', 'Choose one teammate for a direct message, or select multiple people to start a group conversation.'));
        for (const user of users) {
          const rowNode = el('button', 'fm-ch-member-row fm-ch-member-choice');
          rowNode.type = 'button';
          rowNode.setAttribute('aria-pressed', 'false');
          rowNode.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("channels-ui","m_65bb5febcad942",`Select ${v0}`,{v0}) ?? `Select ${v0}`)(user.name));
          rowNode.innerHTML = `${avatarHtml(user, 'sm')}<span class="name">${esc(user.name)}${user.agent ? ` <span class="fm-ch-tag"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.text("channels-ui","m_7011e28be0ee19"," AI") ?? " AI")}</span>` : ''}</span><span class="fm-ch-member-check" aria-hidden="true"><i class="fas fa-check"></i></span>`;
          rowNode.addEventListener('click', () => {
            const nextSelected = !selected.has(user.id);
            if (nextSelected) selected.add(user.id);
            else selected.delete(user.id);
            rowNode.classList.toggle('selected', nextSelected);
            rowNode.setAttribute('aria-pressed', nextSelected ? 'true' : 'false');
            rowNode.setAttribute('aria-label', `${nextSelected ? 'Deselect' : 'Select'} ${user.name}`);
          });
          body.appendChild(rowNode);
        }
      }, [{ label: (globalThis.PlatformLanguage?.text("channels-ui","m_1f492347b01f51","Start conversation") ?? "Start conversation"), primary: true, onClick: async (close) => {
        if (!selected.size) return;
        try {
          const data = await api.channels.create(orgId, { type: 'dm', name: '', topic: '', member_user_ids: [...selected] });
          close();
          await loadChannels();
          await setChannel(data.channel.id);
        } catch (error) {
          showError(error);
        }
      } }]);
    }

    function openQuickSwitcher(){
      showModal('Quick switcher', (body) => {
        const input = el('input');
        input.type = 'text';
        input.placeholder = (globalThis.PlatformLanguage?.text("channels-ui","m_4be13a4c37e830","Jump to a channel or conversation") ?? "Jump to a channel or conversation");
        input.style.width = '100%';
        input.style.padding = '8px 10px';
        input.style.border = '1px solid #e4e7ec';
        input.style.borderRadius = '8px';
        const results = el('div');
        const paint = () => {
          const query = cleanText(input.value).toLowerCase();
          results.innerHTML = '';
          state.channels
            .filter((channel) => !query || cleanText(channel.display_name || channel.name).toLowerCase().includes(query))
            .slice(0, 30)
            .forEach((channel) => {
              const row = sideItem(channel);
              row.addEventListener('click', () => document.querySelector('.fm-ch-modal-backdrop')?.remove(), { once:true });
              results.appendChild(row);
            });
        };
        input.addEventListener('input', paint);
        body.append(input, results);
        paint();
        setTimeout(() => input.focus(), 0);
      }, []);
    }

    async function openMembersModal(){
      const channel = state.activeChannel;
      const everyone = await orgUsers();
      const memberIds = new Set((channel.members || []).map((member) => member.id));
      showModal(`Members — ${channel.display_name || channel.name}`, (body) => {
        for (const member of channel.members || []) {
          const rowNode = el('div', 'fm-ch-member-row');
          rowNode.innerHTML = `${avatarHtml(member, 'sm')}<span class="name">${esc(member.name)}${member.role !== 'member' ? ` <span class="fm-ch-tag">${esc(member.role)}</span>` : ''}</span>`;
          if (channel.can_manage && member.id !== currentUser.id) {
            const remove = el('button', 'fm-ch-icon-btn', '<i class="fas fa-xmark"></i>');
            remove.title = (globalThis.PlatformLanguage?.text("channels-ui","m_47839980185da7","Remove from channel") ?? "Remove from channel");
            remove.addEventListener('click', async () => {
              try {
                await api.channels.removeMember(orgId, channel.id, member.id);
                rowNode.remove();
              } catch (error) { showError(error); }
            });
            rowNode.appendChild(remove);
          }
          body.appendChild(rowNode);
        }
        const addable = everyone.filter((user) => !memberIds.has(user.id));
        if (addable.length && (channel.can_manage || channel.type === 'public')) {
          body.appendChild(el('label', '', 'Add people'));
          for (const user of addable) {
            const rowNode = el('div', 'fm-ch-member-row');
            rowNode.innerHTML = `${avatarHtml(user, 'sm')}<span class="name">${esc(user.name)}</span>`;
            const add = el('button', 'fm-ch-btn', 'Add');
            add.addEventListener('click', async () => {
              try {
                await api.channels.addMembers(orgId, channel.id, [user.id]);
                add.textContent = (globalThis.PlatformLanguage?.text("channels-ui","m_3c7ae517773d5c","Added") ?? "Added");
                add.disabled = true;
              } catch (error) { showError(error); }
            });
            rowNode.appendChild(add);
            body.appendChild(rowNode);
          }
        }
      }, [{ label: (globalThis.PlatformLanguage?.text("channels-ui","m_8cb6b086a0e69c","Done") ?? "Done"), primary: true, onClick: async (close) => {
        close();
        await loadChannels();
        if (state.activeChannelId) {
          const data = await api.channels.get(orgId, state.activeChannelId).catch(() => null);
          if (data) { state.activeChannel = data.channel; renderHeader(); }
        }
      } }]);
    }

    function openChannelSettingsModal(){
      const channel = state.activeChannel;
      const huddleDefaults = channelHuddleDefaults(channel);
      showModal(`Channel settings — #${channel.name}`, (body) => {
        body.innerHTML = `
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_8cf345002184e5","Name") ?? "Name")}</label>
          <input type="text" data-field="name" value="${String(esc(channel.name))}">
          <label>${(globalThis.PlatformLanguage?.text("channels-ui","m_b0afebe3886365","Topic") ?? "Topic")}</label>
          <input type="text" data-field="topic" value="${String(esc(channel.topic))}">
          ${String(features.recording ? `<div class="fm-ch-setting-group">
            <strong>Huddle recording defaults</strong>
            <p>People can override these defaults before starting each huddle.</p>
            <label class="fm-ch-check-row">
              <span><strong>Record huddles by default</strong><small>Retain the conversation recording in this channel.</small></span>
              <input type="checkbox" data-field="huddle-recording" ${huddleDefaults.recordingEnabled ? 'checked' : ''}>
            </label>
            <label class="fm-ch-check-row">
              <span><strong>Include video and shared screens by default</strong><small>Turn this off to retain mixed audio only unless the starter opts in.</small></span>
              <input type="checkbox" data-field="huddle-record-video" ${huddleDefaults.recordVideo ? 'checked' : ''}>
            </label>
          </div>` : '')}`;
        const recording = body.querySelector('[data-field=huddle-recording]');
        const video = body.querySelector('[data-field=huddle-record-video]');
        const syncRecordingDefaults = () => {
          if (!recording || !video) return;
          video.disabled = !features.recordVideo || !recording.checked;
          if (!recording.checked) video.checked = false;
        };
        recording?.addEventListener('change', syncRecordingDefaults);
        syncRecordingDefaults();
        const archive = el('button', 'fm-ch-btn', channel.archived_at ? 'Unarchive channel' : 'Archive channel');
        archive.style.marginTop = '14px';
        archive.addEventListener('click', async () => {
          try {
            if (channel.archived_at) await api.channels.unarchive(orgId, channel.id);
            else await api.channels.archive(orgId, channel.id);
            await loadChannels();
            await setChannel(channel.id);
          } catch (error) { showError(error); }
        });
        body.appendChild(archive);
      }, [{ label: (globalThis.PlatformLanguage?.text("channels-ui","m_5bab3e72de1ebf","Save") ?? "Save"), primary: true, onClick: async (close, body) => {
        try {
          await api.channels.update(orgId, channel.id, {
            name: body.querySelector('[data-field=name]').value,
            topic: body.querySelector('[data-field=topic]').value,
            settings:{
              ...(channel.settings || {}),
              ...(features.recording ? {huddle_recording_enabled:Boolean(body.querySelector('[data-field=huddle-recording]')?.checked),
              huddle_record_video:features.recordVideo && Boolean(body.querySelector('[data-field=huddle-record-video]')?.checked)} : {})
            }
          });
          close();
          await loadChannels();
          await setChannel(channel.id);
        } catch (error) { showError(error); }
      } }]);
    }

    // --- errors -----------------------------------------------------------------------------

    function showError(error){
      console.warn('[FirstMateChannels]', error);
      const message = cleanText(error?.message) || 'Something went wrong.';
      if (root.Portal?.toast) { root.Portal.toast(message, (globalThis.PlatformLanguage?.text("channels-ui","m_7e784f9b5540ab","error") ?? "error")); return; }
      const note = el('div', 'fm-ch-empty', esc(message));
      note.style.color = '#d92d20';
      typingBar.innerHTML = '';
      typingBar.appendChild(note.firstChild ? note : note);
      setTimeout(() => { typingBar.textContent = ''; renderTyping(); }, 4000);
    }

    const keyboardHandler = (event) => {
      if (state.destroyed || mode === 'list') return;
      const editable = event.target?.closest?.('input,textarea,select,[contenteditable=true]');
      const key = String(event.key || '').toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'k') {
        event.preventDefault();
        openQuickSwitcher();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'g') {
        event.preventDefault();
        openSearchPrompt();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'a') {
        event.preventDefault();
        openUnreadsView();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 't') {
        event.preventDefault();
        openThreadsView();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'm') {
        event.preventDefault();
        openActivityView();
        return;
      }
      if (!editable && event.key === 'Escape' && state.view === 'channel' && state.activeChannel) {
        event.preventDefault();
        api.readState.markRead(orgId, state.activeChannel.id, Number(state.activeChannel.message_seq || state.messages.at(-1)?.seq || 0)).then(loadChannels).catch(showError);
      }
      if (!editable && event.key === 'c' && state.view === 'channel') textarea?.focus();
      if (editable && event.key === 'ArrowUp' && !event.target.value && state.view === 'channel') {
        const own = [...state.messages].reverse().find((message) => message.can_edit && !message.deleted_at);
        if (own) startEdit(own);
      }
    };
    document.addEventListener('keydown', keyboardHandler);
    const sidebarSectionsUpdatedHandler = (event) => {
      if (event.detail?.source === container || state.destroyed) return;
      void loadChannels();
    };
    root.addEventListener('fm:channels-sidebar-sections-updated', sidebarSectionsUpdatedHandler);

    // --- boot -------------------------------------------------------------------------------

    async function boot(){
      connectRealtime();
      try {
        const result = await api.preferences?.collaboration?.(orgId);
        state.collaborationPreferences = result?.preferences || state.collaborationPreferences;
      } catch (_) {}
      if (mode === 'embedded') {
        sidebar.remove();
        const context = options.context || {};
        if (context.kind === 'project' && context.projectId) {
          try {
            const data = await api.channels.ensureProject(orgId, context.projectId);
            state.channelsById.set(data.channel.id, data.channel);
            await setChannel(data.channel.id);
          } catch (error) {
            list.innerHTML = `<div class="fm-ch-empty">${esc(error?.message || 'Project messages are unavailable.')}</div>`;
          }
        } else if (context.channelId) {
          await setChannel(context.channelId);
        }
        return;
      }
      await loadChannels();
    }
    root.Portal?.navigation?.registerSchema?.('channelProfile', {});
    root.Portal?.navigation?.registerSchema?.('channelProfileChannel', {});
    const removeProfileHandler = root.Portal?.navigation?.registerHandler?.(`channels-profile-${Math.random().toString(36).slice(2)}`, {
      priority:195, apply:route => {
        if (route.channelProfile && route.channelProfileChannel === state.activeChannelId && mode !== 'list') { if (profilePanel?.dataset.userId !== route.channelProfile) showFullProfile({id:route.channelProfile}, {silent:true}); }
        else closeProfilePanel({silent:true});
      }
    });
    root.Portal?.navigation?.registerSchema?.('huddleWindow', {values:['full','floating','docked','minimized']});
    root.Portal?.navigation?.registerSchema?.('huddlePinned', {values:['1']});
    root.Portal?.navigation?.registerSchema?.('huddleFullscreen', {values:['1']});
    const removeHuddleRouteHandler = root.Portal?.navigation?.registerHandler?.(`channels-huddle-${Math.random().toString(36).slice(2)}`, {
      priority:250,
      apply(route){
        if (!state.huddle) return;
        const mode = route.huddleWindow || (route.huddleFullscreen === '1' ? 'full' : state.huddleWindow?.state.mode || 'floating');
        state.huddleWindow?.setMode(mode,{silent:true});
        if (route.huddlePinned != null) state.huddleWindow?.setPinned(route.huddlePinned === '1',{silent:true});
        state.huddleFullscreen=mode === 'full'; state.huddleMinimized=mode === 'minimized';
        if (mode === 'docked') detachCall();
      }
    });
    boot();

    const instance = {
      destroy(){
        state.clipCleanup?.();
        if (state.huddle?.id) api.huddles.leave(orgId, state.huddle.id).catch(() => {});
        removeHuddleRouteHandler?.();
        removeProfileHandler?.();
        profileWidthObserver?.disconnect();
        closeProfilePanel({silent:true});
        state.destroyed = true;
        mobileMedia?.removeEventListener?.('change', onMobileMediaChange);
        document.removeEventListener('click', onDocumentClickCloseHeaderMenu);
        document.removeEventListener('keydown', keyboardHandler);
        root.removeEventListener('fm:channels-sidebar-sections-updated', sidebarSectionsUpdatedHandler);
        stopHuddleSession();
        root.removeEventListener('fm:user-preferences:updated', handlePreferencesUpdated);
        state.unsubscribe?.();
        clearTimeout(state.markReadTimer);
        closePopover();
        if (externalHeaderActions) externalHeaderActions.replaceChildren();
        container.innerHTML = '';
      },
      detachCall,
      setChannel: (channelId, opts) => setChannel(channelId, opts),
      revealMessage: (messageId) => {
        if (state.revealTarget !== messageId) {
          state.revealTarget = '';
          revealMessage(messageId);
        }
      },
      openThread: (rootId) => openThread(rootId),
      openView(view){
        if (view === 'unreads') return openUnreadsView();
        if (view === 'activity') return openActivityView();
        if (view === 'threads') return openThreadsView();
        if (view === 'saved') return openSavedView();
      },
      refresh: () => { loadChannels(); refreshActiveMessages(); },
      setFeatures(patch){
        Object.assign(features, patch || {});
        renderHeader();
        renderMessages();
        renderComposer();
        renderSidebar();
      },
      update(){ /* portal tab activation hook */ },
      get state(){ return { activeChannelId: state.activeChannelId, view: state.view, threadRootId: state.threadRootId, inCall:Boolean(state.huddle) }; }
    };
    return instance;
  }

  root.FirstMateChannels = { create, EMOJI_SET, DEFAULT_FEATURES };
})();
