(function () {
  'use strict';
  window.SignupSandboxPages = window.SignupSandboxPages || {};
  function styles(){const existing=document.getElementById('channels-onboarding-styles');if(existing?.tagName==='LINK')return;existing?.remove();const s=document.createElement('link');s.id='channels-onboarding-styles';s.rel='stylesheet';s.href='/portal/signup-sandbox/pages/channels-onboarding.css?v=20260805';document.head.appendChild(s)}
  window.SignupSandboxPages.spg_channels_structure = {
    render(container, ctx) {
      styles();
      const channels = [
        { name: 'general', topic: 'Company-wide conversation and updates', visibility: 'public', locked: true },
        { name: 'announcements', topic: 'Important news everyone should see', visibility: 'public' },
        { name: 'help', topic: 'Questions, answers, and team support', visibility: 'public' }
      ];
      const paint = () => {
        const list = container.querySelector('#choChannels');
        list.innerHTML = channels.map((channel, index) => `<div class="cho-chip"><div class="cho-chip-main"><span class="cho-hash">${channel.visibility === 'private' ? '<i class="fa-solid fa-lock"></i>' : '#'}</span><div><strong>${channel.name}</strong><div class="cho-note">${channel.topic}</div></div></div><div class="cho-row"><select data-visibility="${index}" aria-label="Visibility for ${channel.name}" ${channel.locked ? 'disabled' : ''}><option value="public"${channel.visibility === 'public' ? ' selected' : ''}>Public</option><option value="private"${channel.visibility === 'private' ? ' selected' : ''}>Private</option></select>${channel.locked ? '' : `<button class="cho-remove" data-remove="${index}" type="button" aria-label="Remove ${channel.name}"><i class="fa-solid fa-xmark"></i></button>`}</div></div>`).join('');
      };
      container.innerHTML = `
        <div class="cho"><div class="cho-kicker">Organize conversations</div><h1>Create your first channels</h1>
        <p class="cho-lead">Start small. You can add department, location, or project channels whenever your team needs them.</p>
        <div class="cho-stack" id="choChannels"></div>
        <div class="cho-row cho-add-row"><input id="choNewChannel" aria-label="New channel name" placeholder="e.g. marketing"><button class="cho-add" id="choAddChannel" type="button">Add channel</button></div>
        <div class="cho-actions"><button class="cho-primary" id="choContinue">Create channels <i class="fa-solid fa-arrow-right"></i></button></div></div>`;
      paint();
      container.querySelector('#choChannels').addEventListener('change', (event) => { const index = Number(event.target.dataset.visibility); if (Number.isInteger(index)) channels[index].visibility = event.target.value; });
      container.querySelector('#choChannels').addEventListener('click', (event) => { const button = event.target.closest('[data-remove]'); if (!button) return; channels.splice(Number(button.dataset.remove), 1); paint(); });
      const add = () => {
        const input = container.querySelector('#choNewChannel');
        const name = input.value.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-|-$/g, '');
        if (!name || channels.some((channel) => channel.name === name)) return;
        channels.push({ name, topic: 'A new team conversation', visibility: 'public' }); input.value = ''; paint();
      };
      container.querySelector('#choAddChannel').addEventListener('click', add);
      container.querySelector('#choNewChannel').addEventListener('keydown', (event) => { if (event.key === 'Enter') add(); });
      container.querySelector('#choContinue').addEventListener('click', () => ctx.complete({ settings: { 'channels_onboarding.starter_channels': channels } }));
    }
  };
})();
