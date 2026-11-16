/* public/libraries/apps/settings/sms-registration.js
 * SMS registration (10DLC): the Phone settings page (Settings › Phone, sub 'sms') and the registration workflow
 * (business, contact, consent, messages, number, review and submit). Moved out of settings/company.js (FM-510) so the
 * Communications setup runs the same workflow: company.js makes one with `create(env)` for its page, and
 * `open({ orgId })` opens the workflow on its own over any page, resolving with the registration when it closes.
 */
(function(){
  'use strict';
  if (window.FirstMateSmsRegistration) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const css = `
      /* Buttons as Settings draws them, for the workflow opened outside Settings. */
      [data-fm-wizard="sms-workflow"] .cs-btn{border:none;border-radius:999px;padding:12px 14px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:.16s ease}
      [data-fm-wizard="sms-workflow"] .cs-btn.primary{background:var(--primary,#d93025);color:var(--on-primary, #fff);box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.22)}
      [data-fm-wizard="sms-workflow"] .cs-btn.ghost{background:#fff;border:1px solid rgba(0,0,0,0.14);color:#333}
      [data-fm-wizard="sms-workflow"] .cs-btn.ghost:hover{border-color:var(--primary-readable, var(--primary,#d93025));color:var(--primary-readable, var(--primary,#d93025))}
      .sms-auto-status:empty{display:none}
      .sms-card{display:grid;gap:16px}
      .sms-hero{border:1px solid #eaecf0;background:#fff;border-radius:16px;padding:18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center}
      .sms-hero h3{margin:0;font-size:20px;font-weight:1000;color:#101828}
      .sms-hero p{margin:6px 0 0;color:#667085;font-size:13px;font-weight:800;line-height:1.45}
      .sms-status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
      .sms-status-tile{border:1px solid #eaecf0;border-radius:12px;background:#f8fafc;padding:12px;display:grid;gap:5px}
      .sms-status-tile span{font-size:10px;text-transform:uppercase;letter-spacing:.35px;font-weight:1000;color:#667085}
      .sms-status-tile strong{font-size:15px;font-weight:1000;color:#101828;overflow-wrap:anywhere}
      .sms-profile-list{display:grid;gap:10px}
      .sms-profile-row{border:1px solid #eaecf0;border-radius:12px;background:#fff;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
      .sms-profile-row strong{display:block;font-size:13px;font-weight:1000;color:#101828}.sms-profile-row span{display:block;margin-top:3px;font-size:11px;font-weight:850;color:#667085}
      .sms-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:6px 9px;font-size:11px;font-weight:1000;color:#344054;text-transform:capitalize}
      .sms-badge.ok{border-color:#bbf7d0;background:#f0fdf4;color:#166534}.sms-badge.warn{border-color:#fed7aa;background:#fff7ed;color:#9a3412}.sms-badge.mock{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}
      /* 10DLC wizard chrome now comes from the shared FirstMateSetupWizard shell;
         the pane padding override keeps the original 18px workspace inset. */
      [data-fm-wizard="sms-workflow"] .fm-wizard-pane{padding:18px}
      [data-fm-wizard="sms-workflow"] .fm-wizard{grid-template-columns:minmax(0,1fr);min-width:0}
      [data-fm-wizard="sms-workflow"] .fm-wizard-body,[data-fm-wizard="sms-workflow"] .fm-wizard-head,[data-fm-wizard="sms-workflow"] .fm-wizard-rail,[data-fm-wizard="sms-workflow"] .fm-wizard-foot{min-width:0}
      .sms-workspace{display:grid;align-content:start;gap:14px}
      .sms-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.sms-form-grid .wide{grid-column:1/-1}
      [data-fm-wizard="sms-workflow"] [data-fm-note]{display:none}
      .sms-field{display:grid;min-width:0;gap:6px}.sms-field label{font-size:11px;font-weight:1000;color:#344054;text-transform:uppercase;letter-spacing:.25px}
      .sms-field input,.sms-field select,.sms-field textarea{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#101828;font:inherit;font-size:13px;font-weight:800;padding:10px 11px;outline:none}
      .sms-field textarea{min-height:94px;resize:vertical;line-height:1.45}.sms-field input:focus,.sms-field select:focus,.sms-field textarea:focus{border-color:rgba(var(--primary-rgb,217,48,37),.42);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}
      .sms-field input:disabled,.sms-field select:disabled,.sms-field textarea:disabled{background:#f8fafc;color:#475467;cursor:not-allowed}
      .sms-field.invalid input,.sms-field.invalid select,.sms-field.invalid textarea{border-color:#f97316;background:#fff7ed}
      .sms-field.invalid input:focus,.sms-field.invalid select:focus,.sms-field.invalid textarea:focus{border-color:#ea580c;box-shadow:0 0 0 4px rgba(249,115,22,.14)}
      .sms-field-msg{font-size:11px;font-weight:850;line-height:1.35;color:#667085}.sms-field.invalid .sms-field-msg{color:#9a3412}
      .sms-field-msg.ok{color:#166534}.sms-field-msg.warn{color:#9a3412}
      .pac-container{z-index:2147483647!important;font-family:inherit}
      .sms-shake{animation:smsShake .24s ease-in-out 0s 2}
      @keyframes smsShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
      .sms-feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
      .sms-feature-tile{position:relative;border:1px solid #d0d5dd;border-radius:14px;background:#fff;padding:16px;display:grid;gap:12px;min-height:178px;cursor:pointer;box-shadow:0 8px 18px rgba(15,23,42,.05);transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease,background .14s ease}
      .sms-feature-tile:hover{transform:translateY(-1px);box-shadow:0 14px 28px rgba(15,23,42,.10)}
      .sms-feature-tile input{position:absolute;right:14px;top:14px;width:22px;height:22px;accent-color:var(--primary,#d93025)}
      .sms-feature-icon{width:54px;height:54px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:#f2f4f7;color:#344054;font-size:24px;line-height:1;margin:0}
      .sms-feature-icon i{display:block;line-height:1}
      .sms-feature-copy{display:block;margin:0}.sms-feature-copy strong{display:block;font-size:16px;font-weight:1000;color:#101828;line-height:1.2;padding-right:26px}.sms-feature-copy span{display:block;margin-top:6px;font-size:12px;font-weight:800;color:#667085;line-height:1.4}
      .sms-feature-tile:has(input:checked){border-color:rgba(var(--primary-rgb,217,48,37),.48);background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08),0 14px 28px rgba(15,23,42,.08)}
      .sms-feature-tile:has(input:checked) .sms-feature-icon{background:rgba(var(--primary-rgb,217,48,37),.12);color:var(--primary,#d93025)}
      .sms-feature-tile.locked{cursor:not-allowed}.sms-feature-tile.locked:hover{transform:none}.sms-feature-tile input:disabled{cursor:not-allowed}
      .sms-number-search{border:1px solid #eaecf0;background:#fff;border-radius:14px;padding:14px;display:grid;gap:12px}
      .sms-number-search-row{display:grid;grid-template-columns:minmax(180px,280px) minmax(0,1fr);gap:10px;align-items:end}
      .sms-number-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
      .sms-number-option{border:1px solid #d0d5dd;border-radius:13px;background:#fff;padding:13px;display:grid;gap:6px;text-align:left;cursor:pointer;color:#101828}
      .sms-number-option:hover{border-color:rgba(var(--primary-rgb,217,48,37),.42);box-shadow:0 10px 22px rgba(15,23,42,.08)}
      .sms-number-option.selected{border-color:#86efac;background:#f0fdf4;box-shadow:0 0 0 3px rgba(22,101,52,.08)}
      .sms-number-option strong{font-size:17px;font-weight:1000;color:#101828}.sms-number-option span{font-size:11px;font-weight:850;color:#667085}
      .sms-number-option input{position:absolute;opacity:0;pointer-events:none}
      .sms-consent-box{border:1px solid #d0d5dd;background:#fff;border-radius:12px;padding:14px;display:grid;gap:10px}
      .sms-consent-box h4{margin:0;font-size:14px;font-weight:1000;color:#101828}.sms-consent-box p{margin:0;font-size:12px;font-weight:800;color:#667085;line-height:1.5}
      .sms-summary-checklist{border:1px solid #f5c2b8;background:#fff7f5;border-radius:12px;padding:14px;color:#7a271a;font-size:12px;line-height:1.5}
      .sms-summary-checklist.ready{border-color:#abefc6;background:#ecfdf3;color:#067647}
      .sms-summary-checklist strong{display:block;font-size:13px;margin-bottom:5px}.sms-summary-checklist ul{margin:6px 0 0;padding-left:20px;display:grid;gap:5px}
      .sms-final-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
      .sms-final-summary-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
      .sms-final-panel{border:1px solid #eaecf0;border-radius:14px;background:#fff;padding:14px;display:grid;gap:10px;align-content:start}
      .sms-final-panel h4{margin:0;font-size:13px;font-weight:1000;color:#101828;display:flex;align-items:center;gap:8px}.sms-final-panel h4 i{color:var(--primary,#d93025)}
      .sms-final-row{display:grid;gap:3px}.sms-final-row span{font-size:10px;text-transform:uppercase;letter-spacing:.28px;font-weight:1000;color:#667085}.sms-final-row strong{font-size:13px;font-weight:900;color:#101828;overflow-wrap:anywhere}
      .sms-final-features{display:flex;flex-wrap:wrap;gap:8px}
      .sms-final-feature{display:inline-flex;align-items:center;gap:7px;border:1px solid #d0d5dd;border-radius:999px;background:#f8fafc;color:#344054;padding:8px 10px;font-size:12px;font-weight:950}.sms-final-feature i{color:var(--primary,#d93025)}
      .sms-compliance-note{border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;border-radius:12px;padding:12px;display:flex;gap:10px;align-items:flex-start;font-size:12px;font-weight:850;line-height:1.45}.sms-compliance-note i{margin-top:2px}
      .sms-ack{border:1px solid #d0d5dd;border-radius:12px;background:#f8fafc;padding:12px;display:flex;align-items:flex-start;gap:10px;font-size:12px;font-weight:900;color:#344054;line-height:1.45}
      .sms-ack input{width:18px;height:18px;flex:0 0 18px;margin-top:1px;accent-color:var(--primary,#d93025)}
      .sms-ack.locked{color:#667085}.sms-ack input:disabled{cursor:not-allowed}
      .sms-submitted-panel{border:1px solid #bbf7d0;background:#f0fdf4;border-radius:16px;padding:22px;display:grid;gap:12px;align-content:start;max-width:760px}
      .sms-submitted-panel.pending,.sms-submitted-panel.verified{border-color:#bbf7d0;background:#f0fdf4}
      .sms-submitted-icon{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:#fff;color:#166534;font-size:26px;box-shadow:0 10px 22px rgba(15,23,42,.08)}
      .sms-submitted-panel.pending .sms-submitted-icon{color:#166534}.sms-submitted-panel h4{margin:0;font-size:20px;font-weight:1000;color:#101828}.sms-submitted-panel p{margin:0;color:#475467;font-size:13px;font-weight:850;line-height:1.55}
      .sms-submitted-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}.sms-submitted-meta span{display:inline-flex;align-items:center;gap:7px;border:1px solid #bbf7d0;background:#fff;color:#166534;border-radius:999px;padding:7px 10px;font-size:11px;font-weight:1000}
      .sms-review{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.sms-review-card{border:1px solid #eaecf0;border-radius:12px;background:#fff;padding:12px;display:grid;gap:7px}.sms-review-card strong{font-size:13px;font-weight:1000;color:#101828}.sms-review-card span{font-size:12px;font-weight:800;color:#667085;overflow-wrap:anywhere}
      @media(max-width:860px){.sms-hero{grid-template-columns:1fr}.sms-form-grid,.sms-review,.sms-final-grid,.sms-final-summary-grid,.sms-number-search-row{grid-template-columns:minmax(0,1fr)}}
      [data-fm-wizard="sms-workflow"] .fm-wizard-body{grid-template-columns:218px minmax(0,1fr)}
      [data-fm-wizard="sms-workflow"] .fm-wizard-pane{padding:28px;background:#f7f8fa;scroll-behavior:smooth}
      [data-fm-wizard="sms-workflow"] .fm-wizard-head{border-bottom:1px solid #e4e7ec}
      [data-fm-wizard="sms-workflow"] .fm-wizard-rail{background:#fff;padding:18px 12px;min-width:0}
      [data-fm-wizard="sms-workflow"] .fm-wizard-step{padding:12px 10px;box-shadow:none}
      [data-fm-wizard="sms-workflow"] .fm-wizard-step.active{background:#fff4f2;border-color:#f6d0c9;opacity:1}
      [data-fm-wizard="sms-workflow"] .fm-wizard-step strong{font-weight:650}
      [data-fm-wizard="sms-workflow"] .fm-wizard-step-status{font-weight:400}
      [data-fm-wizard="sms-workflow"] .sms-workspace{gap:22px;max-width:880px;margin:auto;padding-bottom:10px;font-weight:400}
      .sms-step-heading{display:grid;gap:9px}.sms-step-heading h2{font-size:26px;letter-spacing:-.65px;line-height:1.2;margin:0;color:#101828;font-weight:700}.sms-step-heading p{max-width:660px;margin:0;color:#667085;font-size:14px;line-height:1.55}
      .sms-eyebrow{font-size:10px;letter-spacing:1.2px;color:#8a4b40;font-weight:700}
      .sms-section,.sms-message-card{border:1px solid #e4e7ec;border-radius:14px;background:white;padding:22px;display:grid;gap:20px;min-width:0}
      .sms-section-title{display:flex;gap:12px;align-items:center}.sms-section-title>div{flex:1}.sms-section-title h3{margin:0;color:#182230;font-size:16px;font-weight:650}.sms-section-title p{margin:4px 0 0;color:#667085;font-size:12px;line-height:1.5;font-weight:400}
      .sms-section-number{background:#f2f4f7;border-radius:9px;padding:9px;color:#667085;font-size:11px;font-weight:700}
      [data-fm-wizard="sms-workflow"] .sms-form-grid{gap:20px}
      [data-fm-wizard="sms-workflow"] .sms-field{align-content:start;gap:7px;min-width:0}
      [data-fm-wizard="sms-workflow"] .sms-field label{font-size:13px;font-weight:600;text-transform:none;letter-spacing:0}
      [data-fm-wizard="sms-workflow"] .sms-field input,[data-fm-wizard="sms-workflow"] .sms-field select,[data-fm-wizard="sms-workflow"] .sms-field textarea{font-size:14px;font-weight:400;line-height:1.5;min-height:44px;border-radius:8px}
      [data-fm-wizard="sms-workflow"] .sms-field textarea{min-height:116px}
      [data-fm-wizard="sms-workflow"] .sms-field-msg{font-size:12px;font-weight:400;line-height:1.5}.sms-field-msg:empty{display:none}
      .sms-required{color:#a33b2d}.sms-counter{font-size:11px;color:#667085;text-align:right}
      [data-fm-wizard="sms-workflow"] .sms-ack{background:white;font-weight:400;font-size:13px;line-height:1.55;border-color:#e4e7ec;border-radius:10px;padding:14px}
      .sms-details{border:1px solid #e4e7ec;border-radius:12px;padding:16px 20px;background:white}.sms-details summary{cursor:pointer;color:#344054;font-size:13px;font-weight:600}.sms-details summary span{font-weight:400;color:#667085;margin-left:8px}.sms-details[open]>summary{margin-bottom:18px}.sms-details p{font-size:13px;line-height:1.5;color:#667085}
      .sms-message-grid{display:grid;gap:16px}.sms-message-card{gap:12px}.sms-auto-reply{padding:12px 0;border-top:1px solid #eaecf0;font-size:12px}.sms-auto-reply p{margin:6px 0 0}
      .sms-inline-note{display:flex;gap:10px;font-size:13px;line-height:1.5;color:#667085}.sms-inline-note i{margin-top:3px}
      .sms-muted{color:#667085;font-size:12px;line-height:1.6;font-weight:400;margin:0}
      .sms-text-button,.sms-summary-checklist button{border:0;background:none;padding:0;color:#9a3528;font:inherit;cursor:pointer;text-align:left;text-decoration:underline;text-underline-offset:3px}.sms-text-button{font-size:12px;font-weight:600}
      .sms-review-actions,.sms-review-links{display:flex;flex-wrap:wrap;gap:14px}.sms-review-links a{font-size:13px;color:#344054}.sms-review-links .sms-review-missing{border:1px solid #f5c2b8;border-radius:8px;background:#fff7f5;color:#9a3528;padding:7px 10px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}.sms-review-section{padding:18px 20px}
      [data-fm-wizard="sms-workflow"] .sms-final-panel{padding:18px;border-color:#e4e7ec;gap:13px}.sms-final-panel .sms-final-row strong{font-weight:500}.sms-final-panel .sms-final-row span{font-weight:600;color:#667085}
      [data-fm-wizard="sms-workflow"] .sms-feature-tile{box-shadow:none;min-height:180px}.sms-feature-copy span{font-weight:400;line-height:1.6}.sms-feature-copy strong{font-weight:650}
      .sms-consent-content{display:grid;gap:14px}.sms-consent-content .sms-section{padding:16px;gap:12px}.sms-consent-content h3{margin:0;font-size:15px;font-weight:650}.sms-consent-content p{margin:0;font-size:13px;line-height:1.5}.sms-consent-content .sms-consent-box{padding:12px}.sms-consent-content .sms-consent-box h4{margin:0 0 6px}.sms-consent-content .sms-details{padding:12px 14px}.sms-consent-content .sms-details[open]>summary{margin-bottom:10px}
      .sms-signup-card{display:grid;gap:12px}.sms-signup-card .sms-field{gap:6px}.sms-signup-card ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 22px;margin:0;padding-left:19px;color:#475467;font-size:12px;line-height:1.4}.sms-signup-card>p{margin:0;color:#475467;font-size:12px}
      .sms-field-footer{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.sms-field-footer .sms-field-msg{flex:1;min-width:0}.sms-field-footer .sms-counter{flex:0 0 auto}.sms-message-card{padding:16px;gap:8px}.sms-message-grid{gap:10px}.sms-message-card .sms-field{gap:6px}.sms-message-card textarea{min-height:92px!important}
      [data-fm-wizard="sms-workflow"] .sms-workspace:has([data-sms-field="campaign.description"]){gap:12px}[data-fm-wizard="sms-workflow"] .sms-workspace:has([data-sms-field="campaign.description"]) .sms-form-grid{gap:12px 16px}[data-fm-wizard="sms-workflow"] .sms-workspace:has([data-sms-field="campaign.description"]) textarea{min-height:92px}
      #sms-number-search::placeholder{font-style:italic;color:#98a2b3}
      @media(max-width:600px){.sms-signup-card ul{grid-template-columns:1fr}.sms-field-footer{align-items:flex-start}.sms-field-footer .sms-counter{white-space:nowrap}}
      [data-fm-wizard="sms-workflow"] .sms-consent-content .sms-form-grid{gap:12px}[data-fm-wizard="sms-workflow"] .sms-consent-content .sms-ack{padding:10px}[data-fm-wizard="sms-workflow"] .sms-consent-content .sms-feature-grid{gap:8px;grid-template-columns:repeat(3,minmax(0,1fr))}[data-fm-wizard="sms-workflow"] .sms-consent-content .sms-feature-tile{min-height:0;padding:12px;border-radius:9px;gap:0;transform:none}[data-fm-wizard="sms-workflow"] .sms-consent-content .sms-feature-tile input{width:16px;height:16px;right:10px;top:12px}.sms-consent-content .sms-feature-copy strong{font-size:13px;line-height:1.4;padding-right:20px}.sms-consent-content .sms-feature-copy span{font-size:11px;line-height:1.4;margin-top:5px}
      .sms-evidence{border-top:1px solid #eaecf0;padding-top:14px;display:grid;gap:12px}.sms-evidence h3 .sms-muted{margin-left:6px}.sms-evidence-options{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:14px;align-items:start}.sms-evidence-or{align-self:center;font-size:12px;color:#667085}.sms-evidence [data-sms-upload-status]:empty{display:none}[data-fm-wizard="sms-workflow"] .sms-evidence input[type="file"]{padding:8px;font-size:12px;width:100%}.sms-evidence input::file-selector-button{border:0;border-radius:5px;padding:5px 8px;margin-right:8px;background:#f2f4f7;color:#344054;cursor:pointer}
      @media(max-width:600px){[data-fm-wizard="sms-workflow"] .sms-consent-content .sms-feature-grid{grid-template-columns:1fr}.sms-evidence-options{grid-template-columns:minmax(0,1fr)}.sms-evidence-or{justify-self:center}}
      .sms-example-copy{white-space:pre-wrap;font-size:12px;line-height:1.45;font-weight:400;color:#475467}.sms-message-card .sms-details{padding:10px 12px}.sms-message-card .sms-details[open]>summary{margin-bottom:8px}.sms-number-search #sms-number-search{width:160px;max-width:100%}.sms-evidence-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.sms-evidence-actions label{cursor:pointer}.sms-evidence-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.sms-evidence-list li{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e4e7ec;border-radius:8px}.sms-evidence-list a{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px;color:#344054}.sms-evidence-link-entry{display:flex;align-items:end;gap:10px}.sms-evidence-link-entry .sms-field{flex:1}.sms-evidence [hidden]{display:none!important}.sms-evidence-feedback{font-size:12px;color:#b42318}
      .sms-timeline{margin:0;padding:18px 20px;background:white;border:1px solid #e4e7ec;border-radius:12px;list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
      .sms-timeline li{display:flex;gap:9px;align-items:flex-start;font-size:12px;color:#667085}.sms-timeline li strong{display:block;color:#344054;font-weight:600}.sms-timeline li div>span{display:block;margin-top:5px;font-size:11px;line-height:1.4}.sms-timeline-dot{width:24px;height:24px;flex:0 0 24px;border:1px solid #d0d5dd;border-radius:50%;display:grid;place-items:center;font-size:10px}.sms-timeline .done .sms-timeline-dot{background:#ecfdf3;color:#067647;border-color:#abefc6}.sms-timeline .pending .sms-timeline-dot{background:#fffaeb;color:#b54708;border-color:#fedf89}
      [data-fm-wizard="sms-workflow"] .sms-submitted-panel{max-width:none;box-shadow:none;padding:20px;border-radius:12px}.sms-submitted-panel.pending{background:#fffaeb!important;border-color:#fedf89!important}.sms-submitted-panel.pending .sms-submitted-meta span{border-color:#fedf89;color:#93370d}.sms-submitted-panel.pending .sms-submitted-icon{color:#b54708;box-shadow:none;width:36px;height:36px;font-size:18px}.sms-submitted-panel h4{font-size:20px;font-weight:650}.sms-submitted-panel p{font-weight:400}
      .sms-step-errors,.sms-api-error{border:1px solid #fecdca;background:#fff4f2;padding:16px;border-radius:12px;color:#912018;font-size:13px;line-height:1.5}.sms-step-errors:empty{display:none}.sms-step-errors ul{padding-left:20px;margin:8px 0 0}.sms-step-errors button{font:inherit;text-align:left;color:inherit;background:none;border:0;cursor:pointer;text-decoration:underline}.sms-api-error strong{display:block;margin-bottom:5px}.sms-api-error p{margin:0 0 8px}
      [data-fm-wizard="sms-workflow"] .cs-btn{min-height:42px;border-radius:9px;font-size:13px;font-weight:600;padding:10px 16px;cursor:pointer}.sms-summary-checklist{font-weight:400}.sms-summary-checklist ul{gap:8px}.sms-summary-checklist button{color:inherit}.sms-summary-checklist.ready{background:#f6fef9}
      @media(max-width:860px){[data-fm-wizard="sms-workflow"] .fm-wizard-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}[data-fm-wizard="sms-workflow"] .fm-wizard-rail{padding:8px}.sms-step-heading h2{font-size:23px}[data-fm-wizard="sms-workflow"] .fm-wizard-pane{padding:20px 16px}[data-fm-wizard="sms-workflow"] .fm-wizard-step{min-width:145px;padding:8px}[data-fm-wizard="sms-workflow"] .fm-wizard-step-status{display:none}[data-fm-wizard="sms-workflow"] .fm-wizard-rail-foot{display:none}.sms-section,.sms-message-card{padding:17px}.sms-timeline{grid-template-columns:1fr;gap:14px}.sms-section-title{flex-wrap:wrap}[data-fm-wizard="sms-workflow"] .fm-wizard-foot{flex-wrap:wrap;padding:10px 14px}[data-fm-wizard="sms-workflow"] .fm-wizard-foot-note{flex-basis:100%}[data-fm-wizard="sms-workflow"] .fm-wizard-foot-actions{margin-left:auto}}
      .sms-entry{display:grid;gap:26px;max-width:1080px;padding:8px 0 20px;color:#182230;font-weight:400}
      .sms-entry-header{display:flex;gap:20px;justify-content:space-between;align-items:center}.sms-entry-header h2{margin:7px 0 8px;font-size:26px;letter-spacing:-.6px;font-weight:700;line-height:1.25}.sms-entry-header p{margin:0;color:#667085;font-size:14px;line-height:1.5}
      .sms-entry-card{border:1px solid #e4e7ec;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 3px 12px #10182805}.sms-entry-main{display:flex;align-items:flex-start;gap:20px;padding:28px}.sms-entry-icon{width:48px;height:48px;flex:0 0 48px;display:grid;place-items:center;background:#fff1ee;color:#b63b2e;border-radius:14px;font-size:20px}.sms-entry-copy{flex:1;min-width:0}.sms-entry-copy h3{font-size:23px;line-height:1.3;letter-spacing:-.4px;font-weight:650;margin:0 0 10px}.sms-entry-copy>p{font-size:14px;line-height:1.7;color:#667085;max-width:640px;margin:0}.sms-entry-action{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0;padding:20px 28px;border-top:1px solid #eaecf0}.sms-entry-action>span{font-size:12px;color:#667085}.sms-entry .cs-btn{border-radius:9px;min-height:42px;padding:11px 16px;font-size:13px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:10px;cursor:pointer}.sms-entry .cs-btn:focus-visible{outline:2px solid #344054;outline-offset:3px}
      .sms-entry-card.pending .sms-entry-icon{background:#fffaeb;color:#b54708}.sms-entry-card.ready .sms-entry-icon{background:#ecfdf3;color:#067647}.sms-entry-card.attention .sms-entry-icon{background:#fef3f2;color:#b42318}
      .sms-entry-preview{background:#fafbfc}.sms-entry-preview>.sms-entry-action{border-top:0;padding-top:0}
      .sms-entry-facts{display:grid;grid-template-columns:1fr 1fr 1.5fr;margin:0;padding:20px 28px;gap:24px;background:#fafbfc;border-top:1px solid #eaecf0}.sms-entry-facts dt{font-size:11px;color:#667085;margin-bottom:7px}.sms-entry-facts dd{font-size:13px;line-height:1.6;font-weight:500;margin:0;overflow-wrap:anywhere}.sms-entry-progress{display:flex;align-items:center;gap:12px;margin-top:18px;font-size:11px;color:#667085}.sms-entry-progress progress{appearance:none;width:140px;height:5px;border:0;border-radius:9px;overflow:hidden;background:#eaecf0}.sms-entry-progress progress::-webkit-progress-bar{background:#eaecf0}.sms-entry-progress progress::-webkit-progress-value{background:#c85d4d;border-radius:9px}.sms-entry-progress progress::-moz-progress-bar{background:#c85d4d}
      .sms-entry-tracking>h3,.sms-entry-prep>h3{font-size:14px;font-weight:600;margin:0 0 14px}.sms-entry-tracking{padding:0 28px 24px}.sms-entry .sms-timeline{padding:0;border:0;border-radius:0;box-shadow:none}.sms-entry .sms-timeline li{align-items:center}.sms-entry-prep-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.sms-entry-prep-grid>div{display:flex;gap:12px}.sms-entry-prep-grid>div>span{flex:0 0 26px;height:26px;display:grid;place-items:center;background:#f2f4f7;border-radius:50%;font-size:11px;color:#667085}.sms-entry-prep h4{font-size:13px;font-weight:600;margin:3px 0 6px}.sms-entry-prep p{font-size:12px;line-height:1.6;color:#667085;margin:0}.sms-entry-footnote{display:flex;align-items:baseline;gap:8px;margin:0;padding-top:18px;border-top:1px solid #eaecf0;color:#667085;font-size:11px;line-height:1.6}.sms-entry-other{font-size:13px;border-top:1px solid #eaecf0;padding-top:16px}.sms-entry-other summary{cursor:pointer;color:#475467}.sms-entry-other>div{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-top:14px}
      @media(max-width:700px){.sms-entry{gap:22px}.sms-entry-header{align-items:flex-start;flex-direction:column;gap:12px}.sms-entry-header h2{font-size:24px}.sms-entry-main{padding:20px;gap:14px}.sms-entry-icon{width:36px;height:36px;flex-basis:36px;font-size:16px;border-radius:10px}.sms-entry-copy h3{font-size:20px}.sms-entry-facts{grid-template-columns:1fr;padding:20px;gap:16px}.sms-entry-prep-grid{grid-template-columns:1fr;gap:18px}.sms-entry .sms-timeline{grid-template-columns:1fr}.sms-entry-action{gap:12px;padding:20px}.sms-entry-tracking{padding:0 20px 20px}.sms-entry-action .cs-btn{width:100%}.sms-entry-progress{flex-wrap:wrap}}
  `;
  function installStyle(){
    if (document.getElementById('fm-sms-registration-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-sms-registration-css';
    style.textContent = css;
    document.head.appendChild(style);
  }
  function readPlatformCsrfToken(){
    const sessionName = String(window.__APP?.platformSessionCookieName || 'fm_platform_session').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    const prefix = sessionName + '_csrf=';
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    try { return value ? decodeURIComponent(value.slice(prefix.length)) : ''; }
    catch { return ''; }
  }
  function messagingBaseUrl(){
    const platformBase = window.PlatformAPI?.baseUrl?.() || '';
    if (platformBase) return platformBase.replace(/\/v1\/platform\/?$/i, '/v1/messaging').replace(/\/+$/, '');
    const host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') return `${location.origin}/v1/messaging`;
    return `${location.origin}/v1/messaging`;
  }
  async function messagingRequest(path, options = {}){
    const body = options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = readPlatformCsrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Platform-CSRF'] = csrf;
    const res = await fetch(`${messagingBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`, {
      ...options,
      method,
      body,
      cache: options.cache || 'no-store',
      credentials: 'include',
      headers
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!res.ok || data?.ok === false) {
      const missing = Array.isArray(data?.details?.missing) ? data.details.missing.filter(Boolean).join(', ') : '';
      const telnyxDetail = Array.isArray(data?.details?.errors)
        ? data.details.errors.map((item) => item?.detail || item?.title || '').filter(Boolean).join(' ')
        : '';
      const detailText = missing ? ` Missing: ${missing}.` : telnyxDetail ? ` ${telnyxDetail}` : '';
      const error = new Error(`${String(data?.message || data?.error || `Messaging request failed (${res.status})`)}${detailText}`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }
  function normalizeOrganizationBusinessAddress(value = {}){
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const address = {
      address1: String(raw.address1 || raw.address_1 || raw.line1 || raw.street || '').trim(),
      address2: String(raw.address2 || raw.address_2 || raw.line2 || '').trim(),
      city: String(raw.city || raw.locality || '').trim(),
      state: String(raw.state || raw.region || raw.province || '').trim(),
      postal_code: String(raw.postal_code || raw.postalCode || raw.zip || raw.zip_code || '').trim(),
      country: String(raw.country || raw.country_code || raw.countryCode || '').trim().toUpperCase()
    };
    if (typeof value !== 'string' || !value.trim()) return address;
    const parts = value.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
    address.address1 = parts[0] || value.trim();
    if (parts.length >= 3) {
      let regionIndex = -1;
      let regionPostal = null;
      for (let index = parts.length - 1; index >= 2; index -= 1) {
        const match = String(parts[index] || '').match(/^(.+?)\s+([A-Z0-9][A-Z0-9 -]{2,12})$/i);
        if (match) {
          regionIndex = index;
          regionPostal = match;
          break;
        }
      }
      if (regionPostal) {
        address.state = regionPostal[1].trim();
        address.postal_code = regionPostal[2].trim();
        address.city = parts[regionIndex - 1] || '';
        address.address2 = parts.slice(1, regionIndex - 1).join(', ');
        if (parts[regionIndex + 1]) address.country = parts[regionIndex + 1].length === 2 ? parts[regionIndex + 1].toUpperCase() : parts[regionIndex + 1];
      } else {
        address.city = parts[1] || '';
        address.state = parts[2] || '';
        if (parts[3]) address.country = parts[3].length === 2 ? parts[3].toUpperCase() : parts[3];
      }
    }
    return address;
  }
  function formatOrganizationBusinessAddress(value = {}){
    const address = normalizeOrganizationBusinessAddress(value);
    const locality = [address.city, [address.state, address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [address.address1, address.address2, locality, address.country && address.country !== 'US' ? address.country : ''].filter(Boolean).join(', ');
  }

  /**
   * env: escapeHtml, showToast, appFlag(group, flag), currentOrgId(), canPlatformBilling, readSettingsRoute(),
   * writeSettingsRoute(patch, options), organizationBusinessAddressFromState(), and getters paneSms(), activeTab(),
   * state() (the company settings record).
   */
  function create(env){
    installStyle();
    const { escapeHtml, showToast, appFlag, currentOrgId, canPlatformBilling, readSettingsRoute, writeSettingsRoute, organizationBusinessAddressFromState } = env;
    function formatPhoneUS(raw){
      const d = String(raw || '').replace(/\D/g, '').slice(0, 10);
      if (d.length <= 3) return d;
      if (d.length <= 6) return `(${d.slice(0,3)}) ${d.slice(3)}`;
      return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    }
    let smsRegistrationLiveMode = false;
    const smsDefaults = {
      brand: {
        country: 'US',
        entityType: 'PRIVATE_PROFIT',
        vertical: 'CONSTRUCTION',
        isReseller: false
      },
      campaign: {
        usecase: 'LOW_VOLUME',
        subscriberOptin: true,
        subscriberOptout: true,
        subscriberHelp: true,
        optinKeywords: 'START',
        optoutKeywords: 'STOP',
        helpKeywords: 'HELP',
        termsAndConditions: true,
        autoRenewal: true,
        embeddedLink: false,
        embeddedPhone: false,
        numberPool: false,
        directLending: false,
        ageGated: false,
        enabledFeatures: null,
        featuresConfirmed: false,
        messageFlowConfirmed: false,
        selectedNumber: '',
        selectedNumberDisplay: '',
        selectedNumberAreaCode: ''
      }
    };
    const smsFeatureOptions = [
      {
        id: 'crm_conversations',
        label: (globalThis.PlatformLanguage?.text("settings","m_6ccda26bef638f","Customer Conversations") ?? "Customer Conversations"),
        icon: 'fa-comments',
        description: (globalThis.PlatformLanguage?.text("settings","m_3e4f5ed6e45ffd","Two-way texting with leads and customers from the inbox.") ?? "Two-way texting with leads and customers from the inbox.")
      },
      {
        id: 'operations',
        label: (globalThis.PlatformLanguage?.text("settings","m_0492f49d263863","Operational Updates") ?? "Operational Updates"),
        icon: 'fa-calendar-check',
        description: (globalThis.PlatformLanguage?.text("settings","m_92e0c5cfcbb5e0","Appointments, reminders, project updates, estimates, and billing notices.") ?? "Appointments, reminders, project updates, estimates, and billing notices.")
      },
      {
        id: 'customer_growth',
        label: 'Marketing',
        icon: 'fa-bullhorn',
        description: (globalThis.PlatformLanguage?.text("settings","m_95efed8d6ab59b","Review requests, referrals, nurture, and optional promotions.") ?? "Review requests, referrals, nurture, and optional promotions.")
      }
    ];
    const smsOptions = {
      entityTypes: ['PRIVATE_PROFIT', 'PUBLIC_PROFIT', 'NON_PROFIT', 'GOVERNMENT', 'SOLE_PROPRIETOR'],
      verticals: ['AGRICULTURE', 'COMMUNICATION', 'CONSTRUCTION', 'EDUCATION', 'ENERGY', 'ENTERTAINMENT', 'FINANCIAL', 'GAMBLING', 'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY', 'HUMAN_RESOURCES', 'INSURANCE', 'LEGAL', 'MANUFACTURING', 'NGO', 'POLITICAL', 'POSTAL', 'PROFESSIONAL', 'REAL_ESTATE', 'RETAIL', 'TECHNOLOGY', 'TRANSPORTATION'],
      stockExchanges: ['NASDAQ', 'NYSE', 'AMEX', 'AMX', 'ASX', 'B3', 'BME', 'BSE', 'FRA', 'ICEX', 'JPX', 'JSE', 'KRX', 'LON', 'NSE', 'OMX', 'SEHK', 'SSE', 'STO', 'SWX', 'SZSE', 'TSX', 'TWSE', 'VSE']
    };
    const smsSteps = [
      { id: 'business', label: (globalThis.PlatformLanguage?.text("settings","m_8807b60e199434","Business") ?? "Business"), note: 'Legal identity' },
      { id: 'contact', label: (globalThis.PlatformLanguage?.text("settings","m_46c8aea84388c3","Contact") ?? "Contact"), note: 'Support and address' },
      { id: 'consent', label: 'Messages & consent', note: 'Permission and policies' },
      { id: 'messages', label: 'Message examples', note: 'What customers receive' },
      { id: 'number', label: (globalThis.PlatformLanguage?.text("settings","m_3e7027aa9d65ed","Number") ?? "Number"), note: 'Sending line' },
      { id: 'summary', label: 'Review & submit', note: 'Final check and status' }
    ];
    function mergeSmsProfile(profile = {}){
      const campaign = { ...smsDefaults.campaign, ...(profile.campaign || {}) };
      if (!Array.isArray(campaign.enabledFeatures)) {
        campaign.enabledFeatures = ['crm_conversations', 'operations', 'customer_growth'];
      }
      return {
        ...profile,
        brand: { ...smsDefaults.brand, ...(profile.brand || {}) },
        campaign,
        events: Array.isArray(profile.events) ? profile.events : []
      };
    }
    function smsSelectedFeatures(profile){
      const selected = Array.isArray(profile?.campaign?.enabledFeatures) ? profile.campaign.enabledFeatures : ['crm_conversations', 'operations', 'customer_growth'];
      const known = new Set(smsFeatureOptions.map((feature) => feature.id));
      const legacyMap = {
        customer_care: 'crm_conversations',
        account_support: 'operations',
        scheduling: 'operations',
        project_updates: 'operations',
        estimate_proposals: 'operations',
        billing: 'operations',
        reviews_referrals: 'customer_growth',
        marketing: 'customer_growth'
      };
      const normalized = selected
        .map((value) => String(value || '').trim())
        .map((value) => legacyMap[value] || value)
        .filter((value) => known.has(value));
      return Array.from(new Set(normalized));
    }
    function smsNormalizeWebsite(value){
      const raw = String(value || '').trim();
      if (!raw) return '';
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        const url = new URL(withScheme);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.href.replace(/\/$/, '');
      } catch(e) {
        return '';
      }
    }
    function smsNormalizePhone(value){
      const raw = String(value || '').trim();
      if (!raw) return '';
      const validNanp = (digits) => /^[2-9]\d{9}$/.test(String(digits || ''));
      const compact = raw.replace(/[^\d+]/g, '');
      if (/^\+1\d{10}$/.test(compact)) return validNanp(compact.slice(2)) ? compact : '';
      if (/^\+[2-9]\d{7,14}$/.test(compact)) return compact;
      const digits = raw.replace(/\D/g, '');
      if (digits.length === 10) return validNanp(digits) ? `+1${digits}` : '';
      if (digits.length === 11 && digits.startsWith('1')) return validNanp(digits.slice(1)) ? `+${digits}` : '';
      return '';
    }
    function smsFormatE164ForDisplay(value){
      const normalized = smsNormalizePhone(value);
      if (!normalized) return '';
      if (normalized.startsWith('+1') && normalized.length === 12) return formatPhoneUS(normalized.slice(2));
      return normalized;
    }
    function smsFormatPhoneInput(value){
      const raw = String(value || '').trim();
      if (raw.startsWith('+') && !raw.startsWith('+1')) return raw;
      const digits = raw.replace(/\D/g, '').replace(/^1(?=\d)/, '').slice(0, 10);
      if (!digits) return '';
      if (digits.length <= 3) return digits;
      if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    function smsFormatSelectedNumber(profile){
      const campaign = profile?.campaign || {};
      return campaign.selectedNumberDisplay || smsFormatE164ForDisplay(campaign.selectedNumber) || campaign.selectedNumber || '';
    }
    function smsAdditionalNumbers(profile){
      return Array.isArray(profile?.provider_refs?.additional_numbers) ? profile.provider_refs.additional_numbers : [];
    }
    function smsCanAddNumber(profile){
      return profile?.status === 'active' && profile?.campaign_status === 'mno_provisioned' && profile?.brand?.entityType !== 'SOLE_PROPRIETOR' && smsAdditionalNumbers(profile).filter(number => !['failed','failure','cancelled','deleted','released'].includes(String(number.status || '').toLowerCase())).length < 48 && !smsAdditionalNumbers(profile).some(number => !['success','failed','failure','cancelled','deleted','released'].includes(String(number.status || '').toLowerCase()) || (number.status === 'success' && number.assignment_status !== 'assigned'));
    }
    function smsValidAreaCode(value){
      return /^[2-9]\d{2}$/.test(String(value || '').replace(/\D/g, ''));
    }
    function smsAddressText(brand = {}){
      return [brand.street, brand.address2, brand.city, brand.state, brand.postalCode].filter(Boolean).join(', ');
    }
    function smsEnsureGooglePlaces(){
      if (window.google?.maps?.places?.Autocomplete) return Promise.resolve(window.google.maps);
      if (window.google?.maps?.importLibrary) {
        return window.google.maps.importLibrary('places').then(() => {
          if (window.google?.maps?.places?.Autocomplete) return window.google.maps;
          throw new Error('Google Places library is unavailable.');
        });
      }
      const existing = Array.from(document.scripts || []).find((script) => String(script.src || '').includes('maps.googleapis.com/maps/api/js'));
      if (existing) {
        return new Promise((resolve, reject) => {
          let attempts = 0;
          const timer = window.setInterval(() => {
            attempts += 1;
            if (window.google?.maps?.places?.Autocomplete) {
              window.clearInterval(timer);
              resolve(window.google.maps);
            } else if (attempts > 80) {
              window.clearInterval(timer);
              reject(new Error('Google Places did not finish loading.'));
            }
          }, 150);
        });
      }
      const key = String(window.Portal?.util?.googleMapsApiKey?.() || window.__APP?.googleMapsApiKey || '').trim();
      if (!key) return Promise.reject(new Error('Google Maps API key is unavailable.'));
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.async = true;
        script.defer = true;
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places`;
        script.onload = () => {
          if (window.google?.maps?.places?.Autocomplete) resolve(window.google.maps);
          else reject(new Error('Google Places library is unavailable.'));
        };
        script.onerror = () => reject(new Error('Google Maps failed to load.'));
        document.head.appendChild(script);
      });
    }
    function smsAddressComponents(place = {}){
      const out = {};
      (place.address_components || []).forEach((component) => {
        (component.types || []).forEach((type) => {
          out[type] = {
            long_name: component.long_name || '',
            short_name: component.short_name || ''
          };
        });
      });
      return out;
    }
    function smsAddressLineFromFormatted(value){
      return String(value || '').split(',').map((part) => part.trim()).filter(Boolean)[0] || '';
    }
    function smsApplyGooglePlace(profile, place = {}){
      const components = smsAddressComponents(place);
      const streetNumber = components.street_number?.long_name || '';
      const route = components.route?.long_name || '';
      const formatted = String(place.formatted_address || '').trim();
      const fallbackStreet = smsAddressLineFromFormatted(formatted || profile.brand?.street || '');
      const street = [streetNumber, route].filter(Boolean).join(' ').trim() || fallbackStreet;
      const city = components.locality?.long_name
        || components.postal_town?.long_name
        || components.sublocality_level_1?.long_name
        || components.sublocality?.long_name
        || components.administrative_area_level_3?.long_name
        || '';
      const state = components.administrative_area_level_1?.short_name || '';
      const postalCode = [components.postal_code?.long_name || '', components.postal_code_suffix?.long_name || ''].filter(Boolean).join('-');
      const formattedAddress = formatted || smsAddressText({ ...(profile.brand || {}), street, city, state, postalCode });
      return prepareSmsProfileForSave({
        ...profile,
        brand: {
          ...(profile.brand || {}),
          street: street || profile.brand?.street || '',
          address2: components.subpremise?.long_name || profile.brand?.address2 || '',
          city: city || profile.brand?.city || '',
          state: state || profile.brand?.state || '',
          postalCode: postalCode || profile.brand?.postalCode || '',
          formattedAddress,
          addressAutocompleteSelected: Boolean(formattedAddress),
          addressComponents: components,
          lat: place.geometry?.location?.lat?.() ?? profile.brand?.lat ?? '',
          lng: place.geometry?.location?.lng?.() ?? profile.brand?.lng ?? ''
        }
      });
    }
    function smsCompanyName(profile){
      return String(profile?.brand?.displayName || profile?.brand?.companyName || window.__APP?.userCompany || 'your company').trim() || 'your company';
    }
    function smsGeneratedCampaign(profile){
      const base = mergeSmsProfile(profile);
      const selectedIds = smsSelectedFeatures(base);
      const selected = smsFeatureOptions.filter((feature) => selectedIds.includes(feature.id));
      const company = smsCompanyName(base);
      const companyKnown = Boolean(String(base.brand?.displayName || base.brand?.companyName || '').trim());
      const includesMarketing = selectedIds.includes('customer_growth');
      const startPurposes = [selectedIds.includes('crm_conversations') && 'customer care', selectedIds.includes('operations') && 'updates', includesMarketing && 'marketing'].filter(Boolean).join(', ');
      const featureLabels = selected.map((feature) => feature.label.toLowerCase()).join(', ');
      const website = String(base.brand?.website || '').trim();
      const soleProprietor = String(base.brand?.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR';
      const savedMessageFlow = String(base.campaign?.messageFlow || '').trim();
      const legacyGeneratedFlow = /customer-facing FirstMate forms|appointment requests, project communications|Recipients provide consent directly to .* in a documented written or verbal customer interaction/i.test(savedMessageFlow);
      return {
        ...base.campaign,
        enabledFeatures: selectedIds,
        featuresConfirmed: base.campaign.featuresConfirmed === true,
        messageFlowConfirmed: base.campaign.messageFlowConfirmed === true,
        usecase: smsHasProviderCampaign(base) ? base.campaign.usecase : soleProprietor ? 'SOLE_PROPRIETOR' : 'LOW_VOLUME',
        description: base.campaign.description || '',
        optInEvidence: smsEvidence(base.campaign),
        messageFlow: savedMessageFlow && !legacyGeneratedFlow ? savedMessageFlow : '',
        sample1: base.campaign.sample1 || '',
        sample2: base.campaign.sample2 || '',
        sample3: base.campaign.sample3 || '',
        subscriberOptin: true,
        subscriberOptout: true,
        subscriberHelp: true,
        optinKeywords: 'START',
        optoutKeywords: 'STOP',
        helpKeywords: 'HELP',
        optinMessage: smsHasProviderCampaign(base) && base.campaign.optinMessage ? base.campaign.optinMessage : `${company}: Subscribed to ${startPurposes || 'business'} texts. Msg freq varies. Msg & data rates may apply. HELP for help; STOP to opt out.${includesMarketing ? ' Consent is not a condition of purchase.' : ''}`,
        optoutMessage: `${company}: You are unsubscribed and will receive no more SMS messages. Reply START to resubscribe.`,
        helpMessage: `${company} SMS: Help at ${String(base.brand?.email || 'support').trim()}. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.`,
        embeddedLink: /https?:\/\//i.test([base.campaign.sample1, base.campaign.sample2, base.campaign.sample3, base.campaign.sample4, base.campaign.sample5].filter(Boolean).join(' ')),
        embeddedLinkSample: base.campaign.embeddedLinkSample || ([base.campaign.sample1, base.campaign.sample2, base.campaign.sample3, base.campaign.sample4, base.campaign.sample5].join(' ').match(/https?:\/\/[^\s]+/i) || [])[0] || '',
        embeddedPhone: /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}/.test([base.campaign.sample1, base.campaign.sample2, base.campaign.sample3, base.campaign.sample4, base.campaign.sample5].filter(Boolean).join(' ')),
        numberPool: false,
        directLending: false,
        ageGated: false,
        termsAndConditions: true,
        privacyPolicyLink: base.campaign.privacyPolicyLink || '',
        termsAndConditionsLink: base.campaign.termsAndConditionsLink || '',
        standardizationVersion: 'firstmate-crm-10dlc-v2'
      };
    }
    function prepareSmsProfileForSave(profile){
      const merged = mergeSmsProfile(profile);
      if (merged.brand.sameAsLegalName) merged.brand.displayName = smsLegalName(merged.brand);
      return {
        ...merged,
        brand: {
          ...merged.brand,
          website: smsNormalizeWebsite(merged.brand.website) || merged.brand.website,
          phone: smsNormalizePhone(merged.brand.phone) || merged.brand.phone
        },
        campaign: Object.fromEntries(Object.entries(smsGeneratedCampaign(merged)).map(([key, value]) => [key, smsLinkFields.includes('campaign.' + key) ? (smsNormalizeWebsite(value) || value) : value]))
      };
    }
    function smsPrefillProfile(profile = {}, setup = {}){
      const next = mergeSmsProfile(profile);
      if (smsRegistrationLiveMode && !profile.id) return prepareSmsProfileForSave(next);
      const org = setup.organization || {};
      const orgContact = org.contact && typeof org.contact === 'object' ? org.contact : {};
      const currentUser = window.Portal?.currentUser || {};
      const company = String(next.brand.companyName || next.brand.displayName || org.name || window.__APP?.userCompany || '').trim();
      if (company) {
        next.brand.companyName = next.brand.companyName || company;
        next.brand.displayName = next.brand.displayName || company;
      }
      next.brand.email = next.brand.email || orgContact.email || env.state()?.company_email || currentUser.email || window.__APP?.userEmail || '';
      next.brand.phone = next.brand.phone || orgContact.phone || env.state()?.company_phone || '';
      const setupAddress = normalizeOrganizationBusinessAddress(orgContact.business_address || orgContact.businessAddress || orgContact.address);
      const businessAddress = Object.values(setupAddress).some(Boolean) ? setupAddress : organizationBusinessAddressFromState();
      next.brand.street = next.brand.street || businessAddress.address1 || '';
      next.brand.address2 = next.brand.address2 || businessAddress.address2 || '';
      next.brand.city = next.brand.city || businessAddress.city || '';
      next.brand.state = next.brand.state || businessAddress.state || '';
      next.brand.postalCode = next.brand.postalCode || businessAddress.postal_code || '';
      next.brand.formattedAddress = next.brand.formattedAddress || formatOrganizationBusinessAddress(businessAddress);
      const fullName = String(currentUser.name || window.__APP?.userName || '').trim();
      if (fullName && (!next.brand.firstName || !next.brand.lastName)) {
        const parts = fullName.split(/\s+/);
        next.brand.firstName = next.brand.firstName || parts[0] || '';
        next.brand.lastName = next.brand.lastName || parts.slice(1).join(' ');
      }
      return prepareSmsProfileForSave(next);
    }
    function smsStatusBadge(value, extra = ''){
      const raw = String(value || 'draft').replace(/_/g, ' ');
      const key = raw.toLowerCase();
      const cls = key.includes('accepted') || key.includes('submitted') || key.includes('active') || key.includes('ok') ? 'ok' : key.includes('fail') || key.includes('reject') ? 'warn' : '';
      return `<span class="sms-badge ${cls} ${extra}">${escapeHtml(raw)}</span>`;
    }
    function smsHasProviderBrand(profile){
      const refs = profile?.provider_refs || {};
      return !!(refs.telnyx_brand_id || refs.tcr_brand_id || profile?.campaign?.brandId);
    }
    function smsHasProviderCampaign(profile){
      const refs = profile?.provider_refs || {};
      return !!(refs.telnyx_campaign_id || refs.tcr_campaign_id);
    }
    function smsBrandReadyForCampaign(profile){
      const status = String(profile?.brand_status || profile?.brandStatus || '').trim().toLowerCase();
      return ['verified', 'vetted_verified', 'ok', 'approved'].includes(status);
    }
    function smsCampaignReady(profile){
      const status = String(profile?.campaign_status || profile?.campaignStatus || profile?.status || '').trim().toLowerCase();
      const autoresponse = profile?.autoresponse_state || {};
      const keywordResponsesReady = String(autoresponse.status || '').toLowerCase() === 'configured'
        && !!autoresponse.desired_hash
        && autoresponse.messaging_profile_id === profile?.provider_refs?.telnyx_messaging_profile_id
        && autoresponse.desired_hash === autoresponse.applied_hash;
      return status === 'mno_provisioned' && keywordResponsesReady;
    }
    function smsCampaignAppealable(profile){
      const status = String(profile?.campaign_status || '').trim().toLowerCase();
      return smsHasProviderCampaign(profile) && ['telnyx_failed', 'mno_rejected'].includes(status);
    }
    function smsCampaignNeedsReplacement(profile){
      const status = String(profile?.campaign_status || '').trim().toLowerCase();
      return smsHasProviderCampaign(profile) && !smsCampaignAppealable(profile) && /failed|rejected|expired/.test(status);
    }
    function smsCampaignSuspended(profile){
      return /suspended/.test(String(profile?.campaign_status || '').trim().toLowerCase());
    }
    function smsProfileIsMock(profile){
      return profile?.brand?.mock === true || profile?.campaign?.mock === true;
    }
    function smsMockRegistrationComplete(profile){
      return smsProfileIsMock(profile) && smsHasProviderCampaign(profile);
    }
    function smsRegistrationSubmitted(profile){
      const status = String(profile?.status || '').trim().toLowerCase();
      if ([status, String(profile?.brand_status || '').toLowerCase(), String(profile?.campaign_status || '').toLowerCase(), String(profile?.phone_number_status || '').toLowerCase()].some((value) => /fail|reject|unverified|suspend|expire|cancel/.test(value))) return false;
      return smsHasProviderBrand(profile) || ['brand_pending', 'brand_submitted', 'campaign_submitted', 'active'].includes(status);
    }
    function smsRegistrationVerified(profile){
      const status = String(profile?.status || '').trim().toLowerCase();
      return status === 'active' && smsCampaignReady(profile);
    }
    function smsResumeStep(profile){
      if (smsRegistrationSubmitted(profile)) return 'summary';
      return smsSteps.find(item => smsStepIssues(item.id, profile).length)?.id || 'summary';
    }
    function smsVisibleSteps(profile){
      return smsSteps;
    }
    function smsFormatDateTime(value){
      const time = Date.parse(value || '');
      if (!time) return '';
      try {
        return new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      } catch(e) {
        return '';
      }
    }
    function smsRegistrationSubmittedAt(profile){
      const events = Array.isArray(profile?.events) ? profile.events : [];
      const eventType = smsHasProviderCampaign(profile) ? 'campaign_submitted' : 'brand_submitted';
      const submitted = events.slice().reverse().find((event) => String(event?.type || '') === eventType);
      return smsFormatDateTime(submitted?.at || profile?.updated_at || profile?.created_at);
    }
    function smsCustomerRegistrationStatus(profile){
      if (!profile?.id) return { label: (globalThis.PlatformLanguage?.text("settings","m_8e0889858c888d","Not started") ?? "Not started"), tone: '', message: (globalThis.PlatformLanguage?.text("settings","m_95c7c3b0210dc4","No SMS registration has been created yet.") ?? "No SMS registration has been created yet.") };
      if (smsRegistrationVerified(profile)) return { label: (globalThis.PlatformLanguage?.text("settings","m_f64a3a7ba06127","Verified") ?? "Verified"), tone: 'ok', message: (globalThis.PlatformLanguage?.text("settings","m_20d655ea01d16d","SMS registration is verified.") ?? "SMS registration is verified.") };
      if (smsRegistrationSubmitted(profile)) return smsHasProviderCampaign(profile)
        ? { label: 'Campaign submitted', tone: 'ok', message: 'The SMS campaign is submitted for carrier review.' }
        : { label: smsBrandReadyForCampaign(profile) ? 'Business verified' : 'Business submitted', tone: 'ok', message: smsBrandReadyForCampaign(profile) ? 'Your campaign is being submitted automatically.' : 'Business verification is in progress.' };
      return { label: (globalThis.PlatformLanguage?.text("settings","m_9ce407c87de615","Draft") ?? "Draft"), tone: '', message: (globalThis.PlatformLanguage?.text("settings","m_93c8e169e0fb0e","Registration is drafted but not submitted.") ?? "Registration is drafted but not submitted.") };
    }
    function smsRegistrationLocked(profile){
      const statuses = [profile?.status, profile?.brand_status, profile?.campaign_status, profile?.phone_number_status].map((value) => String(value || '').toLowerCase());
      if (statuses.some((value) => /suspend/.test(value))) return true;
      if (statuses.some((value) => /fail|reject|unverified|expired|cancel/.test(value))) return false;
      return smsHasProviderCampaign(profile);
    }
    function smsOptionHtml(values, selected){
      const labels = { '': 'Choose an option', WEBSITE_FORM: 'Website form', PAPER_FORM: 'Paper form', VERBAL: 'Verbal agreement', KEYWORD: 'Text a keyword', PRIVATE_PROFIT: 'Private business (including LLCs, partnerships, and corporations)', PUBLIC_PROFIT: 'Publicly traded company', NON_PROFIT: 'Nonprofit', GOVERNMENT: 'Government', SOLE_PROPRIETOR: 'Sole proprietor / individual', PROFESSIONAL: 'Professional services', COMMUNICATION: 'Communications', FINANCIAL: 'Financial services', NGO: 'Non-governmental organization', POSTAL: 'Postal and delivery services' };
      return values.map((value) => `<option value="${escapeHtml(value)}" ${String(selected || '') === value ? 'selected' : ''}>${escapeHtml(labels[value] || value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()))}</option>`).join('');
    }
    function smsField(name, label, value, options = {}){
      if (!smsValuePresent(value)) options = { ...options, error: '' };
      const wide = options.wide ? ' wide' : '';
      const invalid = options.error ? ' invalid' : '';
      const type = options.type || 'text';
      const id = `sms-${name.replace(/\./g, '-')}`;
      const labelHtml = `<label for="${id}">${escapeHtml(label)}${options.required ? '<span class="sms-required" aria-hidden="true"> *</span>' : ''}</label>`;
      const attrs = ` id="${id}" aria-describedby="${id}-help"${options.error ? ' aria-invalid="true"' : ''}${options.required ? ' required' : ''}${options.maxlength ? ` maxlength="${Number(options.maxlength)}"` : ''}${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''}${options.inputmode ? ` inputmode="${escapeHtml(options.inputmode)}"` : ''}${options.autocomplete ? ` autocomplete="${escapeHtml(options.autocomplete)}"` : ''}${options.disabled ? ' disabled' : ''}`;
      const help = options.error || options.hint || '';
      const helpClass = options.error ? 'warn' : options.ok ? 'ok' : '';
      const helpHtml = `<div id="${id}-help" class="sms-field-msg ${helpClass}">${escapeHtml(help)}</div>`;
      if (options.kind === 'select') {
        return `<div class="sms-field${wide}${invalid}">${labelHtml}<select data-sms-field="${escapeHtml(name)}"${attrs}>${smsOptionHtml(options.values || [], value)}</select>${helpHtml}</div>`;
      }
      if (options.kind === 'textarea') {
        const counter = options.maxlength ? `<span class="sms-counter" data-sms-counter="${escapeHtml(name)}" data-sms-max="${Number(options.maxlength)}">${String(value || '').length} / ${Number(options.maxlength)} characters</span>` : '';
        return `<div class="sms-field${wide}${invalid}">${labelHtml}<textarea data-sms-field="${escapeHtml(name)}"${attrs}>${escapeHtml(value || '')}</textarea>${options.inlineHelp ? `<div class="sms-field-footer">${helpHtml}${counter}</div>` : counter + helpHtml}</div>`;
      }
      return `<div class="sms-field${wide}${invalid}">${labelHtml}<input type="${escapeHtml(type)}" data-sms-field="${escapeHtml(name)}" value="${escapeHtml(value || '')}"${attrs}>${helpHtml}</div>`;
    }
    function smsLegalName(brand){
      return brand.entityType === 'SOLE_PROPRIETOR' ? [brand.firstName, brand.lastName].filter(Boolean).join(' ').trim() : String(brand.companyName || '').trim();
    }
    function smsFormatEin(value){
      const raw = String(value || '');
      if (/^\*{3,}\d{4}$/.test(raw)) return raw;
      const digits = raw.replace(/\D/g, '');
      return digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    }
    function smsValidEin(value){
      return /^(?:\d{2}-?\d{7}|\*{3,}\d{4})$/.test(String(value || '').trim());
    }
    function smsFieldLiveState(name, value){
      const raw = String(value || '').trim();
      if (['brand.displayName', 'brand.companyName', 'brand.street', 'brand.city', 'brand.state', 'brand.postalCode'].includes(name)) {
        return { error: raw ? '' : 'This field is required.' };
      }
      if (name === 'brand.ein') {
        const count = raw.replace(/\D/g, '').length;
        return smsValidEin(raw) ? { ok: true } : { error: count > 9 ? `An EIN has 9 digits. You entered ${count}; remove the extra digits.` : 'Enter your 9-digit EIN, for example 12-3456789.' };
      }
      if (smsLinkFields.includes(name)) {
        const normalized = smsNormalizeWebsite(raw);
        if (!raw) return { hint: '' };
        if (!normalized || (name !== 'brand.website' && !smsValidHttpsUrl(normalized))) return { error: 'Enter a valid HTTPS link, such as example.com/signup.' };
        return { ok: true };
      }
      if (name === 'brand.email') {
        if (!raw) return { error: 'Support email is required.' };
        if (!smsValidEmail(raw)) return { error: 'Enter a valid support email.' };
        return { ok: true };
      }
      if (name === 'brand.phone') {
        const normalized = smsNormalizePhone(raw);
        const display = smsFormatE164ForDisplay(raw);
        if (!raw) return { error: 'Business phone is required.' };
        if (!normalized) return { error: 'Enter a valid US/Canada phone number.' };
        return { ok: true };
      }
      if (name === 'campaign.selectedNumberAreaCode') {
        const digits = raw.replace(/\D/g, '');
        if (!digits) return { hint: '' };
        if (digits.length < 3) return { hint: '' };
        if (!smsValidAreaCode(digits.slice(0, 3))) return { error: 'Enter a valid area code.' };
        return { ok: true };
      }
      return null;
    }
    function smsRefreshInputValidity(input){
      if (!input) return;
      const name = String(input.getAttribute('data-sms-field') || '');
      if (!name) return;
      const field = input.closest('.sms-field');
      if (!field) return;
      const state = smsFieldLiveState(name, input.value);
      if (!state) return;
      let msg = field.querySelector('.sms-field-msg');
      if (!msg && (state.error || state.hint)) {
        msg = document.createElement('div');
        msg.className = 'sms-field-msg';
        field.appendChild(msg);
      }
      field.classList.toggle('invalid', !!state.error);
      input.setAttribute('aria-invalid', String(!!state.error));
      if (msg) {
        msg.textContent = state.error || state.hint || '';
        msg.classList.toggle('warn', !!state.error);
        msg.classList.toggle('ok', !!state.ok && !state.error);
      }
    }
    function smsCollect(root, profile){
      const next = mergeSmsProfile(profile);
      const methods = Array.from(root.querySelectorAll('[data-sms-method]'));
      if (methods.length) { next.campaign.optInMethods = methods.filter(input => input.checked).map(input => input.dataset.smsMethod); next.campaign.optInMethod = next.campaign.optInMethods[0] || ''; }
      root.querySelectorAll('[data-sms-field]').forEach((input) => {
        const key = String(input.getAttribute('data-sms-field') || '');
        const value = input.type === 'checkbox' ? !!input.checked : String(input.value || '').trim();
        const target = key.startsWith('brand.') ? next.brand : next.campaign;
        target[key.split('.')[1]] = value;
      });
      const featureInputs = Array.from(root.querySelectorAll('[data-sms-feature]'));
      if (featureInputs.length) {
        next.campaign.enabledFeatures = featureInputs
          .filter((input) => input.checked)
          .map((input) => String(input.getAttribute('data-sms-feature') || '').trim())
          .filter(Boolean);
      }
      const flowAck = root.querySelector('[data-sms-flow-ack]');
      if (flowAck) next.campaign.messageFlowConfirmed = !!flowAck.checked;
      const featureConfirm = root.querySelector('[data-sms-feature-confirm]');
      if (featureConfirm) next.campaign.featuresConfirmed = !!featureConfirm.checked;
      return prepareSmsProfileForSave(next);
    }
    function smsValuePresent(value){
      return String(value || '').trim().length > 0;
    }
    function smsValidWebsite(value){
      const raw = String(value || '').trim();
      if (!raw) return false;
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        const url = new URL(withScheme);
        return (url.protocol === 'http:' || url.protocol === 'https:') && /\./.test(url.hostname);
      } catch(e) {
        return false;
      }
    }
    function smsValidHttpsUrl(value){
      try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password;
      } catch(e) {
        return false;
      }
    }
    function smsValidPhone(value){
      const raw = String(value || '').trim();
      const compact = raw.replace(/[^\d+]/g, '');
      const validNanp = (digits) => /^[2-9]\d{9}$/.test(String(digits || ''));
      if (/^\+1\d{10}$/.test(compact)) return validNanp(compact.slice(2));
      if (/^\+[2-9]\d{7,14}$/.test(compact)) return true;
      const digits = raw.replace(/\D/g, '');
      return (digits.length === 10 && validNanp(digits)) || (digits.length === 11 && digits.startsWith('1') && validNanp(digits.slice(1)));
    }
    function smsValidEmail(value){
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
    }
    function smsNoThirdPartyMarketingSharing(value){
      const disclosure = String(value || '');
      return /\bnot\s+(?:sell\s+or\s+)?share\b[^.]{0,160}\b(?:mobile|phone|SMS|opt[ -]?in)\b[^.]{0,160}\bthird[ -]?part/i.test(disclosure)
        || /\b(?:mobile|phone|SMS|opt[ -]?in)\b[^.]{0,160}\b(?:will|is|are)\s+not\s+(?:be\s+)?(?:sold\s+or\s+)?shared\b[^.]{0,160}\bthird[ -]?part/i.test(disclosure);
    }
    function smsStepIssues(step, profile){
      if (step === 'consent' || step === 'messages') return [...(step === 'consent' ? smsStepIssues('features', profile) : []), ...smsStepIssues('summary', profile).filter(issue => smsIssueTarget(issue).step === step)];
      const brand = profile.brand || {};
      const campaign = profile.campaign || {};
      const missing = [];
      const requireFields = (source, fields) => {
        fields.forEach(([key, label]) => {
          if (!smsValuePresent(source[key])) missing.push(label);
        });
      };
      if (step === 'business') {
        requireFields(brand, [['displayName', 'Brand Name / DBA']]);
        if (String(brand.entityType || '').toUpperCase() !== 'SOLE_PROPRIETOR') {
          requireFields(brand, [['companyName', 'Legal company name'], ['ein', 'EIN']]);
          if (smsValuePresent(brand.ein) && !smsValidEin(brand.ein)) missing.push('EIN must contain exactly 9 digits');
        } else {
          requireFields(brand, [['firstName', 'First name'], ['lastName', 'Last name']]);
        }
        if (String(brand.entityType || '').toUpperCase() === 'PUBLIC_PROFIT') {
          requireFields(brand, [['stockSymbol', 'Stock symbol'], ['stockExchange', 'Stock exchange']]);
        }
        if (!smsValidWebsite(brand.website)) missing.push('Valid website');
        if (String(campaign.description || '').trim().length < 40) missing.push('Campaign description of at least 40 characters');
        if (String(campaign.description || '').length > 600) missing.push('Campaign description: maximum 600 characters');
        if (smsSelectedFeatures(profile).includes('customer_growth') && !/marketing|promotional/i.test(String(campaign.description || ''))) missing.push('Campaign description: Your description must mention marketing and promotional texts.');
      } else if (step === 'contact') {
        requireFields(brand, [
          ['street', 'Street address'],
          ['city', 'City'],
          ['state', 'State'],
          ['postalCode', 'Postal code']
        ]);
        if ([brand.street, brand.address2].filter(Boolean).join(', ').length > 100) missing.push('Street address and unit must fit within 100 characters');
        if (!smsValidEmail(brand.email)) missing.push('Valid support email');
        if (String(brand.entityType || '').toUpperCase() === 'PUBLIC_PROFIT' && !smsValidEmail(brand.businessContactEmail)) missing.push('Valid business contact email');
        if (!smsValidPhone(brand.phone)) missing.push('Valid business phone');
        if (String(brand.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR') {
          requireFields(brand, [['firstName', 'First name'], ['lastName', 'Last name']]);
          if (!smsValidPhone(brand.mobilePhone)) missing.push('Valid mobile phone for OTP');
        }
      } else if (step === 'features') {
        if (String(brand.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR') {
          if (!smsSelectedFeatures(profile).length) missing.push('At least one SMS feature');
        } else if (smsSelectedFeatures(profile).length < 2) missing.push('At least two Low Volume Mixed SMS purposes');
      } else if (step === 'consent') {
        if (String(campaign.optInDisclosure || '').length > 600) missing.push('Consent wording: maximum 600 characters');
        if (String(campaign.messageFlow || '').length > 600) missing.push('Consent process: maximum 600 characters');
        if (smsReviewerFlow(campaign).length > 2048) missing.push('Maximum screenshots submitted. Remove a screenshot or shorten your consent process.');
      } else if (step === 'number') {
        if (!smsNormalizePhone(campaign.selectedNumber)) missing.push('Selected phone number');
      } else if (step === 'summary' || step === 'finalize') {
        smsSteps.filter((item) => ['business', 'contact', 'number'].includes(item.id)).forEach((item) => {
          if (smsStepIssues(item.id, profile).length) missing.push(item.label);
        });
        requireFields(smsGeneratedCampaign(profile), [
          ['description', 'Campaign description'],
          ['messageFlow', 'Opt-in / message flow'],
          ['optInDisclosure', 'Exact SMS consent language'],
          ['privacyPolicyLink', 'Privacy policy URL'],
          ['termsAndConditionsLink', 'SMS terms URL'],
          ['sample1', 'Sample message 1'],
          ['sample2', 'Sample message 2'],
          ['optinMessage', 'Opt-in message'],
          ['optoutMessage', 'Opt-out message'],
          ['helpMessage', 'Help message']
        ]);
        if (String(campaign.description || '').trim().length < 40) missing.push('Campaign description of at least 40 characters');
        if (String(campaign.description || '').length > 600) missing.push('Campaign description: maximum 600 characters');
        if (String(campaign.optInDisclosure || '').length > 600) missing.push('Consent wording: maximum 600 characters');
        if (String(campaign.messageFlow || '').length > 600) missing.push('Consent process: maximum 600 characters');
        if (smsReviewerFlow(campaign).length > 2048) missing.push('Maximum screenshots submitted. Remove a screenshot or shorten your consent process.');
        if (String(campaign.messageFlow || '').trim().length < 40) missing.push('Opt-in flow of at least 40 characters');
        ['sample1', 'sample2', 'sample3', 'sample4', 'sample5'].forEach((key, i) => {
          const sample = String(campaign[key] || '');
          const name = String(brand.displayName || brand.companyName || '').trim();
          if (sample.length > 255) missing.push(`Sample message ${i + 1}: keep it under 256 characters`);
          if (sample && !/\bSTOP\b/i.test(sample)) missing.push(`Sample message ${i + 1}: include STOP to opt out`);
          if (sample && name && !sample.toLowerCase().includes(name.toLowerCase())) missing.push(`Sample message ${i + 1}: name ${name}`);
        });
        if (!smsOptInMethods(campaign).length || smsOptInMethods(campaign).some(method => !['WEBSITE_FORM', 'PAPER_FORM', 'VERBAL', 'KEYWORD'].includes(method))) missing.push('Valid opt-in method');
        if (smsOptInMethods(campaign).includes('WEBSITE_FORM') && !smsValidHttpsUrl(campaign.optInLocationUrl)) missing.push('Public HTTPS opt-in form URL');
        if (smsOptInMethods(campaign).includes('KEYWORD') && !smsValidHttpsUrl(campaign.keywordLocationUrl || (!smsOptInMethods(campaign).includes('WEBSITE_FORM') ? campaign.optInLocationUrl : '')) && !smsEvidence(campaign).some(item=>smsValidHttpsUrl(item.url))) missing.push('Public keyword advertisement or screenshot URL');
        if (smsEvidence(campaign).some(item=>!smsValidHttpsUrl(item.url))) missing.push('Please upload the screenshot again.');
        if (!smsValidHttpsUrl(campaign.privacyPolicyLink)) missing.push('Public HTTPS Privacy Policy URL');
        if (!smsValidHttpsUrl(campaign.termsAndConditionsLink)) missing.push('Public HTTPS SMS Terms URL');
        const disclosure = String(campaign.optInDisclosure || '');
        const businessName = String(brand.displayName || brand.companyName || '').trim();
        if (disclosure.trim()) {
          if (businessName && !disclosure.toLowerCase().includes(businessName.toLowerCase())) missing.push(`Consent script: name ${businessName}`);
          if (!/\b(?:SMS|text messages?|texts?)\b/i.test(disclosure)) missing.push('Consent script: say these are SMS or text messages');
          if (!/\b(?:frequency|freq|messages? per|messages? may vary)\b/i.test(disclosure)) missing.push('Consent script: explain message frequency');
          if (!/\b(?:message|msg)\b.*\bdata rates\b/i.test(disclosure)) missing.push('Consent script: explain message and data rates');
          if (!/\bSTOP\b/i.test(disclosure) || !/\bHELP\b/i.test(disclosure)) missing.push('Consent script: include STOP and HELP');
          if (!smsNoThirdPartyMarketingSharing(disclosure)) missing.push('Consent script: state that mobile or SMS opt-in data is not shared with third parties for marketing');
        }
        if (smsSelectedFeatures(profile).length < 2 && String(brand.entityType || '').toUpperCase() !== 'SOLE_PROPRIETOR') missing.push('At least two Low Volume Mixed purposes');
        if (smsSelectedFeatures(profile).includes('customer_growth')) {
          if (!smsValuePresent(campaign.sample3)) missing.push('Sample message 3: first marketing message');
          if (!smsValuePresent(campaign.sample4)) missing.push('Sample message 4: second marketing message');
          if (campaign.sample3 && campaign.sample4 && campaign.sample3.trim() === campaign.sample4.trim()) missing.push('Sample message 4: use a different marketing message');
        }
        if (smsSelectedFeatures(profile).includes('customer_growth')) {
          if (!/marketing|promotional/i.test(String(campaign.description || ''))) missing.push('Campaign description: Your description must mention marketing and promotional texts.');
          if (!/marketing|promotional/i.test(String(campaign.messageFlow || ''))) missing.push('Opt-in flow: Your description must mention marketing and promotional texts.');
          if (!/marketing|promotional/i.test(disclosure)) missing.push('Consent script: Your description must mention marketing and promotional texts.');
          if (!/consent is not a condition of purchase|not required (?:to|for) (?:a )?purchase/i.test(disclosure)) missing.push('Consent script: state that consent is not required to purchase');
        }
      }
      return missing;
    }
    function smsSummaryIssueText(issue){
      const guidance = {
        'Opt-in flow of at least 40 characters': 'Describe when and how the customer agrees, who records consent, and what confirmation follows (at least 40 characters).',
        'SMS policy confirmation': 'Review the live Privacy Policy and SMS Terms, then check the policy confirmation below.',
        'Opt-in flow confirmation': 'Check the box confirming that the described opt-in flow is accurate.',
        'Marketing sample message': 'Add a real promotional sample message that matches Marketing.',
        'Public HTTPS SMS Terms URL': 'Enter the public HTTPS page containing the SMS program terms.',
        'Public HTTPS Privacy Policy URL': 'Enter the public HTTPS Privacy Policy page.'
      };
      return guidance[issue] || issue;
    }
    function smsIssueTarget(issue){
      const text = String(issue);
      const sampleNumber = text.match(/^Sample message ([1-5])/i)?.[1];
      if (sampleNumber) return { step: 'messages', selector: `[data-sms-field="campaign.sample${sampleNumber}"]` };
      if (/^(Business|Contact|Features|Message types|Number)$/.test(text)) return { step: ({ Business: 'business', Contact: 'contact', Features: 'features', 'Message types': 'features', Number: 'number' })[text] };
      if (/Low Volume|SMS feature|Feature confirmation/.test(text)) return { step: 'features' };
      if (/Opt-in flow confirmation/.test(text)) return { step: 'consent', selector: '[data-sms-flow-ack]' };
      const fields = [
        [/Campaign description/i, 'description', 'business'],
        [/Marketing sample/i, 'sample3', 'messages'],
        [/Sample (?:SMS )?message 1/i, 'sample1', 'messages'],
        [/Sample (?:SMS )?message 2/i, 'sample2', 'messages'],
        [/Sample|Opt-in message|Opt-out message|Help message/i, 'sample1', 'messages'],
        [/Consent script|Consent wording|Exact SMS consent/i, 'optInDisclosure', 'consent'],
        [/Opt-in \/ message flow|Opt-in flow|Consent process/i, 'messageFlow', 'consent'],
        [/Opt-in method/i, 'optInMethods', 'consent'],
        [/Feature confirmation|SMS feature|SMS purposes|Low Volume Mixed purposes/i, '', 'consent'],
        [/keyword advertisement/i, 'keywordLocationUrl', 'consent'],
        [/opt-in form/i, 'optInLocationUrl', 'consent'],
        [/evidence/i, 'optInEvidenceUrl', 'consent'],
        [/Privacy/i, 'privacyPolicyLink', 'consent'],
        [/Terms/i, 'termsAndConditionsLink', 'consent'],
        [/policy confirmation/i, 'policyContentConfirmed', 'consent'],
        [/Website SMS opt-in/i, 'websiteFormConfirmed', 'consent']
      ];
      const brandFields = { 'Brand Name / DBA': 'displayName', 'EIN must contain exactly 9 digits': 'ein', 'Legal company name': 'companyName', EIN: 'ein', 'Stock symbol': 'stockSymbol', 'Stock exchange': 'stockExchange', 'Valid website': 'website', 'Street address': 'street', 'Street address and unit must fit within 100 characters': 'address2', City: 'city', State: 'state', 'Postal code': 'postalCode', 'Valid support email': 'email', 'Valid business contact email': 'businessContactEmail', 'Valid business phone': 'phone', 'First name': 'firstName', 'Last name': 'lastName', 'Valid mobile phone for OTP': 'mobilePhone' };
      if (brandFields[text]) return { step: ['displayName', 'companyName', 'firstName', 'lastName', 'ein', 'stockSymbol', 'stockExchange', 'website'].includes(brandFields[text]) ? 'business' : 'contact', selector: `[data-sms-field="brand.${brandFields[text]}"]` };
      if (/Selected phone number/.test(text)) return { step: 'number', selector: '[data-sms-field="campaign.selectedNumberAreaCode"]' };
      const match = fields.find(([pattern]) => pattern.test(text));
      return match ? { step: match[2], selector: `[data-sms-field="campaign.${match[1]}"]` } : { step: 'summary' };
    }
    function smsIssueLinks(issues){
      return [...new Set(issues)].map(issue => {
        const target = smsIssueTarget(issue);
        return `<li><button type="button" data-sms-fix-step="${target.step}" data-sms-fix-selector="${escapeHtml(target.selector || '')}">${escapeHtml(smsSummaryIssueText(issue))}<span aria-hidden="true"> →</span></button></li>`;
      }).join('');
    }
    function smsStepHeading(step){
      const copy = {
        business: ['Tell us about your business', 'Make sure these details exactly match your tax records.'],
        contact: ['Who should we contact?', ''],
        features: ['What will you text customers?', 'Choose the types of messages you actually send. Your business type determines the registration path.'],
        consent: ['Texting Policies', ''],
        messages: ['Show what customers will receive', ''],
        number: ['Choose your business number', 'This will be your sending number once carrier registration is approved.'],
        summary: ['Review and Submit', '']
      }[step];
      if (!copy) return '';
      return `<header class="sms-step-heading"><span class="sms-eyebrow">STEP ${smsSteps.findIndex(item => item.id === step) + 1} OF ${smsSteps.length}</span><h2>${copy[0]}</h2>${copy[1] ? `<p>${copy[1]}</p>` : ''}</header>`;
    }
    function smsSummaryMissingFields(profile){
      const issues = smsStepIssues('summary', profile);
      const grouped = new Map();
      const labels = {
        description: 'Campaign description', messageFlow: 'Consent process', optInDisclosure: 'Consent wording',
        optInMethods: 'How customers agree', optInLocationUrl: 'SMS signup form',
        keywordLocationUrl: 'Keyword advertisement', optInEvidenceUrl: 'Supporting screenshot',
        privacyPolicyLink: 'Privacy policy', termsAndConditionsLink: 'SMS terms'
      };
      for (const issue of issues) {
        const target = smsIssueTarget(issue);
        const key = `${target.step}:${target.selector || ''}`;
        const field = target.selector?.match(/campaign\.([^"\]]+)/)?.[1];
        const label = labels[field] || (/^Sample message \d/i.test(issue) ? issue.replace(/:.*/, '') : target.step === 'business' && !target.selector ? 'Business information' : target.step === 'number' && !target.selector ? 'Phone number' : smsSummaryIssueText(issue));
        if (!grouped.has(key)) grouped.set(key, {target, label});
      }
      return [...grouped.values()];
    }
    function smsSummaryChecklistHtml(profile){
      const fields = smsSummaryMissingFields(profile);
      return fields.length ? `<strong>${fields.length} missing field${fields.length === 1 ? '' : 's'}</strong><ul>${fields.map(({target,label})=>`<li><button type="button" data-sms-fix-step="${target.step}" data-sms-fix-selector="${escapeHtml(target.selector || '')}">${escapeHtml(label)}<span aria-hidden="true"> →</span></button></li>`).join('')}</ul>`
        : '<strong>Ready to submit</strong>All required registration details are complete.';
    }
    function smsStepStatus(step, index, activeIndex, profile){
      if (step.id === 'summary' && smsRegistrationSubmitted(profile)) {
        const verified = smsRegistrationVerified(profile);
        return {
          cls: 'done',
          icon: verified ? 'fa-check' : 'fa-clock',
          label: verified ? 'Verified' : smsHasProviderCampaign(profile) ? 'Campaign submitted' : smsBrandReadyForCampaign(profile) ? 'Business verified' : 'Business submitted'
        };
      }
      const issues = step.id === 'summary' ? smsSummaryMissingFields(profile) : smsStepIssues(step.id, profile);
      const hasPassed = index < activeIndex;
      const isActive = index === activeIndex;
      if (hasPassed && issues.length) {
        return {
          cls: 'needs-attention',
          icon: 'fa-exclamation',
          label: ((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_ce3c7a7c239dd1",`Needs ${v0} item${v1}`,{v0,v1}) ?? `Needs ${v0} item${v1}`)(issues.length,issues.length === 1 ? '' : 's')
        };
      }
      if ((hasPassed || isActive) && !issues.length) {
        return {
          cls: 'done',
          icon: 'fa-check',
          label: (globalThis.PlatformLanguage?.text("settings","m_e8e493437c1a17","Complete") ?? "Complete")
        };
      }
      return {
        cls: '',
        icon: 'fa-circle',
        label: isActive && issues.length ? `Needs ${issues.length} item${issues.length === 1 ? '' : 's'}` : ''
      };
    }
    function smsFinalFeaturePills(profile){
      const selected = new Set(smsSelectedFeatures(profile));
      const features = smsFeatureOptions.filter((feature) => selected.has(feature.id));
      if (!features.length) return `<span class="sms-final-feature"><i class="fas fa-triangle-exclamation"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_d146ca61ebecc7"," None selected") ?? " None selected")}</span>`;
      return features.map((feature) => `<span class="sms-final-feature"><i class="fas ${escapeHtml(feature.icon || 'fa-message')}"></i>${escapeHtml(feature.label)}</span>`).join('');
    }
    function smsReviewRows(profile){
      const brand = profile.brand || {};
      const contact = [brand.firstName, brand.lastName].filter(Boolean).join(' ').trim() || 'Not set';
      const businessPhone = smsFormatE164ForDisplay(brand.phone) || brand.phone || 'Not set';
      return `
        <div class="sms-final-grid">
          <div class="sms-final-panel">
            <h4><i class="fas fa-building"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_e85c828dc8cd78"," Business") ?? " Business")}</h4>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_dc8d40b3a46dad","Legal name") ?? "Legal name")}</span><strong>${String(escapeHtml(smsLegalName(brand) || brand.displayName || 'Not set'))}</strong></div>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_0e681dc1798ea4","Website") ?? "Website")}</span><strong>${String(escapeHtml(brand.website || 'Not set'))}</strong></div>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_8d6bf72e0170a0","Business phone") ?? "Business phone")}</span><strong>${String(escapeHtml(businessPhone))}</strong></div>
          </div>
          <div class="sms-final-panel">
            <h4><i class="fas fa-user-check"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_120b4ae51d0c1d"," Contact") ?? " Contact")}</h4>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_8cf345002184e5","Name") ?? "Name")}</span><strong>${String(escapeHtml(contact))}</strong></div>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</span><strong>${String(escapeHtml(brand.email || 'Not set'))}</strong></div>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_53d803cdbe9ab1","Address") ?? "Address")}</span><strong>${String(escapeHtml([brand.street, brand.address2, brand.city, brand.state, brand.postalCode].filter(Boolean).join(', ') || 'Not set'))}</strong></div>
          </div>
        </div>
        <div class="sms-final-summary-grid">
          <div class="sms-final-panel">
            <h4><i class="fas fa-phone"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_0912bf5a2cd0ef"," Phone number") ?? " Phone number")}</h4>
            <div class="sms-final-row"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_7ed66a4e107033","Phone number") ?? "Phone number")}</span><strong>${String(escapeHtml(smsFormatSelectedNumber(profile) || 'Not set'))}</strong></div>
            ${smsAdditionalNumbers(profile).map(number => `<div class="sms-final-row"><span>${escapeHtml(number.assignment_status === 'assigned' ? 'Active number' : 'Activating number')}</span><strong>${escapeHtml(smsFormatE164ForDisplay(number.phone_number) || number.phone_number)}</strong></div>`).join('')}
          </div>
        </div>`;
    }
    function smsLogEventsToConsole(profile){
      const events = Array.isArray(profile?.events) ? profile.events : [];
      if (!events.length || !window.console?.debug) return;
      const key = events.map((event) => `${event?.at || ''}:${event?.type || ''}`).join('|');
      if (profile.__smsEventsConsoleKey === key) return;
      try {
        Object.defineProperty(profile, '__smsEventsConsoleKey', {
          value: key,
          configurable: true,
          enumerable: false,
          writable: true
        });
      } catch(e) {
        profile.__smsEventsConsoleKey = key;
      }
      console.debug('FirstMate SMS registration events', events);
    }
    function smsFeatureTiles(profile){
      const selected = new Set(smsSelectedFeatures(profile));
      const locked = smsRegistrationLocked(profile);
      return `<div class="sms-feature-grid">${String(smsFeatureOptions.map((feature) => `
        <label class="sms-feature-tile ${locked ? 'locked' : ''}">
          <input type="checkbox" data-sms-feature="${escapeHtml(feature.id)}" ${selected.has(feature.id) ? 'checked' : ''}${locked ? ' disabled' : ''}>
          <span class="sms-feature-copy"><strong>${escapeHtml(feature.label)}</strong><span>${escapeHtml(feature.description)}</span></span>
        </label>
      `).join(''))}</div>
      `;
    }
    function smsNumberSelection(profile, numberSearch = {}){
      const c = profile.campaign || {}, adding = !!numberSearch.adding && smsCanAddNumber(profile), locked = smsRegistrationLocked(profile) && !adding, choice = numberSearch.choice;
      const selected = choice?.phone_number || c.selectedNumber || '', purchased = !!profile.provider_refs?.telnyx_number_order_id;
      const canChange = !locked && !smsHasProviderCampaign(profile) && (!purchased || profile.phone_number_status === 'success');
      const query = String(numberSearch.query ?? c.selectedNumberAreaCode ?? '').replace(/\D/g,'').slice(0,6);
      const selectedHtml = selected ? `<section class="sms-section"><div class="sms-section-title"><div><h3>${escapeHtml(smsFormatE164ForDisplay(selected) || selected)}</h3><p>${escapeHtml([choice?.locality || c.selectedNumberLocality, choice?.region || c.selectedNumberRegion].filter(Boolean).join(', '))}</p></div>${canChange ? '<button type="button" class="sms-text-button" data-sms-change-number>Choose a different number</button>' : ''}</div>${smsAdditionalNumbers(profile).map(number => `<div class="sms-final-row"><strong>${escapeHtml(smsFormatE164ForDisplay(number.phone_number) || number.phone_number)}</strong><span>${escapeHtml(number.assignment_status === 'assigned' ? 'Active' : number.status === 'failed' ? 'Order failed' : 'Activating')}</span></div>`).join('')}${smsCanAddNumber(profile) && !adding ? '<button type="button" class="sms-text-button" data-sms-add-number>Add another number</button>' : ''}</section>` : '';
      if (selected && !numberSearch.choosing && !adding) return selectedHtml + (choice ? '<p class="sms-muted">Provider charges apply when you reserve this number.</p>' : '');
      const results = numberSearch.results || [];
      return `${selectedHtml}<div class="sms-number-search"><div class="sms-number-search-row"><div class="sms-field wide"><label for="sms-number-search">Enter desired area code</label><input id="sms-number-search" data-sms-field="campaign.selectedNumberAreaCode" inputmode="numeric" placeholder="e.g. 206" maxlength="6" value="${escapeHtml(query)}" ${locked?'disabled':''}></div></div>
        <p class="sms-muted" role="status">${escapeHtml(numberSearch.message || '')}</p><div class="sms-number-grid">${results.filter(number => number.phone_number !== c.selectedNumber && !smsAdditionalNumbers(profile).some(item => item.phone_number === number.phone_number)).map(number=>{const value=number.phone_number;return `<button class="sms-number-option ${value===choice?.phone_number?'selected':''}" type="button" data-sms-choose-number="${escapeHtml(value)}" ${locked?'disabled':''}><strong>${escapeHtml(smsFormatE164ForDisplay(value)||value)}</strong><span>${escapeHtml([number.locality,number.region].filter(Boolean).join(', ') || 'US local number')}</span></button>`;}).join('')}</div>${adding ? `<div class="sms-evidence-actions"><button type="button" class="cs-btn primary" data-sms-reserve-additional ${choice?'':'disabled'}>Reserve additional number</button><button type="button" class="cs-btn" data-sms-cancel-additional>Cancel</button></div>` : ''}</div>`;
    }
    function smsSubmissionBanner(profile){
      const status = smsCustomerRegistrationStatus(profile);
      const verified = smsRegistrationVerified(profile);
      const campaignSubmitted = smsHasProviderCampaign(profile);
      const brandReady = smsBrandReadyForCampaign(profile);
      const submittedAt = smsRegistrationSubmittedAt(profile);
      const needsOtp = profile?.brand?.entityType === 'SOLE_PROPRIETOR' && !brandReady && !campaignSubmitted;
      return `
        <div class="sms-submitted-panel ${verified ? 'verified' : 'pending'}">
          <div class="sms-submitted-icon"><i class="fas ${verified ? 'fa-circle-check' : 'fa-clock'}"></i></div>
          <h4>${verified ? 'You’re ready to text' : campaignSubmitted ? 'Your campaign is under review' : brandReady ? 'Your business is verified' : needsOtp ? 'Verify your mobile number' : 'Business verification in progress'}</h4>
          <p>${verified ? 'Your number is activated for the selected SMS message types.' : campaignSubmitted ? 'Your campaign has been submitted to the carriers. While this page is open, approval and number activation update automatically.' : brandReady ? 'Review your campaign details below, then select Submit campaign to start carrier review.' : needsOtp ? 'Send a verification code to your personal mobile number and enter it below. After identity verification, submit your campaign for carrier review.' : 'Telnyx is reviewing your business details. Status updates automatically while this page is open. You can keep refining your campaign while you wait.'}</p>
          <div class="sms-submitted-meta">
            ${submittedAt ? `<span><i class="fas fa-calendar-check"></i>${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_9a19fffc189408",` Submitted ${v0}`,{v0}) ?? ` Submitted ${v0}`)(escapeHtml(submittedAt))}</span>` : ''}
            <span><i class="fas ${verified ? 'fa-circle-check' : 'fa-hourglass-half'}"></i> ${escapeHtml(status.label)}</span>
          </div>
        </div>`;
    }
    function smsSoleProprietorOtpPanel(profile){
      const sole = String(profile?.brand?.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR';
      if (!sole || !smsHasProviderBrand(profile) || smsBrandReadyForCampaign(profile)) return '';
      const requested = !!profile?.provider_refs?.telnyx_brand_otp_reference_id;
      return `<div class="sms-consent-box">
        <h4>${(globalThis.PlatformLanguage?.htmlText("settings","m_399753b6ce7e9d","Sole proprietor identity verification") ?? "Sole proprietor identity verification")}</h4>
        <p>We will send a one-time verification code to ${escapeHtml(smsFormatE164ForDisplay(profile?.brand?.mobilePhone) || profile?.brand?.mobilePhone || 'the registered mobile phone')}.</p>
        <div class="li-actions">
          <button class="cs-btn" type="button" id="smsRequestOtp"><i class="fas fa-mobile-screen"></i> ${String(requested ? 'Resend Code' : 'Send Code')}</button>
          ${String(requested ? `<button class="cs-btn" type="button" id="smsRefreshOtp"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_41c5620d127a91"," Check Delivery") ?? " Check Delivery")}</button>` : '')}
        </div>
        ${String(requested ? `<div class="sms-form-grid"><div class="sms-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_d0d19cbf76feca","Verification Code") ?? "Verification Code")}</label><input id="smsOtpPin" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_cda0acf85ca254","Enter code") ?? "Enter code")}"></div></div><button class="cs-btn primary" type="button" id="smsVerifyOtp"><i class="fas fa-shield-check"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2335584aef9f38"," Verify Code") ?? " Verify Code")}</button>` : '')}
      </div>`;
    }
    const smsLinkFields = ['brand.website', 'campaign.optInLocationUrl', 'campaign.keywordLocationUrl', 'campaign.optInEvidenceUrl', 'campaign.privacyPolicyLink', 'campaign.termsAndConditionsLink'];
    const smsConsentLabels = { WEBSITE_FORM: 'Website form', PAPER_FORM: 'Paper form', VERBAL: 'Verbal agreement', KEYWORD: 'Text a keyword' };
    function smsOptInMethods(campaign = {}){
      return Array.isArray(campaign.optInMethods) ? campaign.optInMethods : (campaign.optInMethod ? [campaign.optInMethod] : []);
    }
    function smsEvidence(campaign = {}){
      const publicUrl = value => {
        const raw = String(value || '');
        try {
          const url = new URL(raw);
          if (window.location.protocol === 'https:' && ['127.0.0.1','localhost'].includes(url.hostname) && url.pathname.startsWith('/v1/messaging/sms/evidence/')) return window.location.origin + url.pathname;
        } catch(e) {}
        return raw;
      };
      return Array.isArray(campaign.optInEvidence) ? campaign.optInEvidence.map(item=>({url:publicUrl(item?.url),name:String(item?.name || 'Evidence link')})) : campaign.optInEvidenceUrl ? [{url:publicUrl(campaign.optInEvidenceUrl),name:'Evidence link'}] : [];
    }
    function smsReviewerFlow(c){
      return [String(c.messageFlow || '').trim(), `Opt-in methods: ${smsOptInMethods(c).map(method=>method.replace(/_/g,' ')).join(', ')}.`, c.keywordLocationUrl ? `Keyword advertisement: ${c.keywordLocationUrl}.` : '', c.optInLocationUrl ? `Opt-in location: ${c.optInLocationUrl}.` : '', smsEvidence(c).length ? `Public opt-in evidence: ${smsEvidence(c).map(item=>item.url).join(', ')}.` : '', `Exact recipient-facing SMS consent language: ${c.optInDisclosure || ''}`, `Privacy Policy: ${c.privacyPolicyLink || ''}. SMS Terms: ${c.termsAndConditionsLink || ''}.`].filter(Boolean).join(' ');
    }
    function smsExample(title, text){
      return `<details class="sms-details"><summary>${escapeHtml(title)}</summary><div class="sms-example-copy">${escapeHtml(text)}</div></details>`;
    }
    function smsConsentContent(profile){
      const c = profile.campaign || {}, methods = smsOptInMethods(c), website = methods.includes('WEBSITE_FORM'), keyword = methods.includes('KEYWORD');
      const brand = smsCompanyName(profile), marketing = smsSelectedFeatures(profile).includes('customer_growth');
      const purposes = marketing ? 'customer conversations, operational updates, and marketing or promotional offers' : 'customer conversations and operational updates';
      const disclosure = `I agree to receive recurring SMS messages from ${brand} about ${purposes}. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. ${marketing ? 'Consent is not a condition of purchase. ' : ''}SMS opt-in data and consent will not be shared with third parties for marketing. See our Privacy Policy at [privacy URL] and SMS Terms at [terms URL].`;
      const process = {
        WEBSITE_FORM: `Customers visit [direct signup URL], enter their mobile number, and choose a separate, optional SMS checkbox that is unchecked by default. The checkbox shows our consent wording and links to our privacy policy and SMS terms. We record the wording, timestamp, source, and phone number. ${marketing ? 'Marketing permission is explicit and is not required to purchase. ' : ''}We send a confirmation naming ${brand} with STOP and HELP instructions.`,
        PAPER_FORM: `Customers at [location] enter their mobile number and sign a paper form showing ${brand}'s SMS consent wording and policy links. Staff retain the signed form and record the date and permitted message types${marketing ? ', including explicit marketing consent' : ''} before sending a confirmation with STOP and HELP. A blank example form is linked as evidence.`,
        VERBAL: `During [phone call or in-person interaction], staff read the complete SMS consent script, including ${purposes}, and ask the customer to agree. We record [how and where agreement is retained], the date, number, and script version. ${marketing ? 'We obtain and retain explicit written/electronic marketing consent through [actual confirmation process] before promotional texts. ' : ''}We send a confirmation naming ${brand} with STOP and HELP instructions.`,
        KEYWORD: `Customers see [advertisement URL/location] showing the keyword [KEYWORD], our sending number, the full consent wording for ${purposes}, and policy links. They text [KEYWORD] to [number]. We retain the incoming message and timestamp and send a confirmation naming ${brand} with STOP and HELP instructions.`
      };
      const link = (key, label, value, required=false) => smsField('campaign.'+key,label,value,{required,wide:true,inputmode:'url',placeholder:'example.com/'+(key.includes('Evidence')?'consent-example.pdf':'signup')});
      return `<div class="sms-consent-content"><section class="sms-section"><h3>How will your business use texting?</h3>${smsFeatureTiles(profile)}</section>
        <section class="sms-section"><h3>How do your customers agree to receive text messages?</h3><p>Select every method your business uses.</p><div class="sms-form-grid">${Object.entries(smsConsentLabels).map(([key,label])=>`<label class="sms-ack"><input type="checkbox" data-sms-method="${key}" ${methods.includes(key)?'checked':''}><span>${label}</span></label>`).join('')}</div>
        ${website ? `<div class="sms-consent-box sms-signup-card">${link('optInLocationUrl','Link to your SMS signup form',c.optInLocationUrl,true)}<p>Your SMS signup form must include:</p><ul><li>A separate, optional SMS checkbox, unchecked by default</li><li>Your brand name and message types</li><li>Message frequency and rates</li><li>STOP and HELP instructions</li><li>Links to your privacy policy and SMS terms</li></ul><p>Marketing consent must be explicit and not required to purchase.</p></div>` : ''}
        <div class="sms-form-grid">${keyword ? link('keywordLocationUrl','Link to the keyword advertisement',c.keywordLocationUrl || (!website ? c.optInLocationUrl : ''),!smsEvidence(c).length) : ''}
        ${smsField('campaign.optInDisclosure','Consent wording customers see or hear',c.optInDisclosure,{kind:'textarea',wide:true,required:true,maxlength:600,placeholder:'Write the exact wording used for each selected method.'})}</div>
        ${smsExample('See example consent wording',disclosure)}
        <div class="sms-form-grid">${smsField('campaign.messageFlow','Describe your consent process',c.messageFlow,{kind:'textarea',wide:true,required:true,maxlength:600,inlineHelp:true,placeholder:'Explain each selected method, where it happens, and how you keep proof of consent.'})}</div>
        ${methods.map(method=>smsExample('See an example consent process description: '+smsConsentLabels[method],process[method] || '')).join('')}
        <section class="sms-evidence"><div class="sms-section-title"><div><h3>Supporting evidence <span class="sms-muted">Optional</span></h3><p>Upload screenshots of your consent form or advertisement.</p></div></div>
        <ul class="sms-evidence-list">${smsEvidence(c).map((item,index)=>`<li><a href="${escapeHtml(smsValidHttpsUrl(item.url)?item.url:'#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name || 'Evidence link')}</a><button type="button" class="sms-text-button" data-sms-remove-evidence="${index}" aria-label="Remove ${escapeHtml(item.name || 'evidence link')}">Remove</button></li>`).join('')}</ul>
        <div class="sms-evidence-actions"><button type="button" class="cs-btn" data-sms-upload-trigger>Upload screenshots</button><input hidden id="sms-evidence-file" type="file" multiple data-sms-evidence-upload accept="image/png,image/jpeg"><span class="sms-muted">PNG or JPEG · 5 MB per screenshot</span></div>
        <p class="sms-muted" data-sms-evidence-room>${2048-smsReviewerFlow(c).length < 240 ? 'Maximum screenshots submitted' : ''}</p>
        <p class="sms-evidence-feedback" data-sms-upload-status role="status"></p></section></section>
        <section class="sms-section"><h3>Public policies</h3><p>Link to your privacy policy and link to your SMS terms.</p><div class="sms-consent-box"><p>Your privacy policy should explain what information you collect, how you use it, how customers contact you, and that SMS opt-in data is not shared with third parties for marketing.</p><p>Your SMS terms should identify the business, describe the message types and frequency, disclose message/data rates, explain STOP and HELP, provide support contact details, and link to your privacy policy. Marketing consent cannot be a condition of purchase. Publish both pages where anyone can open them.</p></div>
        <div class="sms-form-grid">${link('privacyPolicyLink','Link to your privacy policy',c.privacyPolicyLink,true)}${link('termsAndConditionsLink','Link to your SMS terms',c.termsAndConditionsLink,true)}</div>
        ${smsExample('See an example privacy policy: SMS section',`${brand} collects your mobile number and SMS consent record to send the messages you requested. We retain consent and opt-out records to manage your choices. Mobile information, SMS opt-in data, and consent will not be sold or shared with third parties for their marketing or promotional purposes. We may use service providers solely to deliver and support our messaging service. You can opt out by replying STOP. Contact [support email] about privacy requests.`)}
        ${smsExample('See an example of SMS terms',`${brand} SMS Program
By opting in, you agree to receive ${purposes}. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for assistance. Contact [support email or phone]. ${marketing ? 'Consent is not a condition of purchase. ' : ''}Carriers are not liable for delayed or undelivered messages. See our Privacy Policy at [privacy URL].`)}</section></div>`;
    }
    function smsMessagesContent(profile){
      const c = profile.campaign || {};
      const marketing = smsSelectedFeatures(profile).includes('customer_growth');
      const brand = smsCompanyName(profile);
      const examples = [
        `Hi Jane, this is ${brand}. Thanks for contacting us. How can we help with your project? Reply STOP to opt out.`,
        `Hi Jane, this is ${brand}. Your appointment is confirmed for tomorrow at 10:00 AM. Reply HELP for help or STOP to opt out.`,
        `Hi Jane, ${brand} has a seasonal offer available this week. Contact us for details. Reply STOP to opt out.`,
        `${brand}: Join us at our open house this Saturday to explore our services and meet the team. Reply STOP to opt out.`
      ];
      const sample = (n, title, required) => `<div class="sms-message-card">${smsField('campaign.sample' + n, title, c['sample' + n], { kind: 'textarea', wide: true, required, maxlength: 255, inlineHelp: true, placeholder: 'Write a message your business would actually send.', hint: 'Use your business name and include STOP to opt out.' })}${smsExample('See an example message',examples[n-1] || examples[0])}</div>`;
      return `        <div class="sms-message-grid">${sample(1, 'Customer conversation', true)}${sample(2, 'Update or reminder', true)}${marketing ? sample(3, 'Marketing message 1', true) + sample(4, 'Marketing message 2', true) : ''}</div>
        <details class="sms-details" ${(!marketing && (c.sample3 || c.sample4)) || c.sample5 ? 'open' : ''}><summary>More messages <span>Optional</span></summary><div class="sms-message-grid">${!marketing ? sample(3, 'Additional message', false) : ''}${!marketing ? sample(4, 'Additional message', false) : ''}${sample(5, 'Additional message', false)}</div></details>
        <details class="sms-details"><summary>Automatic START, STOP and HELP replies</summary><p>These messages are configured automatically.</p>${['optinMessage', 'optoutMessage', 'helpMessage'].map((key, i) => `<div class="sms-auto-reply"><strong>${['START', 'STOP', 'HELP'][i]}</strong><p>${escapeHtml(smsGeneratedCampaign(profile)[key])}</p></div>`).join('')}</details>`;
    }
    function smsRegistrationTimeline(profile, compact = false){
      const brand = smsBrandReadyForCampaign(profile);
      const campaign = smsHasProviderCampaign(profile);
      const active = smsRegistrationVerified(profile);
      const states = [
        ['Business verification', brand ? 'Verified by Telnyx' : smsHasProviderBrand(profile) ? 'Verification in progress' : 'Starts when you submit', brand, !brand && smsHasProviderBrand(profile)],
        ['Campaign review', active ? 'Approved by carriers' : campaign ? 'Submitted for carrier review' : brand ? 'Ready to submit' : 'After business verification', active, !active && campaign],
        ['Number activation', active ? 'Ready to send' : 'After carrier approval', active, false]
      ];
      return `<ol class="sms-timeline">${states.map(([title, note, done, pending], i) => `<li class="${done ? 'done' : pending ? 'pending' : ''}"><span class="sms-timeline-dot">${done ? '<i class="fas fa-check" aria-hidden="true"></i>' : i + 1}</span><div><strong>${title}</strong>${compact ? '' : `<span>${note}</span>`}</div></li>`).join('')}</ol>`;
    }
    function smsSummaryContent(profile){
      const submitted = smsHasProviderCampaign(profile) && smsRegistrationLocked(profile);
      const campaign = profile.campaign || {};
      const edit = (step, label) => submitted ? '' : `<button type="button" class="sms-text-button" data-sms-fix-step="${step}">${label}<span aria-hidden="true"> →</span></button>`;
      const status = String(profile.campaign_status || '') === 'auto_submit_failed' ? 'We couldn’t finish submitting your campaign. Review the details below, then try again.' : smsHasProviderCampaign(profile) ? 'Your SMS registration is under review. Approval and number activation update automatically.' : smsHasProviderBrand(profile) ? profile.campaign?.autoSubmitCampaign === true ? smsBrandReadyForCampaign(profile) ? 'Your business is verified. We’re submitting your campaign automatically.' : 'Business verification is in progress. Your campaign will be submitted automatically once it is verified.' : smsBrandReadyForCampaign(profile) ? 'Your business is verified. Submit your campaign to finish registration.' : 'Business verification is in progress.' : '';
      return `${status ? `<p class="sms-review-status" role="status">${status}</p>` : ''}
        ${smsSoleProprietorOtpPanel(profile)}
        ${smsReviewRows(profile)}
        ${smsCanAddNumber(profile) ? '<button type="button" class="sms-text-button" data-sms-fix-step="number">Add another number to this campaign</button>' : ''}
        <section class="sms-section sms-review-section"><div class="sms-section-title"><div><h3>Consent & policies</h3><p>${escapeHtml(smsOptInMethods(campaign).map(method => smsConsentLabels[method]).join(', ') || 'Consent methods not selected')}</p></div>${edit('consent', 'Review consent')}</div><div class="sms-review-links">${[['Privacy policy', campaign.privacyPolicyLink, 'privacyPolicyLink'], ['SMS terms', campaign.termsAndConditionsLink, 'termsAndConditionsLink']].map(([label, url, field]) => smsValidHttpsUrl(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : `<button type="button" class="sms-review-missing" data-sms-fix-step="consent" data-sms-fix-selector='[data-sms-field="campaign.${field}"]'>Add ${label}</button>`).join('')}</div></section>
        <section class="sms-section sms-review-section"><div class="sms-section-title"><div><h3>Message examples</h3><p>${[campaign.sample1, campaign.sample2, campaign.sample3, campaign.sample4, campaign.sample5].filter(Boolean).length} examples prepared for carrier review</p></div>${edit('messages', 'Review messages')}</div></section>
        ${submitted ? '' : `<div class="sms-summary-checklist ${smsStepIssues('summary', profile).length ? '' : 'ready'}" data-sms-summary-checklist aria-live="polite">${smsSummaryChecklistHtml(profile)}</div>`}`;
    }
    function smsStepContent(step, profile, options = {}){
      const brand = profile.brand || {};
      const locked = smsRegistrationLocked(profile) || smsHasProviderBrand(profile);
      if (step === 'business') {
        const soleProprietor = String(brand.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR';
        const publicCompany = String(brand.entityType || '').toUpperCase() === 'PUBLIC_PROFIT';
        const websiteNormalized = smsNormalizeWebsite(brand.website);
        return `<div class="sms-form-grid">
          ${smsField('brand.entityType', 'Business type', brand.entityType, { kind: 'select', values: smsOptions.entityTypes, disabled: locked, wide: true })}
          ${soleProprietor ? smsField('brand.firstName', 'Legal first name', brand.firstName, { required: true, disabled: locked, autocomplete: 'given-name', hint: 'Your name as it appears on government-issued ID.' }) + smsField('brand.lastName', 'Legal last name', brand.lastName, { required: true, disabled: locked, autocomplete: 'family-name' }) : smsField('brand.companyName', 'Legal company name', brand.companyName, { required: true, disabled: locked, wide: true, hint: 'Match the business name on your IRS EIN record.' })}
          <label class="sms-ack" style="grid-column:1/-1"><input type="checkbox" data-sms-field="brand.sameAsLegalName" ${brand.sameAsLegalName ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>Brand Name / DBA is the same as my legal name</span></label>
          ${smsField('brand.displayName', 'Brand Name / DBA', brand.sameAsLegalName ? smsLegalName(brand) : brand.displayName, { required: true, disabled: locked || !!brand.sameAsLegalName, wide: true })}
          ${smsField('brand.vertical', 'Industry', brand.vertical, { kind: 'select', values: smsOptions.verticals, disabled: locked })}
          ${!soleProprietor ? smsField('brand.ein', 'EIN', smsFormatEin(brand.ein), { required: true, disabled: locked, inputmode: 'numeric', placeholder: '12-3456789', hint: '9-digit federal tax ID. Do not enter a Social Security number.', error: brand.ein && !smsValidEin(brand.ein) ? smsFieldLiveState('brand.ein', brand.ein).error : '' }) : ''}
          ${publicCompany ? smsField('brand.stockSymbol', 'Stock Symbol', brand.stockSymbol, { required: true, disabled: locked, error: !smsValuePresent(brand.stockSymbol) ? 'Stock symbol is required.' : '' }) : ''}
          ${publicCompany ? smsField('brand.stockExchange', 'Stock Exchange', brand.stockExchange, { kind: 'select', values: smsOptions.stockExchanges, required: true, disabled: locked }) : ''}
          ${smsField('brand.website', soleProprietor ? 'Business website or professional social profile' : 'Website', brand.website, {
            required: true,
            disabled: locked,
            placeholder: 'example.com',
            inputmode: 'url',
            autocomplete: 'url',
            error: !brand.website ? 'Website is required.' : brand.website && !websiteNormalized ? 'Enter a valid website.' : '',
            hint: '',
            ok: !!websiteNormalized
          })}
          ${smsField('campaign.description', 'Campaign description', profile.campaign?.description, { kind: 'textarea', wide: true, required: true, maxlength: 600, inlineHelp: true, disabled: smsHasProviderCampaign(profile), hint: 'Describe your business and the messages you will send. Minimum 40 characters.' })}
        </div>${smsExample('See an example campaign description', '[Business name] uses FirstMate CRM to text customers who have opted in. We answer customer questions and send appointment and service updates. Where customers separately agree, we also send marketing or promotional offers. Customers give permission through [actual opt-in method] before we text them.')}`;
      }
      if (step === 'contact') {
        const soleProprietor = String(brand.entityType || '').toUpperCase() === 'SOLE_PROPRIETOR';
        const publicCompany = String(brand.entityType || '').toUpperCase() === 'PUBLIC_PROFIT';
        const phoneNormalized = smsNormalizePhone(brand.phone);
        const phoneDisplay = smsFormatE164ForDisplay(brand.phone);
        const emailValid = smsValidEmail(brand.email);
        return `<div class="sms-form-grid">
          ${!soleProprietor ? smsField('brand.firstName', 'Contact first name', brand.firstName, { disabled: locked }) : ''}
          ${!soleProprietor ? smsField('brand.lastName', 'Contact last name', brand.lastName, { disabled: locked }) : ''}
          ${smsField('brand.email', 'Support Email', brand.email, { type: 'email', required: true, disabled: locked, error: !brand.email ? 'Support email is required.' : brand.email && !emailValid ? 'Enter a valid support email.' : '', ok: emailValid })}
          ${publicCompany ? smsField('brand.businessContactEmail', 'Business Contact Email', brand.businessContactEmail, { type: 'email', required: true, disabled: locked, error: !smsValidEmail(brand.businessContactEmail) ? 'A valid business contact email is required.' : '' }) : ''}
          ${smsField('brand.phone', 'Business Phone', brand.phone, {
            required: true,
            disabled: locked,
            error: !brand.phone ? 'Business phone is required.' : brand.phone && !phoneNormalized ? 'Enter a valid US/Canada phone number.' : '',
            hint: '',
            ok: !!phoneNormalized
          })}
          ${soleProprietor ? smsField('brand.mobilePhone', 'Mobile Phone for Verification', brand.mobilePhone, { required: true, disabled: locked, error: !brand.mobilePhone ? 'A US/Canada mobile phone is required for Telnyx OTP verification.' : !smsNormalizePhone(brand.mobilePhone) ? 'Enter a valid mobile phone.' : '', hint: 'We will send a one-time verification code to this number.' }) : ''}
          ${smsField('brand.street', 'Street Address', brand.street, { wide: true, required: true, disabled: locked, autocomplete: 'off', error: !smsValuePresent(brand.street) ? 'Street address is required.' : '' })}
          ${smsField('brand.address2', 'Apartment, suite, or unit (optional)', brand.address2, { wide: true, disabled: locked, autocomplete: 'address-line2', placeholder: 'Suite 200' })}
          ${smsField('brand.city', 'City', brand.city, { required: true, disabled: locked, error: !smsValuePresent(brand.city) ? 'City is required.' : '' })}
          ${smsField('brand.state', 'State', brand.state, { required: true, disabled: locked, error: !smsValuePresent(brand.state) ? 'State is required.' : '' })}
          ${smsField('brand.postalCode', 'Postal Code', brand.postalCode, { required: true, disabled: locked, error: !smsValuePresent(brand.postalCode) ? 'Postal code is required.' : '' })}
        </div>`;
      }
      if (step === 'consent') return smsConsentContent(profile);
      if (step === 'messages') return smsMessagesContent(profile);
      if (step === 'number') return smsNumberSelection(profile, options.numberSearch || {});
      return smsSummaryContent(profile);
    }
    function smsRegistrationHome(profile, profiles = [], setup = {}){
      const started = !!profile.id;
      const mock = smsProfileIsMock(profile) || (profile.events || []).some(event => event.mock === true && ['brand_submitted','campaign_submitted'].includes(event.type));
      const needsAttention = [profile.status, profile.brand_status, profile.campaign_status, profile.phone_number_status].some(value => /fail|reject|unverified|suspend|expire|cancel/i.test(String(value || '')));
      const active = smsRegistrationVerified(profile);
      const hasCampaign = smsHasProviderCampaign(profile);
      const hasBrand = smsHasProviderBrand(profile);
      let view = { tone:'neutral', badge: started ? 'Draft saved' : 'Not started', title: started ? 'Let’s finish your registration' : 'Get your business ready to text', detail: started ? 'Pick up where you left off. We’ll guide you through the remaining details before you submit.' : 'Register your business and texting number with the carriers to send SMS to your customers.', action: started ? 'Continue registration' : 'Start registration', icon:'fa-message' };
      if (hasBrand) view = { tone:'pending', badge:'Business verification', title:'Your business is being verified', detail:'Your campaign will be submitted automatically once verification is complete.', action:'View registration', icon:'fa-clock' };
      if (hasBrand && smsBrandReadyForCampaign(profile)) view = { tone:'pending', badge:'Business verified', title:'Your campaign is being submitted', detail:'We’re finishing your registration automatically.', action:'View registration', icon:'fa-clock' };
      if (hasCampaign) view = { tone:'pending', badge:'Carrier review', title:'Your campaign is under review', detail:'Your campaign has been submitted.', action:'View registration status', icon:'fa-clock' };
      if (hasCampaign && String(profile.campaign_status || '').toLowerCase() === 'mno_provisioned') view = { tone:'pending', badge:'Number activation', title:'Finish activating your texting number', detail:'Carrier review is complete. Your number is awaiting activation.', action:'Continue activation', icon:'fa-phone' };
      if (active) view = { tone:'ready', badge:'Ready to text', title:'Your business texting is ready', detail:'Your registration is approved and your number is active. You can review the registered business and messaging details here.', action:'View registration', icon:'fa-circle-check' };
      if (needsAttention) view = { tone:'attention', badge:'Action needed', title:'Your registration needs attention', detail:'Open registration to review the latest carrier response and the available next steps.', action:'Review registration', icon:'fa-circle-exclamation' };
      if (mock) view = { tone:'neutral', badge:'Development setup', title:'This is a test registration', detail:'This setup is for development testing. It does not represent carrier approval for live customer messages.', action:'View test registration', icon:'fa-flask' };
      const complete = smsSteps.filter(step => step.id !== 'summary' && !smsStepIssues(step.id, profile).length).length;
      const business = profile.brand?.companyName || profile.brand?.displayName || setup.organization?.name || 'Add your business details';
      const number = smsFormatSelectedNumber(profile) || 'Choose during setup';
      return `<section class="sms-entry" aria-labelledby="sms-entry-title">
        <header class="sms-entry-header"><div><h2 id="sms-entry-title">SMS registration</h2><p>U.S. mobile carriers require 10DLC registration to verify businesses sending text messages through software using local phone numbers.</p></div></header>
        <div class="sms-entry-card ${view.tone}">
          <div class="sms-entry-main"><span class="sms-entry-icon" aria-hidden="true"><i class="fas ${view.icon}"></i></span><div class="sms-entry-copy"><h3>${escapeHtml(view.title)}</h3><p>${escapeHtml(view.detail)}</p>
            ${started && !hasBrand && !needsAttention && !mock ? `<div class="sms-entry-progress"><progress value="${complete}" max="5" aria-label="Registration sections completed"></progress><span>${complete} of 5 sections complete</span></div>` : ''}

          </div></div>
          ${hasBrand && !needsAttention && !mock ? `<div class="sms-entry-tracking"><h3>Registration progress</h3>${smsRegistrationTimeline(profile, true)}</div>` : ''}
          <div class="${started ? 'sms-entry-preview' : ''}">
          ${started ? `<dl class="sms-entry-facts"><div><dt>Business</dt><dd>${escapeHtml(business)}</dd></div><div><dt>Texting number</dt><dd>${escapeHtml(number)}</dd></div><div><dt>Message types</dt><dd>${escapeHtml(smsFeatureOptions.filter(option=>smsSelectedFeatures(profile).includes(option.id)).map(option=>option.label).join(' · ') || 'Choose during setup')}</dd></div></dl>` : ''}
          <div class="sms-entry-action"><button class="cs-btn primary" type="button" id="smsStartSetup">${started ? 'View full application' : 'Start registration'} <i class="fas fa-arrow-right" aria-hidden="true"></i></button></div>
          </div>
        </div>
        <p class="sms-muted sms-auto-status" data-sms-auto-status role="status"></p>
        ${profiles.length > 1 ? `<details class="sms-entry-other"><summary>Other registrations (${profiles.length - 1})</summary>${profiles.slice(1).map(item=>`<div><span>${escapeHtml(item.brand?.displayName || item.brand?.companyName || 'Business registration')}</span><button class="cs-btn" type="button" data-open-sms-profile="${escapeHtml(item.id || '')}">View registration</button></div>`).join('')}</details>` : ''}
      </section>`;
    }
    const smsStatusInFlight = new Map();
    function smsProviderStatusPending(profile){
      if (!profile?.id || smsProfileIsMock(profile)) return false;
      if (smsAdditionalNumbers(profile).some(number => !['failed','failure','cancelled','deleted','released'].includes(String(number.status || '').toLowerCase()) && number.assignment_status !== 'assigned')) return true;
      if (smsRegistrationVerified(profile)) return false;
      const statuses = [profile.status, profile.brand_status, profile.campaign_status, profile.phone_number_status].join(' ').toLowerCase();
      if (/deactivat|fail|reject|unverified|suspend|expire|cancel/.test(statuses)) return false;
      return smsHasProviderCampaign(profile) || (smsHasProviderBrand(profile) && (!smsBrandReadyForCampaign(profile) || profile.campaign?.autoSubmitCampaign === true))
        || (!!profile.provider_refs?.telnyx_number_order_id && !['success', 'draft', ''].includes(String(profile.phone_number_status || '').toLowerCase()));
    }
    async function smsFetchRegistrationStatus(orgId, profile, canRefresh = () => true){
      const key = `${orgId}:${profile.id}`;
      if (smsStatusInFlight.has(key)) return smsStatusInFlight.get(key);
      const request = (async () => {
        const path = `/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}`;
        const saved = await messagingRequest(path);
        const current = saved.profile || profile;
        if (!smsProviderStatusPending(current) || !canRefresh()) return current;
        const refreshed = await messagingRequest(`${path}/refresh-status`, { method:'POST', body:{} });
        return refreshed.profile || current;
      })();
      smsStatusInFlight.set(key, request);
      try { return await request; } finally { smsStatusInFlight.delete(key); }
    }
    function smsStatusFingerprint(profile){
      return JSON.stringify([profile?.status, profile?.brand_status, profile?.campaign_status, profile?.phone_number_status, profile?.phone_number_campaign_status, profile?.provider_refs, profile?.autoresponse_state]);
    }
    function smsWatchRegistrationStatus({ root, getProfile, onProfile, onError, enabled = () => true, intervalMs = 30000 }){
      const orgId = currentOrgId();
      let stopped = false, running = false, timer = null, lastCheck = 0, failures = 0;
      const visible = () => root.isConnected && document.visibilityState !== 'hidden' && navigator.onLine !== false && root.getClientRects().length > 0 && enabled();
      const schedule = () => { if (!stopped) timer = setTimeout(check, Math.min(intervalMs * (2 ** failures), 120000)); };
      const stop = () => {
        stopped = true; clearTimeout(timer);
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake); window.removeEventListener('online', wake);
      };
      const check = async () => {
        clearTimeout(timer);
        if (stopped) return;
        if (!root.isConnected) { stop(); return; }
        if (running) return;
        const profile = getProfile();
        if (!visible() || !profile?.id || smsProfileIsMock(profile)) { schedule(); return; }
        running = true; lastCheck = Date.now();
        try {
          const latest = await smsFetchRegistrationStatus(orgId, profile, () => !stopped && visible() && getProfile() === profile);
          failures = 0;
          if (!stopped && visible() && getProfile() === profile) { onProfile(latest); onError?.(''); }
        } catch (error) {
          failures = Math.min(failures + 1, 3);
          if (!stopped && visible()) onError?.('Couldn’t check the latest status. Retrying automatically.');
        } finally { running = false; schedule(); }
      };
      const wake = () => { if (!root.isConnected) stop(); else if (Date.now() - lastCheck >= 5000) void check(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake); window.addEventListener('online', wake);
      timer = setTimeout(check, 0);
      return stop;
    }
    let smsHomeStatusStop = null;
    let phoneSettingsHandle = null;
    async function renderSmsSettings(){
      const paneSms = env.paneSms();
      if(!paneSms)return;
      phoneSettingsHandle?.destroy?.();
      if(!appFlag('apps','comms'))return renderSmsRegistration(paneSms);
      if(!window.FirstMatePhoneSettings?.mount){paneSms.textContent='Phone Settings could not load. Refresh the page.';return;}
      phoneSettingsHandle=await window.FirstMatePhoneSettings.mount(paneSms,{orgId:currentOrgId(),initialTab:readSettingsRoute().workflow==='10dlc'?'registration':'personal',registration:renderSmsRegistration});
    }
    async function renderSmsRegistration(host = env.paneSms()){
      if (!host) return;
      smsHomeStatusStop?.();
      smsHomeStatusStop = null;
      const orgId = currentOrgId();
      host.innerHTML = `<div class="cs-section"><h3>${(globalThis.PlatformLanguage?.htmlText("settings","phone_registration_title","10DLC Registration") ?? "10DLC Registration")}</h3><p class="cs-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_a0a4311c5f28de","Loading SMS setup...") ?? "Loading SMS setup...")}</p></div>`;
      try {
        let setup;
        smsRegistrationLiveMode = false;
        if (window.PlatformAPI?.appFlags?.has?.('platform','sms_settings')) {
          setup = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/setup`);
          smsRegistrationLiveMode = setup.telnyx?.registration_live === true;
        }
        if (!smsRegistrationLiveMode && await window.FirstMatePlatformBilling?.setup(host, {orgId,canView:canPlatformBilling,capabilityKeys:['comms.sms','apps.messaging','platform.sms_settings'],onReady:()=>renderSmsRegistration(host)})) return;
        setup ||= await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/setup`);
        smsRegistrationLiveMode = setup.telnyx?.registration_live === true;
        let profiles = Array.isArray(setup.profiles) ? setup.profiles.map((item) => smsPrefillProfile(item, setup)) : [];
        let eligibleProfiles = smsRegistrationLiveMode ? profiles.filter((item) => !(item.events || []).some((event) => ['brand_submitted','brand_updated','campaign_submitted'].includes(event.type) && event.mock === true)) : profiles;
        let profile = eligibleProfiles[0] || smsPrefillProfile({}, setup);
        const paint = () => {
          host.innerHTML = smsRegistrationHome(profile, eligibleProfiles, setup);
          if (!smsRegistrationLiveMode) void window.Portal?.PhoneTray?.developmentSetup(host);
          host.querySelector('#smsStartSetup')?.addEventListener('click', () => openSmsWizard(profile, { initialStep: smsHasProviderBrand(profile) || smsHasProviderCampaign(profile) ? 'summary' : smsResumeStep(profile) }));
          host.querySelectorAll('[data-open-sms-profile]').forEach((button) => {
            button.addEventListener('click', () => {
              const selected = profiles.find((item) => item.id === button.getAttribute('data-open-sms-profile')) || profile;
              openSmsWizard(selected, { initialStep: smsHasProviderBrand(selected) || smsHasProviderCampaign(selected) ? 'summary' : smsResumeStep(selected) });
            });
          });
        };
        paint();
        smsHomeStatusStop = smsWatchRegistrationStatus({ root:host, getProfile:() => profile,
          enabled:() => !document.querySelector('[data-fm-wizard="sms-workflow"]'),
          onProfile:latest => {
            if (smsStatusFingerprint(latest) === smsStatusFingerprint(profile)) return;
            profile = smsPrefillProfile(latest, setup);
            profiles = profiles.map(item => item.id === profile.id ? profile : item);
            eligibleProfiles = eligibleProfiles.map(item => item.id === profile.id ? profile : item);
            paint();
          },
          onError:message => { const note = host.querySelector('[data-sms-auto-status]'); if (note) note.textContent = message; }
        });
        const route = readSettingsRoute();
        if (route.workflow === '10dlc' && env.activeTab() === 'sms' && !document.querySelector('[data-fm-wizard="sms-workflow"]')) {
          openSmsWizard(profile, { initialStep: route.workflowStep || smsResumeStep(profile) });
        }
      } catch (error) {
        host.innerHTML = `<section class="sms-entry"><header class="sms-entry-header"><h2>SMS registration</h2></header><div class="sms-entry-card attention"><div class="sms-entry-main"><div class="sms-entry-copy" role="alert"><h3>Registration couldn’t load</h3><p>${escapeHtml(error?.message || 'Please try again to load your saved registration.')}</p><div class="sms-entry-action"><button class="cs-btn" type="button" data-sms-retry>Try again</button></div></div></div></div></section>`;
        host.querySelector('[data-sms-retry]')?.addEventListener('click', () => renderSmsRegistration(host));
      }
    }
    function openSmsWizard(initialProfile, options = {}){
      const orgId = currentOrgId();
      if (!window.FirstMateSetupWizard?.open) {
        showToast((globalThis.PlatformLanguage?.text("settings","m_745c6e69fcb21b","SMS setup unavailable") ?? "SMS setup unavailable"), (globalThis.PlatformLanguage?.text("settings","m_09e7fcfa03e4a9","The setup wizard library did not load.") ?? "The setup wizard library did not load."), false);
        return;
      }
      const rawRequestedStep = String(options.initialStep || readSettingsRoute().workflowStep || '').trim();
      const requestedStep = rawRequestedStep === 'features' ? 'consent' : rawRequestedStep === 'finalize' || rawRequestedStep === 'submitted' ? 'summary' : rawRequestedStep;
      let developmentStatus = null;
      const carrierRegistration = smsRegistrationLiveMode;
      let profile = smsPrefillProfile(initialProfile || {});
      let numberSearch = { query: profile.campaign?.selectedNumberSearch || profile.campaign?.selectedNumberAreaCode || '', areaCode: profile.campaign?.selectedNumberAreaCode || '', results: [], searched: false, message: '' };
      let numberSearchTimer = null;
      let numberSearchRevision = 0;
      let refocusNumberSearch = false;
      let ctxRef = null;
      let wizard = null;
      let stopStatusUpdates = null;
      let automaticStatusError = '';
      let operationBusy = false;
      let operationMessage = '';
      let submissionError = '';
      const attemptedSteps = new Set();
      const rootEl = () => wizard?.el || ctxRef?.root || null;
      const refresh = () => ctxRef?.refresh?.();
      const refreshEvidence = (scrollTop) => {
        refresh();
        const pane = rootEl()?.querySelector('.fm-wizard-pane');
        if (pane) { const behavior=pane.style.scrollBehavior;pane.style.scrollBehavior='auto';pane.scrollTop=scrollTop;pane.style.scrollBehavior=behavior; }
      };
      const setStatus = (text) => ctxRef?.setStatus?.(text);
      const persistDraft = async () => {
        if(developmentStatus?.onboarded)return;
        const source = rootEl();
        profile = prepareSmsProfileForSave(source ? smsCollect(source, profile) : mergeSmsProfile(profile));
        try {
          const savingProfile = profile;
          const payload = { ...(smsHasProviderBrand(profile) ? {} : { brand: profile.brand }), campaign: profile.campaign };
          const result = profile.id
            ? await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}`, { method: 'PATCH', body: payload })
            : await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles`, { method: 'POST', body: payload });
          profile = mergeSmsProfile({ ...(result.profile || profile), ...(profile !== savingProfile ? { brand: profile.brand, campaign: profile.campaign } : {}) });
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("settings","m_348d6bcfc41fb7","SMS setup save failed") ?? "SMS setup save failed"), error?.message || 'Could not save draft.', false);
          throw error;
        }
      };
      // Telnyx-backed flows must persist before acting (a save can create the
      // draft row that later calls need); marking the shell autosave dirty makes
      // flushAutosave perform a real save instead of skipping a clean state.
      const flushDraft = async () => {
        if (smsRegistrationLocked(profile)) return true;
        if (!ctxRef) return false;
        ctxRef.touch();
        return (await ctxRef.flushAutosave()) === true;
      };
      const markCurrentStepInvalid = (message = '') => {
        attemptedSteps.add(ctxRef?.stepId);
        const stepButton = rootEl()?.querySelector(`[data-fm-step="${ctxRef?.stepId || ''}"]`);
        const workspace = rootEl()?.querySelector('.sms-workspace');
        [stepButton, workspace].forEach((el) => {
          if (!el) return;
          el.classList.remove('sms-shake');
          void el.offsetWidth;
          el.classList.add('sms-shake');
        });
        if (message) {
          setStatus(message);
        }
      };
      const updateSummaryValidation = () => {
        const checklist = rootEl()?.querySelector('[data-sms-summary-checklist]');
        const issues = smsStepIssues('summary', profile);
        if (checklist) {
          checklist.classList.toggle('ready', issues.length === 0);
          checklist.innerHTML = smsSummaryChecklistHtml(profile);
        }
        rootEl()?.querySelectorAll('[data-sms-counter]').forEach(counter => {
          const name = counter.dataset.smsCounter;
          counter.textContent = `${String(profile.campaign?.[name.split('.')[1]] || '').length} / ${counter.dataset.smsMax} characters`;
        });
        const evidenceRoom = rootEl()?.querySelector('[data-sms-evidence-room]');
        if (evidenceRoom) evidenceRoom.textContent = 2048 - smsReviewerFlow(profile.campaign || {}).length < 240 ? 'Maximum screenshots submitted' : '';
        const stepErrors = rootEl()?.querySelector('[data-sms-step-errors]');
        if (stepErrors && attemptedSteps.has(ctxRef?.stepId)) {
          const currentIssues = smsStepIssues(ctxRef.stepId, profile);
          stepErrors.innerHTML = currentIssues.length ? `<strong>Finish these details to continue</strong><ul>${smsIssueLinks(currentIssues)}</ul>` : '';
        }
        for (const [name, prefix] of [['campaign.description', 'Campaign description:'], ['campaign.messageFlow', 'Opt-in flow:'], ['campaign.optInDisclosure', 'Consent script:']]) {
          const input = rootEl()?.querySelector(`[data-sms-field="${name}"]`);
          const field = input?.closest('.sms-field');
          if (!field) continue;
          let message = field.querySelector('.sms-field-msg');
          if (!message) {
            message = document.createElement('div');
            message.className = 'sms-field-msg';
            field.appendChild(message);
          }
          const warnings = attemptedSteps.has(ctxRef?.stepId) ? issues.filter((issue) => issue.startsWith(prefix)) : [];
          if (!attemptedSteps.has(ctxRef?.stepId)) continue;
          message.textContent = warnings.map(warning => warning.slice(prefix.length).trim()).join(' ');
          message.classList.toggle('warn', warnings.length > 0);
          field.classList.toggle('invalid', warnings.length > 0);
          input.setAttribute('aria-invalid', warnings.length ? 'true' : 'false');
        }
        const submit = rootEl()?.querySelector('#smsSubmitMock');
        if (submit) {
          submit.disabled = operationBusy || smsRegistrationLocked(profile);
          submit.title = '';
        }
        const note = rootEl()?.querySelector('[data-fm-note]');
        if (note && ctxRef?.stepId === 'summary') note.textContent = operationBusy ? operationMessage || 'Saving…' : smsHasProviderCampaign(profile) ? smsCustomerRegistrationStatus(profile).label : issues.length ? 'Missing fields are listed below.' : 'Ready for submission.';
      };
      const submitMock = async (submitOptions = {}) => {
        if (numberSearch.choice) { await ctxRef?.goTo?.('number'); submissionError = 'Reserve your new number choice before submitting.'; refresh(); return; }
        if (operationBusy) return;
        operationBusy = true;
        submissionError = '';
        if (!submitOptions.replaceRejectedCampaign && !smsHasProviderCampaign(profile)) profile.campaign = { ...profile.campaign, autoSubmitCampaign: true };
        if (!(await flushDraft())) {
          operationBusy = false;
          refresh();
          return;
        }
        const finalIssues = smsStepIssues('summary', profile);
        if (finalIssues.length) {
          operationBusy = false;
          attemptedSteps.add('summary');
          const message = `Please finish: ${finalIssues.slice(0, 3).join(', ')}${finalIssues.length > 3 ? '...' : ''}`;
          setStatus(message);
          showToast((globalThis.PlatformLanguage?.text("settings","m_ae559ed49f99f8","Registration incomplete") ?? "Registration incomplete"), message, false);
          refresh();
          return;
        }
        operationMessage = smsHasProviderBrand(profile) ? 'Checking registration…' : 'Submitting business…';
        setStatus(operationMessage);
        refresh();
        try {
          if (!smsHasProviderBrand(profile) || /failed|rejected|unverified/.test(String(profile?.brand_status || '').toLowerCase())) {
            const brand = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/submit-brand`, { method: 'POST', body: { submit: true } });
            profile = mergeSmsProfile(brand.profile || profile);
          }
          if (smsHasProviderBrand(profile)) {
            try {
              const refreshed = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/refresh-status`, { method: 'POST', body: {} });
              profile = mergeSmsProfile(refreshed.profile || profile);
            } catch(e) {}
          }
          if (!smsBrandReadyForCampaign(profile)) {
            await ctxRef?.goTo?.('summary');
            setStatus('Business verification is in progress. Your campaign will be submitted automatically after approval.');
            showToast('Registration started', 'Your campaign will be submitted automatically after business verification.', true);
            return;
          }
          setStatus('Submitting SMS campaign...');
          operationMessage = 'Submitting campaign…';
          refresh();
          const campaign = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/submit-campaign`, {
            method: 'POST',
            body: { submit: true, ...(submitOptions.replaceRejectedCampaign ? { replace_rejected_campaign: true } : {}) }
          });
          profile = mergeSmsProfile(campaign.profile || profile);
          await ctxRef?.goTo?.('summary');
          setStatus('SMS registration submitted.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_2f88ed2671fbaf","SMS registration submitted") ?? "SMS registration submitted"), (globalThis.PlatformLanguage?.text("settings","sms_registration_auto_status","Status and number activation update automatically while this setup is open.") ?? "Status and number activation update automatically while this setup is open."), true);
        } catch (error) {
          const message = error?.message || 'Submission failed.';
          submissionError = message;
          setStatus(message);
          showToast((globalThis.PlatformLanguage?.text("settings","m_7ad47f94a88151","Submission failed") ?? "Submission failed"), message, false);
          try {
            const refreshed = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}`);
            profile = mergeSmsProfile(refreshed.profile || profile);
          } catch(e) {}
        } finally {
          operationBusy = false;
          refresh();
        }
      };
      const searchSmsNumbers = async (queryInput) => {
        const revision = ++numberSearchRevision;
        const areaInput = rootEl()?.querySelector('[data-sms-field="campaign.selectedNumberAreaCode"]');
        const query = String(queryInput ?? areaInput?.value ?? numberSearch.query ?? '').replace(/\D/g, '').slice(0, 6);
        const areaCode = query.slice(0, 3);
        if (query.length < 3) {
          numberSearch = { ...numberSearch, query, areaCode, results: [], searched: false, message: '' };
          profile = prepareSmsProfileForSave({ ...smsCollect(rootEl(), profile), campaign: { ...smsCollect(rootEl(), profile).campaign, selectedNumberSearch: query, selectedNumberAreaCode: areaCode } });
          refocusNumberSearch = true;
          refresh();
          return;
        }
        if (!smsValidAreaCode(areaCode)) {
          numberSearch = { ...numberSearch, query, areaCode, results: [], searched: true, message: (globalThis.PlatformLanguage?.text("settings","m_79ec023f394f16","Enter a valid three digit area code.") ?? "Enter a valid three digit area code.") };
          refocusNumberSearch = true;
          refresh();
          return;
        }
        profile = prepareSmsProfileForSave({ ...smsCollect(rootEl(), profile), campaign: { ...smsCollect(rootEl(), profile).campaign, selectedNumberSearch: query, selectedNumberAreaCode: areaCode } });
        setStatus('Searching numbers...');
        numberSearch = { ...numberSearch, query, areaCode, results: [], searched: true, message: (globalThis.PlatformLanguage?.text("settings","m_1868baee889a75","Searching...") ?? "Searching...") };
        const saved = await flushDraft();
        if (revision !== numberSearchRevision) return;
        if (!saved) {
          numberSearch = { ...numberSearch, message: (globalThis.PlatformLanguage?.text("settings","m_2bb1ea5a2c0f54","Save the registration before searching numbers.") ?? "Save the registration before searching numbers.") };
          refresh();
          return;
        }
        if (!profile.id) {
          numberSearch = { ...numberSearch, query, areaCode, message: (globalThis.PlatformLanguage?.text("settings","m_2bb1ea5a2c0f54","Save the registration before searching numbers.") ?? "Save the registration before searching numbers.") };
          refocusNumberSearch = true;
          refresh();
          return;
        }
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/available-numbers?area_code=${encodeURIComponent(areaCode)}`);
          if (revision !== numberSearchRevision) return;
          const allNumbers = Array.isArray(result.numbers) ? result.numbers : [];
          const filtered = allNumbers.filter((number) => String(number.phone_number || number.phoneNumber || '').replace(/\D/g, '').startsWith(`1${query}`));
          numberSearch = {
            ...numberSearch,
            query,
            areaCode,
            results: filtered,
            searched: true,
            message: filtered.length === 0 ? 'No numbers found.' : ((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_022bb1598621d6",`${v0} number${v1} found.`,{v0,v1}) ?? `${v0} number${v1} found.`)(filtered.length,filtered.length === 1 ? '' : 's')
          };
          setStatus('Choose a number.');
          refocusNumberSearch = true;
          refresh();
        } catch (error) {
          if (revision !== numberSearchRevision) return;
          numberSearch = { ...numberSearch, query, areaCode, results: [], searched: true, message: error?.message || 'Could not search numbers.' };
          setStatus(numberSearch.message);
          showToast((globalThis.PlatformLanguage?.text("settings","m_8fa5b8f8f0f191","Number search failed") ?? "Number search failed"), numberSearch.message, false);
          refocusNumberSearch = true;
          refresh();
        }
      };
      const scheduleSmsNumberSearch = (input) => {
        ++numberSearchRevision;
        const query = String(input?.value || '').replace(/\D/g, '').slice(0, 6);
        if (input && input.value !== query) input.value = query;
        numberSearch = { ...numberSearch, query, areaCode: query.slice(0, 3), message: query.length < 3 ? '' : 'Searching...' };
        profile = prepareSmsProfileForSave({ ...smsCollect(rootEl(), profile), campaign: { ...smsCollect(rootEl(), profile).campaign, selectedNumberSearch: query, selectedNumberAreaCode: query.slice(0, 3) } });
        if (numberSearchTimer) clearTimeout(numberSearchTimer);
        numberSearchTimer = setTimeout(() => {
          numberSearchTimer = null;
          searchSmsNumbers(query);
        }, 320);
      };
      const chooseSmsNumber = (button) => {
        if (!button || operationBusy || (smsRegistrationLocked(profile) && !numberSearch.adding)) return;
        const choice = numberSearch.results.find(number => number.phone_number === button.dataset.smsChooseNumber);
        if (!choice) return;
        ++numberSearchRevision;
        if (numberSearchTimer) { clearTimeout(numberSearchTimer); numberSearchTimer = null; }
        numberSearch = { ...numberSearch, choice, choosing: false }; refresh();
      };
      const reserveSmsNumber = async () => {
        const choice = numberSearch.choice; if (!choice) return true;
        const phoneNumber = choice.phone_number, displayNumber = smsFormatE164ForDisplay(phoneNumber) || phoneNumber;
        const locality = choice.locality || '', region = choice.region || '', monthlyCost = choice.monthly_cost || '', setupCost = choice.setup_cost || '', currency = choice.currency || 'USD';
        const adding = !!numberSearch.adding && smsCanAddNumber(profile);
        const replacing = !!profile.provider_refs?.telnyx_number_order_id && !adding;
        operationBusy = true;
        operationMessage = 'Reserving number…';
        submissionError = '';
        setStatus('Purchasing selected number...');
        refresh();
        if (!(await flushDraft())) {
          operationBusy = false;
          refresh();
          return;
        }
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/${adding ? 'add-number' : 'select-number'}`, {
            method: 'POST',
            body: {
              phone_number: phoneNumber,
              replace_number: replacing,
              display_number: displayNumber,
              area_code: phoneNumber.replace(/\D/g, '').slice(1, 4),
              locality,
              region,
              features: ['sms', 'mms'],
              monthly_cost: monthlyCost,
              setup_cost: setupCost,
              currency
            }
          });
          profile = mergeSmsProfile(result.profile || profile);
          numberSearch = { ...numberSearch, choice: null, choosing: false, adding: false, query: '', areaCode: '', results: [], message: adding ? 'Additional number ordered. Activation updates automatically.' : (globalThis.PlatformLanguage?.text("settings","m_fa0a2f29423c02","Selected number saved.") ?? "Selected number saved.") };
          setStatus(result.ordered ? 'Number order submitted.' : 'Selected number saved.');
          showToast(result.ordered ? 'Number ordered' : 'Number selected', result.ordered ? `${displayNumber} is being provisioned for SMS.` : `${displayNumber} saved for SMS setup.`, true);
          refresh();
          return true;
        } catch (error) {
          setStatus(error?.message || 'Could not save selected number.');
          submissionError = error?.message || 'Could not reserve this number. Search again and choose another.';
          showToast((globalThis.PlatformLanguage?.text("settings","m_9246d1d96d3c1c","Number save failed") ?? "Number save failed"), error?.message || 'Could not save selected number.', false);
          refresh();
        } finally {
          operationBusy = false;
          refresh();
        }
      };
      const refreshProviderStatus = async () => {
        if (operationBusy) return;
        operationBusy = true;
        operationMessage = 'Checking status…';
        submissionError = '';
        if (!(await flushDraft())) { operationBusy = false; refresh(); return; }
        setStatus('Refreshing Telnyx status...');
        refresh();
        try {
          const refreshed = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/refresh-status`, { method: 'POST', body: {} });
          profile = mergeSmsProfile(refreshed.profile || profile);
          const message = profile.status === 'active' ? 'Your number is ready to send.' : smsBrandReadyForCampaign(profile) && !smsHasProviderCampaign(profile) ? 'Business verified. Submit your campaign to start carrier review.' : 'Status checked. Review the progress below.';
          setStatus(message);
          showToast((globalThis.PlatformLanguage?.text("settings","m_cf6debae01e48e","SMS status refreshed") ?? "SMS status refreshed"), message, true);
        } catch (error) {
          submissionError = error?.message || 'Could not check registration status. Try again.';
          setStatus(error?.message || 'Could not refresh SMS status.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_79a4923321ea11","Status refresh failed") ?? "Status refresh failed"), error?.message || 'Could not refresh SMS status.', false);
        }
        operationBusy = false;
        refresh();
      };
      const appealCampaign = async () => {
        const appealReason = String(window.prompt(
          (globalThis.PlatformLanguage?.text("settings","m_60c4e128d606e0","Explain what external compliance issue was corrected (for example, the website privacy policy or terms were updated). This appeals the existing campaign and does not submit edited campaign fields.") ?? "Explain what external compliance issue was corrected (for example, the website privacy policy or terms were updated). This appeals the existing campaign and does not submit edited campaign fields."),
          ''
        ) || '').trim();
        if (!appealReason) return;
        if (appealReason.length < 20) {
          showToast((globalThis.PlatformLanguage?.text("settings","m_eb89cad1650482","Appeal reason is too short") ?? "Appeal reason is too short"), (globalThis.PlatformLanguage?.text("settings","m_3bfcfab657e4ea","Enter at least 20 characters describing the correction.") ?? "Enter at least 20 characters describing the correction."), false);
          return;
        }
        if (!(await flushDraft())) {
          refresh();
          return;
        }
        setStatus('Submitting campaign appeal...');
        refresh();
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/appeal-campaign`, {
            method: 'POST',
            body: { appeal_reason: appealReason }
          });
          profile = mergeSmsProfile(result.profile || profile);
          setStatus('Campaign appeal submitted for manual review.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_8886b8954b3ed0","Campaign appealed") ?? "Campaign appealed"), (globalThis.PlatformLanguage?.text("settings","m_2e0fd1c451023b","Sending remains paused until Telnyx and the carriers approve it again.") ?? "Sending remains paused until Telnyx and the carriers approve it again."), true);
        } catch (error) {
          setStatus(error?.message || 'Could not submit the campaign appeal.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_758afe33c66048","Campaign appeal failed") ?? "Campaign appeal failed"), error?.message || 'Could not submit the campaign appeal.', false);
        }
        refresh();
      };
      const replaceRejectedCampaign = async () => {
        const confirmed = window.confirm((globalThis.PlatformLanguage?.text("settings","m_f5350e72d02fc7","Create a new corrected campaign? Telnyx will charge a new campaign subscription/review fee, and FirstMate will move the phone number only after the replacement is fully approved.") ?? "Create a new corrected campaign? Telnyx will charge a new campaign subscription/review fee, and FirstMate will move the phone number only after the replacement is fully approved."));
        if (!confirmed) return;
        await submitMock({ replaceRejectedCampaign: true });
      };
      const requestSoleProprietorOtp = async () => {
        setStatus('Requesting verification code...');
        refresh();
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/sole-proprietor/otp/request`, { method: 'POST', body: {} });
          profile = mergeSmsProfile(result.profile || profile);
          setStatus('Verification code sent.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_f132a0ca31d71a","Verification code sent") ?? "Verification code sent"), (globalThis.PlatformLanguage?.text("settings","m_21d14d145102f0","Check the registered mobile phone for the Telnyx code.") ?? "Check the registered mobile phone for the Telnyx code."), true);
        } catch (error) {
          setStatus(error?.message || 'Could not request the verification code.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_f8df465eff1b0d","Code request failed") ?? "Code request failed"), error?.message || 'Could not request the verification code.', false);
        }
        refresh();
      };
      const refreshSoleProprietorOtp = async () => {
        setStatus('Checking code delivery...');
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/sole-proprietor/otp/status`);
          profile = mergeSmsProfile(result.profile || profile);
          setStatus(`OTP status: ${String(result.otp?.deliveryStatus || profile.brand_status || 'pending').replace(/_/g, ' ')}`);
        } catch (error) {
          setStatus(error?.message || 'Could not check code delivery.');
        }
        refresh();
      };
      const verifySoleProprietorOtp = async () => {
        const pin = String(rootEl()?.querySelector('#smsOtpPin')?.value || '').replace(/\D/g, '');
        if (pin.length < 4) {
          showToast((globalThis.PlatformLanguage?.text("settings","m_075677640ae58c","Enter verification code") ?? "Enter verification code"), (globalThis.PlatformLanguage?.text("settings","m_a4c8aff05e41cb","Enter the code sent to the registered mobile phone.") ?? "Enter the code sent to the registered mobile phone."), false);
          return;
        }
        setStatus('Verifying code...');
        try {
          const result = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/sole-proprietor/otp/verify`, { method: 'POST', body: { otp_pin: pin } });
          profile = mergeSmsProfile(result.profile || profile);
          setStatus('Identity verified. Continue setup to submit the campaign.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_cc54adb1c290cf","Identity verified") ?? "Identity verified"), (globalThis.PlatformLanguage?.text("settings","m_985dd26605eeb6","Identity verified. Continue setup to submit the campaign.") ?? "Identity verified. Continue setup to submit the campaign."), true);
        } catch (error) {
          setStatus(error?.message || 'The verification code was not accepted.');
          showToast((globalThis.PlatformLanguage?.text("settings","m_4654f6ef5b00de","Verification failed") ?? "Verification failed"), error?.message || 'The verification code was not accepted.', false);
        }
        refresh();
      };
      const initSmsAddressAutocomplete = async () => {
        if (smsRegistrationLocked(profile) || smsHasProviderBrand(profile)) return;
        const overlayEl = rootEl();
        const input = overlayEl?.querySelector('[data-sms-field="brand.street"]');
        if (!input) return;
        if (input.__smsAutocomplete) return;
        input.__smsAutocomplete = 'loading';
        try {
          await smsEnsureGooglePlaces();
          if (!document.body.contains(overlayEl) || !document.body.contains(input)) return;
          input.__smsAutocomplete = new window.google.maps.places.Autocomplete(input, {
            fields: ['formatted_address', 'geometry', 'address_components', 'name'],
            types: ['address']
          });
          input.__smsAutocomplete.addListener('place_changed', () => {
            const place = input.__smsAutocomplete.getPlace() || {};
            profile = smsApplyGooglePlace(smsCollect(rootEl(), profile), place);
            ['street', 'address2', 'city', 'state', 'postalCode'].forEach((key) => {
              const field = rootEl()?.querySelector(`[data-sms-field="brand.${key}"]`);
              if (field) field.value = profile.brand?.[key] || '';
            });
            ctxRef?.touch?.();
            refresh();
          });
        } catch(e) {
          input.__smsAutocomplete = null;
          console.debug('FirstMate SMS address autocomplete unavailable', e);
        }
      };
      const bindWorkspaceInputs = (container) => {
        container.querySelectorAll('[data-sms-field], [data-sms-method], [data-sms-feature], [data-sms-feature-confirm], [data-sms-flow-ack]').forEach((input) => {
          input.addEventListener('input', () => {
            if (operationBusy || input.disabled || (smsRegistrationLocked(profile) && !(numberSearch.adding && input.getAttribute('data-sms-field') === 'campaign.selectedNumberAreaCode'))) return;
            const inputFieldName = String(input.getAttribute('data-sms-field') || '');
            if (inputFieldName === 'brand.ein') {
              const position = input.selectionStart;
              const before = input.value;
              input.value = smsFormatEin(before);
              if (position != null) { const caret = position + input.value.length - before.length; input.setSelectionRange(caret, caret); }
            }
            if (inputFieldName === 'brand.phone') {
              const formatted = smsFormatPhoneInput(input.value);
              if (formatted && formatted !== input.value) input.value = formatted;
            }
            if (inputFieldName === 'campaign.selectedNumberAreaCode') {
              scheduleSmsNumberSearch(input);
            }
            smsRefreshInputValidity(input);
            profile = smsCollect(rootEl(), profile);
            if (profile.brand.sameAsLegalName) {
              const nameInput = rootEl()?.querySelector('[data-sms-field="brand.displayName"]');
              if (nameInput) nameInput.value = profile.brand.displayName;
            }
            updateSummaryValidation();
            ctxRef?.touch?.();
          });
          if (smsLinkFields.includes(input.dataset.smsField)) input.addEventListener('blur', () => {
            if (input.disabled || operationBusy) return;
            const normalized = smsNormalizeWebsite(input.value);
            if (normalized) input.value = normalized;
            smsRefreshInputValidity(input);
            profile = smsCollect(rootEl(), profile);
            ctxRef?.touch?.();
          });
          input.addEventListener('change', () => {
            if (operationBusy || input.disabled || smsRegistrationLocked(profile)) return;
            if (input.hasAttribute('data-sms-feature')) {
              const confirm = rootEl()?.querySelector('[data-sms-feature-confirm]');
              if (confirm) confirm.checked = false;
            }
            const fieldName = String(input.getAttribute('data-sms-field') || '');
            if (['brand.street', 'brand.address2', 'brand.city', 'brand.state', 'brand.postalCode'].includes(fieldName)) {
              profile = prepareSmsProfileForSave({ ...profile, brand: { ...profile.brand, addressAutocompleteSelected: false, formattedAddress: '' } });
            }
            profile = smsCollect(rootEl(), profile);
            if (profile.brand.sameAsLegalName) {
              const nameInput = rootEl()?.querySelector('[data-sms-field="brand.displayName"]');
              if (nameInput) nameInput.value = profile.brand.displayName;
            }
            updateSummaryValidation();
            ctxRef?.touch?.();
            if (input.hasAttribute('data-sms-method') || fieldName === 'brand.entityType' || fieldName === 'brand.sameAsLegalName' || fieldName === 'campaign.optInMethod' || input.hasAttribute('data-sms-feature') || input.hasAttribute('data-sms-feature-confirm') || input.hasAttribute('data-sms-flow-ack')) refresh();
          });
        });
      };
      const renderStepBody = (container, shellCtx, stepId) => {
        ctxRef = shellCtx;
        if(developmentStatus?.onboarded){container.innerHTML=`<div class="sms-workspace"><h3>Fully onboarded for development</h3><p>Brand registration: mock approved</p><p>10DLC campaign: mock approved</p><p>Call center: test transport connected</p><p>All test calls route to ${escapeHtml(developmentStatus.destination)}. These are simulated registrations, not carrier approvals.</p></div>`;return;}
        const stepIssues = attemptedSteps.has(stepId) ? smsStepIssues(stepId, profile) : [];
        container.innerHTML = `<div class="sms-workspace">${smsStepHeading(stepId)}
          ${submissionError ? `<div class="sms-api-error" role="alert"><strong>We couldn’t complete that step</strong><p>${escapeHtml(submissionError)}</p>${/privacy|polic|terms|consent|opt.in/i.test(submissionError) ? '<button class="sms-text-button" type="button" data-sms-fix-step="consent">Review consent & policy links →</button>' : '<span>Your saved details are still here. Review the message and try again.</span>'}</div>` : ''}
          <p class="sms-muted sms-auto-status" data-sms-auto-status role="status">${escapeHtml(automaticStatusError)}</p>
          ${smsStepContent(stepId, profile, { numberSearch })}
          <div class="sms-step-errors" data-sms-step-errors role="alert">${stepIssues.length ? `<strong>Finish these details to continue</strong><ul>${smsIssueLinks(stepIssues)}</ul>` : ''}</div></div>`;
        container.onclick = async (event) => {
          const button = event.target.closest('[data-sms-fix-step]');
          if (!button || operationBusy) return;
          await shellCtx.goTo(button.dataset.smsFixStep);
          const selector = button.dataset.smsFixSelector;
          const input = selector ? rootEl()?.querySelector(selector) : rootEl()?.querySelector('.sms-field input:not(:disabled), .sms-field select:not(:disabled), .sms-field textarea:not(:disabled)');
          input?.closest('details')?.setAttribute('open', '');
          input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          input?.focus({ preventScroll: true });
        };
        if (smsRegistrationLocked(profile) || operationBusy) container.querySelectorAll('input, select, textarea, button').forEach(input => {
          if (!operationBusy && ((stepId === 'summary' && smsCanAddNumber(profile) && input.matches('[data-sms-fix-step="number"]')) || (stepId === 'number' && (input.matches('[data-sms-add-number]') || (numberSearch.adding && input.matches('[data-sms-field="campaign.selectedNumberAreaCode"], [data-sms-choose-number], [data-sms-reserve-additional], [data-sms-cancel-additional]')))))) return;
          input.disabled = true;
        });
        if (!carrierRegistration) void window.Portal?.PhoneTray?.developmentSetup(container,status=>{if(!developmentStatus?.onboarded){developmentStatus=status;refresh();}});
        container.querySelector('[data-sms-change-number]')?.addEventListener('click', () => { numberSearchRevision++; if (numberSearchTimer) clearTimeout(numberSearchTimer); numberSearch = { ...numberSearch, choice: null, choosing: true, query: '', areaCode: '', results: [], searched: false, message: '' }; profile.campaign = { ...profile.campaign, selectedNumberAreaCode: '', selectedNumberSearch: '' }; refresh(); });
        container.querySelector('[data-sms-add-number]')?.addEventListener('click', () => { numberSearch = { ...numberSearch, adding: true, choice: null, query: '', areaCode: '', results: [], searched: false, message: '' }; refresh(); });
        container.querySelector('[data-sms-cancel-additional]')?.addEventListener('click', () => { numberSearch = { ...numberSearch, adding: false, choice: null, query: '', areaCode: '', results: [], searched: false, message: '' }; refresh(); });
        container.querySelector('[data-sms-reserve-additional]')?.addEventListener('click', () => { void reserveSmsNumber(); });
        container.querySelectorAll('[data-sms-choose-number]').forEach((button) => {
          button.addEventListener('click', () => chooseSmsNumber(button));
        });
        const evidenceScroll = () => rootEl()?.querySelector('.fm-wizard-pane')?.scrollTop || 0;
        const evidenceFeedback = message => { const el=rootEl()?.querySelector('[data-sms-upload-status]');if(el)el.textContent=message; };
        const saveEvidence = async (items, scrollTop) => {
          const nextCampaign = {...profile.campaign, optInEvidence:items, optInEvidenceUrl:items[0]?.url || ''};
          if (smsReviewerFlow(nextCampaign).length > 2048) throw new Error('Maximum screenshots submitted. Remove a screenshot before adding another.');
          profile.campaign = nextCampaign;
          await persistDraft();refreshEvidence(scrollTop);
        };
        container.querySelector('[data-sms-upload-trigger]')?.addEventListener('click',()=>container.querySelector('[data-sms-evidence-upload]').click());
        container.querySelectorAll('[data-sms-remove-evidence]').forEach(button=>button.addEventListener('click',async()=>{
          if(operationBusy)return;const scrollTop=evidenceScroll();const items=smsEvidence(profile.campaign);items.splice(Number(button.dataset.smsRemoveEvidence),1);operationBusy=true;
          try{await saveEvidence(items,scrollTop);}catch(error){showToast('Could not remove evidence',error?.message || 'Try again.',false);}finally{operationBusy=false;refreshEvidence(scrollTop);}
        }));
        container.querySelector('[data-sms-evidence-upload]')?.addEventListener('change', async (event) => {
          const files = Array.from(event.target.files || []); if (!files.length || operationBusy) return;
          if (files.some(file=>!['image/png','image/jpeg'].includes(file.type))) { evidenceFeedback('Upload a PNG or JPEG screenshot.'); return; }
          if (files.some(file=>file.size > 5 * 1024 * 1024)) { evidenceFeedback('Choose files up to 5 MB each.'); return; }
          const scrollTop=evidenceScroll();
          if (!(await flushDraft())) return;
          operationBusy = true; operationMessage = 'Uploading evidence…'; refreshEvidence(scrollTop);
          let failure='';
          try {
            for(const file of files){
              const data = await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
              const uploaded = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/compliance-profiles/${encodeURIComponent(profile.id)}/evidence`, {method:'POST',body:{file_name:file.name,data}});
              const items=smsEvidence(profile.campaign);items.push({url:uploaded.url,name:file.name});await saveEvidence(items,scrollTop);
            }
          } catch(error) { failure=error?.message || 'Evidence upload failed.'; }
          finally { operationBusy = false; refreshEvidence(scrollTop);evidenceFeedback(failure); }
        });
        container.querySelector('#smsRequestOtp')?.addEventListener('click', requestSoleProprietorOtp);
        container.querySelector('#smsRefreshOtp')?.addEventListener('click', refreshSoleProprietorOtp);
        container.querySelector('#smsVerifyOtp')?.addEventListener('click', verifySoleProprietorOtp);
        bindWorkspaceInputs(container);
        requestAnimationFrame(() => {
          const active = rootEl()?.querySelector('.fm-wizard-step.active');
          const rail = active?.parentElement;
          if (rail && rail.scrollWidth > rail.clientWidth) rail.scrollLeft = active.offsetLeft - rail.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
        });
        updateSummaryValidation();
        initSmsAddressAutocomplete();
        if (refocusNumberSearch) {
          refocusNumberSearch = false;
          setTimeout(() => {
            const input = rootEl()?.querySelector('[data-sms-field="campaign.selectedNumberAreaCode"]');
            if (!input || document.activeElement === input) return;
            input.focus();
            const length = String(input.value || '').length;
            try { input.setSelectionRange(length, length); } catch(e) {}
          }, 0);
        }
      };
      const renderStepFooter = (container, shellCtx, stepId) => {
        if(developmentStatus?.onboarded){container.textContent='Development setup complete';return;}
        ctxRef = shellCtx;
        const steps = smsVisibleSteps(profile);
        const index = Math.max(0, steps.findIndex((item) => item.id === stepId));
        const stepIssues = smsStepIssues(stepId, profile);
        const locked = smsRegistrationLocked(profile);
        const footerActions = stepId === 'summary' && smsCampaignAppealable(profile)
          ? `<button class="cs-btn" type="button" id="smsRefreshStatus"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8ff6bc351de08b"," Refresh Status") ?? " Refresh Status")}</button>
             <button class="cs-btn primary" type="button" id="smsAppealCampaign"><i class="fas fa-scale-balanced"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_e507a486a6ad57"," Appeal Current Campaign") ?? " Appeal Current Campaign")}</button>
             <button class="cs-btn" type="button" id="smsReplaceCampaign"><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2de5bd3348cbff"," Create Paid Replacement") ?? " Create Paid Replacement")}</button>`
          : stepId === 'summary' && smsCampaignNeedsReplacement(profile)
            ? `<button class="cs-btn" type="button" id="smsRefreshStatus"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8ff6bc351de08b"," Refresh Status") ?? " Refresh Status")}</button>
               <button class="cs-btn primary" type="button" id="smsReplaceCampaign"><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2de5bd3348cbff"," Create Paid Replacement") ?? " Create Paid Replacement")}</button>`
          : stepId === 'summary' && smsCampaignSuspended(profile)
            ? `<button class="cs-btn" type="button" id="smsRefreshStatus"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8ff6bc351de08b"," Refresh Status") ?? " Refresh Status")}</button>`
          : stepId === 'summary' && smsRegistrationSubmitted(profile)
            ? smsHasProviderCampaign(profile) ? '' : submissionError ? '<button class="cs-btn primary" type="button" id="smsRetrySubmission">Retry submission</button>' : profile.campaign?.autoSubmitCampaign === true ? '' : '<button class="cs-btn primary" type="button" id="smsContinueSetup">Submit campaign</button>'
            : `<button class="cs-btn" type="button" id="smsPrev" ${String(index <= 0 ? 'disabled' : '')}><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_206d31a7c795c4"," Back") ?? " Back")}</button>
                  ${String(index < steps.length - 1 ? `<button class="cs-btn primary" type="button" id="smsNext">${(globalThis.PlatformLanguage?.htmlText("settings","m_dc6a60d7bb3581","Next ") ?? "Next ")}<i class="fas fa-arrow-right"></i></button>` : `<button class="cs-btn primary" type="button" id="smsSubmitMock" ${stepIssues.length || locked ? 'disabled' : ''} title="${stepIssues.length ? escapeHtml(`Finish: ${stepIssues.join(', ')}`) : ''}"><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_a50e2076d26969"," Submit Registration") ?? " Submit Registration")}</button>`)}`;
        container.innerHTML = footerActions;
        if (operationBusy) {
          container.innerHTML = `<button class="cs-btn" type="button" disabled aria-live="polite"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(operationMessage || 'Saving…')}</button>`;
          return;
        }
        const submitButton = container.querySelector('#smsSubmitMock');
        if (submitButton) { submitButton.disabled = locked; submitButton.title = ''; }
        const continueButton = container.querySelector('#smsContinueSetup');
        if (continueButton) continueButton.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i> Submit campaign';
        const nextButton = container.querySelector('#smsNext');
        if (nextButton) nextButton.innerHTML = `${stepId === 'number' && numberSearch.choice ? 'Reserve number & continue' : `Continue to ${escapeHtml(steps[index + 1]?.label || 'review')}`} <i class="fas fa-arrow-right" aria-hidden="true"></i>`;
        if (stepId === 'summary' && stepIssues.length && !smsRegistrationSubmitted(profile)) {
          const note = shellCtx.root.querySelector('[data-fm-note]');
          if (note) note.textContent = `Finish before submitting: ${stepIssues.slice(0, 3).join(', ')}${stepIssues.length > 3 ? '...' : ''}`;
        }
        container.querySelector('#smsPrev')?.addEventListener('click', () => { void shellCtx.back(); });
        container.querySelector('#smsNext')?.addEventListener('click', async () => {
          if (stepId === 'number' && numberSearch.choice && !(await reserveSmsNumber())) return;
          const issues = smsStepIssues(stepId, smsCollect(shellCtx.root, profile));
          if (issues.length) {
            markCurrentStepInvalid(`Finish this step: ${issues.slice(0, 3).join(', ')}${issues.length > 3 ? '...' : ''}`);
            refresh();
            rootEl()?.querySelector('[data-sms-step-errors]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
          }
          const nextId = steps[Math.min(steps.length - 1, index + 1)]?.id;
          if (nextId) void shellCtx.goTo(nextId);
        });
        container.querySelector('#smsSubmitMock')?.addEventListener('click', (event) => {
          const issues = smsStepIssues('summary', smsCollect(shellCtx.root, profile));
          if (issues.length) {
            event.preventDefault();
            markCurrentStepInvalid(`Finish before submitting: ${issues.slice(0, 3).join(', ')}${issues.length > 3 ? '...' : ''}`);
            refresh();
            rootEl()?.querySelector('[data-sms-summary-checklist]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
          }
          submitMock();
        });
        container.querySelector('#smsRefreshStatus')?.addEventListener('click', refreshProviderStatus);
        container.querySelector('#smsAppealCampaign')?.addEventListener('click', appealCampaign);
        container.querySelector('#smsReplaceCampaign')?.addEventListener('click', replaceRejectedCampaign);
        container.querySelector('#smsContinueSetup')?.addEventListener('click', () => submitMock());
        container.querySelector('#smsRetrySubmission')?.addEventListener('click', () => submitMock());
      };
      const stepRailStatus = (item, index, shellCtx) => {
        const steps = smsVisibleSteps(profile);
        const activeIndex = Math.max(0, steps.findIndex((entry) => entry.id === shellCtx.stepId));
        const info = smsStepStatus(item, index, activeIndex, profile);
        return { state: info.cls, label: info.label, icon: info.icon };
      };
      wizard = window.FirstMateSetupWizard.open({
        id: 'sms-workflow',
        workflowKey: options.standalone ? '' : '10dlc',
        title: 'Set up business texting',
        subtitle: 'SMS registration',
        icon: 'fa-message',
        initialStepId: requestedStep || smsResumeStep(profile),
        statusNote: 'Draft autosaves as you move through the workflow.',
        locked: () => developmentStatus?.onboarded || smsRegistrationLocked(profile),
        stepNavigable: () => !operationBusy,
        canClose: () => !operationBusy,
        railNote: '<strong>Your progress is saved</strong><br>Return any time to finish registration.',
        autosave: { debounceMs: 900, save: () => persistDraft() },
        steps: (shellCtx) => {
          ctxRef = shellCtx;
          return (developmentStatus?.onboarded?[{id:'summary',label:'Development ready'}]:smsVisibleSteps(profile)).map((item, index) => ({
            id: item.id,
            label: `${index + 1}. ${item.label}`,
            render: (container, stepCtx) => renderStepBody(container, stepCtx, item.id),
            renderFooter: (container, stepCtx) => renderStepFooter(container, stepCtx, item.id),
            status: (stepCtx) => stepRailStatus(item, index, stepCtx)
          }));
        },
        writeRoute: (patch, routeOptions) => { if (!options.standalone) writeSettingsRoute({ sub: 'sms', ...patch }, routeOptions); },
        ...(options.standalone ? { closeRoute: () => {} } : { routeMatch: (route) => String(route?.tab || '') === 'company_settings' && String(route?.sub || '') === 'sms' }),
        onClose: () => {
          stopStatusUpdates?.();
          if (numberSearchTimer) {
            clearTimeout(numberSearchTimer);
            numberSearchTimer = null;
          }
          if (options.standalone) options.onClose?.(profile);
          else renderSmsSettings();
        }
      });
      stopStatusUpdates = smsWatchRegistrationStatus({ root:wizard.el, getProfile:() => profile,
        enabled:() => !operationBusy && !developmentStatus?.onboarded,
        onProfile:latest => {
          if (smsStatusFingerprint(latest) === smsStatusFingerprint(profile)) return;
          // Provider checks must never replace answers the user is editing.
          profile = mergeSmsProfile({ ...latest, brand:profile.brand, campaign:profile.campaign });
          if (ctxRef?.stepId === 'summary' || (ctxRef?.stepId === 'number' && !numberSearch.adding)) refresh();
        },
        onError:message => {
          automaticStatusError = message;
          const note = rootEl()?.querySelector('[data-sms-auto-status]');
          if (note) note.textContent = message;
        }
      });
    }
    /** The workflow on its own (the Communications setup, FM-510): the saved registration, or a new one filled in from the company. */
    async function openRegistration(){
      if (!window.FirstMateSetupWizard?.open) throw new Error('The setup wizard library did not load.');
      const orgId = currentOrgId();
      const setup = await messagingRequest(`/organizations/${encodeURIComponent(orgId)}/sms/setup`);
      smsRegistrationLiveMode = setup.telnyx?.registration_live === true;
      const profiles = Array.isArray(setup.profiles) ? setup.profiles.map((item) => smsPrefillProfile(item, setup)) : [];
      const eligibleProfiles = smsRegistrationLiveMode ? profiles.filter((item) => !(item.events || []).some((event) => ['brand_submitted','brand_updated','campaign_submitted'].includes(event.type) && event.mock === true)) : profiles;
      const profile = eligibleProfiles[0] || smsPrefillProfile({}, setup);
      return new Promise((resolve) => openSmsWizard(profile, { standalone: true, initialStep: smsHasProviderBrand(profile) || smsHasProviderCampaign(profile) ? 'summary' : smsResumeStep(profile), onClose: resolve }));
    }
    return { formatPhoneUS, renderSmsSettings, renderSmsRegistration, openRegistration };
  }

  /** Opens the registration workflow outside Settings. Resolves with the registration (profile) when it closes. */
  function open(options = {}){
    const orgId = String(options.orgId || window.__APP?.userOrgId || '').trim();
    return create({
      escapeHtml: window.Portal?.util?.escapeHtml || esc,
      showToast: window.Portal?.ui?.showToast || (() => {}),
      appFlag: (group, flag) => window.PlatformAPI?.appFlags?.has?.(group, flag) === true,
      currentOrgId: () => orgId,
      canPlatformBilling: false,
      readSettingsRoute: () => ({}),
      writeSettingsRoute: () => {},
      organizationBusinessAddressFromState: () => normalizeOrganizationBusinessAddress({}),
      paneSms: () => null, activeTab: () => '', state: () => null
    }).openRegistration();
  }

  window.FirstMateSmsRegistration = { create, open };
})();
