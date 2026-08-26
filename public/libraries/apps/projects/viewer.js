/* public/libraries/apps/projects/viewer.js
 * Changes vs last:
 * - Sidebar logout: ultra low-profile, no border, sits at bottom of left column ABOVE the signed-in info (uses same vibe as left menu links)
 * - Status model: ONLY rejected / ready / processing (no "finalizing")
 * - Persist view mode (tiles|list|stages) to localStorage + restore on load
 * - Do NOT persist status/sort; ALSO: list-sort only affects list, tile-sort only affects tiles
 * - "Tip: In List view..." only shows when list view is active
 * - Modal: multiple downloads (Report.pdf, Summary.pdf, model_data.xml) w/ buttons when available
 *   - Uses FirstMeasure artifact routes only
 * - Tech notes display in modal sidebar
 * - Thumbnail loading shimmer + retry when image not yet generated
 * - MOBILE RESPONSIVE: full redesign for screens <= 820px without affecting desktop
 * - FIX: Modal close X is now a direct child of .v-modal (not .v-m-frame) so it
 *   remains visible when resizing from desktop to mobile without a page reload
 */
(function(){
  if (!window.Portal) return;

  const { $, escapeHtml, injectCSS, formatDate, postAction, enableSafeBackdropClose, fmJson, fmPost, fmUrl, googleMapsApiKey, currentActor } = window.Portal.util;

  const LS_VIEW_KEY = 'fm_viewer_view_v1';
  const VIEW_MODES = new Set(['tiles', 'list', 'stages']);
  const STAGES_VIEW_FLAG = { group: 'platform', flag: 'project_stages_view' };
  const INSTANT_PITCH_UI_ENABLED = false;
  const INSTANT_WALL_SLOPE_DEGREES_THRESHOLD = 80;
  const INSTANT_WALL_MIN_HEIGHT_METERS = 0.6;
  const INSTANT_WALL_MASK_EXPANSION_RADIUS = 1;
  const INSTANT_WALL_SOFT_GRAY = { r: 102, g: 106, b: 112, a: 255 };
  const PDF_PREVIEW_QUERY_FLAGS = ['disablePdfPreview', 'mobileDebug', 'noPdfPreview'];

  function queryFlagEnabled(names){
    try {
      const params = new URLSearchParams(window.location.search || '');
      return names.some((name) => {
        if (!params.has(name)) return false;
        const value = String(params.get(name) || '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(value);
      });
    } catch (error) {
      return false;
    }
  }

  const pdfPreviewDisabled = queryFlagEnabled(PDF_PREVIEW_QUERY_FLAGS);

  function stagesViewEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    return !!flags.has?.(STAGES_VIEW_FLAG.group, STAGES_VIEW_FLAG.flag);
  }

  function normalizeViewMode(mode){
    const clean = VIEW_MODES.has(mode) ? mode : 'tiles';
    return clean === 'stages' && !stagesViewEnabled() ? 'tiles' : clean;
  }

  function fmtMoney(value){
    if (window.Portal?.pricing?.formatMoney) return window.Portal.pricing.formatMoney(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const amount = Math.round(n * 100) / 100;
    return amount % 1 === 0 ? String(amount.toFixed(0)) : amount.toFixed(2);
  }

  function buildCoverageRejectionDisclaimer(p) {
    const instantMiss = String(p?.instant_rejection_reason || '').trim().toLowerCase() === 'no_structure_at_pin';
    const noCoverageHtml =
      `We do not currently have coverage for this address. ` +
      `We currently cover 95% of all buildings in the United States and we are actively working on increasing our area to cover more of the remaining buildings. ` +
      `We've logged your interest in structures like this and will prioritize being able to cover these in the near future. ` +
      `We apologize for any inconvenience this may have caused.<br><br>` +
      `<strong>Note:</strong> Our coverage is based on individual structure, not area - so we may have coverage for other properties in this same neighborhood.`;
    const projectTypeLabel = (() => {
      const type = String(p?.project_type || 'residential').trim().toLowerCase().replace(/_/g, '-');
      if (type === 'multi-family' || type === 'multifamily') return 'multi-family';
      if (type === 'commercial') return 'commercial';
      return 'residential';
    })();
    const reorder = (p?.rejection_reorder && typeof p.rejection_reorder === 'object') ? p.rejection_reorder : {};
    const correctProjectTypeLabel = (() => {
      const type = String(p?.correct_project_type || p?.rejection_correct_project_type || reorder.project_type || '').trim().toLowerCase().replace(/_/g, '-');
      if (type === 'multi-family' || type === 'multifamily') return 'multi-family';
      if (type === 'commercial') return 'commercial';
      return '';
    })();
    const rejectionReason = String(p?.rejection_reason || '').trim().toLowerCase();
    let html = String(p?.customer_rejection_message || '')
      .replace(/,\s*and the reorder link opens the same order with [^.]+ selected\./gi, '.')
      .replace(/\s+and the reorder link opens the same order with [^.]+ selected\./gi, '.')
      .replace(/\s+/g, ' ')
      .trim();
    if (html) {
      html = escapeHtml(html);
    } else {
      html = instantMiss
      ? (
          `We could not generate a FirstMeasure Instant for this pin because the selected point did not land on a structure with accurate instant data. ` +
          `We currently have about 90% coverage across the US for instant reports, but there are still some places where we do not have accurate enough data for this product.<br><br>` +
          `<strong>Note:</strong> This only affects the instant report for this pinned structure. You can still order a standard full report for this property below.`
        )
      : noCoverageHtml;
    }

    if (!instantMiss && !p?.customer_rejection_message) {
      if (rejectionReason === 'obscured_visibility') {
        html =
          `We were not able to complete this report because the structure is too obscured in the available imagery. ` +
          `This can happen when trees, shadows, image quality, or other visual obstructions prevent us from confidently identifying and measuring the roof. ` +
          `We apologize for any inconvenience this may have caused.`;
      } else if (rejectionReason === 'invalid_pin_placement') {
        html =
          `We were not able to complete this report because the selected pin does not appear to be placed on a structure we can measure. ` +
          `This can happen if the pin is on a yard, driveway, nearby object, or a structure that does not have enough usable imagery for accurate measurement. ` +
          `We apologize for any inconvenience this may have caused.`;
      } else if (rejectionReason === 'incorrect_structure_type') {
        html =
          `We were not able to complete this report because the selected structure does not match the project type that was ordered. ` +
          `This order was submitted as a ${escapeHtml(projectTypeLabel)} project, but it appears to require a ${escapeHtml(correctProjectTypeLabel || 'different')} report. ` +
          `We have reimbursed the original report.`;
      }
    }

    if (p && p.refund_issued && p.refund_amount && parseInt(p.refund_amount, 10) > 0) {
      const amt = parseInt(p.refund_amount, 10);
      html += `<div style="margin:12px 0 0; padding:10px 14px; background:#fce8e6; border:1px solid #f4b4ae; border-radius:8px; color:#7a1b18; font-weight:600;">` +
        `A credit of $${amt} has been refunded to your account for this order.` +
        `</div>`;
    } else if (p && p.refund_pending) {
      html += `<div style="margin:12px 0 0; padding:10px 14px; background:#fff8e1; border:1px solid #f4d58d; border-radius:8px; color:#7a5b00; font-weight:600;">` +
        `We are returning a credit for this instant order.` +
        `</div>`;
    }

    return html;
  }

  function rejectedReorderButtonHtml(p){
    const reorder = (p?.rejection_reorder && typeof p.rejection_reorder === 'object') ? p.rejection_reorder : {};
    const type = String(p?.correct_project_type || p?.rejection_correct_project_type || reorder.project_type || '').trim().toLowerCase().replace(/_/g, '-');
    const normalized = type === 'multi-family' ? 'multifamily' : type;
    if (!['commercial', 'multifamily'].includes(normalized)) return '';
    const label = normalized === 'multifamily' ? 'Multi-family' : 'Commercial';
    return `<div style="margin-top:14px;"><button type="button" id="vmRejectedReorder" class="v-dlbtn"><i class="fas fa-cart-plus"></i> Reorder as ${escapeHtml(label)}</button></div>`;
  }

  function openRejectedReorder(p){
    const reorder = (p?.rejection_reorder && typeof p.rejection_reorder === 'object') ? p.rejection_reorder : {};
    const sourceProjectId = String(reorder.source_project_id || p?.folder || p?.project_id || p?.measurement_project?.id || p?.measurement?.id || '').trim();
    const type = String(p?.correct_project_type || p?.rejection_correct_project_type || reorder.project_type || '').trim().toLowerCase().replace(/_/g, '-');
    const normalized = type === 'multi-family' ? 'multifamily' : type;
    if (!sourceProjectId || !['commercial', 'multifamily'].includes(normalized)) return;
    const platformProject = (p?.platform_project && typeof p.platform_project === 'object') ? p.platform_project : {};
    const baseProject = normalizeProjectRecord({
      ...p,
      ...platformProject,
      address: platformProject.address || p.address || p.project_address || '',
      lat: platformProject.lat ?? p.lat ?? p.latitude ?? null,
      lng: platformProject.lng ?? p.lng ?? p.longitude ?? null,
      pins: Array.isArray(platformProject.pins) && platformProject.pins.length
        ? platformProject.pins
        : (Array.isArray(p.pins) ? p.pins : []),
      cc_emails: Array.isArray(platformProject.cc_emails) ? platformProject.cc_emails : (Array.isArray(p.cc_emails) ? p.cc_emails : []),
      tech_notes: platformProject.tech_notes ?? p.tech_notes ?? '',
      measurement: {
        ...(platformProject.measurement || {}),
        ...(p.measurement || {})
      },
      measurement_project: {
        ...(platformProject.measurement_project || {}),
        ...(p.measurement_project || {})
      }
    });
    if (window.Portal?.modules?.request?.openProject) {
      window.Portal.modules.request.openProject({
        ...baseProject,
        project_type: normalized,
        reorder_source_project_id: sourceProjectId,
        correct_project_type: normalized,
        measurement: {
          ...(baseProject.measurement || p.measurement || {}),
          id: sourceProjectId,
          folder: sourceProjectId,
          status: 'rejected_no_coverage',
          correct_project_type: normalized
        },
        measurement_project: {
          ...(baseProject.measurement_project || p.measurement_project || {}),
          id: sourceProjectId,
          folder: sourceProjectId,
          status: 'rejected_no_coverage',
          correct_project_type: normalized
        }
      }, { fromReorder: true });
      return;
    }
    const url = String(p?.reorder_url || reorder.url || '').trim();
    if (url) window.location.href = url;
  }

  async function ensureInstantRejectionRefund(project){
    if (!project || !project.refund_pending || project.refund_issued) return false;
    try {
      await postAction('refund_instant_rejection', {
        project_id: String(project.id || ''),
        project_type: String(project.project_type || 'residential'),
        address: String(project.address || ''),
        charge_token: String(project.charge_token || project.billing?.charge_token || ''),
        refund_amount: Number(project.refund_amount ?? project.amount_charged ?? 0),
        report_mode: String(project.report_mode || (project.instant_only ? 'instant' : (project.instant_enabled ? 'both' : 'full')) || 'instant'),
        refund_reason: String(project.refund_reason || 'instant_no_coverage')
      });
      project.refund_pending = false;
      project.refund_issued = true;
      project.refund_amount = Number(project.refund_amount ?? project.amount_charged ?? 0);
      try { await window.Portal?.credits?.refreshCredits?.(); } catch(e){}
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  function cancellationRefundAmount(p){
    if (!p || typeof p !== 'object') return 0;
    const cancellation = (p.cancellation && typeof p.cancellation === 'object') ? p.cancellation : {};
    const decision = String(p.cancellation_refund_decision || cancellation.refund_decision || '').trim().toLowerCase();
    const refunded = decision === 'refunded' || !!p.cancellation_refunded;
    const amountRaw = p.cancellation_refund_amount ?? cancellation.refund_amount ?? p.refund_amount ?? null;
    const amount = parseInt(amountRaw, 10);
    if (!refunded || !Number.isFinite(amount) || amount <= 0) return 0;
    return amount;
  }

  function buildCancellationDisclaimer(p){
    const refundedAmount = cancellationRefundAmount(p);
    let html =
      `This project has been cancelled. No further work will be completed for this request.`;

    if (refundedAmount > 0) {
      html += `<div style="margin:12px 0 0; padding:10px 14px; background:#e6f4ea; border:1px solid #c8e6c9; border-radius:8px; color:#137333; font-weight:600;">` +
        `A credit of $${refundedAmount} has been refunded to your account for this cancelled order.` +
        `</div>`;
    }

    return html;
  }

  function normalizeCustomerReworkType(value){
    const key = String(value || '').trim().toLowerCase();
    if (key === 'additional_structure') return 'additional_structure';
    if (key === 'change_correction' || key === 'correction' || key === 'change') return 'change_correction';
    if (key === 'report_issue' || key === 'issue') return 'report_issue';
    return key;
  }

  function customerReworkTypeLabel(value){
    const key = normalizeCustomerReworkType(value);
    if (key === 'additional_structure') return 'additional structure request';
    if (key === 'change_correction') return 'change/correction request';
    return 'rework request';
  }

  function latestReportChangeRequest(p){
    if (p?.latest_report_change_request && typeof p.latest_report_change_request === 'object') return p.latest_report_change_request;
    const requests = Array.isArray(p?.report_change_requests) ? p.report_change_requests : [];
    return requests.length ? requests[requests.length - 1] : null;
  }

  function completedCustomerReworkMeta(p){
    if (!p || typeof p !== 'object') return { completed: false, label: '', completedAt: '' };
    const latest = latestReportChangeRequest(p);
    const latestStatus = String(latest?.status || '').trim().toLowerCase();
    const hasCompletedMarker = !!p.customer_rework_completed_at
      || !!p.customer_rework_completed_request_id
      || (latestStatus === 'completed' && normalizeCustomerReworkType(latest?.type || latest?.request_type) !== 'report_issue');
    if (!hasCompletedMarker) return { completed: false, label: '', completedAt: '' };
    const type = normalizeCustomerReworkType(
      p.customer_rework_completed_type
      || latest?.type
      || latest?.request_type
      || p.customer_rework_request_type
    );
    return {
      completed: true,
      label: p.customer_rework_completed_label || latest?.label || customerReworkTypeLabel(type),
      completedAt: p.customer_rework_completed_at || latest?.completed_at || ''
    };
  }

  function activeCustomerReworkMeta(p){
    if (!p || typeof p !== 'object') return { active: false, label: '', requestedAt: '', type: '' };
    const latest = latestReportChangeRequest(p);
    const type = normalizeCustomerReworkType(
      latest?.type
      || latest?.request_type
      || p.customer_rework_request_type
      || p.rework_request_type
    );
    if (!type || type === 'report_issue') return { active: false, label: '', requestedAt: '', type: '' };
    const status = String(latest?.status || p.status || '').trim().toLowerCase();
    const activeStatuses = new Set([
      'pending_review',
      'rework_requested',
      'customer_rework_requested',
      'reworking',
      'submitted_to_qa',
      'awaiting_review',
      'awaiting_manager_review'
    ]);
    const inactiveStatuses = new Set(['completed', 'finalized', 'rejected', 'cancelled', 'canceled', 'sent_to_support']);
    const active = !inactiveStatuses.has(status) && (
      activeStatuses.has(status)
      || !!p.rework_requested_at
      || !!p.customer_rework_in_qa
    );
    if (!active) return { active: false, label: '', requestedAt: '', type: '' };
    return {
      active: true,
      label: latest?.label || customerReworkTypeLabel(type),
      requestedAt: latest?.created_at || latest?.requested_at || p.rework_requested_at || '',
      type
    };
  }

  function pendingCustomerReworkNoticeHtml(p){
    const meta = activeCustomerReworkMeta(p);
    if (!meta.active) return '';
    const dateText = meta.requestedAt ? ` Requested ${formatDate(meta.requestedAt)}.` : '';
    return `<div class="v-side-chip change-pending"><i class="fas fa-clock-rotate-left"></i><span>Changes pending: ${escapeHtml(meta.label)}.${dateText} Your current PDFs remain available until the updated report is ready.</span></div>`;
  }

  function pendingCustomerReworkPanelHtml(p){
    const meta = activeCustomerReworkMeta(p);
    if (!meta.active) return '';
    return `
      <h4 style="margin:14px 0 10px; display:flex; align-items:center; gap:10px; padding-right:30px;"><i class="fas fa-clock-rotate-left" style="color:#7a4b00;"></i> Changes Pending</h4>
      <div style="font-size:12px; color:#5f4520; line-height:1.4; padding:10px 12px; border:1px solid #f4d58d; background:#fff8e1; border-radius:12px;">
        <strong>${escapeHtml(meta.label)}</strong>${meta.requestedAt ? ` was requested ${escapeHtml(formatDate(meta.requestedAt))}.` : ' is being reviewed.'}
        <br><br>Your existing report PDFs are still available in the report tabs. Updated PDFs will replace them after the rework is finalized.
      </div>
    `;
  }

  function correctedReportNoticeHtml(p){
    const meta = completedCustomerReworkMeta(p);
    if (!meta.completed) return '';
    const dateText = meta.completedAt ? ` Finalized ${formatDate(meta.completedAt)}.` : '';
    return `<div class="v-side-chip corrected"><i class="fas fa-screwdriver-wrench"></i><span>Corrected report PDFs are ready.${dateText}</span></div>`;
  }

  const ViewerCSS = `
    .v-wrap{max-width:1500px; margin:0 auto; height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden}
    .v-head{display:flex; align-items:flex-start; justify-content:space-between; gap:14px; margin-bottom:14px; flex:0 0 auto}
    .v-title{display:flex; flex-direction:column; gap:2px}
    .v-title h1{margin:0; font-size:22px; font-weight:1000; letter-spacing:-.3px}
    .v-title .sub{margin:0; color:#777; font-weight:850; font-size:12px}
    .v-actions{display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end}
    .v-btn{background:#fff; border:1px solid rgba(0,0,0,0.10); padding:10px 12px; border-radius:14px; cursor:pointer; font-weight:950; color:#333; display:inline-flex; align-items:center; gap:8px; transition:.16s ease; user-select:none}
    .v-btn[hidden]{display:none!important}
    .v-btn:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.45); color:var(--primary-readable, var(--primary,#d93025)); transform:translateY(-1px)}
    .v-btn.active{border-color:rgba(var(--primary-rgb,217,48,37),0.55); box-shadow:0 10px 22px rgba(var(--primary-rgb,217,48,37),0.16)}
    .v-pill{border-radius:999px; padding:10px 14px}
    .v-searchwrap{position:relative; display:flex; align-items:center; gap:10px}
    .v-search{width:min(420px, 62vw); background:#fff; border:1px solid rgba(0,0,0,0.10); border-radius:999px; padding:11px 14px 11px 40px; font-weight:900; outline:none; transition:.16s ease}
    .v-search:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.55); box-shadow:0 10px 22px rgba(var(--primary-rgb,217,48,37),0.16)}
    .v-searchicon{position:absolute; left:14px; color:#777}
    .v-clear{position:absolute; right:10px; width:30px; height:30px; border-radius:999px; display:none; align-items:center; justify-content:center; cursor:pointer; color:#666; border:1px solid rgba(0,0,0,0.10); background:#fff; transition:.16s ease}
    .v-clear:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.45); color:var(--primary-readable, var(--primary,#d93025))}
    .v-suggest{position:absolute; top:46px; right:0; width:min(520px, 86vw); background:#fff; border:1px solid rgba(0,0,0,0.10); border-radius:14px; box-shadow:0 18px 46px rgba(0,0,0,0.14); overflow:hidden; display:none; z-index:50}
    .v-suggest .it{padding:10px 12px; cursor:pointer; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; border-top:1px solid rgba(0,0,0,0.06)}
    .v-suggest .it:first-child{border-top:none}
    .v-suggest .it:hover{background:#f8f9fa}
    .v-suggest .a1{font-weight:1000; font-size:13px; line-height:1.2}
    .v-suggest .a2{font-weight:850; font-size:11px; color:#777; margin-top:3px}
    .v-suggest .meta{font-weight:1000; font-size:11px; color:#999; white-space:nowrap; margin-top:1px}
    .v-suggest .tag{font-weight:1000; font-size:10px; letter-spacing:.3px; text-transform:uppercase; padding:4px 8px; border-radius:999px; border:1px solid rgba(0,0,0,0.10); color:#666; background:#fff}
    .v-bar{display:flex; align-items:center; justify-content:space-between; gap:12px; margin:12px 0 12px; flex:0 0 auto}
    .v-leftbar{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
    .v-rightbar{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
    .v-chip{display:inline-flex; align-items:center; gap:8px; background:#fff; border:1px solid rgba(0,0,0,0.10); border-radius:14px; padding:9px 10px; font-weight:950; color:#333}
    .v-chip select{border:none; outline:none; font-weight:950; background:transparent; color:#333; padding:2px 2px}
    .v-toggle-chip{cursor:pointer; user-select:none; font-size:12px; line-height:1}
    .v-toggle-chip input{position:absolute; opacity:0; pointer-events:none}
    .v-toggle-track{width:34px; height:20px; border-radius:999px; background:#d0d5dd; position:relative; flex-shrink:0; transition:.16s ease}
    .v-toggle-track::after{content:''; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:999px; background:#fff; box-shadow:0 2px 6px rgba(15,23,42,.18); transition:.16s ease}
    .v-toggle-chip input:checked + .v-toggle-track{background:var(--primary,#d93025)}
    .v-toggle-chip input:checked + .v-toggle-track::after{transform:translateX(14px)}
    .v-toggle-chip span:last-child{font-size:12px; font-weight:950; color:#333}
    .v-count{font-weight:1000; color:#666; font-size:12px}
    .v-tip{font-weight:900; color:#999; font-size:12px; display:none}
    #vResults{flex:1 1 auto; min-height:0; overflow:hidden}
    .v-grid{height:100%; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch; display:grid; align-content:start; grid-auto-rows:max-content; grid-template-columns:repeat(auto-fill, minmax(290px, 1fr)); gap:16px; padding:2px 2px 16px}
    .v-tile{background:#fff; border:1px solid rgba(0,0,0,0.06); border-radius:18px; overflow:hidden; box-shadow:0 14px 34px rgba(0,0,0,0.08); cursor:pointer; display:flex; flex-direction:column; transition:.20s ease; position:relative}
    .v-tile:hover{transform:translateY(-3px); box-shadow:0 20px 44px rgba(0,0,0,0.12)}
    .v-thumb{height:168px; background:#eef0f3; position:relative}
    .v-thumb img{width:100%; height:100%; object-fit:cover; display:block}
    .v-thumb.loading{display:flex; align-items:center; justify-content:center; background:linear-gradient(110deg,#e8eaed 30%,#f3f4f6 50%,#e8eaed 70%); background-size:200% 100%; animation:vShimmer 1.4s ease infinite}
    @keyframes vShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .v-thumb.loading img{display:none}
    .v-thumb.loading::after{content:'\\f110'; font-family:'Font Awesome 6 Free'; font-weight:900; font-size:22px; color:rgba(0,0,0,0.22); animation:fa-spin 1s linear infinite}
    .v-badge{position:absolute; top:10px; right:10px; padding:6px 10px; border-radius:999px; font-size:11px; font-weight:1000; text-transform:uppercase; letter-spacing:.3px; box-shadow:0 6px 16px rgba(0,0,0,0.18)}
    .v-addon-badge{position:absolute; left:10px; bottom:10px; z-index:3; pointer-events:none; padding:6px 10px; border-radius:999px; font-size:10px; font-weight:1000; letter-spacing:.3px; text-transform:uppercase; color:#fff; background:rgba(26,115,232,0.96); border:1px solid rgba(17,86,173,0.32); box-shadow:0 6px 16px rgba(0,0,0,0.16); display:inline-flex; align-items:center; gap:6px}
    .b-ready{background:#34a853; color:#fff}
    .b-pending{background:#fbbc04; color:#222}
    .b-rej{background:#d93025; color:#fff}
    .b-cancel{background:#5f6368; color:#fff}
    .b-draft{background:#667085; color:#fff}
    .v-body{padding:14px 14px 12px; display:flex; flex-direction:column; gap:8px; flex:1}
    .v-addr{font-weight:1000; font-size:14px; line-height:1.25}
    .v-addr .l2{font-size:12px; color:#777; font-weight:850; margin-top:3px}
    .v-meta{font-size:12px; color:#666; font-weight:850; display:flex; align-items:center; gap:8px; flex-wrap:wrap}
    .v-foot{margin-top:auto; display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#999; font-weight:850; padding-top:6px}
    .v-foot .cta{color:var(--primary-readable, var(--primary,#d93025)); font-weight:1000}
    .v-type-badge{position:absolute; top:44px; left:10px; padding:5px 9px; border-radius:999px; font-size:10px; font-weight:1000; letter-spacing:.3px; text-transform:uppercase; box-shadow:0 4px 12px rgba(0,0,0,0.18); color:#fff}
    .v-type-badge.no-delivery{top:10px}
    .v-type-res{background:rgba(0,0,0,0.50)}
    .v-type-com{background:rgba(0,0,0,0.50)}
    .v-type-mf{background:rgba(0,0,0,0.50)}
    .v-meta-tags{display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:2px}
    .v-meta-tag{font-size:10px; font-weight:1000; padding:3px 8px; border-radius:999px; border:1px solid rgba(0,0,0,0.08); color:#555; background:#f8f9fa; display:inline-flex; align-items:center; gap:5px}
    .v-meta-tag-addon{background:#fff4db; color:#8a5a00; border-color:rgba(171,123,0,0.18)}
    .v-meta-tag-expedite{background:#fff7d6; color:#7a5b00; border-color:rgba(251,188,4,0.38)}
    .v-m-details{margin-bottom:16px}
    .v-m-details .v-detail-row{display:flex; align-items:flex-start; gap:10px; margin-top:8px}
    .v-m-details .v-detail-label{font-size:10px; font-weight:1000; color:#777; letter-spacing:.4px; text-transform:uppercase; min-width:80px; padding-top:2px}
    .v-m-details .v-detail-val{font-size:13px; font-weight:850; color:#222; flex:1}
    .v-type-pill{display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:1000; color:#fff}
    .v-cc-chip{display:inline-block; padding:3px 8px; border-radius:6px; background:#f1f3f4; font-size:11px; font-weight:850; color:#333; margin:2px 4px 2px 0}
    .v-pin-chip{display:inline-block; padding:3px 8px; border-radius:6px; background:#e8f0fe; font-size:10px; font-weight:850; color:#1a73e8; margin:2px 4px 2px 0}
    .v-m-foot{display:flex; flex-direction:column; gap:12px}
    .v-m-foot .v-dlwrap{margin:0; gap:10px}
    .v-list{height:100%; min-height:0; background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:18px; overflow:hidden; box-shadow:0 14px 34px rgba(0,0,0,0.08); display:flex; flex-direction:column}
    .v-lhead{display:grid; grid-template-columns: 160px 1.7fr 1fr 190px; gap:0; align-items:center}
    .v-lrow{display:grid; grid-template-columns: 160px 1.7fr 1fr 190px; gap:0; align-items:center}
    .v-lhead{background:#f8f9fa; border-bottom:1px solid rgba(0,0,0,0.08); position:sticky; top:0; z-index:2}
    .v-lcell{padding:12px 14px; font-weight:950; font-size:12px; color:#444; user-select:none}
    .v-lcell.sortable{cursor:pointer}
    .v-lcell.sortable:hover{color:var(--primary-readable, var(--primary,#d93025))}
    .v-lcell .sicon{margin-left:8px; color:#999}
    .v-lscroll{flex:1 1 auto; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch}
    .v-lrow{border-top:1px solid rgba(0,0,0,0.06); cursor:pointer}
    .v-lrow:hover{background:#fafbfc}
    .v-lrow .v-lcell{font-weight:900; color:#333; font-size:12px}
    .v-laddr1{font-weight:1000; font-size:13px; line-height:1.2}
    .v-laddr2{font-weight:850; font-size:11px; color:#777; margin-top:3px}
    .v-statuspill{display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; font-weight:1000; font-size:11px; letter-spacing:.3px; text-transform:uppercase; width:fit-content}
    .v-statuspill i,.v-badge i{font-size:.95em}
    .v-stages-shell{height:100%; min-height:0; display:flex; flex-direction:column; gap:10px; padding-bottom:0}
    .v-stages-summary{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 2px 2px}
    .v-stages-kicker{display:inline-flex; align-items:center; gap:8px; color:#667085; font-size:12px; font-weight:950}
    .v-stages-kicker strong{color:#1f2937; font-weight:1000}
    .v-stages-board{flex:1 1 auto; min-height:0; display:grid; grid-auto-flow:column; grid-auto-columns:minmax(270px, 1fr); gap:12px; overflow-x:auto; overflow-y:hidden; padding:2px 2px 12px; scroll-snap-type:x proximity; scrollbar-width:thin}
    .v-stage-col{min-width:270px; min-height:0; border:1px solid rgba(15,23,42,0.08); border-radius:16px; background:linear-gradient(180deg, #fff 0%, #f8fafc 100%); box-shadow:0 10px 24px rgba(15,23,42,0.06); display:flex; flex-direction:column; scroll-snap-align:start; overflow:hidden}
    .v-stage-head{flex:0 0 auto; z-index:1; background:rgba(255,255,255,0.92); backdrop-filter:blur(10px); padding:12px 12px 10px; border-bottom:1px solid rgba(15,23,42,0.07)}
    .v-stage-title-row{display:flex; align-items:center; justify-content:space-between; gap:10px}
    .v-stage-title{display:flex; align-items:center; gap:8px; min-width:0; font-size:12px; font-weight:1000; color:#1f2937; letter-spacing:0}
    .v-stage-title span{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .v-stage-icon{width:26px; height:26px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; color:var(--primary-readable, var(--primary,#d93025)); background:rgba(var(--primary-rgb,217,48,37),0.08); border:1px solid rgba(var(--primary-rgb,217,48,37),0.14); flex-shrink:0}
    .v-stage-count{display:inline-flex; align-items:center; justify-content:center; min-width:26px; height:24px; border-radius:999px; padding:0 8px; background:#eef2f7; color:#536071; font-size:11px; font-weight:1000}
    .v-stage-progress{display:flex; gap:4px; margin-top:10px}
    .v-stage-tick{height:3px; border-radius:999px; flex:1; background:#e5e7eb}
    .v-stage-tick.done{background:rgba(52,168,83,0.82)}
    .v-stage-tick.current{background:#fbbc04}
    .v-stage-list{display:flex; flex-direction:column; gap:7px; padding:9px; min-height:0; flex:1 1 auto; overflow:auto; -webkit-overflow-scrolling:touch}
    .v-stage-load{flex:0 0 auto; border:1px dashed rgba(15,23,42,0.12); border-radius:10px; padding:8px 10px; background:#f8fafc; color:#667085; font-size:11px; font-weight:950; text-align:center}
    .v-stage-load.done{display:none}
    .v-stage-card{appearance:none; border:1px solid rgba(15,23,42,0.08); border-radius:10px; padding:8px 10px; background:#fff; box-shadow:0 6px 14px rgba(15,23,42,0.045); cursor:pointer; text-align:left; transition:.16s ease; display:flex; flex-direction:column; gap:4px}
    .v-stage-card:hover{transform:translateY(-2px); border-color:rgba(var(--primary-rgb,217,48,37),0.26); box-shadow:0 14px 28px rgba(15,23,42,0.10)}
    .v-stage-name{min-width:0; color:#18222d; font-size:13px; font-weight:1000; line-height:1.15; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .v-stage-addr{min-width:0; font-size:12px; font-weight:900; color:#425466; line-height:1.2}
    .v-stage-addr .l2{display:block; margin-top:1px; color:#768293; font-size:11px; font-weight:850}
    .v-stage-card-foot{display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:1px; color:#98a2b3; font-size:10px; font-weight:900}
    .v-stage-empty{margin:auto; padding:22px 10px; text-align:center; color:#98a2b3; font-size:12px; font-weight:900; line-height:1.35}
    .v-stage-empty i{display:block; margin-bottom:8px; color:#c7ced8}
    .sp-ready{background:rgba(52,168,83,0.12); color:#137333; border:1px solid rgba(52,168,83,0.24)}
    .sp-pending{background:rgba(251,188,4,0.15); color:#7a5b00; border:1px solid rgba(251,188,4,0.28)}
    .sp-rej{background:rgba(217,48,37,0.12); color:#a50e0e; border:1px solid rgba(217,48,37,0.22)}
    .sp-cancel{background:rgba(95,99,104,0.14); color:#3c4043; border:1px solid rgba(95,99,104,0.24)}
    .sp-draft{background:rgba(102,112,133,0.13); color:#344054; border:1px solid rgba(102,112,133,0.24)}
    .v-overlay{position:fixed; inset:0; background:rgba(0,0,0,0.60); backdrop-filter: blur(3px); display:none; align-items:center; justify-content:center; z-index:2147483100; opacity:0; transition:opacity .16s ease}
    .v-overlay.active{display:flex; opacity:1}
    .v-modal{width:min(1720px, 96vw); height:min(1180px, 92vh); background:#fff; border-radius:24px; overflow:hidden; box-shadow:0 30px 90px rgba(0,0,0,0.50); display:flex; position:relative; animation:vUp .18s ease-out}
    @keyframes vUp{from{transform:translateY(16px); opacity:0}to{transform:translateY(0); opacity:1}}
    .v-m-side{width:420px; max-width:42%; background:#fff; border-right:1px solid rgba(15,23,42,0.08); display:flex; flex-direction:column}
    .v-m-head{padding:24px 24px 14px; border-bottom:1px solid rgba(15,23,42,0.08)}
    .v-m-title{font-weight:1000; font-size:16px; margin:0 0 8px}
    .v-m-status{font-weight:1000; font-size:12px; letter-spacing:.4px}
    .v-m-body{padding:18px 24px; overflow:auto; flex:1}
    .v-k{font-size:11px; font-weight:1000; color:#777; letter-spacing:.4px; text-transform:uppercase}
    .v-v{font-size:13px; font-weight:850; color:#222; margin-top:6px}
    .v-item{margin-bottom:16px}
    .v-customerInput{width:100%; border:1px solid rgba(17,24,39,0.12); border-radius:12px; background:#fff; padding:10px 12px; font:inherit; font-size:13px; font-weight:850; color:#18222d; outline:none; transition:border-color .16s ease, box-shadow .16s ease}
    .v-customerInput:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.48); box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),0.12)}
    .v-customerRow{margin-top:4px}
    .v-customerSave{appearance:none; border:none; border-radius:12px; width:100%; padding:10px 12px; background:var(--primary,#d93025); color:var(--on-primary,#fff); font-size:12px; font-weight:1000; cursor:pointer; transition:.16s ease}
    .v-customerSave:hover:not([disabled]){background:var(--primary-dark,#b0261e); transform:translateY(-1px)}
    .v-customerSave[disabled]{opacity:.6; cursor:not-allowed; transform:none}
    .v-dlwrap{display:flex; flex-direction:column; gap:10px; margin-top:14px}
    .v-dlbtn{background:var(--primary,#d93025); color:var(--on-primary, #fff); text-decoration:none; padding:12px 12px; border-radius:14px; font-size:12px; font-weight:1000; display:flex; align-items:center; justify-content:center; gap:8px; transition:.16s ease}
    button.v-dlbtn{appearance:none; border:none; cursor:pointer; width:100%}
    .v-dlbtn:hover{background:var(--primary-dark,#b0261e)}
    .v-dlbtn.secondary{background:#fff; color:#333; border:1px solid rgba(0,0,0,0.12)}
    .v-dlbtn.secondary:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.45); color:var(--primary-readable, var(--primary,#d93025))}
    .v-dlbtn.disabled{opacity:.45; pointer-events:none}
    .v-m-foot{padding:18px 24px; border-top:1px solid rgba(15,23,42,0.08); display:flex; flex-direction:column; gap:10px}
    .v-side-actions{display:flex; flex-direction:column; gap:10px}
    .v-side-chip{display:flex; align-items:center; gap:8px; padding:12px 13px; border-radius:14px; background:#edf2f7; color:#1b2430; font-size:12px; font-weight:900; border:1px solid rgba(0,0,0,0.08)}
    .v-side-chip.pending i{animation:fa-spin 1.3s linear infinite}
    .v-side-chip.corrected{background:#f7edff; color:#5e1681; border-color:#d7b7ff; align-items:flex-start; line-height:1.35}
    .v-side-chip.corrected i{margin-top:1px}
    .v-side-chip.change-pending{background:#fff8e1; color:#7a4b00; border-color:#f4d58d; align-items:flex-start; line-height:1.35}
    .v-side-chip.change-pending i{margin-top:1px}
    .v-side-pop{display:none; flex-direction:column; gap:8px; padding:12px; border-radius:14px; background:#fff; border:1px solid rgba(0,0,0,0.10); box-shadow:0 16px 34px rgba(0,0,0,0.14)}
    .v-side-pop.active{display:flex}
    .v-closebtn{background:#fff; border:1px solid rgba(0,0,0,0.12); padding:12px 12px; border-radius:14px; cursor:pointer; font-weight:1000; color:#333}
    .v-upgrade-overlay{position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(8,12,18,0.44); backdrop-filter:blur(4px); z-index:120}
    .v-upgrade-overlay.active{display:flex}
    .v-upgrade-dialog{width:min(720px, calc(100% - 40px)); max-height:min(760px, calc(100% - 40px)); overflow:auto; background:#fff; border-radius:24px; box-shadow:0 26px 80px rgba(0,0,0,0.30); padding:24px; color:#1b2430}
    .v-upgrade-head{display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:18px}
    .v-upgrade-title{font-size:22px; font-weight:1000; letter-spacing:-.03em; color:#18222d; margin-bottom:4px}
    .v-upgrade-sub{margin-top:6px; font-size:13px; font-weight:800; line-height:1.5; color:#5f6b76}
    .v-upgrade-type{padding:7px 11px; border-radius:999px; background:#eef3f8; color:#405364; font-size:11px; font-weight:1000; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap}
    .v-upgrade-form{display:flex; flex-direction:column; gap:12px}
    .v-upgrade-section{padding:0; border:none; background:transparent}
    .v-upgrade-sectionTitle{display:block; font-size:12px; font-weight:900; color:#314150; margin-bottom:12px}
    .v-upgrade-field{display:flex; flex-direction:column; gap:7px}
    .v-upgrade-field + .v-upgrade-field{margin-top:12px}
    .v-upgrade-field label{font-size:12px; font-weight:900; color:#314150}
    .v-upgrade-field input,.v-upgrade-field textarea{width:100%; border:1px solid rgba(17,24,39,0.12); border-radius:14px; background:#fff; padding:12px 14px; font:inherit; font-size:14px; color:#18222d; outline:none; transition:border-color .16s ease, box-shadow .16s ease}
    .v-upgrade-field textarea{min-height:112px; resize:vertical; line-height:1.45}
    .v-upgrade-field input:focus,.v-upgrade-field textarea:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.5); box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),0.12)}
    .v-upgrade-hint{font-size:11px; font-weight:800; line-height:1.45; color:#6a7783}
    .v-upgrade-scopeGroup{display:flex; gap:8px; margin-bottom:2px}
    .v-upgrade-scopeBtn{flex:1; appearance:none; border:1px solid rgba(17,24,39,0.12); background:#fff; border-radius:14px; padding:12px 14px; display:flex; align-items:center; gap:10px; cursor:pointer; transition:.16s ease}
    .v-upgrade-scopeBtn:hover{border-color:rgba(0,0,0,0.22)}
    .v-upgrade-scopeBtn.active{border-color:rgba(var(--primary-rgb,217,48,37),0.42); background:rgba(var(--primary-rgb,217,48,37),0.05); box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),0.10)}
    .v-upgrade-scopePrice{font-size:15px; font-weight:1000; color:#18222d; line-height:1.2}
    .v-upgrade-scopePrice s{color:#7b8794; margin-right:4px; font-weight:900}
    .v-upgrade-scopeBody{display:flex; flex-direction:column; gap:2px}
    .v-upgrade-scopeTitle{font-size:12px; font-weight:950; color:#222}
    .v-upgrade-ccList{display:flex; flex-direction:column; gap:8px; margin-bottom:8px}
    .v-upgrade-ccRow{display:flex; align-items:center; gap:8px}
    .v-upgrade-ccInput{flex:1; border:1px solid rgba(17,24,39,0.12); border-radius:14px; background:#fff; padding:12px 14px; font:inherit; font-size:14px; color:#18222d; outline:none; transition:border-color .16s ease, box-shadow .16s ease}
    .v-upgrade-ccInput:focus{border-color:rgba(var(--primary-rgb,217,48,37),0.5); box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),0.12)}
    .v-upgrade-ccRemove{width:32px; height:32px; border-radius:10px; border:1px solid rgba(17,24,39,0.10); background:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#94a3b8; font-size:13px; transition:.14s ease; flex-shrink:0}
    .v-upgrade-ccRemove:hover{background:rgba(var(--primary-rgb,217,48,37),0.04); color:var(--primary-readable, var(--primary,#d93025)); border-color:rgba(var(--primary-rgb,217,48,37),0.24)}
    .v-upgrade-addCc{display:inline-flex; align-items:center; gap:5px; padding:6px 12px; border-radius:10px; border:1px dashed rgba(17,24,39,0.18); background:transparent; font-size:12px; font-weight:900; color:#5f6b76; cursor:pointer; transition:.14s ease; align-self:flex-start}
    .v-upgrade-addCc:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.35); color:var(--primary-readable, var(--primary,#d93025)); background:rgba(var(--primary-rgb,217,48,37),0.03)}
    .v-upgrade-actions{display:flex; align-items:center; justify-content:space-between; gap:14px; margin-top:8px}
    .v-upgrade-price{font-size:14px; font-weight:900; color:#1f2d3a}
    .v-upgrade-price strong{font-size:20px; color:#101a24; letter-spacing:-.03em}
    .v-upgrade-discount{font-size:12px; font-weight:900; color:#137333; margin-top:4px}
    .v-upgrade-discount s{color:#6f8b74; margin-right:4px}
    .v-upgrade-btns{display:flex; gap:10px}
    .v-upgrade-btn{appearance:none; border:none; border-radius:14px; padding:12px 16px; font-size:13px; font-weight:1000; cursor:pointer; transition:.16s ease}
    .v-upgrade-btn.secondary{background:#eef2f6; color:#334155}
    .v-upgrade-btn.secondary:hover{background:#e2e8f0}
    .v-upgrade-btn.primary{background:var(--primary,#d93025); color:var(--on-primary,#fff); box-shadow:0 16px 28px rgba(var(--primary-rgb,217,48,37),0.20)}
    .v-upgrade-btn.primary:hover{background:var(--primary-dark,#b0261e); transform:translateY(-1px)}
    .v-upgrade-btn[disabled]{opacity:.58; cursor:not-allowed; transform:none; box-shadow:none}
    .v-m-frame{flex:1; background:#525659; position:relative}
    .v-report-tabs{position:absolute; top:0; left:0; right:0; height:62px; padding:0 16px; display:flex; align-items:center; gap:8px; overflow-x:auto; scrollbar-width:none; background:linear-gradient(180deg, #eef2f6 0%, #e6ebf2 100%); border-bottom:1px solid rgba(15,23,42,0.08); z-index:20}
    .v-report-tabRow{display:flex; flex-direction:row; flex-wrap:nowrap; align-items:center; justify-content:flex-start; gap:8px; width:100%; overflow-x:auto; scrollbar-width:none}
    .v-report-tabRow::-webkit-scrollbar{display:none}
    .v-report-tab{appearance:none; border:1px solid rgba(15,23,42,0.10); display:inline-flex; align-items:center; gap:8px; padding:10px 14px; border-radius:14px; background:rgba(255,255,255,0.72); backdrop-filter:blur(10px); color:#344054; font-size:12px; font-weight:1000; letter-spacing:.02em; white-space:nowrap; cursor:pointer; transition:.18s ease}
    .v-report-tab:hover:not(:disabled):not(.active){transform:translateY(-1px); border-color:rgba(15,23,42,0.18); background:rgba(255,255,255,0.88); box-shadow:0 10px 22px rgba(15,23,42,0.08)}
    .v-report-tab.active{background:#fff; border-color:rgba(var(--primary-rgb,217,48,37),0.24); color:var(--primary-readable, var(--primary,#d93025)); box-shadow:0 14px 28px rgba(15,23,42,0.08)}
    .v-report-tab.pending{background:rgba(255,255,255,0.52); color:#667085; cursor:default}
    .v-report-tab.hidden{display:none}
    .v-report-tab.is-info-tab{display:none}
    .v-frame-stage{position:absolute; inset:62px 0 60px; overflow:hidden}
    .v-measure-tabs{position:absolute; top:0; left:0; right:0; height:46px; padding:8px 16px; display:none; align-items:center; gap:8px; overflow-x:auto; scrollbar-width:none; background:rgba(248,250,252,0.96); border-bottom:1px solid rgba(15,23,42,0.08); z-index:18}
    .v-measure-tabs.active{display:flex}
    .v-measure-tabs::-webkit-scrollbar{display:none}
    .v-measure-tab{appearance:none; border:1px solid transparent; display:inline-flex; align-items:center; gap:7px; padding:7px 11px; border-radius:999px; background:transparent; color:#526071; font-size:11px; font-weight:950; white-space:nowrap; cursor:pointer; transition:.18s ease}
    .v-measure-tab:hover:not(:disabled):not(.active){background:#fff; border-color:rgba(15,23,42,0.08); color:#344054}
    .v-measure-tab.active{background:#fff; border-color:rgba(15,23,42,0.10); color:#1f2937; box-shadow:0 8px 18px rgba(15,23,42,0.08)}
    .v-measure-tab.pending{color:#7b8794}
    .v-measure-tab:disabled{cursor:default}
    .v-frame-stage.has-measure-tabs #vmFrame,
    .v-frame-stage.has-measure-tabs #vmMapCanvas,
    .v-frame-stage.has-measure-tabs #vmInstantPane{
      top:46px;
      height:calc(100% - 46px);
    }
    #vmFrame{position:absolute; inset:0; width:100%; height:100%; border:none; display:none}
    #vmMapCanvas{position:absolute; inset:0; display:none}
    .modal-close-x{position:absolute; top:10px; right:10px; width:40px; height:40px; border-radius:2px; background:#fefefe; z-index:100; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px; color:#555; transition:.18s ease}
    .modal-close-x:hover{background:#f0f0f0; color:#333}
    .pending-overlay{position:absolute; top:10px; right:10px; background:#fefefe; padding:0px 20px 20px; border-radius:14px; border-top-right-radius:2px; box-shadow:0 10px 28px rgba(0,0,0,0.24); z-index:10; display:none; width:500px}
    .pending-overlay.pdf-preview-disabled{left:18px; right:18px; top:18px; bottom:18px; width:auto; padding:22px; border-radius:16px; border-top-right-radius:16px; display:flex; align-items:center; justify-content:center; box-sizing:border-box; overflow:auto}
    .v-frame-stage.has-measure-tabs .pending-overlay.pdf-preview-disabled{top:64px}
    .v-pdf-debug-card{width:min(420px,100%); text-align:center; display:grid; justify-items:center; gap:12px; color:#344054}
    .v-pdf-debug-card > i{font-size:30px; color:var(--primary-readable,var(--primary,#d93025))}
    .v-pdf-debug-card h4{margin:0; font-size:18px; color:#101828}
    .v-pdf-debug-card p{margin:0; font-size:12px; font-weight:800; line-height:1.5; color:#667085}
    .v-pdf-debug-card .v-dlbtn{width:auto; min-width:180px; justify-content:center}
    .pending-overlay.cancelled{border:1px solid rgba(95,99,104,0.18)}
    .v-instant-pane{position:absolute; inset:0; display:none; background:linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%); color:#18222d}
    .v-instant-pane.active{display:flex}
    .v-instant-scene{position:relative; flex:1; min-width:0; overflow:hidden; background:radial-gradient(circle at top left, rgba(255,255,255,0.18), transparent 38%), linear-gradient(135deg, #152231 0%, #24384a 48%, #304d63 100%)}
    .v-instant-canvas{position:absolute; inset:0; width:100%; height:100%; touch-action:none; cursor:grab; display:block}
    .v-instant-canvas.is-dragging{cursor:grabbing}
    .v-instant-labels{position:absolute; inset:0; pointer-events:none; z-index:1; overflow:hidden}
    .v-instant-label{position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:8px}
    .v-instant-labelLine{width:2px; height:18px; background:rgba(255,255,255,0.78); box-shadow:0 0 10px rgba(0,0,0,0.18)}
    .v-instant-labelBubble{min-width:40px; height:40px; padding:0 10px; border-radius:999px; background:rgba(10,18,28,0.88); border:1px solid rgba(255,255,255,0.18); color:#fff; font-size:12px; font-weight:1000; display:flex; align-items:center; justify-content:center; box-shadow:0 18px 40px rgba(0,0,0,0.24)}
    .v-instant-label.structure-label .v-instant-labelBubble{min-width:34px; height:34px; padding:0 12px; background:rgba(255,255,255,0.96); color:#142132; border-color:rgba(17,24,39,0.08); box-shadow:0 20px 44px rgba(0,0,0,0.28)}
    .v-instant-label.structure-label .v-instant-labelLine{background:rgba(255,255,255,0.92); height:22px}
    .v-instant-controls{position:absolute; top:14px; left:14px; z-index:2; display:flex; align-items:center; gap:8px; flex-wrap:wrap; pointer-events:auto}
    .v-instant-ctrl{appearance:none; border:none; border-radius:999px; padding:9px 12px; background:rgba(8,16,24,0.74); color:#fff; font-size:11px; font-weight:1000; letter-spacing:.02em; cursor:pointer; border:1px solid rgba(255,255,255,0.14); box-shadow:0 14px 34px rgba(0,0,0,0.22); backdrop-filter:blur(10px); transition:.16s ease}
    .v-instant-ctrl:hover{transform:translateY(-1px); border-color:rgba(255,255,255,0.3)}
    .v-instant-ctrl.active{background:rgba(255,255,255,0.16); border-color:rgba(255,255,255,0.36)}
    .v-instant-zoom{display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border-radius:999px; background:rgba(8,16,24,0.74); border:1px solid rgba(255,255,255,0.14); box-shadow:0 14px 34px rgba(0,0,0,0.22); backdrop-filter:blur(10px); pointer-events:auto; position:relative; z-index:4}
    .v-instant-zoom input{width:120px; height:18px; accent-color:#fff; cursor:pointer; pointer-events:auto; appearance:auto; -webkit-appearance:auto; background:transparent; touch-action:pan-x; position:relative; z-index:5}
    .v-instant-loading{position:absolute; z-index:3; left:50%; top:50%; width:auto; transform:translate(-50%,-50%); padding:0; border-radius:0; background:transparent; border:none; backdrop-filter:none; color:#fff; font-weight:1000; font-size:18px; line-height:1.35; text-align:center; box-shadow:none; display:inline-flex; align-items:center; justify-content:center; gap:10px; white-space:nowrap; text-shadow:0 2px 10px rgba(0,0,0,0.42)}
    .v-instant-loadingIcon{width:auto; height:auto; margin:0; border-radius:0; display:flex; align-items:center; justify-content:center; background:transparent; color:#fff; font-size:18px}
    .v-instant-loadingTitle{font-size:18px; font-weight:1000; margin-bottom:0}
    .v-instant-loadingText{font-size:12px; font-weight:850; color:rgba(255,255,255,0.82)}
    .v-instant-loading.error{width:min(440px, calc(100% - 40px)); padding:22px 24px; border-radius:18px; background:rgba(91,27,27,0.82); border:1px solid rgba(255,170,170,0.2); backdrop-filter:blur(14px); box-shadow:0 24px 70px rgba(0,0,0,0.34); display:block; white-space:normal; text-shadow:none}
    .v-instant-loading.error .v-instant-loadingIcon{width:42px; height:42px; margin:0 auto 12px; border-radius:999px; background:rgba(255,255,255,0.12)}
    .v-instant-loading.error .v-instant-loadingTitle{font-size:15px; margin-bottom:5px}
    .v-instant-stats{width:280px; flex-shrink:0; min-height:0; overflow-x:hidden; overflow-y:auto; -webkit-overflow-scrolling:touch; background:linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); border-left:1px solid rgba(15,23,42,0.08); padding:18px; display:flex; flex-direction:column; gap:12px}
    .v-instant-tabs{display:flex; align-items:flex-end; gap:4px; padding:0 4px; border-bottom:1px solid rgba(15,23,42,0.10)}
    .v-instant-tab{appearance:none; margin:0; min-height:40px; border:1px solid rgba(15,23,42,0.10); border-bottom:none; border-radius:12px 12px 0 0; padding:10px 14px 9px; background:rgba(226,232,240,0.55); color:#526071; font-size:11px; font-weight:1000; letter-spacing:.02em; cursor:pointer; transition:.16s ease; position:relative; top:1px; display:inline-flex; align-items:center; justify-content:center}
    .v-instant-tab:hover{background:#edf2f7; color:#1f2937}
    .v-instant-tab.active{background:#fff; color:#132030; border-color:rgba(15,23,42,0.14); box-shadow:0 10px 24px rgba(15,23,42,0.08)}
    .v-instant-tab.muted{color:#94a3b8}
    .v-instant-tab.active.muted{color:#132030}
    .v-instant-head{padding:14px 16px; border-radius:16px; background:#fff; border:1px solid rgba(15,23,42,0.08); box-shadow:0 8px 24px rgba(15,23,42,0.04)}
    .v-instant-headTitle{font-size:13px; font-weight:1000; text-transform:uppercase; letter-spacing:.5px}
    .v-instant-headMeta{margin-top:6px; font-size:12px; font-weight:800; color:#667085; line-height:1.45}
    .v-instant-metric{padding:14px 16px; border-radius:16px; background:#fff; border:1px solid rgba(15,23,42,0.08); box-shadow:0 8px 24px rgba(15,23,42,0.04)}
    .v-instant-k{font-size:10px; font-weight:1000; letter-spacing:.45px; text-transform:uppercase; color:#667085}
    .v-instant-v{margin-top:6px; font-size:20px; font-weight:1000; letter-spacing:-.02em}
    .v-instant-actionWrap{margin-top:auto}
    .v-instant-action{appearance:none; width:100%; border:1px solid rgba(15,23,42,0.10); border-radius:14px; padding:12px 14px; background:#fff; color:#18222d; font-size:12px; font-weight:1000; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; transition:transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease; box-shadow:0 10px 24px rgba(15,23,42,0.08)}
    .v-instant-action:hover:not([disabled]){border-color:rgba(var(--primary-rgb,217,48,37),0.28); box-shadow:0 14px 28px rgba(15,23,42,0.12); transform:translateY(-1px)}
    .v-instant-action:active:not([disabled]){transform:translateY(0); box-shadow:0 8px 18px rgba(15,23,42,0.1)}
    .v-instant-action:focus-visible{outline:2px solid rgba(var(--primary-rgb,217,48,37),0.35); outline-offset:2px}
    .v-instant-action[disabled]{opacity:.48; cursor:not-allowed; box-shadow:none}
    .v-instant-action.secondary{background:#f8fafc; border-color:rgba(15,23,42,0.10)}
    .v-instant-actionStack{margin-top:auto; display:flex; flex-direction:column; gap:10px}
    .v-instant-actionMobileLabel{display:none}
    .v-instant-coverageNote{padding:12px 14px; border-radius:14px; background:#f8fafc; border:1px solid rgba(15,23,42,0.08); color:#526071; font-size:11px; font-weight:850; line-height:1.45}
    .v-instant-emptyState{padding:16px; border-radius:16px; background:linear-gradient(180deg, rgba(126,32,32,0.28), rgba(58,14,14,0.34)); border:1px solid rgba(255,196,196,0.22); box-shadow:0 14px 32px rgba(0,0,0,0.16)}
    .v-instant-emptyTitle{display:flex; align-items:center; gap:10px; font-size:13px; font-weight:1000; letter-spacing:.02em; color:#fff}
    .v-instant-emptyTitle i{color:#ffc7c7}
    .v-instant-emptyText{margin-top:10px; font-size:12px; font-weight:850; line-height:1.55; color:rgba(255,255,255,0.88)}
    .v-instant-emptyRefund{margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.14); font-size:13px; font-weight:1000; line-height:1.55; color:#fff}
    .v-frame-footer{position:absolute; left:0; right:0; bottom:0; height:60px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 16px; background:linear-gradient(180deg, rgba(11,17,24,0.86), rgba(11,17,24,0.94)); z-index:20}
    .v-frame-footerLeft,.v-frame-footerRight{display:flex; align-items:center; gap:10px}
    .v-footer-chip{display:inline-flex; align-items:center; gap:8px; padding:9px 12px; border-radius:999px; background:rgba(255,255,255,0.12); color:#fff; font-size:12px; font-weight:900}
    .v-footer-chip.pending i{animation:fa-spin 1.3s linear infinite}
    .v-footer-btn{appearance:none; border:none; display:inline-flex; align-items:center; gap:8px; padding:10px 13px; border-radius:999px; background:#fff; color:#1b2430; font-size:12px; font-weight:1000; cursor:pointer; transition:.16s ease}
    .v-footer-btn:hover{transform:translateY(-1px)}
    .v-footer-btn.primary{background:var(--primary,#d93025); color:#fff}
    .v-footer-btn.secondary{background:rgba(255,255,255,0.14); color:#fff; border:1px solid rgba(255,255,255,0.14)}
    .v-footer-btn.secondary[disabled]{opacity:.6; cursor:default}
    .v-footer-pop{position:absolute; left:16px; bottom:70px; display:none; flex-direction:column; gap:8px; padding:12px; border-radius:16px; background:#fff; box-shadow:0 18px 42px rgba(0,0,0,0.26); width:280px; z-index:24}
    .v-footer-pop.active{display:flex}
    .v-footer-popTitle{font-size:12px; font-weight:1000; color:#1b2430}
    .v-footer-popText{font-size:11px; font-weight:800; color:#666; line-height:1.4}
    .v-footer-popActions{display:flex; flex-direction:column; gap:8px}
    .v-footer-option{appearance:none; border:1px solid rgba(0,0,0,0.10); background:#fff; color:#1b2430; padding:11px 12px; border-radius:12px; display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; font-weight:1000; cursor:pointer}
    .v-footer-option:hover{border-color:rgba(0,0,0,0.22)}
    .v-delivery-badge{position:absolute; right:10px; bottom:10px; z-index:3; display:inline-flex; align-items:center; gap:6px; padding:5px 9px; border-radius:999px; font-size:10px; font-weight:1000; letter-spacing:.3px; text-transform:uppercase; box-shadow:0 4px 12px rgba(0,0,0,0.18); color:#fff; background:rgba(16,27,38,0.66)}
    .v-delivery-badge.instant-only{background:rgba(26,115,232,0.94)}
    .v-delivery-badge.instant-both{background:rgba(13,115,119,0.94)}
    .v-meta-tag-instant{background:#e8f0fe; color:#174ea6; border-color:rgba(23,78,166,0.16)}
    .v-i-tip{display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; margin-left:4px; border-radius:50%; background:rgba(255,255,255,0.14); color:#fff; font-size:9px; font-weight:1000; position:relative; cursor:help}
    .v-i-tip .v-i-bubble{display:none; position:absolute; right:0; bottom:calc(100% + 8px); width:180px; padding:10px 12px; border-radius:12px; background:#08111a; border:1px solid rgba(255,255,255,0.10); color:#fff; font-size:11px; font-weight:800; line-height:1.45; box-shadow:0 16px 40px rgba(0,0,0,0.30)}
    .v-i-tip:hover .v-i-bubble{display:block}
    .sb-logout-low{display:flex; align-items:center; justify-content:center; gap:8px; font-weight:900; font-size:12px; color:#777; text-decoration:none; padding:10px 0 2px; margin-top:auto; cursor:pointer; user-select:none}
    .sb-logout-low:hover{color:var(--primary-readable, var(--primary,#d93025))}
    .sb-logout-slot{margin-top:auto}
    .v-pagination{display:flex; align-items:center; justify-content:center; gap:8px; padding:12px 0 2px; flex-wrap:wrap; flex:0 0 auto; min-height:0}
    .v-pgbtn{background:#fff; border:1px solid rgba(0,0,0,0.10); border-radius:10px; padding:8px 14px; font-weight:950; font-size:12px; color:#333; cursor:pointer; transition:.16s ease; user-select:none}
    .v-pgbtn:hover:not(.disabled):not(.active){border-color:rgba(var(--primary-rgb,217,48,37),0.45); color:var(--primary-readable, var(--primary,#d93025))}
    .v-pgbtn.active{border-color:rgba(var(--primary-rgb,217,48,37),0.55); background:var(--primary,#d93025); color:var(--on-primary, #fff)}
    .v-pgbtn.disabled{opacity:.35; cursor:default; pointer-events:none}

    /* ==========================================================
       MOBILE RESPONSIVE — max-width: 820px
       All mobile overrides below. Desktop is completely unaffected.
       ========================================================== */
    @media (max-width: 820px){

      /* --- Page header: stack vertically --- */
      .v-head{
        flex-direction:column;
        gap:10px;
        margin-bottom:10px;
      }
      body:has(.mobile-topbar.has-tab-title) .v-title{display:none}
      .v-title h1{font-size:18px}
      .v-title .sub{font-size:11px; display:none}
      .v-actions{
        width:100%;
        justify-content:stretch;
        gap:8px;
      }

      /* --- Search: full width --- */
      .v-searchwrap{
        flex:1; width:100%; order:-1;
      }
      .v-search{
        width:100%;
        padding:12px 14px 12px 38px;
        font-size:14px;
      }
      .v-suggest{
        width:100%;
        left:0; right:0;
        top:48px;
        max-height:60vh;
        overflow:auto;
        -webkit-overflow-scrolling:touch;
      }

      /* --- View toggle buttons: compact --- */
      .v-btn{
        padding:9px 10px;
        font-size:12px;
        border-radius:12px;
      }
      .v-pill{
        padding:9px 12px;
      }
      /* Hide text labels on view toggles, keep icons */
      #vViewTiles span.btn-label,
      #vViewList span.btn-label,
      #vViewStages span.btn-label{display:none}
      /* Refresh: icon only */
      #vRefresh span.btn-label{display:none}

      /* --- Filter bar: horizontal scroll --- */
      .v-bar{
        flex-direction:row;
        gap:8px;
        margin:8px 0 10px;
        overflow-x:auto;
        -webkit-overflow-scrolling:touch;
        scrollbar-width:none;
        -ms-overflow-style:none;
        padding-bottom:2px;
      }
      .v-bar::-webkit-scrollbar{display:none}
      .v-leftbar{
        flex-wrap:nowrap;
        gap:8px;
      }
      .v-rightbar{display:none}
      .v-chip{
        flex-shrink:0;
        padding:8px 10px;
        border-radius:12px;
        font-size:12px;
      }
      .v-chip select{
        font-size:12px;
      }
      .v-count{
        flex-shrink:0;
        font-size:11px;
        white-space:nowrap;
      }

      /* --- Tile grid: single column on small phones, 2 col on wider --- */
      .v-grid{
        grid-template-columns:1fr;
        gap:12px;
        padding-bottom:12px;
      }
      @media (min-width: 480px){
        .v-grid{
          grid-template-columns:repeat(2, 1fr);
        }
      }

      /* --- Tiles: compact --- */
      .v-tile{
        border-radius:14px;
        box-shadow:0 6px 18px rgba(0,0,0,0.07);
      }
      .v-tile:hover{
        transform:none;
        box-shadow:0 6px 18px rgba(0,0,0,0.07);
      }
      .v-tile:active{
        transform:scale(0.985);
      }
      .v-thumb{height:140px}
      .v-body{padding:10px 12px 10px; gap:6px}
      .v-addr{font-size:13px}
      .v-addr .l2{font-size:11px}
      .v-meta{font-size:11px}
      .v-foot{font-size:10px}

      /* --- List view: convert to card layout (table doesn't fit) --- */
      .v-list{
        border-radius:14px;
        box-shadow:0 6px 18px rgba(0,0,0,0.07);
      }
      .v-lhead{
        display:none !important;
      }
      .v-lscroll{
        max-height:none;
        overflow:auto;
      }
      .v-lrow{
        display:flex !important;
        flex-direction:column;
        gap:6px;
        padding:12px 14px;
        border-top:1px solid rgba(0,0,0,0.06);
      }
      .v-lrow .v-lcell{
        padding:0;
      }
      /* Re-order list row cells for card layout */
      .v-lrow .v-lcell:nth-child(1){order:2}
      .v-lrow .v-lcell:nth-child(2){order:1}
      .v-lrow .v-lcell:nth-child(3){order:3}
      .v-lrow .v-lcell:nth-child(4){order:4; color:#999 !important; font-size:11px !important}
      .v-lrow .v-statuspill{
        font-size:10px;
        padding:5px 8px;
      }
      .v-stages-summary{display:none}
      .v-stages-board{
        grid-auto-columns:min(82vw, 318px);
        gap:10px;
        padding-bottom:10px;
      }
      .v-stage-col{
        min-width:min(82vw, 318px);
        min-height:0;
        border-radius:14px;
        box-shadow:0 6px 18px rgba(0,0,0,0.07);
      }
      .v-stage-card:hover{
        transform:none;
        box-shadow:0 8px 18px rgba(15,23,42,0.06);
      }
      .v-stage-card:active{transform:scale(0.985)}

      /* --- Modal: full screen, stacked --- */
      .v-overlay{
        align-items:flex-end;
        justify-content:center;
      }
      .v-modal{
        width:100vw !important;
        height:100vh !important;
        max-width:100vw !important;
        max-height:100vh !important;
        border-radius:0;
        flex-direction:column;
        animation:vSlideUp .22s ease-out;
      }
      @keyframes vSlideUp{
        from{transform:translateY(100%); opacity:0.7}
        to{transform:translateY(0); opacity:1}
      }

      .v-m-side{display:contents}
      .v-m-head{
        padding:14px 16px 10px;
        position:relative;
        order:1;
        background:#f8f9fa;
        z-index:3;
        border-bottom:1px solid rgba(0,0,0,0.08);
        flex-shrink:0;
      }
      .v-m-title{font-size:14px; margin:0 0 6px; padding-right:54px}
      .v-m-body{order:3; padding:12px 16px; overflow:auto; -webkit-overflow-scrolling:touch}
      .v-m-body .v-item{margin-bottom:10px}
      .v-m-body .v-k{font-size:10px}
      .v-m-body .v-v{font-size:12px; margin-top:4px}
      .v-m-foot{order:4; padding:10px 16px; flex-shrink:0}
      .v-modal:not(.mobile-tab-info) .v-m-body,
      .v-modal:not(.mobile-tab-info) .v-m-foot{display:none !important}
      .v-modal.mobile-tab-info .v-m-body{display:block; flex:1 1 auto; min-height:0}
      .v-modal.mobile-tab-info .v-m-foot{display:block}
      .v-dlbtn{padding:10px 12px; font-size:13px; border-radius:12px}

      .v-m-frame{
        order:2;
        flex:1;
        min-height:0;
        width:100%;
      }
      .v-modal.mobile-tab-info .v-m-frame{
        flex:0 0 62px;
        min-height:62px;
        background:#e6ebf2;
      }
      .v-modal.mobile-tab-info .v-frame-stage,
      .v-modal.mobile-tab-info .v-frame-footer{display:none !important}
      .v-report-tab.is-info-tab{display:inline-flex}

      /* Close X repositioned for mobile — fixed so always visible */
      .modal-close-x{
        position:fixed;
        top:10px; right:10px;
        width:40px; height:40px;
        border-radius:12px;
        background:rgba(255,255,255,0.95);
        box-shadow:0 2px 12px rgba(0,0,0,0.25);
        z-index:6100;
        font-size:18px;
      }

      /* Pending overlay: full width on mobile */
      .pending-overlay{
        width:auto !important;
        left:8px !important;
        right:8px !important;
        top:8px !important;
        border-radius:12px !important;
        border-top-right-radius:12px !important;
        padding:0 14px 14px !important;
        max-height:calc(100% - 16px);
        overflow:auto;
        -webkit-overflow-scrolling:touch;
      }
      .pending-overlay.pdf-preview-disabled{
        bottom:8px !important;
        padding:18px !important;
        display:flex !important;
        align-items:center;
        justify-content:center;
      }
      .v-frame-stage.has-measure-tabs .pending-overlay.pdf-preview-disabled{top:54px !important}
      .v-upgrade-dialog{
        width:min(100%, calc(100% - 20px));
        max-height:min(100%, calc(100% - 20px));
        padding:18px;
        border-radius:20px;
      }
      .v-upgrade-head{
        flex-direction:column;
        gap:10px;
      }
      .v-upgrade-actions{
        flex-direction:column;
        align-items:stretch;
      }
      .v-upgrade-btns{
        width:100%;
      }
      .v-upgrade-btn{
        flex:1;
      }
      .v-instant-pane{flex-direction:column; min-height:0}
      .v-instant-scene{flex:1 1 52%; min-height:0}
      .v-instant-tabs{width:100%; flex:0 0 100%}
      .v-instant-stats{
        width:auto;
        flex:1 1 48%;
        min-height:0;
        overflow:auto;
        -webkit-overflow-scrolling:touch;
        border-left:none;
        border-top:1px solid rgba(15,23,42,0.08);
        flex-direction:row;
        flex-wrap:wrap;
        align-content:flex-start;
      }
      .v-instant-head, .v-instant-metric{width:calc(50% - 6px)}
      .v-instant-actionStack{
        width:calc(50% - 6px);
        margin-top:0;
        gap:7px;
        align-self:stretch;
        justify-content:center;
        order:10;
      }
      .v-instant-action{
        min-height:0;
        padding:9px 8px;
        border-radius:12px;
        font-size:11px;
        line-height:1.15;
        box-shadow:0 6px 14px rgba(15,23,42,0.06);
      }
      .v-instant-actionFullLabel{display:none}
      .v-instant-actionMobileLabel{display:inline}
      .v-instant-emptyState{
        width:100%;
        flex:0 0 100%;
        order:1;
      }
      .v-instant-actionStack.is-missing{
        width:100%;
        flex:0 0 100%;
        flex-direction:row;
        order:2;
      }
      .v-instant-actionStack.is-missing .v-instant-action{
        flex:1 1 0;
      }
      .v-instant-coverageNote{
        width:100%;
        flex:0 0 100%;
        order:11;
      }
      .v-instant-controls{top:12px; left:12px; right:12px}
      .v-instant-loading{left:50%; right:auto; top:50%; bottom:auto; width:auto; transform:translate(-50%,-50%); padding:0}
      .v-instant-loading.error{width:calc(100% - 24px); padding:18px 16px}

      /* --- Pagination: compact --- */
      .v-pagination{
        padding:12px 0 6px;
        gap:4px;
      }
      .v-pgbtn{
        padding:8px 10px;
        font-size:11px;
        border-radius:8px;
        min-width:34px;
        text-align:center;
        justify-content:center;
      }
      .v-pginfo{
        font-size:11px;
        padding:0 2px;
      }
    }

    /* Extra-small phones */
    @media (max-width: 380px){
      .v-grid{
        grid-template-columns:1fr !important;
      }
      .v-thumb{height:120px}
    }
  `;

  const __fileExistsCache = new Map();
  let __modalNonce = 0;
  let currentModalId = null;
  let currentModalGroup = null;
  let currentModalProject = null;
  let currentModalCustomerSave = null;
  let panelEl = null;
  let pollTimer = null;
  let modalOpen = false;
  let allProjects = [];
  let filteredProjects = [];
  let lastProjectsById = new Map();
  let viewMode = 'tiles';
  let statusFilter = 'all';
  let hideDrafts = true;
  let tileSortKey = 'created_at';
  let tileSortDir = 'desc';
  let listSortKey = 'created_at';
  let listSortDir = 'desc';
  let searchQuery = '';
  let activeSuggest = false;
  let searchDebounceTimer = null;
  let fetchProjectsSeq = 0;
  let hydrateRefreshTimer = null;
  const PAGE_SIZE = 25;
  const STAGE_COLUMN_PAGE_SIZE = 15;
  const STAGE_COLUMN_PREFETCH_PX = 140;
  const SEARCH_DEBOUNCE_MS = 220;
  let currentPage = 1;
  let totalPages = 1;
  let totalCount = 0;
  let totalUnfilteredCount = 0;
  let viewMap = null;
  let viewMarker = null;
  let viewExtraMarkers = [];
  let instantRetryTimer = null;
  let instantSceneState = null;
  let instantStatsScope = 'total';
  const instantPayloadCache = new Map();
  const instantRepairInFlight = new Map();
  let instantDomScope = null;
  let instantStandaloneOpen = false;
  let instantStandaloneNonce = 0;
  let instantStandaloneCustomerSave = null;
  let _optimisticProjects = []; /* synthetic stubs injected on submit, before server knows */
  const _optimisticProjectUpdates = new Map();
  const OPTIMISTIC_PROJECT_UPDATE_TTL_MS = 45000;
  const detailHydrationInFlight = new Set();
  const detailHydrationQueued = new Set();
  const detailHydrationQueue = [];
  const DETAIL_HYDRATION_CONCURRENCY = 4;
  let detailHydrationActive = 0;

  function ensureViewMap(){
    if (viewMap) return true;
    if (!window.google || !google.maps) return false;
    const el = document.getElementById('vmMapCanvas');
    if (!el) return false;
    viewMap = new google.maps.Map(el, { zoom: 19, mapTypeId: 'satellite', disableDefaultUI: false });
    viewMarker = new google.maps.Marker({ map: viewMap });
    return true;
  }

  function clearExtraMarkers(){
    for (const m of viewExtraMarkers){ try{ m.setMap(null); }catch(e){} }
    viewExtraMarkers = [];
  }

  function cancelInstantWork(){
    if (instantRetryTimer) {
      clearTimeout(instantRetryTimer);
      instantRetryTimer = null;
    }
    if (instantSceneState?.raf) {
      try{ cancelAnimationFrame(instantSceneState.raf); }catch(e){}
    }
    if (instantSceneState?.controls?.dispose) {
      try{ instantSceneState.controls.dispose(); }catch(e){}
    }
    if (instantSceneState?.renderer) {
      try{ instantSceneState.renderer.dispose(); }catch(e){}
    }
    if (Array.isArray(instantSceneState?.disposeList)) {
      instantSceneState.disposeList.forEach((entry) => {
        try{ entry?.dispose?.(); }catch(e){}
      });
    }
    if (instantSceneState?.detach) {
      try{ instantSceneState.detach(); }catch(e){}
    }
    const { labels } = instantEls();
    if (labels) labels.innerHTML = '';
    instantSceneState = null;
  }

  function clearInstantCanvasSurface(){
    const { canvas } = instantEls();
    if (!canvas) return;
    const width = Math.max(1, canvas.width || canvas.clientWidth || 1);
    const height = Math.max(1, canvas.height || canvas.clientHeight || 1);
    try {
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        return;
      }
    } catch (e) {}
    try {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, width, height);
    } catch (e) {}
  }

  function resetInstantCanvasSurface(){
    const { canvas, labels, autoBtn, resetBtn, zoomSlider, pitchBtn } = instantEls();
    if (labels) labels.innerHTML = '';
    if (canvas) {
      try {
        const nextWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
        const nextHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      } catch (e) {}
    }
    clearInstantCanvasSurface();
    autoBtn?.classList.remove('active');
    resetBtn?.classList.remove('active');
    pitchBtn?.classList.remove('active');
    if (pitchBtn) pitchBtn.innerHTML = `<i class="fas fa-ruler-combined"></i> Pitches On`;
    if (pitchBtn) pitchBtn.style.display = INSTANT_PITCH_UI_ENABLED ? '' : 'none';
    if (zoomSlider) zoomSlider.value = '50';
  }

  function instantEls(){
    const byId = (id) => instantDomScope?.querySelector?.(`#${id}`) || document.getElementById(id);
    return {
      pane: byId('vmInstantPane'),
      canvas: byId('vmInstantCanvas'),
      labels: byId('vmInstantLabels'),
      loading: byId('vmInstantLoading'),
      stats: byId('vmInstantStats'),
      autoBtn: byId('vmInstantAuto'),
      resetBtn: byId('vmInstantReset'),
      zoomSlider: byId('vmInstantZoom'),
      pitchBtn: byId('vmInstantPitches')
    };
  }

  function instantRenderIsOpen(nonce){
    if (instantDomScope) {
      return !!instantStandaloneOpen && (!nonce || nonce === instantStandaloneNonce);
    }
    return !!modalOpen && (!nonce || nonce === __modalNonce);
  }

  function setInstantLoading(message, isError){
    const { loading } = instantEls();
    if (!loading) return;
    if (!isError) {
      loading.style.display = '';
      loading.classList.remove('error');
      loading.innerHTML = `
        <div class="v-instant-loadingIcon"><i class="fas fa-circle-notch fa-spin"></i></div>
        <div class="v-instant-loadingTitle">Instant Report Generating</div>
      `;
      return;
    }
    const fallback = 'We could not load the FirstMeasure instant just yet.';
    const text = message || fallback;
    loading.style.display = '';
    loading.classList.toggle('error', !!isError);
    loading.innerHTML = `
      <div class="v-instant-loadingIcon"><i class="fas ${isError ? 'fa-triangle-exclamation' : 'fa-circle-notch fa-spin'}"></i></div>
      <div class="v-instant-loadingTitle">Instant Report Unavailable</div>
      <div class="v-instant-loadingText">${escapeHtml(text)}</div>
    `;
  }

  const INSTANT_ROTATION_DEFAULT = -0.26;
  const INSTANT_ROTATION_MIN = -0.58;
  const INSTANT_ROTATION_MAX = 0.18;
  const INSTANT_ROTATION_STEP = 0.14;
  const INSTANT_AUTO_SPEED = 0.0022;
  const INSTANT_RETRY_DELAY_MS = 5000;
  const INSTANT_RETRY_LIMIT = Math.ceil((60 * 60 * 1000) / INSTANT_RETRY_DELAY_MS);

  function showInstantPane(project, message, isError){
    const { pane, loading, stats } = instantEls();
    if (!pane || !loading || !stats) return;
    resetInstantCanvasSurface();
    pane.classList.add('active');
    setInstantLoading(message, isError);
    instantStatsScope = 'total';
    renderInstantStatsPanel(null, project);
  }

  function hideInstantPane(){
    const { pane, loading, stats } = instantEls();
    if (pane) pane.classList.remove('active');
    if (loading) {
      loading.style.display = 'none';
      loading.textContent = '';
      loading.classList.remove('error');
    }
    if (stats) stats.innerHTML = '';
    instantStatsScope = 'total';
    resetInstantCanvasSurface();
  }

  function renderSidebarActions(config){
    const sideActions = document.getElementById('vmSideActions');
    const sidePop = document.getElementById('vmSidePop');
    if (!sideActions || !sidePop) return;
    sideActions.innerHTML = config?.actionsHtml || '';
    sidePop.classList.toggle('active', !!config?.popActive);
    sidePop.innerHTML = config?.popHtml || '';
  }

  function upgradeEls(){
    return {
      overlay: document.getElementById('vmUpgradeOverlay'),
      dialog: document.getElementById('vmUpgradeDialog'),
      form: document.getElementById('vmUpgradeForm'),
      ccList: document.getElementById('vmUpgradeCcList'),
      addCc: document.getElementById('vmUpgradeAddCc'),
      cancel: document.getElementById('vmUpgradeCancel'),
      submit: document.getElementById('vmUpgradeSubmit'),
      price: document.getElementById('vmUpgradePrice'),
      scopeGroup: document.getElementById('vmUpgradeScopeGroup'),
      residentName: document.getElementById('vmUpgradeResidentName'),
      residentEmail: document.getElementById('vmUpgradeResidentEmail'),
      residentPhone: document.getElementById('vmUpgradeResidentPhone'),
      techNotes: document.getElementById('vmUpgradeTechNotes')
    };
  }

  function getInstantPath(project){
    const id = encodeURIComponent(firstMeasureProjectId(project));
    if (!id) return null;
    return project?.instant_only ? `instants/${id}` : `projects/${id}/instant`;
  }

  function toFiniteNumber(value){
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function meters2ToSqFt(value){
    const num = toFiniteNumber(value);
    return num == null ? null : num * 10.7639;
  }

  function meters2ToRoofingSquares(value){
    const sqFt = meters2ToSqFt(value);
    return sqFt == null ? null : Math.ceil(sqFt / 100);
  }

  function formatRoofingSquareCount(value){
    const squares = Number(value);
    if (!Number.isFinite(squares)) return '-';
    return `${Math.ceil(squares).toLocaleString()} ${Math.ceil(squares) === 1 ? 'square' : 'squares'}`;
  }

  function formatRoofingSquareRange(value){
    const squares = Number(value);
    if (!Number.isFinite(squares)) return '-';
    const center = Math.ceil(squares);
    const low = Math.max(1, center - 2);
    const high = center;
    return `${low.toLocaleString()} to ${high.toLocaleString()} Squares`;
  }

  function pitchToRise12(degrees){
    const pitch = toFiniteNumber(degrees);
    if (pitch == null) return null;
    return Math.max(1, Math.round(Math.tan((pitch * Math.PI) / 180) * 12));
  }

  function formatPitchRange(pitchRise){
    const rise = toFiniteNumber(pitchRise);
    if (rise == null) return '-';
    return `${rise}/12`;
  }

  function predominantPitchDegrees(segments){
    if (!Array.isArray(segments) || !segments.length) return null;
    const best = segments
      .map((segment) => ({
        pitch: toFiniteNumber(segment?.pitch_degrees),
        area: toFiniteNumber(segment?.roof_area_meters2) || 0
      }))
      .filter((segment) => segment.pitch != null)
      .sort((a, b) => b.area - a.area)[0];
    return best?.pitch ?? null;
  }

  function instantStructureAreaForPitch(structure){
    return (
      toFiniteNumber(structure?.roof_area?.total_roof_area_meters2)
      ?? toFiniteNumber(structure?.mask_area?.roof_area_meters2)
      ?? sumFiniteNumbers(Array.isArray(structure?.roof_segments)
        ? structure.roof_segments.map((segment) => segment?.roof_area_meters2)
        : [])
      ?? toFiniteNumber(structure?.mask_area?.ground_area_meters2)
      ?? toFiniteNumber(structure?.roof_area?.building_ground_area_meters2)
      ?? 0
    );
  }

  function largestInstantStructureByArea(structures){
    if (!Array.isArray(structures) || !structures.length) return null;
    return structures.reduce((largest, structure) => (
      instantStructureAreaForPitch(structure) > instantStructureAreaForPitch(largest) ? structure : largest
    ), structures[0]);
  }

  function getInstantStructures(instant){
    return Array.isArray(instant?.structures) ? instant.structures.filter(Boolean) : [];
  }

  function getProjectPinCount(project){
    return Array.isArray(project?.pins)
      ? project.pins.filter((pin) => Number.isFinite(Number(pin?.lat)) && Number.isFinite(Number(pin?.lng))).length
      : 0;
  }

  function getProjectInstantTargetPins(project){
    const pins = Array.isArray(project?.pins)
      ? project.pins
          .map((pin) => ({
            latitude: toFiniteNumber(pin?.lat),
            longitude: toFiniteNumber(pin?.lng)
          }))
          .filter((pin) => pin.latitude != null && pin.longitude != null)
      : [];
    if (pins.length) return pins;
    const latitude = toFiniteNumber(project?.lat);
    const longitude = toFiniteNumber(project?.lng);
    return latitude != null && longitude != null ? [{ latitude, longitude }] : [];
  }

  function instantPointInsideBounds(point, bounds){
    const normalized = normalizeInstantBoxPoint(point, bounds);
    return !!normalized
      && normalized.x >= 0
      && normalized.x <= 1
      && normalized.y >= 0
      && normalized.y <= 1;
  }

  function instantNormalizedDistanceSquared(a, b, bounds){
    const pa = normalizeInstantBoxPoint(a, bounds);
    const pb = normalizeInstantBoxPoint(b, bounds);
    if (pa && pb) {
      return ((pa.x - pb.x) ** 2) + ((pa.y - pb.y) ** 2);
    }
    const aLat = toFiniteNumber(a?.latitude);
    const aLng = toFiniteNumber(a?.longitude);
    const bLat = toFiniteNumber(b?.latitude);
    const bLng = toFiniteNumber(b?.longitude);
    if ([aLat, aLng, bLat, bLng].some((value) => value == null)) return Number.POSITIVE_INFINITY;
    return ((aLat - bLat) ** 2) + ((aLng - bLng) ** 2);
  }

  function instantStructureContainsPoint(structure, point, fullBounds){
    const bounds = structure?.padded_bounding_box || structure?.bounding_box || null;
    if (bounds && instantPointInsideBounds(point, bounds)) return true;

    const normalizedPoint = normalizeInstantBoxPoint(point, fullBounds);
    if (!normalizedPoint) return false;

    const bboxPoints = Array.isArray(structure?.bounding_box_points) ? structure.bounding_box_points : [];
    const bboxPolygon = bboxPoints.map((p) => normalizeInstantBoxPoint(p, fullBounds)).filter(Boolean);
    if (bboxPolygon.length >= 3 && pointInPolygon(normalizedPoint, bboxPolygon)) return true;

    const segments = Array.isArray(structure?.roof_segments) ? structure.roof_segments : [];
    return segments.some((segment) => {
      const segmentPoints = normalizeSegmentPoints(segment, fullBounds);
      return Array.isArray(segmentPoints) && segmentPoints.length >= 3 && pointInPolygon(normalizedPoint, segmentPoints);
    });
  }

  function chooseInstantStructureForPin(structures, pin){
    if (!Array.isArray(structures) || !structures.length || !pin) return null;
    const sharedBounds = structures.find((structure) => structure?.project_extent_bounds)?.project_extent_bounds || null;
    const scored = structures.map((structure, index) => {
      const fullBounds = structure?.project_extent_bounds || sharedBounds || structure?.padded_bounding_box || structure?.bounding_box || null;
      const containsPin = fullBounds ? instantStructureContainsPoint(structure, pin, fullBounds) : false;
      const centerDistance = structure?.center
        ? instantNormalizedDistanceSquared(pin, structure.center, fullBounds)
        : Number.POSITIVE_INFINITY;
      const area = instantStructureAreaForPitch(structure);
      return {
        structure,
        score: (containsPin ? 0 : 1000) + (Number.isFinite(centerDistance) ? centerDistance : 100) + (Math.max(0, area) * 1e-9) + (index * 1e-12)
      };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.structure || null;
  }

  function cloneInstantForSingleStructure(instant, structure){
    if (!instant || !structure) return instant;
    const focusedRoofArea = { ...((structure?.roof_area && typeof structure.roof_area === 'object') ? structure.roof_area : {}) };
    const maskRoofArea = toFiniteNumber(structure?.mask_area?.roof_area_meters2);
    const maskGroundArea = toFiniteNumber(structure?.mask_area?.ground_area_meters2);
    if (focusedRoofArea.total_roof_area_meters2 == null && maskRoofArea != null) {
      focusedRoofArea.total_roof_area_meters2 = maskRoofArea;
    }
    if (focusedRoofArea.building_ground_area_meters2 == null && maskGroundArea != null) {
      focusedRoofArea.building_ground_area_meters2 = maskGroundArea;
    }
    const focusedBilling = (instant?.billing && typeof instant.billing === 'object')
      ? {
          ...instant.billing,
          missing_structure_count: 0,
          refundable_missing_amount: 0
        }
      : instant?.billing;
    return {
      ...instant,
      structures: [{ ...structure, label: structure?.label || 'A' }],
      roof_area: Object.keys(focusedRoofArea).length ? focusedRoofArea : null,
      billing: focusedBilling
    };
  }

  function focusSinglePinInstantPayload(project, instant){
    const targetPins = getProjectInstantTargetPins(project);
    if (targetPins.length !== 1) return instant;
    const structures = getInstantStructures(instant);
    if (structures.length <= 1) return instant;
    const renderableStructures = structures.filter(hasRenderableStructureCoverage);
    if (renderableStructures.length <= 1) return instant;
    const selected = chooseInstantStructureForPin(renderableStructures, targetPins[0]);
    return selected ? cloneInstantForSingleStructure(instant, selected) : instant;
  }

  function projectUsesPerStructureInstantPricing(project){
    const projectType = String(project?.project_type || '').trim().toLowerCase();
    const reportMode = String(project?.report_mode || (project?.instant_only ? 'instant' : '')).trim().toLowerCase();
    return (projectType === 'commercial' || projectType === 'multifamily') && reportMode === 'instant';
  }

  function instantNeedsMultiStructureRepair(project, instant){
    const pinCount = getProjectPinCount(project);
    if (pinCount <= 1) return false;
    const structures = getInstantStructures(instant);
    const structureInsightsUrl = String(instant?.assets?.structure_insights_url || '').trim();
    const coveredIds = structures
      .filter((structure) => hasRenderableStructureCoverage(structure))
      .map((structure) => String(structure?.structure_id || '').trim())
      .filter(Boolean);
    const duplicateIds = new Set();
    coveredIds.forEach((id) => {
      if (duplicateIds.has(id)) return;
      const count = coveredIds.filter((value) => value === id).length;
      if (count > 1) duplicateIds.add(id);
    });
    const missingRefundRefreshNeeded = projectUsesPerStructureInstantPricing(project)
      && structures.some((structure) => !hasRenderableStructureCoverage(structure))
      && !project?.refund_pending
      && !project?.refund_issued;
    const missingStructures = structures.length < pinCount;
    return missingStructures || structures.length <= 1 || !structureInsightsUrl || duplicateIds.size > 0 || missingRefundRefreshNeeded;
  }

  async function ensureMultiStructureInstant(project, instant){
    if (!instantNeedsMultiStructureRepair(project, instant) || !fmPost) {
      return instant;
    }

    const projectId = firstMeasureProjectId(project);
    if (!projectId) return instant;

    const existing = instantRepairInFlight.get(projectId);
    if (existing) {
      return await existing.catch(() => instant);
    }

    const repairPromise = (async () => {
      const response = await fmPost(`projects/${encodeURIComponent(projectId)}/instant/ensure`, {
        force: true
      });
      const nextInstant = response?.instant || instant;
      const cacheKey = `${project?.instant_only ? 'instant' : 'project'}:${projectId}`;
      instantPayloadCache.set(cacheKey, nextInstant);
      if (response?.repaired) {
        project.instant = nextInstant;
      }
      return nextInstant;
    })();

    instantRepairInFlight.set(projectId, repairPromise);
    try{
      return await repairPromise;
    }catch(error){
      console.warn('FirstMeasure instant repair failed', error);
      return instant;
    }finally{
      instantRepairInFlight.delete(projectId);
    }
  }

  function hasRenderableStructureCoverage(structure){
    if (!structure || structure?.has_coverage === false) return false;
    if (Array.isArray(structure?.roof_segments) && structure.roof_segments.length) return true;
    if (structure?.bounding_box || structure?.padded_bounding_box) return true;
    if (toFiniteNumber(structure?.mask_area?.roof_area_meters2) != null) return true;
    return false;
  }

  function getRenderableInstantStructures(instant){
    const structures = getInstantStructures(instant);
    const covered = structures.filter(hasRenderableStructureCoverage);
    return covered.length ? covered : structures;
  }

  function getInstantStructureTabList(instant){
    const structures = getInstantStructures(instant);
    if (structures.length <= 1) return [];
    return [
      { id: 'total', label: 'Total', structure: null },
      ...structures.map((structure, index) => ({
        id: `structure:${index}`,
        label: String(structure?.label || String.fromCharCode(65 + index)),
        structure
      }))
    ];
  }

  function ensureInstantStatsScope(instant){
    const tabs = getInstantStructureTabList(instant);
    if (!tabs.length) {
      instantStatsScope = 'total';
      return 'total';
    }
    if (!tabs.some((tab) => tab.id === instantStatsScope)) {
      instantStatsScope = 'total';
    }
    return instantStatsScope;
  }

  function sumFiniteNumbers(values){
    const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0);
  }

  function getInstantScopeMetrics(instant, scopeId){
    const allStructures = getInstantStructures(instant);
    const renderableStructures = getRenderableInstantStructures(instant);
    const activeScope = scopeId || ensureInstantStatsScope(instant);
    const activeTab = getInstantStructureTabList(instant).find((tab) => tab.id === activeScope) || null;
    const activeStructure = activeTab?.structure || null;
    const structuresForMetrics = activeScope === 'total'
      ? renderableStructures
      : (activeStructure ? [activeStructure] : []);
    const structureForPitch = activeScope === 'total'
      ? largestInstantStructureByArea(structuresForMetrics)
      : activeStructure;
    const segments = structureForPitch && Array.isArray(structureForPitch?.roof_segments)
      ? structureForPitch.roof_segments
      : structuresForMetrics.flatMap((structure) => (
          Array.isArray(structure?.roof_segments) ? structure.roof_segments : []
        ));
    const predominantPitch = predominantPitchDegrees(segments);
    const surfaceArea = activeScope === 'total'
      ? (
          toFiniteNumber(instant?.roof_area?.total_roof_area_meters2)
          ?? sumFiniteNumbers(structuresForMetrics.map((structure) => (
            toFiniteNumber(structure?.roof_area?.total_roof_area_meters2)
              ?? toFiniteNumber(structure?.mask_area?.roof_area_meters2)
          )))
        )
      : (
          toFiniteNumber(activeStructure?.roof_area?.total_roof_area_meters2)
          ?? toFiniteNumber(activeStructure?.mask_area?.roof_area_meters2)
          ?? null
        );
    const roofSquares = meters2ToRoofingSquares(surfaceArea);
    const pitchRise = pitchToRise12(predominantPitch);
    const coverageStatus = String(activeStructure?.coverage_status || '').trim().toLowerCase();
    const totalRenderableCount = renderableStructures.length;
    return {
      activeScope,
      allStructures,
      renderableStructures,
      tabs: getInstantStructureTabList(instant),
      activeStructure,
      activeLabel: activeStructure?.label ? `Structure ${activeStructure.label}` : 'Total',
      surfaceArea,
      roofSquares,
      pitchRise,
      predominantPitch,
      coverageStatus,
      coverageMissing: activeScope !== 'total' && !hasRenderableStructureCoverage(activeStructure),
      summaryText: activeScope === 'total'
        ? (
            allStructures.length > 1
              ? `Included structures: ${totalRenderableCount} of ${allStructures.length} selected.`
              : 'Combined measurements for the selected structure.'
          )
        : (
            activeStructure?.center ? `Measurements for Structure ${activeStructure.label || ''}.` : 'Measurements for the selected structure.'
          )
    };
  }

  function buildInstantStatsMarkup(instant, project){
    const instantPdfUrl = String(instant?.assets?.instant_pdf_url || '').trim();
    const instantPdfStatus = String(instant?.instant_pdf?.status || '').trim().toLowerCase();
    const instantPdfReady = !!instantPdfUrl && instantPdfStatus !== 'failed';
    const instantPdfFailed = !instantPdfReady && instantPdfStatus === 'failed';
    const standardButtonLabel = instantPdfReady
      ? 'Download Standard Report'
      : (instantPdfFailed ? 'Retrying Standard Report' : 'Generating Standard Report');
    const customerButtonLabel = instantPdfReady
      ? 'Download Customer Report'
      : (instantPdfFailed ? 'Retrying Customer Report' : 'Generating Customer Report');
    const standardButtonText = `<span class="v-instant-actionFullLabel">${standardButtonLabel}</span><span class="v-instant-actionMobileLabel">Standard Report</span>`;
    const customerButtonText = `<span class="v-instant-actionFullLabel">${customerButtonLabel}</span><span class="v-instant-actionMobileLabel">Customer Report</span>`;
    const instantPdfButtonIcon = instantPdfReady ? 'fa-file-arrow-down' : 'fa-circle-notch fa-spin';
    const instantPdfDisabled = instantPdfReady ? '' : ' disabled';
    if (!instant) {
      return `
        <div class="v-instant-metric"><div class="v-instant-k">Square Range</div><div class="v-instant-v">-</div></div>
        <div class="v-instant-metric"><div class="v-instant-k">Pitch</div><div class="v-instant-v">-</div></div>
        <div class="v-instant-actionStack">
          <button type="button" id="vmInstantStandardBtn" class="v-instant-action" disabled><i class="fas fa-circle-notch fa-spin"></i> <span class="v-instant-actionFullLabel">Generating Standard Report</span><span class="v-instant-actionMobileLabel">Standard Report</span></button>
          <button type="button" id="vmInstantCustomerBtn" class="v-instant-action secondary" disabled><i class="fas fa-circle-notch fa-spin"></i> <span class="v-instant-actionFullLabel">Generating Customer Report</span><span class="v-instant-actionMobileLabel">Customer Report</span></button>
        </div>
      `;
    }

    const metrics = getInstantScopeMetrics(instant, ensureInstantStatsScope(instant));
    const billing = (instant && typeof instant.billing === 'object' && instant.billing) ? instant.billing : {};
    const missingStructureCount = Number(billing.missing_structure_count || 0);
    const missingRefundAmount = Number.isFinite(Number(billing.refundable_missing_amount)) ? Number(billing.refundable_missing_amount) : null;
    const tabsMarkup = metrics.tabs.length
      ? `
        <div class="v-instant-tabs">
          ${metrics.tabs.map((tab) => {
            const isActive = tab.id === metrics.activeScope;
            const muted = tab.structure && !hasRenderableStructureCoverage(tab.structure);
            return `
              <button
                type="button"
                class="v-instant-tab${isActive ? ' active' : ''}${muted ? ' muted' : ''}"
                data-instant-scope="${escapeHtml(tab.id)}"
              >${escapeHtml(tab.id === 'total' ? 'Total' : tab.label)}</button>
            `;
          }).join('')}
        </div>
      `
      : '';
    let coverageNote = '';
    let missingStructureMarkup = '';
    if (metrics.coverageMissing) {
      const structureName = metrics.activeStructure?.label ? `Structure ${metrics.activeStructure.label}` : 'This structure';
      const structureRefundAmount = Number.isFinite(Number(metrics.activeStructure?.refund_amount))
        ? Number(metrics.activeStructure.refund_amount)
        : null;
      const refundState = String(metrics.activeStructure?.refund_state || '').trim().toLowerCase();
      const refundText = structureRefundAmount != null
        ? (
            refundState === 'issued'
              ? `The $${structureRefundAmount} cost for this structure has been refunded.`
            : refundState === 'pending'
                ? `The $${structureRefundAmount} cost for this structure is being refunded.`
                : metrics.activeStructure?.refund_eligible
                  ? `The $${structureRefundAmount} cost for this structure has been removed from instant billing.`
                  : ''
          )
        : '';
      missingStructureMarkup = `
        <div class="v-instant-emptyState">
          <div class="v-instant-emptyTitle"><i class="fas fa-triangle-exclamation"></i> No usable instant data found</div>
          <div class="v-instant-emptyText">${escapeHtml(`${structureName} could not be generated from the available instant coverage.`)}</div>
          ${refundText ? `<div class="v-instant-emptyRefund">${escapeHtml(refundText)}<br><br>Try ordering a full report to get measurements for this structure.</div>` : ''}
        </div>
      `;
    } else if (metrics.activeScope === 'total' && missingStructureCount > 0) {
      const refundState = project?.refund_issued ? 'issued' : (project?.refund_pending ? 'pending' : 'none');
      const refundText = missingRefundAmount != null
        ? (
            refundState === 'issued'
              ? ` A $${missingRefundAmount} credit has been refunded.`
              : refundState === 'pending'
                ? ` A $${missingRefundAmount} credit is being returned.`
                : ''
          )
        : '';
      const noun = missingStructureCount === 1 ? 'structure was' : 'structures were';
      coverageNote = `<div class="v-instant-coverageNote">${escapeHtml(`${missingStructureCount} selected ${noun} excluded because no usable instant data was available.${refundText}`)}</div>`;
    }
    return `
      ${tabsMarkup}
      ${metrics.coverageMissing ? missingStructureMarkup : `
        <div class="v-instant-metric">
          <div class="v-instant-k">Square Range</div>
          <div class="v-instant-v">${escapeHtml(formatRoofingSquareRange(metrics.roofSquares))}</div>
        </div>
        <div class="v-instant-metric">
          <div class="v-instant-k">Pitch</div>
          <div class="v-instant-v">${escapeHtml(formatPitchRange(metrics.pitchRise))}</div>
        </div>
        ${coverageNote}
      `}
      <div class="v-instant-actionStack${metrics.coverageMissing ? ' is-missing' : ''}">
        <button type="button" id="vmInstantStandardBtn" class="v-instant-action"${instantPdfDisabled}><i class="fas ${instantPdfButtonIcon}"></i> ${standardButtonText}</button>
        <button type="button" id="vmInstantCustomerBtn" class="v-instant-action secondary"${instantPdfDisabled}><i class="fas ${instantPdfButtonIcon}"></i> ${customerButtonText}</button>
      </div>
    `;
  }

  function bindInstantStatsUi(instant, project){
    const { stats } = instantEls();
    if (!stats) return;
    stats.querySelectorAll('[data-instant-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextScope = String(button.getAttribute('data-instant-scope') || 'total');
        if (!nextScope || nextScope === instantStatsScope) return;
        instantStatsScope = nextScope;
        renderInstantStatsPanel(instant, project);
      });
    });
    const instantStandardBtn = stats.querySelector('#vmInstantStandardBtn');
    const instantCustomerBtn = stats.querySelector('#vmInstantCustomerBtn');
    const instantPdfUrl = String(instant?.assets?.instant_pdf_url || '').trim();
    const instantPdfStatus = String(instant?.instant_pdf?.status || '').trim().toLowerCase();
    const instantPdfReady = !!instantPdfUrl && instantPdfStatus !== 'failed';
    const pdfRoutes = (() => {
      const projectId = encodeURIComponent(firstMeasureProjectId(project));
      if (!projectId) return [];
      return project?.instant_only
        ? [`instants/${projectId}/pdf`, `projects/${projectId}/instant/pdf`]
        : [`projects/${projectId}/instant/pdf`, `instants/${projectId}/pdf`];
    })();
    const runDownload = async (button, buildPayload, variant, loadingLabel, fallbackError) => {
      if (!button) return;
      button.disabled = !instantPdfReady;
      button.onclick = async (event) => {
        if (!instantPdfReady) return;
        event.preventDefault();
        event.stopPropagation();
        const originalHtml = button.innerHTML;
        try {
          button.disabled = true;
          button.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${loadingLabel}`;
          const payload = await buildPayload();
          await forceDownloadPostedFile(
            pdfRoutes,
            payload,
            buildInstantPdfFileName(project, variant)
          );
        } catch (error) {
          window.Portal?.ui?.showToast?.('PDF issue', error?.message || fallbackError, false);
          console.error(error);
        } finally {
          button.disabled = !instantPdfReady;
          button.innerHTML = originalHtml;
        }
      };
    };
    runDownload(
      instantStandardBtn,
      async () => ({
        show_prepared_for: false,
        file_name: 'Instant Report - Standard.pdf'
      }),
      'standard',
      'Preparing Standard Report',
      'Could not download the standard instant report.'
    );
    runDownload(
      instantCustomerBtn,
      async () => {
        const saveCustomer = typeof instantStandaloneCustomerSave === 'function'
          ? instantStandaloneCustomerSave
          : currentModalCustomerSave;
        if (typeof saveCustomer !== 'function') {
          throw new Error('Contact info is not available yet.');
        }
        const saveResult = await saveCustomer({
          silentSuccess: true,
          buttonTone: 'download'
        });
        const branding = await getOrganizationBrandingSnapshot();
        const preparedFor = buildPreparedForPayload(saveResult?.draft || resolveResidentFields(project));
        return {
          show_prepared_for: true,
          ...(preparedFor ? { prepared_for: preparedFor } : {}),
          ...(branding && Object.keys(branding).length ? { branding } : {}),
          file_name: 'Instant Report - Customer.pdf'
        };
      },
      'customer',
      'Preparing Customer Report',
      'Could not download the customer instant report.'
    );
  }

  function renderInstantStatsPanel(instant, project){
    const { stats } = instantEls();
    if (!stats) return;
    stats.innerHTML = buildInstantStatsMarkup(instant, project);
    if (instant) bindInstantStatsUi(instant, project);
  }

  function normalizeInstantBoxPoint(point, bounds){
    if (!point || !bounds) return null;
    const lat = toFiniteNumber(point.latitude);
    const lng = toFiniteNumber(point.longitude);
    const swLat = toFiniteNumber(bounds.sw?.latitude);
    const swLng = toFiniteNumber(bounds.sw?.longitude);
    const neLat = toFiniteNumber(bounds.ne?.latitude);
    const neLng = toFiniteNumber(bounds.ne?.longitude);
    if ([lat, lng, swLat, swLng, neLat, neLng].some(v => v == null)) return null;
    const width = neLng - swLng;
    const height = neLat - swLat;
    if (width <= 0 || height <= 0) return null;
    return {
      x: (lng - swLng) / width,
      y: (neLat - lat) / height
    };
  }

  function normalizeSegmentPoints(segment, bounds){
    if (Array.isArray(segment?.points) && segment.points.length >= 4) {
      const points = segment.points.map((point) => normalizeInstantBoxPoint(point, bounds)).filter(Boolean);
      if (points.length >= 4) return points;
    }
    const box = segment?.bounding_box;
    if (!box) return null;
    const sw = box.sw || {};
    const ne = box.ne || {};
    return [
      normalizeInstantBoxPoint({ latitude: sw.latitude, longitude: sw.longitude }, bounds),
      normalizeInstantBoxPoint({ latitude: sw.latitude, longitude: ne.longitude }, bounds),
      normalizeInstantBoxPoint({ latitude: ne.latitude, longitude: ne.longitude }, bounds),
      normalizeInstantBoxPoint({ latitude: ne.latitude, longitude: sw.longitude }, bounds),
    ].filter(Boolean);
  }

  function loadInstantPreview(url){
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function clampInstantRotation(value){
    return Math.max(INSTANT_ROTATION_MIN, Math.min(INSTANT_ROTATION_MAX, value));
  }

  function scheduleInstantRetry(project, nonce, attempt){
    if (instantRetryTimer) {
      clearTimeout(instantRetryTimer);
      instantRetryTimer = null;
    }
    if (!instantRenderIsOpen(nonce)) return false;
    if ((attempt || 0) >= INSTANT_RETRY_LIMIT) return false;
    instantRetryTimer = setTimeout(() => loadInstantForProject(project, nonce, (attempt || 0) + 1), INSTANT_RETRY_DELAY_MS);
    return true;
  }

  function setInstantCanvasDragging(isDragging){
    const { canvas } = instantEls();
    if (canvas) canvas.classList.toggle('is-dragging', !!isDragging);
  }

  function updateInstantControls(state){
    const { autoBtn, zoomSlider, pitchBtn } = instantEls();
    const isAuto = !!(state?.controls ? state.controls.autoRotate : state?.autoRotate);
    if (autoBtn) autoBtn.classList.toggle('active', isAuto);
    if (pitchBtn) {
      pitchBtn.style.display = INSTANT_PITCH_UI_ENABLED ? '' : 'none';
      const labelsVisible = INSTANT_PITCH_UI_ENABLED && state?.labelsVisible !== false;
      pitchBtn.classList.toggle('active', labelsVisible);
      pitchBtn.innerHTML = `<i class="fas fa-ruler-combined"></i> ${labelsVisible ? 'Pitches On' : 'Pitches Off'}`;
    }
    if (zoomSlider && state?.controls) {
      const minDistance = Number(state.controls.minDistance || 1);
      const maxDistance = Number(state.controls.maxDistance || (minDistance + 1));
      const currentDistance = Number(state.controls.getDistance?.() || state.camera?.position?.distanceTo?.(state.controls.target) || minDistance);
      const span = Math.max(1, maxDistance - minDistance);
      const normalized = (maxDistance - currentDistance) / span;
      zoomSlider.value = String(Math.max(0, Math.min(100, Math.round(normalized * 100))));
    }
  }

  function ensureInstant3DLibs(){
    return !!(window.THREE && window.GeoTIFF && window.THREE.OrbitControls);
  }

  async function fetchInstantArrayBuffer(url){
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Instant asset failed to load (${response.status}).`);
    return response.arrayBuffer();
  }

  async function openInstantGeoTiff(url){
    if (!url || !window.GeoTIFF?.fromArrayBuffer) return null;
    const buffer = await fetchInstantArrayBuffer(url);
    const tiff = await window.GeoTIFF.fromArrayBuffer(buffer);
    return tiff.getImage();
  }

  function collectStructureGeometryPoints(structure, fullBounds){
    const points = [];
    const bboxPoints = Array.isArray(structure?.bounding_box_points) ? structure.bounding_box_points : [];
    bboxPoints.forEach((point) => {
      const normalized = normalizeInstantBoxPoint(point, fullBounds);
      if (normalized) points.push(normalized);
    });
    const segments = Array.isArray(structure?.roof_segments) ? structure.roof_segments : [];
    segments.forEach((segment) => {
      const segmentPoints = normalizeSegmentPoints(segment, fullBounds);
      if (Array.isArray(segmentPoints)) {
        segmentPoints.forEach((point) => { if (point) points.push(point); });
      }
      const center = normalizeInstantBoxPoint(segment?.center, fullBounds);
      if (center) points.push(center);
    });
    const structureCenter = normalizeInstantBoxPoint(structure?.center, fullBounds);
    if (structureCenter) points.push(structureCenter);
    return points;
  }

  function unionNormalizedBounds(boundsList){
    let left = 1;
    let top = 1;
    let right = 0;
    let bottom = 0;
    let found = false;
    boundsList.forEach((bounds) => {
      const nextLeft = clamp01(bounds?.left);
      const nextTop = clamp01(bounds?.top);
      const nextRight = clamp01(bounds?.right);
      const nextBottom = clamp01(bounds?.bottom);
      if (!(nextRight > nextLeft) || !(nextBottom > nextTop)) return;
      left = Math.min(left, nextLeft);
      top = Math.min(top, nextTop);
      right = Math.max(right, nextRight);
      bottom = Math.max(bottom, nextBottom);
      found = true;
    });
    return found ? { left, top, right, bottom } : null;
  }

  function getInstantCropBounds(instant){
    const structures = getRenderableInstantStructures(instant);
    const unionBounds = unionNormalizedBounds(
      structures.map((structure) => structure?.normalized_padded_bounds).filter(Boolean)
    );
    const fallback = {
      left: clamp01(unionBounds?.left ?? instant?.render_data?.mask_bounds?.left ?? 0),
      top: clamp01(unionBounds?.top ?? instant?.render_data?.mask_bounds?.top ?? 0),
      right: clamp01(unionBounds?.right ?? instant?.render_data?.mask_bounds?.right ?? 1),
      bottom: clamp01(unionBounds?.bottom ?? instant?.render_data?.mask_bounds?.bottom ?? 1)
    };
    return buildFocusedInstantCropBounds(instant, fallback);
  }

  function buildFocusedInstantCropBounds(instant, fallback){
    const structures = getRenderableInstantStructures(instant);
    const fullBounds = structures[0]?.project_extent_bounds || null;
    if (!structures.length || !fullBounds) {
      return fallback;
    }
    const points = [];
    structures.forEach((structure) => {
      collectStructureGeometryPoints(structure, fullBounds).forEach((point) => points.push(point));
    });
    if (!points.length) {
      return fallback;
    }
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    points.forEach((point) => {
      minX = Math.min(minX, clamp01(point.x));
      minY = Math.min(minY, clamp01(point.y));
      maxX = Math.max(maxX, clamp01(point.x));
      maxY = Math.max(maxY, clamp01(point.y));
    });
    if (!(maxX > minX) || !(maxY > minY)) {
      return fallback;
    }
    const padded = padNormalizedBounds({ left:minX, top:minY, right:maxX, bottom:maxY }, 0.22);
    const squared = squareNormalizedBounds(padded, 0.62);
    return {
      left: clamp01(squared.left),
      top: clamp01(squared.top),
      right: clamp01(squared.right),
      bottom: clamp01(squared.bottom)
    };
  }

  function padNormalizedBounds(bounds, paddingRatio){
    const width = Math.max(0.04, bounds.right - bounds.left);
    const height = Math.max(0.04, bounds.bottom - bounds.top);
    const padX = width * paddingRatio;
    const padY = height * paddingRatio;
    return {
      left: clamp01(bounds.left - padX),
      top: clamp01(bounds.top - padY),
      right: clamp01(bounds.right + padX),
      bottom: clamp01(bounds.bottom + padY)
    };
  }

  function squareNormalizedBounds(bounds, minFillRatio){
    const width = Math.max(0.04, bounds.right - bounds.left);
    const height = Math.max(0.04, bounds.bottom - bounds.top);
    const side = Math.max(width, height) / Math.max(0.01, Math.min(1, minFillRatio || 0.62));
    const safeSide = Math.max(0.08, Math.min(1, side));
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    let left = centerX - (safeSide / 2);
    let top = centerY - (safeSide / 2);
    left = Math.max(0, Math.min(1 - safeSide, left));
    top = Math.max(0, Math.min(1 - safeSide, top));
    return {
      left,
      top,
      right: left + safeSide,
      bottom: top + safeSide
    };
  }

  function getInstantCropWindowPixels(bounds, width, height){
    const safeWidth = Math.max(1, Math.round(width || 0));
    const safeHeight = Math.max(1, Math.round(height || 0));
    const left = Math.max(0, Math.min(safeWidth - 1, Math.floor(bounds.left * safeWidth)));
    const top = Math.max(0, Math.min(safeHeight - 1, Math.floor(bounds.top * safeHeight)));
    const right = Math.max(left + 1, Math.min(safeWidth, Math.ceil(bounds.right * safeWidth)));
    const bottom = Math.max(top + 1, Math.min(safeHeight, Math.ceil(bounds.bottom * safeHeight)));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function metersToLatitudeDistance(latDegrees){
    return Math.abs(Number(latDegrees) || 0) * 111320;
  }

  function metersToLongitudeDistance(lngDegrees, latitude){
    const cos = Math.cos(((Number(latitude) || 0) * Math.PI) / 180);
    const safeCos = Math.max(Math.abs(cos), 0.000001);
    return Math.abs(Number(lngDegrees) || 0) * 111320 * safeCos;
  }

  function resolveInstantCropPhysicalSize(instant, cropBounds, aspectFallback){
    const structure = getRenderableInstantStructures(instant)[0] || null;
    const extent = structure?.project_extent_bounds || null;
    const cropWidthRatio = Math.max(0.0001, Number(cropBounds?.right || 0) - Number(cropBounds?.left || 0));
    const cropHeightRatio = Math.max(0.0001, Number(cropBounds?.bottom || 0) - Number(cropBounds?.top || 0));
    if (extent?.sw && extent?.ne) {
      const swLat = toFiniteNumber(extent.sw.latitude);
      const neLat = toFiniteNumber(extent.ne.latitude);
      const swLng = toFiniteNumber(extent.sw.longitude);
      const neLng = toFiniteNumber(extent.ne.longitude);
      if (swLat != null && neLat != null && swLng != null && neLng != null) {
        const cropCenterLat = neLat - (((Number(cropBounds?.top || 0) + Number(cropBounds?.bottom || 0)) / 2) * (neLat - swLat));
        const heightMeters = metersToLatitudeDistance((neLat - swLat) * cropHeightRatio);
        const widthMeters = metersToLongitudeDistance((neLng - swLng) * cropWidthRatio, cropCenterLat);
        if (widthMeters > 0.1 && heightMeters > 0.1) {
          return { widthMeters, heightMeters };
        }
      }
    }

    const safeAspect = Math.max(0.25, Math.min(4, Number(aspectFallback) || 1));
    if (safeAspect >= 1) {
      return { widthMeters: 60 * safeAspect, heightMeters: 60 };
    }
    return { widthMeters: 60, heightMeters: 60 / safeAspect };
  }

  function getInstantSampleDimensions(pixelWindow){
    const maxSide = 160;
    const aspect = pixelWindow.width / Math.max(pixelWindow.height, 1);
    if (aspect >= 1) {
      return {
        width: Math.max(48, Math.min(maxSide, pixelWindow.width)),
        height: Math.max(48, Math.min(maxSide, Math.round(maxSide / Math.max(aspect, 1))))
      };
    }
    return {
      width: Math.max(48, Math.min(maxSide, Math.round(maxSide * aspect))),
      height: Math.max(48, Math.min(maxSide, pixelWindow.height))
    };
  }

  async function readInstantSingleBand(image, pixelWindow, sampleDims, resampleMethod, fillValue){
    if (!image) return null;
    const options = {
      window: [pixelWindow.left, pixelWindow.top, pixelWindow.right, pixelWindow.bottom],
      samples: [0],
      interleave: true,
      fillValue,
      resampleMethod: resampleMethod || 'bilinear'
    };
    if (sampleDims?.width && sampleDims?.height) {
      options.width = sampleDims.width;
      options.height = sampleDims.height;
    }
    const raster = await image.readRasters(options);
    return {
      width: sampleDims?.width || pixelWindow.width,
      height: sampleDims?.height || pixelWindow.height,
      data: raster,
      image
    };
  }

  async function readInstantRgbCanvas(image, pixelWindow, sampleDims){
    if (!image) return null;
    const sampleCount = Math.max(1, Math.min(3, Number(image.getSamplesPerPixel?.() || 3)));
    const samples = Array.from({ length: sampleCount }, (_, index) => index);
    const options = {
      window: [pixelWindow.left, pixelWindow.top, pixelWindow.right, pixelWindow.bottom],
      samples,
      interleave: false,
      fillValue: 0,
      resampleMethod: 'bilinear'
    };
    if (sampleDims?.width && sampleDims?.height) {
      options.width = sampleDims.width;
      options.height = sampleDims.height;
    }
    const targetWidth = sampleDims?.width || pixelWindow.width;
    const targetHeight = sampleDims?.height || pixelWindow.height;
    const rasters = await image.readRasters(options);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.createImageData(targetWidth, targetHeight);
    for (let i = 0; i < targetWidth * targetHeight; i += 1) {
      const offset = i * 4;
      imageData.data[offset] = rasters[0]?.[i] ?? 0;
      imageData.data[offset + 1] = rasters[Math.min(1, rasters.length - 1)]?.[i] ?? imageData.data[offset];
      imageData.data[offset + 2] = rasters[Math.min(2, rasters.length - 1)]?.[i] ?? imageData.data[offset];
      imageData.data[offset + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return { canvas, width: targetWidth, height: targetHeight, image };
  }

  function downsampleInstantBand(data, sourceWidth, sourceHeight, sampleDims){
    const targetWidth = Math.max(1, Math.min(sourceWidth, sampleDims?.width || sourceWidth));
    const targetHeight = Math.max(1, Math.min(sourceHeight, sampleDims?.height || sourceHeight));
    if (targetWidth === sourceWidth && targetHeight === sourceHeight) {
      return {
        width: sourceWidth,
        height: sourceHeight,
        data: Array.from(data || [])
      };
    }
    const sampled = new Array(targetWidth * targetHeight);
    for (let row = 0; row < targetHeight; row += 1) {
      const sourceRow = targetHeight <= 1
        ? Math.floor(sourceHeight / 2)
        : Math.min(sourceHeight - 1, Math.round((row / (targetHeight - 1)) * (sourceHeight - 1)));
      for (let col = 0; col < targetWidth; col += 1) {
        const sourceCol = targetWidth <= 1
          ? Math.floor(sourceWidth / 2)
          : Math.min(sourceWidth - 1, Math.round((col / (targetWidth - 1)) * (sourceWidth - 1)));
        sampled[(row * targetWidth) + col] = Number(data[(sourceRow * sourceWidth) + sourceCol] || 0);
      }
    }
    return {
      width: targetWidth,
      height: targetHeight,
      data: sampled
    };
  }

  function percentile(values, ratio){
    const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const index = Math.max(0, Math.min(nums.length - 1, Math.round((nums.length - 1) * clamp01(ratio))));
    return nums[index];
  }

  function getInstantGroundReference(instant, heightValues, maskValues){
    const renderGround = toFiniteNumber(instant?.render_data?.ground_reference_meters);
    if (renderGround != null) return renderGround;
    const candidates = [];
    for (let i = 0; i < heightValues.length; i += 1) {
      const value = Number(heightValues[i]);
      const maskValue = Number(maskValues[i] || 0);
      if (!Number.isFinite(value) || value <= -9000) continue;
      if (maskValue < 0.1) candidates.push(value);
    }
    return percentile(candidates.length ? candidates : heightValues, 0.08) ?? 0;
  }

  function normalizePointToCrop(point, fullBounds, cropBounds){
    const normalized = normalizeInstantBoxPoint(point, fullBounds);
    if (!normalized) return null;
    const width = Math.max(0.0001, cropBounds.right - cropBounds.left);
    const height = Math.max(0.0001, cropBounds.bottom - cropBounds.top);
    return {
      x: (normalized.x - cropBounds.left) / width,
      y: (normalized.y - cropBounds.top) / height
    };
  }

  function remapNormalizedPointToCrop(point, cropBounds){
    if (!point) return null;
    const width = Math.max(0.0001, cropBounds.right - cropBounds.left);
    const height = Math.max(0.0001, cropBounds.bottom - cropBounds.top);
    return {
      x: (clamp01(point.x) - cropBounds.left) / width,
      y: (clamp01(point.y) - cropBounds.top) / height
    };
  }

  function pointInPolygon(point, polygon){
    if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = Number(polygon[i]?.x);
      const yi = Number(polygon[i]?.y);
      const xj = Number(polygon[j]?.x);
      const yj = Number(polygon[j]?.y);
      const intersects = ((yi > point.y) !== (yj > point.y))
        && (point.x < (((xj - xi) * (point.y - yi)) / Math.max((yj - yi), 1e-9)) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function buildInstantStructureMaskValues(instant, rawMaskValues, sampleDims, cropBounds){
    const structures = getRenderableInstantStructures(instant);
    const fullBounds = structures[0]?.project_extent_bounds || null;
    const polygons = [];
    if (fullBounds) {
      structures.forEach((structure) => {
        const segments = Array.isArray(structure?.roof_segments) ? structure.roof_segments : [];
        segments.forEach((segment) => {
          const segmentPoints = normalizeSegmentPoints(segment, fullBounds);
          if (!Array.isArray(segmentPoints) || segmentPoints.length < 3) return;
          const polygon = segmentPoints
            .map((point) => remapNormalizedPointToCrop(point, cropBounds))
            .filter(Boolean);
          if (polygon.length >= 3) polygons.push(polygon);
        });
        if (polygons.length) return;
        const bboxPoints = Array.isArray(structure?.bounding_box_points) ? structure.bounding_box_points : [];
        const bboxPolygon = bboxPoints
          .map((point) => normalizeInstantBoxPoint(point, fullBounds))
          .map((point) => remapNormalizedPointToCrop(point, cropBounds))
          .filter(Boolean);
        if (bboxPolygon.length >= 3) polygons.push(bboxPolygon);
      });
    }
    if (!polygons.length) {
      return Array.from(rawMaskValues || []);
    }

    const maskedValues = new Array(sampleDims.width * sampleDims.height).fill(0);
    for (let row = 0; row < sampleDims.height; row += 1) {
      for (let col = 0; col < sampleDims.width; col += 1) {
        const index = (row * sampleDims.width) + col;
        const rawMaskValue = Number(rawMaskValues[index] || 0);
        if (rawMaskValue < 0.1) continue;
        const point = {
          x: sampleDims.width <= 1 ? 0.5 : (col / (sampleDims.width - 1)),
          y: sampleDims.height <= 1 ? 0.5 : (row / (sampleDims.height - 1))
        };
        if (polygons.some((polygon) => pointInPolygon(point, polygon))) {
          maskedValues[index] = rawMaskValue;
        }
      }
    }
    return maskedValues;
  }

  function buildInstantSurfaceHeightValues(heightValues, maskValues, groundReference){
    return Array.from(heightValues || [], (value, index) => {
      const heightValue = Number(value);
      const maskValue = Number(maskValues?.[index] || 0);
      if (!Number.isFinite(heightValue) || heightValue <= -9000 || maskValue < 0.1) return 0;
      return Math.max(0, heightValue - groundReference);
    });
  }

  function sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col, row){
    const safeCol = Math.max(0, Math.min(sampleWidth - 1, col));
    const safeRow = Math.max(0, Math.min(sampleHeight - 1, row));
    return Number(surfaceHeights[(safeRow * sampleWidth) + safeCol] || 0);
  }

  function measureInstantSlope(surfaceHeights, sampleWidth, sampleHeight, stepX, stepY, col, row){
    const centerHeight = sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col, row);
    if (centerHeight < INSTANT_WALL_MIN_HEIGHT_METERS) {
      return { slopeDegrees: 0, downhillX: 0, downhillY: 0 };
    }
    const leftHeight = sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col - 1, row);
    const rightHeight = sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col + 1, row);
    const northHeight = sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col, row - 1);
    const southHeight = sampleInstantSurfaceHeight(surfaceHeights, sampleWidth, sampleHeight, col, row + 1);
    const slopeX = Math.max(
      Math.abs(centerHeight - leftHeight),
      Math.abs(rightHeight - centerHeight)
    ) / Math.max(stepX, 0.0001);
    const slopeY = Math.max(
      Math.abs(centerHeight - northHeight),
      Math.abs(southHeight - centerHeight)
    ) / Math.max(stepY, 0.0001);
    const gradientX = (rightHeight - leftHeight) / Math.max(stepX * 2, 0.0001);
    const gradientY = (southHeight - northHeight) / Math.max(stepY * 2, 0.0001);
    const downhillX = -gradientX;
    const downhillY = -gradientY;
    const downhillMagnitude = Math.hypot(downhillX, downhillY);
    return {
      slopeDegrees: Math.atan(Math.hypot(slopeX, slopeY)) * (180 / Math.PI),
      downhillX: downhillMagnitude > 0.0001 ? (downhillX / downhillMagnitude) : 0,
      downhillY: downhillMagnitude > 0.0001 ? (downhillY / downhillMagnitude) : 0
    };
  }

  function buildInstantWallMask(surfaceHeights, sampleWidth, sampleHeight, physicalSize){
    if (!Array.isArray(surfaceHeights) || !surfaceHeights.length || !physicalSize) return null;
    const stepX = Math.max((Number(physicalSize.widthMeters) || 0) / Math.max(sampleWidth - 1, 1), 0.25);
    const stepY = Math.max((Number(physicalSize.heightMeters) || 0) / Math.max(sampleHeight - 1, 1), 0.25);
    const values = new Array(sampleWidth * sampleHeight).fill(0);
    const downhillVectors = new Array(sampleWidth * sampleHeight).fill(null);
    for (let row = 0; row < sampleHeight; row += 1) {
      for (let col = 0; col < sampleWidth; col += 1) {
        const index = (row * sampleWidth) + col;
        const slope = measureInstantSlope(surfaceHeights, sampleWidth, sampleHeight, stepX, stepY, col, row);
        if (slope.slopeDegrees < INSTANT_WALL_SLOPE_DEGREES_THRESHOLD) continue;
        values[index] = 1;
        downhillVectors[index] = slope;
      }
    }
    const expandedValues = new Array(values.length).fill(0);
    let count = 0;
    for (let row = 0; row < sampleHeight; row += 1) {
      for (let col = 0; col < sampleWidth; col += 1) {
        const index = (row * sampleWidth) + col;
        if (!values[index]) continue;
        const slope = downhillVectors[index];
        for (let rowOffset = -INSTANT_WALL_MASK_EXPANSION_RADIUS; rowOffset <= INSTANT_WALL_MASK_EXPANSION_RADIUS; rowOffset += 1) {
          for (let colOffset = -INSTANT_WALL_MASK_EXPANSION_RADIUS; colOffset <= INSTANT_WALL_MASK_EXPANSION_RADIUS; colOffset += 1) {
            const nextRow = row + rowOffset;
            const nextCol = col + colOffset;
            if (nextRow < 0 || nextRow >= sampleHeight || nextCol < 0 || nextCol >= sampleWidth) continue;
            const nextIndex = (nextRow * sampleWidth) + nextCol;
            if (rowOffset !== 0 || colOffset !== 0) {
              const downhillBias = ((colOffset * (slope?.downhillX || 0)) + (rowOffset * (slope?.downhillY || 0)));
              const isUphillSide = downhillBias < -0.15;
              if (isUphillSide && !values[nextIndex]) continue;
            }
            if (expandedValues[nextIndex]) continue;
            expandedValues[nextIndex] = 1;
            count += 1;
          }
        }
      }
    }
    return count ? { width: sampleWidth, height: sampleHeight, values: expandedValues, count } : null;
  }

  function buildInstantWallOverrideTextureCanvas(textureCanvas, wallMask){
    if (!textureCanvas || !wallMask?.count) return textureCanvas;
    const output = document.createElement('canvas');
    output.width = textureCanvas.width;
    output.height = textureCanvas.height;
    const ctx = output.getContext('2d');
    if (!ctx) return textureCanvas;
    ctx.drawImage(textureCanvas, 0, 0);

    const overlay = document.createElement('canvas');
    overlay.width = wallMask.width;
    overlay.height = wallMask.height;
    const overlayCtx = overlay.getContext('2d');
    if (!overlayCtx) return output;
    const imageData = overlayCtx.createImageData(wallMask.width, wallMask.height);
    for (let i = 0; i < wallMask.values.length; i += 1) {
      if (!wallMask.values[i]) continue;
      const offset = i * 4;
      imageData.data[offset] = INSTANT_WALL_SOFT_GRAY.r;
      imageData.data[offset + 1] = INSTANT_WALL_SOFT_GRAY.g;
      imageData.data[offset + 2] = INSTANT_WALL_SOFT_GRAY.b;
      imageData.data[offset + 3] = INSTANT_WALL_SOFT_GRAY.a;
    }
    overlayCtx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(overlay, 0, 0, output.width, output.height);
    ctx.restore();
    return output;
  }

  function updateInstantLabelPositions(state){
    const { labels } = instantEls();
    if (!labels || !state?.camera || !state?.labelEntries?.length) return;
    const pitchLabelsVisible = state.labelsVisible !== false;
    const rect = labels.getBoundingClientRect();
    const visibleEntries = [];
    state.labelEntries.forEach((entry) => {
      const shouldShowEntry = pitchLabelsVisible || entry.type === 'structure';
      if (!shouldShowEntry) {
        entry.el.style.display = 'none';
        entry.el.style.zIndex = '0';
        return;
      }
      const anchorProjected = entry.anchorWorld.clone().project(state.camera);
      const bubbleProjected = entry.world.clone().project(state.camera);
      const visible = (
        anchorProjected.z > -1 && anchorProjected.z < 1
        && bubbleProjected.z > -1 && bubbleProjected.z < 1
      );
      if (!visible) {
        entry.el.style.display = 'none';
        entry.el.style.zIndex = '0';
        return;
      }
      const anchorX = ((anchorProjected.x + 1) / 2) * rect.width;
      const anchorY = ((1 - anchorProjected.y) / 2) * rect.height;
      const bubbleX = ((bubbleProjected.x + 1) / 2) * rect.width;
      const bubbleY = ((1 - bubbleProjected.y) / 2) * rect.height;
      if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY) || !Number.isFinite(bubbleX) || !Number.isFinite(bubbleY)) {
        entry.el.style.display = 'none';
        entry.el.style.zIndex = '0';
        return;
      }
      if (anchorX < 10 || anchorY < 10 || anchorX > rect.width - 10 || anchorY > rect.height - 10) {
        entry.el.style.display = 'none';
        entry.el.style.zIndex = '0';
        return;
      }
      const lineHeight = Math.max(0, anchorY - bubbleY - 18);
      entry.el.style.display = 'flex';
      entry.el.style.left = `${bubbleX}px`;
      entry.el.style.top = `${bubbleY}px`;
      const line = entry.el.querySelector('.v-instant-labelLine');
      if (line) {
        line.style.height = `${lineHeight}px`;
        line.style.opacity = lineHeight > 1 ? '1' : '0';
      }
      visibleEntries.push({
        entry,
        distanceToCamera: state.camera.position.distanceTo(entry.world)
      });
    });
    visibleEntries
      .sort((a, b) => b.distanceToCamera - a.distanceToCamera)
      .forEach((item, index) => {
        item.entry.el.style.zIndex = String(index + 1);
      });
  }

  function setInstantSceneDragging(isDragging){
    const { canvas } = instantEls();
    if (canvas) canvas.classList.toggle('is-dragging', !!isDragging);
  }

  function buildInstantSceneSignature(instant){
    const structures = getRenderableInstantStructures(instant);
    return JSON.stringify({
      rgb: instant?.assets?.solar_rgb_url || '',
      dsm: instant?.assets?.height_map_url || '',
      mask: instant?.assets?.mask_url || '',
      crop: getInstantCropBounds(instant),
      structures: structures.map((structure) => ({
        label: structure?.label || '',
        bbox: structure?.bounding_box_points || structure?.bounding_box || null,
        segments: (Array.isArray(structure?.roof_segments) ? structure.roof_segments : []).map((segment) => ({
          pitch: segment?.pitch_degrees ?? null,
          center: segment?.center || null,
          box: segment?.bounding_box || null
        }))
      })),
      render: instant?.render_data?.sample_source || null,
      status: instant?.status || ''
    });
  }

  async function buildInstantSceneAssets(instant){
    const assets = instant?.assets || {};
    const rgbUrl = String(assets.solar_rgb_url || '').trim();
    const heightUrl = String(assets.height_map_url || '').trim();
    const maskUrl = String(assets.mask_url || '').trim();
    if (!rgbUrl || !heightUrl || !maskUrl) {
      throw new Error('Instant image assets are not ready yet.');
    }

    const heightImage = await openInstantGeoTiff(heightUrl);
    const maskImage = await openInstantGeoTiff(maskUrl);
    if (!heightImage || !maskImage) {
      throw new Error('Instant model files are not ready yet.');
    }

    const cropBounds = getInstantCropBounds(instant);
    const pixelWindow = getInstantCropWindowPixels(cropBounds, heightImage.getWidth(), heightImage.getHeight());
    const sampleDims = getInstantSampleDimensions(pixelWindow);
    const [heightRasterFull, maskRasterFull, rgbCanvasData] = await Promise.all([
      readInstantSingleBand(heightImage, pixelWindow, null, 'nearest', -9999),
      readInstantSingleBand(maskImage, pixelWindow, null, 'nearest', 0),
      readInstantRgbCanvas(await openInstantGeoTiff(rgbUrl), pixelWindow, null)
    ]);
    if (!heightRasterFull || !maskRasterFull || !rgbCanvasData?.canvas) {
      throw new Error('Instant model files are not ready yet.');
    }

    const heightRaster = downsampleInstantBand(heightRasterFull.data, heightRasterFull.width, heightRasterFull.height, sampleDims);
    const maskRaster = downsampleInstantBand(maskRasterFull.data, maskRasterFull.width, maskRasterFull.height, sampleDims);
    const heightValues = Array.from(heightRaster.data || []);
    const rawMaskValues = Array.from(maskRaster.data || []);
    const maskValues = buildInstantStructureMaskValues(instant, rawMaskValues, { width: heightRaster.width, height: heightRaster.height }, cropBounds);
    const groundReference = getInstantGroundReference(instant, Array.from(heightRasterFull.data || []), Array.from(maskRasterFull.data || []));
    const surfaceHeights = buildInstantSurfaceHeightValues(heightValues, maskValues, groundReference);
    const validMaskedHeights = [];
    for (let i = 0; i < surfaceHeights.length; i += 1) {
      const value = Number(surfaceHeights[i]);
      if (value <= 0) continue;
      validMaskedHeights.push(value);
    }
    const maxHeightMeters = Math.max(0.5, percentile(validMaskedHeights, 0.98) ?? toFiniteNumber(instant?.render_data?.max_height_meters) ?? 0.5);
    return {
      cropBounds,
      pixelWindow,
      sampleWidth: heightRaster.width,
      sampleHeight: heightRaster.height,
      heightValues,
      maskValues,
      surfaceHeights,
      textureCanvas: rgbCanvasData.canvas,
      groundReference,
      maxHeightMeters
    };
  }

  function bindInstantInteraction(state){
    const { canvas, autoBtn, leftBtn, rightBtn, resetBtn } = instantEls();
    if (!canvas) return;

    const stopAutoRotate = () => {
      if (!state) return;
      state.autoRotate = false;
      updateInstantControls(state);
    };

    const nudgeRotation = (delta) => {
      if (!state) return;
      stopAutoRotate();
      state.rotation = clampInstantRotation(state.rotation + delta);
      drawInstantScene(state);
    };

    const onPointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      state.dragging = true;
      state.pointerId = event.pointerId ?? null;
      state.lastPointerX = event.clientX ?? 0;
      stopAutoRotate();
      setInstantCanvasDragging(true);
      try{ canvas.setPointerCapture?.(event.pointerId); }catch(e){}
      event.preventDefault();
    };

    const onPointerMove = (event) => {
      if (!state.dragging) return;
      if (state.pointerId != null && event.pointerId != null && state.pointerId !== event.pointerId) return;
      const currentX = event.clientX ?? state.lastPointerX ?? 0;
      const deltaX = currentX - (state.lastPointerX ?? currentX);
      state.lastPointerX = currentX;
      state.rotation = clampInstantRotation(state.rotation + (deltaX * 0.0065));
      drawInstantScene(state);
      event.preventDefault();
    };

    const finishPointer = (event) => {
      if (!state.dragging) return;
      if (state.pointerId != null && event?.pointerId != null && state.pointerId !== event.pointerId) return;
      state.dragging = false;
      state.pointerId = null;
      setInstantCanvasDragging(false);
      try{ canvas.releasePointerCapture?.(event?.pointerId); }catch(e){}
    };

    const onAutoClick = () => {
      if (!state) return;
      state.autoRotate = !state.autoRotate;
      updateInstantControls(state);
      if (!state.autoRotate) {
        drawInstantScene(state);
      }
    };
    const onLeftClick = () => nudgeRotation(-INSTANT_ROTATION_STEP);
    const onRightClick = () => nudgeRotation(INSTANT_ROTATION_STEP);
    const onResetClick = () => {
      if (!state) return;
      stopAutoRotate();
      state.rotation = INSTANT_ROTATION_DEFAULT;
      drawInstantScene(state);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);
    canvas.addEventListener('pointerleave', finishPointer);
    autoBtn?.addEventListener('click', onAutoClick);
    leftBtn?.addEventListener('click', onLeftClick);
    rightBtn?.addEventListener('click', onRightClick);
    resetBtn?.addEventListener('click', onResetClick);

    state.detach = () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', finishPointer);
      canvas.removeEventListener('pointercancel', finishPointer);
      canvas.removeEventListener('pointerleave', finishPointer);
      autoBtn?.removeEventListener('click', onAutoClick);
      leftBtn?.removeEventListener('click', onLeftClick);
      rightBtn?.removeEventListener('click', onRightClick);
      resetBtn?.removeEventListener('click', onResetClick);
      setInstantCanvasDragging(false);
    };
  }

  function buildTextureSampler(image){
    if (!image) return null;
    const maxDim = 720;
    const scale = Math.min(1, maxDim / Math.max(image.naturalWidth || image.width || 1, image.naturalHeight || image.height || 1));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { width, height, data };
  }

  function sampleTextureColor(sampler, u, v){
    if (!sampler) return { r: 120, g: 148, b: 166, a: 255 };
    const x = Math.max(0, Math.min(sampler.width - 1, Math.round(clamp01(u) * (sampler.width - 1))));
    const y = Math.max(0, Math.min(sampler.height - 1, Math.round(clamp01(v) * (sampler.height - 1))));
    const index = ((y * sampler.width) + x) * 4;
    return {
      r: sampler.data[index] ?? 120,
      g: sampler.data[index + 1] ?? 148,
      b: sampler.data[index + 2] ?? 166,
      a: sampler.data[index + 3] ?? 255
    };
  }

  function shadeColor(color, factor){
    return {
      r: Math.max(0, Math.min(255, Math.round(color.r * factor))),
      g: Math.max(0, Math.min(255, Math.round(color.g * factor))),
      b: Math.max(0, Math.min(255, Math.round(color.b * factor))),
      a: color.a ?? 255
    };
  }

  function rgbaColor(color, alpha){
    const a = alpha == null ? ((color.a ?? 255) / 255) : alpha;
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0, Math.min(1, a))})`;
  }

  function averageNumbers(values){
    const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    if (!nums.length) return 0;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
  }

  function clamp01(value){
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function renderGridValue(render, arrayName, col, row){
    const cols = Math.max(2, Number(render?.cols) || 0);
    const rows = Math.max(2, Number(render?.rows) || 0);
    const c = Math.max(0, Math.min(cols - 1, col));
    const r = Math.max(0, Math.min(rows - 1, row));
    const source = Array.isArray(render?.[arrayName]) ? render[arrayName] : [];
    return Number(source[(r * cols) + c]) || 0;
  }

  function sampleRenderDataAt(render, u, v){
    const cols = Math.max(2, Number(render?.cols) || 0);
    const rows = Math.max(2, Number(render?.rows) || 0);
    const col = Math.max(0, Math.min(cols - 1, Math.round(clamp01(u) * (cols - 1))));
    const row = Math.max(0, Math.min(rows - 1, Math.round(clamp01(v) * (rows - 1))));
    return {
      height: renderGridValue(render, 'heights_meters', col, row),
      mask: renderGridValue(render, 'mask', col, row)
    };
  }

  function averageCellMask(render, col, row){
    return averageNumbers([
      renderGridValue(render, 'mask', col, row),
      renderGridValue(render, 'mask', col + 1, row),
      renderGridValue(render, 'mask', col + 1, row + 1),
      renderGridValue(render, 'mask', col, row + 1)
    ]);
  }

  function averageCellHeight(render, col, row){
    return averageNumbers([
      renderGridValue(render, 'heights_meters', col, row),
      renderGridValue(render, 'heights_meters', col + 1, row),
      renderGridValue(render, 'heights_meters', col + 1, row + 1),
      renderGridValue(render, 'heights_meters', col, row + 1)
    ]);
  }

  function normalizedPointWithinBox(point, box){
    const normalized = normalizeInstantBoxPoint(point, box);
    return normalized ? { x: normalized.x, y: normalized.y } : null;
  }

  function projectInstantPoint(point, center, dims, rotation, z){
    const dx = point.x - 0.5;
    const dy = point.y - 0.5;
    const rx = (dx * Math.cos(rotation)) - (dy * Math.sin(rotation));
    const ry = (dx * Math.sin(rotation)) + (dy * Math.cos(rotation));
    return {
      x: center.x + (rx * dims.width) + (ry * dims.width * 0.28),
      y: center.y + (ry * dims.height * 0.58) - (z * dims.height)
    };
  }

  function tracePolygon(ctx, points){
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
  }

  function drawQuad(ctx, points, fillStyle, strokeStyle){
    if (!points || points.length < 4) return;
    ctx.beginPath();
    tracePolygon(ctx, points);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 0.45;
      ctx.stroke();
    }
  }

  function buildInstantSceneModel(instant, textureSampler){
    const structure = instant?.structures?.[0] || null;
    const render = instant?.render_data || null;
    if (!structure || !render) return null;
    const cols = Math.max(2, Math.round(toFiniteNumber(render.cols) || 0));
    const rows = Math.max(2, Math.round(toFiniteNumber(render.rows) || 0));
    if (!cols || !rows) return null;

    const focus = structure.normalized_padded_bounds || render.mask_bounds || { left: 0.22, right: 0.78, top: 0.18, bottom: 0.82 };
    const focusWidth = Math.max(0.08, (focus.right || 0.78) - (focus.left || 0.22));
    const focusHeight = Math.max(0.08, (focus.bottom || 0.82) - (focus.top || 0.18));
    const maxHeightMeters = Math.max(0.5, toFiniteNumber(render.max_height_meters) || 0.5);
    const extentBounds = structure.project_extent_bounds || structure.padded_bounding_box || structure.bounding_box || null;
    const cells = [];

    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        const corners = [
          { u: col / (cols - 1), v: row / (rows - 1), height: renderGridValue(render, 'heights_meters', col, row), mask: renderGridValue(render, 'mask', col, row) },
          { u: (col + 1) / (cols - 1), v: row / (rows - 1), height: renderGridValue(render, 'heights_meters', col + 1, row), mask: renderGridValue(render, 'mask', col + 1, row) },
          { u: (col + 1) / (cols - 1), v: (row + 1) / (rows - 1), height: renderGridValue(render, 'heights_meters', col + 1, row + 1), mask: renderGridValue(render, 'mask', col + 1, row + 1) },
          { u: col / (cols - 1), v: (row + 1) / (rows - 1), height: renderGridValue(render, 'heights_meters', col, row + 1), mask: renderGridValue(render, 'mask', col, row + 1) }
        ];
        const centerU = averageNumbers(corners.map((corner) => corner.u));
        const centerV = averageNumbers(corners.map((corner) => corner.v));
        const centerInsideFocus = (
          centerU >= ((focus.left || 0) - (1 / cols))
          && centerU <= ((focus.right || 1) + (1 / cols))
          && centerV >= ((focus.top || 0) - (1 / rows))
          && centerV <= ((focus.bottom || 1) + (1 / rows))
        );
        if (!centerInsideFocus) continue;
        const cellMask = averageNumbers(corners.map((corner) => corner.mask));
        if (cellMask < 0.08) continue;

        const localCorners = corners.map((corner) => ({
          x: (corner.u - (focus.left || 0)) / focusWidth,
          y: (corner.v - (focus.top || 0)) / focusHeight,
          heightNorm: clamp01(corner.height / maxHeightMeters)
        }));
        const avgHeightNorm = averageNumbers(localCorners.map((corner) => corner.heightNorm));
        const baseColor = sampleTextureColor(textureSampler, centerU, centerV);
        const northMask = averageCellMask(render, col, row - 1);
        const southMask = averageCellMask(render, col, row + 1);
        const westMask = averageCellMask(render, col - 1, row);
        const eastMask = averageCellMask(render, col + 1, row);
        const northHeight = averageCellHeight(render, col, row - 1);
        const southHeight = averageCellHeight(render, col, row + 1);
        const westHeight = averageCellHeight(render, col - 1, row);
        const eastHeight = averageCellHeight(render, col + 1, row);

        cells.push({
          points: localCorners,
          color: baseColor,
          avgHeightNorm,
          mask: cellMask,
          boundaries: {
            north: northMask < 0.05 || northHeight < averageCellHeight(render, col, row),
            south: southMask < 0.05 || southHeight < averageCellHeight(render, col, row),
            west: westMask < 0.05 || westHeight < averageCellHeight(render, col, row),
            east: eastMask < 0.05 || eastHeight < averageCellHeight(render, col, row)
          }
        });
      }
    }

    const roofSegments = Array.isArray(structure.roof_segments) ? structure.roof_segments : [];
    const labels = !INSTANT_PITCH_UI_ENABLED ? [] : roofSegments.map((segment) => {
      const scenePoint = extentBounds ? normalizedPointWithinBox(segment.center, extentBounds) : null;
      if (!scenePoint) return null;
      const local = {
        x: (scenePoint.x - (focus.left || 0)) / focusWidth,
        y: (scenePoint.y - (focus.top || 0)) / focusHeight
      };
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
      const sampled = sampleRenderDataAt(render, scenePoint.x, scenePoint.y);
      return {
        pitch: toFiniteNumber(segment.pitch_degrees) || 0,
        center: local,
        heightNorm: clamp01((sampled.height || toFiniteNumber(segment.plane_height_at_center_meters) || 0) / maxHeightMeters)
      };
    }).filter(Boolean);

    if (!cells.length) return null;
    return { focus, cells, labels, maxHeightMeters };
  }

  function drawInstantScene(state){
    const { pane, canvas } = instantEls();
    if (!pane || !canvas || !state?.model) return;
    const width = Math.max(1, pane.querySelector('.v-instant-scene')?.clientWidth || canvas.clientWidth || 1);
    const height = Math.max(1, pane.querySelector('.v-instant-scene')?.clientHeight || canvas.clientHeight || 1);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    if (state.image) {
      ctx.drawImage(state.image, 0, 0, width, height);
      ctx.fillStyle = 'rgba(7, 15, 26, 0.16)';
      ctx.fillRect(0, 0, width, height);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#3d5c73');
      gradient.addColorStop(1, '#203242');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }

    const focus = state.model.focus;
    const focusRect = {
      left: width * focus.left,
      top: height * focus.top,
      width: width * Math.max(0.18, focus.right - focus.left),
      height: height * Math.max(0.18, focus.bottom - focus.top)
    };
    const center = {
      x: focusRect.left + (focusRect.width / 2),
      y: focusRect.top + (focusRect.height * 0.66)
    };
    const dims = {
      width: focusRect.width * 0.82,
      height: focusRect.height * 0.82
    };

    const rotation = state.rotation;
    const heightScale = 0.34;
    const cells = state.model.cells
      .map((cell) => {
        const top = cell.points.map((point) => projectInstantPoint(point, center, dims, rotation, point.heightNorm * heightScale));
        const base = cell.points.map((point) => projectInstantPoint(point, center, dims, rotation, 0));
        return {
          ...cell,
          top,
          base,
          sortY: averageNumbers(top.map((point) => point.y))
        };
      })
      .sort((a, b) => a.sortY - b.sortY);

    for (const cell of cells) {
      const topColor = shadeColor(cell.color, 0.92 + (cell.avgHeightNorm * 0.16));
      const westColor = shadeColor(cell.color, 0.54);
      const eastColor = shadeColor(cell.color, 0.6);
      const southColor = shadeColor(cell.color, 0.47);
      const northColor = shadeColor(cell.color, 0.66);
      if (cell.boundaries.west) drawQuad(ctx, [cell.base[3], cell.top[3], cell.top[0], cell.base[0]], rgbaColor(westColor, 0.9));
      if (cell.boundaries.north) drawQuad(ctx, [cell.base[0], cell.top[0], cell.top[1], cell.base[1]], rgbaColor(northColor, 0.86));
      if (cell.boundaries.east) drawQuad(ctx, [cell.base[1], cell.top[1], cell.top[2], cell.base[2]], rgbaColor(eastColor, 0.88));
      if (cell.boundaries.south) drawQuad(ctx, [cell.base[2], cell.top[2], cell.top[3], cell.base[3]], rgbaColor(southColor, 0.92));
      drawQuad(ctx, cell.top, rgbaColor(topColor, 0.96), 'rgba(255,255,255,0.05)');
    }

    if (INSTANT_PITCH_UI_ENABLED) {
      for (const label of state.model.labels) {
        const pitchRise = pitchToRise12(label.pitch);
        const labelPoint = projectInstantPoint(label.center, center, dims, rotation, (label.heightNorm * heightScale) + 0.04);
        if (labelPoint.x < 0 || labelPoint.x > width || labelPoint.y < 0 || labelPoint.y > height) continue;
        const labelY = labelPoint.y - 22;
        ctx.beginPath();
        ctx.moveTo(labelPoint.x, labelPoint.y - 4);
        ctx.lineTo(labelPoint.x, labelY + 10);
        ctx.strokeStyle = 'rgba(255,255,255,0.78)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(labelPoint.x, labelY, 18, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 18, 28, 0.86)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '900 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pitchRise == null ? '?' : `${pitchRise}/12`, labelPoint.x, labelY);
      }
    }
  }

  async function startInstantScene(instant, projectKey, sceneSignature){
    cancelInstantWork();
    if (!ensureInstant3DLibs()) {
      throw new Error('3D model dependencies are unavailable.');
    }

    const { canvas, labels, autoBtn, resetBtn, zoomSlider, pitchBtn, pane } = instantEls();
    const sceneHost = pane?.querySelector('.v-instant-scene');
    if (!canvas || !sceneHost || !labels) return false;

    const assets = await buildInstantSceneAssets(instant);
    if (!instantRenderIsOpen()) return false;

    const THREE_NS = window.THREE;
    const aspect = assets.sampleWidth / Math.max(assets.sampleHeight, 1);
    const physicalSize = resolveInstantCropPhysicalSize(instant, assets.cropBounds, aspect);
    const horizontalMaxMeters = Math.max(physicalSize.widthMeters, physicalSize.heightMeters, 1);
    const sceneMetersScale = 96 / horizontalMaxMeters;
    const planeWidth = physicalSize.widthMeters * sceneMetersScale;
    const planeHeight = physicalSize.heightMeters * sceneMetersScale;
    const verticalScale = sceneMetersScale;
    const maxHeightScene = Math.max(assets.maxHeightMeters * verticalScale, 0.5);
    const wallMask = buildInstantWallMask(assets.surfaceHeights, assets.sampleWidth, assets.sampleHeight, physicalSize);
    const textureCanvas = buildInstantWallOverrideTextureCanvas(assets.textureCanvas, wallMask);

    const renderer = new THREE_NS.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if ('outputEncoding' in renderer && typeof THREE_NS.sRGBEncoding !== 'undefined') {
      renderer.outputEncoding = THREE_NS.sRGBEncoding;
    }

    const scene = new THREE_NS.Scene();
    scene.background = new THREE_NS.Color(0x101a24);

    const camera = new THREE_NS.PerspectiveCamera(42, 1, 0.1, 1000);

    const controls = new THREE_NS.OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.95;
    controls.minDistance = Math.max(44, Math.min(planeWidth, planeHeight) * 0.6);
    controls.maxDistance = Math.max(120, Math.max(planeWidth, planeHeight) * 2.5);
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI / 2.08;
    scene.add(new THREE_NS.HemisphereLight(0xffffff, 0x304050, 1.45));
    const keyLight = new THREE_NS.DirectionalLight(0xffffff, 1.05);
    keyLight.position.set(-planeWidth * 0.5, maxHeightScene * 2.8, planeHeight * 0.9);
    scene.add(keyLight);
    scene.add(new THREE_NS.AmbientLight(0xffffff, 0.28));

    const geometry = new THREE_NS.PlaneGeometry(planeWidth, planeHeight, assets.sampleWidth - 1, assets.sampleHeight - 1);
    const positions = geometry.attributes.position.array;
    const labelEntries = [];
    let highestVertex = 0;

    for (let row = 0; row < assets.sampleHeight; row += 1) {
      for (let col = 0; col < assets.sampleWidth; col += 1) {
        const index = (row * assets.sampleWidth) + col;
        const sceneHeight = Number(assets.surfaceHeights[index] || 0) * verticalScale;
        positions[(index * 3) + 2] = sceneHeight;
        if (sceneHeight > highestVertex) highestVertex = sceneHeight;
      }
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();

    const texture = new THREE_NS.CanvasTexture(textureCanvas);
    if ('encoding' in texture && typeof THREE_NS.sRGBEncoding !== 'undefined') {
      texture.encoding = THREE_NS.sRGBEncoding;
    }
    texture.needsUpdate = true;

    const material = new THREE_NS.MeshStandardMaterial({
      map: texture,
      side: THREE_NS.DoubleSide,
      roughness: 0.9,
      metalness: 0.04
    });

    const mesh = new THREE_NS.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);

    const structures = getRenderableInstantStructures(instant);
    const extentBounds = structures[0]?.project_extent_bounds || structures[0]?.padded_bounding_box || structures[0]?.bounding_box || null;
    const segments = structures.flatMap((structure) => (
      Array.isArray(structure?.roof_segments) ? structure.roof_segments : []
    ));
    labels.innerHTML = '';
    if (INSTANT_PITCH_UI_ENABLED) {
      segments.forEach((segment) => {
        if (!extentBounds) return;
        const normalized = normalizePointToCrop(segment?.center, extentBounds, assets.cropBounds);
        if (!normalized) return;
        if (normalized.x < -0.05 || normalized.x > 1.05 || normalized.y < -0.05 || normalized.y > 1.05) return;
        const sampleCol = Math.max(0, Math.min(assets.sampleWidth - 1, Math.round(clamp01(normalized.x) * (assets.sampleWidth - 1))));
        const sampleRow = Math.max(0, Math.min(assets.sampleHeight - 1, Math.round(clamp01(normalized.y) * (assets.sampleHeight - 1))));
        const sampleIndex = (sampleRow * assets.sampleWidth) + sampleCol;
        const segmentHeight = Math.max(0, Number(assets.surfaceHeights[sampleIndex] || 0) * verticalScale);
        const anchorWorld = new THREE_NS.Vector3(
          (normalized.x - 0.5) * planeWidth,
          segmentHeight + 0.4,
          (normalized.y - 0.5) * planeHeight
        );
        const world = new THREE_NS.Vector3(
          (normalized.x - 0.5) * planeWidth,
          segmentHeight + 8.8,
          (normalized.y - 0.5) * planeHeight
        );
        const el = document.createElement('div');
        el.className = 'v-instant-label';
        const rise = pitchToRise12(segment?.pitch_degrees);
        el.innerHTML = `<div class="v-instant-labelBubble">${rise == null ? '?' : `${rise}/12`}</div><div class="v-instant-labelLine"></div>`;
        labels.appendChild(el);
        labelEntries.push({ el, world, anchorWorld, type: 'pitch' });
      });
    }

    if (structures.length > 1) {
      structures.forEach((structure) => {
        if (!extentBounds || !hasRenderableStructureCoverage(structure)) return;
        const normalized = normalizePointToCrop(structure?.center, extentBounds, assets.cropBounds);
        if (!normalized) return;
        if (normalized.x < -0.05 || normalized.x > 1.05 || normalized.y < -0.05 || normalized.y > 1.05) return;
        const sampleCol = Math.max(0, Math.min(assets.sampleWidth - 1, Math.round(clamp01(normalized.x) * (assets.sampleWidth - 1))));
        const sampleRow = Math.max(0, Math.min(assets.sampleHeight - 1, Math.round(clamp01(normalized.y) * (assets.sampleHeight - 1))));
        const sampleIndex = (sampleRow * assets.sampleWidth) + sampleCol;
        const structureHeight = Math.max(0, Number(assets.surfaceHeights[sampleIndex] || 0) * verticalScale);
        const anchorWorld = new THREE_NS.Vector3(
          (normalized.x - 0.5) * planeWidth,
          structureHeight + 0.6,
          (normalized.y - 0.5) * planeHeight
        );
        const world = new THREE_NS.Vector3(
          (normalized.x - 0.5) * planeWidth,
          structureHeight + 12,
          (normalized.y - 0.5) * planeHeight
        );
        const el = document.createElement('div');
        el.className = 'v-instant-label structure-label';
        el.innerHTML = `<div class="v-instant-labelBubble">${escapeHtml(String(structure?.label || '?'))}</div><div class="v-instant-labelLine"></div>`;
        labels.appendChild(el);
        labelEntries.push({ el, world, anchorWorld, type: 'structure' });
      });
    }

    const bounds = new THREE_NS.Box3().setFromObject(mesh);
    const size = bounds.getSize(new THREE_NS.Vector3());
    const center = bounds.getCenter(new THREE_NS.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fitDistance = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.48;
    const resetCameraPose = () => {
      camera.position.copy(center.clone().add(new THREE_NS.Vector3(-fitDistance * 0.74, fitDistance * 0.92, fitDistance * 0.96)));
      controls.target.copy(center.clone().add(new THREE_NS.Vector3(0, Math.max(1.2, size.y * 0.08), 0)));
      controls.update();
    };
    controls.minDistance = Math.max(44, fitDistance * 0.56);
    controls.maxDistance = Math.max(140, fitDistance * 2.4);
    resetCameraPose();

    const rendererSize = { width: 0, height: 0 };
    const resizeScene = () => {
      const rect = sceneHost.getBoundingClientRect?.() || {};
      const width = Math.max(1, Math.round(rect.width || sceneHost.clientWidth || canvas.clientWidth || 1));
      const height = Math.max(1, Math.round(rect.height || sceneHost.clientHeight || canvas.clientHeight || 1));
      if (rendererSize.width !== width || rendererSize.height !== height) {
        renderer.setSize(width, height, false);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
        rendererSize.width = width;
        rendererSize.height = height;
      }
    };

    const disableAutoRotate = () => {
      controls.autoRotate = false;
      updateInstantControls(instantSceneState);
    };

    const onControlStart = () => {
      disableAutoRotate();
      setInstantSceneDragging(true);
    };
    const onControlEnd = () => {
      setInstantSceneDragging(false);
    };
    const onAutoClick = () => {
      controls.autoRotate = !controls.autoRotate;
      updateInstantControls(instantSceneState);
    };
    const onResetClick = () => {
      disableAutoRotate();
      resetCameraPose();
    };
    const onPitchToggle = () => {
      if (!instantSceneState) return;
      instantSceneState.labelsVisible = instantSceneState.labelsVisible === false;
      updateInstantControls(instantSceneState);
      updateInstantLabelPositions(instantSceneState);
    };
    const onZoomStart = () => {
      controls.enabled = false;
      disableAutoRotate();
    };
    const onZoomEnd = () => {
      controls.enabled = true;
      updateInstantControls(instantSceneState);
    };
    const onZoomInput = () => {
      if (!zoomSlider) return;
      const minDistance = Number(controls.minDistance || 1);
      const maxDistance = Number(controls.maxDistance || (minDistance + 1));
      const sliderValue = Math.max(0, Math.min(100, Number(zoomSlider.value || 0)));
      const nextDistance = maxDistance - ((sliderValue / 100) * (maxDistance - minDistance));
      const direction = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target.clone().add(direction.multiplyScalar(nextDistance)));
      controls.update();
      updateInstantControls(instantSceneState);
    };
    const onZoomChange = () => {
      onZoomInput();
      onZoomEnd();
    };

    controls.addEventListener('start', onControlStart);
    controls.addEventListener('end', onControlEnd);
    controls.addEventListener('change', () => updateInstantControls(instantSceneState));
    autoBtn?.addEventListener('click', onAutoClick);
    resetBtn?.addEventListener('click', onResetClick);
    pitchBtn?.addEventListener('click', onPitchToggle);
    zoomSlider?.addEventListener('pointerdown', onZoomStart);
    zoomSlider?.addEventListener('mousedown', onZoomStart);
    zoomSlider?.addEventListener('touchstart', onZoomStart);
    zoomSlider?.addEventListener('pointerup', onZoomEnd);
    zoomSlider?.addEventListener('mouseup', onZoomEnd);
    zoomSlider?.addEventListener('touchend', onZoomEnd);
    zoomSlider?.addEventListener('blur', onZoomEnd);
    zoomSlider?.addEventListener('input', onZoomInput);
    zoomSlider?.addEventListener('change', onZoomChange);
    window.addEventListener('pointerup', onZoomEnd);
    window.addEventListener('mouseup', onZoomEnd);
    window.addEventListener('touchend', onZoomEnd);

    instantSceneState = {
      projectKey: projectKey || null,
      sceneSignature: String(sceneSignature || buildInstantSceneSignature(instant) || ''),
      renderer,
      scene,
      camera,
      controls,
      mesh,
      labelEntries,
      labelsVisible: INSTANT_PITCH_UI_ENABLED,
      disposeList: [geometry, material, texture],
      raf: 0,
      detach: () => {
        controls.removeEventListener('start', onControlStart);
        controls.removeEventListener('end', onControlEnd);
        autoBtn?.removeEventListener('click', onAutoClick);
        resetBtn?.removeEventListener('click', onResetClick);
        pitchBtn?.removeEventListener('click', onPitchToggle);
        zoomSlider?.removeEventListener('pointerdown', onZoomStart);
        zoomSlider?.removeEventListener('mousedown', onZoomStart);
        zoomSlider?.removeEventListener('touchstart', onZoomStart);
        zoomSlider?.removeEventListener('pointerup', onZoomEnd);
        zoomSlider?.removeEventListener('mouseup', onZoomEnd);
        zoomSlider?.removeEventListener('touchend', onZoomEnd);
        zoomSlider?.removeEventListener('blur', onZoomEnd);
        zoomSlider?.removeEventListener('input', onZoomInput);
        zoomSlider?.removeEventListener('change', onZoomChange);
        window.removeEventListener('pointerup', onZoomEnd);
        window.removeEventListener('mouseup', onZoomEnd);
        window.removeEventListener('touchend', onZoomEnd);
        setInstantSceneDragging(false);
      }
    };
    updateInstantControls(instantSceneState);

    const renderLoop = () => {
      if (!instantSceneState) return;
      resizeScene();
      controls.update();
      renderer.render(scene, camera);
      updateInstantLabelPositions(instantSceneState);
      instantSceneState.raf = requestAnimationFrame(renderLoop);
    };
    renderLoop();
    return true;
  }

  async function renderInstantPayload(project, instant){
    instant = focusSinglePinInstantPayload(project, instant);
    const { loading, stats } = instantEls();
    const statusEl = instantDomScope ? null : $('#vmStatus', panelEl);
    const projectId = firstMeasureProjectId(project);
    const cacheKey = `${project?.instant_only ? 'instant' : 'project'}:${projectId}`;
    const sceneSignature = buildInstantSceneSignature(instant);
    instantPayloadCache.set(cacheKey, instant);
    ensureInstantStatsScope(instant);
    renderInstantStatsPanel(instant, project);
    if (!instantRenderIsOpen()) return;
    if (
      instantSceneState?.projectKey === cacheKey
      && instantSceneState?.renderer
      && instantSceneState?.sceneSignature === sceneSignature
    ) {
      if (statusEl) {
        statusEl.textContent = 'INSTANT READY';
        statusEl.style.color = '#8ab4f8';
      }
      if (loading) {
        loading.style.display = 'none';
        loading.classList.remove('error');
      }
      return true;
    }
    resetInstantCanvasSurface();
    if (loading) {
      setInstantLoading();
    }
    const didStartScene = await startInstantScene(instant, cacheKey, sceneSignature);
    if (didStartScene) {
      if (statusEl) {
        statusEl.textContent = 'INSTANT READY';
        statusEl.style.color = '#8ab4f8';
      }
      if (loading) {
        loading.style.display = 'none';
        loading.classList.remove('error');
      }
    } else {
      if (statusEl) {
        statusEl.textContent = projectReportMode(project) === 'both' ? 'FULL REPORT PROCESSING' : 'INSTANT REPORT';
        statusEl.style.color = '#8ab4f8';
      }
      if (loading) {
        setInstantLoading();
      }
    }
    const instantPdfUrl = String(instant?.assets?.instant_pdf_url || '').trim();
    const instantPdfStatus = String(instant?.instant_pdf?.status || '').trim().toLowerCase();
    const instantPdfReady = !!instantPdfUrl && instantPdfStatus !== 'failed';
    if (!instantPdfReady) {
      scheduleInstantRetry(project, instantDomScope ? instantStandaloneNonce : __modalNonce, 0);
    }
    return !!didStartScene;
  }

  async function loadInstantForProject(project, nonce, attempt){
    const id = firstMeasureProjectId(project);
    const path = getInstantPath(project);
    if (!id || !path || !fmJson) {
      showInstantPane(project, 'Instant preview is unavailable for this project.', true);
      return;
    }
    const cacheKey = `${project?.instant_only ? 'instant' : 'project'}:${id}`;
    const cachedInstant = instantPayloadCache.get(cacheKey);
    const sceneAlreadyActive = !!(
      instantSceneState?.projectKey === cacheKey
      && instantSceneState?.renderer
      && instantSceneState?.sceneSignature
      && cachedInstant
      && instantSceneState.sceneSignature === buildInstantSceneSignature(cachedInstant)
    );
    let renderedCached = false;
    const cachedNeedsRepair = instantNeedsMultiStructureRepair(project, cachedInstant);
    if (cachedInstant?.render_data && !cachedNeedsRepair) {
      renderedCached = await renderInstantPayload(project, cachedInstant);
      const cachedPdfReady = !!String(cachedInstant?.assets?.instant_pdf_url || '').trim() && String(cachedInstant?.instant_pdf?.status || '').trim().toLowerCase() !== 'failed';
      if (renderedCached && cachedPdfReady) return;
    }

    if (!renderedCached && !sceneAlreadyActive) {
      showInstantPane(project);
    }
    try{
      const data = await fmJson(path);
      if (!instantRenderIsOpen(nonce)) return;
      const instant = await ensureMultiStructureInstant(project, data?.instant || null);
      if (!instantRenderIsOpen(nonce)) return;
      const rendered = await renderInstantPayload(project, instant);
      if (!rendered) {
        scheduleInstantRetry(project, nonce, attempt);
      }
    }catch(err){
      if (!instantRenderIsOpen(nonce)) return;
      const message = String(err?.message || '').toLowerCase();
      const shouldRetry = (
        (attempt || 0) < INSTANT_RETRY_LIMIT
        && (
          message.includes('instant')
          || message.includes('model')
          || message.includes('insights')
          || message.includes('not have')
          || message.includes('request failed (400)')
          || message.includes('invalid json (400)')
        )
      );
      if (!renderedCached) {
        showInstantPane(project, shouldRetry ? null : 'We could not load the FirstMeasure instant just yet.', !shouldRetry);
      }
      if (shouldRetry) {
        scheduleInstantRetry(project, nonce, attempt);
      }
    }
  }

  function modalEls(){
    return {
      tabs: document.getElementById('vmTabs'),
      stage: document.getElementById('vmFrameStage'),
      footer: document.getElementById('vmFrameFooter'),
      footerLeft: document.getElementById('vmFooterLeft'),
      footerRight: document.getElementById('vmFooterRight'),
      footerPop: document.getElementById('vmFooterPop')
    };
  }
  function setModalTabState(activeTab){
    const modal = panelEl?.querySelector?.('.v-modal');
    if (!modal) return;
    modal.classList.remove('mobile-tab-info', 'mobile-tab-map', 'mobile-tab-measurements');
    if (activeTab) modal.classList.add(`mobile-tab-${activeTab}`);
  }
  function renderProjectMap(project){
    const mapEl = document.getElementById('vmMapCanvas');
    if (!mapEl) return;
    const lat = parseFloat(project?.lat);
    const lng = parseFloat(project?.lng);
    const ensure = ensureViewMap();
    clearExtraMarkers();
    const allPins = [];
    const pinsData = Array.isArray(project?.pins) ? project.pins : [];
    if (pinsData.length > 0){
      for (const pin of pinsData){
        const pLat = parseFloat(pin.lat);
        const pLng = parseFloat(pin.lng);
        if (!isNaN(pLat) && !isNaN(pLng)) allPins.push({ lat: pLat, lng: pLng });
      }
    }
    if (allPins.length === 0 && !isNaN(lat) && !isNaN(lng)) allPins.push({ lat, lng });
    if (!ensure || !allPins.length) return;
    viewMarker.setPosition(allPins[0]);
    for (let i = 1; i < allPins.length; i += 1){
      const marker = new google.maps.Marker({ map: viewMap, position: allPins[i], label: { text: String(i + 1), color:'#fff', fontWeight:'bold', fontSize:'11px' } });
      viewExtraMarkers.push(marker);
    }
    if (allPins.length > 1){ viewMarker.setLabel({ text: '1', color:'#fff', fontWeight:'bold', fontSize:'11px' }); } else { viewMarker.setLabel(null); }
    if (allPins.length > 1){
      const bounds = new google.maps.LatLngBounds();
      for (const pin of allPins) bounds.extend(pin);
      viewMap.fitBounds(bounds, 60);
    } else {
      viewMap.setCenter(allPins[0]);
      viewMap.setZoom(19);
    }
    setTimeout(() => {
      try{
        google.maps.event.trigger(viewMap, 'resize');
        if (allPins.length > 1){
          const bounds = new google.maps.LatLngBounds();
          for (const pin of allPins) bounds.extend(pin);
          viewMap.fitBounds(bounds, 60);
        } else {
          viewMap.setCenter(allPins[0]);
        }
      }catch(e){}
    }, 250);
  }

  function buildQueuePayloadFromProject(project, options){
    const includeGutters = options?.includeGutters === true;
    const pins = Array.isArray(project?.pins) && project.pins.length
      ? project.pins.map((pin) => ({
          lat: Number(pin?.lat ?? pin?.latitude ?? project?.lat ?? 0),
          lng: Number(pin?.lng ?? pin?.longitude ?? project?.lng ?? 0)
        })).filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lng))
      : [];
    const resident = {
      ...resolveResidentFields(project),
      ...(options?.resident || {})
    };
    const ccEmails = Array.isArray(options?.ccEmails)
      ? options.ccEmails
      : (Array.isArray(project?.cc_emails) ? project.cc_emails : []);
    const techNotes = options?.techNotes != null ? String(options.techNotes) : String(project?.tech_notes || '');
    return {
      issuerName: String(window.Portal?.cfg?.userName || '').trim(),
      issuerEmail: String(window.Portal?.cfg?.userEmail || '').trim(),
      address: String(project?.address || displayAddressPlain(project) || '').trim(),
      lat: String(project?.lat ?? pins[0]?.lat ?? ''),
      lng: String(project?.lng ?? pins[0]?.lng ?? ''),
      resident_name: resident.name || '',
      resident_email: resident.email || '',
      resident_phone: resident.phone || '',
      project_type: String(project?.project_type || 'residential'),
      report_mode: 'full',
      include_gutter_measurements: includeGutters ? '1' : '0',
      pins: JSON.stringify(pins),
      cc_emails: JSON.stringify(ccEmails),
      tech_notes: techNotes
    };
  }

  async function submitFullReportUpgrade(project, options){
    const payload = buildQueuePayloadFromProject(project, options);
    const result = await postAction('queue', payload);
    const data = result?.data || null;
    if (!result?.res?.ok || !data?.success) {
      throw new Error(String(data?.error || 'Unable to order the standard report.'));
    }
    const linkedFullProject = normalizeProjectRecord(data?.project || data?.manifest || {});
    const submittedResident = {
      name: payload.resident_name || '',
      email: payload.resident_email || '',
      phone: payload.resident_phone || ''
    };
    project.resident = submittedResident.name;
    project.resident_email = submittedResident.email;
    project.resident_phone = submittedResident.phone;
    project.cc_emails = (() => { try { return JSON.parse(payload.cc_emails || '[]'); } catch (e) { return []; } })();
    project.tech_notes = payload.tech_notes || '';
    project.include_gutter_measurements = payload.include_gutter_measurements;
    project._linkedFullProject = linkedFullProject;
    project.instant_only = false;
    project.instant_enabled = true;
    if (linkedFullProject && typeof linkedFullProject === 'object') {
      linkedFullProject.resident = submittedResident.name;
      linkedFullProject.resident_email = submittedResident.email;
      linkedFullProject.resident_phone = submittedResident.phone;
      linkedFullProject.cc_emails = project.cc_emails;
      linkedFullProject.tech_notes = project.tech_notes;
      linkedFullProject.include_gutter_measurements = payload.include_gutter_measurements;
    }
    lastProjectsById.set(String(project.id), normalizeProjectRecord(project));
    if (linkedFullProject?.id) lastProjectsById.set(String(linkedFullProject.id), linkedFullProject);
    try { window.Portal?.credits?.refreshCredits?.(); } catch (e) {}
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail:{ redraw:true } }));
    return linkedFullProject;
  }

  function renderModalTabs(config){
    const { tabs, stage } = modalEls();
    if (!tabs) return;
    const tabItems = [];
    if (config.showInfo) {
      tabItems.push({
        id: 'info',
        label: 'Info',
        icon: 'fa-circle-info',
        buttonId: 'vmTabInfo',
        className: 'is-info-tab',
        active: config.activeMainTab === 'info'
      });
    }
    if (config.showMap) {
      tabItems.push({
        id: 'map',
        label: 'Map',
        icon: 'fa-map-location-dot',
        buttonId: 'vmTabMap',
        active: config.activeMainTab === 'map'
      });
    }
    if (config.showMeasurements) {
      tabItems.push({
        id: 'measurements',
        label: 'Measurements',
        icon: 'fa-ruler-combined',
        buttonId: 'vmTabMeasurements',
        active: config.activeMainTab === 'measurements'
      });
    }
    window.Portal.ProjectViewer.renderTabs(tabs, tabItems, { tabClass: 'v-report-tab' });
    tabs.style.display = tabItems.length ? 'flex' : 'none';
    if (stage) stage.style.top = tabItems.length ? '62px' : '0';
  }

  function renderMeasurementTabs(config){
    const bar = document.getElementById('vmMeasureTabs');
    const stage = document.getElementById('vmFrameStage');
    if (!bar || !stage) return;
    const tabs = Array.isArray(config?.tabs) ? config.tabs : [];
    if (!config?.show || !tabs.length) {
      bar.classList.remove('active');
      bar.innerHTML = '';
      stage.classList.remove('has-measure-tabs');
      return;
    }
    window.Portal.ProjectViewer.renderTabs(bar, tabs.map((tab) => ({
      ...tab,
      buttonId: tab.id === 'instant'
        ? 'vmSubTabInstant'
        : (tab.id === 'standard'
          ? 'vmSubTabStandard'
          : (tab.id === 'changes'
            ? 'vmSubTabChanges'
            : (tab.id === 'xml' ? 'vmSubTabXml' : 'vmSubTabCustomer')))
    })), { tabClass: 'v-measure-tab' });
    bar.classList.add('active');
    stage.classList.add('has-measure-tabs');
  }

  function renderModalFooter(config){
    const { footer, footerLeft, footerRight, footerPop, stage } = modalEls();
    if (!footer || !footerLeft || !footerRight || !footerPop) return;
    footer.style.display = config.show ? '' : 'none';
    if (stage) stage.style.bottom = config.show ? '60px' : '0';
    if (!config.show) {
      footerLeft.innerHTML = '';
      footerRight.innerHTML = '';
      footerPop.classList.remove('active');
      footerPop.innerHTML = '';
      return;
    }
    footerLeft.innerHTML = config.leftHtml || '';
    footerRight.innerHTML = config.rightHtml || '';
    footerPop.classList.toggle('active', !!config.popActive);
    footerPop.innerHTML = config.popHtml || '';
  }

  function normalizeStr(s){ return String(s||'').trim().toLowerCase(); }

  const PROJECT_TYPE_META = {
    residential:  { label:'Residential', short:'RES',  icon:'fa-house',     color:'#666', cls:'v-type-res' },
    commercial:   { label:'Commercial',  short:'COM',  icon:'fa-building',  color:'#666', cls:'v-type-com' },
    multifamily:  { label:'Multifamily', short:'MF',   icon:'fa-buildings', color:'#666', cls:'v-type-mf' },
  };
  const PROJECT_STAGE_COLUMNS = [
    { id:'new_lead', label:'New Lead', icon:'fa-user-plus' },
    { id:'appointment_scheduled', label:'Appointment Scheduled', icon:'fa-calendar-check' },
    { id:'drafting_proposal', label:'Drafting Proposal', icon:'fa-file-pen' },
    { id:'proposal_sent', label:'Proposal Sent', icon:'fa-paper-plane' },
    { id:'newly_sold', label:'Sold', icon:'fa-handshake' },
    { id:'project_started', label:'Project Started', icon:'fa-play' },
    { id:'in_progress', label:'In Progress', icon:'fa-spinner' },
    { id:'completed', label:'Completed', icon:'fa-check' },
    { id:'cancelled', label:'Cancelled', icon:'fa-ban', terminal:true },
    { id:'lost', label:'Lost', icon:'fa-circle-xmark', terminal:true },
  ];
  const OPTIONAL_PROJECT_STAGE_COLUMNS = {
    contacting: { id:'contacting', label:'Contacting', icon:'fa-phone', after:'new_lead' },
    job_sold: { id:'job_sold', label:'Job Sold', icon:'fa-handshake', after:'newly_sold' }
  };
  const PROJECT_STAGE_BY_ID = new Map(PROJECT_STAGE_COLUMNS.map((stage, index) => [stage.id, { ...stage, index }]));
  Object.values(OPTIONAL_PROJECT_STAGE_COLUMNS).forEach((stage) => {
    PROJECT_STAGE_BY_ID.set(stage.id, { ...stage, optional:true });
  });
  const PROJECT_STAGE_RANK = new Map(PROJECT_STAGE_COLUMNS.map((stage, index) => [stage.id, index]));
  const OPTIONAL_PROJECT_STAGE_RANK = new Map(Object.values(OPTIONAL_PROJECT_STAGE_COLUMNS).map((stage) => {
    const baseRank = PROJECT_STAGE_RANK.has(stage.after) ? PROJECT_STAGE_RANK.get(stage.after) : PROJECT_STAGE_COLUMNS.length;
    return [stage.id, baseRank + 0.5];
  }));
  const LEGACY_PROJECT_STAGE_MAP = {
    contacting: 'contacting',
    contact: 'contacting',
    lead: 'new_lead',
    sold: 'newly_sold',
    newly_sold: 'newly_sold',
    closed_won: 'newly_sold',
    won: 'newly_sold',
    started: 'project_started',
    active: 'in_progress',
    complete: 'completed',
    done: 'completed',
    canceled: 'cancelled',
    measurement_ordered: '',
    measurement_cancelled: 'cancelled',
    proposal_only: 'drafting_proposal'
  };
  function projectIncludesGutters(p){
    if (String(p?.project_type || 'residential').trim().toLowerCase() !== 'residential') return false;
    const value = p?.include_gutter_measurements;
    return value === true || value === 1 || value === '1' || String(value || '').trim().toLowerCase() === 'true';
  }
  function firstNonEmptyString(...values){
    for (const value of values){
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      const lowered = trimmed.toLowerCase();
      if (lowered === 'n/a' || lowered === 'na' || lowered === 'none' || lowered === 'null' || lowered === 'undefined' || trimmed === '-' || trimmed === '\u2014') continue;
      return trimmed;
    }
    return '';
  }
  function resolveResidentFields(p){
    const residentObj = (p?.resident && typeof p.resident === 'object' && !Array.isArray(p.resident))
      ? p.resident
      : ((p?.manifest?.resident && typeof p.manifest.resident === 'object' && !Array.isArray(p.manifest.resident)) ? p.manifest.resident : null);
    const contactCandidates = projectContactCandidates(p);
    const primaryContact = contactCandidates[0] || {};
    const contactNames = uniqueContactValues(contactCandidates.map((contact) => contact.name));
    const contactDetails = uniqueContactValues(contactCandidates.flatMap((contact) => [contact.email, contact.phone]));
    const fallbackName = firstNonEmptyString(
      typeof p?.resident === 'string' ? p.resident : '',
      p?.resident_name,
      p?.residentName,
      residentObj?.name
    );
    const fallbackEmail = firstNonEmptyString(
      p?.resident_email,
      p?.residentEmail,
      residentObj?.email
    );
    const fallbackPhone = firstNonEmptyString(
      p?.resident_phone,
      p?.residentPhone,
      residentObj?.phone
    );
    const name = firstNonEmptyString(primaryContact.name, fallbackName);
    const email = firstNonEmptyString(primaryContact.email, fallbackEmail);
    const phone = firstNonEmptyString(primaryContact.phone, fallbackPhone);
    const displayName = contactNames.length ? contactNames.join(', ') : name;
    const displayDetail = contactDetails.length ? contactDetails.join(' | ') : firstNonEmptyString(email, phone);
    return {
      name,
      email,
      phone,
      contacts: contactCandidates,
      displayName,
      displayDetail,
      sortValue: contactNames.length ? contactNames.join(' ') : displayName,
      searchText: uniqueContactValues(contactCandidates.flatMap((contact) => [contact.name, contact.email, contact.phone])).join(' ')
    };
  }
  function contactField(source, ...keys){
    if (!source || typeof source !== 'object') return '';
    for (const key of keys){
      const value = firstNonEmptyString(source[key]);
      if (value) return value;
    }
    return '';
  }
  function normalizeProjectContact(source = {}){
    return {
      id: contactField(source, 'id', 'contact_id', 'primary_contact_id'),
      contact_id: contactField(source, 'contact_id', 'id', 'primary_contact_id'),
      name: contactField(source, 'name', 'full_name', 'display_name'),
      email: contactField(source, 'email', 'email_address'),
      phone: contactField(source, 'phone', 'phone_number', 'mobile')
    };
  }
  function contactIdentity(contact = {}){
    const email = String(contact.email || '').trim().toLowerCase();
    if (email) return `email:${email}`;
    const phone = String(contact.phone || '').replace(/[^\d]/g, '');
    if (phone.length >= 7) return `phone:${phone}`;
    const id = String(contact.id || contact.contact_id || '').trim();
    if (id) return `id:${id}`;
    const name = String(contact.name || '').trim().toLowerCase();
    return name ? `name:${name}` : '';
  }
  function uniqueContactValues(values = []){
    const seen = new Set();
    const out = [];
    values.forEach((value) => {
      const text = firstNonEmptyString(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return;
      seen.add(key);
      out.push(text);
    });
    return out;
  }
  function projectContactCandidates(p = {}){
    const manifest = (p?.manifest && typeof p.manifest === 'object' && !Array.isArray(p.manifest)) ? p.manifest : {};
    const residentObj = (p?.resident && typeof p.resident === 'object' && !Array.isArray(p.resident))
      ? p.resident
      : ((manifest.resident && typeof manifest.resident === 'object' && !Array.isArray(manifest.resident)) ? manifest.resident : {});
    const customerObj = (p?.customer && typeof p.customer === 'object' && !Array.isArray(p.customer))
      ? p.customer
      : ((manifest.customer && typeof manifest.customer === 'object' && !Array.isArray(manifest.customer)) ? manifest.customer : {});
    const rawContacts = [
      ...(Array.isArray(p?.contacts) ? p.contacts : []),
      ...(Array.isArray(manifest.contacts) ? manifest.contacts : []),
      p?.contact,
      manifest.contact,
      customerObj,
      residentObj,
      {
        id: firstNonEmptyString(p?.contact_id, p?.primary_contact_id, manifest.contact_id, manifest.primary_contact_id),
        name: firstNonEmptyString(p?.customer_name, p?.customerName, p?.primary_contact_name, p?.resident_name, p?.residentName, typeof p?.resident === 'string' ? p.resident : '', manifest.customer_name, manifest.primary_contact_name, manifest.resident_name),
        email: firstNonEmptyString(p?.customer_email, p?.customerEmail, p?.primary_contact_email, p?.resident_email, p?.residentEmail, manifest.customer_email, manifest.primary_contact_email, manifest.resident_email),
        phone: firstNonEmptyString(p?.customer_phone, p?.customerPhone, p?.primary_contact_phone, p?.resident_phone, p?.residentPhone, manifest.customer_phone, manifest.primary_contact_phone, manifest.resident_phone)
      }
    ];
    const seen = new Set();
    const contacts = [];
    rawContacts.forEach((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return;
      const contact = normalizeProjectContact(source);
      if (!contact.name && !contact.email && !contact.phone) return;
      const key = contactIdentity(contact);
      if (!key || seen.has(key)) return;
      seen.add(key);
      contacts.push(contact);
    });
    return contacts;
  }
  function identityText(value){
    if (value && typeof value === 'object') return '';
    const text = String(value ?? '').trim();
    if (!text) return '';
    const lowered = text.toLowerCase();
    if (lowered === 'n/a' || lowered === 'na' || lowered === 'none' || lowered === 'null' || lowered === 'undefined' || text === '-' || text === '\u2014') return '';
    return text;
  }
  function isFirstMeasureCompleteStatus(...values){
    return values
      .map((value) => identityText(value).toLowerCase())
      .some((status) => status === 'completed' || status === 'complete');
  }
  function parseReleaseHoldDate(value){
    const text = identityText(value);
    if (!text) return null;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = Date.parse(hasExplicitZone ? isoish : `${isoish}Z`);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  function projectReleaseHoldIsActive(...sources){
    return sources.some((source) => {
      if (!source || typeof source !== 'object') return false;
      const raw = (source.raw && typeof source.raw === 'object') ? source.raw : {};
      const manifest = (source.manifest && typeof source.manifest === 'object')
        ? source.manifest
        : ((raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : source);
      const delivery = (manifest.delivery && typeof manifest.delivery === 'object') ? manifest.delivery : {};
      const hold = (manifest.delivery_release_hold && typeof manifest.delivery_release_hold === 'object')
        ? manifest.delivery_release_hold
        : ((delivery.release_hold && typeof delivery.release_hold === 'object') ? delivery.release_hold : {});
      const status = String(manifest.delivery_hold_status || hold.status || '').trim().toLowerCase();
      if (status !== 'holding') return false;
      const scheduled = parseReleaseHoldDate(manifest.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '');
      return !!scheduled && scheduled.getTime() > Date.now();
    });
  }
  function isPlatformProjectId(value){
    return /^(project|base|__optimistic)_/i.test(String(value || '').trim());
  }
  function firstMeasurementId(...values){
    for (const value of values){
      const text = identityText(value);
      if (text && !isPlatformProjectId(text)) return text;
    }
    return '';
  }
  function measurementIdFromAssetUrl(...values){
    for (const value of values){
      const text = identityText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? firstMeasurementId(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  }
  function firstMeasureProjectId(project){
    const p = project || {};
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    return firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.id,
      raw.project_id,
      raw.folder,
      p.measurement_project_id,
      p.project_id,
      p.folder,
      p.id,
      measurementIdFromAssetUrl(
        p.report_url,
        p.pdf_url,
        p.summary_url,
        p.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url
      )
    );
  }
  function addIdentityKey(keys, namespace, value){
    const text = identityText(value);
    if (!text || (namespace === 'measurement' && isPlatformProjectId(text))) return;
    const key = `${namespace}:${text}`;
    if (!keys.includes(key)) keys.push(key);
  }
  function projectIdentityKeys(project){
    const p = project || {};
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const keys = [];
    addIdentityKey(keys, 'measurement', measurement.id);
    addIdentityKey(keys, 'measurement', measurement.project_id);
    addIdentityKey(keys, 'measurement', measurement.folder);
    addIdentityKey(keys, 'measurement', measurement.measurement_project_id);
    addIdentityKey(keys, 'measurement', raw.id);
    addIdentityKey(keys, 'measurement', raw.project_id);
    addIdentityKey(keys, 'measurement', raw.folder);
    addIdentityKey(keys, 'measurement', p.measurement_project_id);
    addIdentityKey(keys, 'measurement', p.project_id);
    addIdentityKey(keys, 'measurement', p.folder);
    addIdentityKey(keys, 'measurement', measurementIdFromAssetUrl(
      p.report_url,
      p.pdf_url,
      p.summary_url,
      p.xml_url,
      measurement.report_url,
      measurement.pdf_url,
      measurement.summary_url,
      measurement.xml_url,
      raw.report_url,
      raw.pdf_url,
      raw.summary_url,
      raw.xml_url
    ));
    addIdentityKey(keys, 'platform', p.platform_project_id);
    addIdentityKey(keys, 'platform', p.base_project_id);
    if (identityText(p.id) && !String(p.id).startsWith('__optimistic_')) {
      addIdentityKey(keys, String(p.id).startsWith('project_') || String(p.id).startsWith('base_') ? 'platform' : 'measurement', p.id);
    }
    const address = normalizeStr(p.address || displayAddressPlain(p));
    const date = identityText(p.created_at || p.queued_at || p.updated_at || measurement.submitted_at);
    if (address) addIdentityKey(keys, 'address', `${address}|${date}`);
    return keys;
  }
  function projectStableKey(project){
    return projectIdentityKeys(project)[0] || `runtime:${identityText(project?.id) || normalizeStr(project?.address || displayAddressPlain(project))}`;
  }
  function projectLookupKeys(project){
    const p = project || {};
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    return [
      isPlatformProjectId(p.id) ? '' : p.id,
      p.platform_project_id,
      p.base_project_id,
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      p.measurement_project_id,
      p.project_id,
      p.folder,
    ].map(identityText).filter(Boolean);
  }
  function indexProjectLookups(projects){
    const map = new Map();
    (Array.isArray(projects) ? projects : []).forEach((project) => {
      projectLookupKeys(project).forEach((key) => map.set(String(key), project));
    });
    return map;
  }
  function dedupeProjects(projects){
    const byKey = new Map();
    const order = [];
    (Array.isArray(projects) ? projects : []).forEach((project) => {
      const key = projectStableKey(project);
      if (!byKey.has(key)) {
        byKey.set(key, project);
        order.push(key);
        return;
      }
      const existing = byKey.get(key);
      if (existing?._optimistic && !project?._optimistic) {
        byKey.set(key, project);
        return;
      }
      if (!existing?._optimistic && project?._optimistic) return;
      byKey.set(key, mergeProjectForRefresh(existing, project));
    });
    return order.map((key) => byKey.get(key)).filter(Boolean);
  }
  function normalizeCcEmails(values){
    const out = [];
    const seen = new Set();
    const list = Array.isArray(values) ? values : [];
    for (const raw of list) {
      const email = String(raw || '').trim();
      if (!email) continue;
      const lowered = email.toLowerCase();
      if (seen.has(lowered)) continue;
      seen.add(lowered);
      out.push(email);
    }
    return out;
  }
  function fullReportUpgradePrefill(project){
    const resident = resolveResidentFields(project);
    return {
      residentName: resident.name || '',
      residentEmail: resident.email || '',
      residentPhone: resident.phone || '',
      ccEmails: normalizeCcEmails(Array.isArray(project?.cc_emails) ? project.cc_emails : []),
      techNotes: String(project?.tech_notes || ''),
      includeGutters: canOfferGutterUpgrade(project) ? projectIncludesGutters(project) : false
    };
  }
  function buildUpgradeCcRow(value){
    return `
      <div class="v-upgrade-ccRow">
        <input type="email" class="v-upgrade-ccInput" placeholder="name@example.com" value="${escapeHtml(String(value || ''))}">
        <button type="button" class="v-upgrade-ccRemove" data-fm-tooltip="Remove CC"><i class="fas fa-times"></i></button>
      </div>
    `;
  }
  function renderUpgradeCcRows(values){
    const { ccList } = upgradeEls();
    if (!ccList) return;
    const emails = normalizeCcEmails(Array.isArray(values) ? values : []);
    ccList.innerHTML = emails.map((email) => buildUpgradeCcRow(email)).join('');
    ccList.querySelectorAll('.v-upgrade-ccRemove').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('.v-upgrade-ccRow');
        if (!row || !ccList.contains(row)) return;
        row.remove();
      });
    });
  }
  function collectUpgradeCcEmails(){
    const { ccList } = upgradeEls();
    if (!ccList) return [];
    return normalizeCcEmails(
      Array.from(ccList.querySelectorAll('.v-upgrade-ccInput')).map((input) => input.value)
    );
  }
  function updateUpgradePrice(project){
    const { price, submit } = upgradeEls();
    const quote = fullReportQuoteWithGutters(project, upgradeDialogIncludesGutters());
    const total = fmtMoney(quote.final_amount);
    if (price) {
      price.innerHTML = quote.active
        ? `Total <strong>$${total}</strong><div class="v-upgrade-discount"><s>$${fmtMoney(quote.original_amount)}</s>${quote.discount_percent}% referral discount</div>`
        : `Total <strong>$${total}</strong>`;
    }
    if (submit && !submit.disabled) {
      submit.innerHTML = `<i class="fas fa-file-lines"></i> Submit Order · $${total}`;
    }
  }
  function setUpgradeSubmitState(isSubmitting, project){
    const { submit, cancel } = upgradeEls();
    if (submit) {
      submit.disabled = !!isSubmitting;
      submit.innerHTML = isSubmitting
        ? '<i class="fas fa-circle-notch fa-spin"></i> Submitting Order'
        : `<i class="fas fa-file-lines"></i> Submit Order · $${fmtMoney(fullReportPriceWithGutters(project, !!upgradeEls().gutters?.checked))}`;
    }
    if (cancel) cancel.disabled = !!isSubmitting;
  }
  function hideFullReportUpgradeDialog(){
    const { overlay, dialog } = upgradeEls();
    if (overlay) overlay.classList.remove('active');
    if (dialog) dialog.innerHTML = '';
  }
  function showFullReportUpgradeDialog(project){
    const { overlay, dialog } = upgradeEls();
    if (!overlay || !dialog) return;
    const prefill = fullReportUpgradePrefill(project);
    const gutterEligible = canOfferGutterUpgrade(project);
    dialog.innerHTML = `
      <form id="vmUpgradeForm" class="v-upgrade-form">
        <div class="v-upgrade-title">Order Standard Report</div>
        ${gutterEligible ? `
          <div class="v-upgrade-section">
            <label class="v-upgrade-sectionTitle">Report Scope</label>
            <div class="v-upgrade-scopeGroup" id="vmUpgradeScopeGroup">
              <button type="button" class="v-upgrade-scopeBtn${prefill.includeGutters ? '' : ' active'}" data-scope="roof_only">
                <span class="v-upgrade-scopePrice">${fullReportPriceHtml(project, false)}</span>
                <span class="v-upgrade-scopeBody">
                  <span class="v-upgrade-scopeTitle">Roof Only</span>
                </span>
              </button>
              <button type="button" class="v-upgrade-scopeBtn${prefill.includeGutters ? ' active' : ''}" data-scope="roof_and_gutters">
                <span class="v-upgrade-scopePrice">${fullReportPriceHtml(project, true)}</span>
                <span class="v-upgrade-scopeBody">
                  <span class="v-upgrade-scopeTitle">Roof &amp; Gutters</span>
                </span>
              </button>
            </div>
          </div>
        ` : ''}
        <div class="v-upgrade-section">
          <label class="v-upgrade-sectionTitle">CC Email Addresses</label>
          <div id="vmUpgradeCcList" class="v-upgrade-ccList"></div>
          <button type="button" id="vmUpgradeAddCc" class="v-upgrade-addCc"><i class="fas fa-plus"></i> Add CC</button>
        </div>
        <div class="v-upgrade-section">
          <div class="v-upgrade-field">
            <label for="vmUpgradeTechNotes">Notes for Technician</label>
            <textarea id="vmUpgradeTechNotes" placeholder="Anything the technician should know about this property...">${escapeHtml(prefill.techNotes)}</textarea>
          </div>
        </div>
        <div class="v-upgrade-section">
          <label class="v-upgrade-sectionTitle">Contact Information <span style="font-weight:700; color:#9aa4af; letter-spacing:0; text-transform:none; font-size:10px; margin-left:2px">- optional</span></label>
          <div class="v-upgrade-field">
            <label for="vmUpgradeResidentName">Name</label>
            <input id="vmUpgradeResidentName" type="text" value="${escapeHtml(prefill.residentName)}" placeholder="Contact name">
          </div>
          <div class="v-upgrade-field">
            <label for="vmUpgradeResidentEmail">Email</label>
            <input id="vmUpgradeResidentEmail" type="email" value="${escapeHtml(prefill.residentEmail)}" placeholder="email@example.com">
          </div>
          <div class="v-upgrade-field">
            <label for="vmUpgradeResidentPhone">Phone</label>
            <input id="vmUpgradeResidentPhone" type="tel" value="${escapeHtml(prefill.residentPhone)}" placeholder="(555) 123-4567">
          </div>
        </div>
        <div class="v-upgrade-actions">
          <div id="vmUpgradePrice" class="v-upgrade-price"></div>
          <div class="v-upgrade-btns">
            <button type="button" id="vmUpgradeCancel" class="v-upgrade-btn secondary">Cancel</button>
            <button type="submit" id="vmUpgradeSubmit" class="v-upgrade-btn primary"></button>
          </div>
        </div>
      </form>
    `;
    overlay.classList.add('active');
    renderUpgradeCcRows(prefill.ccEmails);
    updateUpgradePrice(project);
    const { scopeGroup, addCc, cancel, form, residentName } = upgradeEls();
    scopeGroup?.addEventListener('click', (event) => {
      const btn = event.target.closest('.v-upgrade-scopeBtn');
      if (!btn || !scopeGroup.contains(btn)) return;
      scopeGroup.querySelectorAll('.v-upgrade-scopeBtn').forEach((item) => item.classList.toggle('active', item === btn));
      updateUpgradePrice(project);
    });
    addCc?.addEventListener('click', () => {
      const { ccList } = upgradeEls();
      if (!ccList) return;
      ccList.insertAdjacentHTML('beforeend', buildUpgradeCcRow(''));
      const newRow = ccList.lastElementChild;
      newRow?.querySelector('.v-upgrade-ccRemove')?.addEventListener('click', () => {
        if (!newRow || !ccList.contains(newRow)) return;
        newRow.remove();
      });
      newRow?.querySelector('.v-upgrade-ccInput')?.focus();
    });
    cancel?.addEventListener('click', () => hideFullReportUpgradeDialog());
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const options = {
        includeGutters: upgradeDialogIncludesGutters(),
        resident: {
          name: String(upgradeEls().residentName?.value || '').trim(),
          email: String(upgradeEls().residentEmail?.value || '').trim(),
          phone: String(upgradeEls().residentPhone?.value || '').trim()
        },
        ccEmails: collectUpgradeCcEmails(),
        techNotes: String(upgradeEls().techNotes?.value || '').trim()
      };
      setUpgradeSubmitState(true, project);
      try {
        await submitFullReportUpgrade(project, options);
        hideFullReportUpgradeDialog();
        openModal(project);
      } catch (error) {
        setUpgradeSubmitState(false, project);
        window.Portal?.ui?.showToast?.('Order issue', error?.message || 'Unable to order the standard report.', false);
      }
    });
    residentName?.focus();
    residentName?.select?.();
  }
  function upgradeDialogIncludesGutters(){
    const activeScope = upgradeEls().scopeGroup?.querySelector('.v-upgrade-scopeBtn.active');
    return activeScope?.dataset.scope === 'roof_and_gutters';
  }
  function updateUpgradePrice(project){
    const { price, submit } = upgradeEls();
    const quote = fullReportQuoteWithGutters(project, upgradeDialogIncludesGutters());
    const total = fmtMoney(quote.final_amount);
    if (price) {
      price.innerHTML = quote.active
        ? `Total <strong>$${total}</strong><div class="v-upgrade-discount"><s>$${fmtMoney(quote.original_amount)}</s>${quote.discount_percent}% referral discount</div>`
        : `Total <strong>$${total}</strong>`;
    }
    if (submit && !submit.disabled) {
      submit.innerHTML = `<i class="fas fa-file-lines"></i> Submit Order - $${total}`;
    }
  }
  function setUpgradeSubmitState(isSubmitting, project){
    const { submit, cancel } = upgradeEls();
    if (submit) {
      submit.disabled = !!isSubmitting;
      submit.innerHTML = isSubmitting
        ? '<i class="fas fa-circle-notch fa-spin"></i> Submitting Order'
        : `<i class="fas fa-file-lines"></i> Submit Order - $${fmtMoney(fullReportPriceWithGutters(project, upgradeDialogIncludesGutters()))}`;
    }
    if (cancel) cancel.disabled = !!isSubmitting;
  }
  function buildArtifactUrl(projectId, fileName){
    if (!projectId || !fileName || !fmUrl) return '';
    return fmUrl(`projects/${encodeURIComponent(String(projectId))}/artifacts/${fileName}`);
  }
  function buildThumbnailUrl(projectId, fileName, width = 320){
    if (!projectId || !fileName || !fmUrl) return '';
    const w = Math.max(80, Math.min(960, parseInt(width, 10) || 320));
    return fmUrl(`projects/${encodeURIComponent(String(projectId))}/thumbnail?w=${w}&source=${encodeURIComponent(String(fileName))}`);
  }
  function isQuadThumbnailUrl(url){
    return /(?:^|\/)quad(?:_crop)?(?:\.[a-z0-9]+)?(?:$|\?)/i.test(String(url || ''));
  }
  function dedupeUrls(urls){
    const out = [];
    const seen = new Set();
    for (const raw of urls){
      const value = String(raw || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }
  function finiteCoord(value){
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function projectThumbnailPoint(p = {}){
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    for (const candidate of [p, raw, measurement]){
      const lat = finiteCoord(candidate?.lat ?? candidate?.latitude);
      const lng = finiteCoord(candidate?.lng ?? candidate?.longitude);
      if (lat != null && lng != null) return { lat, lng };
    }
    for (const pins of [p.pins, raw.pins, measurement.pins]){
      if (!Array.isArray(pins)) continue;
      for (const pin of pins){
        const lat = finiteCoord(pin?.lat ?? pin?.latitude);
        const lng = finiteCoord(pin?.lng ?? pin?.longitude);
        if (lat != null && lng != null) return { lat, lng };
      }
    }
    return null;
  }
  function googleStaticMapThumbnailUrl(p = {}){
    const key = String(googleMapsApiKey?.() || '').trim();
    if (!key) return '';
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const point = projectThumbnailPoint(p);
    const address = firstNonEmptyString(p.address, p.project_address, raw.address, raw.project_address, measurement.address);
    if (!point && !address) return '';
    const center = point ? `${point.lat},${point.lng}` : address;
    const params = new URLSearchParams({
      center,
      zoom: '20',
      size: '640x400',
      scale: '2',
      maptype: 'satellite',
      key
    });
    params.append('style', 'feature:all|element:labels|visibility:off');
    params.append('style', 'feature:poi|visibility:off');
    params.append('style', 'feature:transit|visibility:off');
    return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
  }
  function preferredThumbnailUrls(p, fileNames){
    const fileSet = fileNames instanceof Set ? fileNames : null;
    const projectId = firstMeasureProjectId(p);
    const urls = [];
    const artifacts = (p?.artifacts && typeof p.artifacts === 'object') ? p.artifacts : {};
    const assets = (p?.assets && typeof p.assets === 'object') ? p.assets : {};
    const addThumbnail = (fileName) => {
      if (!fileName) return;
      if (/^https?:\/\//i.test(String(fileName))) return;
      if (fileSet && !fileSet.has(fileName)) return;
      const url = buildThumbnailUrl(projectId, fileName, 320);
      if (url) urls.push(url);
    };
    const addArtifact = (fileName) => {
      if (fileSet && !fileSet.has(fileName)) return;
      const url = buildArtifactUrl(projectId, fileName);
      if (url) urls.push(url);
    };
    const thumbnailSource = String(p?.thumbnail_source || p?.thumbnail_artifact_name || '').trim();
    const thumbnailPhoto = (p?.thumbnail_photo && typeof p.thumbnail_photo === 'object') ? p.thumbnail_photo : {};
    [thumbnailPhoto.thumb, thumbnailPhoto.thumbnail, thumbnailPhoto.src, thumbnailPhoto.url].forEach((url) => {
      if (url && !isQuadThumbnailUrl(url)) urls.push(url);
    });
    const incomingThumb = String(p?.thumbnail || '').trim();
    const incomingIsApiThumbnail = /\/thumbnail(?:\?|$)/i.test(incomingThumb);
    if (incomingThumb && incomingIsApiThumbnail && !isQuadThumbnailUrl(incomingThumb)) urls.push(incomingThumb);
    const firstMeasureSources = [
      'solar.png',
      'solar.jpg',
      'solar.jpeg',
      'rgb.png',
      'rgb.jpg',
      'rgb.jpeg',
      'topdown.png',
      'topdown.jpg',
      'topdown.jpeg',
      'top_down.png',
      'top-down.png',
      'overview.png',
      'azure.png',
      'apple.png'
    ];
    const googleSources = [
      'google.png',
      'google.jpg',
      'google.jpeg'
    ];
    const preferredSources = firstMeasureSources.concat(googleSources);
    const specificSources = [];
    const addSource = (fileName) => {
      const value = String(fileName || '').trim();
      if (!value || isQuadThumbnailUrl(value) || /^https?:\/\//i.test(value) || specificSources.includes(value)) return;
      specificSources.push(value);
    };
    addSource(thumbnailSource);
    if (artifacts.has_azure_image || assets.azure) addSource('azure.png');
    if (artifacts.has_apple_image || assets.apple) addSource('apple.png');
    if (fileSet) {
      preferredSources.forEach(addSource);
    } else if (projectId) {
      firstMeasureSources.forEach(addSource);
    }
    if (artifacts.has_google_image || assets.google) addSource('google.png');
    if (!specificSources.length) addSource('google.png');

    specificSources.forEach(addThumbnail);
    if (incomingThumb && !incomingIsApiThumbnail && !isQuadThumbnailUrl(incomingThumb)) urls.push(incomingThumb);
    (fileSet ? preferredSources : specificSources).forEach(addArtifact);
    const googleFallback = googleStaticMapThumbnailUrl(p);
    if (googleFallback) urls.push(googleFallback);
    return dedupeUrls(urls);
  }
  function normalizeProjectRecord(p){
    if (!p || typeof p !== 'object') return p;
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (p.manifest && typeof p.manifest === 'object' && !Array.isArray(p.manifest))
      ? p.manifest
      : ((raw.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest)) ? raw.manifest : {});
    const resident = resolveResidentFields(p);
    const thumbnailCandidates = preferredThumbnailUrls(p);
    const releaseHeld = projectReleaseHoldIsActive(p, manifest, measurement, raw);
    const reportComplete = !releaseHeld && isFirstMeasureCompleteStatus(p.status, manifest.status, measurement.status, raw.status);
    const reportUrl = releaseHeld ? '' : (p.report_url || p.pdf_url || manifest.report_url || manifest.pdf_url || measurement.report_url || measurement.pdf_url || raw.report_url || raw.pdf_url || '');
    const summaryUrl = p.summary_url || manifest.summary_url || measurement.summary_url || raw.summary_url || '';
    const hasReport = !releaseHeld && !!(p.has_report || manifest.has_report || measurement.has_report || raw.has_report || reportUrl || reportComplete);
    const projectTitle = firstNonEmptyString(
      p.title,
      p.project_title,
      p.project_name,
      p.projectName,
      p.name,
      manifest.title,
      manifest.project_title,
      manifest.project_name,
      manifest.name
    );
    return {
      ...manifest,
      ...p,
      id: p.id || manifest.id || null,
      title: projectTitle || p.title || manifest.title || '',
      project_title: firstNonEmptyString(p.project_title, manifest.project_title, projectTitle),
      address: p.address || manifest.address || '',
      status: p.status || manifest.status || '',
      stage_id: firstNonEmptyString(p.stage_id, p.project_stage_id, p.stage, p.project_stage, manifest.stage_id, manifest.project_stage_id, manifest.stage, manifest.project_stage),
      project_stage_id: firstNonEmptyString(p.project_stage_id, p.stage_id, p.stage, p.project_stage, manifest.project_stage_id, manifest.stage_id, manifest.stage, manifest.project_stage),
      project_stage: firstNonEmptyString(p.project_stage, p.stage_label, manifest.project_stage, manifest.stage_label),
      project_type: p.project_type || manifest.project_type || 'residential',
      lat: p.lat ?? manifest.lat ?? null,
      lng: p.lng ?? manifest.lng ?? null,
      instant_enabled: p.instant_enabled ?? manifest.instant_enabled ?? false,
      instant_only: p.instant_only ?? manifest.instant_only ?? false,
      pins: Array.isArray(p.pins) ? p.pins : (Array.isArray(manifest.pins) ? manifest.pins : []),
      cc_emails: Array.isArray(p.cc_emails) ? p.cc_emails : (Array.isArray(manifest.cc_emails) ? manifest.cc_emails : []),
      tech_notes: p.tech_notes ?? manifest.tech_notes ?? '',
      artifacts: (p.artifacts && typeof p.artifacts === 'object') ? p.artifacts : ((manifest.artifacts && typeof manifest.artifacts === 'object') ? manifest.artifacts : {}),
      resident: resident.name,
      resident_email: resident.email,
      resident_phone: resident.phone,
      has_report: !!hasReport,
      report_url: reportUrl || null,
      pdf_url: reportUrl || null,
      summary_url: summaryUrl || null,
      thumbnail_candidates: thumbnailCandidates,
      thumbnail: thumbnailCandidates[0] || null,
      include_gutter_measurements: projectIncludesGutters(p) || projectIncludesGutters(manifest)
    };
  }
  function needsDisplayHydration(p){
    if (!p || p._detailHydrated || !p.id) return false;
    const resident = resolveResidentFields(p);
    return !resident.name;
  }
  function scheduleHydratedDisplayRefresh(){
    if (hydrateRefreshTimer) return;
    hydrateRefreshTimer = setTimeout(() => {
      hydrateRefreshTimer = null;
      applyQueryFilterSort();
      renderPagination();
    }, 80);
  }
  function gutterThumbBadgeHtml(p){
    if (!projectIncludesGutters(p)) return '';
    return `<div class="v-addon-badge" data-role="gutter-badge"><i class="fas fa-water"></i> Gutters</div>`;
  }
  function gutterMetaTagHtml(p){
    if (!projectIncludesGutters(p)) return '';
    return `<div class="v-meta-tags" data-role="gutter-meta"><span class="v-meta-tag v-meta-tag-addon"><i class="fas fa-water"></i> Roof + Gutters</span></div>`;
  }
  function projectReportMode(p){
    const explicitMode = String(p?.report_mode || '').trim().toLowerCase();
    if (explicitMode === 'instant' || explicitMode === 'both' || explicitMode === 'full') return explicitMode;
    if (p?.instant_only) return 'instant';
    if (p?.instant_enabled) return 'both';
    if (hasInstantProjectMarker(p)) return 'instant';
    return 'full';
  }
  function hasInstantProjectMarker(p){
    return !!(
      p?.instant_status
      || p?.instant_url
      || p?.instant_pdf_url
      || p?.instant_pdf
      || p?.instant?.status
      || p?.instant?.assets?.instant_pdf_url
      || p?.assets?.instant_pdf_url
    );
  }
  function instantDeliveryBadgeHtml(p){
    const mode = projectReportMode(p);
    if (mode === 'instant') return `<div class="v-delivery-badge instant-only" data-role="delivery-badge"><i class="fas fa-bolt"></i> Instant</div>`;
    if (mode === 'both') return `<div class="v-delivery-badge instant-both" data-role="delivery-badge"><i class="fas fa-layer-group"></i> Instant + Full</div>`;
    return '';
  }
  function instantMetaTagHtml(p){
    const mode = projectReportMode(p);
    if (mode === 'instant') return `<span class="v-meta-tag v-meta-tag-instant" data-role="instant-meta"><i class="fas fa-bolt"></i> Instant</span>`;
    if (mode === 'both') return `<span class="v-meta-tag v-meta-tag-instant" data-role="instant-meta"><i class="fas fa-layer-group"></i> Instant + Full</span>`;
    return '';
  }
  function fullReportOriginalBasePrice(p){
    const type = String(p?.project_type || 'residential').trim().toLowerCase();
    const pinCount = Math.max(1, Array.isArray(p?.pins) && p.pins.length ? p.pins.length : 1);
    if (type === 'commercial' || type === 'multifamily') return 12 * pinCount;
    return 7;
  }
  function fullReportQuoteWithGutters(p, includeGutters){
    const originalBase = fullReportOriginalBasePrice(p);
    const originalTotal = originalBase + (includeGutters && canOfferGutterUpgrade(p) ? 3 : 0);
    return window.Portal?.pricing?.referralDiscountPreview?.(originalTotal, originalBase) || {
      active: false,
      original_amount: originalTotal,
      final_amount: originalTotal,
      discount_amount: 0,
      discountable_amount: originalBase,
      discount_percent: 0,
    };
  }
  function fullReportPriceHtml(p, includeGutters){
    const quote = fullReportQuoteWithGutters(p, includeGutters);
    if (!quote.active) return `$${fmtMoney(quote.final_amount)}`;
    return `<s>$${fmtMoney(quote.original_amount)}</s>$${fmtMoney(quote.final_amount)}`;
  }
  function fullReportBasePrice(p){
    return fullReportQuoteWithGutters(p, false).final_amount;
  }
  function fullReportPriceWithGutters(p, includeGutters){
    return fullReportQuoteWithGutters(p, includeGutters).final_amount;
  }
  function firstMeasureFlagEnabled(flag, fallback = false){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.('firstmeasure', flag)) return true;
      const value = appFlags.value?.('firstmeasure', flag, undefined);
      return value === undefined ? fallback : value !== false;
    }
    return fallback;
  }
  function canOfferGutterUpgrade(p){
    return firstMeasureFlagEnabled('gutter_reports', false)
      && String(p?.project_type || 'residential').trim().toLowerCase() === 'residential';
  }
  function projectScopeLabel(p){
    const delivery = projectReportMode(p);
    const scope = projectIncludesGutters(p) ? 'Roof + Gutters' : 'Roof Only';
    if (delivery === 'instant') return 'Instant';
    if (delivery === 'both') return `Both - ${scope}`;
    return `Standard - ${scope}`;
  }
  function projectSupportsInstant(p){
    const mode = projectReportMode(p);
    const instantStatus = String(p?.instant_status || '').trim().toLowerCase();
    if (instantStatus === 'rejected' || instantStatus === 'rejected_no_coverage') return false;
    return mode === 'instant' || mode === 'both';
  }
  function getTypeMeta(p){
    const t = String(p.project_type || 'residential').toLowerCase();
    return PROJECT_TYPE_META[t] || PROJECT_TYPE_META.residential;
  }

  function hasCustomerVisibleReport(p){
    if (projectReleaseHoldIsActive(p, p?.manifest, p?.measurement_project, p?.measurement)) return false;
    return !!(
      p?.has_report
      || p?.report_url
      || p?.pdf_url
      || p?.manifest?.has_report
      || p?.manifest?.report_url
      || p?.manifest?.pdf_url
      || isFirstMeasureCompleteStatus(p?.status, p?.manifest?.status, p?.measurement_project?.status, p?.measurement?.status)
    );
  }

  function hasCompletedInstantReport(p){
    if (!projectSupportsInstant(p)) return false;
    const st = String(p?.status || '').trim().toLowerCase();
    const mode = projectReportMode(p);
    const instantStatus = String(p?.instant_status || p?.instant?.status || '').trim().toLowerCase();
    const instantPdfStatus = String(p?.instant_pdf?.status || p?.instant_pdf_status || '').trim().toLowerCase();
    const hasInstantPdf = !!(
      p?.instant_url
      || p?.instant_pdf_url
      || p?.assets?.instant_pdf_url
      || p?.instant?.assets?.instant_pdf_url
    );
    return (
      st === 'completed'
      || instantStatus === 'completed'
      || instantStatus === 'ready'
      || mode === 'instant'
      || (hasInstantPdf && instantPdfStatus !== 'failed')
    );
  }

  function hasMeasurementOrder(p){
    if (p?._optimistic && ['queued', 'submitted', 'processing', 'in_progress'].includes(String(p.status || '').trim().toLowerCase())) return true;
    return !!(
      firstMeasureProjectId(p)
      || p?.has_report
      || p?.report_url
      || p?.pdf_url
      || p?.instant_url
      || p?.instant_pdf_url
      || p?.assets?.instant_pdf_url
      || p?.instant?.assets?.instant_pdf_url
    );
  }
  function hasProjectProposals(p){
    if (Array.isArray(p?.proposals) && p.proposals.length) return true;
    if (Array.isArray(p?.proposal_ids) && p.proposal_ids.length) return true;
    if (String(p?.proposal_id || p?.active_proposal_id || '').trim()) return true;
    return String(p?.workflow_state || '').trim().toLowerCase() === 'proposal_only';
  }
  function isSalesAppointmentEvent(event){
    if (!event || typeof event !== 'object') return false;
    return [
      event.event_type_default_id,
      event.event_type_id,
      event.eventTypeId,
      event.type,
      event.kind,
      event.id
    ].some((value) => {
      const text = String(value || '').trim().toLowerCase();
      return text === 'sales_appointment' || text.includes('sales_appointment');
    });
  }
  function hasScheduledAppointment(p){
    const events = Array.isArray(p?.events) ? p.events : [];
    return events.some((event) => {
      if (!isSalesAppointmentEvent(event)) return false;
      const status = String(event.status || event.state || '').trim().toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'deleted';
    });
  }
  function isDraftProject(p){
    const status = String(p?.status || p?.measurement_project?.status || p?.measurement?.status || p?.workflow_state || '').trim().toLowerCase();
    if (hasMeasurementOrder(p) && ['queued', 'processing', 'in_progress', 'awaiting_review', 'awaiting_manager_review', 'pending_rejection'].includes(status)) return false;
    return !hasMeasurementOrder(p) && !hasProjectProposals(p) && !hasScheduledAppointment(p);
  }

  function projectStatusGroup(p){
    const st = String(p.status || '').toLowerCase();
    if (st === 'rejected_no_coverage' || st === 'rejected') return 'rejected';
    if (st === 'cancelled') return 'cancelled';
    if (projectReleaseHoldIsActive(p, p?.manifest, p?.measurement_project, p?.measurement)) return 'processing';
    if (hasCompletedInstantReport(p)) return 'ready';
    if (hasCustomerVisibleReport(p)) return 'ready';
    if (isDraftProject(p)) return 'draft';
    if (!hasMeasurementOrder(p)) return 'project';
    const measurementStatus = String(p?.measurement_project?.status || p?.measurement?.status || st || '').trim().toLowerCase();
    if (['submitted', 'queued', 'ready', 'measurement_ordered'].includes(measurementStatus)) return 'processing';
    return 'processing';
  }
  function statusLabel(p){
    if (activeCustomerReworkMeta(p).active && hasCustomerVisibleReport(p)) return 'Changes Pending';
    const g = projectStatusGroup(p);
    if (g === 'rejected') return 'Rejected';
    if (g === 'cancelled') return 'Cancelled';
    if (g === 'ready') return 'Ready';
    if (g === 'queued') return 'Processing';
    if (g === 'draft') return 'Draft';
    if (g === 'project') return 'Project';
    return 'Processing';
  }
  function projectIsExpedited(p){
    const measurement = (p?.measurement_project && typeof p.measurement_project === 'object') ? p.measurement_project : ((p?.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const key = String(p?.report_expedite_option || measurement?.report_expedite_option || '').trim().toLowerCase();
    return !!(p?.is_expedited || measurement?.is_expedited || ['rush_1_3','rush_under_1','rush_2_3','rush_1_2','rush_1_1_5'].includes(key));
  }
  function statusBadgeClasses(p){
    if (activeCustomerReworkMeta(p).active && hasCustomerVisibleReport(p)) return { cls:'b-pending', txt:'Changes Pending', pill:'sp-pending' };
    const g = projectStatusGroup(p);
    if (g === 'rejected') return { cls:'b-rej', txt:'Rejected', pill:'sp-rej' };
    if (g === 'cancelled') return { cls:'b-cancel', txt:'Cancelled', pill:'sp-cancel' };
    if (g === 'ready') return { cls:'b-ready', txt:'Ready', pill:'sp-ready' };
    if (g === 'queued') return { cls:'b-pending', txt:'Processing', pill:'sp-pending' };
    if (g === 'draft') return { cls:'b-draft', txt:'Draft', pill:'sp-draft' };
    if (g === 'project') return null;
    return { cls:'b-pending', txt: 'Processing', pill:'sp-pending', html: projectIsExpedited(p) };
  }
  function statusBadgeContent(s, upper = false){
    if (!s) return '';
    const text = upper ? String(s.txt || '').toUpperCase() : String(s.txt || '');
    return s.html ? `<i class="fas fa-bolt"></i> ${escapeHtml(text)}` : escapeHtml(text);
  }
  function normalizeStageKey(value){
    const key = String(value || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return Object.prototype.hasOwnProperty.call(LEGACY_PROJECT_STAGE_MAP, key) ? LEGACY_PROJECT_STAGE_MAP[key] : key;
  }
  function humanizeStageKey(value){
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }
  function explicitProjectStageId(p){
    const stageObj = (p?.stage && typeof p.stage === 'object' && !Array.isArray(p.stage)) ? p.stage : {};
    const raw = firstNonEmptyString(
      p?.stage_id,
      p?.project_stage_id,
      p?.mapped_stage?.id,
      stageObj?.id,
      stageObj?.default_id,
      stageObj?.key,
      p?.stage,
      p?.project_stage,
      p?.stage_label,
      p?.mapped_stage?.label,
      p?.workflow_stage
    );
    return normalizeStageKey(raw);
  }
  function proposalStageId(p){
    const proposalList = Array.isArray(p?.proposals) ? p.proposals : [];
    const statuses = proposalList.flatMap((proposal) => [
      proposal?.status,
      proposal?.state,
      proposal?.delivery?.status,
      proposal?.delivery_status,
      proposal?.signature_status
    ]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (statuses.some((status) => ['signed', 'accepted', 'approved'].includes(status)) || p?.sold_at || p?.closed_at || p?.sale_date) return 'newly_sold';
    if (statuses.some((status) => ['sent', 'viewed'].includes(status)) || proposalList.some((proposal) => proposal?.sent_at || proposal?.delivery?.sent_at)) return 'proposal_sent';
    if (proposalList.length || Array.isArray(p?.proposal_ids) && p.proposal_ids.length || String(p?.proposal_id || p?.active_proposal_id || '').trim()) return 'drafting_proposal';
    const workflow = normalizeStageKey(p?.workflow_state);
    return workflow === 'drafting_proposal' || workflow === 'proposal_sent' ? workflow : '';
  }
  function terminalProjectStageId(p){
    const values = [
      p?.status,
      p?.workflow_state,
      p?.stage_id,
      p?.stage,
      p?.stage?.id,
      p?.stage?.key,
      p?.stage?.label,
      p?.measurement_project?.status,
      p?.measurement?.status
    ].map(normalizeStageKey).filter(Boolean);
    if (values.includes('cancelled')) return 'cancelled';
    if (values.includes('lost')) return 'lost';
    return '';
  }
  function highestProjectStageId(ids){
    return ids.filter(Boolean).reduce((best, id) => {
      if (!best) return id;
      const bestRank = PROJECT_STAGE_RANK.has(best) ? PROJECT_STAGE_RANK.get(best) : (OPTIONAL_PROJECT_STAGE_RANK.get(best) ?? -1);
      const nextRank = PROJECT_STAGE_RANK.has(id) ? PROJECT_STAGE_RANK.get(id) : (OPTIONAL_PROJECT_STAGE_RANK.get(id) ?? -1);
      return nextRank > bestRank ? id : best;
    }, '');
  }
  function projectStageId(p){
    const terminal = terminalProjectStageId(p);
    if (terminal) return terminal;
    const explicit = explicitProjectStageId(p);
    if (explicit && !PROJECT_STAGE_RANK.has(explicit) && !OPTIONAL_PROJECT_STAGE_RANK.has(explicit)) return explicit;
    const inferred = highestProjectStageId([
      hasScheduledAppointment(p) ? 'appointment_scheduled' : '',
      proposalStageId(p)
    ]);
    return highestProjectStageId([explicit, inferred]) || 'new_lead';
  }
  function projectStageLabel(stageId, p){
    const known = PROJECT_STAGE_BY_ID.get(stageId);
    if (known) return known.label;
    const stageObj = (p?.stage && typeof p.stage === 'object' && !Array.isArray(p.stage)) ? p.stage : {};
    return firstNonEmptyString(p?.stage_label, p?.project_stage, stageObj?.label, stageObj?.name) || humanizeStageKey(stageId) || 'Other';
  }
  function stageColumnsForProjects(projects){
    const columns = PROJECT_STAGE_COLUMNS.map((stage, index) => ({ ...stage, index, custom:false }));
    const seen = new Set(columns.map((stage) => stage.id));
    for (const p of projects){
      const id = projectStageId(p);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const optional = OPTIONAL_PROJECT_STAGE_COLUMNS[id];
      const column = optional
        ? { ...optional, label:projectStageLabel(id, p), index:columns.length, custom:true, optional:true }
        : { id, label:projectStageLabel(id, p), icon:'fa-tag', index:columns.length, custom:true };
      if (optional?.after) {
        const afterIndex = columns.findIndex((stage) => stage.id === optional.after);
        if (afterIndex >= 0) {
          columns.splice(afterIndex + 1, 0, column);
          continue;
        }
      }
      columns.push(column);
    }
    return columns;
  }
  function formatStageDate(value){
    try {
      const text = String(value ?? '').trim();
      if (!text) return '';
      const isoish = text.includes('T') ? text : text.replace(' ', 'T');
      const withZone = (isoish.includes('Z') || /[+-]\d\d:?\d\d$/.test(isoish)) ? isoish : `${isoish}Z`;
      const date = new Date(withZone);
      if (Number.isNaN(date.getTime())) return text;
      return date.toLocaleDateString();
    } catch(e) {
      return String(value ?? '');
    }
  }
  function createStageCard(p){
    p = normalizeProjectRecord(p);
    const id = String(p.id);
    const resident = resolveResidentFields(p);
    const name = resident.name || p.customer_name || p.primary_contact_name || p.title || displayAddressLine1(p) || 'Project';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'v-stage-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="v-stage-name">${escapeHtml(name)}</div>
      <div class="v-stage-addr">
        ${escapeHtml(displayAddressLine1(p))}
        <span class="l2">${escapeHtml(displayAddressLine2(p) || '\u00a0')}</span>
      </div>
      <div class="v-stage-card-foot"><span>${escapeHtml(formatStageDate(p.created_at))}</span><span>Open <i class="fas fa-chevron-right"></i></span></div>
    `;
    card.addEventListener('click', () => openModal(lastProjectsById.get(id) || p));
    return card;
  }
  function renderStagesShell(){
    return `
      <div class="v-stages-shell">
        <div class="v-stages-board" id="vStagesBoard"></div>
      </div>
    `;
  }
  function mountStageItems(list, items){
    if (!list) return;
    if (!items.length){
      list.innerHTML = `<div class="v-stage-empty"><i class="fas fa-layer-group"></i>No projects here</div>`;
      return;
    }
    let loaded = 0;
    const more = document.createElement('div');
    more.className = 'v-stage-load';
    const renderMore = () => {
      const next = Math.min(loaded + STAGE_COLUMN_PAGE_SIZE, items.length);
      for (let i = loaded; i < next; i++) list.insertBefore(createStageCard(items[i]), more);
      loaded = next;
      if (loaded >= items.length) {
        more.classList.add('done');
        more.textContent = '';
      } else {
        more.classList.remove('done');
        more.textContent = `${loaded} of ${items.length} loaded`;
      }
    };
    list.appendChild(more);
    renderMore();
    if (items.length > loaded) {
      list.addEventListener('scroll', () => {
        const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
        if (remaining <= STAGE_COLUMN_PREFETCH_PX) renderMore();
      }, { passive: true });
    }
  }
  function renderStagesView(){
    const results = $('#vResults', panelEl);
    if (!results) return;
    results.innerHTML = renderStagesShell();
    const board = $('#vStagesBoard', panelEl);
    if (!board) return;
    const columns = stageColumnsForProjects(filteredProjects);
    const buckets = new Map(columns.map((stage) => [stage.id, []]));
    for (const p of filteredProjects){
      const id = projectStageId(p);
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(p);
    }
    for (const column of columns){
      const items = buckets.get(column.id) || [];
      const col = document.createElement('section');
      col.className = 'v-stage-col';
      col.dataset.stage = column.id;
      col.innerHTML = `
        <div class="v-stage-head">
          <div class="v-stage-title-row">
            <div class="v-stage-title"><span class="v-stage-icon"><i class="fas ${column.icon}"></i></span><span>${escapeHtml(column.label)}</span></div>
            <span class="v-stage-count">${items.length}</span>
          </div>
        </div>
        <div class="v-stage-list"></div>
      `;
      const list = col.querySelector('.v-stage-list');
      mountStageItems(list, items);
      board.appendChild(col);
    }
  }
  function getActiveSort(){
    if (viewMode === 'list') return { key:listSortKey, dir:listSortDir };
    return { key:tileSortKey, dir:tileSortDir };
  }
  function setActiveSort(key, dirMaybe){
    if (viewMode === 'list'){
      if (listSortKey === key) listSortDir = dirMaybe || (listSortDir === 'asc' ? 'desc' : 'asc');
      else { listSortKey = key; listSortDir = dirMaybe || (key === 'created_at' ? 'desc' : 'asc'); }
    } else {
      if (tileSortKey === key) tileSortDir = dirMaybe || (tileSortDir === 'asc' ? 'desc' : 'asc');
      else { tileSortKey = key; tileSortDir = dirMaybe || (key === 'created_at' ? 'desc' : 'asc'); }
    }
    syncSortDropdown();
    applyQueryFilterSort();
  }
  function sortableValue(p, key){
    if (key === 'created_at'){ const v = p.created_at || ''; const t = Date.parse(v); return isNaN(t) ? String(v) : t; }
    if (key === 'address') return normalizeStr(p.address || displayAddressPlain(p));
    if (key === 'resident') return normalizeStr(resolveResidentFields(p).sortValue || '');
    if (key === 'status') return normalizeStr(statusLabel(p));
    return normalizeStr(p[key] || '');
  }
  function applyQueryFilterSort(){
    let arr = allProjects.slice();
    if (hideDrafts) arr = arr.filter((project) => !isDraftProject(project));
    const s = getActiveSort();
    arr.sort((a,b)=>{
      const va = sortableValue(a, s.key);
      const vb = sortableValue(b, s.key);
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return (s.dir === 'asc') ? cmp : -cmp;
    });
    filteredProjects = arr;
    renderResults();
    updateCount();
  }
  function visibleProjectPool(projects){
    const arr = Array.isArray(projects) ? projects.slice() : [];
    return hideDrafts ? arr.filter((project) => !isDraftProject(project)) : arr;
  }
  function sortedProjectIds(projects){
    const s = getActiveSort();
    return visibleProjectPool(projects).sort((a,b)=>{
      const va = sortableValue(a, s.key);
      const vb = sortableValue(b, s.key);
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return (s.dir === 'asc') ? cmp : -cmp;
    }).map(projectStableKey);
  }
  function sameProjectOrder(a, b){
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function mergeProjectForRefresh(existing, incoming){
    if (!existing) return incoming;
    const merged = { ...existing, ...incoming };
    if (
      merged._linkedFullProject
      && hasCustomerVisibleReport(incoming)
      && !hasCustomerVisibleReport(merged._linkedFullProject)
    ) {
      delete merged._linkedFullProject;
    }
    if (existing._detailHydrated) {
      merged._detailHydrated = true;
      const keepIfIncomingBlank = (key) => {
        if (incoming?.[key] == null || String(incoming[key]).trim() === '') merged[key] = existing[key];
      };
      ['resident', 'resident_email', 'resident_phone', 'issuer', 'issuer_email', 'summary_url', 'xml_url', 'report_url', 'pdf_url'].forEach(keepIfIncomingBlank);
      if ((!Array.isArray(incoming?.pins) || !incoming.pins.length) && Array.isArray(existing.pins)) merged.pins = existing.pins;
      if ((!Array.isArray(incoming?.cc_emails) || !incoming.cc_emails.length) && Array.isArray(existing.cc_emails)) merged.cc_emails = existing.cc_emails;
      if ((!Array.isArray(incoming?.thumbnail_candidates) || !incoming.thumbnail_candidates.length) && Array.isArray(existing.thumbnail_candidates)) {
        merged.thumbnail_candidates = existing.thumbnail_candidates;
        merged.thumbnail = existing.thumbnail || merged.thumbnail || null;
      }
    }
    return normalizeProjectRecord(merged);
  }
  function pruneOptimisticProjectUpdates(){
    const now = Date.now();
    for (const [id, entry] of _optimisticProjectUpdates.entries()) {
      if (!entry || Number(entry.expiresAt || 0) <= now) _optimisticProjectUpdates.delete(id);
    }
  }
  function rememberOptimisticProjectUpdate(project){
    const normalized = normalizeProjectRecord(project);
    if (!normalized?.id) return null;
    const measurement = normalized.measurement_project || normalized.measurement || {};
    if (!String(normalized.created_at || '').trim()) {
      normalized.created_at = String(measurement.submitted_at || normalized.updated_at || new Date().toISOString()).trim();
    }
    if (!String(normalized.submitted_at || '').trim()) {
      normalized.submitted_at = String(measurement.submitted_at || normalized.created_at || new Date().toISOString()).trim();
    }
    const id = String(normalized.id);
    _optimisticProjectUpdates.set(id, {
      project: normalized,
      expiresAt: Date.now() + OPTIMISTIC_PROJECT_UPDATE_TTL_MS
    });
    return normalized;
  }
  function applyOptimisticProjectUpdates(projects){
    pruneOptimisticProjectUpdates();
    if (!_optimisticProjectUpdates.size) return projects;
    const seen = new Set();
    const merged = (Array.isArray(projects) ? projects : []).map((project) => {
      const id = String(project?.id || '');
      const entry = id ? _optimisticProjectUpdates.get(id) : null;
      if (!entry) return project;
      seen.add(id);
      return mergeProjectForRefresh(project, entry.project);
    });
    for (const [id, entry] of _optimisticProjectUpdates.entries()) {
      if (!seen.has(id)) merged.unshift(entry.project);
    }
    return dedupeProjects(merged);
  }
  function updateCount(){
    const el = $('#vCount', panelEl);
    if (!el) return;
    if (viewMode === 'stages') {
      const count = totalCount || filteredProjects.length || allProjects.length;
      el.textContent = `${count} project${count===1?'':'s'}`;
      return;
    }
    if (totalCount > 0 && totalPages > 1){
      const start = (currentPage - 1) * PAGE_SIZE + 1;
      const end = Math.min(currentPage * PAGE_SIZE, totalCount);
      el.textContent = `${start}\u2013${end} of ${totalCount}`;
    } else {
      const a = allProjects.length;
      const f = filteredProjects.length;
      el.textContent = (a === f) ? `${a} project${a===1?'':'s'}` : `${f} of ${a}`;
    }
  }
  function renderPagination(){
    const el = $('#vPagination', panelEl);
    if (!el) return;
    if (viewMode === 'stages'){ el.innerHTML = ''; return; }
    if (totalPages <= 1){ el.innerHTML = ''; return; }
    const btns = [];
    btns.push(`<div class="v-pgbtn${currentPage <= 1 ? ' disabled':''}" data-pg="prev"><i class="fas fa-chevron-left"></i></div>`);
    const maxVisible = 7;
    let pages = [];
    if (totalPages <= maxVisible){ for (let i = 1; i <= totalPages; i++) pages.push(i); }
    else {
      pages.push(1);
      let start = Math.max(2, currentPage - 2);
      let end = Math.min(totalPages - 1, currentPage + 2);
      if (currentPage <= 3) end = Math.min(totalPages - 1, 5);
      if (currentPage >= totalPages - 2) start = Math.max(2, totalPages - 4);
      if (start > 2) pages.push('\u2026');
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push('\u2026');
      pages.push(totalPages);
    }
    for (const pg of pages){
      if (pg === '\u2026') btns.push(`<span class="v-pginfo">\u2026</span>`);
      else btns.push(`<div class="v-pgbtn${pg === currentPage ? ' active':''}" data-pg="${pg}">${pg}</div>`);
    }
    btns.push(`<div class="v-pgbtn${currentPage >= totalPages ? ' disabled':''}" data-pg="next"><i class="fas fa-chevron-right"></i></div>`);
    el.innerHTML = btns.join('');
    el.querySelectorAll('.v-pgbtn').forEach(btn => {
      btn.addEventListener('click', ()=>{
        const v = btn.getAttribute('data-pg');
        if (!v) return;
        let newPage = currentPage;
        if (v === 'prev') newPage = currentPage - 1;
        else if (v === 'next') newPage = currentPage + 1;
        else newPage = parseInt(v, 10);
        if (isNaN(newPage) || newPage < 1 || newPage > totalPages || newPage === currentPage) return;
        currentPage = newPage;
        fetchProjects(true);
      });
    });
  }
  function buildSuggestions(max=8){
    const q = normalizeStr(searchQuery);
    if (!q) return [];
    const hits = [];
    for (const p of allProjects){
      const addr = normalizeStr(p.address || displayAddressPlain(p));
      const contact = resolveResidentFields(p);
      const contactText = normalizeStr(contact.searchText || contact.displayName || contact.name || '');
      if (!addr.includes(q) && !contactText.includes(q)) continue;
      hits.push({ id: String(p.id), a1: displayAddressLine1(p), a2: displayAddressLine2(p), contact: contact.displayName || contact.name || '', status: statusLabel(p), group: projectStatusGroup(p), created_at: p.created_at });
      if (hits.length >= max) break;
    }
    return hits;
  }
  function showSuggest(){
    const box = $('#vSuggest', panelEl);
    if (!box) return;
    const items = buildSuggestions(8);
    if (!items.length){ box.style.display = 'none'; activeSuggest = false; return; }
    box.innerHTML = items.map(it=>{
      const cls = it.group === 'ready' ? 'sp-ready' : it.group === 'rejected' ? 'sp-rej' : it.group === 'cancelled' ? 'sp-cancel' : it.group === 'draft' ? 'sp-draft' : 'sp-pending';
      const tag = it.group === 'project' ? '' : `<span class="tag ${cls}" style="border-radius:999px;">${escapeHtml(it.status)}</span>`;
      const subtitle = [it.a2, it.contact ? `Contact: ${it.contact}` : ''].filter(Boolean).join(' | ');
      return `<div class="it" data-id="${escapeHtml(it.id)}"><div style="min-width:0;"><div class="a1">${escapeHtml(it.a1 || '')}</div><div class="a2">${escapeHtml(subtitle)}</div></div><div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">${tag}<div class="meta">${escapeHtml(formatDate(it.created_at))}</div></div></div>`;
    }).join('');
    box.style.display = 'block';
    activeSuggest = true;
    box.querySelectorAll('.it').forEach(row=>{
      row.addEventListener('mousedown', (e)=>{
        e.preventDefault();
        const id = row.getAttribute('data-id');
        const p = lastProjectsById.get(String(id));
        if (p){ const addr = p.address || displayAddressPlain(p); setSearch(addr, true); if (normalizeStr(addr) === normalizeStr(searchQuery)) openModal(p); }
        hideSuggest();
      });
    });
  }
  function hideSuggest(){ const box = $('#vSuggest', panelEl); if (box) box.style.display = 'none'; activeSuggest = false; }
  function scheduleSearchFetch(immediate){
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(()=>{
      currentPage = 1;
      fetchProjects(true);
    }, immediate ? 0 : SEARCH_DEBOUNCE_MS);
  }
  function setSearch(val, suppressSuggest){
    const nextQuery = String(val||'');
    const prevQuery = searchQuery;
    searchQuery = nextQuery;
    const input = $('#vSearch', panelEl);
    if (input && input.value !== searchQuery) input.value = searchQuery;
    const clear = $('#vClear', panelEl);
    if (clear) clear.style.display = searchQuery ? 'flex' : 'none';
    hideSuggest();
    if (normalizeStr(prevQuery) !== normalizeStr(nextQuery)) scheduleSearchFetch(!!suppressSuggest);
  }
  function updateOpenModalFromLatest(projects){
    if (!modalOpen || !panelEl || !currentModalId) return;
    const p = lastProjectsById.get(String(currentModalId));
    if (!p) return;
    const g = projectStatusGroup(p);
    if (g !== currentModalGroup){ openModal(p); return; }
    const statusEl = $('#vmStatus', panelEl);
      if (statusEl){
        if (g === 'ready'){ statusEl.textContent = 'READY'; statusEl.style.color = '#34a853'; }
        else if (g === 'queued'){ statusEl.textContent = 'PROCESSING'; statusEl.style.color = '#fbbc04'; }
        else if (g === 'rejected'){ statusEl.textContent = 'REJECTED'; statusEl.style.color = '#d93025'; }
        else if (g === 'cancelled'){ statusEl.textContent = 'CANCELLED'; statusEl.style.color = '#5f6368'; }
        else if (g === 'draft'){ statusEl.textContent = 'DRAFT'; statusEl.style.color = '#667085'; }
        else if (g === 'project'){ statusEl.textContent = ''; statusEl.style.color = '#5f6368'; }
        else { statusEl.textContent = 'PROCESSING'; statusEl.style.color = '#fbbc04'; }
      }
  }
  function loadPersistedView(){ try{ const v = localStorage.getItem(LS_VIEW_KEY); if (VIEW_MODES.has(v)) return normalizeViewMode(v); }catch(e){} return 'tiles'; }
  function persistView(mode){ try{ localStorage.setItem(LS_VIEW_KEY, mode); }catch(e){} }
  function enforceDraftsHidden(){
    hideDrafts = true;
    if (statusFilter === 'draft') {
      statusFilter = 'all';
      const statusSel = $('#vStatus', panelEl);
      if (statusSel) statusSel.value = 'all';
    }
  }
  function updateViewControls(){
    const bT = $('#vViewTiles', panelEl); const bL = $('#vViewList', panelEl); const bS = $('#vViewStages', panelEl);
    if (bT) bT.classList.toggle('active', viewMode === 'tiles');
    if (bL) bL.classList.toggle('active', viewMode === 'list');
    if (bS) {
      bS.hidden = !stagesViewEnabled();
      bS.classList.toggle('active', viewMode === 'stages');
    }
    const tip = $('#vTip', panelEl);
    if (tip) tip.style.display = (viewMode === 'list') ? 'block' : 'none';
  }
  function setView(mode){
    const previousMode = viewMode;
    viewMode = normalizeViewMode(mode);
    persistView(viewMode);
    updateViewControls();
    syncSortDropdown();
    if (previousMode !== viewMode && ((previousMode === 'stages') !== (viewMode === 'stages'))) {
      currentPage = 1;
      fetchProjects(true);
      return;
    }
    renderResults();
  }
  function applyStagesViewFlag(){
    const nextMode = normalizeViewMode(viewMode);
    if (nextMode !== viewMode) {
      setView(nextMode);
      return;
    }
    updateViewControls();
  }
  function syncSortDropdown(){ const sel = $('#vSort', panelEl); if (!sel) return; const s = getActiveSort(); sel.value = `${s.key}:${s.dir}`; }
  function injectSidebarLogout(){
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return;
    if (document.getElementById('sidebarLogoutLow')) return;
    injectCSS('viewer_logout_fix', `.sidebar-footer{ display:flex; flex-direction:column; align-items:center; gap:6px; } .sidebar-footer .sb-logout-low{ display:inline-flex; align-items:center; justify-content:center; gap:8px; font-weight:900; font-size:12px; color:#888; text-decoration:none; padding:6px 0 2px; cursor:pointer; user-select:none; } .sidebar-footer .sb-logout-low:hover{ color: var(--primary,#d93025); }`);
    const a = document.createElement('a');
    a.id = 'sidebarLogoutLow'; a.className = 'sb-logout-low'; a.href = 'logout.php';
    a.innerHTML = `<i class="fas fa-right-from-bracket"></i><span>Log out</span>`;
    footer.insertBefore(a, footer.firstChild);
  }
  function displayAddressLine1(p){
    if (p.components && p.components.city){
      const street = p.components.street_number ? `${p.components.street_number} ${p.components.route || ''}`.trim() : (p.components.route || '');
      return street || String(p.address || '').split(',')[0] || '\u2014';
    }
    return String(p.address || '\u2014').split(',')[0] || '\u2014';
  }
  function displayAddressLine2(p){
    if (p.components && p.components.city) return `${p.components.city || ''}, ${p.components.state_short || ''} ${p.components.zip || ''}`.trim();
    const parts = String(p.address || '').split(',');
    return (parts.length >= 3) ? `${(parts[1]||'').trim()}, ${(parts[2]||'').trim()}` : (parts[1]||'').trim();
  }
  function displayAddressPlain(p){ const l1 = displayAddressLine1(p); const l2 = displayAddressLine2(p); return (l2 ? `${l1}, ${l2}` : l1).trim(); }
  function displayAddress(p){
    const l1 = displayAddressLine1(p); const l2 = displayAddressLine2(p);
    if (l2) return `<div>${escapeHtml(l1)}</div><div class="l2">${escapeHtml(l2)}</div>`;
    return `<div>${escapeHtml(l1 || p.address || '\u2014')}</div>`;
  }
  function statusToFilterValue(p){ return projectStatusGroup(p); }
  function sortIcon(k){
    const s = getActiveSort();
    if (s.key !== k) return `<i class="fas fa-sort"></i>`;
    return s.dir === 'asc' ? `<i class="fas fa-sort-up"></i>` : `<i class="fas fa-sort-down"></i>`;
  }
  function renderListShell(){
    return `<div class="v-list"><div class="v-lhead" id="vListHead"><div class="v-lcell sortable" data-k="status">Status <span class="sicon">${sortIcon('status')}</span></div><div class="v-lcell sortable" data-k="address">Address <span class="sicon">${sortIcon('address')}</span></div><div class="v-lcell sortable" data-k="resident">Contact <span class="sicon">${sortIcon('resident')}</span></div><div class="v-lcell sortable" data-k="created_at">Submitted <span class="sicon">${sortIcon('created_at')}</span></div></div><div class="v-lscroll" id="vListScroll"></div></div>`;
  }
  function wireListHeaderSort(){
    const head = $('#vListHead', panelEl);
    if (!head) return;
    head.querySelectorAll('.sortable').forEach(el=>{
      el.addEventListener('click', ()=>{
        const k = el.getAttribute('data-k'); if (!k) return;
        const prevMode = viewMode; viewMode = 'list'; setActiveSort(k); viewMode = prevMode;
      });
    });
  }
  function createTile(p){
    p = normalizeProjectRecord(p);
    const id = String(p.id);
    const div = document.createElement('div'); div.className = 'v-tile'; div.dataset.id = id;
    const s = statusBadgeClasses(p);
    const isProcessing = projectStatusGroup(p) === 'processing';
    const thumbnailCandidates = Array.isArray(p.thumbnail_candidates) ? p.thumbnail_candidates : preferredThumbnailUrls(p);
    const shouldProbeThumbnail = isProcessing && !p._detailHydrated && thumbnailCandidates.length === 0;
    const hasThumbnail = thumbnailCandidates.length > 0 && !shouldProbeThumbnail;
    const placeholderThumb = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const thumbSrc = hasThumbnail ? thumbnailCandidates[0] : placeholderThumb;
    const tm = getTypeMeta(p);
    const deliveryBadge = instantDeliveryBadgeHtml(p);
    const typeBadge = (tm !== PROJECT_TYPE_META.residential) ? `<div class="v-type-badge ${tm.cls}${deliveryBadge ? '' : ' no-delivery'}"><i class="fas ${tm.icon}"></i> ${escapeHtml(tm.short)}</div>` : '';
    const statusBadge = s ? `<div class="v-badge ${s.cls}">${statusBadgeContent(s)}</div>` : '';
    const contact = resolveResidentFields(p);
    div.innerHTML = `<div class="v-thumb${(!hasThumbnail && isProcessing) ? ' loading' : ''}"><img src="${escapeHtml(thumbSrc)}" loading="lazy" alt="">${typeBadge}${deliveryBadge}${gutterThumbBadgeHtml(p)}${statusBadge}</div><div class="v-body"><div class="v-addr">${displayAddress(p)}</div><div class="v-meta"><i class="fas fa-user"></i> ${escapeHtml(contact.displayName || contact.name || 'N/A')}</div><div class="v-foot"><span>${escapeHtml(formatDate(p.created_at))}</span><span class="cta">View <i class="fas fa-chevron-right"></i></span></div></div>`;
    div.addEventListener('click', ()=>openModal(lastProjectsById.get(id) || p));

    const img = div.querySelector('.v-thumb img');
    const thumb = div.querySelector('.v-thumb');

    /* Thumbnail polling: check availability without downloading image bodies. */
    if (img && thumb) {
      let retryTimer = null;
      let activeCandidateIndex = 0;

      const startPolling = () => {
        if (!thumbnailCandidates.length) return;
        thumb.classList.add('loading');
        const tryOnce = async () => {
          for (let i = 0; i < thumbnailCandidates.length; i++) {
            const candidateUrl = thumbnailCandidates[i];
            if (await softFileExists(candidateUrl)) {
              activeCandidateIndex = i;
              thumb.classList.remove('loading');
              if (img.src !== candidateUrl) img.src = candidateUrl;
              img.style.display = '';
              p.thumbnail = candidateUrl;
              p.thumbnail_candidates = thumbnailCandidates;
              retryTimer = null;
              return;
            }
          }
          retryTimer = setTimeout(tryOnce, 60000);
        };
        retryTimer = setTimeout(tryOnce, shouldProbeThumbnail ? 60000 : 0);
      };

      if (shouldProbeThumbnail || (!hasThumbnail && isProcessing)) {
        /* No thumbnail URL at all — start polling right away */
        startPolling();
      } else if (hasThumbnail) {
        /* Has URL but image might 404 — poll on error */
        img.addEventListener('error', () => {
          activeCandidateIndex += 1;
          if (thumbnailCandidates[activeCandidateIndex]) {
            img.src = thumbnailCandidates[activeCandidateIndex];
            return;
          }
          startPolling();
        });
      }
    }

    return div;
  }
  function createListRow(p){
    p = normalizeProjectRecord(p);
    const resident = resolveResidentFields(p);
    const id = String(p.id);
    const row = document.createElement('div'); row.className = 'v-lrow'; row.dataset.id = id;
    const s = statusBadgeClasses(p);
    const a1 = displayAddressLine1(p); const a2 = displayAddressLine2(p);
    const expediteTag = projectIsExpedited(p) ? `<span class="v-meta-tag v-meta-tag-expedite"><i class="fas fa-bolt"></i> Expedited</span>` : '';
    const rowTags = `${instantMetaTagHtml(p)}${expediteTag}${projectIncludesGutters(p) ? `<span class="v-meta-tag v-meta-tag-addon" data-role="gutter-meta-row"><i class="fas fa-water"></i> Roof + Gutters</span>` : ''}`;
    const statusPill = s ? `<span class="v-statuspill ${s.pill}">${statusBadgeContent(s, true)}</span>` : '';
    row.innerHTML = `<div class="v-lcell">${statusPill}</div><div class="v-lcell" style="min-width:0;"><div class="v-laddr"><div class="v-laddr1">${escapeHtml(a1)}</div><div class="v-laddr2">${escapeHtml(a2)}</div>${rowTags ? `<div class="v-meta-tags">${rowTags}</div>` : ''}</div></div><div class="v-lcell" style="min-width:0;"><div style="font-weight:1000; font-size:13px; line-height:1.2;">${escapeHtml(resident.displayName || resident.name || '\u2014')}</div><div style="font-weight:850; font-size:11px; color:#777; margin-top:3px;">${escapeHtml((resident.displayDetail || '').toString())}</div></div><div class="v-lcell" data-col="created_at" style="color:#666; font-weight:1000;">${escapeHtml(formatDate(p.created_at))}</div>`;
    row.addEventListener('click', ()=>openModal(lastProjectsById.get(id) || p));
    return row;
  }
  function renderResults(){
    const results = $('#vResults', panelEl); if (!results) return;
    if (!allProjects.length){
      if (hideDrafts && totalUnfilteredCount > 0) {
        results.innerHTML = `<div style="text-align:center; color:#bbb; padding:44px 0;"><div style="font-weight:1000; font-size:14px;">No visible projects.</div><div style="margin-top:8px; color:#999; font-weight:850;">No non-draft projects match this view.</div></div>`;
        return;
      }
      results.innerHTML = `<div style="text-align:center; color:#bbb; padding:44px 0;"><div style="font-weight:1000; font-size:14px;">No projects yet.</div><div style="margin-top:8px; color:#999; font-weight:850;">Click "New Project" to get started.</div></div>`;
      return;
    }
    if (!filteredProjects.length){ results.innerHTML = `<div style="text-align:center; color:#bbb; padding:44px 0;"><div style="font-weight:1000; font-size:14px;">No matches.</div><div style="margin-top:8px; color:#999; font-weight:850;">Try clearing filters or searching a different term.</div></div>`; return; }
    if (viewMode === 'stages'){ renderStagesView(); return; }
    if (viewMode === 'list'){ results.innerHTML = renderListShell(); const scroll = $('#vListScroll', panelEl); for (const p of filteredProjects) scroll.appendChild(createListRow(p)); wireListHeaderSort(); return; }
    results.innerHTML = `<div class="v-grid" id="vGrid"></div>`;
    const grid = $('#vGrid', panelEl);
    for (const p of filteredProjects) grid.appendChild(createTile(p));
  }
  function upsertProjectForViewer(project, { redraw = true } = {}){
    if (!project) return null;
    const normalized = rememberOptimisticProjectUpdate(project);
    if (!normalized?.id) return null;
    const id = String(normalized.id);
    const existing = lastProjectsById.get(id) || allProjects.find(item => String(item?.id || '') === id) || null;
    const merged = mergeProjectForRefresh(existing, normalized);
    const existingIndex = allProjects.findIndex(item => String(item?.id || '') === id);
    if (existingIndex >= 0) allProjects[existingIndex] = merged;
    else allProjects.unshift(merged);
    allProjects = dedupeProjects(allProjects);
    lastProjectsById = indexProjectLookups(allProjects);
    if (redraw) {
      applyQueryFilterSort();
      renderPagination();
    } else {
      filteredProjects = filteredProjects.map(item => String(item?.id || '') === id ? merged : item);
      patchBadges([merged]);
      updateCount();
    }
    if (modalOpen && String(currentModalId || '') === id) updateOpenModalFromLatest([merged]);
    return merged;
  }
  function patchBadges(projects){
    if (!projects?.length || !panelEl) return;
    if (viewMode === 'stages') {
      renderResults();
      return;
    }
    for (const p of projects){
      const project = normalizeProjectRecord(p);
      const id = String(project.id); lastProjectsById.set(id, project);
      const tile = panelEl.querySelector(`.v-tile[data-id="${CSS.escape(id)}"]`);
      if (hideDrafts && isDraftProject(project)) {
        tile?.remove();
        panelEl.querySelector(`.v-lrow[data-id="${CSS.escape(id)}"]`)?.remove();
        continue;
      }
      if (tile){
        const badge = tile.querySelector('.v-badge');
        const s = statusBadgeClasses(project);
        if (badge && s){
          const want = `v-badge ${s.cls}`;
          const html = statusBadgeContent(s);
          if (badge.className !== want) badge.className = want;
          if (badge.innerHTML !== html) badge.innerHTML = html;
        } else if (badge && !s) {
          badge.remove();
        } else if (!badge && s) {
          tile.querySelector('.v-thumb')?.insertAdjacentHTML('beforeend', `<div class="v-badge ${s.cls}">${statusBadgeContent(s)}</div>`);
        }
        const thumb = tile.querySelector('.v-thumb');
        if (thumb){
          const addon = thumb.querySelector('[data-role="gutter-badge"]');
          if (projectIncludesGutters(project)){
            if (!addon) thumb.insertAdjacentHTML('beforeend', gutterThumbBadgeHtml(project));
          } else if (addon) addon.remove();
          const delivery = thumb.querySelector('[data-role="delivery-badge"]');
          const nextDelivery = instantDeliveryBadgeHtml(project);
          if (nextDelivery) {
            if (delivery) delivery.outerHTML = nextDelivery;
            else thumb.insertAdjacentHTML('beforeend', nextDelivery);
          } else if (delivery) {
            delivery.remove();
          }
        }
        const bodyMeta = tile.querySelector('.v-body [data-role="gutter-meta"]');
        if (bodyMeta) bodyMeta.remove();
        const tileResident = tile.querySelector('.v-body .v-meta');
        const tileContact = resolveResidentFields(project);
        if (tileResident) tileResident.innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(tileContact.displayName || tileContact.name || 'N/A')}`;
      }
      const row = panelEl.querySelector(`.v-lrow[data-id="${CSS.escape(id)}"]`);
      if (row){
        const resident = resolveResidentFields(project);
        const pill = row.querySelector('.v-statuspill');
        const s = statusBadgeClasses(project);
        if (pill && s){
          const want = `v-statuspill ${s.pill}`;
          const html = statusBadgeContent(s, true);
          if (pill.className !== want) pill.className = want;
          if (pill.innerHTML !== html) pill.innerHTML = html;
        } else if (pill && !s) {
          pill.remove();
        } else if (!pill && s) {
          row.querySelector('.v-lcell')?.insertAdjacentHTML('afterbegin', `<span class="v-statuspill ${s.pill}">${statusBadgeContent(s, true)}</span>`);
        }
        const d = row.querySelector('[data-col="created_at"]');
        if (d) d.textContent = formatDate(project.created_at);
        const residentCols = row.children[2]?.querySelectorAll('div');
        if (residentCols?.[0]) residentCols[0].textContent = resident.displayName || resident.name || '\u2014';
        if (residentCols?.[1]) residentCols[1].textContent = (resident.displayDetail || '').toString();
        const addr = row.querySelector('.v-laddr');
        if (addr){
          const tags = [];
          const instantMeta = instantMetaTagHtml(project);
          if (instantMeta) tags.push(instantMeta);
          if (projectIsExpedited(project)) tags.push(`<span class="v-meta-tag v-meta-tag-expedite"><i class="fas fa-bolt"></i> Expedited</span>`);
          if (projectIncludesGutters(project)) tags.push(`<span class="v-meta-tag v-meta-tag-addon" data-role="gutter-meta-row"><i class="fas fa-water"></i> Roof + Gutters</span>`);
          const existingTags = addr.querySelector('.v-meta-tags');
          if (existingTags) existingTags.outerHTML = tags.length ? `<div class="v-meta-tags">${tags.join('')}</div>` : '';
        }
      }
    }
  }
  function normalizeComponents(raw){
    if (!raw || typeof raw !== 'object') return {};
    if (typeof raw.city === 'string' || typeof raw.state_short === 'string') return raw;
    return {
      street_number: raw.street_number?.short || raw.street_number?.long || '',
      route: raw.route?.short || raw.route?.long || '',
      city: raw.locality?.long || raw.city?.long || raw.city || '',
      state: raw.administrative_area_level_1?.long || raw.state?.long || raw.state || '',
      state_short: raw.administrative_area_level_1?.short || raw.state?.short || raw.state_short || '',
      zip: raw.postal_code?.long || raw.zip || '',
      country: raw.country?.long || raw.country || ''
    };
  }
  async function hydrateProjectDetails(p){
    const measurementId = firstMeasureProjectId(p);
    if (!measurementId || p._detailHydrated || !fmJson) return p;
    try{
      const data = await fmJson(`projects/${encodeURIComponent(measurementId)}`);
      const project = data?.project || {};
      const manifest = project?.manifest || {};
      const files = Array.isArray(project?.files) ? project.files : [];
      const names = new Set(files.map(f => String(f?.name || '')));
      const releaseHeld = projectReleaseHoldIsActive(manifest, project, p);
      const isComplete = !releaseHeld && isFirstMeasureCompleteStatus(project.status, manifest.status, p.status);
      const hasReportPdf = !releaseHeld && (names.has('Report.pdf') || names.has('report.pdf'));
      const hasSummaryPdf = !releaseHeld && names.has('Summary.pdf');
      const merged = {
        ...p,
        ...manifest,
        components: normalizeComponents(manifest.components || p.components || {}),
        resident: firstNonEmptyString(
          typeof p?.resident === 'string' ? p.resident : '',
          p?.resident_name,
          manifest?.resident?.name
        ),
        resident_email: firstNonEmptyString(
          p?.resident_email,
          p?.residentEmail,
          manifest?.resident?.email
        ),
        resident_phone: firstNonEmptyString(
          p?.resident_phone,
          p?.residentPhone,
          manifest?.resident?.phone
        ),
        issuer: manifest?.issuer?.name || p.issuer || p.owner || '',
        issuer_email: manifest?.issuer?.email || p.issuer_email || p.owner_email || '',
        cc_emails: Array.isArray(manifest.cc_emails) ? manifest.cc_emails : (Array.isArray(p.cc_emails) ? p.cc_emails : []),
        pins: Array.isArray(manifest.pins) ? manifest.pins : (Array.isArray(p.pins) ? p.pins : []),
        include_gutter_measurements: projectIncludesGutters(manifest) || projectIncludesGutters(p),
        tech_notes: manifest.tech_notes ?? p.tech_notes ?? '',
        has_report: !releaseHeld && !!(p.has_report || manifest.has_report || hasReportPdf || isComplete),
        id: p.platform_project_id || (isPlatformProjectId(p.id) ? p.id : '') || p.id || measurementId,
        platform_project_id: p.platform_project_id || (isPlatformProjectId(p.id) ? p.id : ''),
        report_url: releaseHeld ? null : (p.report_url || p.pdf_url || manifest.report_url || manifest.pdf_url || (hasReportPdf ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/Report.pdf`) : null)),
        summary_url: releaseHeld ? null : (p.summary_url || manifest.summary_url || (hasSummaryPdf ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/Summary.pdf`) : null)),
        xml_url: p.xml_url || (names.has('model_data.xml') ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/model_data.xml`) : null),
        _detailHydrated: true
      };
      merged.thumbnail_candidates = preferredThumbnailUrls(merged, names);
      merged.thumbnail = merged.thumbnail_candidates[0] || null;
      const normalized = normalizeProjectRecord(merged);
      lastProjectsById.set(String(normalized.id), normalized);
      allProjects = allProjects.map(item => String(item.id) === String(normalized.id) ? normalized : item);
      filteredProjects = filteredProjects.map(item => String(item.id) === String(normalized.id) ? normalized : item);
      if (panelEl) patchBadges([normalized]);
      return normalized;
    }catch(e){
      return p;
    }
  }
  function hydrateProjectsForDisplay(projects){
    if (!Array.isArray(projects) || !projects.length || !fmJson) return;
    for (const project of projects){
      if (!needsDisplayHydration(project)) continue;
      const id = String(project.id);
      if (!id || detailHydrationInFlight.has(id) || detailHydrationQueued.has(id)) continue;
      detailHydrationQueued.add(id);
      detailHydrationQueue.push({ id, project });
    }
    pumpProjectDetailHydration();
  }
  function pumpProjectDetailHydration(){
    while (detailHydrationActive < DETAIL_HYDRATION_CONCURRENCY && detailHydrationQueue.length){
      const next = detailHydrationQueue.shift();
      if (!next) continue;
      const { id, project } = next;
      detailHydrationQueued.delete(id);
      if (!needsDisplayHydration(project) || detailHydrationInFlight.has(id)) continue;
      detailHydrationInFlight.add(id);
      detailHydrationActive += 1;
      hydrateProjectDetails(project)
        .then((normalized) => {
          if (normalized && normalized !== project) scheduleHydratedDisplayRefresh();
        })
        .finally(() => {
          detailHydrationInFlight.delete(id);
          detailHydrationActive = Math.max(0, detailHydrationActive - 1);
          pumpProjectDetailHydration();
        });
    }
  }
  function projectDownloads(p){
    const measurementId = firstMeasureProjectId(p);
    const base = measurementId && fmUrl ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/`) : null;
    const isRejected = projectStatusGroup(p) === 'rejected';
    const hasReportFlag = hasCustomerVisibleReport(p) && !isRejected;
    const reportUrl = hasReportFlag ? (p.report_url || p.pdf_url || (base ? (base + 'Report.pdf') : null)) : null;
    const summaryUrl = hasReportFlag ? (p.summary_url || (base ? (base + 'Summary.pdf') : null)) : null;
    const xmlUrl = p.xml_url || (base ? (base + 'model_data.xml') : null);
    return { base, reportUrl, summaryUrl, xmlUrl, hasReportFlag, isRejected };
  }
  function xmlDownloadName(project){
    return `model_${String(project?.id || '').slice(0,12) || 'data'}.xml`;
  }
  function xmlDownloadPanelHtml(){
    return `
      <div style="display:flex; flex-direction:column; gap:12px; padding-top:14px;">
        <h4 style="margin:0; display:flex; align-items:center; gap:10px; padding-right:30px;"><i class="fas fa-code" style="color:var(--primary-readable,var(--primary,#d93025));"></i> XML Model</h4>
        <a href="#" class="v-dlbtn" id="vmXmlPanelDownload"><i class="fas fa-code"></i> Download XML Model</a>
      </div>`;
  }
  function pdfPreviewDisabledPanelHtml(url, label){
    const safeUrl = escapeHtml(url || '#');
    const safeLabel = escapeHtml(label || 'PDF');
    return `
      <div class="v-pdf-debug-card">
        <i class="fas fa-file-pdf"></i>
        <h4>${safeLabel} preview disabled</h4>
        <p>The embedded PDF viewer is disabled by the current debug flag so Chrome mobile tools can stay open.</p>
        ${url ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="v-dlbtn"><i class="fas fa-up-right-from-square"></i> Open PDF</a>` : ''}
      </div>`;
  }
  function hidePdfPreviewDisabledPanel(pending){
    if (!pending) return;
    pending.classList.remove('pdf-preview-disabled');
  }
  function showPdfPreviewDisabledPanel({ pending, frame, mapEl, instantPane, url, label }){
    if (!pending) return;
    if (frame) {
      frame.style.display = 'none';
      frame.src = '';
    }
    if (mapEl) mapEl.style.display = 'none';
    if (instantPane) instantPane.classList.remove('active');
    pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
    pending.classList.add('pdf-preview-disabled');
    pending.innerHTML = pdfPreviewDisabledPanelHtml(url, label);
    pending.style.display = 'flex';
  }
  function wireXmlPanelDownload(url, project){
    const btn = document.getElementById('vmXmlPanelDownload');
    if (!btn || !url) return;
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await forceDownloadFile(url, xmlDownloadName(project));
      } catch (error) {
        window.PlatformUI?.alert?.('Could not download XML file.') || alert('Could not download XML file.');
        console.error(error);
      }
    });
  }
  function portalBrandingAssetUrl(url){
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
    if (raw.startsWith('/')) {
      try{
        const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
        const host = String(location.hostname || '').toLowerCase();
        const base = raw.startsWith('/v1/')
          ? (configured || (host === '127.0.0.1' || host === 'localhost'
            ? ''
            : `${location.origin}/v1/platform`))
          : location.origin;
        if (!base) return '';
        return new URL(raw, base).href;
      }catch(e){ return raw; }
    }
    if (raw.startsWith('organizations/')) {
      const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
      const host = String(location.hostname || '').toLowerCase();
      const base = configured || (host === '127.0.0.1' || host === 'localhost'
        ? ''
        : `${location.origin}/v1/platform`);
      if (!base) return '';
      return `${base}/${raw}`;
    }
    return raw;
  }
  function readCachedOrgBranding(){
    try{
      const raw = localStorage.getItem('fm_org_theme_v1');
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        logo_url: portalBrandingAssetUrl(parsed.logo || ''),
        primary_color: typeof parsed.primary === 'string' ? parsed.primary.trim() : '',
        secondary_color: typeof parsed.secondary === 'string' ? parsed.secondary.trim() : ''
      };
    }catch(e){
      return null;
    }
  }
  async function getOrganizationBrandingSnapshot(){
    let logoUrl = '';
    let primary = '';
    let secondary = '';
    try{
      const orgId = String(window.__APP?.userOrgId || '').trim();
      let org = null;
      if (orgId && window.PlatformAPI?.orgs?.portalState) {
        const state = await window.PlatformAPI.orgs.portalState(orgId);
        org = {
          branding: state?.branding || state?.branch?.data?.branding || {}
        };
      } else {
        const result = await postAction('org_get_my');
        org = result?.data?.success ? result?.data?.org : null;
      }
      if (org && typeof org === 'object'){
        logoUrl = portalBrandingAssetUrl(org?.branding?.logo || '');
        primary = String(org?.branding?.colors?.primary || org?.branding?.colors?.accent || '').trim();
        secondary = String(org?.branding?.colors?.secondary || '').trim();
      }
    }catch(e){}
    if (!logoUrl || !primary || !secondary){
      const cached = readCachedOrgBranding();
      if (cached){
        logoUrl = logoUrl || cached.logo_url || '';
        primary = primary || cached.primary_color || '';
        secondary = secondary || cached.secondary_color || '';
      }
    }
    if (!primary){
      primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    }
    if (!secondary){
      secondary = getComputedStyle(document.documentElement).getPropertyValue('--secondary').trim();
    }
    return {
      ...(logoUrl ? { logo_url: logoUrl } : {}),
      ...(primary ? { primary_color: primary } : {}),
      ...(secondary ? { secondary_color: secondary } : {})
    };
  }
  function buildInstantPdfFileName(project, variant){
    const fileAddress = displayAddressPlain(project).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || String(project?.id || 'instant');
    return variant === 'customer'
      ? `${fileAddress}_customer_facing_instant.pdf`
      : `${fileAddress}_standard_instant.pdf`;
  }
  function customerInfoEls(){
    return {
      name: document.getElementById('vmCustomerName'),
      email: document.getElementById('vmCustomerEmail'),
      phone: document.getElementById('vmCustomerPhone'),
      save: document.getElementById('vmCustomerSave')
    };
  }
  function readCustomerInfoDraft(){
    const els = customerInfoEls();
    return {
      name: String(els.name?.value || '').trim(),
      email: String(els.email?.value || '').trim(),
      phone: String(els.phone?.value || '').trim()
    };
  }
  function setCustomerInfoMeta(text, tone){
    void text;
    void tone;
  }
  function buildPreparedForPayload(draft){
    const name = String(draft?.name || '').trim();
    const email = String(draft?.email || '').trim();
    const phone = String(draft?.phone || '').trim();
    const payload = {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {})
    };
    return Object.keys(payload).length ? payload : null;
  }
  async function flashCustomerSaveButton(button, text, durationMs){
    if (!button) return;
    button.textContent = text || 'Saved';
    await new Promise((resolve) => setTimeout(resolve, Number(durationMs) || 650));
    button.textContent = 'Save';
  }
  function validateCustomerInfoDraft(draft, options){
    const hasAny = !!(draft?.name || draft?.email || draft?.phone);
    if (!hasAny) return;
  }
  function syncProjectRecord(project){
    const normalized = normalizeProjectRecord(project);
    const id = String(normalized?.id || '');
    if (!id) return normalized;
    lastProjectsById.set(id, normalized);
    allProjects = allProjects.map(item => String(item?.id || '') === id ? normalized : item);
    filteredProjects = filteredProjects.map(item => String(item?.id || '') === id ? normalized : item);
    if (panelEl) patchBadges([normalized]);
    return normalized;
  }
  function applyResidentFieldsToProject(project, draft){
    if (!project || typeof project !== 'object') return project;
    const resident = {
      ...(draft?.name ? { name: draft.name } : { name: '' }),
      ...(draft?.email ? { email: draft.email } : { email: '' }),
      ...(draft?.phone ? { phone: draft.phone } : { phone: '' })
    };
    project.resident = draft?.name || '';
    project.resident_name = draft?.name || '';
    project.resident_email = draft?.email || '';
    project.resident_phone = draft?.phone || '';
    project.residentEmail = draft?.email || '';
    project.residentPhone = draft?.phone || '';
    project.manifest = (project.manifest && typeof project.manifest === 'object') ? project.manifest : {};
    project.manifest.resident = resident;
    project.resident = draft?.name || '';
    return syncProjectRecord(project);
  }
  async function saveProjectCustomerInfo(project, options){
    const draft = options?.draft || readCustomerInfoDraft();
    validateCustomerInfoDraft(draft, options);
    const actor = currentActor ? currentActor() : {};
    const payload = {
      resident: {
        name: draft.name || null,
        email: draft.email || null,
        phone: draft.phone || null
      },
      ...(actor && Object.keys(actor).length ? { actor } : {})
    };
    const projectId = firstMeasureProjectId(project);
    if (!projectId) throw new Error('FirstMeasure project id is unavailable.');
    await fmJson(`projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const normalized = applyResidentFieldsToProject(project, draft);
    if (!options?.silentSuccess) {
      setCustomerInfoMeta(draft.name || draft.email || draft.phone ? 'Contact info saved.' : 'Contact info cleared.', 'ok');
    }
    return { draft, project: normalized };
  }
  function setDlButton(aEl, url, label, iconClass, enabled){
    if (!aEl) return;
    aEl.innerHTML = `<i class="${iconClass}"></i> ${escapeHtml(label)}`;
    if (enabled && url){ aEl.classList.remove('disabled'); aEl.removeAttribute('aria-disabled'); aEl.href = url; aEl.style.display = 'flex'; }
    else { aEl.classList.add('disabled'); aEl.setAttribute('aria-disabled','true'); aEl.href = '#'; aEl.style.display = enabled === false ? 'none' : 'flex'; }
  }
  async function softFileExists(url){
    if (!url) return false;
    const now = Date.now();
    const cached = __fileExistsCache.get(url);
    if (cached && (now - cached.t) < 60000) return !!cached.ok;
    let ok = false;
    try{ const r = await fetch(url, { method:'HEAD', cache:'no-store' }); if (r && r.ok){ __fileExistsCache.set(url, { ok:true, t: now }); return true; } if (r && (r.status === 404 || r.status === 410)){ __fileExistsCache.set(url, { ok:false, t: now }); return false; } }catch(e){}
    try{ const r = await fetch(url, { method: 'GET', cache: 'no-store', headers: { 'Range': 'bytes=0-0' } }); if (r && (r.status === 206 || r.status === 200)) ok = true; else if (r && (r.status === 404 || r.status === 410)) ok = false; else ok = !!(r && r.ok); try{ if (r && r.body && r.body.cancel) r.body.cancel(); }catch(e){} }catch(e){ ok = false; }
    __fileExistsCache.set(url, { ok, t: now });
    return ok;
  }
  async function forceDownloadFile(url, filename){
    if (!url) return;
    const res = await fetch(url, { method:'GET', cache:'no-store', credentials:'same-origin' });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = objUrl; a.download = filename || 'download'; a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(()=>{ try{ URL.revokeObjectURL(objUrl); }catch(e){} try{ a.remove(); }catch(e){} }, 1500);
  }
  async function forceDownloadPostedFile(path, payload, filename){
    const paths = Array.isArray(path) ? path.filter(Boolean) : [path].filter(Boolean);
    let lastError = null;
    let blob = null;
    for (let index = 0; index < paths.length; index += 1) {
      const res = await fetch(fmUrl(paths[index]), {
        method: 'POST',
        headers: {
          'Accept': 'application/pdf',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload || {}),
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (res.ok) {
        blob = await res.blob();
        break;
      }
      let message = `Download failed (${res.status})`;
      try{
        const data = await res.json();
        message = String(data?.message || data?.error || message);
      }catch(e){}
      lastError = new Error(message);
      if (res.status !== 404 || index === paths.length - 1) {
        throw lastError;
      }
    }
    if (!blob) {
      throw lastError || new Error('Download failed.');
    }
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || 'download.pdf';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ try{ URL.revokeObjectURL(objUrl); }catch(e){} try{ a.remove(); }catch(e){} }, 1500);
  }
  function hideDlButton(aEl){
    if (!aEl) return;
    aEl.style.display = 'none'; aEl.classList.add('disabled'); aEl.setAttribute('aria-disabled','true'); aEl.href = '#'; aEl.removeAttribute('download'); aEl.onclick = null; aEl.onmousedown = null;
  }
  function showDlButton(aEl, url, label, iconClass, opts){
    if (!aEl) return;
    const o = opts || {};
    aEl.innerHTML = `<i class="${iconClass}"></i> ${escapeHtml(label)}`;
    aEl.classList.remove('disabled'); aEl.removeAttribute('aria-disabled'); aEl.style.display = 'flex';
    aEl.onclick = null; aEl.onmousedown = null; aEl.removeAttribute('download');
    if (o.forceDownload){
      aEl.href = '#'; aEl.removeAttribute('target');
      aEl.onclick = async (e)=>{ e.preventDefault(); e.stopPropagation(); try{ await forceDownloadFile(url, o.downloadName || 'model_data.xml'); }catch(err){ window.PlatformUI?.alert?.('Could not download file.') || alert('Could not download file.'); console.error(err); } };
      return;
    }
    aEl.href = url;
    if (o.downloadName){ aEl.setAttribute('download', o.downloadName); aEl.removeAttribute('target'); }
  }

  async function openModal(p){
    if (!p?._forceLegacyViewer && window.Portal?.modules?.request?.openProject) {
      closeModal();
      window.Portal.modules.request.openProject(normalizeProjectRecord(p));
      return;
    }
    const requestedProject = normalizeProjectRecord(p);
    const preferInstantOpen = !!requestedProject?._preferInstantOpen;
    modalOpen = true;
    const myNonce = ++__modalNonce;
    currentModalId = String(requestedProject?.id || '');
    currentModalGroup = projectStatusGroup(requestedProject);
    currentModalProject = requestedProject;
    currentModalCustomerSave = null;

    cancelInstantWork();
    resetInstantCanvasSurface();
    hideInstantPane();
    hideFullReportUpgradeDialog();
    renderModalTabs({ showMap: false, showMeasurements: false, activeMainTab: '' });
    renderMeasurementTabs({ show: false });
    renderModalFooter({ show: false });
    renderSidebarActions({});
    clearExtraMarkers();
    const pendingShell = document.getElementById('vmPending');
    if (pendingShell) {
      pendingShell.classList.remove('processing','rejected','cancelled');
      pendingShell.style.display = 'none';
      pendingShell.innerHTML = '';
    }
    const customerEls = customerInfoEls();
    const applyCustomerDraftToInputs = (projectRecord) => {
      const resident = resolveResidentFields(projectRecord);
      if (customerEls.name) customerEls.name.value = resident.name || '';
      if (customerEls.email) customerEls.email.value = resident.email || '';
      if (customerEls.phone) customerEls.phone.value = resident.phone || '';
    };
    applyCustomerDraftToInputs(requestedProject);
    setCustomerInfoMeta('Saved per project.');
    $('#vmAddress', panelEl).textContent = requestedProject?.address || displayAddressPlain(requestedProject) || '\u2014';
    $('#vmIssuer', panelEl).textContent = requestedProject?.issuer || '-';
    $('#vmIssuerEmail', panelEl).textContent = requestedProject?.issuer_email || '-';
    $('#vmDate', panelEl).textContent = formatDate(requestedProject?.created_at);
    $('#vOverlay', panelEl).classList.add('active');

    p = normalizeProjectRecord(await hydrateProjectDetails(requestedProject));
    if (!modalOpen || myNonce !== __modalNonce) return;
    if (p?.refund_pending && (p?.instant_only || p?.instant_enabled || String(p?.report_mode || '').trim().toLowerCase() === 'instant')) {
      await ensureInstantRejectionRefund(p);
      if (!modalOpen || myNonce !== __modalNonce) return;
    }
    currentModalId = String(p.id);
    currentModalGroup = projectStatusGroup(p);
    currentModalProject = p;
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:true, id:String(p.id) } }));

    $('#vmAddress', panelEl).textContent = p.address || displayAddressPlain(p) || '\u2014';
    applyCustomerDraftToInputs(p);
    $('#vmIssuer', panelEl).textContent = p.issuer || '-';
    $('#vmIssuerEmail', panelEl).textContent = p.issuer_email || '-';
    $('#vmDate', panelEl).textContent = formatDate(p.created_at);

    const wireCustomerInfo = () => {
      const resident = resolveResidentFields(p);
      const baseline = {
        name: resident.name || '',
        email: resident.email || '',
        phone: resident.phone || ''
      };
      applyCustomerDraftToInputs(p);
      setCustomerInfoMeta(baseline.name || baseline.email || baseline.phone ? 'Loaded from this project.' : 'Saved per project.');
      const markDirty = () => setCustomerInfoMeta('Unsaved changes.');
      [customerEls.name, customerEls.email, customerEls.phone].forEach((input) => {
        if (!input) return;
        input.oninput = markDirty;
      });
      if (customerEls.save) {
        customerEls.save.onclick = async () => {
          try {
            customerEls.save.disabled = true;
            customerEls.save.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving';
            const result = await saveProjectCustomerInfo(p);
            p = result.project || p;
            currentModalProject = p;
            await flashCustomerSaveButton(customerEls.save, 'Saved', 650);
          } catch (error) {
            setCustomerInfoMeta(error?.message || 'Could not save contact info.', 'error');
            window.Portal?.ui?.showToast?.('Contact info', error?.message || 'Could not save contact info.', false);
          } finally {
            customerEls.save.disabled = false;
            customerEls.save.textContent = 'Save';
          }
        };
      }
      currentModalCustomerSave = async (options = {}) => {
        try {
          if (customerEls.save) {
            customerEls.save.disabled = true;
            customerEls.save.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving';
          }
          const result = await saveProjectCustomerInfo(p, options);
          p = result.project || p;
          currentModalProject = p;
          if (!options.silentSuccess) {
            setCustomerInfoMeta('Contact info saved.', 'ok');
          }
          return result;
        } catch (error) {
          setCustomerInfoMeta(error?.message || 'Could not save contact info.', 'error');
          throw error;
        } finally {
          if (customerEls.save) {
            customerEls.save.disabled = false;
            customerEls.save.textContent = 'Save';
          }
        }
      };
    };
    wireCustomerInfo();

    // Project type
    const tm = getTypeMeta(p);
    const vmTypeItem = $('#vmTypeItem', panelEl);
    const vmType = $('#vmType', panelEl);
    if (vmTypeItem && vmType){
      vmTypeItem.style.display = '';
      vmType.innerHTML = `<span class="v-type-pill" style="background:${tm.color};"><i class="fas ${tm.icon}"></i> ${escapeHtml(tm.label)}</span>`;
    }
    const vmScopeItem = $('#vmScopeItem', panelEl);
    const vmScope = $('#vmScope', panelEl);
    if (vmScopeItem && vmScope){
      vmScopeItem.style.display = '';
      vmScope.textContent = projectScopeLabel(p);
    }

    // CC emails
    const ccArr = Array.isArray(p.cc_emails) ? p.cc_emails : [];
    const vmCcItem = $('#vmCcItem', panelEl);
    const vmCcEmails = $('#vmCcEmails', panelEl);
    if (vmCcItem && vmCcEmails){
      if (ccArr.length){ vmCcItem.style.display = ''; vmCcEmails.innerHTML = ccArr.map(e => `<span class="v-cc-chip">${escapeHtml(e)}</span>`).join(''); }
      else { vmCcItem.style.display = 'none'; }
    }

    // Tech notes
    const techNotes = p.tech_notes || '';
    const vmTechNotesItem = $('#vmTechNotesItem', panelEl);
    const vmTechNotes = $('#vmTechNotes', panelEl);
    if (vmTechNotesItem && vmTechNotes){
      if (techNotes){ vmTechNotesItem.style.display = ''; vmTechNotes.textContent = techNotes; }
      else { vmTechNotesItem.style.display = 'none'; }
    }

    const statusEl = $('#vmStatus', panelEl);
    const frame = $('#vmFrame', panelEl);
    const mapEl = document.getElementById('vmMapCanvas');
    const instantPane = document.getElementById('vmInstantPane');
    const pending = document.getElementById('vmPending');
    const dlReport = $('#vmDlReport', panelEl);
    const dlSummary = $('#vmDlSummary', panelEl);
    const dlXml = $('#vmDlXml', panelEl);

    pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
    pending.style.display = 'none'; pending.innerHTML = '';
    hideDlButton(dlReport); hideDlButton(dlSummary); hideDlButton(dlXml);

    const st = String(p.status || '');
    const isRejected = st.toLowerCase() === 'rejected_no_coverage' || st.toLowerCase() === 'rejected';
    const isCancelled = st.toLowerCase() === 'cancelled';
    const linkedFullProject = p?._linkedFullProject ? normalizeProjectRecord(p._linkedFullProject) : null;
    const parentDls = projectDownloads(p);
    const linkedDls = linkedFullProject ? projectDownloads(linkedFullProject) : null;
    const parentFullReady = !isRejected && !isCancelled && !!parentDls.hasReportFlag;
    const linkedFullReady = !isRejected && !isCancelled && !!linkedDls?.hasReportFlag;
    const fullProject = linkedFullReady ? linkedFullProject : (parentFullReady ? p : (linkedFullProject || p));
    const dls = linkedFullReady ? linkedDls : (parentFullReady ? parentDls : (linkedDls || parentDls));
    const hasFullReady = !isRejected && !isCancelled && !!dls.hasReportFlag;
    const fullReworkMeta = completedCustomerReworkMeta(fullProject);
    const fullReportIsCorrected = fullReworkMeta.completed;
    const fullReworkPending = activeCustomerReworkMeta(fullProject).active;
    const hasInstant = !isRejected && !isCancelled && projectSupportsInstant(p);
    const wantsFullTab = hasInstant && (projectReportMode(p) === 'both' || !!linkedFullProject || hasFullReady);
    let xmlDownloadReady = !!(dls.xmlUrl && (p?.xml_url || fullProject?.xml_url || linkedFullProject?.xml_url));
    let activeMainTab = (hasInstant || hasFullReady) ? 'measurements' : 'map';
    let activeMeasurementTab = (preferInstantOpen && hasInstant) ? 'instant' : (hasFullReady ? 'standard' : 'instant');

    if (hasInstant) {
      const sidebarOrderLabel = () => `<i class="fas fa-file-lines"></i> Order Full Report - $${fmtMoney(fullReportBasePrice(p))}`;
      const measurementTabs = () => {
        const tabs = [];
        if (hasInstant) {
          tabs.push({
            id: 'instant',
            label: 'Instant',
            icon: 'fa-bolt',
            active: activeMeasurementTab === 'instant'
          });
        }
        if (wantsFullTab) {
          tabs.push({
            id: 'standard',
            label: fullReportIsCorrected ? 'Corrected' : 'Standard',
            icon: hasFullReady ? 'fa-file-pdf' : 'fa-circle-notch fa-spin',
            active: activeMeasurementTab === 'standard',
            disabled: !hasFullReady,
            pending: !hasFullReady
          });
          tabs.push({
            id: 'customer',
            label: fullReportIsCorrected ? 'Customer Copy' : 'Customer',
            icon: hasFullReady ? 'fa-file-lines' : 'fa-circle-notch fa-spin',
            active: activeMeasurementTab === 'customer',
            disabled: !hasFullReady,
            pending: !hasFullReady
          });
          if (xmlDownloadReady) {
            tabs.push({
              id: 'xml',
              label: 'XML',
              icon: hasFullReady ? 'fa-code' : 'fa-circle-notch fa-spin',
              active: activeMeasurementTab === 'xml',
              disabled: !hasFullReady,
              pending: !hasFullReady
            });
          }
          if (fullReworkPending) {
            tabs.push({
              id: 'changes',
              label: 'Changes Pending',
              icon: 'fa-clock-rotate-left',
              active: activeMeasurementTab === 'changes'
            });
          }
        }
        return tabs;
      };
      const renderCurrentTabs = () => {
        renderModalTabs({
          showInfo: true,
          showMap: true,
          showMeasurements: true,
          activeMainTab
        });
        renderMeasurementTabs({
          show: activeMainTab === 'measurements',
          tabs: activeMainTab === 'measurements' ? measurementTabs() : []
        });
      };
      const renderInstantSidebar = (popHtml = '') => {
        let actionsHtml = '';
        if (projectReportMode(p) === 'instant' && !linkedFullProject) {
          actionsHtml = `<button type="button" id="vmOrderFull" class="v-dlbtn">${sidebarOrderLabel()}</button>`;
        } else if (!hasFullReady && wantsFullTab) {
          actionsHtml = `<div class="v-side-chip pending"><i class="fas fa-circle-notch"></i> Full report is still processing</div>`;
        }
        actionsHtml += pendingCustomerReworkNoticeHtml(fullProject);
        renderSidebarActions({
          actionsHtml,
          popActive: !!popHtml,
          popHtml
        });
      };
      const wireOrderUpgradeButton = () => {
        const orderFullBtn = document.getElementById('vmOrderFull');
        if (!orderFullBtn) return;
        orderFullBtn.addEventListener('click', () => showFullReportUpgradeDialog(p));
      };
      const ensureFullDownloadsLoaded = async () => {
        if (!hasFullReady) return;
        const [hasReport, hasSummary, hasXml] = await Promise.all([softFileExists(dls.reportUrl), softFileExists(dls.summaryUrl), softFileExists(dls.xmlUrl)]);
        if (!modalOpen || __modalNonce !== myNonce) return;
        if (hasReport) showDlButton(dlReport, dls.reportUrl, fullReportIsCorrected ? 'Download Corrected Report PDF' : 'Download Report PDF', 'fas fa-file-pdf'); else hideDlButton(dlReport);
        if (hasSummary) showDlButton(dlSummary, dls.summaryUrl, fullReportIsCorrected ? 'Download Corrected Customer PDF' : 'Download Customer PDF', 'fas fa-file-lines'); else hideDlButton(dlSummary);
        if (hasXml){
          showDlButton(dlXml, dls.xmlUrl, 'Download XML Model', 'fas fa-code', { forceDownload: true, downloadName: xmlDownloadName(fullProject) });
          if (!xmlDownloadReady) {
            xmlDownloadReady = true;
            renderCurrentTabs();
            wireTabHandlers();
          }
        } else {
          hideDlButton(dlXml);
        }
      };
      const showChangesPendingView = async () => {
        if (!fullReworkPending) return;
        activeMainTab = 'measurements';
        activeMeasurementTab = 'changes';
        setModalTabState('measurements');
        renderCurrentTabs();
        wireTabHandlers();
        frame.style.display = 'none';
        frame.src = '';
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.remove('active');
        pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
        pending.innerHTML = pendingCustomerReworkPanelHtml(fullProject);
        pending.style.display = 'block';
        renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
        renderModalFooter({ show: false });
        await ensureFullDownloadsLoaded();
      };
      const wireTabHandlers = () => {
        document.getElementById('vmTabInfo')?.addEventListener('click', () => {
          if (activeMainTab === 'info') return;
          showInfoView();
        });
        document.getElementById('vmTabMap')?.addEventListener('click', () => {
          if (activeMainTab === 'map' && mapEl?.style.display === 'block') return;
          showMapView();
        });
        document.getElementById('vmTabMeasurements')?.addEventListener('click', () => {
          if (activeMainTab === 'measurements') return;
          if (activeMeasurementTab === 'changes' && fullReworkPending) {
            void showChangesPendingView();
          } else if (activeMeasurementTab === 'xml' && hasFullReady && xmlDownloadReady) {
            void showXmlView();
          } else if (activeMeasurementTab === 'customer' && hasFullReady) {
            void showCustomerView();
          } else if (hasFullReady) {
            void showStandardView();
          } else {
            showInstantView();
          }
        });
        document.getElementById('vmSubTabInstant')?.addEventListener('click', () => {
          if (activeMainTab === 'measurements' && activeMeasurementTab === 'instant' && instantPane?.classList.contains('active')) return;
          showInstantView();
        });
        document.getElementById('vmSubTabStandard')?.addEventListener('click', () => {
          if (!hasFullReady || (activeMainTab === 'measurements' && activeMeasurementTab === 'standard')) return;
          void showStandardView();
        });
        document.getElementById('vmSubTabCustomer')?.addEventListener('click', () => {
          if (!hasFullReady || (activeMainTab === 'measurements' && activeMeasurementTab === 'customer')) return;
          void showCustomerView();
        });
        document.getElementById('vmSubTabXml')?.addEventListener('click', () => {
          if (!hasFullReady || !xmlDownloadReady || (activeMainTab === 'measurements' && activeMeasurementTab === 'xml')) return;
          void showXmlView();
        });
        document.getElementById('vmSubTabChanges')?.addEventListener('click', () => {
          if (!fullReworkPending || (activeMainTab === 'measurements' && activeMeasurementTab === 'changes')) return;
          void showChangesPendingView();
        });
      };
      statusEl.textContent = fullReworkPending ? 'CHANGES PENDING' : (hasFullReady ? (fullReportIsCorrected ? 'CORRECTED REPORT READY' : 'INSTANT + FULL') : (wantsFullTab ? 'FULL REPORT PROCESSING' : 'INSTANT REPORT'));
      statusEl.style.color = '#8ab4f8';
      renderCurrentTabs();

      const showInfoView = () => {
        activeMainTab = 'info';
        setModalTabState('info');
        renderCurrentTabs();
        wireTabHandlers();
        frame.style.display = 'none';
        frame.src = '';
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.remove('active');
        hidePdfPreviewDisabledPanel(pending);
        pending.style.display = 'none';
        renderModalFooter({ show: false });
      };

      const showMapView = () => {
        activeMainTab = 'map';
        setModalTabState('map');
        renderCurrentTabs();
        wireTabHandlers();
        frame.style.display = 'none';
        frame.src = '';
        mapEl.style.display = 'block';
        if (instantPane) instantPane.classList.remove('active');
        hidePdfPreviewDisabledPanel(pending);
        pending.style.display = 'none';
        renderProjectMap(p);
        renderInstantSidebar();
        wireOrderUpgradeButton();
        renderModalFooter({
          show: false,
          leftHtml: '',
          rightHtml: '',
          popActive: false,
          popHtml: ''
        });
      };

      const showInstantView = () => {
        activeMainTab = 'measurements';
        activeMeasurementTab = 'instant';
        setModalTabState('measurements');
        renderCurrentTabs();
        wireTabHandlers();
        frame.style.display = 'none';
        frame.src = '';
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.add('active');
        hidePdfPreviewDisabledPanel(pending);
        pending.style.display = 'none';

        renderInstantSidebar();
        wireOrderUpgradeButton();
        renderModalFooter({
          show: false,
          leftHtml: '',
          rightHtml: '',
          popActive: false,
          popHtml: ''
        });
        if (hasFullReady) void ensureFullDownloadsLoaded();
        void loadInstantForProject(p, myNonce);
      };

      const showStandardView = async () => {
        if (!hasFullReady) return;
        activeMainTab = 'measurements';
        activeMeasurementTab = 'standard';
        setModalTabState('measurements');
        renderCurrentTabs();
        wireTabHandlers();
        if (pdfPreviewDisabled) {
          showPdfPreviewDisabledPanel({ pending, frame, mapEl, instantPane, url: dls.reportUrl, label: fullReportIsCorrected ? 'Corrected report' : 'Report' });
        } else {
          hidePdfPreviewDisabledPanel(pending);
          frame.style.display = 'block';
          frame.src = dls.reportUrl ? (dls.reportUrl + '#view=FitH') : '';
          pending.style.display = 'none';
        }
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.remove('active');
        renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
        renderModalFooter({ show: false });
        await ensureFullDownloadsLoaded();
      };

      const showCustomerView = async () => {
        if (!hasFullReady) return;
        activeMainTab = 'measurements';
        activeMeasurementTab = 'customer';
        setModalTabState('measurements');
        renderCurrentTabs();
        wireTabHandlers();
        if (pdfPreviewDisabled) {
          showPdfPreviewDisabledPanel({ pending, frame, mapEl, instantPane, url: dls.summaryUrl, label: fullReportIsCorrected ? 'Corrected customer copy' : 'Customer copy' });
        } else {
          hidePdfPreviewDisabledPanel(pending);
          frame.style.display = 'block';
          frame.src = dls.summaryUrl ? (dls.summaryUrl + '#view=FitH') : '';
          pending.style.display = 'none';
        }
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.remove('active');
        renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
        renderModalFooter({ show: false });
        await ensureFullDownloadsLoaded();
      };
      const showXmlView = async () => {
        if (!hasFullReady || !xmlDownloadReady || !dls.xmlUrl) return;
        activeMainTab = 'measurements';
        activeMeasurementTab = 'xml';
        setModalTabState('measurements');
        renderCurrentTabs();
        wireTabHandlers();
        frame.style.display = 'none';
        frame.src = '';
        mapEl.style.display = 'none';
        if (instantPane) instantPane.classList.remove('active');
        pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
        pending.innerHTML = xmlDownloadPanelHtml();
        pending.style.display = 'block';
        wireXmlPanelDownload(dls.xmlUrl, fullProject);
        renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
        renderModalFooter({ show: false });
        await ensureFullDownloadsLoaded();
      };

      $('#vOverlay', panelEl).classList.add('active');
      wireTabHandlers();
      if (hasFullReady && !preferInstantOpen) {
        void showStandardView();
      } else {
        showInstantView();
      }
      return;
    }

    const standaloneFullReady = !isRejected && !isCancelled && !!dls.hasReportFlag;
    const standaloneReworkMeta = completedCustomerReworkMeta(fullProject);
    const standaloneReportIsCorrected = standaloneReworkMeta.completed;
    const standaloneReworkPending = activeCustomerReworkMeta(fullProject).active;
    let standaloneXmlDownloadReady = !!(dls.xmlUrl && (p?.xml_url || fullProject?.xml_url));
    let standaloneMainTab = standaloneFullReady ? 'measurements' : 'map';
    let standaloneMeasurementTab = 'standard';
    const standaloneMeasurementTabs = () => {
      if (!standaloneFullReady) return [];
      const tabs = [
        { id: 'standard', label: standaloneReportIsCorrected ? 'Corrected' : 'Standard', icon: 'fa-file-pdf', active: standaloneMeasurementTab === 'standard' },
        { id: 'customer', label: standaloneReportIsCorrected ? 'Customer Copy' : 'Customer', icon: 'fa-file-lines', active: standaloneMeasurementTab === 'customer' }
      ];
      if (standaloneXmlDownloadReady) {
        tabs.push({ id: 'xml', label: 'XML', icon: 'fa-code', active: standaloneMeasurementTab === 'xml' });
      }
      if (standaloneReworkPending) {
        tabs.push({ id: 'changes', label: 'Changes Pending', icon: 'fa-clock-rotate-left', active: standaloneMeasurementTab === 'changes' });
      }
      return tabs;
    };
    const renderStandaloneTabs = () => {
      renderModalTabs({
        showInfo: true,
        showMap: true,
        showMeasurements: standaloneFullReady,
        activeMainTab: standaloneMainTab
      });
      renderMeasurementTabs({
        show: standaloneMainTab === 'measurements',
        tabs: standaloneMainTab === 'measurements' ? standaloneMeasurementTabs() : []
      });
    };
    const showStandaloneInfoView = () => {
      standaloneMainTab = 'info';
      setModalTabState('info');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      frame.style.display = 'none';
      frame.src = '';
      mapEl.style.display = 'none';
      if (instantPane) instantPane.classList.remove('active');
      hidePdfPreviewDisabledPanel(pending);
      pending.style.display = 'none';
      renderModalFooter({ show: false });
    };
    const showStandaloneMapView = () => {
      standaloneMainTab = 'map';
      setModalTabState('map');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      frame.style.display = 'none';
      frame.src = '';
      mapEl.style.display = 'block';
      if (instantPane) instantPane.classList.remove('active');
      hidePdfPreviewDisabledPanel(pending);
      pending.style.display = 'none';
      renderProjectMap(p);
      renderSidebarActions({ actionsHtml: pendingCustomerReworkNoticeHtml(fullProject) });
      renderModalFooter({ show: false });
    };
    const ensureStandaloneDownloadsLoaded = async () => {
      if (!standaloneFullReady) return;
      const [hasReport, hasSummary, hasXml] = await Promise.all([softFileExists(dls.reportUrl), softFileExists(dls.summaryUrl), softFileExists(dls.xmlUrl)]);
      if (!modalOpen || __modalNonce !== myNonce) return;
      if (hasReport) showDlButton(dlReport, dls.reportUrl, standaloneReportIsCorrected ? 'Download Corrected Report PDF' : 'Download Report PDF', 'fas fa-file-pdf'); else hideDlButton(dlReport);
      if (hasSummary) showDlButton(dlSummary, dls.summaryUrl, standaloneReportIsCorrected ? 'Download Corrected Customer PDF' : 'Download Customer PDF', 'fas fa-file-lines'); else hideDlButton(dlSummary);
      if (hasXml){
        showDlButton(dlXml, dls.xmlUrl, 'Download XML Model', 'fas fa-code', { forceDownload: true, downloadName: xmlDownloadName(p) });
        if (!standaloneXmlDownloadReady) {
          standaloneXmlDownloadReady = true;
          renderStandaloneTabs();
          wireStandaloneTabHandlers();
        }
      } else {
        hideDlButton(dlXml);
      }
    };
    const showStandaloneStandardView = async () => {
      if (!standaloneFullReady) return;
      standaloneMainTab = 'measurements';
      standaloneMeasurementTab = 'standard';
      setModalTabState('measurements');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      if (pdfPreviewDisabled) {
        showPdfPreviewDisabledPanel({ pending, frame, mapEl, instantPane, url: dls.reportUrl, label: standaloneReportIsCorrected ? 'Corrected report' : 'Report' });
      } else {
        hidePdfPreviewDisabledPanel(pending);
        frame.style.display = 'block';
        frame.src = dls.reportUrl ? (dls.reportUrl + '#view=FitH') : '';
        pending.style.display = 'none';
      }
      mapEl.style.display = 'none';
      if (instantPane) instantPane.classList.remove('active');
      renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
      renderModalFooter({ show: false });
      await ensureStandaloneDownloadsLoaded();
    };
    const showStandaloneCustomerView = async () => {
      if (!standaloneFullReady) return;
      standaloneMainTab = 'measurements';
      standaloneMeasurementTab = 'customer';
      setModalTabState('measurements');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      if (pdfPreviewDisabled) {
        showPdfPreviewDisabledPanel({ pending, frame, mapEl, instantPane, url: dls.summaryUrl, label: standaloneReportIsCorrected ? 'Corrected customer copy' : 'Customer copy' });
      } else {
        hidePdfPreviewDisabledPanel(pending);
        frame.style.display = 'block';
        frame.src = dls.summaryUrl ? (dls.summaryUrl + '#view=FitH') : '';
        pending.style.display = 'none';
      }
      mapEl.style.display = 'none';
      if (instantPane) instantPane.classList.remove('active');
      renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
      renderModalFooter({ show: false });
      await ensureStandaloneDownloadsLoaded();
    };
    const showStandaloneXmlView = async () => {
      if (!standaloneFullReady || !standaloneXmlDownloadReady || !dls.xmlUrl) return;
      standaloneMainTab = 'measurements';
      standaloneMeasurementTab = 'xml';
      setModalTabState('measurements');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      frame.style.display = 'none';
      frame.src = '';
      mapEl.style.display = 'none';
      if (instantPane) instantPane.classList.remove('active');
      pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
      pending.innerHTML = xmlDownloadPanelHtml();
      pending.style.display = 'block';
      wireXmlPanelDownload(dls.xmlUrl, p);
      renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
      renderModalFooter({ show: false });
      await ensureStandaloneDownloadsLoaded();
    };
    const showStandaloneChangesPendingView = async () => {
      if (!standaloneReworkPending) return;
      standaloneMainTab = 'measurements';
      standaloneMeasurementTab = 'changes';
      setModalTabState('measurements');
      renderStandaloneTabs();
      wireStandaloneTabHandlers();
      frame.style.display = 'none';
      frame.src = '';
      mapEl.style.display = 'none';
      if (instantPane) instantPane.classList.remove('active');
      pending.classList.remove('processing','rejected','cancelled','pdf-preview-disabled');
      pending.innerHTML = pendingCustomerReworkPanelHtml(fullProject);
      pending.style.display = 'block';
      renderSidebarActions({ actionsHtml: correctedReportNoticeHtml(fullProject) + pendingCustomerReworkNoticeHtml(fullProject) });
      renderModalFooter({ show: false });
      await ensureStandaloneDownloadsLoaded();
    };
    const wireStandaloneTabHandlers = () => {
      document.getElementById('vmTabInfo')?.addEventListener('click', () => {
        if (standaloneMainTab === 'info') return;
        showStandaloneInfoView();
      });
      document.getElementById('vmTabMap')?.addEventListener('click', () => {
        if (standaloneMainTab === 'map' && mapEl?.style.display === 'block') return;
        showStandaloneMapView();
      });
      document.getElementById('vmTabMeasurements')?.addEventListener('click', () => {
        if (!standaloneFullReady || standaloneMainTab === 'measurements') return;
        if (standaloneMeasurementTab === 'changes' && standaloneReworkPending) {
          void showStandaloneChangesPendingView();
        } else if (standaloneMeasurementTab === 'xml' && standaloneXmlDownloadReady) {
          void showStandaloneXmlView();
        } else if (standaloneMeasurementTab === 'customer') {
          void showStandaloneCustomerView();
        } else {
          void showStandaloneStandardView();
        }
      });
      document.getElementById('vmSubTabStandard')?.addEventListener('click', () => {
        if (!standaloneFullReady || (standaloneMainTab === 'measurements' && standaloneMeasurementTab === 'standard')) return;
        void showStandaloneStandardView();
      });
      document.getElementById('vmSubTabCustomer')?.addEventListener('click', () => {
        if (!standaloneFullReady || (standaloneMainTab === 'measurements' && standaloneMeasurementTab === 'customer')) return;
        void showStandaloneCustomerView();
      });
      document.getElementById('vmSubTabXml')?.addEventListener('click', () => {
        if (!standaloneFullReady || !standaloneXmlDownloadReady || (standaloneMainTab === 'measurements' && standaloneMeasurementTab === 'xml')) return;
        void showStandaloneXmlView();
      });
      document.getElementById('vmSubTabChanges')?.addEventListener('click', () => {
        if (!standaloneReworkPending || (standaloneMainTab === 'measurements' && standaloneMeasurementTab === 'changes')) return;
        void showStandaloneChangesPendingView();
      });
    };
    renderStandaloneTabs();

    if (isRejected){
      currentModalGroup = 'rejected'; statusEl.textContent = 'REJECTED'; statusEl.style.color = '#d93025';
      pending.classList.add('rejected');
      const instantMiss = String(p?.instant_rejection_reason || '').trim().toLowerCase() === 'no_structure_at_pin';
      const showOrderFullFromReject = instantMiss && projectReportMode(p) === 'instant';
      pending.innerHTML = `<h4 style="margin:14px 0 14px; display:flex; align-items:center; gap:10px; padding-right:30px;"><i class="fas fa-circle-exclamation" style="color:#d93025;"></i> Unable to generate report</h4><div style="font-size:12px; color:#7a1b18; line-height:1.35; padding:10px 12px; border:1px solid #f4b4ae; background:#fce8e6; border-radius:12px;">${buildCoverageRejectionDisclaimer(p)}</div>${rejectedReorderButtonHtml(p)}${showOrderFullFromReject ? `<div style="margin-top:14px;"><button type="button" id="vmRejectedOrderFull" class="v-dlbtn"><i class="fas fa-file-lines"></i> Order Full Report - $${fmtMoney(fullReportBasePrice(p))}</button></div>` : ''}`;
      pending.style.display = 'block';
      document.getElementById('vmRejectedReorder')?.addEventListener('click', () => openRejectedReorder(p));
      if (showOrderFullFromReject) {
        document.getElementById('vmRejectedOrderFull')?.addEventListener('click', () => showFullReportUpgradeDialog(p));
      }
    } else if (isCancelled) {
      currentModalGroup = 'cancelled'; statusEl.textContent = 'CANCELLED'; statusEl.style.color = '#5f6368';
      pending.classList.add('cancelled');
      pending.innerHTML = `<h4 style="margin:14px 0 14px; display:flex; align-items:center; gap:10px; padding-right:30px;"><i class="fas fa-ban" style="color:#5f6368;"></i> Project cancelled</h4><div style="font-size:12px; color:#3c4043; line-height:1.35; padding:10px 12px; border:1px solid #dadce0; background:#f1f3f4; border-radius:12px;">${buildCancellationDisclaimer(p)}</div>`;
      pending.style.display = 'block';
    } else if (standaloneFullReady) {
      currentModalGroup = 'ready';
      statusEl.textContent = standaloneReworkPending ? 'CHANGES PENDING' : (standaloneReportIsCorrected ? 'CORRECTED REPORT READY' : 'REPORT READY');
      statusEl.style.color = standaloneReworkPending ? '#fbbc04' : '#34a853';
    } else if (projectStatusGroup(p) === 'draft') {
      currentModalGroup = 'draft'; statusEl.textContent = 'DRAFT'; statusEl.style.color = '#667085';
    } else if (projectStatusGroup(p) === 'project') {
      currentModalGroup = 'project'; statusEl.textContent = ''; statusEl.style.color = '#5f6368';
    } else {
      currentModalGroup = 'processing'; statusEl.textContent = 'PROCESSING'; statusEl.style.color = '#fbbc04';
      pending.classList.add('processing');
      pending.innerHTML = `<h4 style="margin:14px 0 14px;"><i class="fas fa-circle-notch fa-spin"></i> Report Processing</h4><p style="margin:0; font-size:12px; color:#555;">We are currently generating the report for this location.</p>`;
      pending.style.display = 'block';
    }
    $('#vOverlay', panelEl).classList.add('active');
    wireStandaloneTabHandlers();
    if (standaloneFullReady) {
      void showStandaloneStandardView();
    } else {
      showStandaloneMapView();
    }
  }

  function closeModal(){
    const overlay = $('#vOverlay', panelEl); overlay.classList.remove('active');
    const frame = $('#vmFrame', panelEl); frame.src = '';
    clearExtraMarkers();
    cancelInstantWork();
    resetInstantCanvasSurface();
    hideInstantPane();
    renderModalTabs({ showMap: false, showMeasurements: false, activeMainTab: '' });
    renderMeasurementTabs({ show: false });
    renderModalFooter({ show: false });
    setModalTabState('');
    renderSidebarActions({});
    hideFullReportUpgradeDialog();
    modalOpen = false; __modalNonce++;
    currentModalId = null; currentModalGroup = null; currentModalProject = null; currentModalCustomerSave = null;
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail:{ open:false } }));
  }

  function openProject(project, options = {}){
    if (!project) return;
    const normalized = normalizeProjectRecord(project);
    if (options?.preferInstant) normalized._preferInstantOpen = true;
    if (normalized?.id) {
      lastProjectsById.set(String(normalized.id), normalized);
    }
    if (!options?.forceLegacy && window.Portal?.modules?.request?.openProject) {
      closeModal();
      window.Portal.modules.request.openProject(normalized);
      return;
    }
    try{ window.Portal.tabs?.activateTab?.('viewer'); }catch(e){}
    const target = normalized?.id ? (lastProjectsById.get(String(normalized.id)) || normalized) : normalized;
    if (options?.preferInstant) target._preferInstantOpen = true;
    if (!panelEl) {
      setTimeout(() => { if (panelEl) openModal(target); }, 0);
      return;
    }
    openModal(target);
  }

  function openProjectById(id){
    const p = lastProjectsById.get(String(id));
    if (!p) return;
    if (window.Portal?.modules?.request?.openProject) {
      closeModal();
      window.Portal.modules.request.openProject(p);
      return;
    }
    openModal(p);
  }

  function instantReportMarkup(){
    return `
      <div id="vmInstantPane" class="v-instant-pane active">
        <div class="v-instant-scene">
          <div class="v-instant-controls">
            <button type="button" id="vmInstantAuto" class="v-instant-ctrl active">Auto Spin</button>
            <button type="button" id="vmInstantReset" class="v-instant-ctrl"><i class="fas fa-compass"></i> Reset</button>
            <div class="v-instant-zoom"><i class="fas fa-magnifying-glass"></i><input id="vmInstantZoom" type="range" min="0" max="100" step="1" value="50" aria-label="Zoom instant model"></div>
            ${INSTANT_PITCH_UI_ENABLED ? '<button type="button" id="vmInstantPitches" class="v-instant-ctrl active"><i class="fas fa-ruler-combined"></i> Pitches On</button>' : ''}
          </div>
          <canvas id="vmInstantCanvas" class="v-instant-canvas"></canvas>
          <div id="vmInstantLabels" class="v-instant-labels"></div>
          <div id="vmInstantLoading" class="v-instant-loading"><div class="v-instant-loadingIcon"><i class="fas fa-circle-notch fa-spin"></i></div><div class="v-instant-loadingTitle">Instant Report Generating</div></div>
        </div>
        <div id="vmInstantStats" class="v-instant-stats"></div>
      </div>
    `;
  }

  function mountInstantReport(root, project, options = {}){
    if (!root || !project) return;
    cancelInstantWork();
    instantStandaloneOpen = true;
    instantStandaloneNonce += 1;
    instantStandaloneCustomerSave = typeof options.saveCustomer === 'function' ? options.saveCustomer : null;
    instantDomScope = root;
    root.classList.add('v-instant-embed');
    root.style.position = root.style.position || 'relative';
    root.style.height = root.style.height || '100%';
    root.innerHTML = instantReportMarkup();
    const normalized = normalizeProjectRecord(project);
    showInstantPane(normalized);
    void loadInstantForProject(normalized, instantStandaloneNonce, 0);
  }

  function disposeInstantReport(root){
    if (root && instantDomScope && root !== instantDomScope) return;
    cancelInstantWork();
    hideInstantPane();
    if (instantDomScope) instantDomScope.innerHTML = '';
    instantDomScope = null;
    instantStandaloneOpen = false;
    instantStandaloneNonce += 1;
    instantStandaloneCustomerSave = null;
  }

  async function fetchProjects(redraw){
    const results = $('#vResults', panelEl); if (!results) return;
    const requestSeq = ++fetchProjectsSeq;
    try{
      if (redraw && !_optimisticProjects.length){ results.innerHTML = `<div class="v-grid" id="vGrid"><div style="grid-column:1/-1; text-align:center; color:#999; padding:40px 0; font-weight:900;"><i class="fas fa-spinner fa-spin" style="font-size:22px; margin-bottom:10px;"></i><br>Loading projects\u2026</div></div>`; }
      const previousVisibleIds = sortedProjectIds(allProjects);
      const trimmedSearch = String(searchQuery || '').trim();
      const stagesMode = viewMode === 'stages';
      const payload = { page: stagesMode ? 1 : currentPage, limit: stagesMode ? 0 : PAGE_SIZE, status_filter: statusFilter || 'all', include_instant_only: '1', view: 'card', hide_drafts: hideDrafts ? '1' : '0' };
      if (trimmedSearch.length >= 2) payload.search = trimmedSearch;
      const { data } = await postAction('list_projects', payload);
      if (requestSeq !== fetchProjectsSeq) return;
      if (data && data.error === 'Not logged in'){ window.location.href = 'login.php'; return; }
      let projects = Array.isArray(data?.projects) ? data.projects.map(normalizeProjectRecord) : [];
      projects = applyOptimisticProjectUpdates(projects);
      totalUnfilteredCount = Number(data?.unfiltered_count ?? data?.platform_total_count ?? projects.length) || projects.length;
      const pg = data?.pagination;
      if (pg){ totalPages = pg.total_pages || 1; totalCount = pg.total_count || projects.length; if (currentPage > totalPages) currentPage = totalPages; }
      else { totalPages = 1; totalCount = projects.length; }

      /* Merge optimistic stubs: keep any that the server doesn't have yet */
      const serverAddrs = new Set(projects.map(p => normalizeStr(p.address || displayAddressPlain(p))));
      const serverKeys = new Set(projects.flatMap(projectIdentityKeys));
      const now = Date.now();
      const hadOptimistic = _optimisticProjects.length > 0;
      _optimisticProjects = _optimisticProjects.filter(op => {
        /* Expire after 90 seconds regardless */
        if (now - op._optimistic_ts > 90000) return false;
        /* Remove once server has it (match by address or id) */
        if (serverAddrs.has(normalizeStr(op.address || displayAddressPlain(op)))) return false;
        if (projectIdentityKeys(op).some((key) => serverKeys.has(key))) return false;
        return true;
      });
      /* If optimistic stubs were just consumed by real data, force a full
       * redraw so the old __optimistic tiles get replaced with real tiles
       * that have proper thumbnail polling. */
      const optimisticConsumed = hadOptimistic && _optimisticProjects.length === 0;

      /* Prepend surviving optimistic stubs so they show at the top */
      const existingByKey = new Map(allProjects.map(p => [projectStableKey(p), p]));
      const mergedProjects = dedupeProjects(projects.map(p => mergeProjectForRefresh(existingByKey.get(projectStableKey(p)), p)));
      allProjects = dedupeProjects([..._optimisticProjects, ...mergedProjects]);

      lastProjectsById = indexProjectLookups(allProjects);
      const visibleProjectsChanged = !sameProjectOrder(previousVisibleIds, sortedProjectIds(allProjects));

      /* Keep credit balance in sync — rejections reimburse credits,
         other windows may spend credits, etc. */
      try { window.Portal.credits.refreshCredits(); } catch(e){}

      if (!redraw && !optimisticConsumed && !_optimisticProjects.length && !visibleProjectsChanged){
        patchBadges(mergedProjects);
        updateOpenModalFromLatest(mergedProjects);
        renderPagination();
        updateCount();
        hydrateProjectsForDisplay(mergedProjects);
        return;
      }
      applyQueryFilterSort(); renderPagination();
      hydrateProjectsForDisplay(allProjects);
    }catch(e){ if (redraw){ results.innerHTML = `<div style="text-align:center; color:var(--primary-readable, var(--primary,#d93025)); font-weight:1000; padding:40px 0;">Error loading projects.</div>`; } }
  }

  function mount(panel){
    panelEl = panel;
    injectCSS('viewer', ViewerCSS);
    injectSidebarLogout();
    viewMode = loadPersistedView();
    enforceDraftsHidden();

    panelEl.innerHTML = `
      <div class="v-wrap">
        <div class="v-head">
          <div class="v-title"><h1>My Projects</h1><p class="sub">Search, filter, and open reports.</p></div>
          <div class="v-actions">
            <div class="v-searchwrap">
              <i class="fas fa-magnifying-glass v-searchicon"></i>
              <input id="vSearch" class="v-search" type="text" placeholder="Search address, contact\u2026">
              <div class="v-clear" id="vClear" data-fm-tooltip="Clear"><i class="fas fa-times"></i></div>
              <div class="v-suggest" id="vSuggest"></div>
            </div>
            <button class="v-btn v-pill" id="vViewTiles"><i class="fas fa-grip"></i><span class="btn-label"> Tiles</span></button>
            <button class="v-btn v-pill" id="vViewList"><i class="fas fa-list"></i><span class="btn-label"> List</span></button>
            <button class="v-btn v-pill" id="vViewStages" hidden><i class="fas fa-table-columns"></i><span class="btn-label"> Stages</span></button>
            <button class="v-btn" id="vRefresh"><i class="fas fa-sync-alt"></i><span class="btn-label"> Refresh</span></button>
          </div>
        </div>
        <div class="v-bar">
          <div class="v-leftbar">
            <div class="v-chip"><i class="fas fa-filter"></i><select id="vStatus"><option value="all">All statuses</option><option value="ready">Ready</option><option value="processing">Processing</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></div>
            <div class="v-chip"><i class="fas fa-arrow-up-wide-short"></i><select id="vSort"><option value="created_at:desc">Newest first</option><option value="created_at:asc">Oldest first</option><option value="address:asc">Address A \u2192 Z</option><option value="address:desc">Address Z \u2192 A</option><option value="resident:asc">Contact A \u2192 Z</option><option value="resident:desc">Contact Z \u2192 A</option><option value="status:asc">Status A \u2192 Z</option><option value="status:desc">Status Z \u2192 A</option></select></div>
            <div class="v-count" id="vCount">\u2014</div>
          </div>
          <div class="v-rightbar"><div class="v-tip" id="vTip">Tip: Click a column header to sort.</div></div>
        </div>
        <div id="vResults"><div class="v-grid" id="vGrid"><div style="grid-column:1/-1; text-align:center; color:#999; padding:40px 0; font-weight:900;"><i class="fas fa-spinner fa-spin" style="font-size:22px; margin-bottom:10px;"></i><br>Loading projects\u2026</div></div></div>
        <div id="vPagination" class="v-pagination"></div>
      </div>
      <div class="v-overlay" id="vOverlay">
        <div class="v-modal" role="dialog" aria-modal="true">
          <div class="v-m-side">
            <div class="v-m-head"><div class="v-m-title" id="vmAddress">\u2014</div><div class="v-m-status" id="vmStatus">\u2014</div></div>
            <div class="v-m-body">
              <div class="v-item"><div class="v-k">Requested By</div><div class="v-v" id="vmIssuer">\u2014</div><div class="v-v" id="vmIssuerEmail" style="font-size:12px; color:#666;"></div></div>
              <div class="v-item"><div class="v-k">Submitted</div><div class="v-v" id="vmDate">\u2014</div></div>
              <div class="v-item" id="vmTypeItem" style="display:none;"><div class="v-k">Project Type</div><div class="v-v" id="vmType">\u2014</div></div>
              <div class="v-item" id="vmScopeItem" style="display:none;"><div class="v-k">Report Scope</div><div class="v-v" id="vmScope">\u2014</div></div>
              <div class="v-item" id="vmCcItem" style="display:none;"><div class="v-k">CC Recipients</div><div class="v-v" id="vmCcEmails">\u2014</div></div>
              <div class="v-item" id="vmTechNotesItem" style="display:none;"><div class="v-k">Notes for Technician</div><div class="v-v" id="vmTechNotes" style="white-space:pre-wrap; font-size:12px; line-height:1.45; color:#333; background:#f8f9fa; padding:10px 12px; border-radius:10px; border:1px solid rgba(0,0,0,0.06);">\u2014</div></div>
              <div class="v-item"><label class="v-k" for="vmCustomerName">Contact Name</label><input id="vmCustomerName" class="v-customerInput" type="text" placeholder="Jane Smith"></div>
              <div class="v-item"><label class="v-k" for="vmCustomerEmail">Contact Email</label><input id="vmCustomerEmail" class="v-customerInput" type="email" placeholder="jane@example.com"></div>
              <div class="v-item"><label class="v-k" for="vmCustomerPhone">Contact Phone</label><input id="vmCustomerPhone" class="v-customerInput" type="text" placeholder="(555) 555-5555"></div>
              <div class="v-item v-customerRow"><button type="button" id="vmCustomerSave" class="v-customerSave">Save</button></div>
            </div>
            <div class="v-m-foot">
              <div id="vmSideActions" class="v-side-actions"></div>
              <div id="vmSidePop" class="v-side-pop"></div>
              <div class="v-dlwrap">
                <a href="#" target="_blank" class="v-dlbtn" id="vmDlReport" style="display:none;"><i class="fas fa-file-pdf"></i> Download Report (PDF)</a>
                <a href="#" target="_blank" class="v-dlbtn secondary" id="vmDlSummary" style="display:none;"><i class="fas fa-file-lines"></i> Download Customer PDF</a>
                <a href="#" target="_blank" class="v-dlbtn secondary" id="vmDlXml" style="display:none;"><i class="fas fa-code"></i> Download XML Model</a>
              </div>
            </div>
          </div>
          <div class="modal-close-x" id="vmX" data-fm-tooltip="Close"><i class="fas fa-times"></i></div>
          <div class="v-m-frame">
            <div id="vmTabs" class="v-report-tabs"></div>
            <div id="vmFrameStage" class="v-frame-stage">
              <div id="vmMeasureTabs" class="v-measure-tabs"></div>
              <iframe id="vmFrame" src=""></iframe>
              <div id="vmMapCanvas"></div>
              <div id="vmInstantPane" class="v-instant-pane">
                <div class="v-instant-scene">
                  <div class="v-instant-controls">
                    <button type="button" id="vmInstantAuto" class="v-instant-ctrl active">Auto Spin</button>
                    <button type="button" id="vmInstantReset" class="v-instant-ctrl"><i class="fas fa-compass"></i> Reset</button>
                    <div class="v-instant-zoom"><i class="fas fa-magnifying-glass"></i><input id="vmInstantZoom" type="range" min="0" max="100" step="1" value="50" aria-label="Zoom instant model"></div>
                    ${INSTANT_PITCH_UI_ENABLED ? '<button type="button" id="vmInstantPitches" class="v-instant-ctrl active"><i class="fas fa-ruler-combined"></i> Pitches On</button>' : ''}
                  </div>
                  <canvas id="vmInstantCanvas" class="v-instant-canvas"></canvas>
                  <div id="vmInstantLabels" class="v-instant-labels"></div>
                  <div id="vmInstantLoading" class="v-instant-loading"><div class="v-instant-loadingIcon"><i class="fas fa-circle-notch fa-spin"></i></div><div class="v-instant-loadingTitle">Generating</div></div>
                </div>
                <div id="vmInstantStats" class="v-instant-stats"></div>
              </div>
              <div id="vmPending" class="pending-overlay"></div>
            </div>
            <div id="vmFrameFooter" class="v-frame-footer" style="display:none;">
              <div id="vmFooterLeft" class="v-frame-footerLeft"></div>
              <div id="vmFooterRight" class="v-frame-footerRight"></div>
              <div id="vmFooterPop" class="v-footer-pop"></div>
            </div>
            <div id="vmUpgradeOverlay" class="v-upgrade-overlay">
              <div id="vmUpgradeDialog" class="v-upgrade-dialog" role="dialog" aria-modal="true" aria-label="Order standard report"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#vRefresh', panelEl)?.addEventListener('click', ()=>{ currentPage = 1; fetchProjects(true); });
    $('#vViewTiles', panelEl)?.addEventListener('click', ()=>setView('tiles'));
    $('#vViewList', panelEl)?.addEventListener('click', ()=>setView('list'));
    $('#vViewStages', panelEl)?.addEventListener('click', ()=>setView('stages'));
    window.addEventListener('fm:app-flags:updated', applyStagesViewFlag);
    window.addEventListener('fm:app-flags:failed', applyStagesViewFlag);
    const statusSel = $('#vStatus', panelEl);
    statusSel?.addEventListener('change', ()=>{
      statusFilter = statusSel.value || 'all';
      enforceDraftsHidden();
      currentPage = 1;
      fetchProjects(true);
    });
    const sortSel = $('#vSort', panelEl);
    sortSel?.addEventListener('change', ()=>{ const val = String(sortSel.value||'created_at:desc'); const parts = val.split(':'); setActiveSort(parts[0] || 'created_at', parts[1] || 'desc'); });
    const input = $('#vSearch', panelEl); const clear = $('#vClear', panelEl);
    input?.addEventListener('input', ()=> setSearch(input.value, false));
    input?.addEventListener('focus', ()=> { if (input.value) showSuggest(); });
    input?.addEventListener('keydown', (e)=>{ if (e.key === 'Escape'){ hideSuggest(); input.blur(); } if (e.key === 'Enter'){ hideSuggest(); const items = buildSuggestions(8); if (items.length === 1){ const p = lastProjectsById.get(String(items[0].id)); if (p) openModal(p); } } });
    input?.addEventListener('blur', ()=>{ setTimeout(()=>{ if (!document.activeElement || document.activeElement !== input) hideSuggest(); }, 120); });
    clear?.addEventListener('click', ()=>{ setSearch('', true); hideSuggest(); input?.focus(); });
    document.addEventListener('click', (e)=>{ if (!panelEl) return; const sw = panelEl.querySelector('.v-searchwrap'); if (!sw) return; if (sw.contains(e.target)) return; hideSuggest(); }, { passive:true });
    const overlay = $('#vOverlay', panelEl);
    $('#vmX', panelEl).addEventListener('click', closeModal);
    enableSafeBackdropClose(overlay, closeModal);
    document.getElementById('vmUpgradeOverlay')?.addEventListener('click', (event) => {
      if (event.target?.id === 'vmUpgradeOverlay') hideFullReportUpgradeDialog();
    });
    document.getElementById('vmUpgradeDialog')?.addEventListener('click', (event) => event.stopPropagation());
    setView(viewMode); syncSortDropdown();
    fetchProjects(true);
    pollTimer = setInterval(()=>{ fetchProjects(false); }, 60000);
  }

  window.Portal.instantReports = {
    mount: mountInstantReport,
    dispose: disposeInstantReport
  };
  window.Portal.modules = window.Portal.modules || {};
  window.Portal.modules.viewer = { refresh: (redraw=true)=>fetchProjects(!!redraw), openProjectById, openProject };

  /* After a submit/refresh event, do a burst of fast re-polls so the
   * user sees the new project appear and its status update quickly. */
  let _burstTimers = [];
  function scheduleBurstPolls(){
    _burstTimers.forEach(t => clearTimeout(t));
    _burstTimers = [];
    const delays = [4000, 8000, 15000, 25000, 40000];
    for (const d of delays){
      _burstTimers.push(setTimeout(() => fetchProjects(false), d));
    }
  }

  window.addEventListener('fm:projects:refresh', (e)=>{
    const redraw = e?.detail?.redraw ?? false;
    fetchProjects(!!redraw && !allProjects.length);
    scheduleBurstPolls();
  });

  window.addEventListener('fm:projects:open', (e)=>{
    const project = e?.detail?.project;
    if (!project) return;
    openProject(project, { preferInstant: !!e?.detail?.preferInstant });
  });

  window.addEventListener('fm:projects:optimistic-update', (e)=>{
    const project = e?.detail?.project;
    if (!project) return;
    upsertProjectForViewer(project, { redraw: e?.detail?.redraw !== false });
  });

  /* Optimistic add: request.js fires this with form data so the tile
   * appears instantly, before the server round-trip completes. */
  window.addEventListener('fm:projects:optimistic-add', (e)=>{
    const d = e?.detail;
    if (!d || !d.address) return;

    const comps = (() => { try { return JSON.parse(d.address_components || '{}'); } catch(e) { return {}; } })();
    const pins  = (() => { try { return JSON.parse(d.pins || '[]'); } catch(e) { return []; } })();
    const ccArr = (() => { try { return JSON.parse(d.cc_emails || '[]'); } catch(e) { return []; } })();

    const stub = {
      id: '__optimistic_' + Date.now(),
      address: d.address,
      components: comps,
      lat: d.lat || 0,
      lng: d.lng || 0,
      status: 'queued',
      workflow_state: 'measurement_ordered',
      has_report: false,
      thumbnail: null,
      project_type: d.project_type || 'residential',
      resident: d.residentName || '',
      resident_email: d.residentEmail || '',
      resident_phone: d.residentPhone || '',
      issuer: d.issuerName || '',
      issuer_email: d.issuerEmail || '',
      created_at: new Date().toISOString().replace('T',' ').slice(0,19),
      pins: pins,
      cc_emails: ccArr,
      include_gutter_measurements: d.include_gutter_measurements,
      tech_notes: d.tech_notes || '',
      _optimistic: true,
      _optimistic_ts: Date.now(),
    };

    _optimisticProjects.push(normalizeProjectRecord(stub));
    allProjects = [..._optimisticProjects, ...allProjects.filter(p => !p._optimistic)];
    lastProjectsById.set(String(stub.id), normalizeProjectRecord(stub));
    applyQueryFilterSort();
    renderPagination();
  });
  window.Portal.apps.registerPortalApp({ id: 'portal.viewer', tabId: 'viewer', title: 'My Projects', icon: 'fa-folder-open', order: 10, mount, onShow: ()=>{ try{ injectSidebarLogout(); }catch(e){} } });
  try{ injectCSS('viewer', ViewerCSS); }catch(e){}
  try{ injectSidebarLogout(); }catch(e){}
})();
