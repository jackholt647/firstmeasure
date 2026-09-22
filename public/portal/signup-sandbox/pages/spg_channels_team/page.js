(function () {
  'use strict';
  window.SignupSandboxPages = window.SignupSandboxPages || {};
  function styles(){const existing=document.getElementById('channels-onboarding-styles');if(existing?.tagName==='LINK')return;existing?.remove();const s=document.createElement('link');s.id='channels-onboarding-styles';s.rel='stylesheet';s.href='/portal/signup-sandbox/pages/channels-onboarding.css?v=20260805';document.head.appendChild(s)}
  window.SignupSandboxPages.spg_channels_team = {
    render(container, ctx) {
      styles();
      const row = (email = '', role = 'member') => `<div class="cho-row"><input type="email" data-email placeholder="teammate@company.com" value="${email}"><select data-role><option value="member"${role === 'member' ? ' selected' : ''}>Member</option><option value="admin"${role === 'admin' ? ' selected' : ''}>Workspace admin</option></select><button class="cho-remove" type="button" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></div>`;
      container.innerHTML = `
        <div class="cho"><div class="cho-kicker">Your team</div><h1>Who will you work with?</h1>
        <p class="cho-lead">Invite a few teammates now. Members can message and create channels; workspace admins can also manage people and company settings.</p>
        <div class="cho-stack" id="choInviteRows">${row()}${row()}</div>
        <button class="cho-add" id="choAddInvite" type="button"><i class="fa-solid fa-plus"></i> Add another person</button>
        <p class="cho-note">Invitations are recorded for this sandbox workflow; a production signup would email each person after you finish setup.</p>
        <div class="cho-actions"><button class="cho-primary" id="choContinue">Continue <i class="fa-solid fa-arrow-right"></i></button></div></div>`;
      const rows = container.querySelector('#choInviteRows');
      container.querySelector('#choAddInvite').addEventListener('click', () => rows.insertAdjacentHTML('beforeend', row()));
      rows.addEventListener('click', (event) => event.target.closest('.cho-remove')?.closest('.cho-row')?.remove());
      container.querySelector('#choContinue').addEventListener('click', () => {
        const invites = [...rows.querySelectorAll('.cho-row')].map((item) => ({
          email: item.querySelector('[data-email]').value.trim().toLowerCase(),
          role: item.querySelector('[data-role]').value
        })).filter((invite) => invite.email);
        ctx.complete({ settings: { 'channels_onboarding.invites': invites } });
      });
    }
  };
})();
