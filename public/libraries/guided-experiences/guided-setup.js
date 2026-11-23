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
 * the selections so far; they report a selection patch, whether it is complete, and a plain summary of it. Steps can
 * branch (a step's `next`, decided on the server); Back returns along the way taken. There is no step count: setup
 * steps the experience requires (docs/architecture/setup-steps.md) are injected by the server while unanswered, drawn
 * in the same frame (often by their own module, widget `module`) and saved by their own action on Continue.
 * The finish offers "Start generating materials" and "View the price book" (the price book renderer, in the sheet).
 */
(function(root){
  'use strict';
  const document = root.document;
  const scriptUrl = document.currentScript?.src || new URL('/libraries/guided-experiences/guided-setup.js',location.href).href;
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

  const choiceCss = `
    /* GP-46: one layout for a step whose answer is one of a few choices, in every setup. The row is .gxs-choices with
       --gxs-n, how many there are; each choice is a .gxs-choice holding its .gxs-choice-icon, its .gxs-choice-text (a
       title and a line) and its .gxs-choice-tick. A desktop shows tall, near-square tiles side by side, evenly spaced
       (the room either side is the gap), narrower and shorter the more there are; a phone shows full-width rectangles,
       one above the other, sharing the sheet's height evenly. The setup keeps its own border, colours and ticked look. */
    .gxs-choices{--gxs-n:2;--gxs-gap:calc(10px + 24px / var(--gxs-n));display:grid;grid-template-columns:repeat(var(--gxs-n),minmax(0,calc(130px + 320px / var(--gxs-n))));justify-content:space-evenly;gap:var(--gxs-gap);padding:30px var(--gxs-gap) 8px}
    .gxs-choices>.gxs-choice{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:16px;min-width:0;min-height:calc(170px + 160px / var(--gxs-n));padding:46px 22px 30px;text-align:center}
    .gxs-choices>.gxs-choice>.gxs-choice-icon{flex:none;width:64px;height:64px;margin:0;border-radius:18px;display:grid;place-items:center;font-size:27px}
    .gxs-choices>.gxs-choice>.gxs-choice-text{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
    .gxs-choices>.gxs-choice .gxs-choice-text strong{font-size:17px;line-height:1.25}
    .gxs-choices>.gxs-choice .gxs-choice-text small{font-size:13px;line-height:1.45;max-width:220px}
    .gxs-choices>.gxs-choice>.gxs-choice-tick{top:14px;right:14px;width:24px;height:24px}
    /* A phone (GP-46): the choices stacked, each as wide as the step, and between them they take the height the sheet
       has left (the step, and whatever holds the row inside it, grow to it); each is at least a comfortable tap and at
       most 220px tall, and a short row sits in the middle of the room. */
    @media(max-width:640px){
      .gxs-step:has(.gxs-choices) .gxs-body,.gxs-body :has(.gxs-choices){display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
      .gxs-choices{grid-template-columns:minmax(0,1fr);grid-auto-rows:minmax(104px,1fr);gap:12px;flex:1 1 auto;max-height:calc(var(--gxs-n) * 232px);margin-block:auto;padding:4px 0 8px}
      .gxs-choices>.gxs-choice{flex-direction:row;align-items:center;gap:16px;min-height:0;padding:18px 52px 18px 18px;text-align:left}
      .gxs-choices>.gxs-choice>.gxs-choice-icon{width:52px;height:52px;border-radius:15px;font-size:22px}
      .gxs-choices>.gxs-choice>.gxs-choice-text{align-items:flex-start;gap:4px}
      .gxs-choices>.gxs-choice .gxs-choice-text strong{font-size:16px}
      .gxs-choices>.gxs-choice .gxs-choice-text small{max-width:none}
      .gxs-choices>.gxs-choice>.gxs-choice-tick{top:calc(50% - 12px);right:16px}
    }
  `;

  const css = `
    .gxs,.gxs *,.gxs *::before,.gxs *::after{box-sizing:border-box}
    .gxs [hidden]{display:none!important}
    .gxs-settled .gxs-card,.gxs-settled .gxs-rule{animation:none}
    .gxs{position:fixed;inset:0;z-index:2147483250;display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828}
    /* One scroller (FirstMateGuides.holdPage): the page under the sheet is held still, the sheet is the visible screen
       (--gx-vh, which a phone's keyboard shrinks), and a step at the end of its scroll never hands the drag on. Only the
       sheet and its steps contain: anything inside that clips or is a field (a line item, an input) is a scroll container
       too, and containing it there would swallow the wheel over it (FM-605); it passes the wheel on to the step. */
    .gxs,.gxs-sheet,.gxs-step{overscroll-behavior:contain}
    .gxs-scrim{position:absolute;inset:0;background:rgba(16,24,40,.55);backdrop-filter:blur(3px);animation:gxsFade .35s ease both}
    /* The sheet is a landscape rectangle as tall as the step on screen needs (--gxs-fit, measured by the player), up to
       the cap; a step that fills (logos, supplier columns, a workflow) has no fit and takes the full height. */
    .gxs-sheet{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 360px;width:min(1120px,calc(100vw - 32px));height:min(var(--gxs-fit,760px),calc(var(--gx-vh,100vh) - 32px));background:#fff;border-radius:20px;box-shadow:0 40px 100px rgba(16,24,40,.45);overflow:hidden;animation:gxsRise .5s cubic-bezier(.22,1,.36,1) both}
    .gxs[data-kind=modal] .gxs-sheet{grid-template-columns:minmax(0,1fr);width:min(960px,calc(100vw - 32px))}
    /* The conversation beside the steps needs room of its own, however short the step. */
    .gxs[data-kind=agentic] .gxs-sheet{min-height:min(600px,calc(var(--gx-vh,100vh) - 32px))}
    .gxs.gxs-fit-now .gxs-sheet{transition:none}
    /* The price book after the finish needs room for its list and an item side by side: the sheet widens to show it. */
    .gxs-sheet{transition:width .45s cubic-bezier(.22,1,.36,1),height .45s cubic-bezier(.22,1,.36,1)}
    .gxs.gxs-wide .gxs-sheet{width:min(1480px,calc(100vw - 32px));height:min(880px,calc(var(--gx-vh,100vh) - 32px))}
    .gxs[data-kind=modal] .gxs-chat{display:none}
    @keyframes gxsFade{from{opacity:0}to{opacity:1}}
    @keyframes gxsRise{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
    .gxs-widget{display:flex;flex-direction:column;min-width:0;min-height:0;background:linear-gradient(180deg,#fcfcfd,#fff 180px)}
    .gxs-head{display:flex;align-items:center;gap:12px;padding:16px 20px 8px}
    .gxs-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.08);border-radius:999px;padding:5px 11px;white-space:nowrap}
    .gxs-head-title{display:none;align-items:center;gap:6px;flex:1;min-width:0;margin:0;font-size:17px;line-height:1.2;letter-spacing:-.015em;font-weight:780;color:#101828}
    .gxs-head-text{min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
    .gxs-icon{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:#667085;cursor:pointer;font-size:18px;display:inline-grid;place-items:center}
    .gxs-icon:hover{background:#f2f4f7;color:#101828}
    .gxs-stage{position:relative;flex:1;min-height:0;overflow:hidden}
    .gxs-step{position:absolute;inset:0;overflow:auto;padding:8px 28px 24px;display:flex;flex-direction:column;transition:transform .55s cubic-bezier(.22,1,.36,1),opacity .4s ease}
    .gxs-body{flex:0 0 auto}
    .gxs-step[data-fill]{overflow:hidden}
    .gxs-step[data-fill] .gxs-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
    .gxs-step.gxs-more-below{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 48px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 48px),transparent)}
    .gxs-titlebar{display:flex;align-items:center;gap:10px;margin:4px 0 12px;padding-right:44px;flex:none}
    .gxs[data-kind=agentic] .gxs-titlebar{padding-right:0}
    .gxs-titlebar h2{margin:0!important;padding-right:0!important;flex:1;min-width:0}
    .gxs-title-actions{display:flex;align-items:center;gap:8px;flex:none}
    .gxs-intro{margin:-4px 0 14px;font-size:14px;line-height:1.45;color:#475467;flex:none}
    /* A setup's welcome (GP-54): what the tab is for, before any question. */
    .gxs-welcome{display:flex;flex-direction:column;gap:14px;padding-bottom:6px}
    .gxs-welcome p{margin:0;font-size:14.5px;line-height:1.5;color:#475467}
    .gxs-welcome ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
    .gxs-welcome li{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.45;font-weight:600;color:#101828}
    .gxs-welcome li svg{flex:none;width:14px;height:14px;padding:4px;box-sizing:content-box;border-radius:50%;background:rgba(var(--primary-rgb,217,48,37),.1);stroke:var(--primary,#d93025);stroke-width:3;fill:none}
    .gxs-welcome .gxs-welcome-note{font-size:13px;color:#667085}
    .gxs-title-actions:empty{display:none}
    .gxs-next-wrap{display:inline-flex}
    .gxs-step.gxs-below{transform:translateY(48px);opacity:0}
    .gxs-step.gxs-above{transform:translateY(-48px);opacity:0;pointer-events:none}
    .gxs-step h2{display:flex;align-items:center;gap:8px;margin:4px 0 12px;padding-right:44px;font-size:clamp(18px,2vw,22px);line-height:1.2;letter-spacing:-.02em;font-weight:780}
    /* The tip opens over the step under it: above a step's own layers (the document setup's style cards are 10, their
       arrows 12, GP-29) and below the sheet's "close?" ask (20). */
    .gxs-info{position:relative;flex:none;width:20px;height:20px;border-radius:50%;border:1px solid #d0d5dd;background:#fff;color:#667085;font:italic 700 11px/1 Georgia,serif;cursor:help;display:inline-grid;place-items:center;padding:0}
    .gxs-info-tip{position:absolute;left:50%;top:calc(100% + 8px);transform:translate(-50%,4px);width:max-content;max-width:min(320px,70vw);background:#101828;color:#fff;font:400 12.5px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:0;text-align:left;border-radius:9px;padding:8px 10px;white-space:pre-line;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;z-index:15}
    .gxs-info:hover .gxs-info-tip,.gxs-info:focus-visible .gxs-info-tip,.gxs-info:focus-within .gxs-info-tip{opacity:1;transform:translate(-50%,0)}
    .gxs-info:focus-within .gxs-info-tip{pointer-events:auto;cursor:text}
    .gxs-step>p.gxs-sub{margin:0 0 18px;color:#667085;max-width:60ch}
    .gxs-module-loading{display:grid;place-items:center;min-height:160px;color:var(--primary,#d93025)}
    /* A workflow drawn as more pages of a step (carrier registration, GP-138) fills it, its buttons along the bottom. */
    .gxs-step:has(>.gxs-body>.fm-wizard-inline){justify-content:flex-start}
    .gxs-body:has(>.fm-wizard-inline){display:flex;flex-direction:column;flex:1 0 auto}
    .gxs-module-error{margin:24px 0;color:#b42318}
    .gxs-foot{display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid #f2f4f7;background:#fff}
    /* A step that marks itself data-float-foot (the document setup's styles, FM-608) has Back and Continue float over its
       bottom edge, with no bar or divider, so it gets the full height; it keeps that corner clear itself. */
    .gxs.gxs-float-foot .gxs-widget{position:relative}
    .gxs.gxs-float-foot .gxs-foot{position:absolute;left:0;right:0;bottom:0;z-index:6;border-top:0;background:transparent;pointer-events:none}
    .gxs.gxs-float-foot .gxs-foot>*{pointer-events:auto}
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
    /* Editing a setup live (development): an agent is changing it; the step redraws in place when the change is ready. */
    .gxs-hot{position:absolute;top:14px;right:52px;z-index:5;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 8px;border-radius:999px;background:#101828;color:#fff;font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 14px rgba(16,24,40,.22);pointer-events:auto;animation:gxsHotIn .2s ease-out both}
    .gxs-hot .gxs-spin{width:13px;height:13px;border-width:2px;border-color:rgba(255,255,255,.35);border-top-color:#fff}
    .gxs-hot.gxs-hot-done{background:#067647}
    .gxs-hot.gxs-hot-done .gxs-spin{display:none}
    .gxs-hot.gxs-hot-done::before{content:"\\2713";font-size:12px}
    @keyframes gxsHotIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
    .gxs-close:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gxs-close .gxs-x{font-size:24px;line-height:1;font-weight:400}
    @keyframes gxsMsg{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    /* Widgets */
    .gxs-wordmark{display:flex;align-items:center;min-height:64px;font-weight:900;font-size:clamp(20px,2.2vw,27px);line-height:1.05;letter-spacing:-.03em;color:var(--brand,#101828);padding-right:26px}
    .gxs-tick{position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;color:#fff;font-size:12px;transition:background .2s,border-color .2s,transform .25s cubic-bezier(.34,1.56,.64,1)}
    .gxs-chip{height:30px;padding:0 12px;border-radius:999px;border:1px solid #d0d5dd;background:#fff;font:inherit;font-size:12.5px;font-weight:650;color:#344054;cursor:pointer}
    .gxs-chip[aria-pressed=true]{background:#101828;border-color:#101828;color:#fff}
    .gxs-seg{display:inline-flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .gxs-done-step{justify-content:center}
    .gxs-done{display:grid;place-items:center;text-align:center;padding:24px 10px;gap:10px;margin:auto 0}
    .gxs-done p{margin:0;color:#475467;max-width:44ch}
    .gxs-done svg{width:84px;height:84px}
    .gxs-done circle{stroke:var(--primary,#d93025);stroke-width:4;fill:none;stroke-dasharray:240;stroke-dashoffset:240;animation:gxsDraw .7s ease forwards}
    .gxs-done path{stroke:var(--primary,#d93025);stroke-width:5;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:60;stroke-dashoffset:60;animation:gxsDraw .45s .55s ease forwards}
    @keyframes gxsDraw{to{stroke-dashoffset:0}}
    /* The price book, shown in the sheet after the finish. */
    .gxs-book-step .gxs-body{display:flex}
    .gxs-book{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
    .gxs-book.pb-embed>.pb-win{flex:1 1 auto;min-height:0;height:100%;border:1px solid #eaecf0;border-radius:14px;overflow:hidden;box-shadow:none}
    .gxs-book .pb-top{display:none}
    .gxs-book .pb-body{grid-template-columns:minmax(340px,44%) minmax(0,1fr)}
    .gxs-book-count{font-size:12px;font-weight:650;color:#475467;background:#f2f4f7;border-radius:999px;padding:4px 10px;white-space:nowrap}
    .gxs-book-loading,.gxs-book-missing{margin:auto;display:flex;align-items:center;gap:8px;color:#667085}
    .gxs-flying{position:fixed!important;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(16,24,40,.35);display:flex;flex-direction:column}
    .gxs.gxs-leaving .gxs-scrim{opacity:0;transition:opacity .45s}
    .gxs.gxs-leaving .gxs-widget{opacity:0;transform:translateX(-30px);transition:opacity .35s,transform .45s}
    .gxs.gxs-leaving[data-kind=modal] .gxs-sheet{opacity:0;transform:scale(.97);transition:opacity .3s,transform .3s}
    @media(max-width:760px){
      .gxs-sheet,.gxs.gxs-wide .gxs-sheet{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;width:100vw;height:var(--gx-vh,100dvh);border-radius:0}
      /* On a phone a modal setup is a sheet from the bottom edge, as tall as its step but never under two-thirds of the
         screen, so a short step (two choices) doesn't leave a sliver; the step sits in the middle of the extra room. The
         agentic one keeps the screen. */
      .gxs[data-kind=modal]{place-items:end center}
      .gxs[data-kind=modal] .gxs-sheet{width:100vw;height:min(var(--gxs-fit,100dvh),calc(var(--gx-vh,100dvh) - 12px));min-height:calc(var(--gx-vh,100dvh) * 2 / 3);border-radius:18px 18px 0 0}
      .gxs[data-kind=modal] .gxs-step:not([data-fill]){justify-content:flex-start;justify-content:safe center}
      .gxs[data-kind=agentic] .gxs-sheet{min-height:0}
      .gxs-chat{border-left:0;border-top:1px solid #eaecf0;max-height:48px;overflow:hidden;transition:max-height .35s cubic-bezier(.22,1,.36,1)}
      .gxs-chat[data-open=true]{max-height:calc(var(--gx-vh,100dvh) * .58)}
      .gxs-chat-handle{display:flex;align-items:center;gap:8px;flex:none;height:48px;padding:0 16px;border:0;background:#fff;font:inherit;font-weight:700;color:#101828;cursor:pointer;text-align:left}
      .gxs-chat-handle .gxs-chevron{margin-left:auto;transition:transform .3s}
      .gxs-chat[data-open=true] .gxs-chat-handle .gxs-chevron{transform:rotate(180deg)}
      .gxs-close{top:8px;right:6px}
      .gxs-step{padding:6px 16px 20px}
      /* The (i) tip hangs from the title, not centred on the icon: centred, it ran past the step's right edge (FM-485)
         and the step scrolled sideways even while the tip was hidden. */
      .gxs-step h2{position:relative}
      .gxs-info{position:static}
      .gxs-info-tip{left:0;max-width:100%;transform:translateY(4px)}
      .gxs-info:hover .gxs-info-tip,.gxs-info:focus-visible .gxs-info-tip,.gxs-info:focus-within .gxs-info-tip{transform:none}
      .gxs-badge span{display:none}
      .gxs-foot{padding:10px 12px}
      /* One title, in the top bar between the agent and the X: the step's own (or one the step published with
         setTitle, such as a workflow's current step). The step keeps only its title actions. */
      .gxs-head{min-height:52px;padding:8px 52px 8px 10px;gap:10px}
      .gxs-head-title{display:flex;position:relative}
      .gxs-step .gxs-titlebar h2{display:none}
      .gxs-titlebar{justify-content:flex-end;margin:0 0 10px}
      .gxs-titlebar:has(>.gxs-title-actions:empty){display:none}
    }
    /* Embedded (GP-78): played with a container (Operations settings' sub-tab), the sheet is that container's content:
       no scrim, no shadow, as large as the container, on a phone too. The container is positioned. */
    .gxs.gxs-embedded{position:absolute;inset:0;z-index:5;display:block}
    .gxs.gxs-embedded[data-kind] .gxs-sheet,.gxs.gxs-embedded.gxs-wide .gxs-sheet{width:100%;height:100%;min-height:0;border-radius:0;box-shadow:none;animation:gxsFade .25s ease both}
${choiceCss}    @media(prefers-reduced-motion:reduce){.gxs *,.gxs{animation:none!important;transition:none!important}}
  `;

  function injectCss(){ G()?.injectCss ? G().injectCss('gx-setup-css', css) : null; }

  // ── The player ─────────────────────────────────────────────────────────
  function player(kind){
    return (ctx) => new Promise((resolve) => {
      injectCss();
      const { experience, track } = ctx;
      const here = ctx.where();
      const steps = array(experience.steps);
      // Nothing left to ask (a setup that only requires setup steps, all answered): nothing is drawn.
      if (!steps.length) return resolve({ status: 'satisfied' });
      const orgId = clean(root.__APP?.userOrgId);
      // The agent is the platform assistant itself, in the person's own project conversation (the one the tray shows).
      // A modal setup can call it in when a step needs it (a pay sheet to read, GP-28): `canAgent` says it can be.
      const canAgent = !!here.projectId && !!orgId && !!root.AssistantAPI && typeof root.PlatformAssistant?.mountProject === 'function';
      let agentic = kind === 'agentic' && canAgent;
      // A setup opened from another one for a known answer (Operations' Proposals card opens the document setup for a
      // proposal, FM-607) starts with that answer and at the step after the question it answers; Back stops there.
      const selections = { ...object(experience.progress?.data), ...object(ctx.options?.selections) };
      const summaries = {};
      // A setup step this experience requires (docs/architecture/setup-steps.md) is answered on its own, through its
      // published action: its answer is kept here per step and never mixed into the experience's selections.
      const answers = {};
      let index = Math.max(0, steps.findIndex((step) => step.id === experience.progress?.step_id));
      if (index >= steps.length) index = 0;
      let mounted = null, busy = false, saving = false, closed = false, assistant = null, doneWaiter = null;
      // The way through: the steps visited (Back returns along them) and each branch the server decided.
      const visited = [], decided = {};
      const indexOf = (id) => steps.findIndex((entry) => entry.id === id);
      /** The step after `at` as far as is known here: a decided branch, a fixed next, the first branch, else the next in order. */
      function after(at){
        const step = steps[at], n = step?.next;
        if (step && decided[step.id] !== undefined) return decided[step.id];
        const target = typeof n === 'string' ? n : n && typeof n === 'object' ? (array(n.branches)[0]?.to || n.otherwise) : '';
        const found = target ? indexOf(target) : -1;
        return found > at ? entryOf(found) : at + 1;
      }
      /**
       * Where to land when going to step `to`: the first of the unanswered setup steps the server put just before it
       * (they are asked first), else the step itself. A branch or a fixed next that jumps to a step goes through them.
       */
      function entryOf(to){
        const target = steps[to]?.id;
        let at = to;
        while (at > 0 && target && steps[at - 1]?.setup_step?.injected_for === target && !answered.has(steps[at - 1].id)) at -= 1;
        return at;
      }
      // Setup steps saved in this run: going back to one and on again does not ask the steps before it again.
      const answered = new Set();
      // A tab that started the setup may have it welcome the person first (GP-54); not on a replay or a nested start.
      let welcome = !ctx.options?.replay && !ctx.options?.nested && ctx.options?.trigger?.kind === 'tab_opened' && ctx.options.trigger.welcome?.title ? ctx.options.trigger.welcome : null;
      const start = clean(ctx.options?.start) ? indexOf(clean(ctx.options.start)) : -1;
      if (start >= 0) index = start;
      index = entryOf(index);
      const first = start >= 0 ? index : 0;

      // Played with a `container` (an element in this page, GP-78), the sheet is drawn inside it instead of over the page:
      // a setup started from a settings pane plays in that pane. `signal` aborting (the pane went away) ends it.
      const container = ctx.options?.container?.nodeType === 1 && ctx.options.container.isConnected && ctx.options.container.ownerDocument === document ? ctx.options.container : null;
      const host = document.createElement('div');
      host.className = container ? 'gxs gxs-embedded' : 'gxs'; host.dataset.kind = agentic ? 'agentic' : 'modal'; host.setAttribute('data-fmr-ignore', ''); host.setAttribute('data-gx-setup', experience.id);
      host.innerHTML = `${container ? '' : '<div class="gxs-scrim"></div>'}
        <section class="gxs-sheet" ${container ? 'role="region"' : 'role="dialog" aria-modal="true"'} aria-label="${esc(L(experience.title))}">
          <span class="gxs-hot" data-gxs-hot hidden role="status"><span class="gxs-spin" aria-hidden="true"></span><span class="gxs-hot-text"></span></span>
          <button type="button" class="gxs-close" data-gxs="close" aria-label="${esc(L('gx_ui_close_setup', 'Close setup'))}" title="${esc(L('gx_ui_close_setup', 'Close setup'))}"><span class="gxs-x" aria-hidden="true">&times;</span></button>
          <div class="gxs-widget">
            <header class="gxs-head"><span class="gxs-badge"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>${H(experience.title)}</span></span><div class="gxs-head-title" role="heading" aria-level="2"></div></header>
            <div class="gxs-stage"></div>
            <footer class="gxs-foot"><span class="gxs-status" role="status"></span>
              <button type="button" class="gxs-btn ghost" data-gxs="back">${H('gx_ui_back', 'Back')}</button>
              <button type="button" class="gxs-btn ghost" data-gxs="skip">${H('gx_ui_skip_step', 'Skip step')}</button>
              <span class="gxs-next-wrap"><button type="button" class="gxs-btn primary" data-gxs="next"></button></span></footer>
          </div>
          <aside class="gxs-chat" aria-label="${esc(L('gx_ui_agent', 'Agent'))}">
            <button type="button" class="gxs-chat-handle" data-gxs="toggleChat" aria-expanded="false"><i class="fas fa-sparkles" aria-hidden="true"></i>${H('gx_ui_agent', 'Agent')}<i class="fas fa-chevron-up gxs-chevron" aria-hidden="true"></i></button>
            <div class="gxs-assistant"></div>
          </aside>
        </section>`;
      (container || document.body).appendChild(host);
      const releasePage = !container && G()?.holdPage ? G().holdPage(host) : () => {};
      // The phone's back control is the sheet's Back (FM-554): one history entry per step behind the one on screen, and
      // one more that leaves the first step. Back on the finish closes it, as the X does. A step with steps of its own
      // (the Operations workflow) adds one per step of its own behind the one it shows (`backDepth`, FM-604).
      const backHistory = root.Portal?.navigation?.steps?.({ onBack: (count) => { for (let n = 0; n < count && !closed; n += 1) pressBack(); syncBack(); } }) || null;
      const syncBack = () => backHistory?.depth(closed || (finished && !doneWaiter) ? 0 : doneWaiter ? (bookPane ? 2 : 1) : (visited.length || index - first) + 1 + Math.max(0, Number(mounted?.backDepth?.()) || 0));
      const $ = (selector) => host.querySelector(selector);
      const stage = $('.gxs-stage'), status = $('.gxs-status'), chat = $('.gxs-chat');
      /**
       * The sheet's height follows the step on screen (--gxs-fit; the CSS caps it and the step scrolls past the cap). The
       * pane is measured let go of the stage's bottom edge, so it is the content's own height and not the space it was
       * given; a pane that fills (data-fill) has no fit and the sheet takes its full height. Measured again whenever the
       * step's content changes size or it starts or stops filling. The first fit is not animated.
       */
      const sheet = $('.gxs-sheet');
      let fitFrame = 0, fitted = false;
      function fit(){
        fitFrame = 0;
        const pane = currentPane;
        if (closed || !pane?.isConnected) return;
        const floating = pane.hasAttribute('data-float-foot');
        host.classList.toggle('gxs-float-foot', floating);
        if (pane.hasAttribute('data-fill')) sheet.style.removeProperty('--gxs-fit');
        else {
          const bottom = pane.style.bottom; pane.style.bottom = 'auto';
          const natural = pane.offsetHeight; pane.style.bottom = bottom;
          const foot = $('.gxs-foot'), chrome = $('.gxs-head').offsetHeight + (foot.hidden || floating ? 0 : foot.offsetHeight);
          sheet.style.setProperty('--gxs-fit', `${Math.ceil(natural + chrome + 1)}px`);
        }
        if (!fitted) { fitted = true; host.classList.add('gxs-fit-now'); requestAnimationFrame(() => requestAnimationFrame(() => host.classList.remove('gxs-fit-now'))); }
      }
      const refit = () => { if (!fitFrame) fitFrame = requestAnimationFrame(fit); };
      const fitSize = root.ResizeObserver ? new root.ResizeObserver(refit) : null;
      const fitFill = root.MutationObserver ? new root.MutationObserver(refit) : null;
      function fitTo(pane){
        fitSize?.disconnect(); fitFill?.disconnect();
        [...pane.children].forEach((child) => fitSize?.observe(child));
        fitFill?.observe(pane, { attributes: true, attributeFilter: ['data-fill', 'data-float-foot'] });
        fit();
      }
      const previousFocus = document.activeElement;

      // The agent: a platform assistant instance running this setup as a preprogrammed workflow.
      function mountAgent(){
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
              onUpload: async (files) => {
                track('question', { step_id: steps[index]?.id, properties: { upload: true, files: files.length } });
                const saved = await saveDraft();
                // With exactly one supplier chosen, a price sheet is that supplier's: say so, naming it.
                const chosenSuppliers = array(selections.suppliers);
                if (steps[index]?.widget === 'supplier-columns' && chosenSuppliers.length === 1 && root.FirstMateSupplierColumns?.sheetMessage) {
                  const match = array(saved?.suppliers).find((entry) => clean(entry.name).toLowerCase() === clean(chosenSuppliers[0].name).toLowerCase());
                  return root.FirstMateSupplierColumns.sheetMessage({ id: match?.id, name: chosenSuppliers[0].name });
                }
                return undefined;
              }
            }
          });
        } catch (error) {
          console.warn('The setup could not open the assistant; it continues without it.', error);
          agentic = false; host.dataset.kind = 'modal'; assistant = null;
        }
      }
      if (agentic) mountAgent();
      /** Calls the agent in beside a modal setup, the way an agentic one starts (the sheet makes room for it). */
      function ensureAgent(){
        if (assistant || closed || !canAgent) return assistant;
        agentic = true; host.dataset.kind = 'agentic';
        mountAgent();
        refit();
        return assistant;
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
      /**
       * A published data read for a step's code, as the person, in their organization: the value, or an error with the
       * layer's reason. Steps read what they show (a catalog, an earlier answer) here, never from private routes.
       */
      async function readData(provider, exportName, extra = {}){
        if (!orgId || !root.PlatformAPI?.publication?.read) throw new Error(L('gx_ui_read_unavailable', 'This can’t be loaded here. Reload the page and try again.'));
        const result = await root.PlatformAPI.publication.read(orgId, { provider, export: exportName, target: { scope: 'organization', organizationId: orgId }, ...object(extra) });
        const value = result?.result ?? result;
        if (value?.status && value.status !== 'ready') throw Object.assign(new Error(clean(value.message) || L('gx_ui_read_failed', 'This couldn’t be loaded. Try again.')), { code: value.code, status: value.status });
        return value?.value;
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
      /**
       * Someone's pay sheet for the agent: pick the file, save the setup so far (which adds the group or company), then
       * send it naming that assignee's key, so the agent writes their pay sheet (pay-sheets.try, pay-sheets.sheet.save).
       */
      function laborPaySheet(entry){
        if (!assistant && !canAgent) return null;
        return new Promise((resolve) => {
          const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.csv,.xlsx,.xls,.pdf,.txt,.png,.jpg,.jpeg';
          picker.addEventListener('change', async () => {
            const files = [...(picker.files || [])];
            if (!files.length) return resolve(null);
            // A modal setup (the workforce setup) calls the agent in now, beside it.
            if (!ensureAgent()) return resolve(null);
            chat.dataset.open = 'true';
            track('question', { step_id: steps[index]?.id, properties: { upload: true, assignee: clean(entry?.name) } });
            const saved = array(object((await saveDraft())?.labor).assignees).find((row) => clean(row.name).toLowerCase() === clean(entry?.name).toLowerCase() && row.kind === entry.kind);
            const ref = saved?.ref || entry.ref;
            const key = ref?.type && ref?.id ? `${ref.type}:${ref.id}` : '';
            const message = `${L('gx_lab_sheet_message', 'Here is the pay sheet for')} ${clean(entry?.name)}${key ? ` (assignee ${key})` : ''}. ${L('gx_lab_sheet_ask', 'Please set up how they are paid for roofing from it.')}`;
            await assistant?.sendWithFiles?.(message, files);
            resolve(true);
          }, { once: true });
          picker.click();
        });
      }
      /** The scripted turn, written into the project conversation so a reload and the agent tray hold it too. */
      function persist(body){
        if (!agentic) return Promise.resolve();
        return ctx.api.conversation(experience.id, { project_id: here.projectId, tab: here.tab, ...body }).catch((error) => console.warn('Setup conversation not saved.', error));
      }
      $('[data-gxs=toggleChat]').addEventListener('click', () => { const open = chat.dataset.open !== 'true'; chat.dataset.open = String(open); $('[data-gxs=toggleChat]').setAttribute('aria-expanded', String(open)); });

      // Steps. There is no step count or progress bar: a flow's length is not known ahead (setup steps it requires are
      // asked only while unanswered, branches and answers add or remove steps), so the frame only ever goes forward
      // to the next step, with Back along the way taken.
      function footer(){
        const step = steps[index];
        $('.gxs-foot').hidden = !!widgets.get(step.widget)?.handlesNavigation || mounted?.handlesNavigation?.() === true;
        const last = after(index) >= steps.length;
        $('[data-gxs=back]').hidden = !visited.length && index <= first;
        // An optional last page (labor prices) can be skipped too; skipping it finishes without its part.
        $('[data-gxs=skip]').hidden = step.required !== false || (last && !Object.keys(object(step.options?.skip_sets)).length);
        $('[data-gxs=skip]').innerHTML = step.skip_label ? H(step.skip_label) : H('gx_ui_skip_step', 'Skip step');
        const next = $('[data-gxs=next]');
        const finishLabel = experience.completion?.screen === 'none' ? H('gx_ui_done', 'Done') : ctx.options?.nested ? H('gx_ui_finish_setup','Finish setup') : H('gx_ui_finish', 'Build my price book');
        next.innerHTML = busy ? `<span class="gxs-spin" aria-hidden="true"></span>${saving ? H('gx_ui_saving', 'Saving…') : H('gx_ui_building', 'Building…')}` : (last ? finishLabel : H('gx_ui_continue', 'Continue'));
        const blocked = step.required !== false && mounted?.valid?.() === false;
        next.disabled = busy || blocked;
        // A disabled button shows no tooltip of its own, so its wrapper says why.
        const hint = blocked ? clean(mounted?.hint?.()) || L('gx_ui_hint_choose', 'Make a choice to continue.') : '';
        const wrap = next.parentElement;
        if (wrap?.classList.contains('gxs-next-wrap')) { if (hint) wrap.title = hint; else wrap.removeAttribute('title'); }
      }
      /**
       * One owner for step changes: each change takes a new generation, removes every pane but the one on screen at
       * once, and its animation callbacks do nothing once a newer change has started. Fast clicks never stack panes.
       */
      let paneGeneration = 0, currentPane = null;
      function watchFade(pane){
        const update = () => pane.classList.toggle('gxs-more-below', !pane.hasAttribute('data-fill') && pane.scrollHeight - pane.scrollTop - pane.clientHeight > 4);
        pane.addEventListener('scroll', update, { passive: true });
        const observer = root.ResizeObserver ? new root.ResizeObserver(update) : null;
        requestAnimationFrame(() => { const body = pane.querySelector('.gxs-body'); if (body) observer?.observe(body); observer?.observe(pane); update(); });
      }
      /**
       * The title in the top bar (shown on a phone, where it replaces the step's own title row): the step's title and its
       * explanation, or a title the step published (`setTitle`, e.g. the workflow step it is on); empty on the finish.
       */
      const headTitle = $('.gxs-head-title');
      function infoHtml(step){ return step?.subtitle ? ` <span class="gxs-info" role="button" tabindex="0" data-gxs-info aria-label="${esc(L(step.subtitle))}"><span aria-hidden="true">i</span><span class="gxs-info-tip" role="tooltip">${H(step.subtitle)}</span></span>` : ''; }
      function setHeadTitle(html, info = ''){ headTitle.innerHTML = html ? `<span class="gxs-head-text">${html}</span>${info}` : ''; refit(); }
      // A live edit redraws the step on screen where it was (redraw below): no slide, no focus move, no step_view.
      // Every setup says where it is through ctx.place (one contract, no per-setup state): `keep(getter)` names a getter
      // of a JSON-safe snapshot ({ page, ... }); a live redraw hands that snapshot back as `restored`, and an issue filed
      // from the dev tray names its page (FirstMateGuidedSetup.where).
      let hotCarry, keeper = null;
      const placeNow = () => { try { const value = keeper?.(); return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null; } catch (_) { return null; } };
      function show(to, direction = 1, hot = false){
        const step = steps[to];
        const generation = ++paneGeneration;
        stage.querySelectorAll('.gxs-step').forEach((pane) => { if (pane !== currentPane) pane.remove(); });
        let old = currentPane && currentPane.isConnected ? currentPane : null;
        const scrolled = hot && old ? old.scrollTop : 0;
        mounted?.destroy?.();
        if (hot && old) { old.remove(); old = null; }
        const el = document.createElement('div');
        el.className = 'gxs-step' + (old && !reduced() ? (direction > 0 ? ' gxs-below' : ' gxs-above') : ''); el.dataset.gxStep = step.id;
        // A compact header: the title, and its explanation in a tooltip. A copy editor edits it in the tooltip, which
        // stays open while it has focus.
        // The setup's intro (why it asks) leads its first page, whichever step that is (FM-553).
        const intro = to === 0 && experience.intro ? `<p class="gxs-intro">${H(experience.intro)}</p>` : '';
        el.innerHTML = `<div class="gxs-titlebar"><h2>${H(step.title)}${infoHtml(step)}</h2><div class="gxs-title-actions"></div></div>${intro}<div class="gxs-body"></div>`;
        stage.appendChild(el);
        setHeadTitle(H(step.title), infoHtml(step));
        currentPane = el;
        index = to;
        const widget = widgets.get(step.widget);
        // A widget that fills the step (logos, supplier columns) gets its height; others scroll, with a fade at the
        // bottom while there is more below.
        if (widget?.fill) el.dataset.fill = '';
        watchFade(el);
        // A setup step's answer is its own (answers[step.id], saved by its action on Continue); an experience step's
        // goes into the selections the completion reads.
        const global = step.setup_step || null;
        if (global && !answers[step.id]) answers[step.id] = {};
        const carried = hot ? hotCarry : undefined; hotCarry = undefined; keeper = null;
        const place = { restored: carried ?? null, keep(getter){ if (currentPane === el && typeof getter === 'function') keeper = getter; } };
        mounted = widget ? widget.render(el.querySelector('.gxs-body'), { step, options: object(step.options), selections, answer: global ? answers[step.id] : null, place, L, H, esc, money, where:here, orgId, read: readData, actions: el.querySelector('.gxs-title-actions'), priceSheet: assistant ? supplierPriceSheet : null, paySheet: assistant || canAgent ? laborPaySheet : null,
          advance:()=>next(false), complete:completeDirectly, nested:!!ctx.options?.nested,
          // A step that hides the sheet's footer (handlesNavigation) has its own Back: to the step before this one; and
          // says when its own steps change, so the phone's back walks them first (FM-604).
          back(){ if (currentPane === el && !closed && !busy && (visited.length || index > first)) back(); }, syncBack(){ if (currentPane === el) syncBack(); },
          // Whether there is a step before this one to go Back to (a step with its own Back shows it only then, GP-85).
          canBack:()=>currentPane === el && !closed && !!(visited.length || index > first),
          // A step whose page needs room (the workforce setup's cards, GP-66) asks for the large sheet, about the project
          // window's size, and lets it go when it no longer needs it (also when it goes away).
          setWide(on){ if (closed || (on && currentPane !== el)) return; host.classList.toggle('gxs-wide', !!on); },
          // The step names what is on screen now (plain text); empty goes back to the step's own title.
          setTitle(text){ if (currentPane !== el || closed) return; const value = clean(text); if (value) setHeadTitle(esc(value)); else setHeadTitle(H(step.title), infoHtml(step)); }, checkpoint:()=>track('step_view',{step_id:step.id,selections}), restart(){visited.length=0;show(0,-1);},
          async runGuide(id,options={}){ if(!options.keepVisible){host.hidden=true;host.inert=true;}try{return await ctx.playChild?.(id,{...options,...(container?{container,signal:ctx.options?.signal}:{})});}finally{if(!closed){host.hidden=false;host.inert=false;}} },
          change(patch, summary){ Object.assign(global ? answers[step.id] : selections, patch); if (summary !== undefined) summaries[step.id] = summary; status.textContent = ''; status.classList.remove('err'); footer(); } }) : null;
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
        footer();
        fitTo(el);
        syncBack();
        if (hot) { if (scrolled) requestAnimationFrame(() => { el.scrollTop = scrolled; }); return; }
        setTimeout(() => { if (generation === paneGeneration) el.querySelector('button,input')?.focus?.({ preventScroll: true }); }, reduced() ? 0 : 450);
        track('step_view', { step_id: step.id, selections });
      }
      /** Redraws the step on screen in place after a live edit, handing the module back its place (ctx.place.restored). */
      function redraw(){
        if (closed || busy || !steps[index] || !currentPane?.isConnected) return;
        hotCarry = placeNow();
        show(index, 0, true);
        hotFlash();
      }
      /**
       * Reads the experience again (its steps, copy and order are config library data) and redraws in place, staying
       * on the same step when it is still there. Used when an agent says its live edit is done.
       */
      async function reloadDefinition(){
        const fresh = await G()?.reloadExperience?.(experience.id).catch?.(() => null);
        if (closed || !fresh || !Array.isArray(fresh.steps) || !fresh.steps.length) return redraw();
        const on = steps[index]?.id;
        for (const key of ['title', 'intro', 'completion']) if (fresh[key] !== undefined) experience[key] = fresh[key];
        steps.splice(0, steps.length, ...fresh.steps);
        const at = indexOf(on);
        index = at >= 0 ? at : Math.min(index, steps.length - 1);
        redraw();
      }
      // The working spinner beside the X while an agent edits this setup live; "Updated" for a moment after each change.
      const hotBadge = $('[data-gxs-hot]');
      let hotWorking = null, hotTimer = 0;
      function hotFlash(){
        if (hotWorking || closed) return;
        clearTimeout(hotTimer);
        hotBadge.hidden = false; hotBadge.classList.add('gxs-hot-done');
        hotBadge.querySelector('.gxs-hot-text').textContent = L('gx_ui_hot_updated', 'Updated');
        hotTimer = setTimeout(() => { if (!hotWorking) { hotBadge.hidden = true; hotBadge.classList.remove('gxs-hot-done'); } }, 1600);
      }
      function hotSignal(signal){
        const was = hotWorking;
        hotWorking = signal;
        clearTimeout(hotTimer);
        if (signal) {
          hotBadge.hidden = false; hotBadge.classList.remove('gxs-hot-done');
          const note = clean(signal.note);
          hotBadge.querySelector('.gxs-hot-text').textContent = L('gx_ui_hot_working', 'Changing…');
          hotBadge.title = note || L('gx_ui_hot_working_title', 'This setup is being changed. It updates here when the change is ready.');
          return;
        }
        hotBadge.hidden = true; hotBadge.removeAttribute('title');
        if (was) reloadDefinition();
      }
      const hotPlayer = { id: experience.id, redraw,
        uses: (key) => !closed && [...(currentPane?.querySelectorAll?.('[data-gx-module]') || [])].some((node) => node.dataset.gxModule === key),
        where: () => ({ experience: experience.id, step: clean(steps[index]?.id), page: clean(placeNow()?.page) }) };
      livePlayers.add(hotPlayer);
      const stopHotEdits = watchHotEdits(experience.id, hotSignal);
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
        // A setup step is saved before the flow moves on: its published action, run as the person. A failure stays
        // on the step with the reason, so nothing later is asked on an answer that was not kept.
        const global = step.setup_step;
        if (global?.writes?.action && !skip) {
          const answer = object(mounted?.answer?.() ?? answers[step.id]);
          busy = true; saving = true; footer(); status.textContent = ''; status.classList.remove('err');
          try {
            if (!orgId || !root.PlatformAPI?.publication?.invoke) throw new Error(L('gx_ui_save_unavailable', 'This can’t be saved here. Reload the page and try again.'));
            await root.PlatformAPI.publication.invoke(orgId, global.writes.action, { scope: 'organization', organizationId: orgId }, answer, { idempotencyKey: `${experience.id}:${step.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
            answered.add(step.id);
          } catch (error) {
            busy = false; saving = false; footer(); status.classList.add('err');
            status.textContent = clean(error?.message) || L('gx_ui_finish_failed', 'That didn’t save. Try again.');
            return;
          }
          busy = false; saving = false;
        }
        const sent = track(skip ? 'step_skip' : 'step_done', { step_id: step.id, selections });
        let to = after(index);
        if (step.next && typeof step.next === 'object') {
          busy = true; footer();
          const target = clean((await sent)?.next_step);
          busy = false;
          const found = indexOf(target);
          if (found > index) { to = entryOf(found); decided[step.id] = to; }
        }
        if (to >= steps.length) return finish(choice);
        if (!closed) { visited.push(index); enter(to, 1, choice); }
      }
      async function finish(choice){
        // Nested setups, and setups with no finish screen (one that only asks setup steps), close as they finish.
        if(ctx.options?.nested || experience.completion?.screen === 'none') { try{return await completeDirectly();}catch{return;} }
        busy = true; footer(); status.textContent = ''; status.classList.remove('err');
        try {
          const result = await ctx.api.complete(experience.id, { selections, tab: here.tab, project_id: here.projectId, idempotency_key: `${experience.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
          const value = object(result.result);
          stage.querySelectorAll('.gxs-step').forEach((el) => el.remove());
          mounted?.destroy?.(); mounted = null;
          const done = document.createElement('div'); done.className = 'gxs-step gxs-done-step'; done.dataset.gxStep = 'done';
          done.innerHTML = `<div class="gxs-done"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="38"/><path d="M26 43l11 11 21-23"/></svg><h2>${H('gx_ui_done_title', 'Your price book is ready')}</h2><p>${H('gx_ui_done_body_2', 'New materials lists start from your defaults, and everything else is in your price book to search.')}</p></div>`;
          stage.appendChild(done);
          currentPane = done; finished = value;
          setHeadTitle('');
          // Two ways on: look at the price book here first, or close and generate this project's materials.
          const foot = $('.gxs-foot');
          [...foot.children].forEach((child) => { child.hidden = true; });
          const button = (kind, action, html) => { const el = document.createElement('button'); el.type = 'button'; el.className = kind; el.dataset.gxs = action; el.innerHTML = html; return el; };
          const bookBack = button('gxs-btn ghost', 'book-back', `<i class="fas fa-arrow-left" aria-hidden="true"></i>${H('gx_ui_back', 'Back')}`); bookBack.hidden = true;
          const view = button('gxs-btn', 'view', `<i class="fas fa-book-open" aria-hidden="true"></i>${H('gx_ui_done_view', 'View the price book')}`);
          const generate = button('gxs-btn primary', 'generate', H('gx_ui_done_generate', 'Start generating materials'));
          view.style.marginLeft = 'auto'; bookBack.style.marginRight = 'auto';
          foot.append(bookBack, view, generate);
          fitTo(done);
          generate.focus({ preventScroll: true });
          const lines = array(experience.completion?.say).map((copy) => L(copy));
          persist({ phase: 'done', choice: choice || '' });
          say(lines, choice, 'done');
          const how = await new Promise((resolveDone) => { doneWaiter = resolveDone; syncBack(); });
          book?.destroy?.(); book = null;
          const handoff = agentic && array(experience.completion?.then).some((entry) => entry.handoff === 'assistant_tray');
          await close(handoff ? 'handoff' : 'plain');
          resolve({ status: 'completed', result: value, ...(how === 'generate' ? { generate: true } : {}) });
        } catch (error) {
          busy = false; footer();
          status.classList.add('err');
          status.textContent = clean(error?.message) || L('gx_ui_finish_failed', 'That didn’t save. Try again.');
        }
      }

      // Widgets that finish with their own checklist can use the same server completion
      // contract without the legacy price-book confirmation screen.
      async function completeDirectly(outcome = {}){
        if (busy || closed) return;
        busy=true; footer();
        try {
          const result=await ctx.api.complete(experience.id,{selections,tab:here.tab,project_id:here.projectId,idempotency_key:`${experience.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`});
          await close('plain');
          resolve({status:'completed',result:object(result.result),...(outcome.generate===true?{generate:true}:{}),...(outcome.resume===false?{resume:false}:{})});
        } catch(error) { busy=false;footer();status.classList.add('err');status.textContent=error?.message||L('gx_ui_finish_failed','That didn’t save. Try again.');throw error; }
      }
      /**
       * The price book that was just set up, in the sheet in place of the finish, with the agent still beside it: the
       * price book renderer (the one Materials settings mounts), showing only the items this setup wrote.
       */
      let finished = null, book = null, bookPane = null;
      function showPricebook(open){
        const done = stage.querySelector('[data-gx-step=done]'), foot = $('.gxs-foot');
        foot.querySelector('[data-gxs=view]').hidden = open; foot.querySelector('[data-gxs=book-back]').hidden = !open;
        host.classList.toggle('gxs-wide', open);
        if (!open) {
          if (bookPane) { const pane = bookPane; bookPane = null; pane.classList.add('gxs-below'); setTimeout(() => { book?.destroy?.(); book = null; pane.remove(); }, reduced() ? 0 : 420); }
          done?.classList.remove('gxs-above'); if (done) { done.inert = false; done.removeAttribute('aria-hidden'); }
          setHeadTitle('');
          foot.querySelector('[data-gxs=view]').focus({ preventScroll: true });
          syncBack();
          return;
        }
        if (bookPane) return;
        const ids = new Set(array(finished?.item_ids).map(String));
        const pane = document.createElement('div'); pane.className = 'gxs-step gxs-book-step' + (reduced() ? '' : ' gxs-below'); pane.dataset.fill = ''; pane.dataset.gxStep = 'pricebook';
        pane.innerHTML = `<div class="gxs-titlebar"><h2>${H('gx_ui_book_title', 'Your price book')}</h2><div class="gxs-title-actions"><span class="gxs-book-count">${ids.size} ${H('gx_ui_book_items', 'items set up')}</span></div></div><div class="gxs-body"><div class="gxs-book"></div></div>`;
        stage.appendChild(pane); bookPane = pane;
        syncBack();
        setHeadTitle(H('gx_ui_book_title', 'Your price book'));
        if (done) { done.classList.add('gxs-above'); done.inert = true; done.setAttribute('aria-hidden', 'true'); }
        requestAnimationFrame(() => requestAnimationFrame(() => pane.classList.remove('gxs-below')));
        const shelf = pane.querySelector('.gxs-book');
        const library = root.FirstMatePricebook || root.Portal?.modules?.pricebook;
        if (!library?.mount) { shelf.innerHTML = `<p class="gxs-book-missing">${H('gx_ui_book_missing', 'The price book opens from Materials settings.')}</p>`; return; }
        shelf.innerHTML = `<div class="gxs-book-loading"><span class="gxs-spin" aria-hidden="true"></span>${H('gx_ui_book_loading', 'Opening your price book…')}</div>`;
        library.configure?.({ currentOrganizationId: () => orgId });
        // The setup has just written the price book: read it again before drawing.
        Promise.resolve(library.loadState?.(true)).catch(() => null).then(() => {
          if (bookPane !== pane) return;
          shelf.innerHTML = '';
          book = library.mount(shelf, { title: L('gx_ui_book_title', 'Your price book'), itemFilter: ids.size ? (item) => ids.has(String(item.id)) : null });
        });
      }
      /**
       * The X asks in a small dialog over the setup (inside the sheet, where the person is looking): Keep going is
       * focused; Escape and a click on the dim choose it.
       */
      function confirmSkip(){
        if (busy || closed || host.querySelector('.gxs-ask')) return;
        const ask = document.createElement('div'); ask.className = 'gxs-ask';
        // What happens after a skip: the trigger's note when a skip there only puts it off (FM-553), else the setup's own.
        const skipNote = ctx.options?.trigger?.skip_note || experience.skip_note || null;
        ask.innerHTML = `<div class="gxs-ask-scrim" data-gxs="keep"></div><div class="gxs-ask-box" role="alertdialog" aria-modal="true" aria-labelledby="gxs-ask-title" aria-describedby="gxs-ask-text">
          <h3 id="gxs-ask-title">${H('gx_ui_skip_dialog_title', 'Skip setup for now?')}</h3>
          <p id="gxs-ask-text">${skipNote ? H(skipNote) : H('gx_ui_skip_dialog_text', 'Materials will use typical products. You can set up your price book any time in Materials settings.')}</p>
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
      /**
       * The welcome (GP-54): started by a tab whose trigger has one, the setup first says what the tab is for. Set up now
       * goes on to the first question; Back puts the setup off as a skip does (`dismiss`, which a `skip: "later"` trigger
       * records as `defer`) and returns to the portal tab the person came from; the X and Escape put it off and stay.
       */
      function showWelcome(){
        const el = document.createElement('div');
        el.className = 'gxs-step gxs-welcome-step'; el.dataset.gxStep = 'welcome';
        const points = array(welcome.points).map((point) => `<li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span>${H(point)}</span></li>`).join('');
        el.innerHTML = `<div class="gxs-titlebar"><h2>${H(welcome.title)}</h2><div class="gxs-title-actions"></div></div><div class="gxs-body"><div class="gxs-welcome"><p>${H(welcome.body)}</p>${points ? `<ul>${points}</ul>` : ''}${welcome.note ? `<p class="gxs-welcome-note">${H(welcome.note)}</p>` : ''}</div></div>`;
        stage.appendChild(el);
        currentPane = el;
        setHeadTitle(H(welcome.title));
        $('[data-gxs=skip]').hidden = true;
        const backButton = $('[data-gxs=back]'), start = $('[data-gxs=next]');
        backButton.hidden = false; backButton.innerHTML = welcome.back ? H(welcome.back) : H('gx_ui_back', 'Back');
        start.disabled = false; start.innerHTML = welcome.start ? H(welcome.start) : H('gx_ui_set_up_now', 'Set up now');
        fitTo(el);
        syncBack();
        setTimeout(() => { if (currentPane === el && !closed) start.focus({ preventScroll: true }); }, reduced() ? 0 : 300);
        // Events name a step of the setup (the server refuses any other): the one the welcome leads to, marked as the welcome.
        track('step_view', { step_id: steps[index]?.id, properties: { welcome: true } });
      }
      function startFromWelcome(){
        if (!welcome || closed) return;
        welcome = null;
        $('[data-gxs=back]').innerHTML = H('gx_ui_back', 'Back');
        enter(index, 1, '');
      }
      async function leaveWelcome(returnToTab){
        if (!welcome || closed || host.dataset.dismissing) return;
        host.dataset.dismissing = 'true';
        await track('dismiss', { step_id: steps[index]?.id, selections, properties: { welcome: returnToTab ? 'back' : 'close' } });
        await close('plain');
        // The tab before this one, when the setup belongs to a portal tab and the portal can say which (core.js).
        const tabs = root.Portal?.tabs;
        const before = returnToTab && clean(ctx.options?.trigger?.tab).startsWith('portal.') ? clean(tabs?.previous?.()) : '';
        if (before) { try { tabs.activateTab(before, false, { history: 'push', source: 'guided-welcome-back' }); } catch (error) { console.warn('Could not return to the previous tab.', error); } }
        resolve({ status: 'dismissed', welcome: returnToTab ? 'back' : 'close' });
      }
      host.addEventListener('click', (event) => {
        const action = event.target.closest?.('[data-gxs]')?.dataset.gxs;
        if (welcome && ['next', 'back', 'close'].includes(action)) { if (action === 'next') startFromWelcome(); else leaveWelcome(action === 'back'); return; }
        if (action === 'next') next(false);
        else if (action === 'skip') next(true);
        else if (action === 'back' && !doneWaiter && (visited.length || index > first)) back();
        else if (action === 'generate' && doneWaiter) { const go = doneWaiter; doneWaiter = null; go('generate'); }
        else if (action === 'view' && doneWaiter) showPricebook(true);
        else if (action === 'book-back' && doneWaiter) showPricebook(false);
        else if (action === 'done' || (action === 'close' && doneWaiter)) { const go = doneWaiter; doneWaiter = null; go?.(); }
        else if (action === 'close') confirmSkip();
        else if (action === 'keep') keepGoing();
        else if (action === 'dismiss' && !host.dataset.dismissing) { host.dataset.dismissing = 'true'; (async () => { await track('dismiss', { step_id: steps[index]?.id, selections }); await close('plain'); resolve({ status: 'dismissed' }); })(); }
      });
      function back(){ track('back', { step_id: steps[index].id }); show(visited.length ? visited.pop() : index - 1, -1); }
      /**
       * The phone's back control, as Escape does with one difference: on a step with steps behind it, it goes back one.
       * A step saving, or hidden under a guide it runs, stays where it is.
       */
      function pressBack(){
        if (host.hidden) return;
        if (welcome) leaveWelcome(true);
        else if (host.querySelector('.gxs-ask')) keepGoing();
        else if (doneWaiter && bookPane) showPricebook(false);
        else if (doneWaiter) { const go = doneWaiter; doneWaiter = null; go(); }
        else if (busy || mounted?.escape?.() === true) return;
        else if (mounted?.back?.() === true) return;
        else if (visited.length || index > first) back();
        else confirmSkip();
      }
      // Escape never reaches the page (the project window closes on it). A step that has something of its own open
      // (a dropdown, a full-screen preview) closes that first: its `escape()` returns true. On the window, ahead of the
      // portal's modal stack, which listens on the document and closed the project window first (FM-608).
      const onKey = (event) => { if (event.key === 'Escape' && !closed) { event.preventDefault(); event.stopPropagation(); if (welcome) { leaveWelcome(false); return; } if (!doneWaiter && !host.querySelector('.gxs-ask') && mounted?.escape?.() === true) return; if (doneWaiter && bookPane) showPricebook(false); else if (doneWaiter) { const go = doneWaiter; doneWaiter = null; go(); } else if (host.querySelector('.gxs-ask')) keepGoing(); else confirmSkip(); } };
      root.addEventListener('keydown', onKey, true);

      /** Closes the sheet. `handoff` flies the conversation to the project's agent tray, which opens with it. */
      async function close(mode){
        closed = true;
        livePlayers.delete(hotPlayer); stopHotEdits(); clearTimeout(hotTimer);
        // The sheet's history entries come off first, so whatever opens next adds its own after the page's.
        const unwound = backHistory?.release() || Promise.resolve();
        fitSize?.disconnect(); fitFill?.disconnect();
        root.removeEventListener('keydown', onKey, true);
        mounted?.destroy?.();
        if (mode === 'handoff') await flyToTray();
        else if (!reduced()) { host.classList.add('gxs-leaving'); await wait(320); }
        // The tray has its own instance on the same conversation; this one goes with the sheet.
        try { assistant?.destroy?.(); } catch (_) {}
        assistant = null;
        host.remove();
        releasePage();
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
        await unwound;
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
        // The card is laid out once at the tray's size. It starts aligned to the column's bottom right edge, clipped at
        // the top only, so the composer and right-aligned bubbles stay in view; nothing is clipped at the sides.
        const W = to.width, Hh = to.height;
        document.body.appendChild(chat);
        chat.classList.add('gxs-flying');
        Object.assign(chat.style, { position: 'fixed', left: `${to.left}px`, top: `${to.top}px`, width: `${W}px`, height: `${Hh}px`, maxHeight: 'none', margin: '0', zIndex: '2147483260', transformOrigin: '0 0', willChange: 'transform, clip-path', borderRadius: '0', transition: 'none' });
        const startX = from.right - W - to.left, startY = from.bottom - Hh - to.top;
        const clip = (rect) => rect === from ? `inset(${Math.max(0, Hh - from.height)}px 0px 0px 0px round 20px)` : 'inset(0px 0px 0px 0px round 0px)';
        // Placed where it is now before the first frame paints, so nothing jumps while the timeline starts.
        chat.style.transform = `translate(${startX}px, ${startY}px)`;
        chat.style.clipPath = clip(from);
        const frames = await new Promise((resolve) => requestAnimationFrame(() => {
          // Everything starts on this frame.
          if (content) content.style.transition = `grid-template-columns ${timing}`;
          if (tray) tray.style.transition = `opacity ${timing}, transform ${timing}`;
          openTray();
          const options = { duration: D, easing: EASE, fill: 'forwards' };
          resolve([
            chat.animate([{ transform: `translate(${startX}px, ${startY}px)`, clipPath: clip(from) }, { transform: 'translate(0px, 0px)', clipPath: clip(to) }], options),
            sheet.animate([{ clipPath: 'inset(0px round 20px)', opacity: 1 }, { clipPath: `inset(${from.top - box.top}px ${box.right - from.right}px ${box.bottom - from.bottom}px ${from.left - box.left}px round 20px)`, opacity: 0 }], options),
            scrim?.animate([{ opacity: getComputedStyle(scrim).opacity }, { opacity: 0 }], options)
          ].filter(Boolean));
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

      // Embedded: the container's owner took it away (Operations settings closed). It ends, neither done nor dismissed.
      const signal = container ? ctx.options?.signal : null;
      const abort = () => { if (closed) return; close('plain').then(() => resolve({ status: 'ended' }), () => resolve({ status: 'ended' })); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener?.('abort', abort, { once: true });
      if (welcome) showWelcome();
      else enter(index, 1, '');
      // The very first time, the scripted greeting already ran in enter(); a resumed setup says where it left off.
    });
  }

  // ── Widgets ────────────────────────────────────────────────────────────
  function registerWidget(id, widget){ widgets.set(id, widget); }
  /**
   * A step with its own code (widget `module`, docs/architecture/setup-steps.md): a browser ES module under /libraries/
   * on this site, loaded when the step first shows and mounted in the standard step frame. It exports
   * `mount(el, ctx)` and returns `{ valid(), hint(), summary(), answer(), escape(), destroy() }`, and with steps of its own
   * `handlesNavigation: true`, `back()` and `backDepth()` as the Operations workflow has them (`escape()` closes something
   * of its own, such as a dropdown, and returns true; otherwise Escape asks to close the setup). `ctx` is what every widget gets
   * (`step`, `options`, `answer`, `change(patch, summary)`, `advance()`, `setTitle(text)` (the title in the top bar while
   * the step shows something with a name of its own; empty restores the step's), `L`, `H`, `esc`, `actions`) plus `read(provider,
   * export, { path, args })`, a published data read as the person. The player saves `answer()` with the step's action.
   */
  // Every step module, by its path (no query): the loaded module, and the <style> elements it put in the page, so a
  // live change to the file can be imported again and drawn in place (hotModule below).
  const stepModules = new Map(), moduleStyles = new Map();
  const modulePath = (path) => { try { return new URL(clean(path), scriptUrl).pathname.replace(/^\//, ''); } catch (_) { return ''; } };
  function loadStepModule(path, fresh){
    const url = new URL(clean(path), scriptUrl);
    if (url.origin !== new URL(scriptUrl).origin || !url.pathname.startsWith('/libraries/')) return Promise.reject(new Error(L('gx_ui_widget_missing', 'This step cannot be shown here.')));
    const key = url.pathname.replace(/^\//, '');
    // A live change imports the file again under a new URL (the live layer serves it whatever the query).
    if (fresh) url.searchParams.set('hot', String(fresh).slice(0, 12) + '-' + Date.now().toString(36));
    if (fresh || !stepModules.has(key)) stepModules.set(key, import(url.href).catch((error) => { stepModules.delete(key); throw error; }));
    return stepModules.get(key);
  }
  /**
   * A flow's code: one ES module per setup (or setup step), declared once in FLOW_MODULES or by a step's `module`
   * path. It exports `mount(el, ctx)` (or `mountWidget(id, el, ctx)`) and returns its handle. Mounting records the
   * styles the module added, so a live edit takes them out before the new copy puts its own in. The place a module
   * kept (ctx.place.keep) before a live edit redrew it comes back as `ctx.place.restored`. `ctx.mountStep(el,
   * path, context)` mounts another step module inside this one through the same loader (the workforce setup's who page).
   */
  function mountModule(el, ctx, path, { id = '' } = {}){
    let disposed = false, handle = null;
    ctx = { ...ctx, mountStep: (target, nested, context) => mountModule(target, { ...ctx, place: null, ...object(context) }, nested) };
    const key = modulePath(path);
    el.dataset.gxModule = key;
    el.innerHTML = `<div class="gxs-module-loading"><span class="gxs-spin" aria-hidden="true"></span></div>`;
    const before = new Set(document.querySelectorAll('style'));
    loadStepModule(path).then((module) => {
      if (disposed) return;
      el.innerHTML = '';
      const mount = id && typeof module.mountWidget === 'function' ? (target, context) => module.mountWidget(id, target, context) : (module.mount || module.default);
      handle = mount?.(el, ctx) || {};
      const added = [...document.querySelectorAll('style')].filter((style) => !before.has(style));
      if (added.length) moduleStyles.set(key, added);
      ctx.change({});
    }).catch((error) => {
      if (disposed) return;
      console.warn('A setup step could not load its module.', error);
      el.innerHTML = `<p class="gxs-module-error" role="alert">${esc(L('gx_ui_step_load_failed', 'This step didn’t load. Close the setup and try again.'))}</p>`;
    });
    return {
      // Continue waits for the step's code to say its answer is complete.
      valid: () => !!handle && handle.valid?.() !== false,
      hint: () => handle?.hint?.() || '',
      summary: () => handle?.summary?.() || '',
      answer: () => handle?.answer?.(),
      escape: () => handle?.escape?.() === true,
      // A module with steps of its own (the document setup's first proposal, FM-614) is its own navigation, as the
      // Operations workflow is: the sheet's footer hides, and Back and the phone's back walk its steps first.
      handlesNavigation: () => handle?.handlesNavigation === true,
      back: () => handle?.back?.() === true,
      backDepth: () => Math.max(0, Number(handle?.backDepth?.()) || 0),
      destroy(){ disposed = true; handle?.destroy?.(); }
    };
  }
  /**
   * A step with its own code (widget `module`, docs/architecture/setup-steps.md): a browser ES module under /libraries/
   * on this site, loaded when the step first shows and mounted in the standard step frame. It exports
   * `mount(el, ctx)` and returns `{ valid(), hint(), summary(), answer(), escape(), destroy() }`, and with steps of its own
   * `handlesNavigation: true`, `back()` and `backDepth()` as the Operations workflow has them (`escape()` closes something
   * of its own, such as a dropdown, and returns true; otherwise Escape asks to close the setup). `ctx` is what every widget gets
   * (`step`, `options`, `answer`, `change(patch, summary)`, `advance()`, `setTitle(text)` (the title in the top bar while
   * the step shows something with a name of its own; empty restores the step's), `L`, `H`, `esc`, `actions`) plus `read(provider,
   * export, { path, args })`, a published data read as the person. The player saves `answer()` with the step's action.
   */
  registerWidget('module', { render(el, ctx){ return mountModule(el, ctx, ctx.step.module); } });
  /**
   * Every setup's code, by the widget id an experience's step names: the ONE list (with `widget: 'module'` and a step's
   * own `module` path, the only way a setup step is drawn). Each entry is one ES module loaded through loadStepModule,
   * swapped in place by a live edit, and saying where it is through ctx.place. `pages: false` is a step of one page;
   * otherwise the module has pages of its own, walked by Back and the phone's back (`handlesNavigation`). Add a setup
   * here, never as its own widget, loader or inline code in this file.
   * - operations-*: the Operations workflow (its first page is as tall as it is; the workflow and the ready page fill).
   * - comms-setup (FM-491, FM-510, GP-138), appointments-setup (FM-515, GP-85), equipment-setup (GP-15),
   *   workforce-setup (GP-28; a pay sheet calls the agent in), sales-team-setup (GP-144).
   * - the price book setup's steps (pricebook-setup.js).
   */
  const FLOW_MODULES = {
    'operations-path': { path: './operations-setup.js?v=20261123-places', fill: false },
    'operations-document': { path: './operations-setup.js?v=20261123-places', fill: true },
    'operations-ready': { path: './operations-setup.js?v=20261123-places', fill: true },
    'comms-setup': { path: './comms-setup.js?v=20261123-places' },
    'appointments-setup': { path: './appointments-setup.js?v=20261123-places' },
    'equipment-setup': { path: './equipment-setup.js?v=20261123-places' },
    'workforce-setup': { path: './workforce-setup.js?v=20261123-places' },
    'sales-team-setup': { path: './sales-team-setup.js?v=20261123-places' },
    // The price book setup: one page per step, its answers the player's selections.
    'roof-types': { path: './pricebook-setup.js?v=20261123-places', fill: true, pages: false },
    'brand-cards': { path: './pricebook-setup.js?v=20261123-places', fill: true, pages: false },
    'material-defaults': { path: './pricebook-setup.js?v=20261123-places', pages: false },
    'default-material': { path: './pricebook-setup.js?v=20261123-places', fill: true, pages: false },
    'supplier-columns': { path: './pricebook-setup.js?v=20261123-places', fill: true, pages: false },
    'labor-assignees': { path: './pricebook-setup.js?v=20261123-places', pages: false }
  };
  for (const [id, flow] of Object.entries(FLOW_MODULES)) registerWidget(id, {
    handlesNavigation: flow.pages !== false, fill: !!flow.fill,
    render(el, ctx){ return mountModule(el, ctx, flow.path, { id }); }
  });

  // ── Editing a setup live (docs/architecture/guided-experiences.md, "Editing a setup live") ──────────────────────
  // Development only: the live layer (live-assets.js) hands every changed script to `__fmHotHandlers`. A step module
  // an open setup shows is imported again and the step redrawn where it was; one not on screen is dropped from the
  // cache, so the next step that needs it loads the new copy. A signal file an agent writes while it works
  // (libraries/hot-edits/<experience id>.json, tools/live-layer/hot-edit.mjs) shows the working spinner beside the X;
  // when the agent says done, the setup's definition is read again and the step redrawn.
  const livePlayers = new Set();
  async function hotModule(path){
    const key = String(path || '').replace(/^\//, '');
    if (!stepModules.has(key)) return false;
    const showing = [...livePlayers].filter((player) => player.uses(key));
    moduleStyles.get(key)?.forEach((style) => style.remove());
    moduleStyles.delete(key);
    if (!showing.length) { stepModules.delete(key); return true; }
    await loadStepModule('/' + key, Date.now().toString(36)).catch(() => null);
    for (const player of showing) player.redraw();
    return true;
  }
  try { (root.__fmHotHandlers = root.__fmHotHandlers || []).push(hotModule); } catch (_) {}
  const HOT_DIR = 'libraries/hot-edits/';
  const HOT_MAX_AGE = 15 * 60 * 1000;
  /** The windows whose live layer this frame hears: its own, and the top page's (the page that holds the stream). */
  function liveWindows(){
    const list = [root];
    try { if (root.top && root.top !== root && root.top.document) list.push(root.top); } catch (_) {}
    return list;
  }
  /** Calls onSignal(signal | null) whenever the experience's hot-edit file appears, changes or goes away. */
  function watchHotEdits(id, onSignal){
    const file = HOT_DIR + String(id).replace(/[^A-Za-z0-9._-]/g, '_') + '.json'; // as tools/live-layer/hot-edit.mjs hotFile
    let last = null;
    async function read(sha){
      sha = sha || '';
      if (sha === last) return;
      const first = last === null;
      last = sha;
      if (!sha) { if (!first) onSignal(null); return; }
      try {
        const response = await fetch('/' + file + '?hot=' + sha.slice(0, 12), { cache: 'no-store', credentials: 'same-origin' });
        const signal = response.ok ? await response.json() : null;
        onSignal(signal && signal.state === 'working' && Date.now() - Date.parse(signal.at || 0) < HOT_MAX_AGE ? signal : null);
      } catch (_) { onSignal(null); }
    }
    const filesOf = (win) => { try { return win.FirstMateLiveAssets?.files?.() || null; } catch (_) { return null; } };
    const listeners = [];
    for (const win of liveWindows()) {
      const listener = (event) => {
        const detail = event.detail || {};
        if (detail.event === 'hello') read(filesOf(win)?.[file] || '');
        else if (Array.isArray(detail.files)) { const hit = detail.files.find((entry) => entry.path === file); if (hit) read(hit.sha || ''); }
      };
      try { win.addEventListener('fm:live-assets', listener); listeners.push([win, listener]); } catch (_) {}
      const files = filesOf(win);
      if (files) read(files[file] || '');
    }
    return () => listeners.forEach(([win, listener]) => { try { win.removeEventListener('fm:live-assets', listener); } catch (_) {} });
  }

  function register(){
    if (!G()?.registerKind) return false;
    G().registerKind('modal', player('modal'));
    G().registerKind('agentic', player('agentic'));
    return true;
  }
  if (!register()) root.addEventListener?.('DOMContentLoaded', register, { once: true });
  // choiceCss: the shared choice row, for a setup module drawn outside the player (its browser tests).
  /** Where the open setup is: { experience, step, page } (the dev tray puts it in an issue), or null. */
  const where = () => { const open = [...livePlayers].pop(); return open ? open.where() : null; };
  root.FirstMateGuidedSetup = { registerWidget, widgets: () => [...widgets.keys()], choiceCss, where, FLOW_MODULES };
})(window);
