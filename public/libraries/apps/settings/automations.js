(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => String(values.find((value) => value != null && String(value).trim()) ?? '').trim();
  const AGENT_TIMEOUT_MS = 150000;

  function injectCss(){
    if (document.getElementById('fmAutomationsSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmAutomationsSettingsCss';
    style.textContent = `
      .au-root{color:#17212b;min-height:620px}.au-root *{box-sizing:border-box}
      .au-loading{display:grid;place-items:center;min-height:420px;color:#667085;font-size:12px;font-weight:850}
      .au-error{border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:14px;color:#b42318;font-size:12px;font-weight:800}
      .au-picker-head h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em}
      .au-picker-head p{margin:6px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:640px}
      .au-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:20px}
      .au-card{appearance:none;position:relative;display:flex;flex-direction:column;gap:11px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;padding:16px;text-align:left;cursor:pointer;box-shadow:0 1px 2px rgba(16,24,40,.03);transition:box-shadow .14s ease,border-color .14s ease,transform .14s ease}
      .au-card:hover{border-color:#c8d0da;box-shadow:0 6px 18px rgba(16,24,40,.08);transform:translateY(-1px)}
      .au-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .au-card-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:11px;background:var(--au-tile,#667085);color:#fff;font-size:16px;flex:0 0 auto}
      .au-card strong{color:#101828;font-size:14px;line-height:1.25}
      .au-card p{margin:0;color:#667085;font-size:11px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .au-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 9px;font-size:9px;font-weight:950;letter-spacing:.03em;text-transform:uppercase;background:#eef4ff;color:#3538cd;flex:0 0 auto}
      .au-badge.production{background:#fff4ed;color:#c4320a}
      .au-empty-boards{border:1px dashed #ccd4dd;border-radius:11px;padding:26px;text-align:center;color:#7b8794;font-size:12px;font-weight:800;margin-top:20px}
      .au-picker{max-width:1180px;margin:0 auto;padding:4px 0 28px}
      .au-picker-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
      .au-root.embedded .au-title{pointer-events:none}.au-root.embedded .au-tile{pointer-events:none}.au-root.embedded .au-swatch,.au-root.embedded .au-manage{display:none}
      .au-picker-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
      .au-primary,.au-secondary,.au-danger{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;border-radius:10px;padding:0 13px;font:900 11.5px/1 inherit;cursor:pointer}
      .au-primary{border:1px solid var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .au-primary:hover{filter:brightness(1.05)}.au-primary:disabled{border-color:#d0d5dd;background:#d0d5dd;cursor:default;filter:none}
      .au-secondary{border:1px solid #d0d5dd;background:#fff;color:#344054}.au-secondary:hover{background:#f8fafc}
      .au-danger{border:1px solid #fecdca;background:#fff;color:#b42318}.au-danger:hover{background:#fef3f2}
      .au-board-tabs{display:flex;align-items:center;gap:4px;width:max-content;margin-top:20px;border:1px solid #e4e7ec;border-radius:11px;background:#f8fafc;padding:4px}
      .au-board-tab{appearance:none;border:0;border-radius:8px;background:transparent;padding:8px 12px;color:#667085;font:900 11px/1 inherit;cursor:pointer}
      .au-board-tab.active{background:#fff;color:#101828;box-shadow:0 1px 4px rgba(16,24,40,.10)}
      .au-board-tab span{display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:4px;border-radius:999px;background:#eaecf0;font-size:9px}
      .au-card-shell{position:relative;min-width:0}
      .au-card-shell .au-card{width:100%;height:100%;padding-right:48px}
      .au-card-shell.disabled .au-card{border-color:#d0d5dd;background:#f2f4f7;color:#667085;opacity:.78}
      .au-card-shell.disabled .au-card-icon{filter:grayscale(1);opacity:.68}
      .au-card-shell.disabled .au-badge{background:#e4e7ec;color:#667085}
      .au-card-more{appearance:none;position:absolute;right:11px;top:11px;z-index:2;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}
      .au-card-more:hover,.au-card-more[aria-expanded="true"]{background:#f2f4f7;color:#101828}
      .au-card-menu{position:absolute;right:10px;top:44px;z-index:20;width:190px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:5px;box-shadow:0 14px 34px rgba(16,24,40,.16)}
      .au-card-menu button{appearance:none;display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:8px;background:transparent;padding:9px 10px;color:#344054;font:850 11px/1.2 inherit;text-align:left;cursor:pointer}
      .au-card-menu button:hover{background:#f2f4f7}.au-card-menu button.trash{color:#b42318}.au-card-menu button i{width:14px;text-align:center}
      .au-card-state{display:inline-flex;align-items:center;gap:5px;color:#667085;font-size:9.5px;font-weight:900}.au-card-state i{font-size:7px;color:#12b76a}.au-card-state.off i{color:#98a2b3}
      .au-trash-note{margin-top:14px;border:1px solid #d1e9ff;border-radius:11px;background:#f0f9ff;padding:11px 13px;color:#175cd3;font-size:11px;font-weight:750;line-height:1.45}
      .au-creator{max-width:1120px;margin:0 auto;padding:4px 0 30px}
      .au-creator-head{display:flex;align-items:center;gap:13px;margin-bottom:18px}.au-creator-head h3{margin:0;font-size:22px}.au-creator-head p{margin:4px 0 0;color:#667085;font-size:11.5px}
      .au-creator-layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:16px;align-items:start}
      .au-form-card,.au-preview-card{border:1px solid #e4e7ec;border-radius:15px;background:#fff;padding:17px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
      .au-form-card{display:grid;gap:18px}.au-form-section{display:grid;gap:11px}.au-form-section+.au-form-section{padding-top:17px;border-top:1px solid #eaecf0}
      .au-form-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.au-form-title strong{font-size:13px}.au-form-title span{display:block;margin-top:3px;color:#667085;font-size:10.5px;font-weight:700}
      .au-kind-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.au-kind{appearance:none;border:1px solid #d0d5dd;border-radius:12px;background:#fff;padding:12px;display:grid;grid-template-columns:36px minmax(0,1fr);gap:10px;align-items:center;text-align:left;cursor:pointer;color:#344054}
      .au-kind i{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:#f2f4f7;color:#475467}.au-kind strong{display:block;font-size:11.5px}.au-kind span{display:block;margin-top:3px;color:#667085;font-size:9.5px;line-height:1.35}
      .au-kind.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.035);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.09)}.au-kind.selected i{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .au-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.au-field{display:grid;gap:5px;color:#475467;font-size:10px;font-weight:900}.au-field.wide{grid-column:1/-1}
      .au-field input,.au-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:9px 10px;color:#101828;font:750 12px/1.4 inherit;outline:0}.au-field textarea{min-height:68px;resize:vertical}
      .au-field input:focus,.au-field textarea:focus,.au-stage-name:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
      .au-appearance{display:grid;grid-template-columns:auto minmax(0,1fr);gap:13px}.au-color-wrap{display:grid;gap:6px}.au-color-input{width:54px;height:54px;border:0;border-radius:12px;background:transparent;padding:0;cursor:pointer}.au-color-input::-webkit-color-swatch-wrapper{padding:0}.au-color-input::-webkit-color-swatch{border:1px solid #d0d5dd;border-radius:12px}
      .au-icon-grid{display:grid;grid-template-columns:repeat(8,minmax(30px,1fr));gap:5px}.au-icon-choice{appearance:none;height:34px;border:1px solid transparent;border-radius:8px;background:#f8fafc;color:#667085;cursor:pointer}.au-icon-choice:hover{background:#f2f4f7;color:#101828}.au-icon-choice.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
      .au-stage-list{display:grid;gap:7px}.au-stage-row{display:grid;grid-template-columns:28px 24px minmax(0,1fr) auto;gap:7px;align-items:center;border:1px solid #e4e7ec;border-radius:10px;background:#f8fafc;padding:7px}
      .au-stage-number{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#fff;color:#667085;font-size:9px;font-weight:950}.au-stage-dot{width:16px;height:16px;border-radius:50%;border:2px solid #fff;background:var(--stage-color);box-shadow:0 0 0 1px #d0d5dd}
      .au-stage-name{min-width:0;border:1px solid transparent;border-radius:7px;background:transparent;padding:7px 8px;color:#101828;font:850 11.5px/1.2 inherit;outline:0}.au-stage-actions{display:flex;gap:2px}.au-stage-actions button{appearance:none;width:27px;height:27px;border:0;border-radius:7px;background:transparent;color:#667085;cursor:pointer}.au-stage-actions button:hover{background:#fff;color:#101828}.au-stage-actions button.remove:hover{color:#b42318}.au-stage-actions button:disabled{opacity:.3;cursor:default}
      .au-add-stage{appearance:none;border:1px dashed #cbd3dd;border-radius:10px;background:#fff;padding:10px;color:#475467;font:900 10.5px/1 inherit;cursor:pointer}.au-add-stage:hover{border-color:#98a2b3;background:#f8fafc}
      .au-creator-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.au-form-error{margin-right:auto;color:#b42318;font-size:10.5px;font-weight:850}
      .au-preview-card{position:sticky;top:10px;display:grid;gap:14px}.au-preview-label{color:#98a2b3;font-size:9px;font-weight:950;letter-spacing:.08em;text-transform:uppercase}
      .au-preview-board{overflow:hidden;border:1px solid #e4e7ec;border-radius:13px;background:#f8fafc}.au-preview-head{display:flex;align-items:center;gap:10px;padding:12px;background:#fff;border-bottom:1px solid #e4e7ec}.au-preview-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 38px;margin:0;border-radius:10px;background:var(--board-color);color:#fff;font-size:14px;line-height:1}.au-preview-icon i{display:block;color:inherit;line-height:1}.au-preview-head strong{display:block;font-size:12px}.au-preview-copy>span{display:block;margin-top:3px;color:#667085;font-size:9.5px}.au-preview-stages{display:grid;gap:7px;padding:10px}.au-preview-stage{display:grid;grid-template-columns:5px minmax(0,1fr);gap:9px;align-items:center;border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:9px}.au-preview-stage:before{content:"";align-self:stretch;border-radius:999px;background:var(--stage-color)}.au-preview-stage strong{font-size:10.5px}.au-preview-stage span{display:block;margin-top:2px;color:#98a2b3;font-size:8.5px}
      .au-manage{position:relative;flex:0 0 auto}.au-manage-btn{appearance:none;display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}.au-manage-btn:hover,.au-manage-btn[aria-expanded="true"]{background:#f2f4f7;color:#101828}.au-manage .au-card-menu{top:34px;right:0}
      .au-workspace{display:grid;grid-template-columns:360px minmax(0,1fr);grid-template-rows:minmax(0,1fr);border:1px solid #e4e7ec;border-radius:13px;background:#fff;overflow:hidden;height:var(--au-fit,auto);max-height:var(--au-fit,none);min-height:360px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
      .au-left{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid #e4e7ec;background:#f8fafc}
      .au-left-head{position:relative;display:flex;align-items:center;gap:9px;padding:12px;border-bottom:1px solid #e4e7ec;background:#fff;min-height:62px}
      .au-back{appearance:none;display:grid;place-items:center;width:32px;height:32px;flex:0 0 auto;border:1px solid #d6dce3;border-radius:8px;background:#fff;color:#475467;cursor:pointer;font-size:12px}
      .au-back:hover{background:#f7f9fb;color:#17212b}
      .au-tile{appearance:none;border:0;padding:0;display:grid;place-items:center;width:36px;height:36px;flex:0 0 auto;border-radius:9px;background:var(--au-tile,#667085);color:#fff;font-size:14px;cursor:pointer}
      .au-tile:hover{filter:brightness(1.08)}
      .au-iconpop{position:absolute;top:calc(100% - 6px);left:44px;z-index:60;width:260px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(16,24,40,.16);padding:10px}
      .au-iconpop-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
      .au-iconpop-btn{appearance:none;display:grid;place-items:center;height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:#475467;font-size:13px;cursor:pointer}
      .au-iconpop-btn:hover{background:#f2f4f7;color:#17212b}
      .au-iconpop-btn.selected{border-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.06)}
      .au-iconpop-row{display:flex;align-items:center;gap:7px;margin-top:9px;padding-top:9px;border-top:1px solid #eaecf0}
      .au-iconpop-preview{display:grid;place-items:center;width:30px;height:30px;flex:0 0 auto;border-radius:8px;background:var(--au-tile,#667085);color:#fff;font-size:12px}
      .au-iconpop-input{flex:1;min-width:0;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:7px 8px;color:#344054;font:800 11.5px/1.2 inherit;outline:0}
      .au-iconpop-input:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .au-iconpop-apply{appearance:none;border:0;border-radius:8px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font:900 10.5px/1 inherit;padding:9px 10px;cursor:pointer;flex:0 0 auto}
      .au-iconpop-apply:hover{filter:brightness(1.06)}
      .au-title-wrap{flex:1;min-width:0}
      .au-title{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid transparent;border-radius:7px;padding:6px 8px;margin:-6px -8px;color:#101828;font-size:14.5px;font-weight:950;cursor:text}
      .au-title:hover{border-color:#d6dce3;background:#fff}
      .au-title-input{width:100%;border:1px solid var(--primary-readable,var(--primary,#d93025));border-radius:7px;background:#fff;padding:6px 8px;margin:-6px -8px;color:#101828;font:950 14.5px/1.2 inherit;outline:none;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .au-swatch{position:relative;display:block;width:24px;height:24px;flex:0 0 auto;border-radius:50%;background:var(--au-tile,#667085);box-shadow:inset 0 0 0 2px rgba(255,255,255,.85),0 0 0 1px #d0d5dd;cursor:pointer}
      .au-swatch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
      .au-list-toggle{display:none}
      .au-list{flex:1;overflow:auto;padding:10px;display:grid;gap:7px;align-content:start}
      .au-list-note{color:#7b8794;font-size:10px;font-weight:850;padding:2px 4px}
      .au-list-section{margin:14px 2px 6px;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#98a2b3}
      .au-entry{appearance:none;position:relative;display:block;width:100%;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:11px 34px 11px 12px;text-align:left;cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease}
      .au-entry:hover{border-color:#c8d0da;box-shadow:0 2px 8px rgba(16,24,40,.06)}
      .au-entry.referenced{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.10)}
      .au-entry.disabled .au-entry-text{color:#98a2b3;text-decoration:line-through}
      .au-entry-text{display:block;color:#344054;font-size:12px;font-weight:800;line-height:1.45}
      .au-entry-node{display:block;margin-top:5px;overflow:hidden;color:#98a2b3;font-size:9.5px;font-weight:900;letter-spacing:.02em;text-transform:uppercase;text-overflow:ellipsis;white-space:nowrap}
      .au-entry-add{position:absolute;top:9px;right:9px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#eaecf0;color:#667085;font-size:9px}
      .au-entry:hover .au-entry-add{background:#dbe1e8;color:#344054}
      .au-entry.referenced .au-entry-add{background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .au-list-empty{border:1px dashed #ccd4dd;border-radius:10px;padding:20px 14px;text-align:center;color:#7b8794;font-size:11.5px;font-weight:800;line-height:1.5}
      .au-right{display:flex;flex-direction:column;min-width:0;min-height:0}
      .au-chat-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;border-bottom:1px solid #e4e7ec;min-height:62px}
      .au-chat-head-copy{min-width:0}
      .au-chat-head strong{display:block;color:#101828;font-size:13px}
      .au-chat-head span{display:block;margin-top:2px;color:#667085;font-size:10px;font-weight:750}
      .au-textbtn{appearance:none;border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font:900 11px/1 inherit;cursor:pointer;padding:7px 8px;border-radius:7px;flex:0 0 auto}
      .au-textbtn:hover{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .au-textbtn:disabled{color:#98a2b3;cursor:default;background:transparent}
      .au-messages{flex:1;min-height:0;overflow:auto;padding:18px 16px;display:flex;flex-direction:column;gap:12px;background:#fcfcfd}
      .au-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:82%}
      .au-msg.user{align-self:flex-end;align-items:flex-end}
      .au-bubble{border:1px solid #e4e7ec;border-radius:13px;border-bottom-left-radius:4px;background:#fff;padding:10px 13px;color:#344054;font-size:12.5px;font-weight:700;line-height:1.55;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .au-msg.user .au-bubble{border-radius:13px;border-bottom-right-radius:4px;border-color:transparent;background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .au-bubble.failed{border-color:#fedf89;background:#fffaeb;color:#7a5200}
      .au-rollback{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(122,82,0,.16);color:#b54708;font-size:10.5px;font-weight:900}
      .au-changes{margin-top:7px;border:1px solid #d1e0ff;border-radius:10px;background:#eff4ff;padding:9px 12px;max-width:100%}
      .au-changes>span{display:flex;align-items:center;gap:6px;color:#175cd3;font-size:9.5px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}
      .au-changes ul{margin:6px 0 0;padding-left:16px;color:#344054;font-size:11px;font-weight:750;line-height:1.55}
      .au-msg-time{margin-top:4px;color:#98a2b3;font-size:9px;font-weight:850}
      .au-dots{display:inline-flex;gap:3px;margin-left:2px;vertical-align:middle}
      .au-dots i{width:5px;height:5px;border-radius:50%;background:#98a2b3;animation:auDot 1.1s infinite ease-in-out}
      .au-dots i:nth-child(2){animation-delay:.18s}.au-dots i:nth-child(3){animation-delay:.36s}
      @keyframes auDot{0%,70%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
      .au-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px}
      .au-chips:not(:empty){padding-top:10px}
      .au-chip{appearance:none;display:inline-flex;align-items:center;gap:7px;max-width:100%;border:1px solid rgba(var(--primary-rgb,217,48,37),.35);border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.06);padding:6px 10px;color:var(--primary-readable,var(--primary,#d93025));font:850 10.5px/1.2 inherit;cursor:pointer;text-align:left}
      .au-chip em{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .au-chip i{font-size:9px;opacity:.75;flex:0 0 auto}
      .au-chip:hover i{opacity:1}
      .au-inputrow{display:flex;align-items:flex-end;gap:9px;padding:12px 16px 16px}
      .au-input{flex:1;min-width:0;max-height:130px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;padding:10px 12px;color:#344054;font:750 12.5px/1.5 inherit;outline:0;resize:none}
      .au-input:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}
      .au-input:disabled{background:#f8fafc;color:#98a2b3}
      .au-send{appearance:none;display:grid;place-items:center;width:40px;height:40px;flex:0 0 auto;border:0;border-radius:11px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:13px;cursor:pointer}
      .au-send:hover{filter:brightness(1.06)}
      .au-send:disabled{background:#e4e7ec;color:#98a2b3;cursor:default;filter:none}
      @media(max-width:1200px){
        .au-creator-layout{grid-template-columns:1fr}.au-preview-card{position:static}
      }
      @media(max-width:900px){
        .au-picker-head{flex-direction:column}.au-appearance{grid-template-columns:1fr}.au-icon-grid{grid-template-columns:repeat(8,1fr)}
        .au-workspace{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);min-height:0}
        .au-left{border-right:0;border-bottom:1px solid #e4e7ec}
        .au-list-toggle{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;border-top:1px solid #e4e7ec;background:#f8fafc;padding:11px 14px;color:#475467;font:900 11px/1 inherit;cursor:pointer;width:100%;text-align:left}
        .au-list-toggle i{transition:transform .15s ease}
        .au-left.open .au-list-toggle i{transform:rotate(180deg)}
        .au-list{display:none;max-height:300px}
        .au-left.open .au-list{display:grid}
        .au-right{min-height:0}
        .au-msg{max-width:92%}
      }
      @media(max-width:620px){
        .au-kind-grid,.au-fields{grid-template-columns:1fr}.au-field.wide{grid-column:auto}.au-icon-grid{grid-template-columns:repeat(6,1fr)}
        .au-stage-row{grid-template-columns:24px 18px minmax(0,1fr)}.au-stage-actions{grid-column:3;justify-content:flex-end}.au-creator-actions{flex-wrap:wrap}.au-form-error{width:100%;margin:0}.au-primary,.au-secondary{flex:1}
      }
    `;
    document.head.appendChild(style);
  }

  function mount(host, options = {}){
    if (!host || host.dataset.automationsMounted === '1') return;
    host.dataset.automationsMounted = '1';
    injectCss();

    const orgId = String(options.orgId || '').trim();
    const branchId = String(options.branchId || 'default').trim() || 'default';
    const toast = options.showToast || (() => {});
    const embeddedTemplateId = text(options.templateId);
    const embedded = !!embeddedTemplateId;
    const routeSub = text(options.routeSub, 'automations');

    const state = {
      view:'picker',
      templates:[],
      template:null,          // {id,name,color,icon,description,version,kind}
      entries:[],
      orgRules:[],
      references:[],          // ordered entry keys
      threadId:'',
      messages:[],
      sending:false,
      mobileListOpen:false,
      pickerSection:'boards',
      creating:false
    };

    // --- transport: same cookie+CSRF pipeline as every other settings tab ---
    const base = `${location.origin}/v1/scopes`;
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
    const templatesPath = `/organizations/${encodeURIComponent(orgId)}/branches/${encodeURIComponent(branchId)}/templates`;
    const agentPath = `/organizations/${encodeURIComponent(orgId)}/agent/threads`;
    const writeRoute = (patch, history = 'push') => {
      if (root.Portal?.navigation?.applying) return;
      if (embedded) return;
      root.Portal?.navigation?.write?.({ tab:'company_settings', sub:routeSub, ...patch }, {
        history,
        source:'automation-assistant-boards',
        ownedKeys:['settingsView','settingsEntity']
      });
    };

    const templateKind = (template) => text(object(template?.definition).kind, template?.kind, 'production') === 'pipeline' ? 'pipeline' : 'production';
    const templateColor = (template) => text(template?.color, '#667085');
    const templateIcon = (template) => text(template?.icon, templateKind(template) === 'pipeline' ? 'fa-filter-circle-dollar' : 'fa-diagram-project');
    const welcomeMessage = () => ({
      role:'assistant',
      content:"Hi! I manage the automations for this board. Click any automation on the left to talk about it, or just tell me what you'd like to happen automatically.",
      data:{},
      local:true
    });

    host.innerHTML = `<div class="au-root ${String(embedded ? 'embedded' : '')}"><div class="au-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_a54bc20fe42cea"," Loading your board…") ?? " Loading your board…")}</span></div></div>`;
    const rootEl = host.querySelector('.au-root');

    // Clamp the workspace to the visible viewport so the composer is always reachable.
    function fitWorkspace(){
      const workspace = rootEl.querySelector('.au-workspace');
      if (!workspace) { rootEl.style.removeProperty('--au-fit'); return; }
      const top = workspace.getBoundingClientRect().top;
      const height = Math.max(360, Math.floor(window.innerHeight - Math.max(top, 0) - 16));
      rootEl.style.setProperty('--au-fit', `${height}px`);
    }
    window.addEventListener('resize', () => { if (rootEl.isConnected && state.view === 'workspace') fitWorkspace(); });

    // ---------------- View 1: board picker ----------------
    async function openPicker(options = {}){
      closeIconPopover();
      state.view = 'picker';
      state.template = null;
      state.pickerSection = options.section === 'trash' ? 'trash' : 'boards';
      rootEl.innerHTML = `<div class="au-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_089ef20b3b1f8f"," Loading your boards…") ?? " Loading your boards…")}</span></div>`;
      try {
        const result = await api(`${templatesPath}?include_disabled=1&include_archived=1`);
        state.templates = array(result?.templates);
      } catch (error) {
        rootEl.innerHTML = `<div class="au-error">${((v0) => globalThis.PlatformLanguage?.text("settings","m_48aa2f183e023c",`Could not load your boards. ${v0}`,{v0}) ?? `Could not load your boards. ${v0}`)(esc(error?.message || ''))}</div>`;
        return;
      }
      renderPicker();
    }

    function renderPickerLegacy(){
      const cards = state.templates.map((template) => {
        const kind = templateKind(template);
        return `<button class="au-card" type="button" data-au-open="${esc(template.id)}">
          <div class="au-card-top">
            <span class="au-card-icon" style="--au-tile:${esc(templateColor(template))}"><i class="fas ${esc(templateIcon(template))}"></i></span>
            <span class="au-badge ${kind === 'pipeline' ? '' : 'production'}">${kind === 'pipeline' ? 'Sales pipeline' : 'Production'}</span>
          </div>
          <strong>${esc(text(template.name, 'Untitled board'))}</strong>
          <p>${esc(text(template.description, 'No description yet.'))}</p>
        </button>`;
      }).join('');
      rootEl.innerHTML = `<div class="au-picker">
        <div class="au-picker-head">
          <h3>${(globalThis.PlatformLanguage?.text("settings","m_a80fb97ae44094","Which projects do you want to automate?") ?? "Which projects do you want to automate?")}</h3>
          <p>${(globalThis.PlatformLanguage?.text("settings","m_586326a4d33513","Pick a board below, then describe what should happen automatically — reminders, follow-ups, status changes, and more. The assistant sets it all up for you.") ?? "Pick a board below, then describe what should happen automatically — reminders, follow-ups, status changes, and more. The assistant sets it all up for you.")}</p>
        </div>
        ${String(cards ? `<div class="au-grid">${cards}</div>` : `<div class="au-empty-boards">No boards found yet. Create a scope template first, then come back here to automate it.</div>`)}
      </div>`;
      rootEl.querySelectorAll('[data-au-open]').forEach((button) => button.addEventListener('click', () => {
        const template = state.templates.find((item) => item.id === button.dataset.auOpen);
        if (template) openWorkspace(template);
      }));
    }

    function renderPicker(){
      const live = state.templates.filter((template) => text(template.status) !== 'archived');
      const trashed = state.templates.filter((template) => text(template.status) === 'archived');
      const visible = state.pickerSection === 'trash' ? trashed : live;
      const cards = visible.map((template) => {
        const kind = templateKind(template);
        const isTrash = text(template.status) === 'archived';
        return `<div class="au-card-shell ${String(template.enabled === false ? 'disabled' : '')}" data-au-card-shell="${String(esc(template.id))}">
          <button class="au-card" type="button" data-au-open="${String(esc(template.id))}" ${String(isTrash ? 'disabled' : '')}>
            <div class="au-card-top">
              <span class="au-card-icon" style="--au-tile:${String(esc(templateColor(template)))}"><i class="fas ${String(esc(templateIcon(template)))}"></i></span>
              <span class="au-badge ${String(kind === 'pipeline' ? '' : 'production')}">${String(kind === 'pipeline' ? 'Sales pipeline' : 'Production')}</span>
            </div>
            <strong>${String(esc(text(template.name, 'Untitled board')))}</strong>
            <p>${String(esc(text(template.description, isTrash ? 'Stored safely in trash.' : 'Ready for automations.')))}</p>
            <span class="au-card-state ${String(template.enabled === false ? 'off' : '')}"><i class="fas fa-circle"></i>${String(isTrash ? 'In trash' : template.enabled === false ? 'Disabled' : 'Enabled')}</span>
          </button>
          <button class="au-card-more" type="button" data-au-card-more="${String(esc(template.id))}" aria-label="${((v13) => globalThis.PlatformLanguage?.text("settings","m_57b1c3b97b7ce4",`Manage ${v13}`,{v13}) ?? `Manage ${v13}`)(esc(text(template.name, 'board')))}" aria-expanded="false"><i class="fas fa-ellipsis"></i></button>
        </div>`;
      }).join('');
      rootEl.innerHTML = `<div class="au-picker">
        <div class="au-picker-head">
          <div><h3>${(globalThis.PlatformLanguage?.text("settings","m_117a3ed83e32b5","Boards &amp; automations") ?? "Boards &amp; automations")}</h3>
          <p>${(globalThis.PlatformLanguage?.text("settings","m_e1cb0d8242a573","Create the stages yourself, then use the assistant to build the reminders, handoffs, updates, and follow-ups around them.") ?? "Create the stages yourself, then use the assistant to build the reminders, handoffs, updates, and follow-ups around them.")}</p></div>
          <div class="au-picker-actions"><button class="au-primary" type="button" data-au-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_a838cb86d52e24"," New board") ?? " New board")}</button></div>
        </div>
        <div class="au-board-tabs" role="tablist" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_11e5dd576234a1","Board status") ?? "Board status")}">
          <button class="au-board-tab ${String(state.pickerSection === 'boards' ? 'active' : '')}" type="button" role="tab" aria-selected="${String(state.pickerSection === 'boards')}" data-au-section="boards">${(globalThis.PlatformLanguage?.text("settings","m_af2eeabbf2aaee","Boards ") ?? "Boards ")}<span>${String(live.length)}</span></button>
          <button class="au-board-tab ${String(state.pickerSection === 'trash' ? 'active' : '')}" type="button" role="tab" aria-selected="${String(state.pickerSection === 'trash')}" data-au-section="trash">${(globalThis.PlatformLanguage?.text("settings","m_f13b900b5b5b5b","Trash ") ?? "Trash ")}<span>${String(trashed.length)}</span></button>
        </div>
        ${String(state.pickerSection === 'trash' ? '<div class="au-trash-note"><i class="fas fa-shield-halved"></i>&nbsp; Trashed boards are hidden from daily work but keep every version and all existing project history. Restore them at any time.</div>' : '')}
        ${String(cards ? `<div class="au-grid">${cards}</div>` : `<div class="au-empty-boards">${state.pickerSection === 'trash' ? 'Trash is empty.' : 'No boards yet. Create your first board to get started.'}</div>`)}
      </div>`;
      rootEl.querySelectorAll('[data-au-open]').forEach((button) => button.addEventListener('click', () => {
        const template = state.templates.find((item) => item.id === button.dataset.auOpen);
        if (!template) return;
        writeRoute({ settingsView:'board', settingsEntity:`scope:${template.id}` }, 'push');
        openWorkspace(template);
      }));
      rootEl.querySelector('[data-au-create]')?.addEventListener('click', () => {
        writeRoute({ settingsView:'create-board', settingsEntity:'' }, 'push');
        openCreator();
      });
      rootEl.querySelectorAll('[data-au-section]').forEach((button) => button.addEventListener('click', () => {
        state.pickerSection = button.dataset.auSection;
        writeRoute({ settingsView:state.pickerSection === 'boards' ? 'boards' : state.pickerSection, settingsEntity:'' }, 'push');
        renderPicker();
      }));
      rootEl.querySelectorAll('[data-au-card-more]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const template = state.templates.find((item) => item.id === button.dataset.auCardMore);
        if (template) toggleCardMenu(button, template);
      }));
    }

    let boardMenuOutsideHandler = null;
    function closeBoardMenus(){
      rootEl.querySelectorAll('[data-au-card-menu]').forEach((menu) => menu.remove());
      rootEl.querySelectorAll('[data-au-card-more],[data-au-manage-btn]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
      if (boardMenuOutsideHandler) {
        document.removeEventListener('mousedown', boardMenuOutsideHandler, true);
        boardMenuOutsideHandler = null;
      }
    }

    function toggleCardMenu(button, template){
      const shell = button.closest('[data-au-card-shell]') || button.closest('[data-au-manage]');
      const existing = shell?.querySelector('[data-au-card-menu]');
      closeBoardMenus();
      if (existing || !shell) return;
      const trashed = text(template.status) === 'archived';
      const menu = document.createElement('div');
      menu.className = 'au-card-menu';
      menu.dataset.auCardMenu = '';
      menu.innerHTML = trashed
        ? `<button type="button" data-au-state="restore"><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_27dd714b58dc0c"," Restore board") ?? " Restore board")}</button>`
        : `<button type="button" data-au-state="${String(template.enabled === false ? 'enable' : 'disable')}"><i class="fas ${String(template.enabled === false ? 'fa-toggle-on' : 'fa-toggle-off')}"></i> ${String(template.enabled === false ? 'Enable board' : 'Disable board')}</button>
           <button class="trash" type="button" data-au-state="trash"><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("settings","m_86f9abd667ae6d"," Move to trash") ?? " Move to trash")}</button>`;
      shell.appendChild(menu);
      button.setAttribute('aria-expanded', 'true');
      menu.querySelectorAll('[data-au-state]').forEach((action) => action.addEventListener('click', () => changeBoardState(template, action.dataset.auState)));
      const outsideHandler = (event) => {
        if (event.target?.closest?.('[data-au-card-menu],[data-au-card-more],[data-au-manage-btn]')) return;
        closeBoardMenus();
      };
      boardMenuOutsideHandler = outsideHandler;
      setTimeout(() => {
        if (boardMenuOutsideHandler === outsideHandler) document.addEventListener('mousedown', outsideHandler, true);
      }, 0);
    }

    async function changeBoardState(template, action){
      closeBoardMenus();
      if (action === 'trash' && !window.confirm(((v0) => globalThis.PlatformLanguage?.text("settings","m_12777a0433d94c",`Move "${v0}" to trash? Existing project history and every board version will be kept.`,{v0}) ?? `Move "${v0}" to trash? Existing project history and every board version will be kept.`)(text(template.name, 'this board')))) return;
      const patch = action === 'enable' ? { enabled:true } : action === 'disable' ? { enabled:false } : action === 'restore' ? { trashed:false } : { trashed:true };
      try {
        const result = await api(`${templatesPath}/${encodeURIComponent(template.id)}/state`, { method:'PATCH', body:patch });
        const saved = object(result?.template);
        window.dispatchEvent(new CustomEvent('fm:scope-templates:updated', { detail:{ template:saved, state:object(result?.state) } }));
        toast(action === 'trash' ? 'Moved to trash' : action === 'restore' ? 'Board restored' : action === 'enable' ? 'Board enabled' : 'Board disabled',
          action === 'trash' ? 'The board and its history are safe in Trash.' : `${text(saved.name, template.name)} is now ${action}d.`, true);
        const nextSection = action === 'trash' ? 'trash' : 'boards';
        writeRoute({ settingsView:nextSection, settingsEntity:'' }, 'replace');
        await openPicker({ section:nextSection });
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_9c0cf78e6e6e48","Board update failed") ?? "Board update failed"), error?.message || 'Please try again.', false);
      }
    }

    const STAGE_COLORS = ['#2563eb','#7c3aed','#d97706','#059669','#db2777','#0891b2','#dc2626','#475467'];
    let creatorDraft = null;
    const starterStages = (kind) => (kind === 'pipeline'
      ? ['New lead','Appointment','Proposal','Decision']
      : ['Newly sold','Planning','Scheduled','In progress','Complete'])
      .map((name, index) => ({ name, color:STAGE_COLORS[index % STAGE_COLORS.length] }));

    function openCreator(){
      closeIconPopover();
      closeBoardMenus();
      state.view = 'creator';
      creatorDraft = {
        kind:'production',
        name:'',
        description:'',
        color:'#2563eb',
        icon:'fa-diagram-project',
        stages:starterStages('production'),
        saving:false
      };
      renderCreator();
    }

    function renderCreator(){
      const draft = creatorDraft;
      const stagesMarkup = draft.stages.map((stage, index) => `<div class="au-stage-row" data-au-stage="${String(index)}">
        <span class="au-stage-number">${String(index + 1)}</span><span class="au-stage-dot" style="--stage-color:${String(esc(stage.color))}"></span>
        <input class="au-stage-name" value="${String(esc(stage.name))}" aria-label="${((v4) => globalThis.PlatformLanguage?.text("settings","m_7f39a99ea61b85",`Stage ${v4} name`,{v4}) ?? `Stage ${v4} name`)(index + 1)}" data-au-stage-name="${String(index)}">
        <span class="au-stage-actions">
          <button type="button" data-au-stage-up="${String(index)}" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_6c229ba1747e68","Move stage up") ?? "Move stage up")}" ${String(index === 0 ? 'disabled' : '')}><i class="fas fa-arrow-up"></i></button>
          <button type="button" data-au-stage-down="${String(index)}" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_3cd5fc2837b252","Move stage down") ?? "Move stage down")}" ${String(index === draft.stages.length - 1 ? 'disabled' : '')}><i class="fas fa-arrow-down"></i></button>
          <button class="remove" type="button" data-au-stage-remove="${String(index)}" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_93d5fa01ae38ff","Remove stage") ?? "Remove stage")}" ${String(draft.stages.length <= 1 ? 'disabled' : '')}><i class="fas fa-xmark"></i></button>
        </span>
      </div>`).join('');
      rootEl.innerHTML = `<div class="au-creator">
        <header class="au-creator-head"><button class="au-back" type="button" data-au-creator-back aria-label="${(globalThis.PlatformLanguage?.text("settings","m_ee4928655ff054","Back to boards") ?? "Back to boards")}"><i class="fas fa-arrow-left"></i></button><div><h3>${(globalThis.PlatformLanguage?.text("settings","m_ccbb6748922b13","Create a board") ?? "Create a board")}</h3><p>${(globalThis.PlatformLanguage?.text("settings","m_2a8565a786dbde","Lay out the board. The Automation Assistant will help you make it work.") ?? "Lay out the board. The Automation Assistant will help you make it work.")}</p></div></header>
        <div class="au-creator-layout">
          <div class="au-form-card">
            <section class="au-form-section">
              <div class="au-form-title"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_ef418a0cdbeca0","What kind of board is this?") ?? "What kind of board is this?")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_a955203eca4c27","This controls where the board is used.") ?? "This controls where the board is used.")}</span></div></div>
              <div class="au-kind-grid">
                <button class="au-kind ${String(draft.kind === 'pipeline' ? 'selected' : '')}" type="button" data-au-kind="pipeline"><i class="fas fa-filter-circle-dollar"></i><span><strong>${(globalThis.PlatformLanguage?.text("settings","m_01fbc71cf58163","Sales pipeline") ?? "Sales pipeline")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_7ff5fc2759b397","For leads, appointments, proposals, and closing.") ?? "For leads, appointments, proposals, and closing.")}</span></span></button>
                <button class="au-kind ${String(draft.kind === 'production' ? 'selected' : '')}" type="button" data-au-kind="production"><i class="fas fa-helmet-safety"></i><span><strong>${(globalThis.PlatformLanguage?.text("settings","m_c2e6380e130020","Production") ?? "Production")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_a8e65103609849","For sold work, scheduling, delivery, and completion.") ?? "For sold work, scheduling, delivery, and completion.")}</span></span></button>
              </div>
            </section>
            <section class="au-form-section">
              <div class="au-form-title"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_ebc1c692a2e78d","Name and purpose") ?? "Name and purpose")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_f4873ce50ff197","Use a name your team will recognize immediately.") ?? "Use a name your team will recognize immediately.")}</span></div></div>
              <div class="au-fields">
                <label class="au-field wide">${(globalThis.PlatformLanguage?.text("settings","m_15425354dbbc27","Board name") ?? "Board name")}<input type="text" maxlength="300" placeholder="${String(draft.kind === 'pipeline' ? 'Residential sales' : 'Roof replacement')}" value="${String(esc(draft.name))}" data-au-create-name></label>
                <label class="au-field wide">${(globalThis.PlatformLanguage?.text("settings","m_931f0950e047a8","Short description") ?? "Short description")}<textarea maxlength="1000" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_5bfcd72bba1d59","What belongs on this board?") ?? "What belongs on this board?")}" data-au-create-description>${String(esc(draft.description))}</textarea></label>
              </div>
            </section>
            <section class="au-form-section">
              <div class="au-form-title"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_3c6460c8cc6146","Color and icon") ?? "Color and icon")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_2080bffb3afded","Make the board easy to spot throughout FirstMate.") ?? "Make the board easy to spot throughout FirstMate.")}</span></div></div>
              <div class="au-appearance">
                <div class="au-color-wrap"><input class="au-color-input" type="color" value="${String(esc(draft.color))}" data-au-create-color aria-label="${(globalThis.PlatformLanguage?.text("settings","m_10eb04122d3284","Board color") ?? "Board color")}"></div>
                <div class="au-icon-grid">${String(ICON_CHOICES.map((icon) => `<button class="au-icon-choice ${draft.icon === icon ? 'selected' : ''}" type="button" data-au-create-icon="${esc(icon)}" aria-label="${esc(icon)}"><i class="fas ${esc(icon)}"></i></button>`).join(''))}</div>
              </div>
            </section>
            <section class="au-form-section">
              <div class="au-form-title"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_aac16f05678935","Stages") ?? "Stages")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_adbf2a9f16ad37","Put these in the order work should move from left to right.") ?? "Put these in the order work should move from left to right.")}</span></div></div>
              <div class="au-stage-list">${String(stagesMarkup)}</div>
              <button class="au-add-stage" type="button" data-au-add-stage><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_012423874ebff7","&nbsp; Add stage") ?? "&nbsp; Add stage")}</button>
            </section>
            <div class="au-creator-actions"><span class="au-form-error" data-au-create-error></span><button class="au-secondary" type="button" data-au-creator-cancel>${(globalThis.PlatformLanguage?.text("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="au-primary" type="button" data-au-create-save ${String(draft.saving ? 'disabled' : '')}><i class="fas ${String(draft.saving ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles')}"></i> ${String(draft.saving ? 'Creating…' : 'Create & open assistant')}</button></div>
          </div>
          <aside class="au-preview-card"><span class="au-preview-label">${(globalThis.PlatformLanguage?.text("settings","m_5842fe531f8ba3","Live preview") ?? "Live preview")}</span><div data-au-preview>${String(creatorPreviewMarkup())}</div></aside>
        </div>
      </div>`;
      bindCreator();
    }

    function creatorPreviewMarkup(){
      const draft = creatorDraft;
      return `<div class="au-preview-board"><div class="au-preview-head"><span class="au-preview-icon" style="--board-color:${String(esc(draft.color))}"><i class="fas ${String(esc(draft.icon))}"></i></span><span class="au-preview-copy"><strong>${String(esc(text(draft.name, 'Untitled board')))}</strong><span>${((v3,v4,v5) => globalThis.PlatformLanguage?.text("settings","m_055dd44bd73037",`${v3} · ${v4} stage${v5}`,{v3,v4,v5}) ?? `${v3} · ${v4} stage${v5}`)(draft.kind === 'pipeline' ? 'Sales pipeline' : 'Production board',draft.stages.length,draft.stages.length === 1 ? '' : 's')}</span></span></div><div class="au-preview-stages">${String(draft.stages.map((stage, index) => `<div class="au-preview-stage" style="--stage-color:${esc(stage.color)}"><span><strong>${esc(text(stage.name, `Stage ${index + 1}`))}</strong><span>Stage ${index + 1}</span></span></div>`).join(''))}</div></div>`;
    }

    function refreshCreatorPreview(){
      const preview = rootEl.querySelector('[data-au-preview]');
      if (preview) preview.innerHTML = creatorPreviewMarkup();
    }

    function bindCreator(){
      const back = () => {
        if (creatorDraft.name || creatorDraft.description) {
          if (!window.confirm((globalThis.PlatformLanguage?.text("settings","m_7b49a71dcc5039","Discard this new board?") ?? "Discard this new board?"))) return;
        }
        root.Portal?.navigation?.backOrClose?.(['settingsView'], { settingsView:'boards', settingsEntity:null }, { source:'automation-board-create-close' });
        openPicker({ section:'boards' });
      };
      rootEl.querySelector('[data-au-creator-back]')?.addEventListener('click', back);
      rootEl.querySelector('[data-au-creator-cancel]')?.addEventListener('click', back);
      rootEl.querySelectorAll('[data-au-kind]').forEach((button) => button.addEventListener('click', () => {
        const kind = button.dataset.auKind === 'pipeline' ? 'pipeline' : 'production';
        if (kind === creatorDraft.kind) return;
        creatorDraft.kind = kind;
        creatorDraft.icon = kind === 'pipeline' ? 'fa-filter-circle-dollar' : 'fa-diagram-project';
        creatorDraft.stages = starterStages(kind);
        renderCreator();
      }));
      rootEl.querySelector('[data-au-create-name]')?.addEventListener('input', (event) => { creatorDraft.name = event.currentTarget.value; refreshCreatorPreview(); });
      rootEl.querySelector('[data-au-create-description]')?.addEventListener('input', (event) => { creatorDraft.description = event.currentTarget.value; });
      rootEl.querySelector('[data-au-create-color]')?.addEventListener('input', (event) => { creatorDraft.color = event.currentTarget.value; refreshCreatorPreview(); });
      rootEl.querySelectorAll('[data-au-create-icon]').forEach((button) => button.addEventListener('click', () => { creatorDraft.icon = button.dataset.auCreateIcon; renderCreator(); }));
      rootEl.querySelectorAll('[data-au-stage-name]').forEach((input) => input.addEventListener('input', () => { creatorDraft.stages[Number(input.dataset.auStageName)].name = input.value; refreshCreatorPreview(); }));
      rootEl.querySelectorAll('[data-au-stage-up],[data-au-stage-down]').forEach((button) => button.addEventListener('click', () => {
        const from = Number(button.dataset.auStageUp ?? button.dataset.auStageDown);
        const to = button.hasAttribute('data-au-stage-up') ? from - 1 : from + 1;
        [creatorDraft.stages[from], creatorDraft.stages[to]] = [creatorDraft.stages[to], creatorDraft.stages[from]];
        renderCreator();
      }));
      rootEl.querySelectorAll('[data-au-stage-remove]').forEach((button) => button.addEventListener('click', () => { creatorDraft.stages.splice(Number(button.dataset.auStageRemove), 1); renderCreator(); }));
      rootEl.querySelector('[data-au-add-stage]')?.addEventListener('click', () => {
        creatorDraft.stages.push({ name:`Stage ${creatorDraft.stages.length + 1}`, color:STAGE_COLORS[creatorDraft.stages.length % STAGE_COLORS.length] });
        renderCreator();
        rootEl.querySelector(`[data-au-stage-name="${creatorDraft.stages.length - 1}"]`)?.select();
      });
      rootEl.querySelector('[data-au-create-save]')?.addEventListener('click', createBoard);
    }

    const slug = (value) => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 150);
    function uniqueId(base, used){
      let candidate = base || 'custom_board';
      let suffix = 2;
      while (used.has(candidate)) candidate = `${base || 'custom_board'}_${suffix++}`;
      used.add(candidate);
      return candidate;
    }

    async function createBoard(){
      const error = rootEl.querySelector('[data-au-create-error]');
      const name = text(creatorDraft.name);
      const stageNames = creatorDraft.stages.map((stage) => text(stage.name));
      if (!name) { if (error) error.textContent = (globalThis.PlatformLanguage?.text("settings","m_8824e32b108310","Give the board a name.") ?? "Give the board a name."); rootEl.querySelector('[data-au-create-name]')?.focus(); return; }
      if (!stageNames.length || stageNames.some((stage) => !stage)) { if (error) error.textContent = (globalThis.PlatformLanguage?.text("settings","m_a94a0d6e8d4fe7","Every stage needs a name.") ?? "Every stage needs a name."); return; }
      creatorDraft.saving = true;
      renderCreator();
      const usedTemplateIds = new Set(state.templates.map((template) => text(template.id)));
      const templateId = uniqueId(slug(name), usedTemplateIds);
      const usedNodeIds = new Set();
      const stageNodes = creatorDraft.stages.map((stage, index) => {
        const id = uniqueId(`${slug(stage.name) || `stage_${index + 1}`}_stage`, usedNodeIds);
        return {
          id,
          title:text(stage.name),
          terminology_key:'work.stage',
          actionable:true,
          completion_mode:'manual',
          ...(index ? { depends_on:[creatorDraft.stages[index - 1]._id] } : {}),
          metadata:{ color:stage.color, manually_created:true }
        };
      });
      stageNodes.forEach((node, index) => { creatorDraft.stages[index]._id = node.id; if (index) node.depends_on = [stageNodes[index - 1].id]; });
      const phaseId = uniqueId(`${templateId}_phase`, usedNodeIds);
      const definition = {
        schema_version:1,
        id:templateId,
        kind:creatorDraft.kind,
        name,
        description:text(creatorDraft.description),
        details:text(creatorDraft.description),
        color:creatorDraft.color,
        icon:creatorDraft.icon,
        status:'active',
        proposal:creatorDraft.kind === 'pipeline'
          ? { kind:'sales_pipeline', selectable:false }
          : { piece_types:[templateId], selectable:true },
        fields:[],
        work_plan:{
          title:name,
          terminology:{ phase:'Phase', stage:'Stage', task:'To-do', board:'Board' },
          metadata:{ board_color:creatorDraft.color },
          root_nodes:[{
            id:phaseId,
            title:name,
            terminology_key:'work.phase',
            completion_mode:'all_children',
            metadata:{ color:creatorDraft.color, board_id:templateId },
            children:stageNodes
          }]
        },
        metadata:{ preset:false, created_in:'automation_assistant' }
      };
      try {
        const result = await api(`${templatesPath}/${encodeURIComponent(templateId)}`, { method:'PUT', body:definition });
        const template = object(result?.template);
        state.templates = [...state.templates, template];
        creatorDraft.saving = false;
        window.dispatchEvent(new CustomEvent('fm:scope-templates:updated', { detail:{ template, created:true } }));
        toast((globalThis.PlatformLanguage?.text("settings","m_de0fcf6b94cfbb","Board created") ?? "Board created"), ((v0) => globalThis.PlatformLanguage?.text("settings","m_cd652bd494a8f4",`${v0} is ready. Now tell the assistant what should happen automatically.`,{v0}) ?? `${v0} is ready. Now tell the assistant what should happen automatically.`)(name), true);
        writeRoute({ settingsView:'board', settingsEntity:`scope:${templateId}` }, 'replace');
        await openWorkspace(template, { newlyCreated:true });
      } catch (saveError) {
        creatorDraft.saving = false;
        renderCreator();
        const message = rootEl.querySelector('[data-au-create-error]');
        if (message) message.textContent = saveError?.message || 'Could not create this board.';
      }
    }

    // ---------------- View 2: workspace ----------------
    async function openWorkspace(template, options = {}){
      state.view = 'workspace';
      state.template = { id:template.id, name:text(template.name), color:templateColor(template), icon:templateIcon(template), description:text(template.description), version:template.version, kind:templateKind(template), enabled:template.enabled !== false, status:text(template.status, 'active') };
      state.entries = [];
      state.references = [];
      state.threadId = '';
      state.messages = options.newlyCreated ? [{
        role:'assistant',
        content:`${text(template.name, 'Your board')} is ready with its stages in place. Tell me what should happen as work enters, moves through, or leaves each stage. I’ll ask a focused question whenever I need a business detail.`,
        data:{},
        local:true
      }] : [welcomeMessage()];
      state.sending = false;
      state.mobileListOpen = false;
      renderWorkspace();
      setListStatus(`<div class="au-loading" style="min-height:120px"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_b720d047a2de24"," Loading automations…") ?? " Loading automations…")}</span></div>`);
      try {
        const [inventory, threadList] = await Promise.all([
          api(`${templatesPath}/${encodeURIComponent(template.id)}/automation-inventory`),
          api(`${agentPath}?template_id=${encodeURIComponent(template.id)}`).catch(() => ({ threads:[] }))
        ]);
        applyInventory(inventory);
        const threads = array(threadList?.threads).slice().sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
        const latest = threads[0];
        if (latest?.id) {
          state.threadId = String(latest.id);
          try {
            const detail = await api(`${agentPath}/${encodeURIComponent(state.threadId)}`);
            state.messages = [welcomeMessage(), ...array(detail?.messages)];
          } catch (error) { /* keep the welcome bubble; thread will be recreated on demand */ state.threadId = ''; }
        }
      } catch (error) {
        setListStatus(`<div class="au-error">${((v0) => globalThis.PlatformLanguage?.text("settings","m_a5403c4290c6bd",`Could not load automations. ${v0}`,{v0}) ?? `Could not load automations. ${v0}`)(esc(error?.message || ''))}</div>`);
        toast((globalThis.PlatformLanguage?.text("settings","m_4d267c6ce90311","Load failed") ?? "Load failed"), error?.message || 'Could not load automations.', false);
        renderMessages();
        return;
      }
      renderList();
      renderMessages();
      renderChips();
    }

    function applyInventory(result){
      const template = object(result?.template);
      if (template.id) {
        state.template = {
          ...state.template,
          id:text(template.id, state.template.id),
          name:text(template.name, state.template.name),
          color:text(template.color, state.template.color),
          icon:text(template.icon, state.template.icon),
          description:text(template.description, state.template.description),
          version:template.version ?? state.template.version,
          kind:text(template.kind, state.template.kind),
          enabled:template.enabled !== undefined ? template.enabled !== false : state.template.enabled,
          status:text(template.status, state.template.status)
        };
      }
      state.entries = array(result?.entries).filter((entry) => entry?.customer_visible !== false);
      state.orgRules = array(result?.organization_rules).filter((rule) => rule?.customer_visible !== false);
      const referenceable = [...state.entries, ...state.orgRules];
      state.references = state.references.filter((key) => referenceable.some((entry) => entry.key === key));
      updateHeader();
    }

    function renderWorkspace(){
      rootEl.innerHTML = `<div class="au-workspace">
        <div class="au-left">
          <div class="au-left-head">
            ${String(embedded ? '' : '<button class="au-back" type="button" data-au-back title="All boards"><i class="fas fa-arrow-left"></i></button>')}
            <button class="au-tile" type="button" data-au-tile style="--au-tile:${String(esc(state.template.color))}" title="${(globalThis.PlatformLanguage?.text("settings","m_df7d95e0d9f7d3","Board icon") ?? "Board icon")}"><i class="fas ${String(esc(state.template.icon))}"></i></button>
            <div class="au-title-wrap"><span class="au-title" data-au-title title="${(globalThis.PlatformLanguage?.text("settings","m_2b10cfc47821fb","Click to rename") ?? "Click to rename")}">${String(esc(text(state.template.name, 'Untitled board')))}</span></div>
            <label class="au-swatch" data-au-swatch style="--au-tile:${String(esc(state.template.color))}" title="${(globalThis.PlatformLanguage?.text("settings","m_10eb04122d3284","Board color") ?? "Board color")}"><input type="color" data-au-color value="${String(esc(/^#[0-9a-fA-F]{6}$/.test(state.template.color) ? state.template.color : '#667085'))}"></label>
            <span class="au-manage" data-au-manage><button class="au-manage-btn" type="button" data-au-manage-btn aria-label="${(globalThis.PlatformLanguage?.text("settings","m_69ccb206476b9b","Manage board") ?? "Manage board")}" aria-expanded="false"><i class="fas fa-ellipsis-vertical"></i></button></span>
          </div>
          <button class="au-list-toggle" type="button" data-au-list-toggle><span data-au-list-count>${(globalThis.PlatformLanguage?.text("settings","m_e6e022972a7532","Automations") ?? "Automations")}</span><i class="fas fa-chevron-down"></i></button>
          <div class="au-list" data-au-list></div>
        </div>
        <div class="au-right">
          <div class="au-chat-head">
            <div class="au-chat-head-copy"><strong>${(globalThis.PlatformLanguage?.text("settings","m_0c1356b1264417","Automation assistant") ?? "Automation assistant")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_86e45f3db5835c","Describe what should happen automatically — I'll set it up.") ?? "Describe what should happen automatically — I'll set it up.")}</span></div>
            <button class="au-textbtn" type="button" data-au-newthread>${(globalThis.PlatformLanguage?.text("settings","m_84e4d3109d655d","New conversation") ?? "New conversation")}</button>
          </div>
          <div class="au-messages" data-au-messages></div>
          <div class="au-chips" data-au-chips></div>
          <div class="au-inputrow">
            <textarea class="au-input" data-au-input rows="1" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_db6df9a421ff5f","Tell me what you'd like to happen automatically…") ?? "Tell me what you'd like to happen automatically…")}"></textarea>
            <button class="au-send" type="button" data-au-send title="${(globalThis.PlatformLanguage?.text("settings","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
      </div>`;
      rootEl.querySelector('[data-au-back]')?.addEventListener('click', () => {
        root.Portal?.navigation?.backOrClose?.(['settingsEntity'], { settingsView:'boards', settingsEntity:null }, { source:'automation-board-close' });
        openPicker({ section:'boards' });
      });
      rootEl.querySelector('[data-au-manage-btn]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleCardMenu(event.currentTarget, state.template);
      });
      rootEl.querySelector('[data-au-list-toggle]').addEventListener('click', () => {
        state.mobileListOpen = !state.mobileListOpen;
        rootEl.querySelector('.au-left').classList.toggle('open', state.mobileListOpen);
      });
      rootEl.querySelector('[data-au-newthread]').addEventListener('click', startNewThread);
      bindHeaderEditors();
      bindComposer();
      fitWorkspace();
      renderList();
      renderMessages();
      renderChips();
    }

    function setListStatus(html){
      const list = rootEl.querySelector('[data-au-list]');
      if (list) list.innerHTML = html;
    }

    function updateHeader(){
      const tile = rootEl.querySelector('[data-au-tile]');
      if (tile) { tile.style.setProperty('--au-tile', state.template.color); tile.innerHTML = `<i class="fas ${esc(state.template.icon)}"></i>`; }
      const swatch = rootEl.querySelector('[data-au-swatch]');
      if (swatch) swatch.style.setProperty('--au-tile', state.template.color);
      const colorInput = rootEl.querySelector('[data-au-color]');
      if (colorInput && /^#[0-9a-fA-F]{6}$/.test(state.template.color)) colorInput.value = state.template.color;
      const title = rootEl.querySelector('[data-au-title]');
      if (title) title.textContent = text(state.template.name, 'Untitled board');
    }

    function bindHeaderEditors(){
      const titleWrap = rootEl.querySelector('.au-title-wrap');
      titleWrap.addEventListener('click', () => {
        const current = rootEl.querySelector('[data-au-title]');
        if (!current || state.view !== 'workspace') return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'au-title-input';
        input.value = text(state.template.name);
        const finish = (commit) => {
          const next = text(input.value);
          const span = document.createElement('span');
          span.className = 'au-title';
          span.dataset.auTitle = '';
          span.title = (globalThis.PlatformLanguage?.text("settings","m_2b10cfc47821fb","Click to rename") ?? "Click to rename");
          span.textContent = commit && next ? next : text(state.template.name, 'Untitled board');
          if (input.parentNode) input.replaceWith(span);
          if (commit && next && next !== state.template.name) saveHeader({ name:next });
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
          if (event.key === 'Escape') { input.value = state.template.name; input.blur(); }
        });
        input.addEventListener('blur', () => finish(true));
        current.replaceWith(input);
        input.focus();
        input.select();
      });
      const colorInput = rootEl.querySelector('[data-au-color]');
      colorInput.addEventListener('change', () => {
        const next = text(colorInput.value);
        if (next && next !== state.template.color) saveHeader({ color:next });
      });
      rootEl.querySelector('[data-au-tile]').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleIconPopover();
      });
    }

    // ---------------- icon picker popover ----------------
    const ICON_CHOICES = ['fa-house','fa-screwdriver-wrench','fa-water','fa-building','fa-clipboard-check','fa-truck','fa-hammer','fa-paint-roller','fa-leaf','fa-tree','fa-broom','fa-bolt','fa-fire','fa-snowflake','fa-sun','fa-droplet','fa-bug','fa-wrench','fa-table-cells','fa-solar-panel','fa-plug','fa-window-maximize','fa-door-open','fa-filter-circle-dollar'];

    function normalizeIcon(value){
      const cleaned = text(value).toLowerCase().replace(/^(fas|far|fab|fa-solid|fa-regular)\s+/, '').replace(/[^a-z0-9-]/g, '');
      if (!cleaned) return '';
      return cleaned.startsWith('fa-') ? cleaned : `fa-${cleaned}`;
    }

    function closeIconPopover(){
      rootEl.querySelector('[data-au-iconpop]')?.remove();
      document.removeEventListener('mousedown', onIconPopoverOutside, true);
      document.removeEventListener('keydown', onIconPopoverKey, true);
    }

    function onIconPopoverOutside(event){
      const pop = rootEl.querySelector('[data-au-iconpop]');
      if (!pop || pop.contains(event.target) || event.target?.closest?.('[data-au-tile]')) { if (!pop) closeIconPopover(); return; }
      closeIconPopover();
    }

    function onIconPopoverKey(event){
      if (event.key === 'Escape') closeIconPopover();
    }

    function commitIcon(raw){
      const next = normalizeIcon(raw);
      closeIconPopover();
      if (next && next !== state.template.icon) saveHeader({ icon:next });
    }

    function toggleIconPopover(){
      if (rootEl.querySelector('[data-au-iconpop]')) { closeIconPopover(); return; }
      const head = rootEl.querySelector('.au-left-head');
      if (!head || state.view !== 'workspace') return;
      const pop = document.createElement('div');
      pop.className = 'au-iconpop';
      pop.dataset.auIconpop = '';
      pop.innerHTML = `
        <div class="au-iconpop-grid">${String(ICON_CHOICES.map((icon) => `<button class="au-iconpop-btn ${icon === state.template.icon ? 'selected' : ''}" type="button" data-au-icon="${esc(icon)}" title="${esc(icon)}"><i class="fas ${esc(icon)}"></i></button>`).join(''))}</div>
        <div class="au-iconpop-row">
          <span class="au-iconpop-preview" data-au-icon-preview style="--au-tile:${String(esc(state.template.color))}"><i class="fas ${String(esc(state.template.icon))}"></i></span>
          <input class="au-iconpop-input" data-au-icon-input type="text" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_c9a98c9c5a5d5e","fa-icon-name") ?? "fa-icon-name")}" value="${String(esc(state.template.icon))}" spellcheck="false">
          <button class="au-iconpop-apply" type="button" data-au-icon-apply>${(globalThis.PlatformLanguage?.text("settings","m_fccaa3fc954540","Use") ?? "Use")}</button>
        </div>`;
      head.appendChild(pop);
      pop.querySelectorAll('[data-au-icon]').forEach((button) => button.addEventListener('click', () => commitIcon(button.dataset.auIcon)));
      const input = pop.querySelector('[data-au-icon-input]');
      const preview = pop.querySelector('[data-au-icon-preview]');
      input.addEventListener('input', () => {
        const icon = normalizeIcon(input.value);
        preview.innerHTML = `<i class="fas ${esc(icon || state.template.icon)}"></i>`;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commitIcon(input.value); }
      });
      pop.querySelector('[data-au-icon-apply]').addEventListener('click', () => commitIcon(input.value));
      document.addEventListener('mousedown', onIconPopoverOutside, true);
      document.addEventListener('keydown', onIconPopoverKey, true);
      input.focus();
      input.select();
    }

    // Quick header edits use the versioned PUT flow: read fresh, merge, save.
    async function saveHeader(patch){
      const previous = { ...state.template };
      state.template = { ...state.template, ...patch };
      updateHeader();
      try {
        const read = await api(`${templatesPath}/${encodeURIComponent(state.template.id)}`);
        const template = object(read?.template);
        const definition = object(template.definition);
        const body = {
          ...definition,
          id:state.template.id,
          name:text(patch.name, template.name, state.template.name),
          description:text(template.description, definition.description),
          details:text(template.details, definition.details),
          color:text(patch.color, template.color, state.template.color),
          icon:text(patch.icon, template.icon, state.template.icon),
          status:text(template.status, 'active'),
          sort_order:Number(template.sort_order ?? definition.sort_order ?? 0),
          expected_version:template.version
        };
        const saved = await api(`${templatesPath}/${encodeURIComponent(state.template.id)}`, { method:'PUT', body });
        const savedTemplate = object(saved?.template);
        state.template = {
          ...state.template,
          name:text(savedTemplate.name, state.template.name),
          color:text(savedTemplate.color, state.template.color),
          icon:text(savedTemplate.icon, state.template.icon),
          version:savedTemplate.version ?? state.template.version
        };
        updateHeader();
        window.dispatchEvent(new CustomEvent('fm:scope-templates:updated', { detail:{ template:savedTemplate } }));
        await refreshInventory();
      } catch (error) {
        state.template = previous;
        updateHeader();
        toast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"), error?.message || 'Could not update this board.', false);
      }
    }

    // ---------------- left column: automation list ----------------
    function renderList(){
      const list = rootEl.querySelector('[data-au-list]');
      const count = rootEl.querySelector('[data-au-list-count]');
      if (count) count.textContent = ((v0) => globalThis.PlatformLanguage?.text("settings","m_368b6f485452b2",`Automations (${v0})`,{v0}) ?? `Automations (${v0})`)(state.entries.length + state.orgRules.length);
      if (!list) return;
      if (!state.entries.length && !state.orgRules.length) {
        list.innerHTML = `<div class="au-list-empty">${(globalThis.PlatformLanguage?.text("settings","m_b4e18f4709bb92","No automations to show yet — ask below and I'll set them up.") ?? "No automations to show yet — ask below and I'll set them up.")}</div>`;
        return;
      }
      const entryCard = (entry, subtitle) => {
        const referenced = state.references.includes(entry.key);
        return `<button class="au-entry ${referenced ? 'referenced' : ''} ${entry.enabled === false ? 'disabled' : ''}" type="button" data-au-entry="${esc(entry.key)}">
          <span class="au-entry-text">${esc(text(entry.explainer, 'Automation'))}</span>
          <span class="au-entry-node">${esc(subtitle)}</span>
          <span class="au-entry-add"><i class="fas ${referenced ? 'fa-check' : 'fa-plus'}"></i></span>
        </button>`;
      };
      list.innerHTML = `<div class="au-list-note">${(globalThis.PlatformLanguage?.text("settings","m_8ebf6080278c9b","Click an automation to bring it into the conversation.") ?? "Click an automation to bring it into the conversation.")}</div>`
        + state.entries.map((entry) => entryCard(entry, text(entry.node_title, entry.node_id))).join('')
        + (state.orgRules.length
          ? `<div class="au-list-section">${(globalThis.PlatformLanguage?.text("settings","m_ddc2f8aa948cec","Across all boards") ?? "Across all boards")}</div>` + state.orgRules.map((rule) => entryCard(rule, 'Every board')).join('')
          : '');
      list.querySelectorAll('[data-au-entry]').forEach((button) => button.addEventListener('click', () => toggleReference(button.dataset.auEntry)));
    }

    function toggleReference(key){
      if (!key) return;
      if (state.references.includes(key)) state.references = state.references.filter((item) => item !== key);
      else state.references = [...state.references, key];
      renderList();
      renderChips();
    }

    async function refreshInventory(){
      try {
        const inventory = await api(`${templatesPath}/${encodeURIComponent(state.template.id)}/automation-inventory`);
        applyInventory(inventory);
        renderList();
        renderChips();
      } catch (error) { /* keep the stale list rather than blanking it */ }
    }

    // ---------------- right column: chat ----------------
    function messageHtml(message){
      const data = object(message?.data);
      const failed = text(data.status) === 'failed';
      const changes = array(data.changes).map((item) => text(item)).filter(Boolean);
      const reverted = array(data.reverted_templates).filter(Boolean);
      if (message.role === 'user') {
        return `<div class="au-msg user"><div class="au-bubble">${esc(message.content)}</div></div>`;
      }
      return `<div class="au-msg assistant">
        <div class="au-bubble ${failed ? 'failed' : ''}">${esc(message.content)}${failed && reverted.length ? `<div class="au-rollback"><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("settings","m_c63e6b7013bb4e"," Changes were rolled back.") ?? " Changes were rolled back.")}</div>` : ''}</div>
        ${changes.length ? `<div class="au-changes"><span><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.text("settings","m_82153cf924cbde"," What changed") ?? " What changed")}</span><ul>${String(changes.map((item) => `<li>${esc(item)}</li>`).join(''))}</ul></div>` : ''}
      </div>`;
    }

    function renderMessages(){
      const wrap = rootEl.querySelector('[data-au-messages]');
      if (!wrap) return;
      wrap.innerHTML = state.messages.map(messageHtml).join('')
        + (state.sending ? `<div class="au-msg assistant" data-au-pending><div class="au-bubble">${(globalThis.PlatformLanguage?.text("settings","m_3656f3ab22ece8","Working on it… ") ?? "Working on it… ")}<span class="au-dots"><i></i><i></i><i></i></span></div></div>` : '');
      wrap.scrollTop = wrap.scrollHeight;
    }

    function renderChips(){
      const wrap = rootEl.querySelector('[data-au-chips]');
      if (!wrap) return;
      wrap.innerHTML = state.references.map((key) => {
        const entry = state.entries.find((item) => item.key === key) || state.orgRules.find((item) => item.key === key);
        const label = text(entry?.explainer, key);
        const short = label.length > 40 ? `${label.slice(0, 40)}…` : label;
        return `<button class="au-chip" type="button" data-au-chip="${esc(key)}" title="${esc(label)}"><em>${esc(short)}</em><i class="fas fa-xmark"></i></button>`;
      }).join('');
      wrap.querySelectorAll('[data-au-chip]').forEach((button) => button.addEventListener('click', () => toggleReference(button.dataset.auChip)));
    }

    function setComposerBusy(busy){
      const input = rootEl.querySelector('[data-au-input]');
      const send = rootEl.querySelector('[data-au-send]');
      const fresh = rootEl.querySelector('[data-au-newthread]');
      if (input) input.disabled = busy;
      if (send) send.disabled = busy;
      if (fresh) fresh.disabled = busy;
    }

    function bindComposer(){
      const input = rootEl.querySelector('[data-au-input]');
      const send = rootEl.querySelector('[data-au-send]');
      const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 130)}px`; };
      input.addEventListener('input', autosize);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
      });
      send.addEventListener('click', sendMessage);
    }

    async function startNewThread(){
      if (state.sending) return;
      try {
        const created = await api(agentPath, { method:'POST', body:{ template_id:state.template.id, branch_id:branchId } });
        state.threadId = text(object(created?.thread).id);
        state.messages = [welcomeMessage()];
        state.references = [];
        renderMessages();
        renderList();
        renderChips();
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_4a1fb679b1221c","Could not start a conversation") ?? "Could not start a conversation"), error?.message || 'Please try again.', false);
      }
    }

    async function sendMessage(){
      const input = rootEl.querySelector('[data-au-input]');
      const value = text(input?.value);
      if (!value || state.sending || state.view !== 'workspace') return;
      state.sending = true;
      state.messages = [...state.messages, { role:'user', content:value, data:{} }];
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setComposerBusy(true);
      renderMessages();
      const references = [...state.references];
      try {
        if (!state.threadId) {
          const created = await api(agentPath, { method:'POST', body:{ template_id:state.template.id, branch_id:branchId } });
          state.threadId = text(object(created?.thread).id);
          if (!state.threadId) throw new Error('Could not start a conversation.');
        }
        // Turns run the AI synchronously and can take up to ~90 seconds.
        const result = await api(`${agentPath}/${encodeURIComponent(state.threadId)}/messages`, {
          method:'POST',
          body:{ message:value, references, branch_id:branchId },
          signal:(typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(AGENT_TIMEOUT_MS) : undefined
        });
        const assistant = object(result?.assistant_message);
        state.messages = [...state.messages, {
          role:'assistant',
          content:text(assistant.content, result?.status === 'failed' ? 'I could not complete that change.' : 'Done.'),
          data:{
            status:text(object(assistant.data).status, result?.status),
            changes:array(object(assistant.data).changes ?? result?.changes),
            reverted_templates:array(object(assistant.data).reverted_templates ?? result?.reverted_templates)
          }
        }];
        state.references = [];
        state.sending = false;
        renderMessages();
        renderChips();
        await refreshInventory();
        renderList();
      } catch (error) {
        state.sending = false;
        const timedOut = String(error?.name || '').includes('Timeout') || String(error?.message || '').toLowerCase().includes('abort');
        state.messages = [...state.messages, {
          role:'assistant',
          content:timedOut ? "That's taking longer than expected. Give it a moment, then start a new message — I'll pick up where we left off." : `Something went wrong: ${text(error?.message, 'please try again.')}`,
          data:{ status:'failed' }
        }];
        renderMessages();
        refreshInventory();
      } finally {
        state.sending = false;
        setComposerBusy(false);
        rootEl.querySelector('[data-au-input]')?.focus();
      }
    }

    async function restoreSurface(url = {}){
      if (text(url.tab) !== 'company_settings' || text(url.sub) !== routeSub) return;
      const view = text(url.settingsView);
      const templateId = text(url.settingsEntity).replace(/^scope:/, '');
      if (view === 'create-board') {
        if (state.view !== 'creator') openCreator();
        return;
      }
      if (view === 'board' && templateId) {
        if (state.view === 'workspace' && state.template?.id === templateId) return;
        rootEl.innerHTML = `<div class="au-loading"><span><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_a0a7dba8320cb6"," Loading board…") ?? " Loading board…")}</span></div>`;
        try {
          const result = await api(`${templatesPath}/${encodeURIComponent(templateId)}`);
          await openWorkspace(object(result?.template));
        } catch (error) {
          toast((globalThis.PlatformLanguage?.text("settings","m_732c98ca045167","Board unavailable") ?? "Board unavailable"), error?.message || 'This board could not be opened.', false);
          await openPicker({ section:'boards' });
        }
        return;
      }
      const section = view === 'trash' ? 'trash' : 'boards';
      if (state.view !== 'picker' || state.pickerSection !== section || !state.templates.length) await openPicker({ section });
    }

    if (embedded) {
      api(`${templatesPath}/${encodeURIComponent(embeddedTemplateId)}`)
        .then((result) => openWorkspace(object(result?.template)))
        .catch((error) => { rootEl.innerHTML = `<div class="au-error">${((v0) => globalThis.PlatformLanguage?.text("settings","m_22945e8644356b",`Could not load this scope's automations. ${v0}`,{v0}) ?? `Could not load this scope's automations. ${v0}`)(esc(error?.message || ''))}</div>`; });
    } else {
      root.Portal?.navigation?.registerHandler?.(`automation-assistant-boards-${orgId}-${branchId}`, {
        priority:1250,
        match:(url) => text(url.tab) === 'company_settings' && text(url.sub) === routeSub,
        apply:(url) => restoreSurface(url)
      });
      const initialRoute = root.Portal?.navigation?.read?.() || {};
      if (text(initialRoute.tab) === 'company_settings' && text(initialRoute.sub) === routeSub) restoreSurface(initialRoute);
      else openPicker({ section:'boards' });
    }
  }

  root.FirstMateAutomationsSettings = { mount };
})(window);
