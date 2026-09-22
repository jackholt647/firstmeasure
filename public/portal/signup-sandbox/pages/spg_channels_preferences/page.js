(function () {
  'use strict';
  window.SignupSandboxPages = window.SignupSandboxPages || {};
  function styles(){const existing=document.getElementById('channels-onboarding-styles');if(existing?.tagName==='LINK')return;existing?.remove();const s=document.createElement('link');s.id='channels-onboarding-styles';s.rel='stylesheet';s.href='/portal/signup-sandbox/pages/channels-onboarding.css?v=20260805';document.head.appendChild(s)}
  window.SignupSandboxPages.spg_channels_preferences = {
    render(container, ctx) {
      styles();
      const choice = (id, icon, title, copy, checked = true) => `<label class="cho-choice"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span><strong><i class="cho-choice-icon fa-solid ${icon}"></i>${title}</strong><small>${copy}</small></span></label>`;
      container.innerHTML = `
        <div class="cho"><div class="cho-kicker">Workspace defaults</div><h1>How should your team collaborate?</h1>
        <p class="cho-lead">Set company-wide starting points. Every teammate can still personalize their own notification and message preferences.</p>
        <div class="cho-grid">
          <div class="cho-field"><label>Default notifications</label><select id="choNotify"><option value="mentions">Mentions and replies</option><option value="all">Every new message</option><option value="muted">Nothing</option></select></div>
          <div class="cho-field"><label>Send messages with</label><select id="choSend"><option value="enter">Enter</option><option value="modified_enter">Ctrl/Cmd + Enter</option></select></div>
          <div class="cho-field wide"><div class="cho-stack">
            ${choice('choAi', 'fa-wand-magic-sparkles', 'FirstMate AI', 'Let the assistant answer questions, summarize conversations, and help draft messages.')}
            ${choice('choRecording', 'fa-record-vinyl', 'Retain huddle recordings', 'Save recorded huddles and transcripts back to the channel.', false)}
            ${choice('choVideo', 'fa-video', 'Include video and shared screens', 'When recording is on, retain cameras and screen shares too.', false)}
            ${choice('choExternal', 'fa-building-user', 'External guests', 'Allow approved people outside your company into explicitly shared conversations.', false)}
          </div></div>
        </div>
        <div class="cho-actions"><button class="cho-primary" id="choContinue">Save defaults <i class="fa-solid fa-arrow-right"></i></button></div></div>`;
      const recording = container.querySelector('#choRecording');
      const video = container.querySelector('#choVideo');
      const sync = () => { video.disabled = !recording.checked; if (!recording.checked) video.checked = false; };
      recording.addEventListener('change', sync); sync();
      container.querySelector('#choContinue').addEventListener('click', () => ctx.complete({
        app_flags: {
          'channels.ai': container.querySelector('#choAi').checked,
          'channels.recording': recording.checked,
          'channels.record_video': video.checked,
          'channels.external': container.querySelector('#choExternal').checked
        },
        settings: {
          'channels_onboarding.default_notify_level': container.querySelector('#choNotify').value,
          'channels_onboarding.send_mode': container.querySelector('#choSend').value
        }
      }));
    }
  };
})();
