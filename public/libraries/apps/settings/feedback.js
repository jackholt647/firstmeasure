(function(root){
  'use strict';

  // The settings shell and standalone app both load this shared bundle.
  if (root.FirstMateFeedbackSettings) return;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => String(values.find((value) => value != null && String(value).trim()) ?? '').trim();
  const controllers = new WeakMap();

  const DESTINATION_PRESETS = [
    { id:'google', label:(globalThis.PlatformLanguage?.text("settings","m_de640c90c8d483","Google") ?? "Google"), icon:'fab fa-google', hint:'https://search.google.com/local/writereview?placeid=…' },
    { id:'facebook', label:(globalThis.PlatformLanguage?.text("settings","m_6050c1a64ac2c3","Facebook") ?? "Facebook"), icon:'fab fa-facebook', hint:'https://www.facebook.com/yourpage/reviews' },
    { id:'yelp', label:(globalThis.PlatformLanguage?.text("settings","m_f68aee335cdec2","Yelp") ?? "Yelp"), icon:'fab fa-yelp', hint:'https://www.yelp.com/biz/your-business' },
    { id:'bbb', label:(globalThis.PlatformLanguage?.text("settings","m_28e8ec64f85ab0","BBB") ?? "BBB"), icon:'fas fa-shield-halved', hint:'https://www.bbb.org/…/customer-reviews' },
    { id:'custom', label:(globalThis.PlatformLanguage?.text("settings","m_cb6d9694bc5c14","Custom link") ?? "Custom link"), icon:'fas fa-star', hint:'https://…' }
  ];

  const MERGE_TAGS = [
    { tag:'{{customer_first_name}}', label:(globalThis.PlatformLanguage?.text("settings","m_ed956bd0cbfa79","First name") ?? "First name") },
    { tag:'{{customer_name}}', label:(globalThis.PlatformLanguage?.text("settings","m_38ccbd6c134964","Full name") ?? "Full name") },
    { tag:'{{company_name}}', label:(globalThis.PlatformLanguage?.text("settings","m_500872d3c049f6","Company") ?? "Company") },
    { tag:'{{project_title}}', label:(globalThis.PlatformLanguage?.text("settings","m_aaebd7ccba0b30","Project") ?? "Project") },
    { tag:'{{link}}', label:(globalThis.PlatformLanguage?.text("settings","m_59c139649e7fda","Feedback link") ?? "Feedback link") }
  ];

  function injectCss(){
    if (document.getElementById('fmFeedbackSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmFeedbackSettingsCss';
    style.textContent = `
      .fb-root{color:#17212b;min-height:620px}.fb-root *{box-sizing:border-box}
      .fb-loading{display:grid;place-items:center;min-height:420px;color:#667085;font-size:12px;font-weight:850}
      .fb-error{border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:14px;color:#b42318;font-size:12px;font-weight:800}
      .fb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
      .fb-head-copy h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em;display:flex;align-items:center;gap:11px}
      .fb-head-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:16px;flex:0 0 auto}
      .fb-head-copy p{margin:7px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:560px}
      .fb-subtabs{display:inline-flex;gap:2px;border:1px solid #e4e7ec;border-radius:12px;background:#f4f6f9;padding:3px;margin:16px 0}
      .fb-subtabs button{appearance:none;border:0;border-radius:9px;background:transparent;padding:9px 16px;color:#667085;font:850 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background .12s ease,color .12s ease}
      .fb-subtabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
      .fb-subtabs .count{display:inline-grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025));font-size:9.5px;font-weight:950}
      .fb-layout{display:grid;grid-template-columns:minmax(0,1fr) 348px;gap:18px;align-items:start}
      .fb-col{display:grid;grid-template-columns:1fr;gap:14px;min-width:0;align-items:start}
      .fb-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04);padding:18px;min-width:0}
      .fb-card.wide{grid-column:1/-1}
      .fb-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}
      .fb-card-head strong{font-size:13.5px;color:#101828;display:flex;align-items:center;gap:8px}
      .fb-card-head strong i{color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
      .fb-card-head p, .fb-card > p.fb-sub{margin:5px 0 0;color:#667085;font-size:11.5px;line-height:1.5;font-weight:650}
      .fb-field{margin-top:14px;min-width:0}
      .fb-field label{display:block;font-size:10px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;color:#667085;margin-bottom:6px}
      .fb-field input[type=text], .fb-field input[type=url], .fb-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:10px 12px;color:#344054;font:700 12.5px/1.5 inherit;outline:0;resize:vertical}
      .fb-field input:focus, .fb-field textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .fb-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
      .fb-tag{appearance:none;border:1px solid rgba(var(--primary-rgb,217,48,37),.28);border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.05);padding:4px 9px;color:var(--primary-readable,var(--primary,#d93025));font:850 10px/1.2 inherit;cursor:pointer}
      .fb-tag:hover{background:rgba(var(--primary-rgb,217,48,37),.11)}
      .fb-pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
      .fb-pill{appearance:none;display:inline-flex;align-items:center;gap:8px;border:1.5px solid #e4e7ec;border-radius:11px;background:#fff;padding:10px 14px;color:#475467;font:850 12px/1 inherit;cursor:pointer;transition:border-color .13s ease,box-shadow .13s ease}
      .fb-pill i{font-size:12px}
      .fb-pill.on{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.08)}
      .fb-page-intro{display:flex;align-items:flex-start;gap:12px;border-radius:14px;padding:16px 17px;background:linear-gradient(135deg,rgba(var(--primary-rgb,217,48,37),.08),rgba(var(--primary-rgb,217,48,37),.025));border:1px solid rgba(var(--primary-rgb,217,48,37),.16)}
      .fb-page-intro .icon{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;flex:0 0 auto}.fb-page-intro h4{margin:0;color:#101828;font-size:14px}.fb-page-intro p{margin:4px 0 0;color:#667085;font-size:11.5px;line-height:1.5;font-weight:650}
      .fb-choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:14px}.fb-choice{appearance:none;display:flex;align-items:center;gap:10px;border:1.5px solid #e4e7ec;border-radius:12px;background:#fff;padding:12px;text-align:left;color:#475467;cursor:pointer;transition:.14s ease}.fb-choice:hover{border-color:#cbd3dd;transform:translateY(-1px)}.fb-choice.on{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.07)}.fb-choice .choice-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#f2f4f7;color:#667085;flex:0 0 auto}.fb-choice.on .choice-icon{background:var(--primary-readable,var(--primary,#d93025));color:#fff}.fb-choice b{display:block;font-size:11.5px;color:#101828}.fb-choice span:not(.choice-icon){display:block;margin-top:3px;font-size:9.5px;line-height:1.35;color:#667085;font-weight:700}.fb-choice .check{margin-left:auto;color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
      .fb-trigger-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}.fb-trigger{appearance:none;display:flex;align-items:flex-start;gap:10px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:12px;text-align:left;cursor:pointer;color:#475467}.fb-trigger:hover{border-color:#cbd3dd}.fb-trigger.on{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.07)}.fb-trigger i{width:20px;margin-top:1px;text-align:center;color:#98a2b3}.fb-trigger.on i{color:var(--primary-readable,var(--primary,#d93025))}.fb-trigger b{display:block;color:#101828;font-size:11px}.fb-trigger span{display:block;margin-top:3px;color:#667085;font-size:9.5px;line-height:1.4;font-weight:650}
      .fb-scope-todo{display:flex;align-items:flex-start;gap:9px;margin-top:12px;border:1px dashed #b2ccff;border-radius:10px;background:#f5f8ff;padding:10px 11px;color:#344054;font-size:10px;font-weight:750;line-height:1.5}.fb-scope-todo i{margin-top:2px;color:#4e5ba6}.fb-scope-todo strong{color:#3538cd}
      .fb-message-list{display:grid;gap:12px}.fb-message-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04);padding:17px;transition:opacity .16s ease,background .16s ease}.fb-message-card.off{background:#f5f6f8;border-color:#e7eaee;box-shadow:none;opacity:.62}.fb-message-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.fb-message-title{display:flex;align-items:center;gap:9px}.fb-message-title .icon{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;background:#f2f4f7;color:#475467;font-size:11px}.fb-message-title b{font-size:12.5px;color:#101828}.fb-channel-state{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#ecfdf3;color:#067647;padding:4px 8px;font-size:8.5px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}.fb-channel-state.off{background:#e9edf2;color:#667085}.fb-message-card.off input,.fb-message-card.off textarea,.fb-message-card.off button{cursor:not-allowed}.fb-message-note{margin:7px 0 0 40px;color:#667085;font-size:10px;line-height:1.45;font-weight:650}
      .fb-message-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;border-radius:10px;background:#f2f4f7;padding:3px;margin:-5px -5px 16px}.fb-message-tabs button{appearance:none;border:0;border-radius:8px;background:transparent;padding:9px;color:#667085;font:850 11px/1 inherit;cursor:pointer}.fb-message-tabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}.fb-message-card.off .fb-message-tabs button{cursor:pointer}
      .fb-seg{display:inline-flex;border:1px solid #e4e7ec;border-radius:11px;background:#f4f6f9;padding:3px;gap:2px;margin-top:12px}
      .fb-seg button{appearance:none;border:0;border-radius:8px;background:transparent;padding:8px 13px;color:#667085;font:850 11.5px/1 inherit;cursor:pointer;transition:background .12s ease,color .12s ease}
      .fb-seg button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
      .fb-threshold{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}
      .fb-threshold-stars{display:inline-flex;gap:3px}
      .fb-tstar{appearance:none;border:0;background:transparent;padding:2px;cursor:pointer;font-size:20px;color:#e4e7ec;transition:transform .1s ease,color .12s ease;line-height:1}
      .fb-tstar.lit{color:#f6b83c}
      .fb-tstar:hover{transform:scale(1.15)}
      .fb-threshold-note{color:#667085;font-size:11.5px;font-weight:750}
      .fb-dest{display:flex;align-items:center;gap:9px;border:1px solid #e4e7ec;border-radius:11px;background:#fbfcfd;padding:9px 10px;margin-top:9px}
      .fb-dest-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:#fff;border:1px solid #e4e7ec;color:#475467;font-size:12px;flex:0 0 auto}
      .fb-dest-fields{flex:1;display:grid;grid-template-columns:130px minmax(0,1fr);gap:7px;min-width:0}
      .fb-dest-fields input{width:100%;border:1px solid #d8dde4;border-radius:8px;background:#fff;padding:7px 9px;color:#344054;font:750 11.5px/1.3 inherit;outline:0;min-width:0}
      .fb-dest-fields input:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
      .fb-dest-remove{appearance:none;border:0;background:transparent;color:#98a2b3;cursor:pointer;font-size:12px;padding:6px;border-radius:7px;flex:0 0 auto}
      .fb-dest-remove:hover{color:#b42318;background:#fef3f2}
      .fb-dest-add{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}
      .fb-dest-add button{appearance:none;display:inline-flex;align-items:center;gap:7px;border:1px dashed #ccd4dd;border-radius:9px;background:#fff;padding:7px 11px;color:#475467;font:800 11px/1 inherit;cursor:pointer}
      .fb-dest-add button:hover{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}
      .fb-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}
      @media(max-width:640px){.fb-grid2{grid-template-columns:1fr}}
      .fb-empty{border:1px dashed #ccd4dd;border-radius:10px;padding:16px;text-align:center;color:#7b8794;font-size:11px;font-weight:800;margin-top:12px}
      /* Responses tab */
      .fb-resp-wrap{display:grid;gap:14px}
      .fb-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
      @media(max-width:900px){.fb-stats{grid-template-columns:repeat(2,1fr)}}
      .fb-stat{border:1px solid #e4e7ec;border-radius:13px;background:#fff;padding:14px 15px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
      .fb-stat b{display:block;font-size:22px;letter-spacing:-.02em;color:#101828}
      .fb-stat b .max{color:#98a2b3;font-size:12px;font-weight:800}
      .fb-stat span{display:block;margin-top:3px;color:#667085;font-size:9.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}
      .fb-stat.alert b{color:#b42318}
      .fb-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .fb-search{position:relative;flex:1;min-width:220px}
      .fb-search i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:11px}
      .fb-search input{width:100%;border:1px solid #d0d5dd;border-radius:11px;background:#fff;padding:10px 12px 10px 32px;color:#344054;font:750 12px/1.4 inherit;outline:0}
      .fb-search input:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .fb-filters{display:flex;gap:5px;flex-wrap:wrap}
      .fb-chip{appearance:none;border:1px solid #e4e7ec;border-radius:999px;background:#fff;padding:7px 12px;color:#667085;font:850 11px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
      .fb-chip i{color:#f6b83c;font-size:9px}
      .fb-chip.on{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.06)}
      .fb-chip.attention i{color:#b42318}
      .fb-rows{display:grid;gap:9px}
      .fb-row{display:flex;align-items:flex-start;gap:13px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;padding:13px 15px;box-shadow:0 1px 2px rgba(16,24,40,.03)}
      .fb-row.low{border-color:#f4c7c3;background:linear-gradient(120deg,#fff7f6,#fff)}
      .fb-row.pending{background:#fbfcfd}
      .fb-row-stars{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:2px;min-width:64px}
      .fb-row-stars .stars{color:#f6b83c;font-size:12px;letter-spacing:1.5px;white-space:nowrap}
      .fb-row.low .fb-row-stars .stars{color:#e2725b}
      .fb-row-stars .num{font-size:10px;font-weight:950;color:#667085}
      .fb-row-stars .awaiting{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#eef1f4;color:#98a2b3;font-size:11px}
      .fb-row-main{flex:1;min-width:0}
      .fb-row-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .fb-row-top b{font-size:12.5px;color:#101828}
      .fb-row-top .proj{color:#667085;font-size:10.5px;font-weight:800}
      .fb-row-comment{margin:6px 0 0;color:#344054;font-size:12px;line-height:1.55;font-weight:650;white-space:pre-wrap;word-break:break-word}
      .fb-row.low .fb-row-comment{color:#7a271a}
      .fb-row-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:8px}
      .fb-meta-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 9px;font-size:9px;font-weight:950;letter-spacing:.03em;text-transform:uppercase;background:#f2f4f7;color:#667085}
      .fb-meta-chip.click{background:#eef4ff;color:#3538cd}
      .fb-meta-chip.low{background:#fef0ef;color:#b42318}
      .fb-row-time{flex:0 0 auto;color:#98a2b3;font-size:10px;font-weight:850;text-align:right;line-height:1.5}
      /* Preview column */
      .fb-preview{position:sticky;top:12px}
      .fb-preview-tabs{display:grid;grid-template-columns:repeat(2,1fr);gap:2px;border:1px solid #e4e7ec;border-radius:11px;background:#f4f6f9;padding:3px;margin-bottom:12px}
      .fb-preview-tabs.delivery{grid-template-columns:repeat(3,1fr)}
      .fb-preview-tabs button{appearance:none;flex:1;border:0;border-radius:8px;background:transparent;padding:8px;color:#667085;font:850 11px/1 inherit;cursor:pointer}
      .fb-preview-tabs button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
      .fb-phone{border:8px solid #17212b;border-radius:34px;background:#f7f8fa;overflow:hidden;box-shadow:0 18px 44px rgba(16,24,40,.18);min-height:540px;display:flex;flex-direction:column}
      .fb-preview.workflow-preview .fb-phone{min-height:620px}
      .fb-phone-notch{height:20px;background:#17212b;border-radius:0 0 12px 12px;width:46%;margin:0 auto;flex:0 0 auto}
      .fb-screen{flex:1;padding:18px 14px 22px;overflow:auto}
      .fb-pv-brand{display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px 0 14px}
      .fb-pv-brand img{max-height:34px;max-width:150px;object-fit:contain}
      .fb-pv-brand .nm{font-size:11px;font-weight:900;color:#17212b}
      .fb-pv-card{background:#fff;border:1px solid #e8ebf0;border-radius:16px;padding:20px 15px;box-shadow:0 10px 26px rgba(16,24,40,.08);text-align:center}
      .fb-pv-card h4{margin:0;font-size:15px;letter-spacing:-.01em;color:#101828}
      .fb-pv-sub{margin:7px 0 0;color:#667085;font-size:10.5px;line-height:1.5;font-weight:650}
      .fb-pv-stars{display:flex;justify-content:center;gap:5px;margin:16px 0 5px}
      .fb-pv-star{appearance:none;border:0;background:transparent;padding:2px;cursor:pointer;font-size:23px;color:#e4e7ec;transition:transform .1s ease,color .12s ease;line-height:1}
      .fb-pv-star.lit{color:#f6b83c}
      .fb-pv-star:hover{transform:scale(1.18)}
      .fb-pv-hint{color:#98a2b3;font-size:8.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
      .fb-pv-textarea{width:100%;margin-top:12px;border:1px solid #d8dde4;border-radius:10px;background:#fbfcfd;padding:10px;min-height:54px;color:#98a2b3;font:650 10px/1.5 inherit;text-align:left}
      .fb-pv-cta{appearance:none;border:0;width:100%;margin-top:10px;border-radius:10px;background:var(--fb-pv-brand,var(--primary,#d93025));color:#fff;font:900 11px/1 inherit;padding:12px;letter-spacing:.01em;cursor:pointer}
      .fb-pv-check{width:44px;height:44px;margin:2px auto 12px;border-radius:50%;background:rgba(var(--fb-pv-brand-rgb,var(--primary-rgb,217,48,37)),.12);display:grid;place-items:center;color:var(--fb-pv-brand,var(--primary,#d93025));font-size:17px}
      .fb-pv-dest{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1.5px solid #e4e7ec;border-radius:11px;background:#fff;padding:10px 12px;margin-top:8px;font:800 11px/1.2 inherit;color:#101828;text-align:left}
      .fb-pv-dest i.brand{color:#475467;font-size:11px}
      .fb-pv-dest .go{color:var(--fb-pv-brand,var(--primary,#d93025));font-size:11px}
      .fb-pv-note{margin-top:12px;color:#667085;font-size:9.5px;line-height:1.55;font-weight:650}
      .fb-pv-warn{margin-top:12px;border:1px dashed #f0c674;background:#fffaeb;border-radius:9px;padding:9px;color:#7a5200;font-size:9.5px;line-height:1.5;font-weight:750;text-align:left}
      .fb-pv-reset{appearance:none;border:0;background:transparent;color:#98a2b3;font:800 9.5px/1 inherit;margin-top:14px;cursor:pointer;text-decoration:underline}
      .fb-pv-caption{text-align:center;color:#98a2b3;font-size:10px;font-weight:800;margin-top:10px}
      /* SMS preview */
      .fb-sms-thread{padding:10px 4px}
      .fb-sms-from{text-align:center;color:#98a2b3;font-size:9px;font-weight:900;letter-spacing:.04em;margin-bottom:10px}
      .fb-sms-bubble{max-width:88%;border-radius:16px;border-bottom-left-radius:5px;background:#e9ebef;color:#17212b;padding:11px 13px;font:650 11.5px/1.55 inherit;white-space:pre-wrap;word-break:break-word}
      .fb-sms-link{display:inline-block;margin-top:2px;color:#1570cd;text-decoration:underline;word-break:break-all}
      .fb-sms-time{color:#98a2b3;font-size:8.5px;font-weight:800;margin:5px 0 0 6px}
      /* Email + portal previews are always available, even when their channel is off. */
      .fb-email{background:#fff;border:1px solid #e4e7ec;border-radius:13px;overflow:hidden;box-shadow:0 8px 22px rgba(16,24,40,.08)}
      .fb-email-bar{display:flex;align-items:center;gap:5px;background:#f2f4f7;border-bottom:1px solid #e4e7ec;padding:9px 11px}.fb-email-bar i{font-size:7px;color:#98a2b3}
      .fb-email-head{padding:12px 13px;border-bottom:1px solid #eef1f4}.fb-email-head b{display:block;color:#101828;font-size:11px;line-height:1.35}.fb-email-head span{display:block;color:#98a2b3;font-size:8.5px;font-weight:750;margin-top:5px}
      .fb-email-body{padding:15px 13px 18px;color:#344054;font:650 10.5px/1.6 inherit;white-space:pre-wrap;word-break:break-word}.fb-email-link{color:#1570cd;text-decoration:underline;word-break:break-all}
      .fb-portal-shell{background:#f4f6f8;border:1px solid #dfe4ea;border-radius:13px;overflow:hidden;min-height:330px}.fb-portal-head{display:flex;align-items:center;gap:8px;background:#fff;border-bottom:1px solid #e4e7ec;padding:12px}.fb-portal-head img{max-width:72px;max-height:22px}.fb-portal-head b{font-size:10px;color:#101828}.fb-portal-nav{display:flex;gap:12px;background:#fff;border-bottom:1px solid #e4e7ec;padding:0 12px 9px;color:#667085;font-size:8px;font-weight:850}.fb-portal-nav span:first-child{color:var(--fb-pv-brand,var(--primary,#d93025))}
      .fb-portal-content{padding:20px 12px}.fb-portal-project{margin:0 0 10px;color:#667085;font-size:8.5px;font-weight:850;text-transform:uppercase;letter-spacing:.05em}.fb-portal-card{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:13px;box-shadow:0 4px 14px rgba(16,24,40,.05)}.fb-portal-stars{color:#f6b83c;font-size:11px;letter-spacing:1px;white-space:nowrap}.fb-portal-copy{flex:1}.fb-portal-copy b{display:block;font-size:10px;color:#101828}.fb-portal-copy span{display:block;margin-top:3px;font-size:8.5px;color:#667085;line-height:1.4}.fb-portal-btn{border-radius:8px;background:var(--fb-pv-brand,var(--primary,#d93025));padding:8px;color:#fff;font-size:8px;font-weight:900;white-space:nowrap}
      /* Save bar */
      .fb-savebar{position:sticky;bottom:10px;grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;box-shadow:0 12px 30px rgba(16,24,40,.14);padding:11px 14px;opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease;z-index:5}
      .fb-savebar.show{opacity:1;pointer-events:auto;transform:none}
      .fb-savebar span{color:#475467;font-size:11.5px;font-weight:800}
      .fb-savebar .actions{display:flex;gap:8px}
      .fb-btn{appearance:none;border:0;border-radius:10px;padding:10px 16px;font:900 12px/1 inherit;cursor:pointer}
      .fb-btn.primary{background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .fb-btn.primary:hover{filter:brightness(1.06)}
      .fb-btn.primary:disabled{background:#e4e7ec;color:#98a2b3;cursor:default;filter:none}
      .fb-btn.ghost{background:transparent;color:#667085}
      .fb-btn.ghost:hover{color:#17212b}
      @media(max-width:760px){.fb-choice-grid{grid-template-columns:1fr}.fb-trigger-grid{grid-template-columns:1fr}}
      @media(max-width:1080px){.fb-layout{grid-template-columns:1fr}.fb-preview{position:static;max-width:370px;margin:0 auto;width:100%}}
    `;
    document.head.appendChild(style);
  }

  function mount(host, options = {}){
    if (!host || host.dataset.feedbackMounted === '1') return;
    host.dataset.feedbackMounted = '1';
    injectCss();

    const orgId = String(options.orgId || '').trim();
    const branchId = String(options.branchId || 'default').trim() || 'default';
    const toast = options.showToast || (() => {});

    const initialTab = ['delivery','workflow','responses'].includes(options.initialView) ? options.initialView : 'delivery';
    const state = {
      tab:initialTab,        // 'delivery' | 'workflow' | 'responses'
      settings:null,
      revision:0,
      saved:'',
      totals:null,
      requests:[],
      query:'',
      filter:'all',          // 'all' | 'attention' | 'awaiting' | '1'..'10'
      previewTab:'sms',      // 'page' | 'sms' | 'email' | 'portal'
      previewStep:'ask',     // 'ask' | 'comment' | 'done'
      previewRating:0,
      saving:false
    };
    let deliveryTimingInsight = null;
    let destroyed = false;
    controllers.set(host, {
      destroy(){
        destroyed = true;
        deliveryTimingInsight?.destroy?.();
        controllers.delete(host);
        delete host.dataset.feedbackMounted;
      },
      setView(next){
        if (!['delivery','workflow','responses'].includes(next) || state.tab === next) return;
        state.tab = next;
        state.previewTab = next === 'delivery' ? 'sms' : 'page';
        render();
      }
    });

    // --- transport: same cookie+CSRF pipeline as every other settings tab ---
    const base = `${location.origin}/v1/feedback`;
    async function api(path, requestOptions = {}){
      if (root.PlatformAPI?.request) return root.PlatformAPI.request(`${base}${path}`, requestOptions);
      const method = String(requestOptions.method || 'GET').toUpperCase();
      const csrf = decodeURIComponent((document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('fm_platform_session_csrf=')) || '').slice(25) || '');
      const body = requestOptions.body != null && typeof requestOptions.body !== 'string' ? JSON.stringify(requestOptions.body) : requestOptions.body;
      const response = await fetch(`${base}${path}`, {
        ...requestOptions,
        body,
        credentials:'include',
        headers:{ Accept:'application/json', ...(body ? { 'Content-Type':'application/json' } : {}), ...(!['GET','HEAD','OPTIONS'].includes(method) && csrf ? { 'X-Platform-CSRF':csrf } : {}), ...(requestOptions.headers || {}) }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) throw new Error(text(data?.message, data?.error) || `Request failed (${response.status})`);
      return data;
    }
    const settingsPath = `/organizations/${encodeURIComponent(orgId)}/branches/${encodeURIComponent(branchId)}/settings`;
    const requestsPath = `/organizations/${encodeURIComponent(orgId)}/requests`;

    // --- branding for the live preview ---
    function brandTheme(){
      const theme = object(root.Portal?.currentTheme || root.__APP?.theme);
      const css = getComputedStyle(document.documentElement);
      const primary = text(theme.primary, css.getPropertyValue('--primary'), '#d93025');
      const name = text(theme.name, theme.company_name, object(root.Portal?.org).name, 'Your Company');
      return { primary, logo:text(theme.logo, theme.logo_url), name };
    }
    function hexToRgb(hex){
      const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
      if (!match) return '';
      const value = parseInt(match[1], 16);
      return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
    }

    host.innerHTML = `<div class="fb-root"><div class="fb-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2799365eb998f2"," Loading your feedback system…") ?? " Loading your feedback system…")}</span></div></div>`;
    const rootEl = host.querySelector('.fb-root');
    render();

    async function load(){
      try {
        const [settingsResult, requestsResult] = await Promise.all([
          api(settingsPath),
          api(requestsPath).catch(() => ({ totals:null, requests:[] }))
        ]);
        state.settings = object(settingsResult?.settings);
        state.revision = Number(settingsResult?.revision || 0);
        state.saved = JSON.stringify(state.settings);
        state.totals = object(requestsResult?.totals);
        state.requests = array(requestsResult?.requests)
          .sort((a, b) => text(b?.rated_at, b?.last_sent_at, b?.created_at).localeCompare(text(a?.rated_at, a?.last_sent_at, a?.created_at)));
      } catch (error) {
        if (destroyed) return;
        rootEl.innerHTML = `<div class="fb-error">${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_0ed9f5595c82be",`Could not load the feedback system. ${v0}`,{v0}) ?? `Could not load the feedback system. ${v0}`)(esc(error?.message || ''))}</div>`;
        return;
      }
      render();
    }

    // ---------------- helpers over state.settings ----------------
    const survey = () => object(state.settings.survey);
    const review = () => object(state.settings.review);
    const channels = () => object(state.settings.channels);
    const messages = () => object(state.settings.messages);
    const delivery = () => object(state.settings.delivery);

    function setDeep(section, key, value){
      state.settings = { ...state.settings, [section]: { ...object(state.settings[section]), [key]: value } };
      updateDirty();
    }

    function isDirty(){
      return JSON.stringify(state.settings) !== state.saved;
    }

    function updateDirty(){
      const bar = rootEl.querySelector('[data-fb-savebar]');
      if (bar) bar.classList.toggle('show', isDirty());
    }

    function mergeSample(template){
      const theme = brandTheme();
      return String(template ?? '')
        .replace(/\{\{\s*customer_first_name\s*\}\}/g, 'Sarah')
        .replace(/\{\{\s*customer_name\s*\}\}/g, 'Sarah Mitchell')
        .replace(/\{\{\s*company_name\s*\}\}/g, theme.name)
        .replace(/\{\{\s*project_title\s*\}\}/g, 'the roof replacement')
        .replace(/\{\{\s*link\s*\}\}/g, previewPublicLink());
    }

    function previewPublicLink(){
      const local = ['127.0.0.1', 'localhost'].includes(String(location.hostname || '').toLowerCase());
      return `${local ? 'http://127.0.0.1:8011' : 'https://app.1m8.ai'}/l/feedback-preview`;
    }

    function previewMessageHtml(template, className){
      const link = previewPublicLink();
      return esc(mergeSample(template)).split(esc(link)).join(`<span class="${className}">${esc(link)}</span>`);
    }

    function starRow(count, lit, className, attr){
      let html = '';
      for (let index = 1; index <= count; index += 1) {
        html += `<button class="${className} ${index <= lit ? 'lit' : ''}" type="button" ${attr}="${index}"><i class="fas fa-star"></i></button>`;
      }
      return html;
    }

    // ---------------- main render ----------------
    function render(){
      if (destroyed) return;
      deliveryTimingInsight?.destroy?.();
      deliveryTimingInsight = null;
      if (!state.settings) {
        rootEl.innerHTML = (String(chrome()) + "<div class=\"fb-loading\"><span><i class=\"fas fa-spinner fa-spin\"></i>" + (globalThis.PlatformLanguage?.htmlText("settings","m_2799365eb998f2"," Loading your feedback system…") ?? " Loading your feedback system…") + "</span></div>");
        bindShell();
        return;
      }
      const scale = Number(survey().scale) || 5;
      rootEl.innerHTML = `${chrome()}
        ${state.tab === 'responses' ? `<div class="fb-resp-wrap">${responsesView(scale)}</div>` : `
        <div class="fb-layout">
          <div class="fb-col">
            ${String(state.tab === 'delivery' ? deliveryView() : workflowView(scale))}
            <div class="fb-savebar" data-fb-savebar>
              <span>${(globalThis.PlatformLanguage?.htmlText("settings","m_4deabcbe613943","You have unsaved changes.") ?? "You have unsaved changes.")}</span>
              <div class="actions">
                <button class="fb-btn ghost" type="button" data-fb-discard>${(globalThis.PlatformLanguage?.htmlText("settings","m_4ab5419992b0f7","Discard") ?? "Discard")}</button>
                <button class="fb-btn primary" type="button" data-fb-save>${(globalThis.PlatformLanguage?.htmlText("settings","m_1d368860f0287e","Save changes") ?? "Save changes")}</button>
              </div>
            </div>
          </div>
          <div class="fb-preview" data-fb-preview></div>
        </div>`}
      `;
      bindShell();
      if (state.tab !== 'responses') {
        bindSetup();
        renderPreview();
        updateDirty();
      } else {
        bindResponses();
      }
    }

    function chrome(){
      const respondedCount = state.requests.filter((request) => Number(request.rating) > 0).length;
      return `
        <div class="fb-head">
          <div class="fb-head-copy">
            <h3><span class="fb-head-icon"><i class="fas fa-star"></i></span>${(globalThis.PlatformLanguage?.htmlText("settings","m_5ed41495facc6a"," Feedback System") ?? " Feedback System")}</h3>
            <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_27c91807f153a9","Ask every customer how the job went, capture the rating on the project, and invite your happiest customers to share it where it counts.") ?? "Ask every customer how the job went, capture the rating on the project, and invite your happiest customers to share it where it counts.")}</p>
          </div>
        </div>
        <div class="fb-subtabs">
          <button type="button" data-fb-tab="delivery" class="${String(state.tab === 'delivery' ? 'on' : '')}"><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_dbae5e9697315f"," Delivery") ?? " Delivery")}</button>
          <button type="button" data-fb-tab="workflow" class="${String(state.tab === 'workflow' ? 'on' : '')}"><i class="fas fa-route"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_6d5cbceb09ad8e"," Workflow") ?? " Workflow")}</button>
          <button type="button" data-fb-tab="responses" class="${String(state.tab === 'responses' ? 'on' : '')}"><i class="fas fa-comments"></i> Responses ${String(respondedCount ? `<span class="count">${respondedCount}</span>` : '')}</button>
        </div>`;
    }

    // ---------------- setup cards ----------------
    function deliveryView(){
      return `
        <div class="fb-page-intro"><span class="icon"><i class="fas fa-paper-plane"></i></span><div><h4>${(globalThis.PlatformLanguage?.htmlText("settings","m_44d90cd58e1f59","Choose when and where the request is delivered") ?? "Choose when and where the request is delivered")}</h4><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_40a101d3dc3cec","Set the moment that starts the request, then tailor the message for every channel your customer can receive it through.") ?? "Set the moment that starts the request, then tailor the message for every channel your customer can receive it through.")}</p></div></div>
        ${String(deliveryTimingCard())}
        ${String(channelChooserCard())}
        ${String(channelMessagesCard())}
      `;
    }

    function workflowView(scale){
      return `
        <div class="fb-page-intro"><span class="icon"><i class="fas fa-route"></i></span><div><h4>${(globalThis.PlatformLanguage?.htmlText("settings","m_37583c5f088fe4","Design the customer feedback journey") ?? "Design the customer feedback journey")}</h4><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_1b03ec923f1e15","Control the first question, the follow-up prompt, and what happens after each possible rating.") ?? "Control the first question, the follow-up prompt, and what happens after each possible rating.")}</p></div></div>
        ${String(surveyCard())}
        ${String(reviewCard(scale))}
      `;
    }

    function deliveryTimingCard(){
      const selected = text(delivery().trigger, 'workflow');
      // TODO(feedback-scope-timing): replace these provisional global events
      // with trigger choices derived from the active scope sets and automations.
      const options = [
        { key:'project_completed', icon:'fas fa-flag-checkered', label:(globalThis.PlatformLanguage?.text("settings","m_db872e4acca3f4","When work is completed") ?? "When work is completed"), note:'Send when a project work plan reaches completion.' },
        { key:'final_payment', icon:'fas fa-circle-dollar-to-slot', label:(globalThis.PlatformLanguage?.text("settings","m_db9237afcc561c","After final payment") ?? "After final payment"), note:'Send when a settled final payment is recorded.' },
        { key:'crew_completed', icon:'fas fa-clipboard-check', label:(globalThis.PlatformLanguage?.text("settings","m_7e8f49260656d9","After crew closeout") ?? "After crew closeout"), note:'Send when the project crew completes a checklist.' },
        { key:'manual', icon:'fas fa-hand-pointer', label:(globalThis.PlatformLanguage?.text("settings","m_5832abd7cf0637","Manually only") ?? "Manually only"), note:'Only send when a team member explicitly requests it.' }
      ];
      return `<div class="fb-card wide">
        <div class="fb-card-head"><strong><i class="fas fa-clock"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_4dcdaed478d0bf"," When should this be sent?") ?? " When should this be sent?")}</strong><span data-feedback-timing-insight></span></div>
        <p class="fb-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_456f88328e8a58","Choose the event that makes the feedback request available. Each project receives one request, so repeat events will not send duplicates.") ?? "Choose the event that makes the feedback request available. Each project receives one request, so repeat events will not send duplicates.")}</p>
        <div class="fb-trigger-grid">${String(options.map((option) => `<button type="button" class="fb-trigger ${selected === option.key ? 'on' : ''}" data-fb-trigger="${option.key}"><i class="${option.icon}"></i><span><b>${option.label}</b><span>${option.note}</span></span></button>`).join(''))}</div>
        <div class="fb-scope-todo"><i class="fas fa-diagram-project"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_479768d58a038e","Scope-aware timing is still being connected.") ?? "Scope-aware timing is still being connected.")}</strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_75c3ffbc0df087"," Workflows and scope sets can already request feedback with the feedback automation action; their triggers are configured in the workflow, not with a button here. This list will later reflect the triggers available to this branch.") ?? " Workflows and scope sets can already request feedback with the feedback automation action; their triggers are configured in the workflow, not with a button here. This list will later reflect the triggers available to this branch.")}</span></div>
      </div>`;
    }

    function channelChooserCard(){
      const channelState = channels();
      const choice = (key, icon, label, note) => {
        const on = key === 'portal' ? channelState[key] === true : channelState[key] !== false;
        return `<button class="fb-choice ${on ? 'on' : ''}" type="button" data-fb-channel="${key}" aria-pressed="${on}"><span class="choice-icon"><i class="${icon}"></i></span><span><b>${label}</b><span>${note}</span></span>${on ? '<i class="fas fa-circle-check check"></i>' : ''}</button>`;
      };
      return `<div class="fb-card wide">
        <div class="fb-card-head"><strong><i class="fas fa-share-nodes"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_9a5412305bd598"," How do you want to send the message?") ?? " How do you want to send the message?")}</strong></div>
        <p class="fb-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_0f43e2feaab957","Use any combination. A channel is only used when the customer has the required contact information or portal access.") ?? "Use any combination. A channel is only used when the customer has the required contact information or portal access.")}</p>
        <div class="fb-choice-grid">
          ${String(choice('sms', 'fas fa-message', 'Text message', 'Send a short link to their mobile phone.'))}
          ${String(choice('email', 'fas fa-envelope', 'Email', 'Send a branded request to their inbox.'))}
          ${String(choice('portal', 'fas fa-window-maximize', 'Customer portal', 'Show a feedback card inside their project portal.'))}
        </div>
      </div>`;
    }

    function channelMessagesCard(){
      const channelState = channels();
      const messageState = messages();
      const enabled = (key) => key === 'portal' ? channelState[key] === true : channelState[key] !== false;
      const status = (key) => `<span class="fb-channel-state ${enabled(key) ? '' : 'off'}"><i class="fas ${enabled(key) ? 'fa-circle-check' : 'fa-circle-pause'}"></i> ${enabled(key) ? 'On' : 'Off'}</span>`;
      const tags = (target, off) => `<div class="fb-tags">${MERGE_TAGS.map((entry) => `<button class="fb-tag" type="button" data-fb-tag="${esc(entry.tag)}" data-fb-tag-target="${target}" ${off ? 'disabled' : ''}>${esc(entry.label)}</button>`).join('')}</div>`;
      const active = ['sms', 'email', 'portal'].includes(state.previewTab) ? state.previewTab : 'sms';
      const off = !enabled(active);
      const tabs = `<div class="fb-message-tabs">
        <button type="button" data-fb-message-tab="sms" class="${String(active === 'sms' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_124287f184b88b","Text") ?? "Text")}</button>
        <button type="button" data-fb-message-tab="email" class="${String(active === 'email' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</button>
        <button type="button" data-fb-message-tab="portal" class="${String(active === 'portal' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_a4cd44bc12f332","Portal") ?? "Portal")}</button>
      </div>`;
      let editor = '';
      if (active === 'email') {
        editor = `<div class="fb-message-head"><div class="fb-message-title"><span class="icon"><i class="fas fa-envelope"></i></span><b>${(globalThis.PlatformLanguage?.htmlText("settings","m_dd8addd86a5eb5","Email message") ?? "Email message")}</b></div>${String(status('email'))}</div>
          <p class="fb-message-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_1c1074d948b624","The subject and full message customers receive in their inbox.") ?? "The subject and full message customers receive in their inbox.")}</p>
          <div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_bfb9f300f17496","Subject") ?? "Subject")}</label><input type="text" data-fb-set="messages.email_subject" data-fb-input="email_subject" value="${String(esc(messageState.email_subject))}" ${String(off ? 'disabled' : '')}></div>
          <div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_63ea7578d93f41","Email body") ?? "Email body")}</label><textarea rows="7" data-fb-set="messages.email_body" data-fb-input="email_body" ${String(off ? 'disabled' : '')}>${String(esc(messageState.email_body))}</textarea>${String(tags('email_body', off))}</div>`;
      } else if (active === 'portal') {
        editor = `<div class="fb-message-head"><div class="fb-message-title"><span class="icon"><i class="fas fa-window-maximize"></i></span><b>${(globalThis.PlatformLanguage?.htmlText("settings","m_8f4e084f019658","Customer portal message") ?? "Customer portal message")}</b></div>${String(status('portal'))}</div>
          <p class="fb-message-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_fd3cea1c6a9d1b","The feedback card displayed on the customer's project overview.") ?? "The feedback card displayed on the customer's project overview.")}</p>
          <div class="fb-grid2"><div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_f2b1764fc05842","Headline") ?? "Headline")}</label><input type="text" data-fb-set="messages.portal_title" data-fb-input="portal_title" value="${String(esc(text(messageState.portal_title, 'How did we do?')))}" ${String(off ? 'disabled' : '')}>${String(tags('portal_title', off))}</div><div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_f709f2734ba4ad","Button label") ?? "Button label")}</label><input type="text" data-fb-set="messages.portal_cta" value="${String(esc(text(messageState.portal_cta, 'Leave feedback')))}" ${String(off ? 'disabled' : '')}></div></div>
          <div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_dd88bd427da29a","Supporting message") ?? "Supporting message")}</label><textarea rows="3" data-fb-set="messages.portal_body" data-fb-input="portal_body" ${String(off ? 'disabled' : '')}>${String(esc(text(messageState.portal_body, 'Tell us how everything went — it only takes a few seconds.')))}</textarea>${String(tags('portal_body', off))}</div>`;
      } else {
        editor = `<div class="fb-message-head"><div class="fb-message-title"><span class="icon"><i class="fas fa-message"></i></span><b>${(globalThis.PlatformLanguage?.htmlText("settings","m_def279b4381c15","Text message") ?? "Text message")}</b></div>${String(status('sms'))}</div>
          <p class="fb-message-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_8dee195d1a2ca6","Keep it personal and concise. The feedback link is inserted automatically with the link tag.") ?? "Keep it personal and concise. The feedback link is inserted automatically with the link tag.")}</p>
          <div class="fb-field"><label>${(globalThis.PlatformLanguage?.htmlText("settings","m_a16cfd85cfd122","Message") ?? "Message")}</label><textarea rows="6" data-fb-set="messages.sms_text" data-fb-input="sms" ${String(off ? 'disabled' : '')}>${String(esc(messageState.sms_text))}</textarea>${String(tags('sms', off))}</div>`;
      }
      return `<div class="fb-message-card ${off ? 'off' : ''}">${tabs}${editor}</div>`;
    }

    function surveyCard(){
      const surveyState = survey();
      return `<div class="fb-card">
        <div class="fb-card-head"><strong><i class="fas fa-star-half-stroke"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_417595701f5efd"," Rating page") ?? " Rating page")}</strong></div>
        <p class="fb-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_aded7846960631","The branded page your customer lands on — your colors and logo, automatically.") ?? "The branded page your customer lands on — your colors and logo, automatically.")}</p>
        <div class="fb-field">
          <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_bc5c2002760d4b","Question") ?? "Question")}</label>
          <input type="text" data-fb-set="survey.question" value="${String(esc(surveyState.question))}">
        </div>
        <div class="fb-grid2">
          <div class="fb-field">
            <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_693b3024ec2d2a","Comment prompt") ?? "Comment prompt")}</label>
            <input type="text" data-fb-set="survey.comment_prompt" value="${String(esc(surveyState.comment_prompt))}">
          </div>
          <div class="fb-field">
            <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_f26e99eeec4727","Low-rating prompt") ?? "Low-rating prompt")}</label>
            <input type="text" data-fb-set="survey.low_comment_prompt" value="${String(esc(surveyState.low_comment_prompt))}">
          </div>
        </div>
      </div>`;
    }

    function reviewCard(scale){
      const reviewState = review();
      const mode = text(reviewState.mode, 'threshold');
      const threshold = Math.min(scale, Number(reviewState.threshold) || 4);
      const destinations = array(reviewState.destinations);
      const destRow = (destination, index) => {
        const preset = DESTINATION_PRESETS.find((entry) => entry.id === text(object(destination).id).replace(/_\d+$/, '')) || null;
        return `<div class="fb-dest" data-fb-dest="${String(index)}">
          <span class="fb-dest-icon"><i class="${String(esc(text(destination.icon, 'fas fa-star')))}"></i></span>
          <div class="fb-dest-fields">
            <input type="text" data-fb-dest-label="${String(index)}" value="${String(esc(destination.label))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_9fd79f4276d659","Label") ?? "Label")}">
            <input type="url" data-fb-dest-url="${String(index)}" value="${String(esc(destination.url))}" placeholder="${String(esc(preset?.hint || 'https://…'))}">
          </div>
          <button class="fb-dest-remove" type="button" data-fb-dest-remove="${String(index)}" title="${(globalThis.PlatformLanguage?.htmlText("settings","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>
        </div>`;
      };
      return `<div class="fb-card wide">
        <div class="fb-card-head"><strong><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_586f8486ebf025"," Review invitations") ?? " Review invitations")}</strong></div>
        <p class="fb-sub">${(globalThis.PlatformLanguage?.htmlText("settings","m_876704370a30a6","After a customer rates you, invite them to post it publicly. Choose who sees the invitation and where it sends them.") ?? "After a customer rates you, invite them to post it publicly. Choose who sees the invitation and where it sends them.")}</p>
        <div class="fb-seg" data-fb-mode>
          <button type="button" data-fb-mode-value="threshold" class="${String(mode === 'threshold' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_ee49d54fa637c1","At a rating") ?? "At a rating")}</button>
          <button type="button" data-fb-mode-value="always" class="${String(mode === 'always' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_ba4c0181dbbab5","Everyone") ?? "Everyone")}</button>
          <button type="button" data-fb-mode-value="never" class="${String(mode === 'never' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_273e689aeb0785","Off") ?? "Off")}</button>
        </div>
        ${String(mode === 'threshold' ? `<div class="fb-threshold">
          <span class="fb-threshold-stars" data-fb-threshold>${starRow(scale, threshold, 'fb-tstar', 'data-fb-tstar')}</span>
          <span class="fb-threshold-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_d37d1ea8014ce9","Invite customers who rate ") ?? "Invite customers who rate ")}<b>${threshold}${threshold < scale ? '+' : ''}</b>${(globalThis.PlatformLanguage?.htmlText("settings","m_6389d8e47068f3"," stars &middot; everyone else lands on the private thank-you") ?? " stars &middot; everyone else lands on the private thank-you")}</span>
        </div>` : '')}
        <div class="fb-field" style="margin-top:18px">
          <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_2f7b6ce949eb0e","Closing message &mdash; the customer only ever sees one of these") ?? "Closing message &mdash; the customer only ever sees one of these")}</label>
        </div>
        <div class="fb-grid2" style="margin-top:-6px">
          ${String(mode !== 'never' ? `<div class="fb-field" style="margin-top:8px">
            <label style="color:#3538cd">${(globalThis.PlatformLanguage?.htmlText("settings","m_3a0286aa106f2b","With review invitation") ?? "With review invitation")}</label>
            <input type="text" data-fb-set="review.prompt" value="${esc(reviewState.prompt)}">
          </div>` : '')}
          <div class="fb-field" style="margin-top:8px">
            <label style="color:#b42318">${(globalThis.PlatformLanguage?.htmlText("settings","m_fa780a47499428","Low rating (kept private)") ?? "Low rating (kept private)")}</label>
            <input type="text" data-fb-set="review.low_note" value="${String(esc(reviewState.low_note))}">
          </div>
          <div class="fb-field" style="margin-top:8px">
            <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_b7ef67005d0484","Default thank-you") ?? "Default thank-you")}</label>
            <input type="text" data-fb-set="survey.thank_you" value="${String(esc(object(state.settings.survey).thank_you))}">
          </div>
        </div>
        ${String(mode !== 'never' ? `<div class="fb-field">
          <label>${(globalThis.PlatformLanguage?.htmlText("settings","m_52830c4072ae13","Destinations") ?? "Destinations")}</label>
          ${destinations.map((destination, index) => destRow(object(destination), index)).join('') || `<div class="fb-empty">${(globalThis.PlatformLanguage?.htmlText("settings","m_1dad4c0b509712","No destinations yet — add where great reviews should go.") ?? "No destinations yet — add where great reviews should go.")}</div>`}
          <div class="fb-dest-add">
            ${DESTINATION_PRESETS.map((preset) => `<button type="button" data-fb-dest-add="${preset.id}"><i class="${preset.icon}"></i> ${preset.label}</button>`).join('')}
          </div>
        </div>` : '')}
      </div>`;
    }

    // ---------------- responses tab ----------------
    function matchesFilter(request){
      const scale = Number(request.rating_scale) || Number(survey().scale) || 5;
      const threshold = Math.min(scale, Number(review().threshold) || 4);
      const rating = Number(request.rating) || 0;
      if (state.filter === 'awaiting' && rating > 0) return false;
      if (state.filter === 'attention' && (rating === 0 || rating >= threshold)) return false;
      if (/^\d+$/.test(state.filter) && rating !== Number(state.filter)) return false;
      if (state.query) {
        const haystack = [
          object(request.contact).name, object(request.contact).email, object(request.contact).phone,
          request.project_title, request.project_id, request.comment
        ].map((value) => String(value ?? '').toLowerCase()).join(' ');
        if (!haystack.includes(state.query.toLowerCase())) return false;
      }
      return true;
    }

    function responsesView(scale){
      const totals = object(state.totals);
      const threshold = Math.min(scale, Number(review().threshold) || 4);
      const rated = state.requests.filter((request) => Number(request.rating) > 0);
      const attention = rated.filter((request) => Number(request.rating) < threshold).length;
      const filtered = state.requests.filter(matchesFilter);
      const chip = (value, label, icon) => `<button class="fb-chip ${state.filter === value ? 'on' : ''} ${value === 'attention' ? 'attention' : ''}" type="button" data-fb-filter="${value}">${icon || ''}${label}</button>`;
      const starChips = [];
      for (let index = scale; index >= 1; index -= 1) starChips.push(chip(String(index), `${index}`, '<i class="fas fa-star"></i> '));
      return `
        <div class="fb-stats">
          <div class="fb-stat"><b>${String(Number(totals.sent || 0))}</b><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_56fe4e1ce79d70","Requests sent") ?? "Requests sent")}</span></div>
          <div class="fb-stat"><b>${String(Number(totals.rated || 0))}</b><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_00c47f7a0e881d","Ratings") ?? "Ratings")}</span></div>
          <div class="fb-stat"><b>${String(totals.average_rating ? `${Number(totals.average_rating).toFixed(1)}<span class="max"> / ${scale}</span>` : '—')}</b><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_eb12b605c5ff63","Avg rating") ?? "Avg rating")}</span></div>
          <div class="fb-stat ${String(attention ? 'alert' : '')}"><b>${String(attention)}</b><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_aeaf0897bce2d4","Needs attention") ?? "Needs attention")}</span></div>
          <div class="fb-stat"><b>${String(Number(totals.review_clicks || 0))}</b><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_2da71c09981b1e","Review clicks") ?? "Review clicks")}</span></div>
        </div>
        <div class="fb-toolbar">
          <div class="fb-search"><i class="fas fa-magnifying-glass"></i><input type="text" data-fb-search placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_c216b4e1d94213","Search customers, projects, or comments…") ?? "Search customers, projects, or comments…")}" value="${String(esc(state.query))}"></div>
          <div class="fb-filters">
            ${String(chip('all', 'All'))}
            ${String(chip('attention', 'Needs attention', '<i class="fas fa-star"></i> '))}
            ${String(starChips.join(''))}
            ${String(chip('awaiting', 'Awaiting reply'))}
          </div>
        </div>
        <div class="fb-rows">
          ${String(filtered.length ? filtered.map((request) => responseRow(request, threshold)).join('') : `<div class="fb-empty">${state.requests.length ? 'Nothing matches this filter.' : 'Responses will appear here as customers rate their projects.'}</div>`)}
        </div>`;
    }

    function responseRow(request, threshold){
      const scale = Number(request.rating_scale) || Number(survey().scale) || 5;
      const rating = Number(request.rating) || 0;
      const low = rating > 0 && rating < threshold;
      let stars = '';
      for (let index = 1; index <= scale; index += 1) stars += index <= rating ? '★' : '☆';
      const contact = object(request.contact);
      const sendChips = array(request.sends).map((send) => `<span class="fb-meta-chip"><i class="fas ${text(object(send).channel) === 'email' ? 'fa-envelope' : 'fa-message'}"></i> ${esc(text(object(send).channel, 'sent'))}</span>`).join('');
      const clickChips = array(request.destination_clicks).map((click) => `<span class="fb-meta-chip click"><i class="fas fa-arrow-up-right-from-square"></i> ${esc(text(object(click).label, object(click).id, 'review'))}</span>`).join('');
      const when = text(request.rated_at, request.last_sent_at, request.created_at).slice(0, 10);
      return `<div class="fb-row ${low ? 'low' : ''} ${rating ? '' : 'pending'}">
        <div class="fb-row-stars">
          ${rating ? `<span class="stars">${stars}</span><span class="num">${rating}/${scale}</span>` : `<span class="awaiting" title="${(globalThis.PlatformLanguage?.htmlText("settings","m_113acb668de4b5","Awaiting reply") ?? "Awaiting reply")}"><i class="fas fa-hourglass-half"></i></span>`}
        </div>
        <div class="fb-row-main">
          <div class="fb-row-top">
            <b>${esc(text(contact.name, 'Customer'))}</b>
            ${text(request.project_title) ? `<span class="proj">${esc(request.project_title)}</span>` : ''}
          </div>
          ${text(request.comment) ? `<p class="fb-row-comment">${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_318ed57bbe192b",`&ldquo;${v0}&rdquo;`,{v0}) ?? `&ldquo;${v0}&rdquo;`)(esc(request.comment))}</p>` : (rating ? '' : `<p class="fb-row-comment" style="color:#98a2b3">${(globalThis.PlatformLanguage?.htmlText("settings","m_2c1250ca3d67ef","Invitation sent — no response yet.") ?? "Invitation sent — no response yet.")}</p>`)}
          <div class="fb-row-meta">
            ${low ? `<span class="fb-meta-chip low"><i class="fas fa-flag"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_48ae8a24acd3d5"," Needs attention") ?? " Needs attention")}</span>` : ''}
            ${sendChips}
            ${request.opened_at && !rating ? `<span class="fb-meta-chip">${(globalThis.PlatformLanguage?.htmlText("settings","m_af42634af9d6f3","opened") ?? "opened")}</span>` : ''}
            ${clickChips}
          </div>
        </div>
        <div class="fb-row-time">${esc(when)}</div>
      </div>`;
    }

    // ---------------- live phone preview ----------------
    function renderPreview(){
      const wrap = rootEl.querySelector('[data-fb-preview]');
      if (!wrap) return;
      const onDeliveryPage = state.tab === 'delivery';
      if (onDeliveryPage && !['sms', 'email', 'portal'].includes(state.previewTab)) state.previewTab = 'sms';
      if (!onDeliveryPage) state.previewTab = 'page';
      wrap.classList.toggle('workflow-preview', !onDeliveryPage);
      const theme = brandTheme();
      const rgb = hexToRgb(theme.primary);
      const surveyState = survey();
      const reviewState = review();
      const scale = Number(surveyState.scale) || 5;
      const mode = text(reviewState.mode, 'threshold');
      const threshold = Math.min(scale, Number(reviewState.threshold) || 4);
      const rating = state.previewRating;
      const qualifies = rating > 0 && mode !== 'never' && (mode === 'always' || rating >= threshold);
      const destinations = array(reviewState.destinations).filter((destination) => object(destination).enabled !== false);
      const linkedDestinations = destinations.filter((destination) => text(object(destination).url));

      const brand = `<div class="fb-pv-brand">${theme.logo ? `<img src="${esc(theme.logo)}" alt="">` : ''}<span class="nm">${esc(theme.name)}</span></div>`;
      let screen = '';
      let caption = 'Tap a star to preview what your customer sees.';

      if (state.previewStep === 'ask' || !rating) {
        screen = (String(brand) + "<div class=\"fb-pv-card\">\n          <h4>" + String(esc(surveyState.question)) + "</h4>\n          <p class=\"fb-pv-sub\">" + (globalThis.PlatformLanguage?.text("settings","m_e93cc15d94a857","Thanks for choosing us, Sarah — it only takes a few seconds.") ?? "Thanks for choosing us, Sarah — it only takes a few seconds.") + "</p>\n          <div class=\"fb-pv-stars\">" + String(starRow(scale, 0, 'fb-pv-star', 'data-fb-pv-star')) + "</div>\n          <div class=\"fb-pv-hint\">" + (globalThis.PlatformLanguage?.text("settings","m_bd15ef72c20228","Tap a star") ?? "Tap a star") + "</div>\n        </div>");
      } else if (state.previewStep === 'comment') {
        const below = rating < threshold;
        screen = (String(brand) + "<div class=\"fb-pv-card\">\n          <h4>" + String(esc(surveyState.question)) + "</h4>\n          <div class=\"fb-pv-stars\">" + String(starRow(scale, rating, 'fb-pv-star', 'data-fb-pv-star')) + "</div>\n          <div class=\"fb-pv-hint\">" + String(rating) + "/" + String(scale) + "</div>\n          <div class=\"fb-pv-textarea\">" + String(esc(below ? surveyState.low_comment_prompt : surveyState.comment_prompt)) + "</div>\n          <button class=\"fb-pv-cta\" type=\"button\" data-fb-pv-send>" + (globalThis.PlatformLanguage?.text("settings","m_6653b9d85e7598","Send feedback") ?? "Send feedback") + "</button>\n          <button class=\"fb-pv-reset\" type=\"button\" data-fb-pv-reset>" + (globalThis.PlatformLanguage?.text("settings","m_146bf782a5decb","Start over") ?? "Start over") + "</button>\n        </div>");
        caption = below
          ? `${rating} star${rating === 1 ? '' : 's'} → asks &ldquo;${esc(surveyState.low_comment_prompt)}&rdquo;`
          : `${rating} star${rating === 1 ? '' : 's'} → comment, then send`;
      } else {
        // Exactly one closing message, mirroring the live page: invitation
        // (with buttons), private low-rating note, or default thank-you.
        const showsInvite = qualifies && linkedDestinations.length > 0;
        const message = showsInvite
          ? text(reviewState.prompt)
          : rating < threshold
            ? text(reviewState.low_note)
            : text(surveyState.thank_you);
        const buttons = showsInvite
          ? linkedDestinations.map((destination) => `<div class="fb-pv-dest"><span><i class="brand ${String(esc(text(object(destination).icon, 'fas fa-star')))}"></i>${((v1) => globalThis.PlatformLanguage?.htmlText("settings","m_0d5439f565ef39",`&nbsp; ${v1}`,{v1}) ?? `&nbsp; ${v1}`)(esc(object(destination).label))}</span><span class="go">${(globalThis.PlatformLanguage?.htmlText("settings","m_dcba86d629271a","&rarr;") ?? "&rarr;")}</span></div>`).join('')
          : '';
        const warn = qualifies && !linkedDestinations.length
          ? `<div class="fb-pv-warn"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_e1a4221377482a"," This rating qualifies for a review invitation, but no destination has a link yet — customers see the default thank-you until you add one.") ?? " This rating qualifies for a review invitation, but no destination has a link yet — customers see the default thank-you until you add one.")}</div>`
          : '';
        screen = (String(brand) + "<div class=\"fb-pv-card\">\n          <div class=\"fb-pv-check\"><i class=\"fas fa-check\"></i></div>\n          <h4>" + (globalThis.PlatformLanguage?.text("settings","m_1d9048d24b091e","Thank you!") ?? "Thank you!") + "</h4>\n          <p class=\"fb-pv-sub\">" + String(esc(message)) + "</p>\n          " + String(buttons) + "\n          " + String(warn) + "\n          <button class=\"fb-pv-reset\" type=\"button\" data-fb-pv-reset>" + (globalThis.PlatformLanguage?.text("settings","m_5dcd8b0803f48a","Preview a different rating") ?? "Preview a different rating") + "</button>\n        </div>");
        caption = `${rating} star${rating === 1 ? '' : 's'} ${showsInvite ? '→ review invitation' : rating < threshold ? '→ private feedback' : '→ default thank-you'}`;
      }

      const smsScreen = `<div class="fb-sms-thread">
        <div class="fb-sms-from">${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_12629ab4bb91ce",`${v0} &middot; TEXT MESSAGE`,{v0}) ?? `${v0} &middot; TEXT MESSAGE`)(esc(theme.name.toUpperCase()))}</div>
        <div class="fb-sms-bubble">${String(previewMessageHtml(text(messages().sms_text), 'fb-sms-link'))}</div>
        <div class="fb-sms-time">${(globalThis.PlatformLanguage?.htmlText("settings","m_08395ff7aa8e3a","Delivered") ?? "Delivered")}</div>
      </div>`;

      const emailScreen = `<div class="fb-email">
        <div class="fb-email-bar"><i class="fas fa-circle"></i><i class="fas fa-circle"></i><i class="fas fa-circle"></i></div>
        <div class="fb-email-head"><b>${String(esc(mergeSample(text(messages().email_subject))))}</b><span>${((v1) => globalThis.PlatformLanguage?.htmlText("settings","m_685b5b9075b04a",`${v1} &lt;notifications@firstmatemail.com&gt; &nbsp; to Sarah`,{v1}) ?? `${v1} &lt;notifications@firstmatemail.com&gt; &nbsp; to Sarah`)(esc(theme.name))}</span></div>
        <div class="fb-email-body">${String(previewMessageHtml(text(messages().email_body), 'fb-email-link'))}</div>
      </div>`;

      const portalScreen = `<div class="fb-portal-shell">
        <div class="fb-portal-head">${String(theme.logo ? `<img src="${esc(theme.logo)}" alt="">` : '')}<b>${String(esc(theme.name))}</b></div>
        <div class="fb-portal-nav"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_b69161f38dacdf","Overview") ?? "Overview")}</span><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_fc05a804bd034c","Schedule") ?? "Schedule")}</span><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_5d7c7ad6033624","Documents") ?? "Documents")}</span></div>
        <div class="fb-portal-content"><p class="fb-portal-project">${(globalThis.PlatformLanguage?.htmlText("settings","m_e582e6c2daa378","Roof replacement") ?? "Roof replacement")}</p><div class="fb-portal-card">
          <div class="fb-portal-stars">★★★★★</div><div class="fb-portal-copy"><b>${String(esc(mergeSample(text(messages().portal_title, 'How did we do?'))))}</b><span>${String(esc(mergeSample(text(messages().portal_body, 'Tell us how everything went — it only takes a few seconds.'))))}</span></div><div class="fb-portal-btn">${String(esc(text(messages().portal_cta, 'Leave feedback')))}</div>
        </div></div>
      </div>`;

      const previewScreens = { page: screen, sms: smsScreen, email: emailScreen, portal: portalScreen };

      wrap.innerHTML = `
        ${onDeliveryPage ? `<div class="fb-preview-tabs delivery">
          <button type="button" data-fb-pv-tab="sms" class="${String(state.previewTab === 'sms' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_124287f184b88b","Text") ?? "Text")}</button>
          <button type="button" data-fb-pv-tab="email" class="${String(state.previewTab === 'email' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_5d2b9327181e33","Email") ?? "Email")}</button>
          <button type="button" data-fb-pv-tab="portal" class="${String(state.previewTab === 'portal' ? 'on' : '')}">${(globalThis.PlatformLanguage?.htmlText("settings","m_a4cd44bc12f332","Portal") ?? "Portal")}</button>
        </div>` : ''}
        <div class="fb-phone" style="--fb-pv-brand:${esc(theme.primary)};${rgb ? `--fb-pv-brand-rgb:${rgb};` : ''}">
          <div class="fb-phone-notch"></div>
          <div class="fb-screen">${previewScreens[state.previewTab] || screen}</div>
        </div>
        ${!onDeliveryPage ? `<div class="fb-pv-caption">${caption}</div>` : ''}`;

      wrap.querySelectorAll('[data-fb-pv-tab]').forEach((button) => button.addEventListener('click', () => {
        state.previewTab = button.dataset.fbPvTab;
        render();
      }));
      wrap.querySelectorAll('[data-fb-pv-star]').forEach((button) => button.addEventListener('click', () => {
        state.previewRating = Number(button.dataset.fbPvStar);
        state.previewStep = 'comment';
        renderPreview();
      }));
      wrap.querySelector('[data-fb-pv-send]')?.addEventListener('click', () => {
        state.previewStep = 'done';
        renderPreview();
      });
      wrap.querySelector('[data-fb-pv-reset]')?.addEventListener('click', () => {
        state.previewRating = 0;
        state.previewStep = 'ask';
        renderPreview();
      });
    }

    // ---------------- bindings ----------------
    function bindShell(){
      rootEl.querySelectorAll('[data-fb-tab]').forEach((button) => button.addEventListener('click', () => {
        if (state.tab === button.dataset.fbTab) return;
        const leavingEditor = !!state.settings && state.tab !== 'responses' && button.dataset.fbTab === 'responses';
        if (leavingEditor && isDirty() && !root.confirm((globalThis.PlatformLanguage?.text("settings","m_a821f72dd01473","Leave without saving your feedback changes?") ?? "Leave without saving your feedback changes?"))) return;
        if (leavingEditor && isDirty()) state.settings = JSON.parse(state.saved);
        state.tab = button.dataset.fbTab;
        state.previewTab = state.tab === 'delivery' ? 'sms' : 'page';
        options.onViewChange?.(state.tab);
        render();
        const scroller = host.closest('.cs-card');
        if (scroller) scroller.scrollTop = 0;
      }));
    }

    function bindResponses(){
      const search = rootEl.querySelector('[data-fb-search]');
      search?.addEventListener('input', () => {
        state.query = search.value;
        const rows = rootEl.querySelector('.fb-rows');
        const scale = Number(survey().scale) || 5;
        const threshold = Math.min(scale, Number(review().threshold) || 4);
        const filtered = state.requests.filter(matchesFilter);
        if (rows) rows.innerHTML = filtered.length
          ? filtered.map((request) => responseRow(request, threshold)).join('')
          : `<div class="fb-empty">${state.requests.length ? 'Nothing matches this filter.' : 'Responses will appear here as customers rate their projects.'}</div>`;
      });
      rootEl.querySelectorAll('[data-fb-filter]').forEach((button) => button.addEventListener('click', () => {
        state.filter = button.dataset.fbFilter;
        render();
      }));
    }

    function bindSetup(){
      const timingInsightHost = rootEl.querySelector('[data-feedback-timing-insight]');
      if (timingInsightHost && root.FirstMateInsights?.mount) {
        deliveryTimingInsight = root.FirstMateInsights.mount(timingInsightHost, {
          id:'feedback_delivery_timing_recommendation',
          title:(globalThis.PlatformLanguage?.text("settings","m_87973863921b2d","Send every customer a feedback request") ?? "Send every customer a feedback request"),
          body:'We recommend automatically sending the feedback request to all customers, even if the job did not go that well, because this gives the customer an opportunity to vent and leave their feedback in private.',
          developerContext:'Explain why consistently requesting private feedback can help a company identify problems, recover customer relationships, and improve its service. Do not imply that private feedback prevents a customer from leaving a public review.',
          preferredSide:'left'
        });
      }

      rootEl.querySelectorAll('[data-fb-message-tab]').forEach((button) => button.addEventListener('click', () => {
        state.previewTab = button.dataset.fbMessageTab;
        render();
      }));

      rootEl.querySelectorAll('[data-fb-channel]').forEach((button) => button.addEventListener('click', () => {
        const key = button.dataset.fbChannel;
        const current = channels()[key];
        setDeep('channels', key, key === 'portal' ? current !== true : current === false);
        render();
      }));

      rootEl.querySelectorAll('[data-fb-trigger]').forEach((button) => button.addEventListener('click', () => {
        setDeep('delivery', 'trigger', button.dataset.fbTrigger);
        render();
      }));

      rootEl.querySelectorAll('[data-fb-set]').forEach((input) => input.addEventListener('input', () => {
        const [section, key] = String(input.dataset.fbSet).split('.');
        setDeep(section, key, input.value);
        renderPreview();
      }));

      rootEl.querySelectorAll('[data-fb-mode-value]').forEach((button) => button.addEventListener('click', () => {
        setDeep('review', 'mode', button.dataset.fbModeValue);
        state.previewRating = 0;
        state.previewStep = 'ask';
        render();
      }));

      rootEl.querySelectorAll('[data-fb-tstar]').forEach((button) => button.addEventListener('click', () => {
        setDeep('review', 'threshold', Number(button.dataset.fbTstar));
        render();
      }));

      rootEl.querySelectorAll('[data-fb-dest-add]').forEach((button) => button.addEventListener('click', () => {
        const preset = DESTINATION_PRESETS.find((entry) => entry.id === button.dataset.fbDestAdd) || DESTINATION_PRESETS[DESTINATION_PRESETS.length - 1];
        const destinations = array(review().destinations);
        const suffix = destinations.filter((destination) => text(object(destination).id).replace(/_\d+$/, '') === preset.id).length;
        setDeep('review', 'destinations', [...destinations, {
          id: suffix ? `${preset.id}_${suffix + 1}` : preset.id,
          label: preset.id === 'custom' ? 'Review us' : preset.label,
          url: '',
          icon: preset.icon,
          enabled: true
        }]);
        render();
      }));

      rootEl.querySelectorAll('[data-fb-dest-remove]').forEach((button) => button.addEventListener('click', () => {
        const destinations = array(review().destinations).slice();
        destinations.splice(Number(button.dataset.fbDestRemove), 1);
        setDeep('review', 'destinations', destinations);
        render();
      }));

      const bindDestField = (attr, key) => rootEl.querySelectorAll(`[${attr}]`).forEach((input) => input.addEventListener('input', () => {
        const index = Number(input.getAttribute(attr));
        const destinations = array(review().destinations).map((destination, position) => (
          position === index ? { ...object(destination), [key]: input.value } : destination
        ));
        setDeep('review', 'destinations', destinations);
        renderPreview();
      }));
      bindDestField('data-fb-dest-label', 'label');
      bindDestField('data-fb-dest-url', 'url');

      rootEl.querySelectorAll('[data-fb-tag]').forEach((button) => button.addEventListener('click', () => {
        const target = button.dataset.fbTagTarget;
        const input = rootEl.querySelector(`[data-fb-input="${target}"]`);
        if (!input) return;
        const tag = button.dataset.fbTag;
        const start = Number(input.selectionStart ?? input.value.length);
        const end = Number(input.selectionEnd ?? input.value.length);
        input.value = `${input.value.slice(0, start)}${tag}${input.value.slice(end)}`;
        input.dispatchEvent(new Event('input'));
        input.focus();
        const caret = start + tag.length;
        try { input.setSelectionRange(caret, caret); } catch (error) { /* inputs without selection support */ }
      }));

      rootEl.querySelector('[data-fb-save]')?.addEventListener('click', save);
      rootEl.querySelector('[data-fb-discard]')?.addEventListener('click', () => {
        state.settings = JSON.parse(state.saved);
        state.previewRating = 0;
        state.previewStep = 'ask';
        render();
      });
    }

    async function save(){
      if (state.saving || !isDirty()) return;
      state.saving = true;
      const button = rootEl.querySelector('[data-fb-save]');
      if (button) { button.disabled = true; button.textContent = (globalThis.PlatformLanguage?.text("settings","m_ea600c018fb36c","Saving…") ?? "Saving…"); }
      try {
        const result = await api(settingsPath, { method:'PUT', body:{ ...state.settings, expected_revision: state.revision || undefined } });
        state.settings = object(result?.settings);
        state.revision = Number(result?.revision || 0);
        state.saved = JSON.stringify(state.settings);
        toast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_bbc21684980ea4","Your feedback system is up to date.") ?? "Your feedback system is up to date."), true);
        render();
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"), error?.message || 'Could not save your changes.', false);
        if (button) { button.disabled = false; button.textContent = (globalThis.PlatformLanguage?.text("settings","m_1d368860f0287e","Save changes") ?? "Save changes"); }
      } finally {
        state.saving = false;
      }
    }

    load();
  }

  root.FirstMateFeedbackSettings = { mount, setView:(host, view) => controllers.get(host)?.setView(view), destroy:(host) => controllers.get(host)?.destroy() };
})(window);
