function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCommunicationsDeveloperPage(organizationId: string) {
  const org = escapeHtml(organizationId);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Communications Test Log</title>
  <style>
    :root{--bg:#f4f6f8;--panel:#fff;--ink:#18212b;--muted:#65717f;--line:#dce2e8;--blue:#1769aa;--blue-soft:#e8f2fa;--green:#16784b;--green-soft:#e5f5ec;--red:#b42318;--red-soft:#fce9e7;--amber:#9a5b00;--amber-soft:#fff4dc}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}
    button,input,select,textarea{font:inherit;letter-spacing:0}button{cursor:pointer}.shell{min-height:100vh;display:grid;grid-template-rows:auto auto minmax(0,1fr)}
    header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 24px;border-bottom:1px solid var(--line);background:#fff}.title h1{margin:0;font-size:22px}.title p{margin:3px 0 0;color:var(--muted);font-size:12px}
    .header-actions,.toolbar,.segmented,.row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.btn{min-height:34px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);padding:7px 11px;font-weight:700}.btn:hover{border-color:#aeb8c2}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.danger{color:var(--red)}.btn.success{color:var(--green)}
    .compose{display:grid;grid-template-columns:150px minmax(180px,1fr) minmax(180px,1fr) minmax(260px,2fr) auto;gap:10px;padding:14px 24px;border-bottom:1px solid var(--line);background:#fbfcfd}.field{display:grid;gap:5px;min-width:0}.field span{font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase}.input,.select,.textarea{width:100%;min-height:36px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:7px 9px;color:var(--ink)}.textarea{resize:vertical;min-height:36px;max-height:120px}.subject-field.hidden{display:none}.compose .btn{align-self:end;min-height:36px}
    .workspace{min-height:0;display:grid;grid-template-columns:minmax(380px,44%) minmax(0,1fr)}.list-pane,.detail-pane{min-height:0;display:flex;flex-direction:column;background:#fff}.list-pane{border-right:1px solid var(--line)}.pane-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);background:#fff}.pane-head strong{font-size:13px}.count{color:var(--muted);font-size:12px}
    .seg{border:1px solid var(--line);background:#fff;padding:5px 9px;font-size:11px;font-weight:750}.seg:first-child{border-radius:5px 0 0 5px}.seg:last-child{border-radius:0 5px 5px 0}.seg+.seg{margin-left:-9px}.seg.active{background:var(--ink);border-color:var(--ink);color:#fff}
    .message-list{min-height:0;overflow:auto}.message-row{width:100%;display:grid;grid-template-columns:74px minmax(0,1fr) 92px;gap:10px;padding:12px 14px;border:0;border-bottom:1px solid #edf0f3;background:#fff;text-align:left;color:inherit}.message-row:hover{background:#f8fafb}.message-row.active{background:var(--blue-soft);box-shadow:inset 3px 0 var(--blue)}.channel{display:inline-flex;align-items:center;justify-content:center;width:fit-content;border-radius:4px;padding:3px 6px;font-size:10px;font-weight:900;text-transform:uppercase}.channel.sms{background:#e9f6ee;color:var(--green)}.channel.email{background:#e9f0fb;color:#315da8}.summary{min-width:0}.summary strong,.summary span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.summary strong{font-size:12px}.summary span{margin-top:3px;color:var(--muted);font-size:11px}.row-meta{text-align:right}.row-meta time{display:block;color:var(--muted);font-size:10px}.status{display:inline-flex;margin-top:6px;border-radius:4px;padding:2px 6px;background:#eef1f4;color:#4c5967;font-size:9px;font-weight:900;text-transform:uppercase}.status.delivered,.status.sent{background:var(--green-soft);color:var(--green)}.status.failed,.status.bounced{background:var(--red-soft);color:var(--red)}.status.queued,.status.scheduled{background:var(--amber-soft);color:var(--amber)}
    .detail-scroll{min-height:0;overflow:auto;padding:18px}.empty{display:grid;place-items:center;min-height:220px;color:var(--muted);text-align:center}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}.metric{border:1px solid var(--line);border-radius:6px;padding:10px}.metric span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;font-weight:800}.metric strong{display:block;margin-top:4px;overflow-wrap:anywhere;font-size:12px}.content-block{border:1px solid var(--line);border-radius:6px;margin-bottom:16px}.content-head{padding:9px 11px;border-bottom:1px solid var(--line);background:#f8fafb;font-size:11px;font-weight:850}.content-body{padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}.json{margin:0;max-height:440px;overflow:auto;background:#111820;color:#dce7f1;padding:14px;border-radius:5px;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:8px 11px;border:1px solid #c9dff0;background:var(--blue-soft);color:#24567d;border-radius:5px;font-size:11px}.error{border-color:#f2b8b5;background:var(--red-soft);color:var(--red)}
    @media(max-width:900px){.compose{grid-template-columns:1fr 1fr}.compose .field:last-of-type{grid-column:1/-1}.workspace{grid-template-columns:1fr;grid-template-rows:minmax(280px,45vh) minmax(400px,1fr)}.list-pane{border-right:0;border-bottom:1px solid var(--line)}}
  </style>
</head>
<body>
<main class="shell" data-org="${org}">
  <header>
    <div class="title"><h1>Communications Test Log</h1><p>Organization ${org}. Normal API requests are captured by the backend transport.</p></div>
    <div class="header-actions"><span id="modeNotice" class="notice">Capture transport</span><button class="btn" id="refreshButton" type="button">Refresh</button></div>
  </header>
  <form class="compose" id="composeForm">
    <label class="field"><span>Channel</span><select class="select" id="channel"><option value="sms">SMS</option><option value="email">Email</option></select></label>
    <label class="field"><span>Recipient</span><input class="input" id="recipient" placeholder="+12065550123" required></label>
    <label class="field subject-field hidden" id="subjectField"><span>Subject</span><input class="input" id="subject" placeholder="Project update"></label>
    <label class="field"><span>Message</span><textarea class="textarea" id="messageText" rows="1" placeholder="Write a test message" required></textarea></label>
    <button class="btn primary" id="sendButton" type="submit">Send test</button>
  </form>
  <section class="workspace">
    <div class="list-pane">
      <div class="pane-head"><div class="segmented"><button class="seg active" data-channel="" type="button">All</button><button class="seg" data-channel="sms" type="button">SMS</button><button class="seg" data-channel="email" type="button">Email</button></div><span class="count" id="messageCount">0 messages</span></div>
      <div class="message-list" id="messageList"><div class="empty">Loading messages...</div></div>
    </div>
    <div class="detail-pane">
      <div class="pane-head"><strong>Message detail</strong><div class="row-actions" id="detailActions"></div></div>
      <div class="detail-scroll" id="messageDetail"><div class="empty">Select a captured message to inspect its request, deliveries, and events.</div></div>
    </div>
  </section>
</main>
<script>
(() => {
  const orgId = document.querySelector('[data-org]').dataset.org;
  const base = '/v1/messaging';
  const state = { messages: [], selectedId: '', channel: '' };
  const el = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const csrf = () => {
    const name = 'fm_platform_session_csrf=';
    return decodeURIComponent(document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(name))?.slice(name.length) || '');
  };
  async function request(path, options = {}) {
    const response = await fetch(base + path, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.method && options.method !== 'GET' ? {'X-Platform-CSRF': csrf()} : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Request failed.');
    return data;
  }
  const formatDate = (value) => value ? new Date(value).toLocaleString() : '';
  function snippet(message) {
    const content = message.content || {};
    return String(content.text || content.subject || '').replace(/\s+/g, ' ').trim();
  }
  function renderList() {
    const rows = state.channel ? state.messages.filter((message) => message.channel === state.channel) : state.messages;
    el('messageCount').textContent = rows.length + (rows.length === 1 ? ' message' : ' messages');
    el('messageList').innerHTML = rows.length ? rows.map((message) => {
      const recipients = Array.isArray(message.recipients) ? message.recipients.map((recipient) => recipient.address).join(', ') : '';
      return '<button class="message-row ' + (message.id === state.selectedId ? 'active' : '') + '" data-message-id="' + escapeHtml(message.id) + '" type="button">' +
        '<span class="channel ' + escapeHtml(message.channel) + '">' + escapeHtml(message.channel) + '</span>' +
        '<span class="summary"><strong>' + escapeHtml(recipients || 'No recipient') + '</strong><span>' + escapeHtml(snippet(message) || 'No message body') + '</span></span>' +
        '<span class="row-meta"><time>' + escapeHtml(formatDate(message.created_at)) + '</time><span class="status ' + escapeHtml(message.status) + '">' + escapeHtml(message.status) + '</span></span></button>';
    }).join('') : '<div class="empty">No captured messages match this filter.</div>';
    document.querySelectorAll('[data-message-id]').forEach((button) => button.addEventListener('click', () => selectMessage(button.dataset.messageId)));
  }
  async function loadMessages(preserveSelection = true) {
    const result = await request('/developer/organizations/' + encodeURIComponent(orgId) + '/messages?limit=250');
    state.messages = Array.isArray(result.messages) ? result.messages : [];
    if (!preserveSelection || !state.messages.some((message) => message.id === state.selectedId)) state.selectedId = state.messages[0]?.id || '';
    renderList();
    if (state.selectedId) await selectMessage(state.selectedId, false);
  }
  async function selectMessage(messageId, rerender = true) {
    state.selectedId = messageId;
    if (rerender) renderList();
    const result = await request('/developer/organizations/' + encodeURIComponent(orgId) + '/messages/' + encodeURIComponent(messageId));
    const message = result.message;
    const sender = message.sender || {};
    const recipients = Array.isArray(message.recipients) ? message.recipients.map((recipient) => recipient.address).join(', ') : '';
    el('messageDetail').innerHTML = '<div class="detail-grid">' +
      '<div class="metric"><span>Message ID</span><strong>' + escapeHtml(message.id) + '</strong></div>' +
      '<div class="metric"><span>Status</span><strong>' + escapeHtml(message.status) + '</strong></div>' +
      '<div class="metric"><span>From</span><strong>' + escapeHtml(sender.address || '') + '</strong></div>' +
      '<div class="metric"><span>To</span><strong>' + escapeHtml(recipients) + '</strong></div>' +
      '<div class="metric"><span>Source</span><strong>' + escapeHtml(message.source?.type || '') + '</strong></div>' +
      '<div class="metric"><span>Created</span><strong>' + escapeHtml(formatDate(message.created_at)) + '</strong></div></div>' +
      '<div class="content-block"><div class="content-head">' + escapeHtml(message.content?.subject || (message.channel === 'sms' ? 'SMS body' : 'Email body')) + '</div><div class="content-body">' + escapeHtml(message.content?.text || '') + '</div></div>' +
      '<div class="content-block"><div class="content-head">Captured JSON</div><pre class="json">' + escapeHtml(JSON.stringify(message, null, 2)) + '</pre></div>';
    el('detailActions').innerHTML = '<button class="btn success" data-status="delivered" type="button">Mark delivered</button><button class="btn danger" data-status="failed" type="button">Mark failed</button>';
    document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => simulateStatus(button.dataset.status)));
  }
  async function simulateStatus(status) {
    await request('/developer/organizations/' + encodeURIComponent(orgId) + '/messages/' + encodeURIComponent(state.selectedId) + '/status', { method:'POST', body:JSON.stringify({ status, reason:'Developer test-log simulation' }) });
    await loadMessages(true);
  }
  function syncChannelForm() {
    const email = el('channel').value === 'email';
    el('subjectField').classList.toggle('hidden', !email);
    el('recipient').placeholder = email ? 'customer@example.com' : '+12065550123';
  }
  el('composeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = el('sendButton');
    button.disabled = true;
    button.textContent = 'Sending...';
    try {
      const channel = el('channel').value;
      await request('/organizations/' + encodeURIComponent(orgId) + '/messages', { method:'POST', body:JSON.stringify({
        channel,
        purpose:'customer_care',
        recipients:[{ address:el('recipient').value }],
        content:{ subject:channel === 'email' ? el('subject').value : undefined, text:el('messageText').value },
        source:{ type:'user', id:'communications_developer_page' },
        idempotency_key:'developer-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      }) });
      el('messageText').value = '';
      await loadMessages(false);
    } catch (error) {
      el('modeNotice').textContent = error.message;
      el('modeNotice').classList.add('error');
    } finally {
      button.disabled = false;
      button.textContent = 'Send test';
    }
  });
  el('channel').addEventListener('change', syncChannelForm);
  el('refreshButton').addEventListener('click', () => loadMessages(true));
  document.querySelectorAll('[data-channel]').forEach((button) => button.addEventListener('click', () => {
    state.channel = button.dataset.channel;
    document.querySelectorAll('[data-channel]').forEach((item) => item.classList.toggle('active', item === button));
    renderList();
  }));
  syncChannelForm();
  loadMessages(false).catch((error) => { el('messageList').innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
})();
</script>
</body>
</html>`;
}
