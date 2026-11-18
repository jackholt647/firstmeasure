/*
 * Phone and messages: the development test mode of calls and texts (FM-538). The phone, the call center and a
 * project's Comms tab look as they do in production; what test mode does, onboarding the test line, and simulating
 * the customer replying are here instead. Reads voice/status through the portal's CustomerPhone; redraws when the
 * phone's status changes (fm:customer-calls:changed). No stream of its own.
 */
export function mount(root, { T, esc, toast }) {
  const ui = () => window.Portal?.CommunicationsUI;
  const phone = () => window.Portal?.CustomerPhone;
  const format = (number) => window.Portal?.PhoneTray?.formatPhone?.(number) || String(number || '');
  const LABELS = {
    brand: T('dc_comms_brand', 'Brand registration'),
    campaign_10dlc: T('dc_comms_campaign', '10DLC campaign'),
    number: T('dc_comms_number', 'Phone number'),
    voice: T('dc_comms_voice', 'Calling')
  };
  // The project window is its own document: find the Comms tab that is open in this page or one of its frames.
  function commsTab() {
    const views = [window];
    for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentWindow?.Portal) views.push(frame.contentWindow); } catch (_) {} }
    for (const view of views) {
      const tab = view.Portal?.modules?.commsTab;
      if (tab?.simulateInbound && tab.context?.().mounted) return tab;
    }
    return null;
  }
  let token = 0, busy = false;
  // refreshStatus() announces fm:customer-calls:changed, which redraws from the status it just read.
  async function render(fresh = true) {
    const mine = ++token;
    let status = phone()?.status || null;
    if (fresh) { try { status = await phone()?.refreshStatus?.() || status; } catch (_) {} }
    if (mine !== token || !root.isConnected) return;
    const dev = status?.development || null;
    const tab = commsTab();
    const channels = tab?.context?.().channels || {};
    const registrations = Object.entries(dev?.registrations || {});
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_comms_intro', 'Calls and texts look as they do in production. What development test mode does to them is shown here.'))}</p>
      ${!phone() ? `<p class="fm-dc-empty">${esc(T('dc_comms_no_phone', 'Calling is not loaded on this page.'))}</p>`
      : !dev?.enabled ? `<p class="fm-dc-note">${esc(T('dc_comms_off', 'Test mode is off for this organization: calls and texts are delivered.'))}</p>`
      : `<h3 class="fm-dc-h">${esc(T('dc_comms_test_mode', 'Test mode'))} <span class="fm-dc-badge fm-dc-ok">${esc(T('dc_comms_on', 'on'))}</span></h3>
        <ul class="fm-dc-list">
          <li class="fm-dc-row"><span><strong>${esc(T('dc_comms_ring', 'Approved test phones ring directly'))}</strong><small>${esc((dev.destinations || []).map(format).join(', ') || '—')}</small></span></li>
          <li class="fm-dc-row"><span><strong>${esc(T('dc_comms_route', 'Every other call routes to'))}</strong><small>${esc(format(dev.destination) || '—')}</small></span></li>
          <li class="fm-dc-row"><span><strong>${esc(T('dc_comms_messages', 'Messages'))}</strong><small>${esc(T('dc_comms_messages_how', 'Outbound email and texts are recorded on the project but not sent to the customer.'))}</small></span></li>
          ${registrations.map(([key, value]) => `<li class="fm-dc-row"><span>${esc(LABELS[key] || key)}</span><span class="fm-dc-badge">${esc(String(value).replace(/_/g, ' '))}</span></li>`).join('')}
          <li class="fm-dc-row"><span>${esc(T('dc_comms_onboarded', 'Onboarded for development'))}</span><span class="fm-dc-badge${dev.onboarded ? ' fm-dc-ok' : ' fm-dc-changed'}">${esc(dev.onboarded ? T('dc_comms_yes', 'yes') : T('dc_comms_no', 'no'))}</span></li>
        </ul>
        ${!dev.onboarded && status?.permissions?.manage ? `<div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-comms-onboard><i class="fas fa-forward" aria-hidden="true"></i> ${esc(T('dc_comms_onboard', 'Skip to fully onboarded'))}</button></div>
        <p class="fm-dc-sub">${esc(T('dc_comms_onboard_how', 'Mock brand and 10DLC campaign approved, test line connected.'))}</p>` : ''}`}
      <h3 class="fm-dc-h">${esc(T('dc_comms_reply', 'Customer reply'))}</h3>
      ${tab && (channels.email || channels.sms) ? `<p class="fm-dc-sub">${esc(T('dc_comms_reply_how', 'Arrives on the open project as if the customer wrote it, for notifications, automations and AI.'))}</p>
        <div class="fm-dc-fields"><label class="fm-dc-field">${esc(T('dc_comms_channel', 'Channel'))}<select data-comms-channel>${channels.sms ? `<option value="sms">${esc(T('dc_comms_text', 'Text'))}</option>` : ''}${channels.email ? `<option value="email">${esc(T('dc_comms_email', 'Email'))}</option>` : ''}</select></label></div>
        <label class="fm-dc-field">${esc(T('dc_comms_reply_text', 'Message'))}<textarea class="fm-dc-input" rows="3" data-comms-text></textarea></label>
        <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-comms-simulate><i class="fas fa-reply" aria-hidden="true"></i> ${esc(T('dc_comms_simulate', 'Simulate reply'))}</button></div>`
      : `<p class="fm-dc-empty">${esc(T('dc_comms_open_project', 'Open a project\'s Comms tab to simulate the customer replying.'))}</p>`}
      <p class="fm-dc-error" role="alert" data-comms-error></p>`;
    root.querySelector('[data-comms-onboard]')?.addEventListener('click', async (event) => {
      if (busy) return; busy = true; event.currentTarget.disabled = true;
      try {
        const result = await ui().request('voice/development/onboard', {});
        window.dispatchEvent(new CustomEvent('fm:comms:development-changed', { detail: result.development || { onboarded: true } }));
        await window.AppChrome?.load?.();
        toast(T('dc_comms_onboarded_done', 'Onboarded for development'));
      } catch (error) { root.querySelector('[data-comms-error]').textContent = error.message; }
      busy = false; render();
    });
    root.querySelector('[data-comms-simulate]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget, text = root.querySelector('[data-comms-text]').value.trim();
      if (busy || !text) return; busy = true; button.disabled = true;
      try {
        await commsTab()?.simulateInbound({ channel: root.querySelector('[data-comms-channel]').value, text });
        root.querySelector('[data-comms-text]').value = '';
        toast(T('dc_comms_simulated', 'Customer reply added'));
      } catch (error) { root.querySelector('[data-comms-error]').textContent = error.message; }
      busy = false; button.disabled = false;
    });
  }
  window.addEventListener('fm:customer-calls:changed', () => { if (root.isConnected && !root.closest('[hidden]') && !busy) render(false); });
  render();
  return { shown: render };
}
