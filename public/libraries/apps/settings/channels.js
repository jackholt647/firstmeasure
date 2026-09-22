/* Channels settings tab: org-wide channel management (create, rename, archive,
 * restore), permission guidance, and pointers to the capability toggles that
 * turn individual Channels features on and off. Backed entirely by
 * window.ChannelsAPI — the same client the Channels app and project-notes
 * embeds use. */
(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function injectCss(){
    if (document.getElementById('fmChannelsSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmChannelsSettingsCss';
    style.textContent = `
      .chs-root{color:#17212b;min-height:420px}
      .chs-root *{box-sizing:border-box}
      .chs-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
      .chs-head-copy h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em;display:flex;align-items:center;gap:11px}
      .chs-head-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:16px;flex:0 0 auto}
      .chs-head-copy p{margin:7px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:560px}
      .chs-actions-top{display:flex;gap:8px;padding-top:6px;flex-wrap:wrap}
      .chs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start;margin-top:16px}
      .chs-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04);padding:18px;min-width:0}
      .chs-card.wide{grid-column:1/-1}
      .chs-card-head strong{font-size:13.5px;color:#101828;display:flex;align-items:center;gap:8px}
      .chs-card-head strong i{color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
      .chs-card-head p{margin:5px 0 0;color:#667085;font-size:11.5px;line-height:1.5;font-weight:650}
      .chs-btn{border:1px solid #d8dee8;background:#fff;border-radius:9px;cursor:pointer;font:850 12.5px/1 inherit;padding:10px 16px;color:#344054}
      .chs-btn:hover{background:#f7f8fa}
      .chs-btn.primary{background:var(--primary-readable,var(--primary,#d93025));border-color:transparent;color:#fff}
      .chs-btn.small{padding:6px 10px;font-size:11.5px}
      .chs-row{display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid #f0f2f5}
      .chs-row:last-child{border-bottom:none}
      .chs-row .icon{width:26px;text-align:center;color:#667085;flex:0 0 auto}
      .chs-row .name{flex:1;min-width:0;font-weight:800;font-size:13px;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .chs-row .name small{display:block;font-weight:650;color:#667085;font-size:11px}
      .chs-row.archived .name{color:#98a2b3;text-decoration:line-through}
      .chs-pill{font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;border:1px solid #e4e7ec;border-radius:999px;padding:2px 8px;color:#667085;flex:0 0 auto}
      .chs-empty{color:#667085;font-size:12px;font-weight:650;padding:14px 4px}
      .chs-loading{display:grid;place-items:center;min-height:280px;color:#667085;font-size:12px;font-weight:850}
      .chs-note{margin-top:10px;font-size:11.5px;color:#667085;line-height:1.55;font-weight:650}
      .chs-note a{color:var(--primary-readable,var(--primary,#d93025));font-weight:800;cursor:pointer}
      .chs-perm{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f2f5}
      .chs-perm:last-child{border-bottom:none}
      .chs-perm code{background:#f4f6f9;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:800;color:#344054;flex:0 0 auto}
      .chs-perm span{font-size:11.5px;color:#667085;font-weight:650;line-height:1.5}
      .chs-pref-list{display:grid;gap:12px;margin-top:14px}
      .chs-pref-row{display:flex;align-items:center;justify-content:space-between;gap:18px}
      .chs-pref-row label{font-size:12px;font-weight:800;color:#344054}
      .chs-pref-row small{display:block;margin-top:3px;color:#667085;font-size:10.5px;font-weight:650}
      .chs-pref-row select{min-width:180px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:8px 10px;font:750 12px/1.2 inherit;color:#344054}
      .chs-switch{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:#344054}
      .chs-switch input{width:17px;height:17px;accent-color:var(--primary-readable,var(--primary,#d93025))}
      @media (max-width:900px){.chs-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function mount(pane, options = {}){
    injectCss();
    const orgId = String(options.orgId || root.__APP?.userOrgId || '').trim();
    const api = root.ChannelsAPI;
    const toast = typeof options.showToast === 'function' ? options.showToast : () => {};
    pane.innerHTML = `<div class="chs-loading">${(globalThis.PlatformLanguage?.text("settings","m_c7905f57f9bef9","Loading channel settings…") ?? "Loading channel settings…")}</div>`;

    async function load(){
      let channels = [];
      let preferences = {};
      try {
        const [data, preferenceData] = await Promise.all([
          api.channels.list(orgId, { include_archived: 1 }),
          api.preferences?.collaboration?.(orgId).catch(() => ({ preferences:{} }))
        ]);
        channels = data.channels || [];
        preferences = preferenceData?.preferences || {};
      } catch (error) {
        pane.innerHTML = `<div class="chs-loading">${esc(error?.message || 'Channels could not be loaded.')}</div>`;
        return;
      }
      render(channels, preferences);
    }

    function channelRow(channel){
      const icon = channel.type === 'private' ? 'fa-lock' : channel.type === 'project' ? 'fa-folder' : 'fa-hashtag';
      const archived = Boolean(channel.archived_at);
      return `
        <div class="chs-row${String(archived ? ' archived' : '')}" data-channel="${String(esc(channel.id))}">
          <span class="icon"><i class="fas ${String(icon)}"></i></span>
          <span class="name">${String(esc(channel.display_name || channel.name))}<small>${((v4,v5) => globalThis.PlatformLanguage?.text("settings","m_cc5d9caa3b69a6",`${v4} members${v5}`,{v4,v5}) ?? `${v4} members${v5}`)(channel.member_count || 0,channel.topic ? ` · ${esc(channel.topic)}` : '')}</small></span>
          ${String(channel.type === 'private' ? '<span class="chs-pill">Private</span>' : '')}
          ${String(archived ? '<span class="chs-pill">Archived</span>' : '')}
          ${String(channel.type !== 'project' ? `<button class="chs-btn small" data-act="${archived ? 'unarchive' : 'archive'}">${archived ? 'Restore' : 'Archive'}</button>` : '')}
        </div>`;
    }

    function render(channels, preferences = {}){
      const team = channels.filter((channel) => ['public', 'private'].includes(channel.type));
      const projects = channels.filter((channel) => channel.type === 'project');
      const huddleRecordingEnabled = root.Portal?.capabilities?.value?.('channels.recording', false) === true;
      // Preserve the configured child policy while retention is off. The
      // effective value is false whenever its parent is disabled, but that
      // should not make the Settings control look like the policy was reset.
      const capabilityState = root.Portal?.capabilities?.current?.() || {};
      const rawVideoRecording = capabilityState?.raw?.['channels.record_video'];
      const videoRecordingDefault = root.Portal?.capabilities?.definition?.('channels.record_video')?.default;
      const huddleVideoRecordingEnabled = rawVideoRecording === undefined
        ? videoRecordingDefault !== false
        : rawVideoRecording === true;
      pane.innerHTML = `
        <div class="chs-root">
          <div class="chs-head">
            <div class="chs-head-copy">
              <h3><span class="chs-head-icon"><i class="fas fa-hashtag"></i></span>${(globalThis.PlatformLanguage?.text("settings","m_bebb358d67ea41"," Channels") ?? " Channels")}</h3>
              <p>${(globalThis.PlatformLanguage?.text("settings","m_fb7493b5014d0e","Internal team messaging: channels, threads, reactions, direct messages, and per-project message threads. Manage the org-wide channel list here.") ?? "Internal team messaging: channels, threads, reactions, direct messages, and per-project message threads. Manage the org-wide channel list here.")}</p>
            </div>
            <div class="chs-actions-top">
              <button class="chs-btn" id="chsOpenApp"><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.text("settings","m_4cb9e31714b89c"," Open Channels") ?? " Open Channels")}</button>
              <button class="chs-btn primary" id="chsCreate"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_b325c4ac4d5599"," New channel") ?? " New channel")}</button>
            </div>
          </div>
          <div class="chs-grid">
            <div class="chs-card wide">
              <div class="chs-card-head"><strong><i class="fas fa-hashtag"></i>${(globalThis.PlatformLanguage?.text("settings","m_ab3fbcb19bd5ed"," Team channels") ?? " Team channels")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_cc4d3edf151612","Public channels are open to everyone in the company; private channels are invite-only. Archiving hides a channel and locks new messages without deleting history.") ?? "Public channels are open to everyone in the company; private channels are invite-only. Archiving hides a channel and locks new messages without deleting history.")}</p></div>
              <div id="chsTeamList">${String(team.length ? team.map(channelRow).join('') : '<div class="chs-empty">No channels yet — create the first one.</div>')}</div>
            </div>
            <div class="chs-card">
              <div class="chs-card-head"><strong><i class="fas fa-user-shield"></i>${(globalThis.PlatformLanguage?.text("settings","m_9e683e58247212"," Permissions") ?? " Permissions")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_656b94e3524e0c","Grant these in user permission sets (Settings → Users).") ?? "Grant these in user permission sets (Settings → Users).")}</p></div>
              <div class="chs-perm"><code>${(globalThis.PlatformLanguage?.text("settings","m_a4c36d4228f838","create_channels") ?? "create_channels")}</code><span>${(globalThis.PlatformLanguage?.text("settings","m_f33f158a12c9f3","Create public and private channels. Owners and admins always can.") ?? "Create public and private channels. Owners and admins always can.")}</span></div>
              <div class="chs-perm"><code>${(globalThis.PlatformLanguage?.text("settings","m_5f557f484e28f6","manage_channels") ?? "manage_channels")}</code><span>${(globalThis.PlatformLanguage?.text("settings","m_a20984ac87e216","Edit or archive any channel, manage members, and remove or restore anyone's message. Editing stays author-only for everyone.") ?? "Edit or archive any channel, manage members, and remove or restore anyone's message. Editing stays author-only for everyone.")}</span></div>
              <div class="chs-note">${(globalThis.PlatformLanguage?.text("settings","m_ee0e0c24230d26","Message authorship is enforced server-side: only the person who wrote a message can edit it, ever.") ?? "Message authorship is enforced server-side: only the person who wrote a message can edit it, ever.")}</div>
            </div>
            <div class="chs-card">
              <div class="chs-card-head"><strong><i class="fas fa-toggle-on"></i>${(globalThis.PlatformLanguage?.text("settings","m_5539ab93aa7a52"," Features") ?? " Features")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_24941aa4ad361a","Threads, reactions, DMs, attachments, pins, and search are individual capability flags.") ?? "Threads, reactions, DMs, attachments, pins, and search are individual capability flags.")}</p></div>
              <div class="chs-note">${(globalThis.PlatformLanguage?.text("settings","m_aa00d6f0409fa0","Toggle Channels features per-organization in ") ?? "Toggle Channels features per-organization in ")}<a id="chsOpenFlags">${(globalThis.PlatformLanguage?.text("settings","m_cc445c917318c1","Features &amp; Apps") ?? "Features &amp; Apps")}</a>${(globalThis.PlatformLanguage?.text("settings","m_d1aa801311165f"," under the “Communications” category (keys starting with ") ?? " under the “Communications” category (keys starting with ")}<code>${(globalThis.PlatformLanguage?.text("settings","m_3fc867806515a5","channels.") ?? "channels.")}</code>).</div>
            </div>
            <div class="chs-card wide">
              <div class="chs-card-head"><strong><i class="fas fa-record-vinyl"></i>${(globalThis.PlatformLanguage?.text("settings","m_f9eec5552531d5"," Huddle retention") ?? " Huddle retention")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_f2d903f955925d","When enabled, huddles retain their mixed audio and can include cameras and shared screens. A visible recording indicator appears for everyone, and the result is retained in the huddle conversation and channel files.") ?? "When enabled, huddles retain their mixed audio and can include cameras and shared screens. A visible recording indicator appears for everyone, and the result is retained in the huddle conversation and channel files.")}</p></div>
              <div class="chs-pref-list">
                <div class="chs-pref-row">
                  <div><label for="chsRecordHuddles">${(globalThis.PlatformLanguage?.text("settings","m_8448509a8602f7","Retain huddle recordings") ?? "Retain huddle recordings")}</label><small>${(globalThis.PlatformLanguage?.text("settings","m_4a5d2f8c4c7927","Organization-wide. Turn this off to keep huddles live-only.") ?? "Organization-wide. Turn this off to keep huddles live-only.")}</small></div>
                  <label class="chs-switch"><input id="chsRecordHuddles" type="checkbox" ${String(huddleRecordingEnabled ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_6184a3f1c019ec"," Record huddles") ?? " Record huddles")}</label>
                </div>
                <div class="chs-pref-row">
                  <div><label for="chsRecordHuddleVideo">${(globalThis.PlatformLanguage?.text("settings","m_c0fafd4c71c164","Include video and shared screens") ?? "Include video and shared screens")}</label><small>${(globalThis.PlatformLanguage?.text("settings","m_8edacd3ed2648a","Audio-only huddles still work normally when nobody enables a camera or screen.") ?? "Audio-only huddles still work normally when nobody enables a camera or screen.")}</small></div>
                  <label class="chs-switch"><input id="chsRecordHuddleVideo" type="checkbox" ${String(huddleVideoRecordingEnabled ? 'checked' : '')} ${String(huddleRecordingEnabled ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.text("settings","m_2d17177a23d2ec"," Record video") ?? " Record video")}</label>
                </div>
              </div>
            </div>
            <div class="chs-card wide">
              <div class="chs-card-head"><strong><i class="fas fa-bell"></i>${(globalThis.PlatformLanguage?.text("settings","m_55539f4f3c8f55"," Your channel preferences") ?? " Your channel preferences")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_a306c13ae7d201","These preferences follow your account and apply on every device.") ?? "These preferences follow your account and apply on every device.")}</p></div>
              <div class="chs-pref-list">
                <div class="chs-pref-row">
                  <div><label for="chsDefaultNotifications">${(globalThis.PlatformLanguage?.text("settings","m_ed01a1da4c98c1","Default notifications") ?? "Default notifications")}</label><small>${(globalThis.PlatformLanguage?.text("settings","m_250e156ead090a","Individual channel choices can override this.") ?? "Individual channel choices can override this.")}</small></div>
                  <select id="chsDefaultNotifications">
                    <option value="all">${(globalThis.PlatformLanguage?.text("settings","m_6275935eadd8a4","All new messages") ?? "All new messages")}</option>
                    <option value="mentions">${(globalThis.PlatformLanguage?.text("settings","m_722ecd47834278","Mentions and replies") ?? "Mentions and replies")}</option>
                    <option value="muted">${(globalThis.PlatformLanguage?.text("settings","m_3c7c4f2cd743b8","Nothing") ?? "Nothing")}</option>
                  </select>
                </div>
                <div class="chs-pref-row">
                  <div><label for="chsSendMode">${(globalThis.PlatformLanguage?.text("settings","m_10b3b04881d2ff","Send messages with") ?? "Send messages with")}</label><small>${(globalThis.PlatformLanguage?.text("settings","m_b1f07f61089504","The other key combination inserts a new line.") ?? "The other key combination inserts a new line.")}</small></div>
                  <select id="chsSendMode">
                    <option value="enter">${(globalThis.PlatformLanguage?.text("settings","m_92c001f63daac8","Enter") ?? "Enter")}</option>
                    <option value="modified_enter">${(globalThis.PlatformLanguage?.text("settings","m_a34f170b65e07e","Ctrl/Cmd + Enter") ?? "Ctrl/Cmd + Enter")}</option>
                  </select>
                </div>
                <div class="chs-pref-row">
                  <div><label for="chsDnd">${(globalThis.PlatformLanguage?.text("settings","m_be9029a365cbbe","Pause notifications") ?? "Pause notifications")}</label><small>${(globalThis.PlatformLanguage?.text("settings","m_58b5ec56db50e3","Activity remains available for you to review later.") ?? "Activity remains available for you to review later.")}</small></div>
                  <label class="chs-switch"><input id="chsDnd" type="checkbox">${(globalThis.PlatformLanguage?.text("settings","m_fcfd131557bcd7"," Do not disturb") ?? " Do not disturb")}</label>
                </div>
              </div>
            </div>
            <div class="chs-card wide">
              <div class="chs-card-head"><strong><i class="fas fa-folder"></i>${(globalThis.PlatformLanguage?.text("settings","m_e1fc3bc4c3c18e"," Project message threads") ?? " Project message threads")}</strong><p>${(globalThis.PlatformLanguage?.text("settings","m_387d32582f5cb6","Each project gets its own message thread, shown in the project's Notes area and under “Project messages” in the Channels app. These are created automatically and follow project access.") ?? "Each project gets its own message thread, shown in the project's Notes area and under “Project messages” in the Channels app. These are created automatically and follow project access.")}</p></div>
              <div id="chsProjectList">${String(projects.length ? projects.slice(0, 12).map(channelRow).join('') : '<div class="chs-empty">No project messages yet.</div>')}</div>
            </div>
          </div>
        </div>`;

      const defaultNotifications = pane.querySelector('#chsDefaultNotifications');
      const sendMode = pane.querySelector('#chsSendMode');
      const dnd = pane.querySelector('#chsDnd');
      const recordHuddles = pane.querySelector('#chsRecordHuddles');
      const recordHuddleVideo = pane.querySelector('#chsRecordHuddleVideo');
      if (defaultNotifications) defaultNotifications.value = preferences.default_notify_level || 'mentions';
      if (sendMode) sendMode.value = preferences.send_mode || 'enter';
      if (dnd) dnd.checked = Boolean(preferences.dnd?.enabled);
      const savePreferences = async () => {
        try {
          const result = await api.preferences.updateCollaboration(orgId, {
            default_notify_level: defaultNotifications?.value || 'mentions',
            send_mode: sendMode?.value || 'enter',
            dnd: { ...(preferences.dnd || {}), enabled: Boolean(dnd?.checked) }
          });
          preferences = result.preferences || preferences;
          toast((globalThis.PlatformLanguage?.text("settings","m_cefcdc24fac431","Channel preferences saved.") ?? "Channel preferences saved."));
        } catch (error) {
          toast(error?.message || 'Channel preferences could not be saved.', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error"));
        }
      };
      [defaultNotifications, sendMode, dnd].forEach((control) => control?.addEventListener('change', savePreferences));
      recordHuddles?.addEventListener('change', async () => {
        const enabled = Boolean(recordHuddles.checked);
        recordHuddles.disabled = true;
        try {
          await root.Portal?.capabilities?.update?.({
            'channels.recording': enabled,
            ...(enabled ? { 'channels.record_video': Boolean(recordHuddleVideo?.checked) } : {})
          });
          if (recordHuddleVideo) recordHuddleVideo.disabled = !enabled;
          toast(enabled ? 'Huddle recording enabled.' : 'Huddles are now live-only.');
        } catch (error) {
          recordHuddles.checked = !enabled;
          toast(error?.message || 'Huddle recording could not be updated.', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error"));
        } finally {
          recordHuddles.disabled = false;
        }
      });
      recordHuddleVideo?.addEventListener('change', async () => {
        const enabled = Boolean(recordHuddleVideo.checked);
        recordHuddleVideo.disabled = true;
        try {
          await root.Portal?.capabilities?.update?.({ 'channels.record_video': enabled });
          toast(enabled ? 'Huddle video recording enabled.' : 'Huddle recordings will retain audio only.');
        } catch (error) {
          recordHuddleVideo.checked = !enabled;
          toast(error?.message || 'Huddle video recording could not be updated.', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error"));
        } finally {
          recordHuddleVideo.disabled = !recordHuddles?.checked;
        }
      });

      pane.querySelector('#chsOpenApp')?.addEventListener('click', () => {
        root.Portal?.navigation?.navigate?.({ tab: 'channels' }, { ownedKeys: ['tab'] });
      });
      pane.querySelector('#chsOpenFlags')?.addEventListener('click', () => {
        root.Portal?.navigation?.navigate?.({ tab: 'company_settings', sub: 'app_flags' }, { ownedKeys: ['tab', 'sub'] });
      });
      pane.querySelector('#chsCreate')?.addEventListener('click', () => {
        const list = pane.querySelector('#chsTeamList');
        if (!list || list.querySelector('.chs-create-row')) return;
        const row = document.createElement('div');
        row.className = 'chs-row chs-create-row';
        row.innerHTML = `
          <span class="icon"><i class="fas fa-hashtag"></i></span>
          <input type="text" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_2e0e0d6bedcbd2","channel-name") ?? "channel-name")}" style="flex:1;min-width:0;border:1px solid #d0d5dd;border-radius:9px;padding:8px 11px;font:800 12.5px/1.4 inherit;color:#344054;outline:0">
          <button class="chs-btn small" data-create-confirm>${(globalThis.PlatformLanguage?.text("settings","m_3c21a9590eb762","Create") ?? "Create")}</button>
          <button class="chs-btn small" data-create-cancel>${(globalThis.PlatformLanguage?.text("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>`;
        list.prepend(row);
        const input = row.querySelector('input');
        input.focus();
        const create = async () => {
          const name = input.value.trim();
          if (!name) return;
          try {
            await api.channels.create(orgId, { type: 'public', name, topic: '', member_user_ids: [] });
            toast((globalThis.PlatformLanguage?.text("settings","m_b2e747cd5b2c44","Channel created.") ?? "Channel created."));
            load();
          } catch (error) {
            toast(error?.message || 'The channel could not be created.', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error"));
          }
        };
        row.querySelector('[data-create-confirm]').addEventListener('click', create);
        row.querySelector('[data-create-cancel]').addEventListener('click', () => row.remove());
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') create();
          if (event.key === 'Escape') row.remove();
        });
      });
      pane.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-act]');
        if (!button) return;
        const channelId = button.closest('[data-channel]')?.dataset.channel;
        if (!channelId) return;
        try {
          if (button.dataset.act === 'archive') await api.channels.archive(orgId, channelId);
          else if (button.dataset.act === 'unarchive') await api.channels.unarchive(orgId, channelId);
          load();
        } catch (error) {
          toast(error?.message || 'That change could not be saved.', (globalThis.PlatformLanguage?.text("settings","m_7e784f9b5540ab","error") ?? "error"));
        }
      }, { once: false });
    }

    load();
  }

  root.FirstMateChannelsSettings = { mount };
})(window);
