/* public/libraries/guided-experiences/guided-setup.js
 * The setup players for guided experiences (docs/architecture/guided-experiences.md):
 *
 * - `modal`: the steps in a sheet in front of a dimmed page.
 * - `agentic`: the same sheet with the agent beside it. The widget for each step is on the left and rises into
 *   place as the steps change; the conversation is on the right. The agent's lines for the known steps are
 *   programmatic (the definition's `say`), written into the person's own project conversation. If the person types,
 *   the real assistant answers in that conversation knowing the step and the choices so far, then the scripted steps
 *   carry on. When it finishes, the sheet closes and the conversation flies to the right to become the project's
 *   agent tray, which holds the same conversation.
 *
 * Step widgets are registered by id (`registerWidget`) and are given the step's options (data from the server) and
 * the selections so far; they report a selection patch, whether it is complete, and a plain summary of it.
 */
(function(root){
  'use strict';
  const document = root.document;
  const G = () => root.FirstMateGuides;
  const clean = (value) => String(value ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const L = (copy, fallback) => G()?.L ? G().L(copy, fallback) : (copy?.text ?? fallback);
  /** Visible copy: escaped, and editable in place for a development editor (guided-experiences.js `copyHtml`). */
  const H = (copy, fallback) => G()?.copyHtml ? G().copyHtml(copy, fallback) : esc(L(copy, fallback));
  const reduced = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced() ? 0 : ms));
  const money = (value) => { try { return new Intl.NumberFormat(undefined, { style:'currency', currency:'USD' }).format(Number(value) || 0); } catch (_) { return '$' + (Number(value) || 0).toFixed(2); } };
  const widgets = new Map();

  const css = `
    .gxs,.gxs *,.gxs *::before,.gxs *::after{box-sizing:border-box}
    .gxs [hidden]{display:none!important}
    .gxs-settled .gxs-card,.gxs-settled .gxs-rule{animation:none}
    .gxs{position:fixed;inset:0;z-index:2147483250;display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828}
    .gxs-scrim{position:absolute;inset:0;background:rgba(16,24,40,.55);backdrop-filter:blur(3px);animation:gxsFade .35s ease both}
    .gxs-sheet{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 360px;width:min(1120px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));background:#fff;border-radius:20px;box-shadow:0 40px 100px rgba(16,24,40,.45);overflow:hidden;animation:gxsRise .5s cubic-bezier(.22,1,.36,1) both}
    .gxs[data-kind=modal] .gxs-sheet{grid-template-columns:minmax(0,1fr);width:min(820px,calc(100vw - 32px))}
    .gxs[data-kind=modal] .gxs-chat{display:none}
    @keyframes gxsFade{from{opacity:0}to{opacity:1}}
    @keyframes gxsRise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
    .gxs-widget{display:flex;flex-direction:column;min-width:0;min-height:0;background:linear-gradient(180deg,#fcfcfd,#fff 180px)}
    .gxs-head{display:flex;align-items:center;gap:12px;padding:16px 20px 8px}
    .gxs-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.08);border-radius:999px;padding:5px 11px;white-space:nowrap}
    .gxs-progress{display:flex;gap:6px;margin:0 auto 0 4px;padding:0;list-style:none;flex:1;max-width:320px}
    .gxs-progress li{flex:1;height:4px;border-radius:2px;background:#eaecf0;overflow:hidden}
    .gxs-progress li i{display:block;height:100%;width:0;background:var(--primary,#d93025);transition:width .5s cubic-bezier(.22,1,.36,1)}
    .gxs-progress li.done i,.gxs-progress li.on i{width:100%}
    .gxs-progress li.on i{opacity:.55}
    .gxs-icon{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:#667085;cursor:pointer;font-size:18px;display:inline-grid;place-items:center}
    .gxs-icon:hover{background:#f2f4f7;color:#101828}
    .gxs-stage{position:relative;flex:1;min-height:0;overflow:hidden}
    .gxs-step{position:absolute;inset:0;overflow:auto;padding:8px 28px 24px;transition:transform .55s cubic-bezier(.22,1,.36,1),opacity .4s ease}
    .gxs-step.gxs-below{transform:translateY(48px);opacity:0}
    .gxs-step.gxs-above{transform:translateY(-48px);opacity:0;pointer-events:none}
    .gxs-step h2{display:flex;align-items:center;gap:8px;margin:4px 0 12px;padding-right:44px;font-size:clamp(18px,2vw,22px);line-height:1.2;letter-spacing:-.02em;font-weight:780}
    .gxs-info{position:relative;flex:none;width:20px;height:20px;border-radius:50%;border:1px solid #d0d5dd;background:#fff;color:#667085;font:italic 700 11px/1 Georgia,serif;cursor:help;display:inline-grid;place-items:center;padding:0}
    .gxs-info-tip{position:absolute;left:50%;top:calc(100% + 8px);transform:translate(-50%,4px);width:max-content;max-width:min(320px,70vw);background:#101828;color:#fff;font:400 12.5px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:0;text-align:left;border-radius:9px;padding:8px 10px;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;z-index:10}
    .gxs-info:hover .gxs-info-tip,.gxs-info:focus-visible .gxs-info-tip{opacity:1;transform:translate(-50%,0)}
    .gxs-step>p.gxs-sub{margin:0 0 18px;color:#667085;max-width:60ch}
    .gxs-foot{display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid #f2f4f7;background:#fff}
    .gxs-foot .gxs-status{margin-right:auto;color:#667085;font-size:12.5px;min-height:18px}
    .gxs-foot .gxs-status.err{color:#b42318}
    .gxs-btn{height:40px;padding:0 16px;border-radius:11px;border:1px solid #d0d5dd;background:#fff;color:#344054;font:inherit;font-weight:650;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:transform .12s,background .15s,opacity .2s}
    .gxs-btn:hover{background:#f9fafb}.gxs-btn:active{transform:scale(.98)}
    .gxs-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff;box-shadow:0 6px 16px rgba(var(--primary-rgb,217,48,37),.25)}
    .gxs-btn.primary:hover{filter:brightness(1.05)}
    .gxs-btn.ghost{border-color:transparent;color:#667085}
    .gxs-btn:disabled{opacity:.45;cursor:default;transform:none}
    .gxs-btn:focus-visible,.gxs-icon:focus-visible,.gxs-card:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gxs-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:gxsSpin .7s linear infinite}
    @keyframes gxsSpin{to{transform:rotate(360deg)}}
    .gxs-ask{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:16px;border-radius:inherit}
    .gxs-ask-scrim{position:absolute;inset:0;background:rgba(16,24,40,.38);border-radius:inherit;animation:gxsAskFade .16s ease-out both}
    .gxs-ask-box{position:relative;width:min(380px,100%);background:#fff;border-radius:16px;padding:20px 20px 16px;box-shadow:0 24px 60px rgba(16,24,40,.28);animation:gxsAskIn .2s cubic-bezier(.22,1,.36,1) both}
    .gxs-ask-box h3{margin:0 0 6px;font-size:16px;font-weight:750;color:#101828}
    .gxs-ask-box p{margin:0 0 16px;font-size:13px;line-height:1.45;color:#475467}
    .gxs-ask-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
    .gxs-ask.gxs-ask-out .gxs-ask-scrim{animation:gxsAskFade .12s ease-in reverse both}
    .gxs-ask.gxs-ask-out .gxs-ask-box{animation:gxsAskIn .12s ease-in reverse both}
    @keyframes gxsAskFade{from{opacity:0}to{opacity:1}}
    @keyframes gxsAskIn{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}
    /* Chat */
    .gxs-chat{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;background:#fff;border-left:1px solid #eaecf0}
    .gxs-assistant{flex:1;min-height:0;display:flex;flex-direction:column}
    .gxs-assistant>.fma-drawer{flex:1;min-height:0}
    .gxs-chat .fma-head{padding-right:52px}
    .gxs-chat-handle{display:none}
    .gxs-close{position:absolute;top:10px;right:10px;z-index:5;width:36px;height:36px;border:0;border-radius:10px;background:rgba(255,255,255,.9);color:#475467;cursor:pointer;display:inline-grid;place-items:center;font-size:18px;transition:background .15s,color .15s}
    .gxs-close:hover{background:#f2f4f7;color:#101828}
    .gxs-close:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gxs-close .gxs-x{font-size:24px;line-height:1;font-weight:400}
    @keyframes gxsMsg{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    /* Widgets */
    .gxs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));grid-auto-rows:1fr;gap:14px}
    .gxs-grid .gxs-card{display:flex;flex-direction:column;align-items:stretch;min-height:150px}
    .gxs-logo{display:flex;align-items:center;height:64px;padding-right:28px}
    .gxs-logo img{display:block;max-width:100%;max-height:48px;width:auto;height:auto;object-fit:contain}
    .gxs-card .gxs-meta{margin-top:auto}
    .gxs-card{position:relative;text-align:left;border:1.5px solid #eaecf0;border-radius:16px;background:#fff;padding:18px;cursor:pointer;font:inherit;color:inherit;transition:border-color .2s,box-shadow .2s,transform .2s;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(16,24,40,.08)}
    .gxs-card[aria-pressed=true]{border-color:var(--brand,var(--primary,#d93025));box-shadow:0 0 0 3px color-mix(in srgb,var(--brand,#d93025) 18%,transparent)}
    .gxs-wordmark{display:flex;align-items:center;min-height:64px;font-weight:900;font-size:clamp(20px,2.2vw,27px);line-height:1.05;letter-spacing:-.03em;color:var(--brand,#101828);padding-right:26px}
    .gxs-card small{display:block;color:#667085;font-size:12.5px}
    .gxs-tick{position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;color:#fff;font-size:12px;transition:background .2s,border-color .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}
    .gxs-card[aria-pressed=true] .gxs-tick,.gxs-row[aria-checked=true] .gxs-tick{background:var(--brand,var(--primary,#d93025));border-color:var(--brand,var(--primary,#d93025));transform:scale(1.08)}
    .gxs-allbar{display:flex;align-items:center;gap:10px;margin:0 0 14px}
    .gxs-chip{height:30px;padding:0 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;font:inherit;font-size:12.5px;font-weight:650;color:#344054;cursor:pointer}
    .gxs-chip[aria-pressed=true]{background:#101828;border-color:#101828;color:#fff}
    .gxs-brand{margin:0 0 18px}
    .gxs-brand h3{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:15px}
    .gxs-brand h3 b{color:var(--brand);font-weight:900;letter-spacing:-.02em}
    .gxs-brand h3 .gxs-chip{margin-left:auto}
    .gxs-row{position:relative;display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1.5px solid #eaecf0;border-radius:12px;background:#fff;padding:10px 44px 10px 12px;margin:0 0 8px;font:inherit;color:inherit;cursor:pointer;transition:border-color .2s,background .2s}
    .gxs-row[aria-checked=true]{border-color:var(--brand,var(--primary,#d93025));background:color-mix(in srgb,var(--brand,#d93025) 4%,#fff)}
    .gxs-row .gxs-tick{top:50%;margin-top:-12px}
    .gxs-row strong{font-weight:650}.gxs-row em{font-style:normal;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#667085;background:#f2f4f7;border-radius:6px;padding:2px 6px}
    .gxs-row .gxs-price{margin-left:auto;color:#475467;font-variant-numeric:tabular-nums}
    .gxs-star{border:0;background:transparent;color:#d0d5dd;font-size:16px;cursor:pointer;padding:2px}
    .gxs-star[aria-pressed=true]{color:#f59e0b}
    .gxs-rule{border:1px solid #eaecf0;border-radius:14px;background:#fff;margin:0 0 10px;overflow:hidden;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-rule>button{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;padding:14px 16px;font:inherit;text-align:left;cursor:pointer;color:inherit}
    .gxs-rule>button strong{flex:1}
    .gxs-rule .gxs-qty{font-variant-numeric:tabular-nums;font-weight:700;color:#101828}
    .gxs-rule .gxs-caret{transition:transform .3s;color:#98a2b3}
    .gxs-rule[open-rule=true] .gxs-caret{transform:rotate(90deg)}
    .gxs-rule-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s cubic-bezier(.22,1,.36,1)}
    .gxs-rule[open-rule=true] .gxs-rule-body{grid-template-rows:1fr}
    .gxs-rule-body>div{overflow:hidden;padding:0 16px}
    .gxs-rule[open-rule=true] .gxs-rule-body>div{padding:0 16px 16px}
    .gxs-eq{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0}
    .gxs-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#eef4ff;color:#3538cd;font-size:12.5px;font-weight:650}
    .gxs-pill b{font-variant-numeric:tabular-nums;color:#101828}
    .gxs-op{color:#98a2b3;font-weight:700}
    .gxs-seg{display:inline-flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .gxs-manual{font-size:11px;font-weight:700;color:#b54708;background:#fffaeb;border-radius:6px;padding:2px 7px}
    .gxs-table{width:100%;border-collapse:collapse;font-size:13px}
    .gxs-table th{text-align:left;color:#667085;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:14px 6px 6px}
    .gxs-table td{padding:7px 6px;border-top:1px solid #f2f4f7}
    .gxs-table td:last-child{text-align:right}
    .gxs-table input{width:96px;height:32px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;text-align:right;font:inherit;font-variant-numeric:tabular-nums}
    .gxs-table input:focus{outline:none;border-color:var(--primary,#d93025)}
    .gxs-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
    .gxs-inline input[type=number]{width:72px;height:32px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;font:inherit}
    .gxs-done{display:grid;place-items:center;text-align:center;padding:40px 10px;gap:10px}
    .gxs-done svg{width:84px;height:84px}
    .gxs-done circle{stroke:var(--primary,#d93025);stroke-width:4;fill:none;stroke-dasharray:240;stroke-dashoffset:240;animation:gxsDraw .7s ease forwards}
    .gxs-done path{stroke:var(--primary,#d93025);stroke-width:5;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:gxsDraw .45s .55s ease forwards}
    @keyframes gxsDraw{to{stroke-dashoffset:0}}
    .gxs-flying{position:fixed!important;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(16,24,40,.35);display:flex;flex-direction:column}
    .gxs.gxs-leaving .gxs-scrim{opacity:0;transition:opacity .45s}
    .gxs.gxs-leaving .gxs-widget{opacity:0;transform:translateX(-30px);transition:opacity .35s,transform .45s}
    .gxs.gxs-leaving[data-kind=modal] .gxs-sheet{opacity:0;transform:scale(.97);transition:opacity .3s,transform .3s}
    @media(max-width:760px){
      .gxs-sheet{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;width:100vw;height:100dvh;border-radius:0}
      .gxs-chat{border-left:0;border-top:1px solid #eaecf0;max-height:48px;overflow:hidden;transition:max-height .35s cubic-bezier(.22,1,.36,1)}
      .gxs-chat[data-open=true]{max-height:58dvh}
      .gxs-chat-handle{display:flex;align-items:center;gap:8px;flex:none;height:48px;padding:0 16px;border:0;background:#fff;font:inherit;font-weight:700;color:#101828;cursor:pointer;text-align:left}
      .gxs-chat-handle .gxs-chevron{margin-left:auto;transition:transform .3s}
      .gxs-chat[data-open=true] .gxs-chat-handle .gxs-chevron{transform:rotate(180deg)}
      .gxs-close{top:6px;right:6px}
      .gxs-step{padding:6px 16px 20px}
      .gxs-head{padding:12px 12px 6px}
      .gxs-badge span{display:none}
      .gxs-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .gxs-card{padding:12px}.gxs-grid .gxs-card{min-height:124px}.gxs-wordmark{min-height:46px;font-size:19px}.gxs-logo{height:48px}.gxs-logo img{max-height:36px}
      .gxs-foot{padding:10px 12px}
    }
    @media(prefers-reduced-motion:reduce){.gxs *,.gxs{animation:none!important;transition:none!important}}
  `;

  function injectCss(){ G()?.injectCss ? G().injectCss('gx-setup-css', css) : null; }

  // ── The player ─────────────────────────────────────────────────────────
  function player(kind){
    return (ctx) => new Promise((resolve) => {
      injectCss();
      const { experience, track } = ctx;
      const here = ctx.where();
      const steps = array(experience.steps);
      const orgId = clean(root.__APP?.userOrgId);
      // The agent is the platform assistant itself, in the person's own project conversation (the one the tray shows).
      let agentic = kind === 'agentic' && !!here.projectId && !!orgId && !!root.AssistantAPI && typeof root.PlatformAssistant?.mountProject === 'function';
      const selections = { ...object(experience.progress?.data) };
      const summaries = {};
      let index = Math.max(0, steps.findIndex((step) => step.id === experience.progress?.step_id));
      if (index >= steps.length) index = 0;
      let mounted = null, busy = false, closed = false, assistant = null;

      const host = document.createElement('div');
      host.className = 'gxs'; host.dataset.kind = agentic ? 'agentic' : 'modal'; host.setAttribute('data-fmr-ignore', ''); host.setAttribute('data-gx-setup', experience.id);
      host.innerHTML = `<div class="gxs-scrim"></div>
        <section class="gxs-sheet" role="dialog" aria-modal="true" aria-label="${esc(L(experience.title))}">
          <button type="button" class="gxs-close" data-gxs="close" aria-label="${esc(L('gx_ui_close_setup', 'Close setup'))}" title="${esc(L('gx_ui_close_setup', 'Close setup'))}"><span class="gxs-x" aria-hidden="true">&times;</span></button>
          <div class="gxs-widget">
            <header class="gxs-head"><span class="gxs-badge"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>${H(experience.title)}</span></span>
              <ol class="gxs-progress" aria-hidden="true">${steps.map(() => '<li><i></i></li>').join('')}</ol></header>
            <div class="gxs-stage"></div>
            <footer class="gxs-foot"><span class="gxs-status" role="status"></span>
              <button type="button" class="gxs-btn ghost" data-gxs="back">${H('gx_ui_back', 'Back')}</button>
              <button type="button" class="gxs-btn ghost" data-gxs="skip">${H('gx_ui_skip_step', 'Skip step')}</button>
              <button type="button" class="gxs-btn primary" data-gxs="next"></button></footer>
          </div>
          <aside class="gxs-chat" aria-label="${esc(L('gx_ui_agent', 'Agent'))}">
            <button type="button" class="gxs-chat-handle" data-gxs="toggleChat" aria-expanded="false"><i class="fas fa-sparkles" aria-hidden="true"></i>${H('gx_ui_agent', 'Agent')}<i class="fas fa-chevron-up gxs-chevron" aria-hidden="true"></i></button>
            <div class="gxs-assistant"></div>
          </aside>
        </section>`;
      document.body.appendChild(host);
      const $ = (selector) => host.querySelector(selector);
      const stage = $('.gxs-stage'), status = $('.gxs-status'), chat = $('.gxs-chat');
      const previousFocus = document.activeElement;

      // The agent: a platform assistant instance running this setup as a preprogrammed workflow.
      if (agentic) {
        try {
          assistant = root.PlatformAssistant.mountProject($('.gxs-assistant'), {
            orgId, projectId: here.projectId,
            getContext: () => ({ surface: 'project', projectId: here.projectId, tab: here.tab, tray: 'guided_setup' }),
            workflow: {
              // Typing hands this turn to the real assistant, which is told the step and choices (guidedConversationContext).
              onUserMessage: (text) => { track('question', { step_id: steps[index]?.id, properties: { length: String(text).length } }); return false; },
              onReply: () => { if (!closed) say([L('gx_ui_back_to_step', 'Whenever you’re ready, carry on with the step on the left.')], '', ''); },
              onChoice: (id) => { if (id === 'continue' && !closed) next(false); },
              // A price sheet changes the price book: what is chosen so far is saved first, so the agent has items to price.
              onUpload: async (files) => { track('question', { step_id: steps[index]?.id, properties: { upload: true, files: files.length } }); await saveDraft(); }
            }
          });
        } catch (error) {
          console.warn('The setup could not open the assistant; it continues without it.', error);
          agentic = false; host.dataset.kind = 'modal'; assistant = null;
        }
      }
      /** The agent's scripted lines, shown in the assistant as it would type them. */
      /** `at` is the step (or 'done') whose lines these are: their keys match the ones the server stores. */
      function say(lines, choice, at){
        if (!assistant || closed) return Promise.resolve();
        if (choice) assistant.post({ role: 'user', content: choice, data: { source: 'guided_experience' } });
        const keys = at === 'done' ? array(experience.completion?.say) : array(steps.find((entry) => entry.id === at)?.say);
        // A step can offer an upload inside one of its lines; the file goes to the real assistant (platform-assistant `upload`).
        const upload = at && at !== 'done' ? steps.find((entry) => entry.id === at)?.upload : null;
        return assistant.say(lines.map((content, i) => ({ content, data: { source: 'guided_experience', ...(at ? { line_key: `${experience.id}:${at}:say:${i}` } : {}), ...(keys[i]?.key ? { copy_key: keys[i].key } : {}),
          ...(upload && keys[i]?.key === upload.line ? { upload: { label: L(upload.button), message: L(upload.message), accept: clean(upload.accept) } } : {}) } })));
      }
      /**
       * Saves what is chosen so far through the completion action (the same writer the finish uses), so an agent asked
       * to read a price sheet mid-setup finds the price book items and suppliers. The finish writes again and keeps
       * prices the agent set (pricebook price_source "price_sheet", saved supplier prices).
       */
      async function saveDraft(){
        const action = experience.completion?.action;
        if (!action?.id || !orgId || !root.PlatformAPI?.publication?.invoke) return null;
        try {
          const result = await root.PlatformAPI.publication.invoke(orgId, action.id, { scope: 'organization', organizationId: orgId }, { ...object(action.input), ...selections }, { idempotencyKey: `${experience.id}:draft:${Date.now()}:${Math.random().toString(36).slice(2)}` });
          return object(result?.value ?? result);
        } catch (error) { console.warn('The setup could not save its draft before the price sheet.', error); return null; }
      }
      /** A supplier's price sheet: saved first so it has an id, then the file goes to the agent with the supplier named. */
      function supplierPriceSheet(supplier){
        if (!assistant || !root.FirstMateSupplierColumns?.priceSheet) return null;
        chat.dataset.open = 'true';
        track('question', { step_id: steps[index]?.id, properties: { upload: true, supplier: clean(supplier?.name) } });
        return root.FirstMateSupplierColumns.priceSheet({ supplier, assistant, before: async () => {
          const saved = array((await saveDraft())?.suppliers).find((entry) => clean(entry.name).toLowerCase() === clean(supplier?.name).toLowerCase());
          return saved ? { id: saved.id, name: saved.name } : supplier;
        } });
      }
      /** The scripted turn, written into the project conversation so a reload and the agent tray hold it too. */
      function persist(body){
        if (!agentic) return Promise.resolve();
        return ctx.api.conversation(experience.id, { project_id: here.projectId, tab: here.tab, ...body }).catch((error) => console.warn('Setup conversation not saved.', error));
      }
      $('[data-gxs=toggleChat]').addEventListener('click', () => { const open = chat.dataset.open !== 'true'; chat.dataset.open = String(open); $('[data-gxs=toggleChat]').setAttribute('aria-expanded', String(open)); });

      // Steps
      function progress(){ host.querySelectorAll('.gxs-progress li').forEach((li, i) => { li.classList.toggle('done', i < index); li.classList.toggle('on', i === index); }); }
      function footer(){
        const step = steps[index];
        const last = index === steps.length - 1;
        $('[data-gxs=back]').hidden = index === 0;
        // An optional last page (labor prices) can be skipped too; skipping it finishes without its part.
        $('[data-gxs=skip]').hidden = step.required !== false || (last && !Object.keys(object(step.options?.skip_sets)).length);
        const next = $('[data-gxs=next]');
        next.innerHTML = busy ? `<span class="gxs-spin" aria-hidden="true"></span>${H('gx_ui_building', 'Building…')}` : (last ? H('gx_ui_finish', 'Build my price book') : H('gx_ui_continue', 'Continue'));
        next.disabled = busy || (step.required !== false && mounted?.valid?.() === false);
      }
      /**
       * One owner for step changes: each change takes a new generation, removes every pane but the one on screen at
       * once, and its animation callbacks do nothing once a newer change has started. Fast clicks never stack panes.
       */
      let paneGeneration = 0, currentPane = null;
      function show(to, direction = 1){
        const step = steps[to];
        const generation = ++paneGeneration;
        stage.querySelectorAll('.gxs-step').forEach((pane) => { if (pane !== currentPane) pane.remove(); });
        const old = currentPane && currentPane.isConnected ? currentPane : null;
        mounted?.destroy?.();
        const el = document.createElement('div');
        el.className = 'gxs-step' + (old && !reduced() ? (direction > 0 ? ' gxs-below' : ' gxs-above') : ''); el.dataset.gxStep = step.id;
        // A compact header: the title, and its explanation in a tooltip (shown as text for a copy editor).
        const editingCopy = !!G()?.isDevEditor?.();
        el.innerHTML = `<h2>${H(step.title)}${step.subtitle && !editingCopy ? ` <button type="button" class="gxs-info" data-gxs-info aria-label="${esc(L(step.subtitle))}"><span aria-hidden="true">i</span><span class="gxs-info-tip" role="tooltip">${esc(L(step.subtitle))}</span></button>` : ''}</h2>${step.subtitle && editingCopy ? `<p class="gxs-sub">${H(step.subtitle)}</p>` : ''}<div class="gxs-body"></div>`;
        stage.appendChild(el);
        currentPane = el;
        index = to;
        const widget = widgets.get(step.widget);
        mounted = widget ? widget.render(el.querySelector('.gxs-body'), { step, options: object(step.options), selections, L, esc, money, priceSheet: assistant ? supplierPriceSheet : null, change(patch, summary){ Object.assign(selections, patch); if (summary !== undefined) summaries[step.id] = summary; status.textContent = ''; footer(); } }) : null;
        if (!widget) el.querySelector('.gxs-body').textContent = L('gx_ui_widget_missing', 'This step cannot be shown here.');
        if (old) {
          old.classList.remove('gxs-below', 'gxs-above');
          old.classList.add(direction > 0 ? 'gxs-above' : 'gxs-below');
          old.setAttribute('aria-hidden', 'true'); old.inert = true;
          if (reduced()) old.remove();
          else {
            requestAnimationFrame(() => requestAnimationFrame(() => { if (generation === paneGeneration) el.classList.remove('gxs-below', 'gxs-above'); }));
            setTimeout(() => { if (old !== currentPane) old.remove(); }, 560);
          }
        }
        progress(); footer();
        setTimeout(() => { if (generation === paneGeneration) el.querySelector('button,input')?.focus?.({ preventScroll: true }); }, reduced() ? 0 : 450);
        track('step_view', { step_id: step.id, selections });
      }
      async function enter(to, direction, choice){
        show(to, direction);
        if (direction > 0) {
          const lines = array(steps[to].say).map((copy) => L(copy));
          persist({ step_id: steps[to].id, choice: choice || '' });
          if (lines.length || choice) say(lines, choice, steps[to].id);
        }
      }
      /**
       * Moves on at once; the event goes to the server in the background. Only a step whose next step depends on the
       * choices (branches, decided on the server) waits for the answer. A burst of presses counts once.
       */
      let movingUntil = 0;
      // Working in the step between two presses makes the second one deliberate.
      ['input', 'change', 'pointerdown'].forEach((name) => stage.addEventListener(name, () => { movingUntil = 0; }, true));
      async function next(skip = false){
        if (busy || closed || Date.now() < movingUntil) return;
        // A second press within a moment of the first is the same press: a burst never skips a step.
        movingUntil = Date.now() + 250;
        const step = steps[index];
        if (!skip && step.required !== false && mounted?.valid?.() === false) return;
        const choice = skip ? '' : clean(summaries[step.id] || mounted?.summary?.() || '');
        // An optional step skipped leaves its part out (the labor prices page: no labor lines).
        if (skip) Object.assign(selections, object(step.options?.skip_sets));
        const sent = track(skip ? 'step_skip' : 'step_done', { step_id: step.id, selections });
        if (index === steps.length - 1) return finish(choice);
        let to = index + 1;
        if (step.next && typeof step.next === 'object') {
          busy = true; footer();
          const target = clean((await sent)?.next_step);
          busy = false;
          const found = steps.findIndex((entry) => entry.id === target);
          if (found > index) to = found;
        }
        if (!closed) enter(to, 1, choice);
      }
      async function finish(choice){
        busy = true; footer(); status.textContent = ''; status.classList.remove('err');
        try {
          const result = await ctx.api.complete(experience.id, { selections, tab: here.tab, project_id: here.projectId, idempotency_key: `${experience.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
          const value = object(result.result);
          stage.querySelectorAll('.gxs-step').forEach((el) => el.remove());
          mounted?.destroy?.(); mounted = null;
          const done = document.createElement('div'); done.className = 'gxs-step';
          done.innerHTML = `<div class="gxs-done"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="38"/><path d="M26 43l11 11 21-23"/></svg><h2>${H('gx_ui_done_title', 'Your price book is ready')}</h2><p class="gxs-sub">${esc(value.items ? L('gx_ui_done_items', 'Products added') + ': ' + value.items : '')}</p></div>`;
          stage.appendChild(done);
          host.querySelectorAll('.gxs-progress li').forEach((li) => { li.classList.add('done'); li.classList.remove('on'); });
          $('.gxs-foot').style.visibility = 'hidden';
          const lines = array(experience.completion?.say).map((copy) => L(copy));
          persist({ phase: 'done', choice: choice || '' });
          await say(lines, choice, 'done');
          await wait(900);
          const handoff = agentic && array(experience.completion?.then).some((entry) => entry.handoff === 'assistant_tray');
          await close(handoff ? 'handoff' : 'plain');
          resolve({ status: 'completed', result: value });
        } catch (error) {
          busy = false; footer();
          status.classList.add('err');
          status.textContent = clean(error?.message) || L('gx_ui_finish_failed', 'That didn’t save. Try again.');
        }
      }
      /**
       * The X asks in a small dialog over the setup (inside the sheet, where the person is looking): Keep going is
       * focused; Escape and a click on the dim choose it.
       */
      function confirmSkip(){
        if (busy || closed || host.querySelector('.gxs-ask')) return;
        const ask = document.createElement('div'); ask.className = 'gxs-ask';
        ask.innerHTML = `<div class="gxs-ask-scrim" data-gxs="keep"></div><div class="gxs-ask-box" role="alertdialog" aria-modal="true" aria-labelledby="gxs-ask-title" aria-describedby="gxs-ask-text">
          <h3 id="gxs-ask-title">${H('gx_ui_skip_dialog_title', 'Skip setup for now?')}</h3>
          <p id="gxs-ask-text">${H('gx_ui_skip_dialog_text', 'Materials will use typical products. You can set up your price book any time in Materials settings.')}</p>
          <div class="gxs-ask-actions"><button type="button" class="gxs-btn" data-gxs="keep">${H('gx_ui_keep_going', 'Keep going')}</button><button type="button" class="gxs-btn primary" data-gxs="dismiss">${H('gx_ui_skip_setup', 'Skip setup')}</button></div></div>`;
        $('.gxs-sheet').appendChild(ask);
        $('.gxs-widget').inert = true; chat.inert = true;
        ask.querySelector('.gxs-ask-box [data-gxs=keep]').focus();
        // Tab stays between the two buttons.
        ask.addEventListener('keydown', (event) => {
          if (event.key !== 'Tab') return;
          const buttons = [...ask.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
          event.preventDefault();
          buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
        });
      }
      function keepGoing(){
        const ask = host.querySelector('.gxs-ask'); if (!ask || ask.classList.contains('gxs-ask-out')) return;
        $('.gxs-widget').inert = false; chat.inert = false;
        const done = () => { ask.remove(); (stage.querySelector('.gxs-step:not(.gxs-above) button, .gxs-step:not(.gxs-above) input') || $('[data-gxs=next]'))?.focus?.({ preventScroll: true }); };
        if (reduced()) return done();
        ask.classList.add('gxs-ask-out');
        setTimeout(done, 120);
      }
      host.addEventListener('click', (event) => {
        const action = event.target.closest?.('[data-gxs]')?.dataset.gxs;
        if (action === 'next') next(false);
        else if (action === 'skip') next(true);
        else if (action === 'back' && index > 0) { track('back', { step_id: steps[index].id }); show(index - 1, -1); }
        else if (action === 'close') confirmSkip();
        else if (action === 'keep') keepGoing();
        else if (action === 'dismiss' && !host.dataset.dismissing) { host.dataset.dismissing = 'true'; (async () => { await track('dismiss', { step_id: steps[index]?.id, selections }); await close('plain'); resolve({ status: 'dismissed' }); })(); }
      });
      const onKey = (event) => { if (event.key === 'Escape' && !closed) { event.preventDefault(); event.stopPropagation(); if (host.querySelector('.gxs-ask')) keepGoing(); else confirmSkip(); } };
      document.addEventListener('keydown', onKey, true);

      /** Closes the sheet. `handoff` flies the conversation to the project's agent tray, which opens with it. */
      async function close(mode){
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        mounted?.destroy?.();
        if (mode === 'handoff') await flyToTray();
        else if (!reduced()) { host.classList.add('gxs-leaving'); await wait(320); }
        // The tray has its own instance on the same conversation; this one goes with the sheet.
        try { assistant?.destroy?.(); } catch (_) {}
        assistant = null;
        host.remove();
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
      }
      /**
       * The hand-off, one choreographed transition on a single timeline (one duration, one easing, started on the same
       * frame): the sheet shrinks onto the agent and fades, the backdrop fades, the agent card moves and resizes into
       * the tray's place, and the project window opens the tray's space with the same duration and easing. The card
       * is laid out once at its final size and then only transformed and clipped (no layout per frame); the real tray,
       * on the same conversation, is underneath when the card fades out at identical bounds.
       */
      async function flyToTray(){
        const D = 520, EASE = 'cubic-bezier(.65,0,.35,1)';
        const sheet = $('.gxs-sheet'), scrim = $('.gxs-scrim');
        const from = chat.getBoundingClientRect(), box = sheet.getBoundingClientRect();
        const content = document.querySelector('#rOverlay .fm-project-content') || document.querySelector('.fm-project-content');
        const area = content?.getBoundingClientRect();
        const width = area ? Math.min(380, root.innerWidth <= 700 ? area.width : area.width * 0.45) : Math.min(380, root.innerWidth);
        const to = area ? { left: area.right - width, top: area.top, width, height: area.height } : { left: root.innerWidth - width, top: 0, width, height: root.innerHeight };
        const tab = document.querySelector('#rOverlay .fm-project-tray-tabs [data-tray="agent"]') || document.querySelector('.fm-project-tray-tabs [data-tray="agent"]');
        const openTray = () => { if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click(); };
        host.dataset.handoff = 'true';
        if (reduced() || typeof chat.animate !== 'function') { openTray(); return; }
        const timing = `${D}ms ${EASE}`;
        const tray = content?.querySelector(':scope > .fm-project-tray');
        const restore = [[content, content?.style.transition], [tray, tray?.style.transition]];
        // The card: the agent column at its final size, placed and clipped to where it is now.
        const W = Math.max(from.width, to.width), Hh = Math.max(from.height, to.height);
        document.body.appendChild(chat);
        chat.classList.add('gxs-flying');
        Object.assign(chat.style, { position: 'fixed', left: `${to.left}px`, top: `${to.top}px`, width: `${W}px`, height: `${Hh}px`, maxHeight: 'none', margin: '0', zIndex: '2147483260', transformOrigin: '0 0', willChange: 'transform, clip-path', borderRadius: '0', transition: 'none' });
        const clip = (rect) => `inset(0px ${W - rect.width}px ${Hh - rect.height}px 0px round ${rect === from ? 20 : 0}px)`;
        // Placed where it is now before the first frame paints, so nothing jumps while the timeline starts.
        chat.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
        chat.style.clipPath = clip(from);
        const frames = await new Promise((resolve) => requestAnimationFrame(() => {
          // Everything starts on this frame.
          if (content) content.style.transition = `grid-template-columns ${timing}`;
          if (tray) tray.style.transition = `opacity ${timing}, transform ${timing}`;
          openTray();
          const options = { duration: D, easing: EASE, fill: 'forwards' };
          resolve([
            chat.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, clipPath: clip(from) }, { transform: 'translate(0px, 0px)', clipPath: clip(to) }], options),
            sheet.animate([{ clipPath: 'inset(0px round 20px)', opacity: 1 }, { clipPath: `inset(${from.top - box.top}px ${box.right - from.right}px ${box.bottom - from.bottom}px ${from.left - box.left}px round 20px)`, opacity: 0 }], options),
            scrim.animate([{ opacity: getComputedStyle(scrim).opacity }, { opacity: 0 }], options)
          ]);
        }));
        await Promise.all(frames.map((animation) => animation.finished.catch(() => null)));
        // The real tray is underneath at the same bounds: wait until it shows the conversation, then fade the card.
        const started = Date.now();
        while (Date.now() - started < 1500) {
          const drawer = tray?.querySelector('.fma-drawer');
          if (!tray || (drawer && drawer.getBoundingClientRect().width > 0 && drawer.querySelector('.fma-msg'))) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await chat.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' }).finished.catch(() => null);
        chat.remove();
        restore.forEach(([node, value]) => { if (node) node.style.transition = value || ''; });
      }

      enter(index, 1, '');
      // The very first time, the scripted greeting already ran in enter(); a resumed setup says where it left off.
    });
  }

  // ── Widgets ────────────────────────────────────────────────────────────
  function registerWidget(id, widget){ widgets.set(id, widget); }
  const widgetCss = `
    .gxs-logos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
    .gxs-logo-tile{position:relative;display:grid;place-items:center;height:96px;padding:14px 18px;border:0;border-radius:14px;background:#f9fafb;cursor:pointer;transition:background .2s,box-shadow .25s,transform .2s;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-logo-tile:hover{background:#f2f4f7;transform:translateY(-1px)}
    .gxs-logo-tile img{display:block;max-width:100%;max-height:56px;width:auto;height:auto;object-fit:contain;transition:transform .25s cubic-bezier(.34,1.56,.64,1),filter .2s}
    .gxs-logo-tile .gxs-wordmark{min-height:0;padding:0;font-size:22px;justify-content:center;text-align:center}
    .gxs-logo-tile[aria-pressed=true]{background:color-mix(in srgb,var(--brand,#d93025) 7%,#fff);box-shadow:0 0 0 2px var(--brand,#d93025)}
    .gxs-logo-tile[aria-pressed=true] img{transform:scale(1.04)}
    .gxs-logo-tile[aria-pressed=false] img{filter:saturate(.85)}
    .gxs-badge-check{position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:var(--brand,#d93025);color:#fff;display:grid;place-items:center;font-size:12px;line-height:1;transform:scale(0);opacity:0;transition:transform .3s cubic-bezier(.34,1.56,.64,1),opacity .2s}
    .gxs-logo-tile[aria-pressed=true] .gxs-badge-check{transform:scale(1);opacity:1}
    .gxs-tools{display:flex;align-items:center;gap:8px;margin:0 0 10px;flex-wrap:wrap}
    .gxs-search{flex:1 1 200px;min-width:0;height:34px;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px;font:inherit}
    .gxs-search:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
    .gxs-cols{columns:2 280px;column-gap:18px}
    .gxs-cols>section{break-inside:avoid;margin:0 0 12px}
    .gxs-cols h3{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:13px}
    .gxs-cols h3 b{color:var(--brand);font-weight:900}
    .gxs-cols h3 .gxs-chip{margin-left:auto;height:24px;padding:0 9px;font-size:11.5px}
    .gxs-line{position:relative;display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid #eaecf0;border-radius:10px;background:#fff;padding:6px 34px 6px 8px;margin:0 0 5px;font:inherit;font-size:13px;color:inherit;cursor:pointer;transition:border-color .2s,background .2s}
    .gxs-line[aria-checked=true]{border-color:var(--brand,var(--primary,#d93025));background:color-mix(in srgb,var(--brand,#d93025) 5%,#fff)}
    .gxs-line .gxs-tick{top:50%;margin-top:-11px;right:8px;width:22px;height:22px}
    .gxs-line[aria-checked=true] .gxs-tick{background:var(--brand,var(--primary,#d93025));border-color:var(--brand,var(--primary,#d93025))}
    .gxs-line strong{font-weight:650;flex:1;min-width:0}
    .gxs-line em{font-style:normal;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#667085}
    .gxs-more{border:0;background:transparent;color:var(--primary,#d93025);font:inherit;font-size:12px;font-weight:650;cursor:pointer;padding:2px 2px 6px}
    .gxs-mats{display:flex;flex-direction:column;gap:6px}
    .gxs-mat{border:1px solid #eaecf0;border-radius:12px;background:#fff;overflow:visible}
    .gxs-mat>button{position:relative;display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;padding:10px 12px;font:inherit;text-align:left;cursor:pointer;color:inherit;border-radius:12px}
    .gxs-mat>button:hover{background:#f9fafb}
    .gxs-mat>button strong{flex:1;min-width:0;font-weight:650}
    .gxs-source{font-size:11px;font-weight:700;border-radius:999px;padding:3px 9px;white-space:nowrap}
    .gxs-source[data-source=report]{background:#ecfdf3;color:#067647}
    .gxs-source[data-source=hand]{background:#fffaeb;color:#b54708}
    .gxs-mat .gxs-caret{color:#98a2b3;transition:transform .3s}
    .gxs-mat[data-open=true] .gxs-caret{transform:rotate(90deg)}
    .gxs-mat-edit{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.22,1,.36,1)}
    .gxs-mat[data-open=true] .gxs-mat-edit{grid-template-rows:1fr}
    .gxs-mat-edit>div{overflow:hidden;padding:0 12px}
    .gxs-mat[data-open=true] .gxs-mat-edit>div{padding:0 12px 12px}
    .gxs-mat-edit p{margin:0 0 10px;color:#344054}
    .gxs-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;font-size:12.5px;color:#475467}
    .gxs-field>span:first-child{min-width:110px;font-weight:650;color:#344054}
    .gxs-field input[type=number]{width:84px;height:30px;border:1px solid #d0d5dd;border-radius:8px;padding:0 8px;font:inherit}
    .gxs-tip{position:fixed;z-index:2147483700;max-width:300px;background:#101828;color:#fff;font-size:12.5px;line-height:1.45;border-radius:10px;padding:8px 11px;box-shadow:0 12px 30px rgba(16,24,40,.3);pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s}
    .gxs-tip[data-show=true]{opacity:1;transform:none}
    .gxs-prices{columns:2 300px;column-gap:20px}
    .gxs-prices>section{break-inside:avoid;margin:0 0 10px}
    .gxs-prices h3{margin:0 0 4px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#667085}
    .gxs-price-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid #f2f4f7;font-size:12.5px}
    .gxs-price-row span{flex:1;min-width:0}
    .gxs-price-row small{color:#98a2b3}
    .gxs-price-row input{width:84px;height:28px;border:1px solid #d0d5dd;border-radius:7px;padding:0 7px;text-align:right;font:inherit;font-variant-numeric:tabular-nums}
    .gxs-supplier-picks{gap:6px}
    .gxs-supplier-pill .gxs-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);display:inline-block;margin-right:6px}
    .gxs-supplier-pill[aria-pressed=true]{border-color:var(--brand);background:var(--brand);color:#fff}
    .gxs-supplier-pill[aria-pressed=true] .gxs-dot{background:#fff}
    .gxs-supplier-custom{display:contents}
    .gxs-supplier-tag button{border:0;background:transparent;margin-left:4px;cursor:pointer;font-size:14px;line-height:1;color:#667085;padding:0}
    .gxs-supplier-input{flex:1 1 220px}
    .gxs-supplier-cols{margin-top:6px;padding-right:14px}
    @media(max-width:760px){.gxs-logos{grid-template-columns:repeat(2,minmax(0,1fr))}.gxs-logo-tile{height:76px}.gxs-logo-tile img{max-height:40px}}
  `;
  const injectWidgetCss = () => G()?.injectCss?.('gx-setup-widgets-css', widgetCss);
  /** One shared tooltip: plain text, positioned beside the element it explains. */
  function tooltip(){
    let tip = document.querySelector('.gxs-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'gxs-tip'; tip.setAttribute('role', 'tooltip'); tip.setAttribute('data-fmr-ignore', ''); document.body.appendChild(tip); }
    return {
      show(anchor, text){ if (!text) return; tip.textContent = text; tip.dataset.show = 'true'; const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(r.left, root.innerWidth - t.width - 8))}px`; tip.style.top = `${r.bottom + 8 + t.height > root.innerHeight ? r.top - t.height - 8 : r.bottom + 8}px`; },
      hide(){ tip.dataset.show = 'false'; }
    };
  }

  // Manufacturers: logos only, compact tiles, a check badge on the chosen ones. The wordmark only when a logo is missing.
  registerWidget('brand-cards', {
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const brands = array(options.brands);
      const picked = new Set(array(selections.brands).filter((id) => brands.some((brand) => brand.id === id)));
      const summary = () => picked.size === brands.length ? L('gx_ui_all_brands', 'All of them') : brands.filter((brand) => picked.has(brand.id)).map((brand) => brand.name).join(', ');
      const report = () => change({ brands: brands.filter((brand) => picked.has(brand.id)).map((brand) => brand.id), region: clean(options.region?.id) }, summary());
      const sync = () => { el.querySelectorAll('[data-brand]').forEach((tile) => tile.setAttribute('aria-pressed', String(picked.has(tile.dataset.brand)))); const all = el.querySelector('[data-all]'); if (all) all.setAttribute('aria-pressed', String(picked.size === brands.length)); report(); };
      el.innerHTML = `${options.allow_all !== false ? `<div class="gxs-tools"><button type="button" class="gxs-chip" data-all aria-pressed="false">${H('gx_ui_use_all', 'Use all')}</button></div>` : ''}
        <div class="gxs-logos">${brands.map((brand, i) => `<button type="button" class="gxs-logo-tile" style="--brand:${esc(brand.color)};animation-delay:${i * 40}ms" aria-pressed="false" aria-label="${esc(brand.name)}" title="${esc(brand.name)}" data-brand="${esc(brand.id)}">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}" decoding="async" data-gxs-logo>` : `<span class="gxs-wordmark">${esc(brand.name)}</span>`}<span class="gxs-badge-check" aria-hidden="true">&#10003;</span></button>`).join('')}</div>`;
      el.querySelectorAll('img[data-gxs-logo]').forEach((img) => img.addEventListener('error', () => { const mark = document.createElement('span'); mark.className = 'gxs-wordmark'; mark.textContent = img.alt; img.replaceWith(mark); }, { once: true }));
      el.addEventListener('click', (event) => {
        if (event.target.closest('[data-all]')) { if (picked.size === brands.length) picked.clear(); else brands.forEach((brand) => picked.add(brand.id)); sync(); return; }
        const id = event.target.closest('[data-brand]')?.dataset.brand;
        if (!id) return;
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        sync();
      });
      sync();
      setTimeout(() => el.classList.add('gxs-settled'), 900);
      return { valid: () => picked.size > 0, summary };
    }
  });

  const TIER = { '3_tab': ['gx_tier_3tab', '3-tab'], architectural: ['gx_tier_arch', 'Architectural'], premium_architectural: ['gx_tier_premium', 'Premium'], impact_rated: ['gx_tier_impact', 'Impact rated'], designer: ['gx_tier_designer', 'Designer'] };
  // Shingle lines in two columns: the usual ones ticked, the rest of the common range shown, specialty lines behind More; a search across all.
  registerWidget('product-lines', {
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const brands = array(options.brands).filter((brand) => array(selections.brands).includes(brand.id));
      const all = brands.flatMap((brand) => array(brand.lines));
      const known = new Set(all.map((line) => line.id));
      const chosen = new Set(array(selections.lines).filter((id) => known.has(id)));
      if (!chosen.size) all.filter((line) => (line.visibility || (line.popular ? 'default' : 'visible')) === 'default').forEach((line) => chosen.add(line.id));
      if (!chosen.size && all[0]) chosen.add(all[0].id);
      let star = known.has(selections.default_line) && chosen.has(selections.default_line) ? selections.default_line : [...chosen][0] || '';
      const expanded = new Set(); let query = '';
      const summary = () => all.filter((line) => chosen.has(line.id)).map((line) => line.name + (line.id === star ? ' ★' : '')).join(', ');
      const report = () => { if (!chosen.has(star)) star = [...chosen][0] || ''; change({ lines: all.filter((line) => chosen.has(line.id)).map((line) => line.id), default_line: star }, summary()); };
      const shown = (brand, line) => query ? `${brand.name} ${line.name}`.toLowerCase().includes(query) : (line.visibility || 'visible') !== 'more' || expanded.has(brand.id) || chosen.has(line.id);
      const row = (brand, line) => `<div class="gxs-line" role="checkbox" tabindex="0" aria-checked="${chosen.has(line.id)}" data-line="${esc(line.id)}" style="--brand:${esc(brand.color)}"><button type="button" class="gxs-star" data-star="${esc(line.id)}" aria-pressed="${line.id === star}" aria-label="${esc(L('gx_ui_make_default', 'Use first on new lists'))}" title="${esc(L('gx_ui_make_default', 'Use first on new lists'))}">&#9733;</button><strong>${esc(String(line.name).replace(brand.name + ' ', ''))}</strong>${TIER[line.tier] ? `<em>${H(TIER[line.tier][0], TIER[line.tier][1])}</em>` : ''}<span class="gxs-tick" aria-hidden="true">&#10003;</span></div>`;
      const listHtml = () => brands.map((brand) => {
        const lines = array(brand.lines), visible = lines.filter((line) => shown(brand, line)), hidden = lines.filter((line) => (line.visibility || 'visible') === 'more' && !shown(brand, line));
        if (!visible.length && query) return '';
        return `<section style="--brand:${esc(brand.color)}"><h3><b>${esc(brand.name)}</b><button type="button" class="gxs-chip" data-brand-all="${esc(brand.id)}" aria-pressed="${lines.every((line) => chosen.has(line.id))}">${H('gx_ui_include_all', 'Include all')}</button></h3>${visible.map((line) => row(brand, line)).join('')}${!query && hidden.length ? `<button type="button" class="gxs-more" data-more="${esc(brand.id)}">${H('gx_ui_more_lines', 'More')} (${hidden.length})</button>` : ''}</section>`;
      }).join('') || `<p class="gxs-sub">${H('gx_ui_no_lines', 'No shingle line matches that.')}</p>`;
      el.innerHTML = `<div class="gxs-tools"><input type="search" class="gxs-search" placeholder="${esc(L('gx_ui_search_lines', 'Search shingle lines'))}" aria-label="${esc(L('gx_ui_search_lines', 'Search shingle lines'))}"><button type="button" class="gxs-chip" data-all aria-pressed="false">${H('gx_ui_include_all', 'Include all')}</button></div><div class="gxs-cols"></div>`;
      const cols = el.querySelector('.gxs-cols');
      const draw = () => { cols.innerHTML = listHtml(); el.querySelector('[data-all]').setAttribute('aria-pressed', String(chosen.size === all.length)); report(); };
      const toggle = (id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); draw(); };
      el.querySelector('.gxs-search').addEventListener('input', (event) => { query = clean(event.target.value).toLowerCase(); draw(); });
      el.addEventListener('click', (event) => {
        const starred = event.target.closest('[data-star]');
        if (starred) { event.stopPropagation(); star = starred.dataset.star; chosen.add(star); draw(); return; }
        if (event.target.closest('[data-all]')) { if (chosen.size === all.length) chosen.clear(); else all.forEach((line) => chosen.add(line.id)); draw(); return; }
        const more = event.target.closest('[data-more]')?.dataset.more; if (more) { expanded.add(more); draw(); return; }
        const brandAll = event.target.closest('[data-brand-all]')?.dataset.brandAll;
        if (brandAll) { const lines = array(brands.find((brand) => brand.id === brandAll)?.lines); const every = lines.every((line) => chosen.has(line.id)); lines.forEach((line) => every ? chosen.delete(line.id) : chosen.add(line.id)); if (!every) expanded.add(brandAll); draw(); return; }
        const line = event.target.closest('[data-line]'); if (line) toggle(line.dataset.line);
      });
      el.addEventListener('keydown', (event) => { const line = event.target.closest('[data-line]'); if (line && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); toggle(line.dataset.line); el.querySelector(`[data-line="${CSS.escape(line.dataset.line)}"]`)?.focus(); } });
      draw();
      return { valid: () => chosen.size > 0, summary };
    }
  });

  /**
   * A material's rule in plain words, from its parts: what is measured, how much one package covers, the waste.
   * Never a sample roof's amount.
   */
  function plainRule(row, edit, L){
    if (edit.source === 'hand') return row.explanation ? `${L('gx_mr_by_hand', 'Entered by hand on each job.')} ${row.explanation}` : L('gx_mr_by_hand', 'Entered by hand on each job.');
    const unitWord = { roofing_square: L('gx_unit_square', 'square'), ft: L('gx_unit_foot', 'foot'), ft2: L('gx_unit_sqft', 'square foot') };
    const terms = array(row.terms).filter((term) => !(row.key === 'ice_water' && term.measurement === 'roof.eave_length' && !edit.eave_width));
    const flatAdjusted = terms.some((term) => term.measurement === 'roof.squares') && terms.some((term) => term.measurement === 'roof.flat_squares' && term.factor < 0);
    const measured = flatAdjusted ? L('gx_mr_roof_above_flat', 'every square of roof steeper than 2/12')
      : terms.map((term, i) => `${i ? (term.factor < 0 ? L('gx_mr_minus', 'minus') + ' ' : L('gx_mr_plus', 'plus') + ' ') : ''}${row.key === 'ice_water' && term.measurement === 'roof.eave_length' ? `${edit.eave_width} ${L('gx_mr_ft_up_from', 'ft up from')} ` : Math.abs(term.factor) !== 1 ? `${Math.abs(term.factor)} × ` : ''}${String(term.label).toLowerCase()}`).join(' ');
    const unit = unitWord[array(row.terms)[0]?.unit] || L('gx_unit_unit', 'unit');
    const pack = row.package ? clean(row.package.unit) : '';
    const coverage = Number(edit.coverage || row.package?.coverage || 0);
    let amount;
    if (row.key === 'ice_water') amount = `${L('gx_mr_ice_rows', 'Rows of barrier along the eaves and down every valley:')} ${measured}${pack ? `, ${L('gx_mr_one', 'one')} ${pack} ${L('gx_mr_per', 'per')} ${Math.round(coverage)} ${L('gx_mr_ft_of_row', 'ft of row')}` : ''}`;
    else if (pack && coverage > 0 && coverage < 1) amount = `${Math.round(1 / coverage * 10) / 10} ${pack}s ${L('gx_mr_for_every', 'for every')} ${measured.startsWith(L('gx_mr_every', 'every')) ? measured.replace(/^every /, '') : `${unit} ${L('gx_mr_of', 'of')} ${measured}`}`;
    else if (pack && coverage > 0) amount = `${L('gx_mr_one', 'One')} ${pack} ${L('gx_mr_for_every', 'for every')} ${Math.round(coverage * 100) / 100} ${unit === L('gx_unit_square', 'square') ? `${unit}s` : `${unit === L('gx_unit_foot', 'foot') ? 'ft' : unit}`} ${L('gx_mr_of', 'of')} ${measured}`;
    else amount = `${L('gx_mr_one', 'One')} ${unit} ${L('gx_mr_for_every', 'for every')} ${unit} ${L('gx_mr_of', 'of')} ${measured}`;
    const waste = edit.waste === 'roof' ? L('gx_mr_waste_report', 'plus waste from the measurement report') : Number(edit.waste) ? `${L('gx_mr_plus', 'plus')} ${edit.waste}% ${L('gx_mr_extra', 'extra')}` : '';
    const reveal = row.reveal_note ? ` ${L('gx_mr_reveal', 'When the job’s shingle shows its starter course (designer lines such as Presidential or Grand Sequoia), a coloured starter is used instead.')}` : '';
    return `${amount.charAt(0).toUpperCase()}${amount.slice(1)}${waste ? `, ${waste}` : ''}.${reveal}`;
  }
  // The materials list: one row per material and where its amount comes from; hover for the rule in plain words, click to edit it.
  registerWidget('measurement-rules', {
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const rows = array(options.materials);
      const tip = tooltip();
      const edits = Object.fromEntries(rows.map((row) => [row.key, {
        source: object(selections.rules)[row.key]?.source || row.source,
        waste: object(selections.rules)[row.key]?.waste ?? (row.key === 'shingles' ? selections.waste ?? row.waste : row.waste),
        coverage: object(selections.rules)[row.key]?.coverage ?? row.package?.coverage ?? null,
        eave_width: row.eave_width ? Number(selections.ice_eave_width ?? object(options.ice_eave_width).default ?? 6) : null
      }]));
      const open = new Set();
      const sourceLabel = (edit) => edit.source === 'hand' ? L('gx_mr_source_hand', 'Entered by hand') : L('gx_mr_source_report', 'From measurement report');
      const editor = (row) => {
        const edit = edits[row.key];
        const wasteControl = row.source !== 'hand' || row.can_report ? `<div class="gxs-field"><span>${H('gx_mr_waste', 'Waste')}</span>${row.key === 'shingles' ? `<button type="button" class="gxs-chip" data-waste="roof" aria-pressed="${edit.waste === 'roof'}">${H('gx_mr_waste_from_report', 'From measurement report')}</button>` : ''}<label><input type="number" min="0" max="40" step="1" data-waste-input value="${edit.waste === 'roof' ? '' : esc(edit.waste ?? 0)}" placeholder="%"> %</label></div>` : '';
        return `<p data-plain>${esc(plainRule(row, edit, L))}</p>
          <div class="gxs-field"><span>${H('gx_mr_source', 'Amount')}</span>${row.can_report ? `<button type="button" class="gxs-chip" data-source="report" aria-pressed="${edit.source !== 'hand'}">${H('gx_mr_source_report', 'From measurement report')}</button>` : ''}<button type="button" class="gxs-chip" data-source="hand" aria-pressed="${edit.source === 'hand'}">${H('gx_mr_source_hand', 'Entered by hand')}</button></div>
          ${edit.source !== 'hand' ? wasteControl : ''}
          ${edit.source !== 'hand' && row.package ? `<div class="gxs-field"><span>${H('gx_mr_coverage', 'One package covers')}</span><input type="number" min="0.01" step="any" data-coverage value="${esc(edit.coverage ?? '')}"> ${esc(String(array(row.terms)[0]?.unit) === 'roofing_square' ? L('gx_mr_squares', 'squares') : L('gx_mr_feet', 'ft'))} <small>(${esc(row.package.unit)})</small></div>` : ''}
          ${edit.source !== 'hand' && row.eave_width ? `<div class="gxs-field"><span>${H('gx_ui_ice_label', 'How far up from the eaves')}</span>${[6, 3, 0].map((value) => `<button type="button" class="gxs-chip" data-width="${value}" aria-pressed="${Number(edit.eave_width) === value}">${value ? `${value} ft` : H('gx_ui_ice_0', 'None')}</button>`).join('')}</div>` : ''}`;
      };
      const rowHtml = (row) => `<div class="gxs-mat" data-mat="${esc(row.key)}" data-open="${open.has(row.key)}"><button type="button" data-mat-toggle aria-expanded="${open.has(row.key)}"><i class="fas fa-chevron-right gxs-caret" aria-hidden="true"></i><strong>${esc(row.label)}</strong><span class="gxs-source" data-source="${edits[row.key].source}">${esc(sourceLabel(edits[row.key]))}</span></button><div class="gxs-mat-edit"><div>${open.has(row.key) ? editor(row) : ''}</div></div></div>`;
      el.innerHTML = `<div class="gxs-mats">${rows.map(rowHtml).join('')}</div>`;
      const redraw = (key) => { const node = el.querySelector(`[data-mat="${CSS.escape(key)}"]`); const row = rows.find((entry) => entry.key === key); const fresh = document.createElement('div'); fresh.innerHTML = rowHtml(row); node.replaceWith(fresh.firstElementChild); };
      const report = () => {
        const rules = {};
        for (const row of rows) { const edit = edits[row.key], base = { source: row.source, waste: row.waste, coverage: row.package?.coverage ?? null }; const diff = {}; if (edit.source !== base.source) diff.source = edit.source; if (String(edit.waste) !== String(base.waste)) diff.waste = edit.waste; if (edit.coverage && Number(edit.coverage) !== Number(base.coverage)) diff.coverage = Number(edit.coverage); if (Object.keys(diff).length && row.can_report) rules[row.key] = diff; }
        const ice = rows.find((row) => row.eave_width);
        change({ rules, waste: edits.shingles?.waste ?? 'roof', ...(ice ? { ice_eave_width: Number(edits[ice.key].eave_width) } : {}) }, `${rows.filter((row) => edits[row.key].source !== 'hand').length} ${L('gx_mr_from_report_count', 'from the measurement report')}, ${rows.filter((row) => edits[row.key].source === 'hand').length} ${L('gx_mr_by_hand_count', 'by hand')}`);
      };
      el.addEventListener('click', (event) => {
        const mat = event.target.closest('[data-mat]'); if (!mat) return;
        const key = mat.dataset.mat, edit = edits[key];
        if (event.target.closest('[data-mat-toggle]')) { if (open.has(key)) open.delete(key); else open.add(key); tip.hide(); redraw(key); return; }
        const source = event.target.closest('[data-source]')?.dataset.source; if (source) { edit.source = source; redraw(key); report(); return; }
        if (event.target.closest('[data-waste]')) { edit.waste = 'roof'; redraw(key); report(); return; }
        const width = event.target.closest('[data-width]')?.dataset.width; if (width !== undefined) { edit.eave_width = Number(width); redraw(key); report(); }
      });
      el.addEventListener('change', (event) => {
        const mat = event.target.closest('[data-mat]'); if (!mat) return;
        const edit = edits[mat.dataset.mat], value = Number(event.target.value);
        if (event.target.matches('[data-waste-input]') && Number.isFinite(value) && value >= 0 && value <= 40) edit.waste = value;
        if (event.target.matches('[data-coverage]') && value > 0) edit.coverage = value;
        mat.querySelector('[data-plain]').textContent = plainRule(rows.find((row) => row.key === mat.dataset.mat), edit, L);
        mat.querySelector('.gxs-source').textContent = sourceLabel(edit);
        report();
      });
      el.addEventListener('pointerover', (event) => { const head = event.target.closest('[data-mat-toggle]'); if (!head) return; const key = head.closest('[data-mat]').dataset.mat; if (!open.has(key)) tip.show(head, plainRule(rows.find((row) => row.key === key), edits[key], L)); });
      el.addEventListener('pointerout', (event) => { if (event.target.closest('[data-mat-toggle]') && !event.relatedTarget?.closest?.('[data-mat-toggle]')) tip.hide(); });
      el.addEventListener('focusin', (event) => { const head = event.target.closest('[data-mat-toggle]'); if (head) { const key = head.closest('[data-mat]').dataset.mat; if (!open.has(key)) tip.show(head, plainRule(rows.find((row) => row.key === key), edits[key], L)); } });
      el.addEventListener('focusout', () => tip.hide());
      report();
      return { valid: () => true, destroy(){ tip.hide(); } };
    }
  });

  /**
   * The products the chosen brands and lines put in the price book, grouped by kind: the chosen shingle lines, the main
   * brand's accessories (plus coloured starters when a chosen line shows its starter), common items and labor.
   */
  function chosenProducts(options, selections, L){
      const brands = array(options.brands).filter((brand) => array(selections.brands).includes(brand.id));
      const lines = brands.flatMap((brand) => array(brand.lines)).filter((line) => array(selections.lines).includes(line.id));
      const star = selections.default_line && lines.some((line) => line.id === selections.default_line) ? selections.default_line : lines[0]?.id;
      const primary = brands.find((brand) => array(brand.lines).some((line) => line.id === star)) || brands[0];
      const plainOf = (entry) => !entry.colored_starter;
      const accessory = (role) => array(primary?.accessories).find((entry) => entry.role === role && plainOf(entry)) || brands.flatMap((brand) => array(brand.accessories)).find((entry) => entry.role === role && plainOf(entry));
      const accessories = ['starter', 'hip_ridge', 'underlayment', 'ice_water', 'ridge_vent'].map(accessory).filter(Boolean);
      const revealing = lines.filter((line) => line.reveals_starter);
      const colored = [...new Set(revealing.map((line) => array(brands.find((brand) => brand.id === line.brand)?.accessories).find((entry) => entry.colored_starter) || array(primary?.accessories).find((entry) => entry.colored_starter)).filter(Boolean))];
      const seen = new Set(); const generic = array(options.generic).filter((entry) => { if (seen.has(entry.rule)) return false; seen.add(entry.rule); return true; });
      return { brands, lines, accessories: [...accessories, ...colored], generic, groups: [
        ['line', L('gx_ui_group_shingles', 'Shingles'), lines],
        ['accessory', L('gx_ui_group_accessories', 'Accessories') + (primary ? ` (${primary.name})` : ''), [...accessories, ...colored].map((entry) => ({ ...entry, brand: entry.brand || brands.find((brand) => array(brand.accessories).includes(entry))?.id }))],
        ['generic', L('gx_ui_group_common', 'Common items'), generic],
        ['labor', L('gx_ui_group_labor', 'Labor and services'), array(options.labor)]
      ] };
  }
  // Costs only, in two columns grouped by kind of material. The kinds come from the step (materials, or labor on its own page).
  registerWidget('price-review', {
    render(el, { step, options, selections, change, L }){
      injectWidgetCss();
      const kinds = array(options.kinds).length ? array(options.kinds) : ['line', 'accessory', 'generic', 'labor'];
      const prices = { ...object(selections.prices) };
      const groups = chosenProducts(options, selections, L).groups.filter(([kind, , items]) => kinds.includes(kind) && items.length);
      const priceOf = (item) => prices[item.id] ?? item.price;
      el.innerHTML = `<p class="gxs-sub" style="margin:0 0 8px">${H('gx_ui_prices_region', 'Typical costs for')} <b>${esc(options.region?.label || '')}</b></p><div class="gxs-prices">${groups.map(([, title, items]) => `<section><h3>${esc(title)}</h3>${items.map((item) => `<label class="gxs-price-row"><span>${esc(item.name)} <small>/ ${esc(item.unit)}</small></span><input type="number" min="0" step="0.01" inputmode="decimal" data-price="${esc(item.id)}" value="${esc(priceOf(item))}" aria-label="${esc(item.name)}"></label>`).join('')}</section>`).join('')}</div>`;
      const count = groups.reduce((sum, [, , items]) => sum + items.length, 0);
      const report = () => change({ prices, ...(kinds.includes('labor') ? { include_labor: true } : {}) }, `${count} ${L('gx_ui_products', 'products')}`);
      el.addEventListener('change', (event) => { const input = event.target.closest('[data-price]'); if (!input) return; const value = Number(input.value); if (Number.isFinite(value) && value >= 0) prices[input.dataset.price] = value; report(); });
      report();
      return { valid: () => true };
    }
  });

  /**
   * Who provides the materials: the researched suppliers as pills and any typed one as a tag; the chosen ones as
   * columns (supplier-columns.js) with what each carries and costs. A researched supplier starts with the chosen
   * products of the brands it stocks (a big-box store only the mainstream lines and plain accessories) at the prices
   * seen there; a typed one starts empty. Each column takes a price sheet, which goes to the agent.
   */
  registerWidget('supplier-columns', {
    render(el, { options, selections, change, L, priceSheet }){
      injectWidgetCss();
      const presets = array(options.suppliers);
      const products = chosenProducts(options, selections, L);
      const groups = products.groups.filter(([kind, , items]) => kind !== 'labor' && items.length);
      const items = groups.flatMap(([kind, title, entries]) => entries.map((entry) => ({ id: entry.id, name: entry.name, unit: entry.unit, price: entry.price, group: title, kind, brand: entry.brand, visibility: entry.visibility, colored: !!entry.colored_starter })));
      const brandOf = (item) => item.brand || array(options.brands).find((brand) => array(brand.lines).some((line) => line.id === item.id))?.id;
      const carriedBy = (preset) => items.filter((item) => {
        if (item.kind === 'generic') return true;
        if (!array(preset.manufacturers).includes(brandOf(item))) return false;
        if (preset.line_scope !== 'retail_core') return true;
        return item.kind === 'line' ? (item.visibility || 'default') === 'default' : !item.colored;
      }).map((item) => item.id);
      const slug = (name) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'supplier';
      const known = new Set(items.map((item) => item.id));
      let chosen = array(selections.suppliers).map((entry) => {
        const preset = presets.find((candidate) => candidate.id === entry.preset);
        return { key: preset ? preset.id : `custom:${slug(entry.name)}`, preset: preset?.id, name: clean(entry.name) || preset?.name, color: preset?.color || '#475467', kind: preset?.kind || 'custom', item_ids: array(entry.item_ids).filter((id) => known.has(id)), prices: { ...object(entry.prices) }, base_prices: object(preset?.prices) };
      }).filter((entry) => entry.name);
      el.innerHTML = `<div class="gxs-tools gxs-supplier-picks">${presets.map((preset) => `<button type="button" class="gxs-chip gxs-supplier-pill" data-preset="${esc(preset.id)}" style="--brand:${esc(preset.color)}" aria-pressed="false" title="${esc(preset.regions || '')}"><span class="gxs-dot" aria-hidden="true"></span>${esc(preset.name)}</button>`).join('')}<span class="gxs-supplier-custom"></span><input type="text" class="gxs-search gxs-supplier-input" maxlength="200" placeholder="${esc(L('gx_sup_type_own', 'Another supplier? Type it and press Enter'))}" aria-label="${esc(L('gx_sup_type_own', 'Another supplier? Type it and press Enter'))}"></div><div class="gxs-supplier-cols"></div><p class="gxs-sub gxs-supplier-empty">${H('gx_sup_none', 'Pick a supplier to see what it carries.')}</p>`;
      const colsEl = el.querySelector('.gxs-supplier-cols');
      let columns = null;
      const summary = () => chosen.map((entry) => entry.name).join(', ');
      const report = () => change({ suppliers: chosen.map((entry) => ({ ...(entry.preset ? { preset: entry.preset } : {}), name: entry.name, item_ids: entry.item_ids, prices: entry.prices })) }, summary());
      const sync = () => {
        el.querySelectorAll('[data-preset]').forEach((pill) => pill.setAttribute('aria-pressed', String(chosen.some((entry) => entry.preset === pill.dataset.preset))));
        el.querySelector('.gxs-supplier-custom').innerHTML = chosen.filter((entry) => !entry.preset).map((entry) => `<span class="gxs-chip gxs-supplier-tag" aria-pressed="true">${esc(entry.name)}<button type="button" data-remove="${esc(entry.key)}" aria-label="${esc(L('gx_sup_remove', 'Remove'))} ${esc(entry.name)}">&times;</button></span>`).join('');
        el.querySelector('.gxs-supplier-empty').hidden = chosen.length > 0;
        if (!root.FirstMateSupplierColumns) { colsEl.textContent = ''; report(); return; }
        if (!columns) columns = root.FirstMateSupplierColumns.mount(colsEl, { suppliers: chosen, items, onChange: (next) => { chosen = next; report(); }, ...(priceSheet ? { onPriceSheet: (supplier) => priceSheet(supplier) } : {}) });
        else columns.update(chosen);
        report();
      };
      const add = (entry) => { if (chosen.some((existing) => existing.key === entry.key || existing.name.toLowerCase() === entry.name.toLowerCase()) || chosen.length >= 12) return; chosen.push(entry); sync(); };
      el.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove]')?.dataset.remove;
        if (remove) { chosen = chosen.filter((entry) => entry.key !== remove); sync(); return; }
        const id = event.target.closest('[data-preset]')?.dataset.preset; if (!id) return;
        if (chosen.some((entry) => entry.preset === id)) { chosen = chosen.filter((entry) => entry.preset !== id); sync(); return; }
        const preset = presets.find((candidate) => candidate.id === id);
        add({ key: preset.id, preset: preset.id, name: preset.name, color: preset.color, kind: preset.kind, item_ids: carriedBy(preset), prices: {}, base_prices: object(preset.prices) });
      });
      el.querySelector('.gxs-supplier-input').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ',') return;
        event.preventDefault();
        const name = clean(event.target.value); if (!name) return;
        event.target.value = '';
        const preset = presets.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (preset) { if (!chosen.some((entry) => entry.preset === preset.id)) el.querySelector(`[data-preset="${CSS.escape(preset.id)}"]`)?.click(); return; }
        add({ key: `custom:${slug(name)}`, name, color: '#475467', kind: 'custom', item_ids: [], prices: {}, base_prices: {} });
      });
      sync();
      return { valid: () => true, summary, destroy(){ columns?.destroy?.(); } };
    }
  });

  function register(){
    if (!G()?.registerKind) return false;
    G().registerKind('modal', player('modal'));
    G().registerKind('agentic', player('agentic'));
    return true;
  }
  if (!register()) root.addEventListener?.('DOMContentLoaded', register, { once: true });
  root.FirstMateGuidedSetup = { registerWidget, widgets: () => [...widgets.keys()], plainRule };
})(window);
