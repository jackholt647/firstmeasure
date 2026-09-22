(function () {
  'use strict';
  window.SignupSandboxPages = window.SignupSandboxPages || {};
  function styles(){const existing=document.getElementById('channels-onboarding-styles');if(existing?.tagName==='LINK')return;existing?.remove();const s=document.createElement('link');s.id='channels-onboarding-styles';s.rel='stylesheet';s.href='/portal/signup-sandbox/pages/channels-onboarding.css?v=20260805';document.head.appendChild(s)}
  window.SignupSandboxPages.spg_channels_launch = {
    render(container, ctx) {
      styles();
      container.innerHTML = `
        <div class="cho cho--launch">
          <div class="cho-logo"><i class="fa-solid fa-comments"></i></div>
          <div class="cho-kicker">Setup complete</div><h1>Your team workspace is ready</h1>
          <p class="cho-lead cho-launch-lead">You have everything you need to start talking, sharing files, meeting in huddles, and getting help from FirstMate AI.</p>
          <div class="cho-summary">
            <div class="cho-summary-row"><span>Product</span><strong>FirstMate Channels</strong></div>
            <div class="cho-summary-row"><span>Workspace navigation</span><strong>Channels + Settings</strong></div>
            <div class="cho-summary-row"><span>Top bar</span><strong>AI Assistant, Messages, Notifications</strong></div>
            <div class="cho-summary-row"><span>CRM and project tools</span><strong>Not included</strong></div>
          </div>
          <div class="cho-actions cho-actions--center"><button class="cho-primary" id="choContinue">Open Channels <i class="fa-solid fa-arrow-right"></i></button></div>
        </div>`;
      container.querySelector('#choContinue').addEventListener('click', () => ctx.complete({ settings: { 'channels_onboarding.completed': true } }));
    }
  };
})();
