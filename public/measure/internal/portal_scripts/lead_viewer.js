(function () {
  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtTs(ts) {
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleString() : "-";
  }
  function fmtTsMinute(ts) {
    const n = Number(ts || 0);
    return n
      ? new Date(n * 1000).toLocaleString([], {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "-";
  }
  function fmtDay(ts) {
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleDateString() : "-";
  }
  function defaultFollowupDate() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function isoDateForOffset(days) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + Number(days || 0));
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const FOLLOWUP_DURATION_OPTIONS = [15, 30, 45, 60, 90, 120];
  const SMS_TEMPLATE_OPTIONS = [
    {
      value: "follow_up",
      label: "Follow Up",
      body: "Hi, this is FirstMate following up on your estimate request.",
    },
    {
      value: "check_in",
      label: "Checking In",
      body: "Hi, just checking in to see if you had any questions for us.",
    },
    {
      value: "call_back",
      label: "Call Back",
      body: "Hi, I missed you. What time works best for a quick call back today?",
    },
  ];
  const EMAIL_TEMPLATE_OPTIONS = [
    {
      id: "dm_info",
      name: "DM Info",
      subject: "First Mate info for {{company}}",
      body: "Hi {{contact_name}},\n\nHere is the quick First Mate overview we discussed. We provide aerial roof measurement reports with same-day turnaround and simple pricing.\n\nResidential reports start at $7 and commercial reports start at $12.\n\nLet me know if you want me to send a sample report or walk through how teams are using it today.\n\n{{rep_name}}\nFirst Mate",
    },
    {
      id: "general_info",
      name: "General Info",
      subject: "Quick First Mate overview",
      body: "Hi {{contact_name}},\n\nThanks for taking the time today. First Mate gives you fast aerial roof measurement reports without the long turnaround or annual contract.\n\nIf helpful, I can send pricing details and a sample report next.\n\n{{rep_name}}\nFirst Mate",
    },
    {
      id: "sign_up",
      name: "Sign Up",
      subject: "Getting started with First Mate",
      body: "Hi {{contact_name}},\n\nGreat speaking with you. Here is the sign-up path we discussed so you can get started with First Mate right away.\n\nReply here with any questions and I can help you get your first order in.\n\n{{rep_name}}\nFirst Mate",
    },
    {
      id: "pre_signup_fu",
      name: "Pre-Signup F/U",
      subject: "Following up on First Mate",
      body: "Hi {{contact_name}},\n\nWanted to follow up on our conversation about First Mate. If you would like, I can send over a sample report or a quick pricing comparison for your current workflow.\n\n{{rep_name}}\nFirst Mate",
    },
    {
      id: "post_signup_fu",
      name: "Post-Signup F/U",
      subject: "Checking in after sign up",
      body: "Hi {{contact_name}},\n\nChecking in to make sure everything is going smoothly after sign up. If you want help placing the next order or inviting teammates, I am happy to help.\n\n{{rep_name}}\nFirst Mate",
    },
  ];
  const FOLLOWUP_WINDOW_PRESETS = {
    morning: { start: "07:00", end: "12:00", label: "Morning", title: "Morning Follow-Up" },
    afternoon: { start: "12:00", end: "17:00", label: "Afternoon", title: "Afternoon Follow-Up" },
  };
  const CALENDAR_DAY_TOTAL_MINUTES = 24 * 60;
  const CALENDAR_DAY_HOUR_HEIGHT = 56;
  const CALENDAR_DAY_MIN_EVENT_HEIGHT = 24;
  const CALENDAR_DAY_OVERLAP_PEEK = 8;
  const COMPANY_RECIPIENT_ID = "__company__";
  function fmtDurationSeconds(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return "-";
    const mins = Math.floor(n / 60);
    const secs = Math.floor(n % 60);
    if (mins <= 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }
  function titleCaseWords(value) {
    return String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  function normalizeCommStatus(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ");
  }
  function humanizeCommStatus(value) {
    return titleCaseWords(normalizeCommStatus(value));
  }
  function emailReadStatus(meta, direction) {
    if (String(direction || "").toLowerCase() === "out") return "Sent";
    const explicit = humanizeCommStatus(meta?.read_status);
    if (explicit) return explicit;
    const labelIds = Array.isArray(meta?.gmail_label_ids)
      ? meta.gmail_label_ids
          .map((label) => String(label || "").trim().toUpperCase())
          .filter(Boolean)
      : [];
    if (!labelIds.length) return "";
    return labelIds.includes("UNREAD") ? "Unread" : "Read";
  }
  function smsStatusSummary(meta, direction) {
    const parts = [];
    const readStatus = humanizeCommStatus(meta?.read_status);
    const messageStatus = humanizeCommStatus(meta?.message_status);
    if (String(direction || "").toLowerCase() === "in") {
      parts.push("Received");
      if (readStatus && readStatus !== "Received") parts.push(readStatus);
    } else {
      parts.push(messageStatus || "Sent");
      if (readStatus && readStatus !== parts[0]) parts.push(readStatus);
    }
    return Array.from(new Set(parts.filter(Boolean))).join(" | ");
  }
  function callStatusSummary(item) {
    const parts = [];
    const direction = String(item?.context?.direction || item?.direction || "")
      .trim()
      .toLowerCase();
    if (direction === "inbound" || direction === "in") parts.push("Inbound");
    else if (direction === "outbound" || direction === "out")
      parts.push("Outbound");
    const disposition = String(item?.context?.disposition || "").trim();
    if (disposition) parts.push(disposition);
    else {
      const action = humanizeCommStatus(item?.context?.action);
      const result = humanizeCommStatus(item?.context?.result);
      if (action) parts.push(action);
      if (result && result !== action) parts.push(result);
    }
    return Array.from(new Set(parts.filter(Boolean))).join(" | ");
  }
  function crmSettingsForLead(lead) {
    const leadSettings =
      lead?.crm?.settings && typeof lead.crm.settings === "object"
        ? lead.crm.settings
        : {};
    const liveSettings =
      window.CrmSettingsTab &&
      typeof window.CrmSettingsTab.getCurrentSettings === "function"
        ? window.CrmSettingsTab.getCurrentSettings()
        : null;
    if (!liveSettings || typeof liveSettings !== "object") return leadSettings;
    return {
      ...leadSettings,
      sms_templates:
        Array.isArray(liveSettings.sms_templates) &&
        liveSettings.sms_templates.length
          ? liveSettings.sms_templates
          : leadSettings.sms_templates,
      email_templates:
        Array.isArray(liveSettings.email_templates) &&
        liveSettings.email_templates.length
          ? liveSettings.email_templates
          : leadSettings.email_templates,
      call_dispositions:
        Array.isArray(liveSettings.call_dispositions) &&
        liveSettings.call_dispositions.length
          ? liveSettings.call_dispositions
          : leadSettings.call_dispositions,
    };
  }
  function smsTemplateOptionsForLead(lead) {
    const configured = Array.isArray(crmSettingsForLead(lead).sms_templates)
      ? crmSettingsForLead(lead).sms_templates
      : [];
    const templates = (configured.length ? configured : SMS_TEMPLATE_OPTIONS).map(
      (item) => ({
        value: String(item?.id || item?.value || ""),
        label: String(item?.name || item?.label || "Template"),
        body: String(item?.body || ""),
      }),
    );
    return [{ value: "", label: "Template...", body: "" }, ...templates];
  }
  function emailTemplateOptionsForLead(lead) {
    const configured = Array.isArray(crmSettingsForLead(lead).email_templates)
      ? crmSettingsForLead(lead).email_templates
      : [];
    return (configured.length ? configured : EMAIL_TEMPLATE_OPTIONS).map((item) => ({
      id: String(item?.id || item?.name || ""),
      name: String(item?.name || item?.label || "Template"),
      subject: String(item?.subject || ""),
      body: String(item?.body || ""),
    }));
  }
  function callDispositionOptionsForLead(lead) {
    const configured = Array.isArray(crmSettingsForLead(lead).call_dispositions)
      ? crmSettingsForLead(lead).call_dispositions
      : [];
    return configured
      .map((item) => String(item?.label || item?.name || "").trim())
      .filter(Boolean);
  }
  function applyEmailTemplateVars(templateText, vars) {
    return String(templateText || "").replace(/\{\{\s*(company|company_name|contact_name|contact_first_name|rep_name|sender_name|sender_phone|sender_email|lead_name|list_name)\s*\}\}/gi, (_, key) => {
      const normalized = String(key || "").toLowerCase();
      return String(vars?.[normalized] || "");
    });
  }
  function normalizePhone(value) {
    return String(value || "").replace(/\D+/g, "");
  }
  function normalizeUsPhoneDigits(value) {
    let digits = normalizePhone(value);
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return digits.slice(0, 10);
  }
  function formatUsPhone(value) {
    const digits = normalizeUsPhoneDigits(value);
    if (!digits) return "";
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    }
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  function phoneCaretFromDigits(formattedValue, digitCount) {
    if (digitCount <= 0) return 0;
    let seen = 0;
    for (let i = 0; i < formattedValue.length; i += 1) {
      if (/\d/.test(formattedValue.charAt(i))) {
        seen += 1;
        if (seen >= digitCount) return i + 1;
      }
    }
    return formattedValue.length;
  }
  function applyPhoneFormattingToInput(input) {
    if (!(input instanceof HTMLInputElement)) return "";
    const rawValue = String(input.value || "");
    const selectionStart = typeof input.selectionStart === "number" ? input.selectionStart : rawValue.length;
    const digitsBeforeCaret = normalizeUsPhoneDigits(rawValue.slice(0, selectionStart)).length;
    const formatted = formatUsPhone(rawValue);
    if (formatted !== rawValue) {
      input.value = formatted;
      const caret = phoneCaretFromDigits(formatted, digitsBeforeCaret);
      try {
        input.setSelectionRange(caret, caret);
      } catch (_) {}
    }
    return formatted;
  }
  function fmtUsd(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return "$0";
    return `$${Math.round(amount).toLocaleString()}`;
  }
  function fmtUsdPrecise(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return "$0.00";
    return `$${amount.toFixed(2)}`;
  }
  function fmtAgeFromTs(ts) {
    const n = Number(ts || 0);
    if (!n) return "-";
    const diffDays = Math.max(
      0,
      Math.floor((Date.now() - n * 1000) / 86400000),
    );
    if (diffDays < 1) return "Today";
    if (diffDays === 1) return "1 day";
    if (diffDays < 30) return `${diffDays} days`;
    const months = Math.floor(diffDays / 30);
    if (months < 12) return months === 1 ? "1 month" : `${months} months`;
    const years = Math.floor(months / 12);
    return years === 1 ? "1 year" : `${years} years`;
  }
  const STATE_NAME_TO_CODE = {
    alabama: "AL",
    alaska: "AK",
    arizona: "AZ",
    arkansas: "AR",
    california: "CA",
    colorado: "CO",
    connecticut: "CT",
    delaware: "DE",
    florida: "FL",
    georgia: "GA",
    hawaii: "HI",
    idaho: "ID",
    illinois: "IL",
    indiana: "IN",
    iowa: "IA",
    kansas: "KS",
    kentucky: "KY",
    louisiana: "LA",
    maine: "ME",
    maryland: "MD",
    massachusetts: "MA",
    michigan: "MI",
    minnesota: "MN",
    mississippi: "MS",
    missouri: "MO",
    montana: "MT",
    nebraska: "NE",
    nevada: "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    ohio: "OH",
    oklahoma: "OK",
    oregon: "OR",
    pennsylvania: "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    tennessee: "TN",
    texas: "TX",
    utah: "UT",
    vermont: "VT",
    virginia: "VA",
    washington: "WA",
    "west virginia": "WV",
    wisconsin: "WI",
    wyoming: "WY",
    "district of columbia": "DC",
  };
  const STATE_TIME_ZONES = {
    AL: "America/Chicago",
    AK: "America/Anchorage",
    AZ: "America/Phoenix",
    AR: "America/Chicago",
    CA: "America/Los_Angeles",
    CO: "America/Denver",
    CT: "America/New_York",
    DE: "America/New_York",
    FL: "America/New_York",
    GA: "America/New_York",
    HI: "Pacific/Honolulu",
    ID: "America/Denver",
    IL: "America/Chicago",
    IN: "America/Indiana/Indianapolis",
    IA: "America/Chicago",
    KS: "America/Chicago",
    KY: "America/New_York",
    LA: "America/Chicago",
    ME: "America/New_York",
    MD: "America/New_York",
    MA: "America/New_York",
    MI: "America/New_York",
    MN: "America/Chicago",
    MS: "America/Chicago",
    MO: "America/Chicago",
    MT: "America/Denver",
    NE: "America/Chicago",
    NV: "America/Los_Angeles",
    NH: "America/New_York",
    NJ: "America/New_York",
    NM: "America/Denver",
    NY: "America/New_York",
    NC: "America/New_York",
    ND: "America/Chicago",
    OH: "America/New_York",
    OK: "America/Chicago",
    OR: "America/Los_Angeles",
    PA: "America/New_York",
    RI: "America/New_York",
    SC: "America/New_York",
    SD: "America/Chicago",
    TN: "America/Chicago",
    TX: "America/Chicago",
    UT: "America/Denver",
    VT: "America/New_York",
    VA: "America/New_York",
    WA: "America/Los_Angeles",
    WV: "America/New_York",
    WI: "America/Chicago",
    WY: "America/Denver",
    DC: "America/New_York",
  };
  function resolveLeadStateCode(lead) {
    const raw = String(lead?.state || lead?.region_code || "").trim();
    if (!raw) return "";
    const upper = raw.toUpperCase();
    if (/^[A-Z]{2}$/.test(upper)) return upper;
    return STATE_NAME_TO_CODE[raw.toLowerCase()] || "";
  }
  function formatTimeInfo(timeZone) {
    if (!timeZone) return null;
    try {
      const dtf = new Intl.DateTimeFormat([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
        timeZoneName: "short",
      });
      const parts = dtf.formatToParts(new Date());
      const get = (type) =>
        parts.find((part) => part.type === type)?.value || "";
      const time =
        `${get("hour")}${get("literal") || ":"}${get("minute")}`.trim();
      const abbrev = get("timeZoneName") || timeZone;
      return {
        timeZone,
        time,
        abbreviation: abbrev,
        label: `${time} (${abbrev})`,
      };
    } catch (err) {
      return null;
    }
  }
  function getLeadTimeInfo(lead) {
    const explicitTimeZone = [
      lead?.time_zone,
      lead?.timezone,
      lead?.metadata?.time_zone,
      lead?.metadata?.timezone,
    ]
      .map((value) => String(value || "").trim())
      .find(Boolean);
    if (explicitTimeZone) {
      const direct = formatTimeInfo(explicitTimeZone);
      if (direct) {
        return {
          ...direct,
          stateCode: resolveLeadStateCode(lead),
          source: "explicit",
        };
      }
    }
    const stateCode = resolveLeadStateCode(lead);
    const timeZone = STATE_TIME_ZONES[stateCode] || "";
    const info = formatTimeInfo(timeZone);
    if (!info) return null;
    return { ...info, stateCode, source: stateCode ? "state" : "" };
  }
  function getViewerTimeInfo() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return formatTimeInfo(zone);
  }
  function buildDialerUrl(leadId) {
    const base =
      window.Portal?.cfg?.endpoints?.lead_callback ||
      window.LEAD_VIEWER_CFG?.lead_callback ||
      "lead_callback.php";
    const url = new URL(base, window.location.href);
    url.searchParams.set("lead_id", String(leadId || ""));
    url.searchParams.set("source", "orum");
    return url.toString();
  }
  function canSeeOrumLink(opts) {
    if (typeof opts?.allowCallbackLink === "boolean")
      return opts.allowCallbackLink;
    const caps = window.Portal?.cfg?.capabilities || {};
    return !!caps.manage_sales_users || !!(window.Portal?.cfg?.perms || {}).sales_view_orum_history || !!(window.Portal?.cfg?.perms || {}).sales_import_daily_orum_csv;
  }
  function ensureStyles() {
    if (document.getElementById("sharedLeadViewerStyles")) return;
    const style = document.createElement("style");
    style.id = "sharedLeadViewerStyles";
    style.textContent = `      .lead-viewer-shell{display:grid;gap:14px}      .lead-viewer-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}      .lead-viewer-head-main{display:grid;gap:4px;min-width:0;flex:1 1 420px}      .lead-viewer-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}      .lead-viewer-title h1,.lead-viewer-title h2{margin:0;font-size:28px;font-weight:900;color:#233246}      .lead-time-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #d7dee9;border-radius:999px;padding:7px 11px;background:#fff;font-size:12px;font-weight:800;color:#314154}      .lead-time-chip i{color:#d93025}      .lead-viewer-sub{margin-top:4px;font-size:12px;color:#677283}      .lead-viewer-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;flex:0 1 auto;margin-left:auto}      .lead-viewer-action-compact{font-size:12px;padding:7px 10px}      .lead-viewer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}      .lead-field{background:#f7f9fc;border:1px solid #e7ebf2;border-radius:10px;padding:8px 10px;min-height:54px}      .lead-field .k{font-size:11px;font-weight:900;color:#6c7685;text-transform:uppercase}      .lead-field .v{margin-top:4px;font-size:12px;color:#223040;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}      .lead-field.address .v{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}      .lead-field.actionable .v{display:flex;align-items:center;gap:8px;flex-wrap:wrap}      .lead-field-split{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}      .lead-metric{display:inline-flex;gap:4px;align-items:baseline}      .lead-metric-label{font-size:10px;font-weight:900;color:#6c7685;text-transform:uppercase;letter-spacing:.03em}      .lead-metric-value{font-size:13px;font-weight:800;color:#223040}      .lead-section{border:1px solid #e7ebf2;border-radius:14px;background:#fff;overflow:hidden}      .lead-section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;background:#fbfcfe;border-bottom:1px solid #eef1f5;cursor:pointer}      .lead-section-head h3{margin:0;font-size:13px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#5f6b7b}      .lead-section-head .meta{font-size:11px;color:#7a8594;font-weight:700}      .lead-section-head-right{display:flex;align-items:center;gap:8px}      .lead-section-head .toggle{border:none;background:none;font-size:14px;color:#7a8594;cursor:pointer}      .lead-section-body{padding:14px}      .lead-section.collapsed .lead-section-body{display:none}      .lead-actions{display:flex;gap:8px;flex-wrap:wrap}      .lead-actions-inline{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}      .lead-panel-input,.lead-panel-textarea{        width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cfd5df;border-radius:9px;background:#fff;font:inherit;font-size:13px;line-height:1.35;      }      .lead-panel-textarea{resize:vertical;min-height:76px}      .lead-quick-buttons{display:flex;gap:6px;flex-wrap:wrap}      .lead-quick-btn{border:1px solid #d8dee8;background:#fff;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:800;color:#46556a;cursor:pointer}      .lead-quick-btn.active{background:#d93025;border-color:#d93025;color:#fff}      .lead-contact-row{display:flex;gap:10px;overflow:auto;padding-bottom:2px}      .lead-contact-card{min-width:220px;max-width:260px;border:1px solid #e4e8ef;border-radius:12px;background:#fafcff;padding:10px;display:grid;gap:8px}      .lead-contact-card.active{border-color:#d93025;box-shadow:0 0 0 2px rgba(217,48,37,.12)}      .lead-contact-name{font-size:14px;font-weight:900;color:#243041}      .lead-contact-sub{font-size:12px;color:#5a6677}      .lead-contact-note-list{display:grid;gap:6px;max-height:118px;overflow:auto}      .lead-contact-note-item{border:none;border-radius:0;background:transparent;padding:0;font-size:11px;line-height:1.35;color:#445163}      .lead-contact-note-item .meta{font-size:10px;color:#7a8594;margin-bottom:0;max-height:0;opacity:0;overflow:hidden;transition:opacity .15s ease,max-height .15s ease,margin-bottom .15s ease}      .lead-contact-note-item:hover .meta{opacity:1;max-height:40px;margin-bottom:4px}      .lead-contact-form{display:grid;gap:10px;margin-top:12px}      .lead-contact-form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}      .lead-contact-form-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}      .lead-note-list,.lead-followup-list,.lead-call-list{display:grid;gap:10px}      .lead-note-item,.lead-followup-item,.lead-call-item{border:1px solid #e7ebf2;border-radius:12px;background:#fafcff;padding:10px 12px}      .lead-note-item .meta,.lead-followup-item .meta,.lead-call-item .meta{font-size:11px;color:#6b7583;margin-bottom:6px}      .lead-note-item.imported{border-color:#f3d7b5;background:#fffaf3}      .lead-call-summary{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:#243041;font-size:13px;font-weight:700}      .lead-call-summary .sep{color:#9aa3af}      .lead-call-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:10px}      .lead-call-field{background:#fff;border:1px solid #eceff4;border-radius:10px;padding:8px}      .lead-call-field .k{font-size:10px;color:#7a8594;font-weight:900;text-transform:uppercase}      .lead-call-field .v{margin-top:4px;font-size:12px;color:#243041;word-break:break-word}      .lead-field-foot{margin-top:6px;font-size:10px;color:#7a8594}      .lead-email-edit{display:flex;gap:8px;align-items:center;flex-wrap:wrap}      .lead-inline-form{display:grid;gap:8px}      .lead-inline-form-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}      .lead-history-details{margin-top:10px}      .lead-history-details summary{cursor:pointer;color:#6a7483;font-size:12px;font-weight:800}      .lead-btn-subtle{border:1px solid #dde3eb;background:#fff;color:#687588;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer}      .lead-btn-subtle:hover{border-color:#c9d2de;color:#4a5563}      .lead-followup-main{flex:1;min-width:0}      .lead-followup-due-row{display:flex;gap:8px;align-items:center;justify-content:flex-start;flex-wrap:wrap}      .lead-followup-due-row .lead-panel-input{max-width:220px}      .lead-history-raw{margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}      .lead-subsection{border:1px solid #e7ebf2;border-radius:12px;background:#fff;overflow:hidden}      .lead-subsection > summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;background:#fbfcfe;border-bottom:1px solid #eef1f5;font-size:13px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#5f6b7b}      .lead-subsection > summary::-webkit-details-marker{display:none}      .lead-subsection-body{padding:0}      .lead-empty{padding:18px 0;color:#8a93a0;text-align:center;font-style:italic}      .lead-inline-status{font-size:11px;font-weight:800;color:#7a8594}      .lead-inline-status.saved{color:#137333}      .lead-inline-status.saving{color:#0b57d0}      .lead-inline-status.error{color:#b42318}      .lead-page-v5-root{--red:#d93025;--rd:#a1241c;--rl:#fce8e6;--s9:#1a1f2e;--s8:#252b3b;--s7:#3a4255;--s6:#4d566b;--s5:#6b7588;--s4:#8b95a8;--s3:#b0b8c9;--s2:#d4dae6;--s1:#edf0f5;--s0:#f6f8fb;--w:#fff;--g:#1a8a4a;--gl:#e6f4ec;--o:#c4700a;--ol:#fef3e0;--b:#1a6bd9;--bl:#e8f0fe;--p:#7c3aed;--pl:#f3e8ff;--r:10px;--rs:6px;--rl2:14px;font-family:'DM Sans','Segoe UI',system-ui,sans-serif;color:var(--s9);display:grid;gap:0}      .lead-page-v5-root *, .lead-page-v5-root *::before, .lead-page-v5-root *::after{box-sizing:border-box}      .lead-page-v5-root a{text-decoration:none}      .lead-page-v5-topbar{background:var(--w);border-bottom:1px solid var(--s2);padding:8px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:60}      .lead-page-v5-topbar-left{display:flex;align-items:center;gap:14px}      .lead-page-v5-logo{font-weight:900;font-size:15px;color:var(--red)}      .lead-page-v5-logo span{color:var(--s5);font-weight:500}      .lead-page-v5-back{color:var(--s5);border:1px solid var(--s2);background:var(--w);border-radius:var(--rs);padding:5px 10px;font-weight:700;font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer}      .lead-page-v5-back:hover{background:var(--s0)}      .lead-page-v5-user{font-size:12px;color:var(--s5);font-weight:600}      .lead-page-v5-banner{background:linear-gradient(135deg,#1a6bd9,#2d7fe8);color:#fff;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}      .lead-page-v5-banner-text{font-size:13px;font-weight:600}      .lead-page-v5-banner-btn,.lead-page-v5-btn-primary,.lead-page-v5-btn-green,.lead-page-v5-btn-secondary,.lead-page-v5-ghost,.lead-page-v5-pill-btn,.lead-page-v5-chip,.lead-page-v5-mini-btn,.lead-page-v5-activity-filter,.lead-page-v5-contact-role{font:inherit;cursor:pointer}      .lead-page-v5-banner-btn,.lead-page-v5-btn-primary{background:var(--red);color:#fff;border:none;padding:8px 16px;border-radius:var(--rs);font-weight:700;font-size:13px;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}      .lead-page-v5-banner-btn{background:#fff;color:var(--b)}      .lead-page-v5-btn-primary:hover{background:var(--rd)}      .lead-page-v5-btn-green{background:var(--g);color:#fff;border:none;padding:8px 16px;border-radius:var(--rs);font-weight:700;font-size:13px;display:inline-flex;align-items:center;gap:7px}      .lead-page-v5-btn-green:hover{background:#15753e}      .lead-page-v5-btn-secondary{background:var(--w);color:var(--s6);border:1px solid var(--s2);padding:7px 13px;border-radius:var(--rs);font-weight:700;font-size:12px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}      .lead-page-v5-btn-secondary:hover{background:var(--s0)}      .lead-page-v5-ghost{background:none;border:none;color:var(--s4);font-size:12px;font-weight:700;padding:4px 8px;border-radius:var(--rs)}      .lead-page-v5-ghost:hover{color:var(--s6);background:var(--s1)}      .lead-page-v5-header{padding:16px 24px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}      .lead-page-v5-header-left{flex:1;min-width:0}      .lead-page-v5-header-right{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}      .lead-page-v5-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}      .lead-page-v5-company{font-size:24px;font-weight:900;letter-spacing:-.03em}      .lead-page-v5-stage-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;background:var(--bl);color:var(--b)}      .lead-page-v5-sub{font-size:12px;color:var(--s4);margin-top:4px}      .lead-page-v5-badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}      .lead-page-v5-seq{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:var(--rs);font-size:11px;font-weight:700;background:var(--pl);color:var(--p);border:1px solid #ddd0f5}      .lead-page-v5-seq button{background:none;border:1px solid #c4a8e8;color:var(--p);font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px}      .lead-page-v5-tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:5px 9px;border-radius:var(--rs)}      .lead-page-v5-tag.funded{background:var(--gl);color:var(--g);border:1px solid #b8e0c9}      .lead-page-v5-tag.orders{background:var(--bl);color:var(--b);border:1px solid #c7d9f2}      .lead-page-v5-local-time{font-size:14px;color:var(--s6);font-weight:700;display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;white-space:nowrap}      .lead-page-v5-local-time i{color:var(--s4);font-size:13px}.lead-page-v5-local-time-header{width:100%}      .lead-page-v5-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;padding:16px 24px 80px;align-items:start}      .lead-page-v5-left{display:flex;flex-direction:column;gap:14px;min-width:0}      .lead-page-v5-right{position:sticky;top:52px}      .lead-page-v5-card{background:var(--w);border:1px solid var(--s2);border-radius:var(--rl2);overflow:hidden}      .lead-page-v5-card-header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--s0);border-bottom:1px solid var(--s1)}      .lead-page-v5-card-header h3{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--s5);margin:0}      .lead-page-v5-card-header-right{display:flex;align-items:center;gap:6px}      .lead-page-v5-card-body{padding:14px}      .lead-page-v5-stage-select{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--s1)}      .lead-page-v5-stage-select label,.lead-page-v5-mini-label{font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em}      .lead-page-v5-stage-select select,.lead-page-v5-input,.lead-page-v5-textarea,.lead-page-v5-date,.lead-page-v5-select{padding:7px 10px;border:1px solid var(--s2);border-radius:var(--rs);font-size:12px;background:#fff;color:var(--s8);outline:none}      .lead-page-v5-stage-select select{width:auto;min-width:220px;max-width:100%;flex:0 0 auto;cursor:pointer}      .lead-page-v5-milestones{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}      .lead-page-v5-milestone{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:var(--w);border:1px solid var(--s2);font-size:12px;font-weight:800;color:var(--s6);white-space:nowrap;cursor:pointer;flex:0 0 auto}      .lead-page-v5-milestone.over{background:var(--ol);color:var(--o);border-color:#f0d6a8}      .lead-page-v5-milestone input{appearance:auto;-webkit-appearance:checkbox;accent-color:var(--g);width:14px !important;max-width:14px !important;min-width:14px;height:14px !important;max-height:14px !important;min-height:14px;margin:0;cursor:pointer;flex:0 0 14px;display:block;inline-size:14px !important;block-size:14px !important;padding:0}      .lead-page-v5-milestone span{display:inline-block;line-height:1.1}      .lead-page-v5-milestone.done{background:var(--gl);color:var(--g);border-color:#b8e0c9}      .lead-page-v5-company-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}      .lead-page-v5-field-row{display:flex;padding:6px 0;border-bottom:1px solid var(--s1)}      .lead-page-v5-field-row:last-child{border:none}      .lead-page-v5-field-label{color:var(--s4);font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.04em;width:76px;flex-shrink:0;padding-top:2px}      .lead-page-v5-field-value{font-weight:600;color:var(--s8);font-size:13px;flex:1;min-width:0}      .lead-page-v5-field-value a{color:var(--b)}      .lead-page-v5-inline-save{font-size:10px;color:var(--g);font-weight:700;margin-left:6px}      .lead-page-v5-inline-save.error{color:var(--red)}      .lead-page-v5-subsection{border-top:1px solid var(--s1);padding-top:14px;margin-top:14px}      .lead-page-v5-subsection-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}      .lead-page-v5-subsection-head h4{margin:0;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:var(--s5)}      .lead-page-v5-contact-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;align-items:stretch}      .lead-page-v5-contact-card{min-width:190px;max-width:220px;border:1px solid var(--s2);border-radius:var(--r);padding:10px;flex-shrink:0;display:flex;flex-direction:column;gap:6px}      .lead-page-v5-contact-card.active{border-color:var(--red);box-shadow:0 0 0 2px rgba(217,48,37,.12)}      .lead-page-v5-contact-name{font-size:13px;font-weight:800}      .lead-page-v5-contact-sub{font-size:11px;color:var(--s5);flex:1}      .lead-page-v5-contact-actions{display:flex;gap:4px;flex-wrap:wrap}      .lead-page-v5-pill-btn{border:1px solid var(--s2);background:var(--w);border-radius:999px;padding:3px 8px;font-size:10px;font-weight:700;color:var(--s6)}      .lead-page-v5-add-contact{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:84px;min-height:84px;padding:10px 14px;border-radius:14px;border:1px dashed var(--s2);background:var(--w);color:var(--s5);font-weight:800;font-size:13px;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}.lead-page-v5-add-contact:hover{background:var(--s0);border-color:var(--s3);color:var(--s7)}      .lead-page-v5-contact-form{display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--s1)}      .lead-page-v5-contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}      .lead-page-v5-contact-roles{display:flex;gap:0;border:1px solid var(--s2);border-radius:var(--rs);overflow:hidden}      .lead-page-v5-contact-role{flex:1;padding:7px;border:none;background:#fff;font-size:11px;font-weight:700;color:var(--s6);border-right:1px solid var(--s2)}      .lead-page-v5-contact-role:last-child{border-right:none}      .lead-page-v5-contact-role.active{background:var(--red);color:#fff}      .lead-page-v5-account-tabs{display:flex;gap:0;border-bottom:1px solid var(--s2)}      .lead-page-v5-account-tab{padding:8px 12px;font-size:12px;font-weight:700;color:var(--s4);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;background:none;border-left:none;border-right:none;border-top:none}      .lead-page-v5-account-tab.active{color:var(--s9);border-bottom-color:var(--red)}      .lead-page-v5-account-panel{display:none;padding-top:12px}      .lead-page-v5-account-panel.active{display:block}      .lead-page-v5-info-table{width:100%;border-collapse:collapse}      .lead-page-v5-info-table td{padding:5px 0;font-size:13px;border-bottom:1px solid var(--s1)}      .lead-page-v5-info-table tr:last-child td{border:none}      .lead-page-v5-info-table .k{color:var(--s4);font-weight:800;font-size:10px;text-transform:uppercase;width:80px;vertical-align:top;padding-top:7px}      .lead-page-v5-info-table .v{font-weight:600;color:var(--s8)}      .lead-page-v5-account-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:8px}      .lead-page-v5-account-metric{padding:6px 0;border-bottom:1px solid var(--s1)}      .lead-page-v5-account-metric .k{font-size:10px;font-weight:800;text-transform:uppercase;color:var(--s4);letter-spacing:.03em}      .lead-page-v5-account-metric .v{font-size:14px;font-weight:800;color:var(--s8);margin-top:1px}      .lead-page-v5-empty{font-size:12px;color:var(--s4);font-style:italic;padding:4px 0}      .lead-page-v5-referral-empty{font-size:12px;color:var(--s4);font-style:italic;padding:4px 0}      .lead-page-v5-activity{background:var(--w);border:1px solid var(--s2);border-radius:var(--rl2);display:flex;flex-direction:column;max-height:calc(100vh - 68px);overflow:hidden}      .lead-page-v5-activity-head{padding:12px 14px;background:var(--s0);border-bottom:1px solid var(--s1);flex-shrink:0}      .lead-page-v5-activity-head-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}      .lead-page-v5-activity-head-top h3{margin:0;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--s5)}      .lead-page-v5-schedule-bar{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:8px}      .lead-page-v5-chip{border:1px solid var(--s2);background:#fff;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:700;color:var(--s6)}      .lead-page-v5-chip.morning{background:var(--bl);color:var(--b);border-color:#c7d9f2}      .lead-page-v5-chip.afternoon{background:var(--ol);color:var(--o);border-color:#f0d6a8}      .lead-page-v5-mini-calendar{margin-bottom:8px;display:none;border:1px solid var(--s2);border-radius:var(--rs);overflow:hidden}      .lead-page-v5-mini-calendar.show{display:block}      .lead-page-v5-mini-calendar-head{background:var(--bl);padding:6px 10px;font-size:11px;font-weight:800;color:var(--b);display:flex;justify-content:space-between;align-items:center}      .lead-page-v5-mini-calendar-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--s1);font-size:11px}      .lead-page-v5-mini-calendar-row:last-child{border-bottom:none}      .lead-page-v5-mini-time{font-weight:800;color:var(--b);width:64px;flex-shrink:0}      .lead-page-v5-mini-name{font-weight:600;color:var(--s7);flex:1}      .lead-page-v5-mini-calendar-row.highlight{background:#fef3e0}      .lead-page-v5-mini-actions{padding:8px 10px;border-top:1px solid var(--s1);display:grid;gap:6px}      .lead-page-v5-mini-timezones{display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--s6)}      .lead-page-v5-mini-timezones strong{font-weight:800}      .lead-page-v5-note-bar{margin-bottom:8px}      .lead-page-v5-note{width:100%;padding:8px 10px;border:1px solid var(--s2);border-radius:var(--rs);font-size:12px;line-height:1.5;resize:none;overflow:hidden;min-height:36px}      .lead-page-v5-filters{display:flex;gap:4px;flex-wrap:wrap}      .lead-page-v5-activity-filter{border:1px solid var(--s2);background:#fff;border-radius:999px;padding:4px 10px;font-size:10px;font-weight:700;color:var(--s5)}      .lead-page-v5-activity-filter.active{background:var(--s9);color:#fff;border-color:var(--s9)}      .lead-page-v5-activity-scroll{flex:1;overflow-y:auto;padding:0 14px 14px}      .lead-page-v5-upcoming{padding:10px 0;border-bottom:2px solid var(--s2)}      .lead-page-v5-upcoming-label,.lead-page-v5-history-label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}      .lead-page-v5-upcoming-label{color:var(--o);margin-bottom:8px}      .lead-page-v5-history-label{color:var(--s4);padding:10px 0 6px}      .lead-page-v5-upcoming-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--s1);align-items:flex-start}      .lead-page-v5-upcoming-item:last-child{border-bottom:none}      .lead-page-v5-upcoming-item input{accent-color:var(--g);width:15px;height:15px;flex-shrink:0}      .lead-page-v5-upcoming-icon,.lead-page-v5-history-icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}      .lead-page-v5-upcoming-icon.phone{background:var(--pl);color:var(--p)}      .lead-page-v5-upcoming-icon.seq{background:#fef3c7;color:#a16207}      .lead-page-v5-upcoming-main{flex:1}      .lead-page-v5-upcoming-title{font-size:12px;font-weight:700}      .lead-page-v5-upcoming-meta{font-size:11px;color:var(--s4)}      .lead-page-v5-upcoming-seq{font-size:10px;color:var(--p);font-weight:700}      .lead-page-v5-upcoming-date{font-size:11px;font-weight:700;color:var(--b)}      .lead-page-v5-history-item{border-bottom:1px solid var(--s1)}      .lead-page-v5-history-head{display:flex;gap:10px;padding:10px 0;cursor:pointer;align-items:center}      .lead-page-v5-history-head:hover{background:var(--s0);margin:0 -14px;padding:10px 14px;border-radius:var(--rs)}      .lead-page-v5-history-icon.orum{background:var(--bl);color:var(--b)}      .lead-page-v5-history-icon.rc{background:var(--gl);color:var(--g)}      .lead-page-v5-history-icon.sms{background:#f0fdf4;color:#15803d}      .lead-page-v5-history-icon.email{background:var(--ol);color:var(--o)}      .lead-page-v5-history-icon.note{background:var(--s1);color:var(--s5)}      .lead-page-v5-history-icon.stage{background:var(--rl);color:var(--red)}      .lead-page-v5-history-icon.seq{background:#fef3c7;color:#a16207}      .lead-page-v5-history-main{flex:1;min-width:0}      .lead-page-v5-history-line{font-size:12px;font-weight:600;color:var(--s8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}      .lead-page-v5-history-meta{font-size:10px;color:var(--s4);margin-top:1px}      .lead-page-v5-history-seq{font-size:10px;font-weight:700;color:var(--p);margin-top:1px}      .lead-page-v5-expand{font-size:10px;color:var(--s4);transition:transform .15s}      .lead-page-v5-history-body{padding:0 0 10px 38px;display:none;font-size:12px;color:var(--s6);line-height:1.6}      .lead-page-v5-history-item.open .lead-page-v5-history-body{display:block}      .lead-page-v5-history-item.open .lead-page-v5-expand{transform:rotate(180deg)}      .lead-page-v5-history-body a{color:var(--b);font-weight:700;font-size:11px}      .lead-page-v5-history-tag{font-size:9px;font-weight:800;text-transform:uppercase;padding:2px 5px;border-radius:3px;letter-spacing:.03em;margin-right:4px}      .lead-page-v5-history-tag.orum{background:var(--bl);color:var(--b)}      .lead-page-v5-history-tag.rc{background:var(--gl);color:var(--g)}      .lead-page-v5-history-tag.sms{background:#f0fdf4;color:#15803d}      .lead-page-v5-history-tag.email{background:var(--ol);color:var(--o)}      .lead-page-v5-history-tag.note{background:var(--s1);color:var(--s5)}      .lead-page-v5-history-tag.stage{background:var(--rl);color:var(--red)}      .lead-page-v5-history-tag.seq{background:#fef3c7;color:#a16207}      .lead-page-v5-rci{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}      .lead-page-v5-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:400;display:none;align-items:center;justify-content:center}      .lead-page-v5-modal-overlay.open{display:flex}      .lead-page-v5-sms-modal{background:var(--w);border-radius:var(--rl2);width:min(480px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)}      .lead-page-v5-sms-head{padding:14px 16px;border-bottom:1px solid var(--s1);display:flex;justify-content:space-between;align-items:center}      .lead-page-v5-sms-head h3{margin:0;font-size:14px;font-weight:800}      .lead-page-v5-sms-chips{display:flex;gap:4px;padding:10px 16px;border-bottom:1px solid var(--s1);overflow-x:auto}      .lead-page-v5-sms-chip{border:1px solid var(--s2);background:#fff;border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;color:var(--s6)}      .lead-page-v5-sms-chip.active{background:var(--g);color:#fff;border-color:var(--g)}      .lead-page-v5-sms-thread{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}      .lead-page-v5-sms-msg{max-width:80%;padding:10px 14px;border-radius:14px;font-size:13px;line-height:1.5}      .lead-page-v5-sms-msg.out{background:var(--g);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}      .lead-page-v5-sms-msg.in{background:var(--s1);color:var(--s8);align-self:flex-start;border-bottom-left-radius:4px}      .lead-page-v5-sms-msg-time{font-size:10px;opacity:.7;margin-top:4px}      .lead-page-v5-sms-compose{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--s1)}      .lead-page-v5-sms-compose input{flex:1;padding:10px 12px;border:1px solid var(--s2);border-radius:var(--r);font-size:13px}      .lead-page-v5-email{position:fixed;bottom:16px;right:24px;width:min(460px,92vw);background:var(--w);border-radius:var(--rl2);box-shadow:0 12px 40px rgba(26,31,46,.12);border:1px solid var(--s2);z-index:200;display:none;flex-direction:column;max-height:500px}      .lead-page-v5-email.open{display:flex}      .lead-page-v5-email-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--s9);border-radius:var(--rl2) var(--rl2) 0 0;color:#fff}      .lead-page-v5-email-head h4{margin:0;font-size:13px;font-weight:700}      .lead-page-v5-email-head-actions{display:flex;gap:6px}      .lead-page-v5-email-templates{display:flex;gap:3px;padding:8px 12px;border-bottom:1px solid var(--s1);flex-wrap:wrap}      .lead-page-v5-email-template{border:1px solid var(--s2);background:#fff;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:700;color:var(--s6)}      .lead-page-v5-email-template.active{background:var(--red);border-color:var(--red);color:#fff}      .lead-page-v5-email-fields{padding:8px 12px;display:grid;gap:4px;border-bottom:1px solid var(--s1)}      .lead-page-v5-email-row{display:flex;align-items:center;gap:6px}      .lead-page-v5-email-row label{font-size:10px;font-weight:700;color:var(--s4);width:28px}      .lead-page-v5-email-row input{flex:1;border:none;font-size:12px;padding:4px 0;outline:none;font-weight:500}      .lead-page-v5-email-editor-wrap{flex:1;padding:0 12px;overflow-y:auto}      .lead-page-v5-email-editor{min-height:100px;outline:none;font-size:12px;line-height:1.6;color:var(--s8);padding:8px 0}      .lead-page-v5-email-signature{padding:8px 0;border-top:1px solid var(--s1);font-size:11px;color:var(--s5)}      .lead-page-v5-email-signature strong{color:var(--s8)}      .lead-page-v5-email-attachments{padding:6px 12px;border-top:1px solid var(--s1);display:flex;gap:3px;flex-wrap:wrap}      .lead-page-v5-email-attachment{border:1px solid var(--s2);background:#fff;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:700;color:var(--s5);display:flex;align-items:center;gap:4px}      .lead-page-v5-email-attachment.on{background:var(--gl);color:var(--g);border-color:#b8e0c9}      .lead-page-v5-email-footer{padding:8px 12px;border-top:1px solid var(--s1);display:flex;justify-content:flex-end;gap:6px}      @media (max-width: 1100px){        .lead-page-v5-layout{grid-template-columns:1fr}        .lead-page-v5-right{position:static}      }      @media (max-width: 760px){        .lead-page-v5-topbar,.lead-page-v5-banner,.lead-page-v5-header,.lead-page-v5-layout{padding-left:16px;padding-right:16px}        .lead-page-v5-company-grid{grid-template-columns:1fr}        .lead-page-v5-account-metrics{grid-template-columns:repeat(2,1fr)}        .lead-page-v5-local-time{font-size:14px;color:var(--s6);font-weight:700;display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;white-space:nowrap}      }      @media (max-width: 980px){.lead-contact-form-grid{grid-template-columns:1fr 1fr}}      @media (max-width: 700px){.lead-contact-form-grid{grid-template-columns:1fr}}    `;
    document.head.appendChild(style);
    const overrides = document.createElement("style");
    overrides.id = "sharedLeadViewerOverrides";
    overrides.textContent = `
      .lead-page-v5-root input:not([type="checkbox"]):not([type="radio"]),
      .lead-page-v5-root select,
      .lead-page-v5-root textarea {
        font-size: 12px;
        line-height: 1.35;
      }
      .lead-page-v5-root .lead-panel-input,
      .lead-page-v5-root .lead-panel-textarea,
      .lead-page-v5-root .lead-page-v5-input,
      .lead-page-v5-root .lead-page-v5-textarea,
      .lead-page-v5-root .lead-page-v5-date,
      .lead-page-v5-root .lead-page-v5-select,
      .lead-page-v5-root .lead-page-v5-note,
      .lead-page-v5-root .lead-page-v5-email-row input,
      .lead-page-v5-root .lead-page-v5-sms-compose input {
        font-size: 11px;
      }
      .lead-page-v5-root .lead-page-v5-email-pill-list {
        flex: 1 1 auto;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        min-height: 34px;
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill {
        display: inline-flex;
        align-items: center;
        min-width: 132px;
        max-width: 100%;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px dashed #cbd5e1;
        background: #fff;
        transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill.empty {
        border-style: dashed;
        background: transparent;
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill.committed {
        background: #fef3c7;
        border-color: #facc15;
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill.invalid {
        background: #fff7ed;
        border-color: #fdba74;
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill:focus-within {
        border-color: #facc15;
        box-shadow: 0 0 0 2px rgba(250, 204, 21, .18);
      }
      .lead-page-v5-root .lead-page-v5-email-input-pill input {
        min-width: 88px;
        width: 100%;
        padding: 6px 0;
        border: none;
        background: transparent;
      }
      .lead-page-v5-root .lead-page-v5-stage-select select {
        font-size: 11px;
        padding: 6px 10px;
      }
      .lead-page-v5-root .lead-page-v5-note {
        min-height: 34px;
        line-height: 1.45;
      }
      .lead-page-v5-root {
        height: min(100%, calc(100vh - 16px));
        max-height: calc(100vh - 16px);
        min-height: 0;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-layout {
        min-height: 0;
        height: 100%;
        overflow: hidden;
        align-items: stretch;
        padding-bottom: 16px;
      }
      .lead-page-v5-root .lead-page-v5-left {
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .lead-page-v5-root .lead-page-v5-right {
        position: static;
        display: flex;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-card {
        display: flex;
        flex-direction: column;
        height: auto;
        min-height: 100%;
      }
      .lead-page-v5-root .lead-page-v5-card-body {
        flex: 0 0 auto;
        min-height: 0;
        overflow: visible;
      }
      .lead-page-v5-root .lead-page-v5-activity {
        height: 100%;
        max-height: none;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .lead-page-v5-root .lead-page-v5-activity-scroll {
        flex: 0 0 auto;
        overflow: visible;
        padding: 0 14px;
      }
      .lead-page-v5-root .lead-page-v5-history-scroll {
        flex: 0 0 auto;
        min-height: 0;
        overflow: visible;
        padding: 0 14px 14px;
      }
      .lead-page-v5-root .lead-page-v5-email {
        width: min(860px, calc(100vw - 48px));
        max-height: 780px;
        height: min(780px, calc(100vh - 32px));
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-email-fields {
        gap: 6px;
      }
      .lead-page-v5-root .lead-page-v5-email-row label {
        width: 46px;
      }
      .lead-page-v5-root .lead-page-v5-email-row select {
        flex: 1 1 auto;
      }
      .lead-page-v5-root .lead-page-v5-email-toolbar {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding: 8px 12px 0;
        border-top: 1px solid var(--s1);
      }
      .lead-page-v5-root .lead-page-v5-email-toolbtn {
        border: 1px solid var(--s2);
        background: #fff;
        border-radius: 8px;
        width: 34px;
        height: 32px;
        color: var(--s6);
      }
      .lead-page-v5-root .lead-page-v5-email-toolbtn:hover {
        background: var(--s0);
        color: var(--s8);
      }
      .lead-page-v5-root .lead-page-v5-email-editor-wrap {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        min-height: 210px;
        padding-top: 8px;
      }
      .lead-page-v5-root .lead-page-v5-email-editor {
        min-height: 150px;
        white-space: normal;
      }
      .lead-page-v5-root .lead-page-v5-email-editor p {
        margin: 0 0 10px;
      }
      .lead-page-v5-root .lead-page-v5-email-editor ul,
      .lead-page-v5-root .lead-page-v5-email-editor ol {
        margin: 0 0 10px 20px;
        padding: 0;
      }
      .lead-page-v5-root .lead-page-v5-email-signature-note {
        padding: 0 0 8px;
        font-size: 10px;
        color: var(--s4);
      }
      .lead-page-v5-root .lead-page-v5-email-signature-note.warning {
        color: #9a3412;
      }
      .lead-page-v5-root .lead-page-v5-email-attachments {
        display: grid;
        gap: 8px;
        padding: 8px 10px 10px;
        overflow: hidden;
        min-height: 168px;
      }
      .lead-page-v5-root .lead-page-v5-email-attachments-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-email-attachments-title {
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .05em;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-email-attachment-grid {
        display: grid;
        grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr);
        gap: 8px;
        align-items: stretch;
        min-height: 0;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-panel,
      .lead-page-v5-root .lead-page-v5-email-report-panel {
        border: 1px solid var(--s2);
        border-radius: 12px;
        background: #fbfcfe;
        min-width: 0;
        overflow: hidden;
        min-height: 136px;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-panel {
        padding: 10px;
        display: grid;
        gap: 8px;
        align-content: start;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-row {
        display: grid;
        grid-template-columns: 60px minmax(0, 1fr);
        gap: 8px;
        align-items: start;
      }
      .lead-page-v5-root .lead-page-v5-email-logo-tile {
        width: 60px;
        height: 60px;
        border: 1px dashed var(--s2);
        background: #fff;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        overflow: hidden;
        padding: 5px;
      }
      .lead-page-v5-root .lead-page-v5-email-logo-tile:hover {
        border-color: var(--s3);
        background: var(--s0);
      }
      .lead-page-v5-root .lead-page-v5-email-logo-preview,
      .lead-page-v5-root .lead-page-v5-email-logo-placeholder {
        width: 100%;
        height: 100%;
        border-radius: 10px;
        object-fit: contain;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: var(--s4);
        text-align: center;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-copy {
        min-width: 0;
        display: grid;
        gap: 5px;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-title {
        font-size: 10px;
        font-weight: 800;
        color: var(--s8);
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-save {
        font-size: 10px;
        font-weight: 700;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-email-branding-save:empty {
        display: none;
      }
      .lead-page-v5-root .lead-page-v5-email-branding-save.saved {
        color: var(--g);
      }
      .lead-page-v5-root .lead-page-v5-email-branding-save.error {
        color: var(--red);
      }
      .lead-page-v5-root .lead-page-v5-email-branding-colors {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-email-brand-field {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 10px;
        font-weight: 800;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-email-brand-field input[type="color"] {
        width: 36px;
        height: 28px;
        border: 1px solid var(--s2);
        border-radius: 10px;
        background: #fff;
        padding: 0;
      }
      .lead-page-v5-root .lead-page-v5-email-report-panel {
        display: flex;
        min-height: 0;
      }
      .lead-page-v5-root .lead-page-v5-email-report-list {
        display: grid;
        gap: 2px;
        overflow-y: auto;
        padding: 8px 10px;
        min-height: 136px;
        max-height: 136px;
        flex: 1 1 auto;
      }
      .lead-page-v5-root .lead-page-v5-email-report-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        border-bottom: 1px solid var(--s1);
      }
      .lead-page-v5-root .lead-page-v5-email-report-row:last-child {
        border-bottom: none;
      }
      .lead-page-v5-root .lead-page-v5-email-report-title {
        min-width: 0;
        font-size: 10px;
        font-weight: 800;
        color: var(--s8);
        line-height: 1.2;
      }
      .lead-page-v5-root .lead-page-v5-email-report-modes {
        display: inline-flex;
        gap: 3px;
        flex-wrap: nowrap;
        flex: 0 0 auto;
      }
      .lead-page-v5-root .lead-page-v5-email-report-mode {
        border: 1px solid var(--s2);
        background: #fff;
        color: var(--s6);
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 9px;
        font-weight: 800;
      }
      .lead-page-v5-root .lead-page-v5-email-report-mode.active {
        background: var(--gl);
        border-color: #b8e0c9;
        color: var(--g);
      }
      .lead-page-v5-root .lead-page-v5-email-report-preview {
        border: 1px solid var(--s2);
        background: #fff;
        color: var(--s6);
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 9px;
        font-weight: 800;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .lead-page-v5-root .lead-page-v5-email-report-preview:hover {
        background: var(--s0);
        color: var(--s8);
      }
      .lead-page-v5-root .lead-page-v5-email-report-empty {
        padding: 12px;
        border: 1px dashed var(--s2);
        border-radius: 12px;
        color: var(--s4);
        font-size: 11px;
        font-style: italic;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, .48);
        z-index: 420;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-modal {
        width: min(1040px, 96vw);
        height: min(820px, 90vh);
        background: #fff;
        border-radius: 18px;
        box-shadow: 0 28px 80px rgba(15, 23, 42, .24);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--s1);
        background: #fbfcfe;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-title {
        font-size: 13px;
        font-weight: 900;
        color: var(--s8);
      }
      .lead-page-v5-root .lead-page-v5-email-preview-tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-tab {
        border: 1px solid var(--s2);
        background: #fff;
        color: var(--s6);
        border-radius: 999px;
        padding: 5px 10px;
        font-size: 10px;
        font-weight: 800;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-tab.active {
        background: var(--bl);
        border-color: #c7d9f2;
        color: var(--b);
      }
      .lead-page-v5-root .lead-page-v5-email-preview-body {
        flex: 1 1 auto;
        min-height: 0;
        background: #eef2f7;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-frame {
        width: 100%;
        height: 100%;
        border: none;
        background: #fff;
      }
      .lead-page-v5-root .lead-page-v5-email-preview-status {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        text-align: center;
        color: var(--s5);
        font-size: 13px;
        font-weight: 700;
      }
      .lead-page-v5-root .lead-page-v5-sms-modal {
        width: min(960px, calc(100vw - 40px));
        max-height: min(760px, calc(100vh - 40px));
      }
      .lead-page-v5-root .lead-page-v5-sms-head {
        padding: 16px 18px;
      }
      .lead-page-v5-root .lead-page-v5-sms-chips {
        padding: 10px 18px;
      }
      .lead-page-v5-root .lead-page-v5-sms-thread {
        min-height: 280px;
        padding: 18px;
        background: #fbfcfe;
      }
      .lead-page-v5-root .lead-page-v5-sms-empty-state {
        min-height: 220px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      .lead-page-v5-root .lead-page-v5-sms-compose {
        display: grid;
        gap: 10px;
        padding: 14px 18px 18px;
      }
      .lead-page-v5-root .lead-page-v5-sms-recipient-row {
        display: grid;
        grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
        gap: 10px;
        align-items: center;
      }
      .lead-page-v5-root .lead-page-v5-sms-contact-select,
      .lead-page-v5-root .lead-page-v5-sms-phone-input {
        width: 100%;
        min-width: 0;
      }
      .lead-page-v5-root .lead-page-v5-sms-alt-note {
        font-size: 11px;
        color: var(--s5);
        margin-top: -2px;
      }
      .lead-page-v5-root .lead-page-v5-sms-compose-row {
        display: grid;
        grid-template-columns: minmax(0, 2.2fr) minmax(140px, 180px) auto;
        gap: 10px;
        align-items: stretch;
      }
      .lead-page-v5-root .lead-page-v5-sms-message-input {
        width: 100%;
        min-height: 88px;
        resize: vertical;
        padding: 11px 12px;
        border: 1px solid var(--s2);
        border-radius: 12px;
        background: #fff;
      }
      .lead-page-v5-root .lead-page-v5-sms-template-select {
        align-self: stretch;
      }
      .lead-page-v5-root .lead-page-v5-sms-send {
        min-width: 108px;
        justify-content: center;
        position: relative;
        z-index: 5;
        pointer-events: auto;
      }
      .lead-page-v5-root .lead-page-v5-sms-status {
        font-size: 11px;
        font-weight: 700;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-sms-status.error {
        color: #b42318;
      }
      .lead-page-v5-root .lead-page-v5-sms-status.saved {
        color: var(--g);
      }
      .lead-page-v5-root .lead-page-v5-sms-status.saving {
        color: var(--b);
      }
      @media (max-width: 760px) {
        .lead-page-v5-root .lead-page-v5-email-attachment-grid {
          grid-template-columns: 1fr;
        }
        .lead-page-v5-root .lead-page-v5-email-report-list {
          max-height: none;
        }
        .lead-page-v5-root .lead-page-v5-sms-modal {
          width: min(100vw - 20px, 960px);
        }
        .lead-page-v5-root .lead-page-v5-sms-recipient-row,
        .lead-page-v5-root .lead-page-v5-sms-compose-row {
          grid-template-columns: 1fr;
        }
        .lead-page-v5-root .lead-page-v5-sms-send {
          width: 100%;
        }
      }
      .lead-page-v5-root .lead-page-v5-schedule-shell {
        display: grid;
        gap: 10px;
      }
      .lead-page-v5-root .lead-page-v5-schedule-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--s2);
        border-radius: 12px;
        background: #fff;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel.followup {
        border-color: #f5d4d0;
        background: #fff8f7;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel.meeting {
        border-color: #cfe0fb;
        background: #f7faff;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-detail {
        border-color: #cfe0fb;
        background: #f7faff;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        min-height: 0;
        height: min(68vh, 720px);
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-meta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        font-size: 10px;
        font-weight: 800;
        color: var(--s5);
        white-space: nowrap;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-meta i {
        color: #16a34a;
        font-size: 9px;
        flex: 0 0 auto;
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-title {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        font-weight: 900;
        color: var(--s8);
      }
      .lead-page-v5-root .lead-page-v5-schedule-panel-copy {
        font-size: 10px;
        font-weight: 700;
        color: var(--s5);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .lead-page-v5-root .lead-page-v5-schedule-note {
        font-size: 10px;
        color: var(--s5);
        font-weight: 700;
      }
      .lead-page-v5-root .lead-page-v5-schedule-preview {
        display: grid;
        gap: 4px;
        font-size: 11px;
        color: var(--s6);
      }
      .lead-page-v5-root .lead-page-v5-schedule-summary-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        padding-top: 2px;
        font-size: 11px;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-schedule-summary {
        display: grid;
        gap: 4px;
        flex: 1 1 280px;
      }
      .lead-page-v5-root .lead-page-v5-schedule-summary-item strong {
        color: var(--s8);
      }
      .lead-page-v5-root .lead-page-v5-inline-checks {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-inline-checks.tight {
        gap: 6px;
        flex-wrap: nowrap;
      }
      .lead-page-v5-root .lead-page-v5-toggle-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 0;
        padding: 6px 10px;
        border: 1px solid var(--s2);
        border-radius: 999px;
        background: #fff;
        color: var(--s6);
        font-size: 11px;
        font-weight: 800;
        white-space: nowrap;
      }
      .lead-page-v5-root .lead-page-v5-toggle-chip.active {
        background: var(--gl);
        border-color: #b8e0c9;
        color: var(--g);
      }
      .lead-page-v5-root .lead-page-v5-note-submit-row {
        display: flex;
        align-items: stretch;
        gap: 8px;
      }
      .lead-page-v5-root .lead-page-v5-note-submit-row .lead-page-v5-note {
        flex: 1 1 auto;
      }
      .lead-page-v5-root .lead-page-v5-note-submit-row .lead-page-v5-btn-secondary {
        flex: 0 0 auto;
        align-self: stretch;
        justify-content: center;
      }
      .lead-page-v5-root .lead-page-v5-calendar-day-shell {
        display: grid;
        gap: 10px;
        min-height: 0;
        height: 100%;
      }
      .lead-page-v5-root .lead-page-v5-calendar-day-hint {
        font-size: 11px;
        color: var(--s5);
      }
      .lead-page-v5-root .lead-page-v5-calendar-allday {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-calendar-allday-label {
        min-width: 48px;
        padding-top: 6px;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: .05em;
        text-transform: uppercase;
        color: var(--s4);
      }
      .lead-page-v5-root .lead-page-v5-calendar-allday-list {
        display: flex;
        flex: 1 1 auto;
        gap: 8px;
        flex-wrap: wrap;
      }
      .lead-page-v5-root .lead-page-v5-calendar-allday-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        padding: 6px 10px;
        border: 1px solid var(--s2);
        border-radius: 999px;
        background: var(--s0);
        color: var(--s7);
        font-size: 11px;
        font-weight: 800;
      }
      .lead-page-v5-root .lead-page-v5-calendar-allday-chip.selected {
        border-color: #8ed0ad;
        background: var(--gl);
        color: var(--g);
      }
      .lead-page-v5-root .lead-page-v5-calendar-scroll {
        position: relative;
        min-height: 0;
        height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        border: 1px solid var(--s2);
        border-radius: 14px;
        background: linear-gradient(180deg, #fff 0%, #fbfcff 100%);
      }
      .lead-page-v5-root .lead-page-v5-calendar-grid {
        position: relative;
        min-height: 100%;
      }
      .lead-page-v5-root .lead-page-v5-calendar-gutter {
        position: absolute;
        inset: 0 auto 0 0;
        width: 60px;
        border-right: 1px solid var(--s1);
        background: linear-gradient(180deg, #fcfdff 0%, #f7f9fc 100%);
      }
      .lead-page-v5-root .lead-page-v5-calendar-track {
        position: absolute;
        inset: 0 0 0 60px;
        background-image:
          repeating-linear-gradient(
            to bottom,
            transparent 0,
            transparent 27px,
            rgba(212, 218, 230, 0.35) 27px,
            rgba(212, 218, 230, 0.35) 28px,
            transparent 28px,
            transparent 55px,
            rgba(212, 218, 230, 0.85) 55px,
            rgba(212, 218, 230, 0.85) 56px
          );
      }
      .lead-page-v5-root .lead-page-v5-calendar-hour {
        position: absolute;
        left: 0;
        right: 0;
        height: 0;
      }
      .lead-page-v5-root .lead-page-v5-calendar-hour-label {
        position: absolute;
        right: 10px;
        top: 0;
        transform: translateY(-50%);
        font-size: 10px;
        font-weight: 800;
        color: var(--s4);
        letter-spacing: .02em;
      }
      .lead-page-v5-root .lead-page-v5-calendar-event-canvas {
        position: absolute;
        inset: 0 8px 0 8px;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block {
        position: absolute;
        min-width: 0;
        padding: 8px 10px;
        border-radius: 12px;
        border: 1px solid #b7cff9;
        background: linear-gradient(180deg, #edf4ff 0%, #dbe8ff 100%);
        box-shadow: 0 8px 18px rgba(26, 107, 217, 0.12);
        color: var(--s8);
        overflow: visible;
        cursor: default;
        transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block:hover {
        transform: translateY(-1px);
        box-shadow: 0 14px 28px rgba(26, 31, 46, 0.16);
        border-color: #89adef;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block.selected {
        border-color: #8ed0ad;
        background: linear-gradient(180deg, #e7f7ef 0%, #d8f0e4 100%);
        box-shadow: 0 10px 24px rgba(26, 138, 74, 0.18);
      }
      .lead-page-v5-root .lead-page-v5-calendar-block.compact {
        padding-top: 6px;
        padding-bottom: 6px;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block.compact .lead-page-v5-calendar-block-meta {
        display: none;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block-title {
        padding-right: 20px;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.25;
        color: inherit;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block-meta {
        margin-top: 2px;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--s6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block.selected .lead-page-v5-calendar-block-meta {
        color: #31694b;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block-open {
        position: absolute;
        top: 7px;
        right: 7px;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.78);
        color: var(--b);
        font-size: 9px;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block-tooltip {
        position: absolute;
        left: calc(100% + 10px);
        top: -4px;
        width: 220px;
        max-width: min(220px, calc(100vw - 120px));
        padding: 10px 11px;
        border-radius: 12px;
        background: #172032;
        color: #fff;
        box-shadow: 0 16px 34px rgba(23, 32, 50, 0.28);
        opacity: 0;
        transform: translateY(4px);
        pointer-events: none;
        transition: opacity .14s ease, transform .14s ease;
      }
      .lead-page-v5-root .lead-page-v5-calendar-block:hover .lead-page-v5-calendar-block-tooltip {
        opacity: 1;
        transform: translateY(0);
      }
      .lead-page-v5-root .lead-page-v5-calendar-block-tooltip::before {
        content: "";
        position: absolute;
        top: 14px;
        left: -6px;
        width: 12px;
        height: 12px;
        background: #172032;
        transform: rotate(45deg);
      }
      .lead-page-v5-root .lead-page-v5-calendar-tooltip-title {
        font-size: 12px;
        font-weight: 900;
        line-height: 1.3;
      }
      .lead-page-v5-root .lead-page-v5-calendar-tooltip-copy {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.4;
        color: rgba(255, 255, 255, 0.88);
      }
      .lead-page-v5-root .lead-page-v5-calendar-empty-state {
        display: grid;
        place-items: center;
        min-height: 100%;
        padding: 20px;
        color: var(--s4);
        text-align: center;
        font-style: italic;
      }
      .lead-page-v5-root .lead-page-v5-calendar-events {
        min-height: 0;
        height: 100%;
      }
      .lead-page-v5-root .lead-page-v5-calendar-times {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 11px;
        color: var(--s6);
      }
      .lead-page-v5-root .lead-page-v5-calendar-times strong {
        color: var(--s6);
      }
      .lead-page-v5-root .lead-page-v5-calendar-times .viewer {
        font-weight: 800;
        color: var(--b);
      }
      .lead-page-v5-root .lead-page-v5-calendar-times .lead {
        font-weight: 800;
        color: var(--o);
      }
      .lead-page-v5-root .lead-page-v5-schedule-bar {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-start;
        align-items: center;
        gap: 5px;
        margin-bottom: 0;
      }
      .lead-page-v5-root .lead-page-v5-schedule-divider {
        width: 1px;
        height: 18px;
        background: var(--s2);
        margin: 0 2px;
        flex: 0 0 auto;
      }
      .lead-page-v5-root .lead-page-v5-date {
        width: auto;
        min-width: 138px;
        max-width: 148px;
        flex: 0 0 auto;
        padding: 5px 8px;
      }
      .lead-page-v5-root .lead-page-v5-schedule-time {
        padding: 5px 8px;
        font-size: 11px;
      }
      .lead-page-v5-root .lead-page-v5-mini-label {
        white-space: nowrap;
      }
      .lead-page-v5-root .lead-page-v5-upcoming-item > input[type="checkbox"] {
        appearance: auto;
        -webkit-appearance: checkbox;
        accent-color: var(--g);
        width: 15px !important;
        min-width: 15px;
        max-width: 15px !important;
        height: 15px !important;
        min-height: 15px;
        max-height: 15px !important;
        inline-size: 15px !important;
        block-size: 15px !important;
        flex: 0 0 15px;
        margin: 0;
        padding: 0;
        display: block;
        align-self: center;
      }
      .lead-page-v5-root .lead-page-v5-email {
        right: 154px;
        display: flex;
        flex-direction: column;
        cursor: default;
      }
      .lead-page-v5-root .lead-page-v5-email.active {
        box-shadow: 0 20px 60px rgba(26, 31, 46, 0.18);
        border-color: var(--s3);
      }
      .lead-page-v5-root .lead-page-v5-email.minimized {
        height: 56px !important;
        min-height: 56px !important;
        max-height: 56px !important;
        overflow: hidden;
        border-radius: var(--rl2);
      }
      .lead-page-v5-root .lead-page-v5-email.minimized .lead-page-v5-email-head {
        border-radius: var(--rl2);
      }
      .lead-page-v5-root .lead-page-v5-email-head {
        cursor: grab;
        user-select: none;
      }
      .lead-page-v5-root .lead-page-v5-email-links {
        align-items: center;
      }
      .lead-page-v5-root .lead-page-v5-email-link-row {
        display: flex;
        gap: 2px;
        align-items: center;
      }
      .lead-page-v5-root .lead-page-v5-email-resize {
        display: none;
      }
      .lead-page-v5-root .lead-page-v5-toast {
        position: fixed;
        left: 24px;
        bottom: 24px;
        z-index: 430;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 12px 14px;
        border-radius: 12px;
        box-shadow: 0 14px 34px rgba(26, 31, 46, 0.18);
        font-size: 12px;
        font-weight: 800;
        color: #fff;
        background: #16351f;
      }
      .lead-page-v5-root .lead-page-v5-toast.success {
        background: #16351f;
      }
      .lead-page-v5-root .lead-page-v5-toast.error {
        background: #7f1d1d;
      }
      .lead-page-v5-root .lead-page-v5-email-send-status {
        margin-right: auto;
        font-size: 10px;
        font-weight: 800;
        color: var(--s4);
      }
      .lead-page-v5-root .lead-page-v5-email-send-status.saving {
        color: var(--b);
      }
      .lead-page-v5-root .lead-page-v5-email-send-status.error {
        color: var(--red);
      }
      @media (max-width: 1100px) {
        .lead-page-v5-root {
          height: min(100%, calc(100vh - 16px));
          max-height: calc(100vh - 16px);
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          grid-template-rows: auto auto auto auto;
        }
        .lead-page-v5-root .lead-page-v5-layout {
          height: auto;
          min-height: 0;
          overflow: visible;
        }
        .lead-page-v5-root .lead-page-v5-left,
        .lead-page-v5-root .lead-page-v5-right {
          height: auto;
          min-height: 0;
          overflow: visible;
        }
        .lead-page-v5-root .lead-page-v5-right {
          display: block;
        }
        .lead-page-v5-root .lead-page-v5-card,
        .lead-page-v5-root .lead-page-v5-activity {
          height: auto;
          min-height: 0;
          max-height: none;
          overflow: visible;
        }
        .lead-page-v5-root .lead-page-v5-card-body,
        .lead-page-v5-root .lead-page-v5-activity-scroll,
        .lead-page-v5-root .lead-page-v5-history-scroll {
          overflow: visible;
          max-height: none;
        }
      }
      @media (max-width: 760px) {
        .lead-page-v5-root .lead-page-v5-schedule-grid {
          grid-template-columns: 1fr;
        }
        .lead-page-v5-root .lead-page-v5-schedule-panel-detail {
          height: min(62vh, 680px);
        }
        .lead-page-v5-root .lead-page-v5-note-submit-row {
          flex-direction: column;
        }
        .lead-page-v5-root .lead-page-v5-inline-checks.tight {
          flex-wrap: wrap;
        }
        .lead-page-v5-root .lead-page-v5-email {
          right: 16px;
          left: 16px;
          width: auto;
          max-width: none;
          max-height: calc(100vh - 32px);
          top: auto;
        }
        .lead-page-v5-root .lead-page-v5-toast {
          left: 16px;
          right: 16px;
          bottom: 16px;
          max-width: none;
        }
        .lead-page-v5-root .lead-page-v5-schedule-divider {
          display: none;
        }
      }
    `;
    document.head.appendChild(overrides);
  }
  function sectionWrap(key, title, bodyHtml, meta, state, headExtrasHtml) {
    const raw = state.sections?.[key];
    const collapsed = typeof raw === "function" ? !!raw() : !!raw;
    return `        <section class="lead-section ${collapsed ? "collapsed" : ""}" data-lead-section="${esc(key)}">          <div class="lead-section-head" data-toggle-section="${esc(key)}">            <div>              <h3>${esc(title)}</h3>              ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}            </div>            <div class="lead-section-head-right">              ${headExtrasHtml || ""}              <button type="button" class="toggle" data-toggle-section="${esc(key)}"><i class="fas ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}"></i></button>            </div>          </div>          <div class="lead-section-body">${bodyHtml}</div>        </section>      `;
  }
  function renderField(label, value, opts) {
    const options = opts || {};
    return `      <div class="lead-field ${options.className || ""}">        <div class="k">${esc(label)}</div>        <div class="v">${options.html ? value : esc(value === "" || value === null || value === undefined ? "-" : value)}</div>      </div>    `;
  }
  function renderImportedFieldTiles(raw) {
    if (!raw || typeof raw !== "object") return "";
    const fields = Object.entries(raw)
      .filter(
        ([, value]) =>
          value !== null && value !== undefined && String(value).trim() !== "",
      )
      .map(([key, value]) => {
        const label = String(key)
          .replace(/_/g, " ")
          .replace(/\b\w/g, (m) => m.toUpperCase());
        const text =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        return `          <div class="lead-call-field">            <div class="k">${esc(label)}</div>            <div class="v">${esc(text)}</div>          </div>        `;
      });
    return fields.length
      ? `<div class="lead-history-raw">${fields.join("")}</div>`
      : "";
  }
  function renderSubsection(title, meta, bodyHtml, collapsed) {
    return `      <details class="lead-subsection" ${collapsed ? "" : "open"}>        <summary>          <span>${esc(title)}</span>          <span class="meta">${esc(meta || "")}</span>        </summary>        <div class="lead-subsection-body">${bodyHtml}</div>      </details>    `;
  }
  function renderReputationField(lead) {
    const rating = lead.metadata?.rating ?? "-";
    const reviews = lead.metadata?.user_ratings_total;
    return `      <div class="lead-field">        <div class="k">Reputation</div>        <div class="v lead-field-split">          <span class="lead-metric"><span class="lead-metric-label">Rating</span><span class="lead-metric-value">${esc(rating)}</span></span>          <span class="lead-metric"><span class="lead-metric-label">Reviews</span><span class="lead-metric-value">${esc(reviews === undefined || reviews === null || reviews === "" ? "-" : Number(reviews).toLocaleString())}</span></span>        </div>      </div>    `;
  }
  function renderSaveState(saveState, idleText) {
    const state = saveState || {};
    const status = String(state.status || "idle");
    const message = String(
      state.message ||
        (status === "saving"
          ? "Saving..."
          : status === "saved"
            ? "Saved"
            : status === "error"
              ? "Could not save"
              : status === "dirty"
                ? "Unsaved changes"
                : idleText || "Autosaves when you leave this area"),
    );
    const className = ["saved", "saving", "error"].includes(status)
      ? ` ${status}`
      : "";
    return `<span class="lead-inline-status${className}">${esc(message)}</span>`;
  }
  function renderContactsSection(lead, state) {
    const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
    const notesMap = lead.contact_notes || {};
    const draft = state.contactDraft || {};
    const selectedTitle = draft.title_preset || "";
    const noteDraftId = state.contactNoteTargetId || "";
    const contactSaveState = state.saveStates?.contact || {};
    return `      <div class="lead-contact-row">        ${
      contacts.length
        ? contacts
            .map((contact) => {
              const contactNotes = Array.isArray(notesMap[contact.id])
                ? notesMap[contact.id]
                : [];
              const noteSaveState =
                state.contactNoteSaveStates?.[contact.id] || {};
              const noteDraft = state.contactNoteDrafts?.[contact.id] || "";
              return `            <div class="lead-contact-card ${String(draft.contact_id || "") === String(contact.id) ? "active" : ""}">              <div>                <div class="lead-contact-name">${esc(contact.full_name || contact.email || contact.phone || "Unnamed Contact")}</div>                <div class="lead-contact-sub">${esc([contact.title, contact.email, contact.phone].filter(Boolean).join(" â€¢ ") || "No direct details yet")}</div>              </div>              ${contact.notes ? `<div class="lead-inline-status">${esc(contact.notes)}</div>` : ""}              <div class="lead-contact-note-list">                ${
                contactNotes.length
                  ? contactNotes
                      .slice(0, 3)
                      .map(
                        (item) =>
                          `                  <div class="lead-contact-note-item">                    <div class="meta">${esc(item.owner_email || "-")} â€¢ ${esc(fmtTs(item.created_at))}</div>                    <div>${esc(item.note_text || "")}</div>                  </div>                `,
                      )
                      .join("")
                  : '<div class="lead-inline-status">No short notes yet.</div>'
              }              </div>              <div class="lead-actions">                  <button class="lead-btn-subtle" type="button" data-lead-edit-contact="${esc(contact.id)}">Edit</button>                  <button class="lead-btn-subtle" type="button" data-lead-open-contact-note="${esc(contact.id)}">Add Note</button>              </div>              ${String(noteDraftId) === String(contact.id) ? `                <div class="lead-inline-form" data-autosave-contact-note="${esc(contact.id)}">                  <div class="lead-inline-form-head">                    ${renderSaveState(noteSaveState, "Autosaves when you leave this note")}                    <button class="btn-secondary" type="button" data-lead-cancel-contact-note="${esc(contact.id)}">Close</button>                  </div>                  <textarea class="lead-panel-textarea" rows="2" data-lead-contact-note-input="${esc(contact.id)}" placeholder="Short contact note...">${esc(noteDraft)}</textarea>                  <div class="lead-inline-status">This note saves after you click away.</div>                </div>              ` : ""}            </div>          `;
            })
            .join("")
        : '<div class="lead-empty" style="min-width:220px;">No contacts yet.</div>'
    }      </div>      <div class="lead-contact-form" data-autosave-contact>        <div class="lead-contact-form-head">          ${renderSaveState(contactSaveState, "Autosaves when you leave the contact form")}          ${draft.contact_id ? '<button class="btn-secondary" type="button" data-lead-clear-contact-draft>Done Editing</button>' : '<div class="lead-inline-status">Add a new contact and move on.</div>'}        </div>        <div class="lead-quick-buttons">          ${["Receptionist", "Owner", "Manager", "Other"].map((title) => `            <button type="button" class="lead-quick-btn ${selectedTitle === title ? "active" : ""}" data-contact-title-preset="${esc(title)}">${esc(title)}</button>          `).join("")}        </div>        <div class="lead-contact-form-grid">          <input class="lead-panel-input" data-lead-contact-name type="text" placeholder="Contact name" value="${esc(draft.full_name || "")}">          <input class="lead-panel-input" data-lead-contact-title type="text" placeholder="Title" value="${esc(draft.title || "")}" ${selectedTitle && selectedTitle !== "Other" ? "readonly" : ""}>          <input class="lead-panel-input" data-lead-contact-email type="email" placeholder="Direct email" value="${esc(draft.email || "")}">          <input class="lead-panel-input" data-lead-contact-phone type="text" placeholder="Direct phone" value="${esc(draft.phone || "")}">        </div>        <textarea class="lead-panel-textarea" data-lead-contact-notes rows="2" placeholder="Quick note">${esc(draft.notes || "")}</textarea>      </div>    `;
  }
  function renderNotesSection(lead, state) {
    const notes = Array.isArray(lead.notes_items)
      ? lead.notes_items.filter((note) => !note.dial_event_id)
      : [];
    const formOpen = !!state.newNoteOpen;
    const noteSaveState = state.saveStates?.note || {};
    return `        ${formOpen ? `          <div class="lead-inline-form" style="margin-bottom:12px;" data-autosave-note>            <div class="lead-inline-form-head">              ${renderSaveState(noteSaveState, "Autosaves when you leave this note")}              <button class="btn-secondary" type="button" data-lead-toggle-new-note>Hide Draft</button>            </div>            <textarea class="lead-panel-textarea" data-lead-note-input rows="3" placeholder="Add a CRM note...">${esc(state.noteDraft || "")}</textarea>            <div class="lead-inline-status">Keep typing and click away when you are ready to save.</div>        </div>      ` : ""}      <div class="lead-note-list">        ${notes.length ? notes.map((note) => `          <div class="lead-note-item ${note.dial_event_id ? "imported" : ""}">            <div class="meta">${esc(note.owner_email || "-")} â€¢ ${esc(fmtTs(note.created_at))}${note.dial_event_id ? " â€¢ Imported from Orum call history" : ""}</div>            <div>${esc(note.note_text || "")}</div>          </div>        `).join("") : '<div class="lead-empty">No notes yet.</div>'}      </div>    `;
  }
  function callContextFields(item) {
    const ctx = item.context || {};
    const raw = ctx.raw && typeof ctx.raw === "object" ? ctx.raw : {};
    const pick = (...keys) => {
      for (const key of keys) {
        const value = ctx[key];
        if (
          value !== null &&
          value !== undefined &&
          String(value).trim() !== ""
        )
          return String(value).trim();
      }
      for (const key of keys) {
        const value = raw[key];
        if (
          value !== null &&
          value !== undefined &&
          String(value).trim() !== ""
        )
          return String(value).trim();
      }
      return "";
    };
    const fields = [];
    const pushIf = (label, value) => {
      const safe = String(value ?? "").trim();
      if (safe) fields.push({ label, value: safe });
    };
    pushIf("Reason Ended", pick("reason_ended"));
    pushIf("Call Type", pick("call_type"));
    pushIf("List", pick("list"));
    pushIf("Rep", pick("rep_name", "rep"));
    pushIf("Rep Phone", pick("rep_phone"));
    return fields;
  }
  function renderCallHistorySection(lead) {
    const dialEvents = Array.isArray(lead.dial_events) ? lead.dial_events : [];
    const notes = Array.isArray(lead.notes_items) ? lead.notes_items : [];
    const eventContacts = lead.dial_event_contacts || {};
    const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
    return `      <div class="lead-call-list">          ${
      dialEvents.length
        ? dialEvents
            .map((item) => {
              const linkedContacts = Array.isArray(eventContacts[item.id])
                ? eventContacts[item.id]
                : [];
              const linkedNotes = notes.filter(
                (note) =>
                  String(note.dial_event_id || "") === String(item.id || ""),
              );
              const fields = callContextFields(item);
              const rawFields =
                item.context?.raw && typeof item.context.raw === "object"
                  ? item.context.raw
                  : {};
              const pick = (...keys) => {
                for (const key of keys) {
                  const value = item.context?.[key];
                  if (
                    value !== null &&
                    value !== undefined &&
                    String(value).trim() !== ""
                  )
                    return String(value).trim();
                }
                for (const key of keys) {
                  const value = rawFields[key];
                  if (
                    value !== null &&
                    value !== undefined &&
                    String(value).trim() !== ""
                  )
                    return String(value).trim();
                }
                return "";
              };
              const recordingUrl = pick("recording");
              const dialedPhone = pick("phone");
              const normalizedPhone = normalizePhone(dialedPhone);
              const phoneMatch = normalizedPhone
                ? contacts.find(
                    (contact) =>
                      normalizePhone(contact.phone) === normalizedPhone,
                  )
                : null;
              const targetLabel = linkedContacts.length
                ? linkedContacts
                    .map(
                      (contact) =>
                        contact.full_name ||
                        contact.email ||
                        contact.phone ||
                        "Contact",
                    )
                    .join(", ")
                : phoneMatch?.full_name ||
                  lead.company ||
                  dialedPhone ||
                  "Unknown";
              const repLabel =
                pick("rep_name", "rep") ||
                String(item.owner_email || "-").trim() ||
                "-";
              const disposition =
                pick("disposition") || String(item.source || "-").trim() || "-";
              return `              <div class="lead-call-item">                <div class="lead-call-summary">                <span>${esc(repLabel)}</span>                <span class="sep">â†’</span>                <span>${esc(targetLabel)}</span>                <span>at ${esc(fmtTsMinute(item.dialed_at))}</span>                <span class="sep">,</span>                <span>${esc(fmtDurationSeconds(item.context?.duration))}</span>                <span class="sep">-</span>                <span>${esc(disposition)}</span>                ${recordingUrl ? `<a class="btn-secondary lead-viewer-action-compact" href="${esc(recordingUrl)}" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Recording</a>` : ""}              </div>              ${linkedNotes.length ? `<div style="margin-top:8px;">${esc(linkedNotes[0].note_text || "")}</div>` : ""}              ${fields.length || (rawFields && Object.keys(rawFields).length) ? `                <details class="lead-history-details">                  <summary>Show All</summary>                  ${fields.length ? `                    <div class="lead-call-grid">                      ${fields.map((field) => `                        <div class="lead-call-field">                          <div class="k">${esc(field.label)}</div>                          <div class="v">${esc(field.value)}</div>                        </div>                      `).join("")}                    </div>                  ` : ""}                </details>              ` : ""}            </div>          `;
            })
            .join("")
        : '<div class="lead-empty">No call history yet.</div>'
    }      </div>    `;
    return `      <div class="lead-call-list">        ${
      dialEvents.length
        ? dialEvents
            .map((item) => {
              const contacts = Array.isArray(eventContacts[item.id])
                ? eventContacts[item.id]
                : [];
              const linkedNotes = notes.filter(
                (note) =>
                  String(note.dial_event_id || "") === String(item.id || ""),
              );
              const fields = callContextFields(item);
              const raw = item.context?.raw
                ? JSON.stringify(item.context.raw, null, 2)
                : "";
              const callbackUrl = String(
                item.context?.callback_url || "",
              ).trim();
              const recordingUrl = String(item.context?.recording || "").trim();
              return `            <div class="lead-call-item">              <div class="meta">${esc(item.owner_email || "-")} â€¢ ${esc(item.source || "orum_import")} â€¢ ${esc(fmtTs(item.dialed_at))}</div>              <div>${contacts.length ? `Spoke with ${esc(contacts.map((contact) => contact.full_name || contact.email || contact.phone || "Contact").join(", "))}` : "No contact linked to this call."}</div>              ${linkedNotes.length ? `<div style="margin-top:8px;"><strong>Imported note:</strong> ${esc(linkedNotes[0].note_text || "")}</div>` : ""}              ${recordingUrl || callbackUrl ? `                <div class="lead-actions" style="margin-top:10px;">                  ${recordingUrl ? `<a class="btn-secondary" href="${esc(recordingUrl)}" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Recording</a>` : ""}                  ${callbackUrl ? `<a class="btn-secondary" href="${esc(callbackUrl)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> Callback Page</a>` : ""}                </div>              ` : ""}              ${fields.length ? `                <div class="lead-call-grid">                  ${fields.map((field) => `                    <div class="lead-call-field">                      <div class="k">${esc(field.label)}</div>                      <div class="v">${esc(field.value)}</div>                    </div>                  `).join("")}                </div>              ` : ""}              ${raw ? `                <details class="lead-history-details">                  <summary>All imported fields</summary>                  <pre class="lead-history-raw">${esc(raw)}</pre>                </details>              ` : ""}            </div>          `;
            })
            .join("")
        : '<div class="lead-empty">No call history yet.</div>'
    }      </div>    `;
  }
  function renderFollowupsSection(lead, state) {
    const followups = Array.isArray(lead.followups) ? lead.followups : [];
    const draft = state.followupDraft || {};
    const followupSaveState = state.saveStates?.followup || {};
    return `        <div class="lead-inline-form" style="margin-bottom:14px;" data-autosave-followup>        <div class="lead-inline-form-head">          ${renderSaveState(followupSaveState, "Autosaves when you leave the follow-up draft")}          <button class="btn-secondary" type="button" data-lead-clear-followup-draft>Clear Draft</button>        </div>        <div class="lead-quick-buttons">          ${["DM Call Back", "Report Feedback", "Email Check", "Other"].map((title) => `<button type="button" class="lead-quick-btn ${draft.title === title ? "active" : ""}" data-followup-title-preset="${esc(title)}">${esc(title)}</button>`).join("")}        </div>        <input class="lead-panel-input" data-lead-followup-title type="text" placeholder="Follow-up title" value="${esc(draft.title || "")}">        <textarea class="lead-panel-textarea" data-lead-followup-body rows="2" placeholder="Optional short note...">${esc(draft.body || "")}</textarea>          <div class="lead-quick-buttons">            <button type="button" class="lead-quick-btn" data-followup-date-offset="1">Tomorrow</button>            <button type="button" class="lead-quick-btn" data-followup-date-offset="3">3 Days</button>            <button type="button" class="lead-quick-btn" data-followup-date-offset="7">Next Week</button>          </div>          <div class="lead-followup-due-row">            <input class="lead-panel-input" data-lead-followup-due-at type="date" value="${esc(draft.due_at || defaultFollowupDate())}">          </div>        </div>        <div class="lead-followup-list">          ${followups.length ? followups.map((item) => `            <div class="lead-followup-item">              <div class="meta">${esc(item.owner_email || "-")} â€¢ ${esc(item.status || "open")} â€¢ ${esc(item.due_at ? fmtDay(item.due_at) : "No date")}</div>              <div class="lead-actions-inline">                <div class="lead-followup-main"><strong>${esc(item.title || "Follow-up")}</strong>${item.body ? `<div style="margin-top:6px;">${esc(item.body)}</div>` : ""}</div>                ${item.status === "open" ? `<button class="btn-secondary" type="button" data-lead-complete-followup="${esc(item.id)}">Mark Done</button>` : ""}              </div>            </div>          `).join("") : '<div class="lead-empty">No follow-ups yet.</div>'}        </div>      `;
  }
  function renderAccountSection(lead) {
    const org = lead.organization_snapshot;
    if (!org) {
      const linkedOrgId = String(lead.organization_id || "").trim();
      if (linkedOrgId) {
        const linkedOrgName = String(lead.metadata?.organization_name || "").trim();
        return `<div class="lead-empty">This lead is linked to customer ${esc(linkedOrgName || linkedOrgId)}, but that customer record could not be loaded.</div>`;
      }
      return '<div class="lead-empty">This lead has not been paired to a customer account yet.</div>';
    }
    const users = Array.isArray(org.users) ? org.users : [];
    const orders = Array.isArray(org.orders) ? org.orders : [];
    const contact = org.contact || {};
    const createdTs = org.created_at ? Date.parse(org.created_at) / 1000 : 0;
    const billingEvents = Array.isArray(org.billing_events)
      ? org.billing_events
      : [];
    return `      <div class="lead-viewer-grid" style="margin-bottom:12px;">        ${renderField("Age", `${fmtAgeFromTs(createdTs)}<div class="lead-field-foot">${esc(fmtTsMinute(createdTs))}</div>`, { html: true })}        ${renderField("Users", String((users || []).length))}        ${renderField("Lifetime Orders", String(org.lifetimeOrders ?? 0))}        ${renderField("Lifetime Revenue", `$${Number(org.lifetimeRevenue ?? 0).toLocaleString()}`)}        ${renderField("Rolling 7 Days", String(org.rolling7 ?? 0))}        ${renderField("Avg Orders / Day", String(org.avgOrdersDay ?? 0))}        ${renderField("Credits Balance", `$${Number(org.credits_balance || 0).toLocaleString()}`)}      </div>      ${renderSubsection("Organization Users", `${users.length} user${users.length === 1 ? "" : "s"}`, users.length ? `        <div style="overflow:auto;">          <table class="leads-table" style="border:none;border-radius:0;">            <thead>              <tr>                <th>Name</th>                <th>Email</th>                <th>Permission</th>                <th>Orders</th>                <th>Joined</th>              </tr>            </thead>            <tbody>              ${users.map((user) => `                <tr>                  <td>${esc(user.name || "-")}</td>                  <td>${esc(user.email || "-")}</td>                  <td>${esc(user.org_permission_level || "viewer")}</td>                  <td>${esc(String(user.orderCount ?? 0))}</td>                  <td>${esc(user.created_at ? fmtTs(Date.parse(user.created_at) / 1000) : "-")}</td>                </tr>              `).join("")}            </tbody>          </table>        </div>      ` : '<div class="lead-empty">No users in this organization.</div>', true)}      <div style="height:12px"></div>      ${renderSubsection(
      "Recent Orders",
      `${orders.length} order${orders.length === 1 ? "" : "s"}`,
      orders.length
        ? `        <div style="overflow:auto;">          <table class="leads-table" style="border:none;border-radius:0;">            <thead>              <tr>                <th>Project</th>                <th>Created</th>                <th>Status</th>                <th>Folder</th>              </tr>            </thead>            <tbody>              ${orders
            .slice()
            .sort(
              (a, b) =>
                new Date(b.created_at || 0) - new Date(a.created_at || 0),
            )
            .slice(0, 25)
            .map(
              (order) =>
                `                <tr>                  <td>${esc(order.name || order.project_name || order.id || "-")}</td>                  <td>${esc(order.created_at ? fmtTs(Date.parse(order.created_at) / 1000) : "-")}</td>                  <td>${esc(order.status || order.project_status || "-")}</td>                  <td>${esc(order.folder_id || order.folder || "-")}</td>                </tr>              `,
            )
            .join(
              "",
            )}            </tbody>          </table>        </div>      `
        : '<div class="lead-empty">No orders on this account yet.</div>',
      true,
    )}      <div style="height:12px"></div>      ${renderSubsection(
      "Billing History",
      `${billingEvents.length} event${billingEvents.length === 1 ? "" : "s"}`,
      billingEvents.length
        ? `        <div style="overflow:auto;">          <table class="leads-table" style="border:none;border-radius:0;">            <thead>              <tr>                <th>When</th>                <th>Type</th>                <th>Details</th>              </tr>            </thead>            <tbody>              ${billingEvents
            .slice(0, 25)
            .map(
              (event) =>
                `                <tr>                  <td>${esc(event.ts_utc ? new Date(event.ts_utc).toLocaleString() : "-")}</td>                  <td>${esc(event.type || "-")}</td>                  <td>${esc(typeof event.data === "object" ? JSON.stringify(event.data) : String(event.data || "-"))}</td>                </tr>              `,
            )
            .join(
              "",
            )}            </tbody>          </table>        </div>      `
        : '<div class="lead-empty">No billing history on this account yet.</div>',
      true,
    )}    `;
    return `      <div class="lead-viewer-grid" style="margin-bottom:12px;">        ${renderField("Organization", org.name || "")}        ${renderField("Org ID", org.id || "")}        ${renderField("Salesperson", salesperson)}        ${renderField("Created", org.created_at ? fmtTs(Date.parse(org.created_at) / 1000) : "-")}        ${renderField("Users", String((users || []).length))}        ${renderField("Lifetime Orders", String(org.lifetimeOrders ?? 0))}        ${renderField("Rolling 7 Days", String(org.rolling7 ?? 0))}        ${renderField("Avg Orders / Day", String(org.avgOrdersDay ?? 0))}        ${renderField("Credits Balance", `$${Number(org.credits_balance || 0).toLocaleString()}`)}        ${renderField("Contact Email", contact.email || "")}        ${renderField("Contact Phone", contact.phone || "")}        ${renderField("Contact Address", contact.address || "", { className: "address" })}      </div>      <div class="lead-section" style="margin-bottom:12px;">        <div class="lead-section-head" style="cursor:default;">          <div><h3>Organization Users</h3><div class="meta">${users.length} user${users.length === 1 ? "" : "s"}</div></div>        </div>        <div class="lead-section-body" style="padding:0;">          ${users.length ? `            <div style="overflow:auto;">              <table class="leads-table" style="border:none;border-radius:0;">                <thead>                  <tr>                    <th>Name</th>                    <th>Email</th>                    <th>Permission</th>                    <th>Orders</th>                    <th>Joined</th>                  </tr>                </thead>                <tbody>                  ${users.map((user) => `                    <tr>                      <td>${esc(user.name || "-")}</td>                      <td>${esc(user.email || "-")}</td>                      <td>${esc(user.org_permission_level || "viewer")}</td>                      <td>${esc(String(user.orderCount ?? 0))}</td>                      <td>${esc(user.created_at ? fmtTs(Date.parse(user.created_at) / 1000) : "-")}</td>                    </tr>                  `).join("")}                </tbody>              </table>            </div>          ` : '<div class="lead-empty">No users in this organization.</div>'}        </div>      </div>      <div class="lead-section">        <div class="lead-section-head" style="cursor:default;">          <div><h3>Recent Orders</h3><div class="meta">${orders.length} order${orders.length === 1 ? "" : "s"}</div></div>        </div>        <div class="lead-section-body" style="padding:0;">          ${
      orders.length
        ? `            <div style="overflow:auto;">              <table class="leads-table" style="border:none;border-radius:0;">                <thead>                  <tr>                    <th>Project</th>                    <th>Created</th>                    <th>Status</th>                    <th>Folder</th>                  </tr>                </thead>                <tbody>                  ${orders
            .slice()
            .sort(
              (a, b) =>
                new Date(b.created_at || 0) - new Date(a.created_at || 0),
            )
            .slice(0, 25)
            .map(
              (order) =>
                `                    <tr>                      <td>${esc(order.name || order.project_name || order.id || "-")}</td>                      <td>${esc(order.created_at ? fmtTs(Date.parse(order.created_at) / 1000) : "-")}</td>                      <td>${esc(order.status || order.project_status || "-")}</td>                      <td>${esc(order.folder_id || order.folder || "-")}</td>                    </tr>                  `,
            )
            .join(
              "",
            )}                </tbody>              </table>            </div>          `
        : '<div class="lead-empty">No orders on this account yet.</div>'
    }        </div>      </div>    `;
  }
  function mockupStageOptions() {
    return [
      "New",
      "Contacted",
      "Info Sent",
      "Info Received",
      "Signed Up",
      "Active Customer",
      "Lost",
      "Do Not Contact",
    ];
  }
  function normalizeStageLabel(value) {
    const raw = String(value || "").trim();
    if (!raw) return "Contacted";
    return raw.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }
  function fmtTimeShort(ts) {
    const n = Number(ts || 0);
    return n
      ? new Date(n * 1000).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : "-";
  }
  function fmtDateShort(ts) {
    const n = Number(ts || 0);
    return n
      ? new Date(n * 1000).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })
      : "-";
  }
  function fmtRelativeFromTs(ts) {
    const n = Number(ts || 0);
    if (!n) return "-";
    const diffMs = Date.now() - n * 1000;
    const diffMin = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return fmtDateShort(ts);
  }
  function isoDateFromTs(ts) {
    const n = Number(ts || 0);
    if (!n) return defaultFollowupDate();
    const d = new Date(n * 1000);
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function hasMeaningfulTime(ts) {
    const n = Number(ts || 0);
    if (!n) return false;
    const d = new Date(n * 1000);
    return d.getHours() !== 0 || d.getMinutes() !== 0;
  }
  function fmtUpcomingDue(ts) {
    return hasMeaningfulTime(ts) ? fmtTsMinute(ts) : fmtDay(ts);
  }
  function buildScheduledAtValue(draft) {
    const dueAt = String(draft?.followup_date || draft?.due_at || "").trim();
    if (!dueAt) return "";
    const slot = String(
      draft?.followup_slot || draft?.schedule_mode || "",
    ).trim();
    if (slot === "morning") return `${dueAt} 07:00`;
    if (slot === "afternoon") return `${dueAt} 12:00`;
    return dueAt;
  }
  function fmtDateLong(value) {
    const date = String(value || "").trim();
    if (!date) return "-";
    const parsed = new Date(`${date}T00:00:00`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : date;
  }
  function followupMode(draft) {
    const date = String(draft?.followup_date || draft?.due_at || "").trim();
    if (!date) return "none";
    return String(
      draft?.followup_slot || draft?.schedule_mode || "all_day",
    ).trim();
  }
  function meetingMode(draft) {
    const date = String(draft?.meeting_date || "").trim();
    const time = String(draft?.meeting_time || "").trim();
    return date && time ? "timed" : "none";
  }
  function hasPartialMeetingSelection(draft) {
    const hasDate = !!String(draft?.meeting_date || "").trim();
    const hasTime = !!String(draft?.meeting_time || "").trim();
    return (hasDate || hasTime) && !(hasDate && hasTime);
  }
  function createLocalTimestamp(dateValue, timeValue) {
    const date = String(dateValue || "").trim();
    const time = String(timeValue || "").trim();
    if (!date || !time) return 0;
    const local = new Date(`${date}T${time}:00`);
    const ms = local.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  function formatTimeRangeForZone(startTs, endTs, timeZone) {
    const start = Number(startTs || 0);
    const end = Number(endTs || 0);
    if (!start || !end || !timeZone) return "-";
    try {
      const formatter = new Intl.DateTimeFormat([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      });
      return `${formatter.format(new Date(start * 1000))} - ${formatter.format(new Date(end * 1000))}`;
    } catch (err) {
      return `${fmtTimeShort(start)} - ${fmtTimeShort(end)}`;
    }
  }
  function buildFollowupScheduleDetails(draft, leadTimeInfo, viewerTimeInfo) {
    const date = String(draft?.followup_date || draft?.due_at || "").trim();
    if (!date) {
      return {
        mode: "none",
        allDayDate: "",
        startTs: 0,
        endTs: 0,
        durationMinutes: 0,
        viewerSummary: "",
        leadSummary: "",
        headline: "",
      };
    }
    const mode = followupMode(draft);
    if (mode === "morning" || mode === "afternoon") {
      const preset = FOLLOWUP_WINDOW_PRESETS[mode];
      const startTs = createLocalTimestamp(date, preset.start);
      const endTs = createLocalTimestamp(date, preset.end);
      return {
        mode,
        allDayDate: "",
        startTs,
        endTs,
        durationMinutes: Math.max(15, Math.round((endTs - startTs) / 60)),
        viewerSummary: `${preset.label}: ${formatTimeRangeForZone(startTs, endTs, viewerTimeInfo?.timeZone)}`,
        leadSummary: `${preset.label}: ${formatTimeRangeForZone(startTs, endTs, leadTimeInfo?.timeZone || viewerTimeInfo?.timeZone)}`,
        headline: `${preset.label} follow-up on ${fmtDateLong(date)}`,
      };
    }
    return {
      mode: "all_day",
      allDayDate: date,
      startTs: 0,
      endTs: 0,
      durationMinutes: 0,
      viewerSummary: "All day",
      leadSummary: "All day",
      headline: `All-day follow-up on ${fmtDateLong(date)}`,
    };
  }
  function buildMeetingScheduleDetails(draft, leadTimeInfo, viewerTimeInfo) {
    const date = String(draft?.meeting_date || "").trim();
    const time = String(draft?.meeting_time || "").trim();
    if (!date || !time) {
      return {
        mode: "none",
        allDay: false,
        allDayDate: "",
        startTs: 0,
        endTs: 0,
        durationMinutes: Math.max(
          15,
          Number(draft?.duration_minutes || 30) || 30,
        ),
        viewerSummary: "",
        leadSummary: "",
        headline: "",
      };
    }
    const durationMinutes = Math.max(
      15,
      Number(draft?.duration_minutes || 30) || 30,
    );
    const startTs = createLocalTimestamp(date, time);
    const endTs = startTs ? startTs + durationMinutes * 60 : 0;
    return {
      mode: "timed",
      allDay: false,
      allDayDate: "",
      startTs,
      endTs,
      durationMinutes,
      viewerSummary: formatTimeRangeForZone(
        startTs,
        endTs,
        viewerTimeInfo?.timeZone,
      ),
      leadSummary: formatTimeRangeForZone(
        startTs,
        endTs,
        leadTimeInfo?.timeZone || viewerTimeInfo?.timeZone,
      ),
      headline: `Meeting on ${fmtDateLong(date)}`,
    };
  }
  function googleCalendarEventRangeLabel(event, timeZone) {
    const start = event?.start || {};
    const end = event?.end || {};
    const startDate = String(start.date || "").trim();
    const endDate = String(end.date || "").trim();
    if (startDate) {
      return "All day";
    }
    const startDateTime = String(start.dateTime || "").trim();
    const endDateTime = String(end.dateTime || "").trim();
    if (!startDateTime) return "-";
    try {
      const startValue = new Date(startDateTime);
      const endValue = endDateTime ? new Date(endDateTime) : null;
      const format = new Intl.DateTimeFormat([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timeZone || undefined,
      });
      return endValue
        ? `${format.format(startValue)} - ${format.format(endValue)}`
        : format.format(startValue);
    } catch (err) {
      return startDateTime;
    }
  }
  function calendarDatePartsInZone(value, timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone || undefined,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const partMap = {};
      formatter.formatToParts(date).forEach((part) => {
        if (part.type !== "literal") partMap[part.type] = part.value;
      });
      return {
        year: String(partMap.year || ""),
        month: String(partMap.month || "").padStart(2, "0"),
        day: String(partMap.day || "").padStart(2, "0"),
        hour: Number(partMap.hour || 0) % 24,
        minute: Number(partMap.minute || 0) || 0,
      };
    } catch (err) {
      return {
        year: String(date.getFullYear()),
        month: String(date.getMonth() + 1).padStart(2, "0"),
        day: String(date.getDate()).padStart(2, "0"),
        hour: date.getHours(),
        minute: date.getMinutes(),
      };
    }
  }
  function calendarDateKeyForZone(value, timeZone) {
    const parts = calendarDatePartsInZone(value, timeZone);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
  }
  function calendarMinutesIntoDay(value, timeZone) {
    const parts = calendarDatePartsInZone(value, timeZone);
    if (!parts) return 0;
    return Math.max(
      0,
      Math.min(
        CALENDAR_DAY_TOTAL_MINUTES,
        Number(parts.hour || 0) * 60 + Number(parts.minute || 0),
      ),
    );
  }
  function calendarHourLabel(hour) {
    const normalized = Number(hour || 0) % 24;
    const suffix = normalized >= 12 ? "PM" : "AM";
    const displayHour = normalized % 12 === 0 ? 12 : normalized % 12;
    return `${displayHour} ${suffix}`;
  }
  function normalizeCalendarEventForDay(event, timeZone, dayKey) {
    const start = event?.start || {};
    const end = event?.end || {};
    const startDate = String(start.date || "").trim();
    if (startDate) {
      return {
        id: String(event?.id || startDate),
        summary: String(event?.summary || "Busy"),
        range: googleCalendarEventRangeLabel(event, timeZone),
        htmlLink: String(event?.htmlLink || event?.html_link || ""),
        hasMeet: !!String(event?.hangoutLink || event?.hangout_link || "").trim(),
        allDay: true,
        isDraft: false,
        leadRange: "",
      };
    }
    const startDateTime = String(start.dateTime || "").trim();
    if (!startDateTime) return null;
    const startDateValue = new Date(startDateTime);
    if (!Number.isFinite(startDateValue.getTime())) return null;
    const endDateTime = String(end.dateTime || "").trim();
    const endDateValue = endDateTime ? new Date(endDateTime) : null;
    const safeEndDate =
      endDateValue instanceof Date && Number.isFinite(endDateValue.getTime())
        ? endDateValue
        : new Date(startDateValue.getTime() + 30 * 60 * 1000);
    const startKey = calendarDateKeyForZone(startDateValue, timeZone);
    const endKey = calendarDateKeyForZone(safeEndDate, timeZone);
    let startMinute = startKey && startKey < dayKey ? 0 : calendarMinutesIntoDay(startDateValue, timeZone);
    let endMinute =
      endKey && endKey > dayKey
        ? CALENDAR_DAY_TOTAL_MINUTES
        : calendarMinutesIntoDay(safeEndDate, timeZone);
    if (endKey && endKey !== dayKey && endMinute === 0) {
      endMinute = CALENDAR_DAY_TOTAL_MINUTES;
    }
    if (endMinute <= startMinute) {
      endMinute = Math.min(CALENDAR_DAY_TOTAL_MINUTES, startMinute + 30);
    }
    return {
      id: String(event?.id || `${startDateTime}-${endDateTime}`),
      summary: String(event?.summary || "Busy"),
      range: googleCalendarEventRangeLabel(event, timeZone),
      htmlLink: String(event?.htmlLink || event?.html_link || ""),
      hasMeet: !!String(event?.hangoutLink || event?.hangout_link || "").trim(),
      startMinute,
      endMinute,
      allDay: false,
      isDraft: false,
      leadRange: "",
    };
  }
  function layoutCalendarTimedEvents(events) {
    const ordered = (Array.isArray(events) ? events : [])
      .filter((event) => !event?.allDay)
      .map((event) => ({ ...event }))
      .sort((a, b) => {
        if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
        if (a.endMinute !== b.endMinute) return b.endMinute - a.endMinute;
        return String(a.summary || "").localeCompare(String(b.summary || ""));
      });
    const finalizeGroup = (group) => {
      if (!group.length) return;
      const columnCount = group.reduce(
        (max, event) => Math.max(max, Number(event.column || 0) + 1),
        1,
      );
      group.forEach((event) => {
        event.columnCount = columnCount;
      });
    };
    let active = [];
    let group = [];
    ordered.forEach((event) => {
      active = active.filter((item) => Number(item.endMinute || 0) > Number(event.startMinute || 0));
      if (!active.length) {
        finalizeGroup(group);
        group = [];
      }
      const usedColumns = new Set(active.map((item) => Number(item.column || 0)));
      let column = 0;
      while (usedColumns.has(column)) column += 1;
      event.column = column;
      active.push(event);
      group.push(event);
    });
    finalizeGroup(group);
    return ordered.map((event) => {
      const columnCount = Math.max(1, Number(event.columnCount || 1));
      const columnWidth = 100 / columnCount;
      const peek = columnCount > 1 ? Math.min(CALENDAR_DAY_OVERLAP_PEEK, columnWidth * 0.28) : 0;
      const leftPct = columnCount > 1 ? Number(event.column || 0) * Math.max(0, columnWidth - peek) : 0;
      const widthPct =
        Number(event.column || 0) === columnCount - 1
          ? 100 - leftPct
          : Math.min(100 - leftPct, columnWidth + peek);
      const topPx = (Number(event.startMinute || 0) / 60) * CALENDAR_DAY_HOUR_HEIGHT;
      const heightPx = Math.max(
        CALENDAR_DAY_MIN_EVENT_HEIGHT,
        (Math.max(Number(event.endMinute || 0) - Number(event.startMinute || 0), 15) / 60) *
          CALENDAR_DAY_HOUR_HEIGHT,
      );
      return {
        ...event,
        leftPct,
        widthPct,
        topPx,
        heightPx,
        compact: heightPx < 44,
        zIndex: event.isDraft ? 60 : 10 + Number(event.column || 0),
      };
    });
  }
  function buildMeetingDayViewModel(events, timeZone, dateValue, selectedSchedule) {
    const dayKey = String(dateValue || "").trim();
    const normalized = (Array.isArray(events) ? events : [])
      .map((event) => normalizeCalendarEventForDay(event, timeZone, dayKey))
      .filter(Boolean);
    if (
      selectedSchedule?.mode === "timed" &&
      dayKey &&
      String(selectedSchedule?.headline || "").trim()
    ) {
      normalized.push({
        id: "__selected_meeting__",
        summary: "Selected meeting",
        range: String(selectedSchedule.viewerSummary || "").trim() || "Selected time",
        leadRange: String(selectedSchedule.leadSummary || "").trim(),
        htmlLink: "",
        hasMeet: false,
        startMinute: Math.max(
          0,
          Math.min(
            CALENDAR_DAY_TOTAL_MINUTES,
            calendarMinutesIntoDay(
              new Date(Number(selectedSchedule.startTs || 0) * 1000),
              timeZone,
            ),
          ),
        ),
        endMinute: Math.max(
          0,
          Math.min(
            CALENDAR_DAY_TOTAL_MINUTES,
            calendarMinutesIntoDay(
              new Date(Number(selectedSchedule.endTs || 0) * 1000),
              timeZone,
            ),
          ),
        ),
        allDay: false,
        isDraft: true,
      });
    }
    return {
      totalHeightPx: 24 * CALENDAR_DAY_HOUR_HEIGHT,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: calendarHourLabel(hour),
        topPx: hour * CALENDAR_DAY_HOUR_HEIGHT,
      })),
      allDayEvents: normalized.filter((event) => event.allDay),
      timedEvents: layoutCalendarTimedEvents(normalized),
    };
  }
  function renderMeetingDayView(model, dateValue) {
    const dayView = model || {
      totalHeightPx: 24 * CALENDAR_DAY_HOUR_HEIGHT,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: calendarHourLabel(hour),
        topPx: hour * CALENDAR_DAY_HOUR_HEIGHT,
      })),
      allDayEvents: [],
      timedEvents: [],
    };
    const allDayHtml = dayView.allDayEvents.length
      ? `
          <div class="lead-page-v5-calendar-allday">
            <div class="lead-page-v5-calendar-allday-label">All Day</div>
            <div class="lead-page-v5-calendar-allday-list">
              ${dayView.allDayEvents
                .map(
                  (event) => `<div class="lead-page-v5-calendar-allday-chip ${event.isDraft ? "selected" : ""}" title="${esc(`${event.summary} - ${event.range}`)}">
                      ${event.hasMeet ? `<i class="fas fa-video"></i>` : `<i class="fas fa-calendar-day"></i>`}
                      <span>${esc(event.summary)}</span>
                    </div>`,
                )
                .join("")}
            </div>
          </div>
        `
      : "";
    const timedHtml = dayView.timedEvents
      .map((event) => {
        const style = [
          `top:${Number(event.topPx || 0).toFixed(2)}px`,
          `height:${Number(event.heightPx || 0).toFixed(2)}px`,
          `left:${Number(event.leftPct || 0).toFixed(2)}%`,
          `width:${Number(event.widthPct || 100).toFixed(2)}%`,
          `z-index:${Number(event.zIndex || 1)}`,
        ].join(";");
        const meta = `${event.range}${event.hasMeet ? " | Google Meet" : ""}`;
        return `
          <div class="lead-page-v5-calendar-block ${event.isDraft ? "selected" : ""} ${event.compact ? "compact" : ""}" style="${style}">
            <div class="lead-page-v5-calendar-block-title">${esc(event.summary)}</div>
            <div class="lead-page-v5-calendar-block-meta">${esc(meta)}</div>
            ${event.htmlLink ? `<a class="lead-page-v5-calendar-block-open" href="${esc(event.htmlLink)}" target="_blank" rel="noopener" aria-label="Open calendar event"><i class="fas fa-up-right-from-square"></i></a>` : ""}
            <div class="lead-page-v5-calendar-block-tooltip">
              <div class="lead-page-v5-calendar-tooltip-title">${esc(event.summary)}</div>
              <div class="lead-page-v5-calendar-tooltip-copy">${esc(meta)}</div>
              ${event.leadRange ? `<div class="lead-page-v5-calendar-tooltip-copy">Lead time: ${esc(event.leadRange)}</div>` : ""}
              ${event.isDraft ? `<div class="lead-page-v5-calendar-tooltip-copy">This is the slot you currently have selected.</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");
    return `
      <div class="lead-page-v5-calendar-day-shell">
        <div class="lead-page-v5-calendar-day-hint">Hover an event to inspect it. Scroll the day to review earlier or later times.</div>
        ${allDayHtml}
        <div class="lead-page-v5-calendar-scroll" data-lead-calendar-day-scroll data-calendar-date="${esc(dateValue)}">
          <div class="lead-page-v5-calendar-grid" style="height:${Number(dayView.totalHeightPx || 0)}px">
            <div class="lead-page-v5-calendar-gutter">
              ${dayView.hours
                .map(
                  (hour) => `<div class="lead-page-v5-calendar-hour" style="top:${Number(hour.topPx || 0)}px">
                      <div class="lead-page-v5-calendar-hour-label">${esc(hour.label)}</div>
                    </div>`,
                )
                .join("")}
            </div>
            <div class="lead-page-v5-calendar-track">
              <div class="lead-page-v5-calendar-event-canvas">
                ${timedHtml || `<div class="lead-page-v5-calendar-empty-state">No timed Google Calendar events on ${esc(fmtDateLong(dateValue))}.</div>`}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  function buildAutoFollowupTitle(draft) {
    const mode = followupMode(draft);
    if (mode === "morning") return "Morning Follow-Up";
    if (mode === "afternoon") return "Afternoon Follow-Up";
    return "Follow-Up";
  }
  function buildAutoMeetingTitle(lead) {
    return `Meeting with ${lead?.company || "Lead"}`;
  }
  function activeSequenceInfo(lead) {
    return lead?.crm?.active_sequence || null;
  }
  function normalizeLeadRecipientEmail(value) {
    const email = String(value || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  }
  function leadContactEmailsForUi(contact) {
    const emails = [];
    const primary = normalizeLeadRecipientEmail(contact?.email || "");
    if (primary) emails.push(primary);
    const secondary = Array.isArray(contact?.secondary_emails)
      ? contact.secondary_emails
      : [];
    secondary.forEach((email) => {
      const normalized = normalizeLeadRecipientEmail(email);
      if (normalized) emails.push(normalized);
    });
    return Array.from(new Set(emails));
  }
  function leadContactDisplayNameForUi(contact) {
    return (
      String(contact?.full_name || "").trim() ||
      String(contact?.email || "").trim() ||
      String(contact?.phone || "").trim() ||
      "Contact"
    );
  }
  function leadPreferredContactEmailForUi(contact) {
    return leadContactEmailsForUi(contact)[0] || "";
  }
  function leadContactIsPrimaryForUi(contact) {
    return !!contact?.metadata?.is_primary;
  }
  function normalizeLeadPhoneForUi(value) {
    const raw = String(value || "").trim();
    const digits = raw.replace(/\D+/g, "");
    if (!digits) return "";
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+1${digits.slice(1)}`;
    }
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    return raw;
  }
  function leadContactPhonesForUi(contact) {
    const phones = [];
    const primary = normalizeLeadPhoneForUi(contact?.phone || "");
    if (primary) phones.push(primary);
    const secondary = Array.isArray(contact?.secondary_phones)
      ? contact.secondary_phones
      : [];
    secondary.forEach((phone) => {
      const normalized = normalizeLeadPhoneForUi(phone);
      if (normalized) phones.push(normalized);
    });
    return Array.from(new Set(phones));
  }
  function leadPreferredContactPhoneForUi(contact) {
    return leadContactPhonesForUi(contact)[0] || "";
  }
  function leadCompanyRecipientForUi(lead, state) {
    const draft = state?.leadCoreDraft || {};
    return {
      id: COMPANY_RECIPIENT_ID,
      full_name: "Company",
      email: String(draft.email || lead?.email || "").trim(),
      phone: String(draft.phone || lead?.phone || "").trim(),
      secondary_emails: [],
      secondary_phones: [],
      metadata: { is_company: true },
    };
  }
  function normalizeEmailBrandingInputForRender(value) {
    const raw = value && typeof value === "object" ? value : {};
    const normalizeColor = (color) => {
      const next = String(color || "").trim();
      if (!next) return "";
      const prefixed = next.startsWith("#") ? next : `#${next}`;
      return /^#[0-9a-fA-F]{6}$/.test(prefixed) ? prefixed.toLowerCase() : "";
    };
    const logoDataUrl = String(
      raw.logoDataUrl || raw.logo_data_url || "",
    ).trim();
    return {
      primaryColor: normalizeColor(raw.primaryColor || raw.primary_color),
      secondaryColor: normalizeColor(raw.secondaryColor || raw.secondary_color),
      logoDataUrl: /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(logoDataUrl)
        ? logoDataUrl
        : "",
    };
  }
  function emailBrandingDefaultsForLead(lead) {
    return normalizeEmailBrandingInputForRender(lead?.crm?.email_assets?.branding);
  }
  function emailReportTemplatesForLead(lead) {
    return Array.isArray(lead?.crm?.email_assets?.report_templates)
      ? lead.crm.email_assets.report_templates
      : [];
  }
  function normalizeEmailAttachmentSelectionsForRender(lead, value) {
    const templateMap = new Map(
      emailReportTemplatesForLead(lead).map((item) => [
        String(item?.id || "").trim(),
        item,
      ]),
    );
    const items = Array.isArray(value) ? value : [];
    const next = [];
    const seen = new Set();
    items.forEach((entry) => {
      const id = String(entry?.id || "").trim();
      if (!id || seen.has(id) || !templateMap.has(id)) return;
      seen.add(id);
      const template = templateMap.get(id) || {};
      const mode = ["summary", "full", "both"].includes(
        String(entry?.mode || "").trim(),
      )
        ? String(entry.mode).trim()
        : "summary";
      next.push({
        id,
        label:
          String(entry?.label || "").trim() ||
          String(template?.label || template?.name || id).trim(),
        mode,
        file_names: Array.isArray(entry?.file_names)
          ? entry.file_names.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
      });
    });
    return next;
  }
  function emailAttachmentSelectionForRender(lead, state, id) {
    return normalizeEmailAttachmentSelectionsForRender(
      lead,
      state?.ui?.emailCompose?.attachments,
    ).find((item) => String(item.id) === String(id));
  }
  function buildFallbackSignatureHtmlForRender() {
    const name = esc(
      window.Portal?.cfg?.user?.name ||
        window.Portal?.cfg?.user?.email ||
        "First Mate",
    );
    const email = esc(window.Portal?.cfg?.user?.email || "");
    return `<div><strong>${name}</strong>${email ? `<br>${email}` : ""}<br>First Mate</div>`;
  }
  function emailSignatureHtmlForLead(lead, compose) {
    return (
      String(compose?.signatureHtml || "").trim() ||
      String(lead?.crm?.gmail?.signature_html || "").trim() ||
      buildFallbackSignatureHtmlForRender()
    );
  }
  function findLeadContactForEmailUi(contacts, email) {
    const normalized = normalizeLeadRecipientEmail(email);
    if (!normalized) return null;
    return (
      (Array.isArray(contacts) ? contacts : []).find((contact) =>
        leadContactEmailsForUi(contact).includes(normalized),
      ) || null
    );
  }
  function renderLeadMultilineHtml(text) {
    return esc(text || "").replace(/\n/g, "<br>");
  }
  function renderMockupContacts(lead, state) {
    const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
    const notesMap = lead.contact_notes || {};
    const draft = state.contactDraft || {};
    const selectedTitle = draft.title_preset || "";
    const contactSaveState = state.saveStates?.contact || {};
    const canSetPrimary = true;
    const showForm =
      !!state.ui?.contactFormOpen ||
      !!draft.contact_id ||
      ["full_name", "title", "email", "phone", "notes"].some(
        (key) => String(draft[key] || "").trim() !== "",
      );
    return `      <div class="lead-page-v5-contact-row">        ${contacts.map((contact) => {
      const contactNotes = Array.isArray(notesMap[contact.id])
        ? notesMap[contact.id]
        : [];
      return `          <div class="lead-page-v5-contact-card ${String(draft.contact_id || "") === String(contact.id) ? "active" : ""}">            <div class="lead-page-v5-contact-name">${leadContactIsPrimaryForUi(contact) ? '<i class="fas fa-star" style="color:#d97706;font-size:11px;margin-right:3px"></i>' : '<i class="far fa-star" style="color:var(--s3);font-size:11px;margin-right:3px"></i>'}${esc(contact.full_name || contact.email || contact.phone || "Unnamed Contact")}</div>            <div class="lead-page-v5-contact-sub">${esc([contact.title, contact.email, contact.phone].filter(Boolean).join(" | ") || "No direct details yet")}</div>            ${contact.notes ? `<div class="lead-inline-status" style="margin-top:8px">${esc(contact.notes)}</div>` : ""}            <div class="lead-contact-note-list" style="margin-top:8px">              ${contactNotes.length ? contactNotes.slice(0, 3).map((item) => `                <div class="lead-contact-note-item">                  <div class="meta">${esc(item.owner_email || "-")} • ${esc(fmtTs(item.created_at))}</div>                  <div>${esc(item.note_text || "")}</div>                </div>              `).join("") : '<div class="lead-inline-status">No short notes yet.</div>'}            </div>            <div class="lead-page-v5-contact-actions">              <button class="lead-page-v5-pill-btn" type="button" data-lead-edit-contact="${esc(contact.id)}">Edit</button>              <button class="lead-page-v5-pill-btn" type="button" data-lead-open-contact-note="${esc(contact.id)}">Add Note</button>              ${canSetPrimary ? `<button class="lead-page-v5-pill-btn" type="button" data-lead-set-primary-contact="${esc(contact.id)}" ${leadContactIsPrimaryForUi(contact) ? 'disabled style="opacity:.55;cursor:default" title="Already the primary contact"' : 'title="Make this the primary contact"'}>${leadContactIsPrimaryForUi(contact) ? "Primary" : "Set Primary"}</button>` : ""}            </div>            ${String(state.contactNoteTargetId || "") === String(contact.id) ? `              <div class="lead-inline-form" data-autosave-contact-note="${esc(contact.id)}">                <div class="lead-inline-form-head">                  ${renderSaveState(state.contactNoteSaveStates?.[contact.id], "Autosaves when you leave this note")}                  <button class="lead-page-v5-pill-btn" type="button" data-lead-cancel-contact-note="${esc(contact.id)}">Close</button>                </div>                <textarea class="lead-page-v5-textarea lead-panel-textarea" rows="2" data-lead-contact-note-input="${esc(contact.id)}" placeholder="Short contact note...">${esc(state.contactNoteDrafts?.[contact.id] || "")}</textarea>              </div>            ` : ""}          </div>        `;
    }).join("")}        <button class="lead-page-v5-add-contact" type="button" data-lead-toggle-contact-form><i class="fas fa-plus"></i> Add</button>      </div>      ${showForm ? `        <div class="lead-page-v5-contact-form" data-autosave-contact>          <div class="lead-inline-status">${renderSaveState(contactSaveState, "Autosaves when you leave this form")}</div>          <input class="lead-page-v5-input lead-panel-input" data-lead-contact-name type="text" placeholder="Contact name" value="${esc(draft.full_name || "")}">          <div class="lead-page-v5-contact-roles">            ${["Receptionist", "Owner", "Manager", "Other"].map((title) => `              <button type="button" class="lead-page-v5-contact-role ${selectedTitle === title ? "active" : ""}" data-contact-title-preset="${esc(title)}">${esc(title)}</button>            `).join("")}          </div>          ${selectedTitle === "Other" ? `<input class="lead-page-v5-input lead-panel-input" data-lead-contact-title type="text" placeholder="Custom title..." value="${esc(draft.title || "")}">` : `<input class="lead-page-v5-input lead-panel-input" data-lead-contact-title type="text" placeholder="Title" value="${esc(draft.title || "")}" style="display:none">`}          <div class="lead-page-v5-contact-grid">            <input class="lead-page-v5-input lead-panel-input" data-lead-contact-email type="email" placeholder="Direct email" value="${esc(draft.email || "")}">            <input class="lead-page-v5-input lead-panel-input" data-lead-contact-phone type="text" placeholder="Direct phone" value="${esc(draft.phone || "")}">          </div>          <textarea class="lead-page-v5-textarea lead-panel-textarea" data-lead-contact-notes rows="2" placeholder="Quick note">${esc(draft.notes || "")}</textarea>          <div style="display:flex;gap:6px">            <button class="lead-page-v5-btn-primary" type="button" data-lead-toggle-contact-form>${draft.contact_id ? "Done" : "Add Contact"}</button>            <button class="lead-page-v5-btn-secondary" type="button" data-lead-clear-contact-draft>Cancel</button>          </div>        </div>      ` : ""}    `;
  }
  function renderMockupAccount(lead, state) {
    const org = lead.organization_snapshot;
    const tab = state.ui?.accountTab || "ov";
    if (!org) {
      const linkedOrgId = String(lead.organization_id || "").trim();
      if (linkedOrgId) {
        const linkedOrgName = String(lead.metadata?.organization_name || "").trim();
        return `<div class="lead-page-v5-empty">This lead is linked to customer ${esc(linkedOrgName || linkedOrgId)}, but that customer record could not be loaded.</div>`;
      }
      return '<div class="lead-page-v5-empty">This lead has not been paired to a customer account yet.</div>';
    }
    const users = Array.isArray(org.users) ? org.users : [];
    const orders = Array.isArray(org.orders) ? org.orders : [];
    const billingEvents = Array.isArray(org.billing_events)
      ? org.billing_events
      : [];
    const creditsLedger = Array.isArray(org.credits_ledger)
      ? org.credits_ledger
      : [];
    const createdTs = org.created_at ? Date.parse(org.created_at) / 1000 : 0;
    const contact = org.contact || {};
    const customerName =
      String(contact.name || contact.full_name || "").trim() || "-";
    const signedUpCompany = String(org.name || lead.company || "").trim() || "-";
    const billing = org.billing || {};
    const autoTopup = billing.auto_topup || {};
    const stripe = billing.stripe || {};
    const autoTopupEnabled = !!autoTopup.enabled;
    const autoTopupStatus = String(
      autoTopup.status || (autoTopupEnabled ? "ok" : "idle"),
    )
      .replace(/_/g, " ")
      .trim();
    const stripeLabel = stripe.has_payment_method
      ? [String(stripe.brand || "").toUpperCase(), stripe.last4 ? `•••• ${stripe.last4}` : "", stripe.exp_month && stripe.exp_year ? `Exp ${stripe.exp_month}/${stripe.exp_year}` : ""]
          .filter(Boolean)
          .join(" | ")
      : "No saved payment method";
    const lastAttemptLabel = autoTopup.last_attempt_utc
      ? new Date(autoTopup.last_attempt_utc).toLocaleString()
      : "-";
    const lastSuccessLabel = autoTopup.last_success_utc
      ? new Date(autoTopup.last_success_utc).toLocaleString()
      : "-";
    const creditsBalanceLabel = `$${Number(org.credits_balance || 0).toLocaleString()}`;
    const creditSaveState = state.saveStates?.accountBilling || {};
    const creditAmount = String(state.ui?.billingCreditAmount || "");
    const creditNote = String(state.ui?.billingCreditNote || "");
    return `      <div class="lead-page-v5-subsection-head"><h4>Account</h4><span style="font-size:10px;color:var(--g);font-weight:700"><i class="fas fa-link"></i> Linked</span></div>      <div class="lead-page-v5-account-tabs">        <button class="lead-page-v5-account-tab ${tab === "ov" ? "active" : ""}" type="button" data-lead-account-tab="ov">Overview</button>        <button class="lead-page-v5-account-tab ${tab === "us" ? "active" : ""}" type="button" data-lead-account-tab="us">Users</button>        <button class="lead-page-v5-account-tab ${tab === "bi" ? "active" : ""}" type="button" data-lead-account-tab="bi">Billing</button>      </div>      <div class="lead-page-v5-account-panel ${tab === "ov" ? "active" : ""}">        <table class="lead-page-v5-info-table">          <tr><td class="k">Company</td><td class="v">${esc(org.name || lead.company || "-")}</td></tr>          <tr><td class="k">Customer</td><td class="v">${esc(customerName)}</td></tr>          <tr><td class="k">Signed Up As</td><td class="v">${esc(signedUpCompany)}</td></tr>          <tr><td class="k">Email</td><td class="v">${esc(contact.email || lead.email || "-")}</td></tr>          <tr><td class="k">Phone</td><td class="v">${esc(contact.phone || lead.phone || "-")}</td></tr>        </table>        <div class="lead-page-v5-account-metrics">          <div class="lead-page-v5-account-metric"><div class="k">Age</div><div class="v">${esc(fmtAgeFromTs(createdTs))}</div></div>          <div class="lead-page-v5-account-metric"><div class="k">Orders</div><div class="v">${esc(String(org.lifetimeOrders ?? orders.length))}</div></div>          <div class="lead-page-v5-account-metric"><div class="k">Revenue</div><div class="v">$${esc(Number(org.lifetimeRevenue ?? 0).toLocaleString())}</div></div>          <div class="lead-page-v5-account-metric"><div class="k">Credits</div><div class="v">$${esc(Number(org.credits_balance || 0).toLocaleString())}</div></div>          <div class="lead-page-v5-account-metric"><div class="k">7-Day</div><div class="v">${esc(String(org.rolling7 ?? 0))}</div></div>          <div class="lead-page-v5-account-metric"><div class="k">Avg/Day</div><div class="v">${esc(String(org.avgOrdersDay ?? 0))}</div></div>        </div>      </div>      <div class="lead-page-v5-account-panel ${tab === "us" ? "active" : ""}">        <table style="width:100%;font-size:12px;border-collapse:collapse">          <thead><tr style="border-bottom:1px solid var(--s2)"><th style="text-align:left;padding:6px 0;font-size:10px;color:var(--s4);font-weight:800;text-transform:uppercase">Name</th><th style="text-align:left;padding:6px;font-size:10px;color:var(--s4);font-weight:800;text-transform:uppercase">Email</th><th style="text-align:left;padding:6px;font-size:10px;color:var(--s4);font-weight:800;text-transform:uppercase">Role</th><th style="text-align:right;padding:6px 0;font-size:10px;color:var(--s4);font-weight:800;text-transform:uppercase">Orders</th></tr></thead>          <tbody>            ${users.length ? users.map((user) => `<tr style="border-bottom:1px solid var(--s1)"><td style="padding:8px 0;font-weight:600">${esc(user.name || "-")}</td><td style="padding:8px">${esc(user.email || "-")}</td><td>${esc(user.org_permission_level || "viewer")}</td><td style="text-align:right;font-weight:700">${esc(String(user.orderCount ?? 0))}</td></tr>`).join("") : '<tr><td colspan="4" class="lead-page-v5-empty">No users yet.</td></tr>'}          </tbody>        </table>      </div>      <div class="lead-page-v5-account-panel ${tab === "bi" ? "active" : ""}">        <div style="background:var(--s0);border:1px solid var(--s2);border-radius:var(--rs);padding:10px;margin-bottom:12px;font-size:12px">          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">            <div><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Auto Top-Up</div><div style="font-size:14px;font-weight:800;color:${autoTopupEnabled ? "var(--g)" : "var(--s8)"};margin-top:2px">${esc(autoTopupEnabled ? "Enabled" : "Disabled")}</div></div>            <div><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Status</div><div style="font-size:14px;font-weight:800;color:var(--s8);margin-top:2px">${esc(autoTopupStatus || "-")}</div></div>            <div><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Threshold</div><div style="font-size:14px;font-weight:800;color:var(--s8);margin-top:2px">$${esc(String(Number(autoTopup.threshold_dollars || 0).toLocaleString()))}</div></div>            <div><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Top-Up Amount</div><div style="font-size:14px;font-weight:800;color:var(--s8);margin-top:2px">$${esc(String(Number(autoTopup.topup_dollars || 0).toLocaleString()))}</div></div>          </div>          <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--s1)">            <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Saved Card</div>            <div style="font-size:12px;font-weight:700;color:var(--s8);margin-top:3px">${esc(stripeLabel)}</div>            <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--s5)">              <span><strong style="color:var(--s7)">Last Attempt:</strong> ${esc(lastAttemptLabel)}</span>              <span><strong style="color:var(--s7)">Last Success:</strong> ${esc(lastSuccessLabel)}</span>            </div>            ${autoTopup.last_error ? `<div style="margin-top:8px;color:var(--red);font-size:11px;font-weight:700">${esc(autoTopup.last_error)}</div>` : ""}          </div>        </div>        <div style="display:grid;gap:10px;margin-bottom:12px">          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px;border:1px solid var(--s2);border-radius:var(--rs);background:#fff">            <div>              <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em">Current Credits</div>              <div style="font-size:18px;font-weight:900;color:var(--s8);margin-top:2px">${esc(creditsBalanceLabel)}</div>            </div>            <div style="min-width:min(100%,300px);flex:1;display:grid;gap:6px">              <div class="lead-inline-status">${renderSaveState(creditSaveState, "Adds free credits to this customer account")}</div>              <div style="display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:6px;align-items:center">                <input class="lead-page-v5-input" data-lead-billing-credit-amount type="number" min="1" step="1" placeholder="Credits" value="${esc(creditAmount)}">                <input class="lead-page-v5-input" data-lead-billing-credit-note type="text" placeholder="Optional internal note" value="${esc(creditNote)}">                <button class="lead-page-v5-btn-secondary" type="button" data-lead-assign-org-credits><i class="fas fa-gift"></i> Assign Credits</button>              </div>            </div>          </div>          <div style="border:1px solid var(--s2);border-radius:var(--rs);background:#fff;padding:10px">            <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em;margin-bottom:8px">Recent Credit Activity</div>            ${creditsLedger.length ? creditsLedger.slice(0, 5).map((entry) => `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--s1);font-size:12px"><div><div style="font-weight:700;color:var(--s8)">${esc(String(entry.reason || "credit_activity").replace(/_/g, " "))}</div><div style="color:var(--s4);font-size:11px">${esc(entry.ts ? new Date(entry.ts).toLocaleString() : "-")}</div></div><div style="text-align:right"><div style="font-weight:900;color:${Number(entry.delta || entry.amount || 0) >= 0 ? "var(--g)" : "var(--red)"}">${Number(entry.delta || entry.amount || 0) >= 0 ? "+" : ""}$${esc(String(Number(entry.delta || entry.amount || 0).toLocaleString()))}</div>${entry.meta && entry.meta.note ? `<div style="color:var(--s4);font-size:11px;margin-top:2px">${esc(String(entry.meta.note || ""))}</div>` : ""}</div></div>`).join("") : '<div class="lead-page-v5-empty">No credit activity yet.</div>'}          </div>        </div>        <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:var(--s4);letter-spacing:.04em;margin-bottom:8px">Billing History</div>        ${
      billingEvents.length
        ? billingEvents
            .slice(0, 5)
            .map(
              (event) =>
                `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--s1);font-size:12px"><div><span style="font-weight:700;color:var(--s8)">${esc(event.type || "Billing Event")}</span><br><span style="color:var(--s4);font-size:11px">${esc(event.ts_utc ? new Date(event.ts_utc).toLocaleDateString() : "-")}</span></div><div style="font-weight:800">${esc(typeof event.data === "object" ? JSON.stringify(event.data) : String(event.data || "-"))}</div></div>`,
            )
            .join("")
        : '<div class="lead-page-v5-empty">No billing history yet.</div>'
    }      </div>    `;
  }
  function buildMockupActivityItems(lead, state) {
    const items = [];
    (Array.isArray(lead.activity_items) ? lead.activity_items : []).forEach(
      (item) => {
        const type = String(item.activity_type || "").toLowerCase();
        const meta = item.metadata || {};
        if (type === "stage") {
          items.push({
            id: item.id || `stage-${item.happened_at}`,
            type: "stage",
            label: "Stage",
            icon: "stage",
            line: `${meta.from || "-"} -> ${meta.to || item.subject || "-"}`,
            body: item.body_text || "",
            meta: `${esc(item.owner_email || "System")} | ${fmtTsMinute(item.happened_at)}`,
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "email") {
          const direction =
            String(meta.direction || item.direction || "").toLowerCase() === "in"
              ? "in"
              : "out";
          const status = emailReadStatus(meta, direction);
          const counterparty =
            direction === "in"
              ? meta.from || meta.from_email || meta.to || "-"
              : meta.to || "-";
          const badges = [];
          if (status) badges.push(status);
          if (String(meta.transport || "").toLowerCase() === "gmail") {
            badges.push("Gmail");
          }
          if (meta.template) badges.push(`Template: ${meta.template}`);
          items.push({
            id: item.id || `email-${item.happened_at}`,
            type: "email",
            label: "Email",
            icon: "email",
            line: `${direction === "in" ? "From" : "To"} ${counterparty} | "${item.subject || "First Mate follow-up"}"`,
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            seq: badges.join(" | "),
            statusDetail: badges.join(" | "),
            emailMeta: meta,
            direction,
            subject: item.subject || "First Mate follow-up",
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "sms") {
          const direction =
            String(item.direction || meta.direction || "").toLowerCase() === "in"
              ? "in"
              : "out";
          const preview = String(item.body_text || "").trim();
          const phone =
            meta.phone ||
            meta.from_phone ||
            (Array.isArray(meta.to_phones) ? meta.to_phones[0] : "") ||
            "";
          const status = smsStatusSummary(meta, direction);
          const seqParts = [status];
          if (meta.contact_name) seqParts.push(meta.contact_name);
          if (phone) seqParts.push(phone);
          items.push({
            id: item.id || `sms-${item.happened_at}`,
            type: "sms",
            label: "SMS",
            icon: "sms",
            line: `${direction === "in" ? "Inbound" : "Outbound"} text${preview ? ` | "${preview.length > 48 ? `${preview.slice(0, 45)}...` : preview}"` : ""}`,
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            seq: seqParts.filter(Boolean).join(" | "),
            statusDetail: status,
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "email") {
          const direction =
            String(meta.direction || item.direction || "").toLowerCase() === "in"
              ? "in"
              : "out";
          const counterparty =
            direction === "in"
              ? meta.from || meta.from_email || meta.to || "-"
              : meta.to || "-";
          const badges = [];
          if (meta.template) badges.push(`Template: ${meta.template}`);
          if (String(meta.transport || "").toLowerCase() === "gmail") {
            badges.push("Gmail");
          }
          items.push({
            id: item.id || `email-${item.happened_at}`,
            type: "email",
            label: "Email",
            line: `${direction === "in" ? "<-" : "->"} ${counterparty} | "${item.subject || "First Mate follow-up"}"`,
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            seq: badges.join(" | "),
            emailMeta: meta,
            direction,
            subject: item.subject || "First Mate follow-up",
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "sms") {
          const preview = String(item.body_text || "").trim();
          items.push({
            id: item.id || `sms-${item.happened_at}`,
            type: "sms",
            label: "SMS",
            line: `Outbound | "${preview.length > 48 ? `${preview.slice(0, 45)}...` : preview}"`,
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "sequence") {
          items.push({
            id: item.id || `sequence-${item.happened_at}`,
            type: "sequence",
            label: "Sequence",
            icon: "seq",
            line: item.subject || meta.sequence_label || "Sequence update",
            body: item.body_text || "",
            meta: `${esc(item.owner_email || "System")} | ${fmtTsMinute(item.happened_at)}`,
            seq: meta.status ? `Status: ${meta.status}` : "",
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "calendar") {
          const scheduledAt = Number(meta.scheduled_at || 0);
          items.push({
            id: item.id || `calendar-${item.happened_at}`,
            type: "calendar",
            label: "Calendar",
            icon: "email",
            line: `${item.subject || "Scheduled follow-up"} | ${fmtUpcomingDue(scheduledAt || item.happened_at)}`,
            body: item.body_text || "",
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "followup") {
          items.push({
            id: item.id || `followup-${item.happened_at}`,
            type: "note",
            label: "Follow-Up",
            icon: "note",
            line: item.subject || "Follow-up updated",
            body: item.body_text || "",
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            ts: Number(item.happened_at || 0),
          });
          return;
        }
        if (type === "milestone") {
          items.push({
            id: item.id || `milestone-${item.happened_at}`,
            type: "stage",
            label: "Milestone",
            icon: "stage",
            line: item.subject || "Milestone updated",
            body: item.body_text || "",
            meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.happened_at)}`,
            ts: Number(item.happened_at || 0),
          });
        }
      },
    );
    (Array.isArray(lead.notes_items) ? lead.notes_items : []).forEach(
      (note) => {
        items.push({
          id: `note-${note.id || note.created_at}`,
          type: "note",
          label: "Note",
          icon: "note",
          line: note.note_text || "CRM note",
          body: note.note_text || "",
          meta: `${esc(note.owner_email || "-")} | ${fmtTsMinute(note.created_at)}`,
          ts: Number(note.created_at || 0),
        });
      },
    );
    (Array.isArray(lead.dial_events) ? lead.dial_events : []).forEach(
      (item) => {
        const statusDetail = callStatusSummary(item);
        const patchedDuration = fmtDurationSeconds(item.context?.duration);
        const patchedBody =
          (lead.notes_items || []).find(
            (note) =>
              String(note.dial_event_id || "") === String(item.id || ""),
          )?.note_text || "";
        items.push({
          id: `call-${item.id || item.dialed_at}`,
          type: "call",
          label: item.source === "ringcentral" ? "RC" : "Orum",
          icon: item.source === "ringcentral" ? "rc" : "orum",
          line: `${lead.company || "Lead"} | ${patchedDuration}`,
          meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.dialed_at)}`,
          seq: [statusDetail, item.context?.phone || ""]
            .join(" | "),
          statusDetail,
          ts: Number(item.dialed_at || 0),
          recordingUrl: item.context?.recording || "",
          source: String(item.source || ""),
          dialEventId: String(item.id || ""),
          callDisposition: String(item.context?.disposition || ""),
          callNotes: String(item.context?.notes || ""),
        });
        return;
        const duration = fmtDurationSeconds(item.context?.duration);
        const disposition = item.context?.disposition || item.source || "Call";
        const body =
          (lead.notes_items || []).find(
            (note) =>
              String(note.dial_event_id || "") === String(item.id || ""),
          )?.note_text || "";
        items.push({
          id: `call-${item.id || item.dialed_at}`,
          type: "call",
          label: item.source === "ringcentral" ? "RC" : "Orum",
          icon: item.source === "ringcentral" ? "rc" : "orum",
          line: `${lead.company || "Lead"} | ${duration} | ${disposition}`,
          body,
          meta: `${esc(item.owner_email || "-")} | ${fmtTsMinute(item.dialed_at)}`,
          ts: Number(item.dialed_at || 0),
          recordingUrl: item.context?.recording || "",
        });
      },
    );
    return items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  }
  function renderRingCentralCallEditor(lead, state, item) {
    if (String(item?.source || "").toLowerCase() !== "ringcentral") return "";
    const dialEventId = String(item?.dialEventId || "");
    if (!dialEventId) return "";
    const dispositions = callDispositionOptionsForLead(lead);
    const dispositionValue = String(
      state.ui?.callDispositionDrafts?.[dialEventId] ?? item.callDisposition ?? "",
    );
    const notesValue = String(
      state.ui?.callNoteDrafts?.[dialEventId] ?? item.callNotes ?? "",
    );
    const saveState = state.callAnnotationSaveStates?.[dialEventId] || {};
    const saveMessage =
      saveState.status === "saving"
        ? "Saving call context..."
        : saveState.status === "saved"
          ? "Saved."
          : saveState.status === "error"
            ? saveState.message || "Could not save call context."
            : "";
    const saveTone =
      saveState.status === "error"
        ? "#b42318"
        : saveState.status === "saved"
          ? "#137333"
          : "#667487";
    return `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--s1);display:grid;gap:8px" data-autosave-call-note="${esc(dialEventId)}">
        <div style="display:grid;gap:4px">
          <div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--s4)">Disposition</div>
          <select class="lead-page-v5-select" data-lead-call-disposition="${esc(dialEventId)}">
            <option value="">Select disposition...</option>
            ${dispositions.map((label) => `<option value="${esc(label)}" ${label === dispositionValue ? "selected" : ""}>${esc(label)}</option>`).join("")}
          </select>
          ${!dispositionValue ? `<div style="font-size:11px;color:#9a3412;font-weight:700">Set a disposition so this RingCentral call counts correctly in sequence logic and analytics.</div>` : ""}
        </div>
        <div style="display:grid;gap:4px">
          <div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--s4)">Notes</div>
          <textarea
            class="lead-page-v5-textarea"
            rows="${notesValue ? 3 : 1}"
            placeholder="Add call notes..."
            data-lead-call-notes="${esc(dialEventId)}"
            style="min-height:34px;transition:min-height .15s ease"
          >${esc(notesValue)}</textarea>
        </div>
        ${saveMessage ? `<div style="font-size:11px;font-weight:800;color:${saveTone}">${esc(saveMessage)}</div>` : ""}
      </div>
    `;
  }
  function renderMockupActivity(lead, state) {
    const leadTimeInfo = getLeadTimeInfo(lead);
    const viewerTimeInfo = getViewerTimeInfo();
    const draft = state.followupDraft || {};
    const followupSchedule = buildFollowupScheduleDetails(
      draft,
      leadTimeInfo,
      viewerTimeInfo,
    );
    const meetingSchedule = buildMeetingScheduleDetails(
      draft,
      leadTimeInfo,
      viewerTimeInfo,
    );
    const scheduleMode = followupMode(draft);
    const hasMeetingSelection = meetingSchedule.mode !== "none";
    const hasFollowupSelection = followupSchedule.mode !== "none";
    const hasPartialMeeting = hasPartialMeetingSelection(draft);
    const calendar = lead?.crm?.calendar || {};
    const meetingDateValue = String(draft?.meeting_date || "").trim();
    const showMeetingDetailPanel =
      !!meetingDateValue ||
      !!state.ui?.calendarEventsLoading ||
      !!state.ui?.calendarEventsError;
    const calendarDayView = buildMeetingDayViewModel(
      state.ui?.calendarDayEvents,
      viewerTimeInfo?.timeZone,
      meetingDateValue,
      meetingSchedule,
    );
    const submitBusy =
      state.saveStates?.note?.status === "saving" ||
      state.saveStates?.followup?.status === "saving" ||
      state.saveStates?.calendar?.status === "saving";
    const isDateOffsetActive = (days) =>
      String(draft.followup_date || "") === isoDateForOffset(days);
    const filter = state.ui?.activityFilter || "all";
    const items = buildMockupActivityItems(lead, state).filter((item) => {
      if (filter === "all") return true;
      if (filter === "calls") return item.type === "call";
      if (filter === "emails") return item.type === "email";
      if (filter === "texts") return item.type === "sms";
      if (filter === "notes")
        return item.type === "note" || item.type === "stage";
      return true;
    });
    const followups = (
      Array.isArray(lead.followups) ? lead.followups : []
    ).filter((item) => String(item.status || "open") === "open");
    const filterButtons = [
      ["all", "All"],
      ["calls", "Calls"],
      ["emails", "Emails"],
      ["texts", "Texts"],
      ["notes", "Notes"],
    ]
      .map(
        ([value, label]) =>
          `<button class="lead-page-v5-activity-filter ${filter === value ? "active" : ""}" type="button" data-lead-activity-filter="${esc(value)}">${esc(label)}</button>`,
      )
      .join("");
    const summaryItems = [];
    if (hasFollowupSelection) {
      const followupDetail =
        scheduleMode === "morning" || scheduleMode === "afternoon"
          ? `${followupSchedule.headline} | ${followupSchedule.viewerSummary}`
          : followupSchedule.headline;
      summaryItems.push(
        `<div class="lead-page-v5-schedule-summary-item"><strong>Follow-Up:</strong> ${esc(followupDetail)}</div>`,
      );
    }
    if (hasMeetingSelection) {
      summaryItems.push(
        `<div class="lead-page-v5-schedule-summary-item"><strong>Meeting:</strong> ${esc(meetingSchedule.headline)} | Your time: ${esc(meetingSchedule.viewerSummary)} | Lead time: ${esc(meetingSchedule.leadSummary)}</div>`,
      );
    } else if (hasPartialMeeting) {
      summaryItems.push(
        `<div class="lead-page-v5-schedule-summary-item">Pick both a meeting date and time, or clear it to submit only the note/follow-up.</div>`,
      );
    }
    if (!summaryItems.length) {
      summaryItems.push(
        `<div class="lead-page-v5-schedule-summary-item">Just adding a note with no event.</div>`,
      );
    }
    const showClearSelection =
      hasFollowupSelection ||
      hasMeetingSelection ||
      hasPartialMeeting ||
      String(draft.followup_date || "").trim() !== "" ||
      String(draft.meeting_date || "").trim() !== "" ||
      String(draft.meeting_time || "").trim() !== "";
    const disableSubmit =
      submitBusy ||
      (hasMeetingSelection &&
        (calendar.configured === false || !calendar.connected));
    const upcomingHtml = followups.length
      ? followups
          .slice(0, 5)
          .map(
            (item) => `
              <div class="lead-page-v5-upcoming-item">
                <input type="checkbox" data-lead-complete-followup="${esc(item.id)}">
                <div class="lead-page-v5-upcoming-icon phone"><i class="fas fa-phone"></i></div>
                <div class="lead-page-v5-upcoming-main">
                  <div class="lead-page-v5-upcoming-title">${esc(item.title || "Follow-Up")}</div>
                  <div class="lead-page-v5-upcoming-meta">${esc(item.due_at ? fmtUpcomingDue(item.due_at) : "No date")} - ${esc(leadTimeInfo?.label || "-")}</div>
                  ${item.body ? `<div style="margin-top:4px;font-size:12px;line-height:1.45;color:var(--s5)">${esc(item.body)}</div>` : ""}
                  ${item.metadata?.origin === "sequence" ? `<div class="lead-page-v5-upcoming-seq">Sequence: ${esc(item.metadata?.sequence_key || "")}</div>` : ""}
                </div>
                <div class="lead-page-v5-upcoming-date">${esc(item.due_at ? fmtDateShort(item.due_at) : "-")}</div>
              </div>
            `,
          )
          .join("")
      : '<div class="lead-page-v5-empty">No upcoming follow-ups yet.</div>';
    const historyHtml = items.length
      ? items
          .map((item) => {
            const isOpen = state.ui?.historyExpanded
              ? !state.ui?.historyClosed?.[item.id]
              : !!state.ui?.historyOpen?.[item.id];
            return `
              <div class="lead-page-v5-history-item ${isOpen ? "open" : ""}" data-history-item-id="${esc(item.id)}">
                <div class="lead-page-v5-history-head" data-lead-toggle-activity="${esc(item.id)}" aria-expanded="${isOpen ? "true" : "false"}">
                  <div class="lead-page-v5-history-icon ${esc(item.icon)}"><i class="fas ${item.type === "note" ? "fa-sticky-note" : item.type === "email" ? "fa-paper-plane" : item.type === "sms" ? "fa-comment" : item.type === "stage" ? "fa-exchange-alt" : "fa-phone"}"></i></div>
                  <div class="lead-page-v5-history-main">
                    <div class="lead-page-v5-history-line"><span class="lead-page-v5-history-tag ${esc(item.icon)}">${esc(item.label)}</span>${esc(item.line)}</div>
                    <div class="lead-page-v5-history-meta">${item.meta}</div>
                    ${item.seq ? `<div class="lead-page-v5-history-seq">${esc(item.seq)}</div>` : ""}
                  </div>
                  <div class="lead-page-v5-expand"><i class="fas fa-chevron-down"></i></div>
                </div>
                <div class="lead-page-v5-history-body"${isOpen ? "" : " hidden"}>
                  ${item.statusDetail ? `<div style="margin-bottom:6px;font-size:11px;color:var(--s5);font-weight:700">Status: ${esc(item.statusDetail)}</div>` : ""}
                  ${item.body ? `<div>${esc(item.body)}</div>` : '<div class="lead-page-v5-empty">No additional details.</div>'}
                  ${renderRingCentralCallEditor(lead, state, item)}
                  ${item.type === "email" && String(item.emailMeta?.transport || "").toLowerCase() === "gmail" ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="lead-page-v5-btn-secondary" type="button" data-lead-reply-email="${esc(item.id)}"><i class="fas fa-reply"></i> Reply</button><button class="lead-page-v5-btn-secondary" type="button" data-lead-reply-all-email="${esc(item.id)}"><i class="fas fa-reply-all"></i> Reply All</button></div>` : ""}
                  ${item.recordingUrl ? `<div style="margin-top:6px"><a href="${esc(item.recordingUrl)}" target="_blank" rel="noopener"><i class="fas fa-play-circle"></i> Play Recording</a></div>` : ""}
                </div>
              </div>
            `;
          })
          .join("")
      : '<div class="lead-page-v5-empty">No activity yet.</div>';
    return `
      <div style="display:grid;gap:12px">
        <div class="lead-page-v5-activity" style="max-height:none;overflow:hidden">
          <div class="lead-page-v5-activity-head">
            <div class="lead-page-v5-activity-head-top">
              <h3><i class="fas fa-stream"></i> Activity</h3>
            </div>
            <div class="lead-page-v5-schedule-shell">
              <div class="lead-page-v5-schedule-grid">
                <div class="lead-page-v5-schedule-panel followup">
                  <div class="lead-page-v5-schedule-panel-head">
                    <div>
                      <div class="lead-page-v5-schedule-panel-title"><i class="fas fa-phone-alt"></i> Schedule Follow-Up</div>
                      <div class="lead-page-v5-schedule-panel-copy">CRM follow-up only</div>
                    </div>
                  </div>
                  <div class="lead-page-v5-schedule-bar">
                    <button class="lead-page-v5-chip ${isDateOffsetActive(1) ? "active" : ""}" type="button" data-followup-date-offset="1">Tomorrow</button>
                    <button class="lead-page-v5-chip ${isDateOffsetActive(3) ? "active" : ""}" type="button" data-followup-date-offset="3">3 Days</button>
                    <button class="lead-page-v5-chip ${isDateOffsetActive(7) ? "active" : ""}" type="button" data-followup-date-offset="7">Next Week</button>
                    <input class="lead-page-v5-date" data-lead-followup-date type="date" value="${esc(draft?.followup_date || "")}">
                  </div>
                  <div class="lead-page-v5-schedule-bar">
                    <button class="lead-page-v5-chip ${scheduleMode === "morning" ? "active" : ""}" type="button" data-followup-slot="morning"><i class="fas fa-sun" style="font-size:9px"></i> Morning</button>
                    <button class="lead-page-v5-chip ${scheduleMode === "afternoon" ? "active" : ""}" type="button" data-followup-slot="afternoon"><i class="fas fa-cloud-sun" style="font-size:9px"></i> Afternoon</button>
                    <button class="lead-page-v5-chip ${scheduleMode === "all_day" ? "active" : ""}" type="button" data-followup-slot="all_day"><i class="fas fa-calendar-day" style="font-size:9px"></i> All Day</button>
                  </div>
                </div>
                <div class="lead-page-v5-schedule-panel meeting">
                  <div class="lead-page-v5-schedule-panel-head">
                    <div>
                      <div class="lead-page-v5-schedule-panel-title"><i class="fab fa-google"></i> Schedule a Meeting</div>
                      <div class="lead-page-v5-schedule-panel-copy">Syncs to Google Calendar</div>
                    </div>
                    ${calendar.connected ? `<div class="lead-page-v5-schedule-panel-meta"><i class="fas fa-circle"></i><span>${esc(calendar.connected_email || window.Portal?.cfg?.user?.email || "")}</span></div>` : ""}
                  </div>
                  <div class="lead-page-v5-schedule-bar">
                    <button class="lead-page-v5-chip ${meetingDateValue === isoDateForOffset(1) ? "active" : ""}" type="button" data-meeting-date-offset="1">Tomorrow</button>
                    <input class="lead-page-v5-date" data-lead-meeting-date type="date" value="${esc(draft?.meeting_date || "")}">
                    <input class="lead-page-v5-date" data-lead-meeting-time type="time" step="900" value="${esc(draft?.meeting_time || "")}" style="min-width:118px;max-width:128px">
                    <select class="lead-page-v5-select" data-lead-meeting-duration>
                      ${FOLLOWUP_DURATION_OPTIONS.map((minutes) => `<option value="${minutes}" ${Number(draft?.duration_minutes || 30) === minutes ? "selected" : ""}>${minutes} min</option>`).join("")}
                    </select>
                  </div>
                  ${
                    calendar.configured === false
                      ? `<div class="lead-page-v5-schedule-note" style="color:#9a3412">Google Calendar admin config is missing for this server.</div>`
                      : !calendar.connected
                        ? `<div style="display:grid;gap:8px"><div class="lead-page-v5-schedule-note" style="color:#1d4ed8">Connect Google Calendar before submitting a meeting.</div><button class="lead-page-v5-btn-primary" type="button" data-lead-google-connect style="justify-content:center"><i class="fas fa-calendar-plus"></i> Connect Google</button></div>`
                        : ``
                  }
                </div>
              </div>
              ${
                showMeetingDetailPanel
                  ? `<div class="lead-page-v5-schedule-panel lead-page-v5-schedule-panel-detail">
                      <div class="lead-page-v5-schedule-panel-head">
                        <div>
                          <div class="lead-page-v5-schedule-panel-title"><i class="fas fa-calendar-alt"></i> Day View</div>
                          <div class="lead-page-v5-schedule-panel-copy">${esc(meetingDateValue ? fmtDateLong(meetingDateValue) : "Choose a meeting date")}</div>
                        </div>
                      </div>
                      ${calendar.connected ? `<div class="lead-page-v5-inline-checks tight"><button class="lead-page-v5-toggle-chip ${state.ui?.calendarAddMeet ? "active" : ""}" type="button" data-lead-calendar-add-meet-toggle><i class="fas fa-video"></i> Add Google Meet</button></div>` : !calendar.connected && calendar.configured !== false ? `<div style="display:grid;gap:8px"><div class="lead-page-v5-schedule-note" style="color:#1d4ed8">Connect Google Calendar before submitting a meeting.</div><button class="lead-page-v5-btn-primary" type="button" data-lead-google-connect style="justify-content:center"><i class="fas fa-calendar-plus"></i> Connect Google</button></div>` : ``}
                      <div class="lead-page-v5-calendar-times">
                        <span><strong>Your time:</strong> <span class="viewer">${esc(meetingSchedule.viewerSummary || "Pick a time")}</span></span>
                        <span><strong>Lead's time:</strong> <span class="lead">${esc(meetingSchedule.leadSummary || "Pick a time")}</span></span>
                      </div>
                      <div class="lead-page-v5-calendar-events">
                        ${state.ui?.calendarEventsLoading
                          ? `<div class="lead-page-v5-empty">Loading Google Calendar events for ${esc(fmtDateLong(meetingDateValue || state.ui?.calendarEventsDate || ""))}...</div>`
                          : state.ui?.calendarEventsError
                            ? `<div class="lead-page-v5-empty">${esc(state.ui.calendarEventsError)}</div>`
                            : renderMeetingDayView(calendarDayView, meetingDateValue || state.ui?.calendarEventsDate || "")}
                      </div>
                    </div>`
                  : ``
              }
              <div class="lead-page-v5-note-bar lead-page-v5-note-submit-row">
                <textarea class="lead-page-v5-note lead-panel-textarea" data-lead-followup-body placeholder="Add a note..." rows="2">${esc(draft.body || "")}</textarea>
                <button class="lead-page-v5-btn-secondary" style="font-size:11px;padding:7px 12px;justify-content:center;${disableSubmit ? "opacity:.6;cursor:not-allowed" : ""}" type="button" data-lead-submit-activity-note ${disableSubmit ? "disabled" : ""}><i class="fas ${submitBusy ? "fa-spinner fa-spin" : hasMeetingSelection ? "fa-calendar-plus" : hasFollowupSelection ? "fa-clipboard-check" : "fa-sticky-note"}"></i> ${submitBusy ? "Submitting..." : "Submit"}</button>
              </div>
              <div class="lead-page-v5-schedule-summary-row">
                <div class="lead-page-v5-schedule-summary">
                  ${summaryItems.join("")}
                </div>
                ${showClearSelection ? `<button class="lead-page-v5-ghost" type="button" data-lead-clear-activity-selection><i class="fas fa-times"></i> Clear</button>` : ""}
              </div>
            </div>
          </div>
        </div>
        <div class="lead-page-v5-activity">
          <div class="lead-page-v5-activity-head" style="padding-bottom:10px">
            <div class="lead-page-v5-activity-head-top" style="margin-bottom:0">
              <div class="lead-page-v5-filters">
                ${filterButtons}
              </div>
              <button class="lead-page-v5-ghost lead-page-v5-history-toggle-all" type="button" data-lead-toggle-history-all style="position:relative;z-index:5;pointer-events:auto">
                <i class="fas fa-compress-alt"></i> ${state.ui?.historyExpanded ? "Collapse All" : "Expand All"}
              </button>
            </div>
          </div>
          <div class="lead-page-v5-activity-scroll">
            <div class="lead-page-v5-upcoming">
              <div class="lead-page-v5-upcoming-label"><i class="fas fa-clock"></i> Upcoming</div>
              ${upcomingHtml}
            </div>
          </div>
          <div class="lead-page-v5-history-scroll">
            <div class="lead-page-v5-history-label"><i class="fas fa-history"></i> History</div>
            ${historyHtml}
          </div>
        </div>
      </div>
    `;
  }
  function renderMockupSmsModal(lead, state) {
    const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
    const smsRecipients = [leadCompanyRecipientForUi(lead, state), ...contacts];
    const allSmsItems = (Array.isArray(lead.activity_items) ? lead.activity_items : []).filter(
      (item) => String(item.activity_type || "") === "sms",
    );
    const smsTemplates = smsTemplateOptionsForLead(lead);
    const primarySmsContact =
      smsRecipients.find((contact) => leadPreferredContactPhoneForUi(contact)) ||
      smsRecipients[0] ||
      null;
    const activeId =
      state.ui?.smsThreadId ||
      state.ui?.smsRecipientContactId ||
      String(primarySmsContact?.id || "");
    const selectedContact =
      smsRecipients.find(
        (contact) =>
          String(contact?.id || "") === String(state.ui?.smsRecipientContactId || activeId),
      ) || primarySmsContact;
    const selectedContactId = String(selectedContact?.id || "");
    const selectedPhone =
      String(state.ui?.smsPhone || "").trim() ||
      leadPreferredContactPhoneForUi(selectedContact);
    const normalizedPhone = normalizeLeadPhoneForUi(selectedPhone);
    const contactPhones = leadContactPhonesForUi(selectedContact);
    const needsAlternateSave =
      !!selectedContact &&
      String(selectedContact?.id || "") !== COMPANY_RECIPIENT_ID &&
      !!normalizedPhone &&
      !contactPhones.includes(normalizedPhone);
    const sending = state.saveStates?.smsSend?.status === "saving";
    const smsSendState = state.saveStates?.smsSend || {};
    const smsStatusClass =
      smsSendState.status === "error"
        ? "error"
        : smsSendState.status === "saved"
          ? "saved"
          : smsSendState.status === "saving"
            ? "saving"
            : "";
    const smsRefreshing = !!state.ui?.smsRefreshing;
    const unreadCountForThread = (threadId) =>
      allSmsItems.filter((item) => {
        if (String(item.metadata?.thread_id || "") !== String(threadId || "")) return false;
        if (String(item.direction || "").toLowerCase() !== "in") return false;
        const readStatus = String(item.metadata?.read_status || "").trim().toLowerCase();
        return readStatus === "" || readStatus === "unread" || readStatus === "received";
      }).length;
    const messages = allSmsItems
      .filter(
        (item) =>
          String(item.metadata?.thread_id || "") === String(activeId),
      )
      .map((item) => ({
        direction: item.direction || "out",
        body: item.body_text || "",
        ts: Number(item.happened_at || 0),
      }))
      .sort((a, b) => {
        const tsDiff = Number(a.ts || 0) - Number(b.ts || 0);
        if (tsDiff !== 0) return tsDiff;
        return String(a.body || "").localeCompare(String(b.body || ""));
      });
    return `
      <div class="lead-page-v5-modal-overlay ${state.ui?.smsOpen ? "open" : ""}" data-lead-close-sms>
        <div class="lead-page-v5-sms-modal" onclick="event.stopPropagation()">
          <div class="lead-page-v5-sms-head">
            <h3><i class="fas fa-comment" style="color:var(--g)"></i> Text Messages</h3>
            <div style="display:flex;align-items:center;gap:10px">
              ${smsRefreshing ? `<div class="lead-page-v5-sms-status saving"><i class="fas fa-rotate-right fa-spin"></i> Refreshing thread...</div>` : ``}
              <button class="lead-page-v5-ghost" type="button" data-lead-close-sms style="font-size:16px"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div class="lead-page-v5-sms-chips">
            ${
              smsRecipients.length
                ? smsRecipients
                    .map(
                      (contact) => {
                        const unreadCount = unreadCountForThread(contact?.id || "");
                        return `<button class="lead-page-v5-sms-chip ${String(contact.id || "") === activeId ? "active" : ""}" type="button" data-lead-sms-thread="${esc(contact.id || "")}">${esc(leadContactDisplayNameForUi(contact))}${unreadCount ? ` <span style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#d93025;color:#fff;font-size:10px;font-weight:900">${esc(String(unreadCount))}</span>` : ""}</button>`;
                      },
                    )
                    .join("")
                : `<div class="lead-page-v5-empty" style="padding:0">Add a contact to this lead before texting.</div>`
            }
          </div>
          <div class="lead-page-v5-sms-thread">
            ${
              messages.length
                ? messages
                    .map(
                      (message) =>
                        `<div class="lead-page-v5-sms-msg ${message.direction === "in" ? "in" : "out"}">${esc(message.body)}<div class="lead-page-v5-sms-msg-time">${esc(fmtTsMinute(message.ts))}</div></div>`,
                    )
                    .join("")
                : `<div class="lead-page-v5-empty lead-page-v5-sms-empty-state">No text messages yet for ${esc(selectedContact ? leadContactDisplayNameForUi(selectedContact) : "this lead")}.</div>`
            }
          </div>
          <div class="lead-page-v5-sms-compose">
            <div class="lead-page-v5-sms-recipient-row">
              <select class="lead-page-v5-select lead-page-v5-sms-contact-select" data-lead-sms-recipient-contact>
                <option value="">Select recipient...</option>
                ${smsRecipients
                  .map(
                    (contact) =>
                      `<option value="${esc(contact.id || "")}" ${String(contact.id || "") === selectedContactId ? "selected" : ""}>${esc(leadContactDisplayNameForUi(contact))}</option>`,
                  )
                  .join("")}
              </select>
              <input
                class="lead-page-v5-sms-phone-input"
                type="tel"
                placeholder="Phone number"
                data-lead-sms-phone
                value="${esc(selectedPhone)}"
              >
            </div>
            ${
              needsAlternateSave
                ? `<div class="lead-page-v5-sms-alt-note">This will be saved as an alternate phone for ${esc(leadContactDisplayNameForUi(selectedContact))} when you send.</div>`
                : ``
            }
            <div class="lead-page-v5-sms-compose-row">
              <textarea class="lead-page-v5-sms-message-input" placeholder="Type a message..." data-lead-sms-input rows="3">${esc(state.ui?.smsDraft || "")}</textarea>
              <select class="lead-page-v5-select lead-page-v5-sms-template-select" data-lead-sms-template>
                ${smsTemplates
                  .map(
                    (template) =>
                      `<option value="${esc(template.value)}" ${String(state.ui?.smsTemplate || "") === String(template.value) ? "selected" : ""}>${esc(template.label)}</option>`,
                  )
                  .join("")}
              </select>
              <button class="lead-page-v5-btn-green lead-page-v5-sms-send" type="button" data-lead-send-sms ${sending ? "disabled" : ""} style="${sending ? "opacity:.6;cursor:not-allowed" : ""}">
                <i class="fas ${sending ? "fa-spinner fa-spin" : "fa-paper-plane"}"></i>
                ${sending ? "Sending" : "Send"}
              </button>
            </div>
            ${
              smsSendState.message
                ? `<div class="lead-page-v5-sms-status ${smsStatusClass}">${esc(smsSendState.message)}</div>`
                : ``
            }
          </div>
        </div>
      </div>
    `;
  }
  function blankEmailComposeForRender() {
    return {
      template: "",
      bcc: "",
      manualRecipientEmail: "",
      manualRecipientEmails: [],
      recipientContactEnabled: {},
      recipientEmailSelections: {},
      subject: "",
      body: "",
      bodyHtml: "",
      signatureHtml: "",
      attachments: [],
      branding: {
        primaryColor: "",
        secondaryColor: "",
        logoDataUrl: "",
      },
      threadId: "",
      inReplyTo: "",
      references: "",
    };
  }
  function emailComposeHasContentForRender(compose) {
    const draft = compose && typeof compose === "object" ? compose : {};
    return Boolean(
      String(draft.bcc || "").trim() ||
      String(draft.manualRecipientEmail || "").trim() ||
      leadManualRecipientDraftsForUi(draft).length ||
      String(draft.subject || "").trim() ||
      String(draft.bodyHtml || draft.body || "").replace(/<[^>]+>/g, " ").trim() ||
      (Array.isArray(draft.attachments) && draft.attachments.length),
    );
  }
  function leadEmailEligibleContactsForUi(contacts) {
    return (Array.isArray(contacts) ? contacts : []).filter(
      (contact) => leadContactEmailsForUi(contact).length,
    );
  }
  function leadEmailRecipientToggleMapForUi(compose) {
    return compose?.recipientContactEnabled &&
      typeof compose.recipientContactEnabled === "object"
      ? compose.recipientContactEnabled
      : {};
  }
  function leadEmailRecipientSelectionMapForUi(compose) {
    return compose?.recipientEmailSelections &&
      typeof compose.recipientEmailSelections === "object"
      ? compose.recipientEmailSelections
      : {};
  }
  function leadEmailLegacyRecipientForUi(compose, contacts) {
    const legacyId = String(compose?.recipientContactId || "").trim();
    const legacyEmail = normalizeLeadRecipientEmail(compose?.to || "");
    const contactList = Array.isArray(contacts) ? contacts : [];
    return (
      contactList.find(
        (contact) => String(contact?.id || "") === legacyId,
      ) ||
      (legacyEmail
        ? contactList.find((contact) =>
            leadContactEmailsForUi(contact).includes(legacyEmail),
          )
        : null) ||
      null
    );
  }
  function leadEmailContactEnabledForUi(compose, contact, contacts) {
    const emails = leadContactEmailsForUi(contact);
    if (!emails.length) return false;
    const contactId = String(contact?.id || "");
    const toggleMap = leadEmailRecipientToggleMapForUi(compose);
    if (Object.prototype.hasOwnProperty.call(toggleMap, contactId)) {
      return toggleMap[contactId] !== false;
    }
    const legacyRecipient = leadEmailLegacyRecipientForUi(compose, contacts);
    if (legacyRecipient) {
      return String(legacyRecipient?.id || "") === contactId;
    }
    return true;
  }
  function leadEmailSelectedIndexForUi(compose, contact) {
    const emails = leadContactEmailsForUi(contact);
    if (!emails.length) return 0;
    const contactId = String(contact?.id || "");
    const selectionMap = leadEmailRecipientSelectionMapForUi(compose);
    const rawIndex = Number(selectionMap[contactId]);
    if (Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < emails.length) {
      return rawIndex;
    }
    const legacyEmail = normalizeLeadRecipientEmail(compose?.to || "");
    if (legacyEmail) {
      const legacyIndex = emails.indexOf(legacyEmail);
      if (legacyIndex >= 0) return legacyIndex;
    }
    return 0;
  }
  function leadEmailSelectedRecipientsForUi(contacts, compose) {
    return leadEmailEligibleContactsForUi(contacts)
      .filter((contact) => leadEmailContactEnabledForUi(compose, contact, contacts))
      .map((contact) => {
        const emails = leadContactEmailsForUi(contact);
        const selectedIndex = leadEmailSelectedIndexForUi(compose, contact);
        return {
          contact,
          contactId: String(contact?.id || ""),
          emails,
          selectedIndex,
          selectedEmail: emails[selectedIndex] || emails[0] || "",
          hasMultiple: emails.length > 1,
        };
      })
      .filter((entry) => entry.selectedEmail);
  }
  function leadManualRecipientDraftsForUi(compose) {
    const rawList = Array.isArray(compose?.manualRecipientEmails)
      ? compose.manualRecipientEmails
      : String(compose?.manualRecipientEmail || "").trim()
        ? [compose.manualRecipientEmail]
        : [];
    return rawList
      .map((value) => String(value || "").trim())
      .filter((value) => value !== "");
  }
  function defaultEmailWindowFrameForRender(index) {
    const viewportWidth = Math.max(
      640,
      window.innerWidth || document.documentElement.clientWidth || 1280,
    );
    const viewportHeight = Math.max(
      520,
      window.innerHeight || document.documentElement.clientHeight || 900,
    );
    const width = Math.min(860, Math.max(640, Math.round(viewportWidth * 0.56)));
    const height = Math.min(780, Math.max(540, Math.round(viewportHeight * 0.68)));
    const toolsOffset = viewportWidth > 760 ? 154 : 16;
    const staggerX = Number(index || 0) * 28;
    const staggerY = Number(index || 0) * 20;
    return {
      x: Math.max(16, viewportWidth - width - toolsOffset - staggerX),
      y: Math.max(16, viewportHeight - height - 18 - staggerY),
      width,
      height,
      z: 200 + Number(index || 0),
    };
  }
  function emailWindowsForRender(state) {
    return Array.isArray(state?.ui?.emailWindows) ? state.ui.emailWindows : [];
  }
  function ensureEmailWindowsStateForRender(state) {
    if (!state.ui || typeof state.ui !== "object") state.ui = {};
    if (!Array.isArray(state.ui.emailWindows)) {
      state.ui.emailWindows = [];
    }
    if (
      !state.ui.emailWindows.length &&
      (state.ui.emailOpen || emailComposeHasContentForRender(state.ui.emailCompose))
    ) {
      const frame = defaultEmailWindowFrameForRender(0);
      const nextCounter = Number(state.ui.emailWindowCounter || 0) + 1;
      state.ui.emailWindowCounter = nextCounter;
      state.ui.emailWindows.push({
        id: `email_window_${nextCounter}`,
        minimized: false,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        z: frame.z,
        compose: {
          ...blankEmailComposeForRender(),
          ...(state.ui.emailCompose || {}),
        },
      });
    }
  }
  function renderMockupEmailComposer(lead, state) {
    ensureEmailWindowsStateForRender(state);
    const gmail = lead?.crm?.gmail || {};
    const contacts = Array.isArray(lead?.contacts) ? lead.contacts : [];
    const emailRecipients = [leadCompanyRecipientForUi(lead, state), ...contacts];
    const templates = emailTemplateOptionsForLead(lead);
    const toolbarButtons = [
      { command: "bold", icon: "fa-bold", label: "Bold" },
      { command: "italic", icon: "fa-italic", label: "Italic" },
      { command: "underline", icon: "fa-underline", label: "Underline" },
      { command: "insertUnorderedList", icon: "fa-list-ul", label: "Bullets" },
      { command: "insertImage", icon: "fa-image", label: "Image" },
      { command: "createLink", icon: "fa-link", label: "Link" },
      { command: "removeFormat", icon: "fa-eraser", label: "Clear" },
    ];
    const sendState = state.saveStates?.emailSend || {};
    const brandingState = state.saveStates?.emailBranding || {};
    const activeWindowId = String(state.ui?.activeEmailWindowId || "");
    const windows = emailWindowsForRender(state)
      .slice()
      .sort((a, b) => Number(a?.z || 0) - Number(b?.z || 0));
    if (!windows.length) return "";
    const gmailStatusHtml = !gmail.configured
      ? `<div style="padding:10px 12px;border-bottom:1px solid var(--s1);background:#fff7ed;color:#9a3412;font-size:11px;font-weight:700">Gmail admin config is missing for this server.</div>`
      : gmail.connected
        ? ``
        : `<div style="padding:10px 12px;border-bottom:1px solid var(--s1);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;background:#eff6ff"><div style="font-size:11px;color:#1d4ed8;font-weight:700">Connect Gmail to send and sync inbox threads for this lead.</div><button class="lead-page-v5-btn-primary" type="button" data-lead-gmail-connect><i class="fas fa-link"></i> Connect Gmail</button></div>`;
    const signatureNoteHtml =
      gmail.connected && !gmail.signature_scope_granted
        ? `<div class="lead-page-v5-email-signature-note warning"><i class="fas fa-triangle-exclamation"></i> Reconnect Google to import your Gmail signature automatically. Until then, the CRM will use a fallback signature.</div>`
        : gmail.connected && String(gmail.signature_html || "").trim()
          ? `<div class="lead-page-v5-email-signature-note"><i class="fas fa-signature"></i> Using the signature from your connected Gmail account.</div>`
          : "";
    return windows
      .map((emailWindow) => {
        const windowId = String(emailWindow?.id || "");
        const compose = {
          ...blankEmailComposeForRender(),
          ...(emailWindow?.compose || {}),
        };
        const minimized = !!emailWindow?.minimized;
        const emailBodyHtml =
          String(compose.bodyHtml || "").trim() ||
          renderLeadMultilineHtml(compose.body || "");
        const signatureHtml = emailSignatureHtmlForLead(lead, compose);
        const branding = {
          ...emailBrandingDefaultsForLead(lead),
          ...normalizeEmailBrandingInputForRender(compose.branding),
        };
        const reportTemplates = emailReportTemplatesForLead(lead);
        const selectedRecipients = leadEmailSelectedRecipientsForUi(
          emailRecipients,
          compose,
        );
        const manualRecipientDrafts = leadManualRecipientDraftsForUi(compose);
        const manualRecipientEmails = manualRecipientDrafts
          .map((value) => normalizeLeadRecipientEmail(value))
          .filter(Boolean);
        const invalidManualRecipientCount = manualRecipientDrafts.filter(
          (value) => value && !normalizeLeadRecipientEmail(value),
        ).length;
        const selectedRecipientEmails = selectedRecipients.map((entry) =>
          String(entry.selectedEmail || "").trim().toLowerCase(),
        );
        const sendRecipientCount = new Set([
          ...selectedRecipientEmails,
          ...manualRecipientEmails.map((email) => String(email || "").trim().toLowerCase()),
        ]).size;
        const emailEligibleContacts = leadEmailEligibleContactsForUi(emailRecipients);
        const canSend = !!gmail.connected && sendRecipientCount > 0;
        const sending =
          sendState.status === "saving" &&
          String(sendState.windowId || "") === windowId;
        const windowSendMessage =
          String(sendState.windowId || "") === windowId
            ? String(sendState.message || "")
            : "";
        const attachmentSelections = normalizeEmailAttachmentSelectionsForRender(
          lead,
          compose.attachments,
        );
        const attachmentRowsHtml = reportTemplates.length
          ? reportTemplates
              .map((template) => {
                const selected = attachmentSelections.find(
                  (item) => String(item.id) === String(template.id),
                );
                const mode = selected?.mode || "";
                return `<div class="lead-page-v5-email-report-row">
                  <div class="lead-page-v5-email-report-title">${esc(
                    template.label || template.id,
                  )}</div>
                  <div class="lead-page-v5-email-report-modes">
                    ${["summary", "full", "both"].map(
                      (option) =>
                        `<button class="lead-page-v5-email-report-mode ${
                          mode === option ? "active" : ""
                        }" type="button" data-email-window-target="${esc(
                          windowId,
                        )}" data-lead-email-report-id="${esc(
                          template.id,
                        )}" data-lead-email-report-mode="${esc(option)}">${esc(
                          option === "both"
                            ? "Both"
                            : option === "full"
                              ? "Unbranded"
                              : "Branded",
                        )}</button>`,
                    ).join("")}
                  </div>
                  <button class="lead-page-v5-email-report-preview" type="button" data-email-window-target="${esc(
                    windowId,
                  )}" data-lead-email-report-preview="${esc(
                    template.id,
                  )}" ${mode ? "" : 'disabled style="opacity:.45;cursor:not-allowed" title="Choose branded, unbranded, or both first"'}>
                    <i class="fas fa-file-pdf"></i> Preview
                  </button>
                </div>`;
              })
              .join("")
          : `<div class="lead-page-v5-email-report-empty">Pin sample reports in the Sample Reports tab to attach them from lead email.</div>`;
        const recipientToggleButtonsHtml = emailRecipients
          .map((contact) => {
            const emails = leadContactEmailsForUi(contact);
            const enabled = leadEmailContactEnabledForUi(
              compose,
              contact,
              emailRecipients,
            );
            const disabled = !emails.length;
            return `<button class="lead-page-v5-email-template ${
              enabled ? "active" : ""
            }" type="button" data-email-window-target="${esc(
              windowId,
            )}" data-lead-email-recipient-toggle="${esc(
              contact.id || "",
            )}" ${
              disabled
                ? `aria-disabled="true" title="No email for that recipient" style="opacity:.45;cursor:not-allowed"`
                : ""
            }>${esc(
              leadContactDisplayNameForUi(contact),
            )}</button>`;
          })
          .join("");
        const manualRecipientPillsHtml = [
          ...manualRecipientDrafts.map((value, index) => {
            const normalized = normalizeLeadRecipientEmail(value);
            const pillClass = normalized
              ? "committed"
              : value
                ? "invalid"
                : "";
            return `<label class="lead-page-v5-email-input-pill ${pillClass}">
              <input
                type="text"
                value="${esc(value)}"
                data-email-window-target="${esc(windowId)}"
                data-lead-email-manual-pill="${esc(String(index))}"
                placeholder="email@example.com"
                spellcheck="false"
                autocomplete="off"
              >
            </label>`;
          }),
          `<label class="lead-page-v5-email-input-pill empty">
            <input
              type="text"
              value=""
              data-email-window-target="${esc(windowId)}"
              data-lead-email-manual-pill="${esc(String(manualRecipientDrafts.length))}"
              placeholder="email@example.com"
              spellcheck="false"
              autocomplete="off"
            >
          </label>`,
        ].join("");
        const recipientPillsHtml = [
          ...selectedRecipients.map((entry) => {
            const cycleLabel = entry.hasMultiple
              ? `${entry.selectedIndex + 1}/${entry.emails.length}`
              : "";
            return `<div style="position:relative;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:6px 10px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:11px;font-weight:700;">
              <span>${esc(entry.selectedEmail)}</span>
              ${
                entry.hasMultiple
                  ? `<button class="lead-page-v5-ghost" type="button" style="position:absolute;top:-8px;right:-6px;display:inline-flex;align-items:center;gap:4px;padding:2px 6px;min-height:auto;font-size:10px;border-radius:999px;background:#fff;border:1px solid #93c5fd;box-shadow:0 2px 6px rgba(15,23,42,.12);color:#1d4ed8;" data-email-window-target="${esc(
                      windowId,
                    )}" data-lead-email-cycle-contact="${esc(
                      entry.contactId,
                    )}" title="Use another saved email for ${esc(
                      leadContactDisplayNameForUi(entry.contact),
                    )}"><i class="fas fa-rotate"></i><span>${esc(cycleLabel)}</span></button>`
                  : ""
              }
            </div>`;
          }),
          manualRecipientPillsHtml,
        ].join("") || `<div style="font-size:11px;color:#9a3412;font-weight:700;">Select at least one recipient with an email, or type a new one below.</div>`;
        const recipientInfoHtml = invalidManualRecipientCount
          ? `<div style="padding:8px 0 4px 46px;font-size:11px;color:#9a3412;font-weight:700"><i class="fas fa-envelope"></i> ${esc(String(invalidManualRecipientCount))} new email pill${invalidManualRecipientCount === 1 ? " is" : "s are"} not valid yet.</div>`
          : manualRecipientEmails.length
            ? `<div style="padding:8px 0 4px 46px;font-size:11px;color:#157347;font-weight:700"><i class="fas fa-circle-check"></i> New email pills will send now and become contacts automatically.</div>`
            : !emailEligibleContacts.length
              ? `<div style="padding:8px 0 4px 46px;font-size:11px;color:#9a3412;font-weight:700"><i class="fas fa-envelope"></i> Add an email address to the company or a contact before sending, or enter one in the dotted pill and press Enter or comma.</div>`
              : !selectedRecipients.length
                ? `<div style="padding:8px 0 4px 46px;font-size:11px;color:#9a3412;font-weight:700"><i class="fas fa-user-check"></i> Choose at least one recipient or add a new email pill with Enter or comma.</div>`
                : `<div style="padding:6px 0 2px 46px;font-size:11px;color:#157347;font-weight:700"><i class="fas fa-circle-check"></i> Sending to ${esc(String(sendRecipientCount))} recipient${sendRecipientCount === 1 ? "" : "s"} on this lead.</div>`;
        const titleText =
          String(compose.subject || "").trim() ||
          `Email ${lead.company || lead.lead_name || "Lead"}`;
        const expandedEmailWidth = 864;
        const expandedEmailHeight = 864;
        const frameStyle =
          window.innerWidth <= 760
            ? `z-index:${Number(emailWindow?.z || 200)};${minimized ? "bottom:16px;height:56px;min-height:56px;max-height:56px;" : ""}`
            : minimized
              ? `right:152px;left:auto;top:auto;bottom:16px;width:360px;height:56px;min-height:56px;max-height:56px;z-index:${Number(emailWindow?.z || 200)};`
              : `right:152px;left:auto;top:auto;bottom:16px;width:${expandedEmailWidth}px;min-width:${expandedEmailWidth}px;max-width:${expandedEmailWidth}px;height:${expandedEmailHeight}px;min-height:${expandedEmailHeight}px;max-height:${expandedEmailHeight}px;z-index:${Number(emailWindow?.z || 200)};`;
        return `
          <div class="lead-page-v5-email open ${minimized ? "minimized" : ""} ${windowId === activeWindowId ? "active" : ""}" data-email-window-id="${esc(windowId)}" style="${frameStyle}">
            <div class="lead-page-v5-email-head" data-lead-email-window-focus="${esc(windowId)}" data-email-window-drag-handle="${esc(windowId)}">
              <h4><i class="fas fa-envelope"></i> ${esc(titleText)}</h4>
              <div class="lead-page-v5-email-head-actions">
                <button class="lead-page-v5-ghost" type="button" data-lead-email-toggle-minimize="${esc(windowId)}" title="${minimized ? "Restore" : "Minimize"}"><i class="fas ${minimized ? "fa-window-restore" : "fa-minus"}"></i></button>
                <button class="lead-page-v5-ghost" type="button" data-lead-close-email="${esc(windowId)}"><i class="fas fa-times"></i></button>
              </div>
            </div>
            ${
              minimized
                ? ``
                : `
                  ${gmailStatusHtml}
                  <div class="lead-page-v5-email-templates">
                    ${templates.map((template) => `<button class="lead-page-v5-email-template ${String(compose.template || "") === String(template.id || "") ? "active" : ""}" type="button" data-email-window-target="${esc(windowId)}" data-lead-email-template="${esc(template.id || "")}">${esc(template.name || "Template")}</button>`).join("")}
                  </div>
                  <div class="lead-page-v5-email-fields">
                    <div class="lead-page-v5-email-row"><label>Send To</label><div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">${recipientToggleButtonsHtml}</div></div>
                    <div class="lead-page-v5-email-row"><label>Emails</label><div class="lead-page-v5-email-pill-list">${recipientPillsHtml}</div></div>
                    <div class="lead-page-v5-email-row"><label>Bcc</label><input type="text" data-lead-email-bcc value="${esc(compose.bcc || "")}" placeholder="Optional bcc recipients"></div>
                    <div class="lead-page-v5-email-row"><label>Subj</label><input type="text" data-lead-email-subject value="${esc(compose.subject || "")}"></div>
                    ${recipientInfoHtml}
                  </div>
                    <div class="lead-page-v5-email-toolbar">
                      ${toolbarButtons
                      .map(
                        (button) =>
                          `<button class="lead-page-v5-email-toolbtn" type="button" data-email-window-target="${esc(windowId)}" data-lead-email-format="${esc(
                            button.command,
                          )}" title="${esc(button.label)}"><i class="fas ${esc(
                            button.icon,
                          )}"></i></button>`,
                      )
                      .join("")}
                    <input type="file" accept="image/*" data-email-window-target="${esc(windowId)}" data-lead-email-inline-image-file style="display:none">
                  </div>
                  <div class="lead-page-v5-email-editor-wrap">
                    <div class="lead-page-v5-email-editor" contenteditable="true" data-lead-email-body>${emailBodyHtml}</div>
                    <div class="lead-page-v5-email-signature">${signatureHtml}</div>
                    ${signatureNoteHtml}
                  </div>
                  <div class="lead-page-v5-email-attachments">
                    <div class="lead-page-v5-email-attachments-head">
                      <div class="lead-page-v5-email-attachments-title">Sample Report Attachments</div>
                    </div>
                    <div class="lead-page-v5-email-attachment-grid">
                      <div class="lead-page-v5-email-branding-panel">
                        <input type="file" accept="image/*" data-email-window-target="${esc(windowId)}" data-lead-email-logo-file style="display:none">
                        <div class="lead-page-v5-email-branding-row">
                          <button class="lead-page-v5-email-logo-tile" type="button" data-email-window-target="${esc(windowId)}" data-lead-email-logo-pick title="${esc(branding.logoDataUrl ? "Update logo" : "Upload logo")}">
                            ${branding.logoDataUrl ? `<img class="lead-page-v5-email-logo-preview" src="${esc(branding.logoDataUrl)}" alt="Brand logo">` : `<div class="lead-page-v5-email-logo-placeholder"><span>Click to add logo</span></div>`}
                          </button>
                          <div class="lead-page-v5-email-branding-copy">
                            <div class="lead-page-v5-email-branding-title">Branding</div>
                            <div class="lead-page-v5-email-branding-colors">
                              <label class="lead-page-v5-email-brand-field">Primary <input type="color" value="${esc(branding.primaryColor || "#c82828")}" data-email-window-target="${esc(windowId)}" data-lead-email-brand-primary></label>
                              <label class="lead-page-v5-email-brand-field">Secondary <input type="color" value="${esc(branding.secondaryColor || "#4a5563")}" data-email-window-target="${esc(windowId)}" data-lead-email-brand-secondary></label>
                            </div>
                            <div class="lead-page-v5-email-branding-save ${brandingState.status === "saved" ? "saved" : brandingState.status === "error" ? "error" : ""}">${brandingState.status === "saving" ? '<i class="fas fa-spinner fa-spin"></i> Saving...' : brandingState.status === "saved" ? '<i class="fas fa-circle-check"></i> Saved' : brandingState.status === "error" ? esc(brandingState.message || "Could not save branding.") : ''}</div>
                          </div>
                        </div>
                      </div>
                      <div class="lead-page-v5-email-report-panel">
                        <div class="lead-page-v5-email-report-list">
                          ${attachmentRowsHtml}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="lead-page-v5-email-footer">
                    <div class="lead-page-v5-email-send-status ${sending ? "saving" : sendState.status === "error" && String(sendState.windowId || "") === windowId ? "error" : ""}">${sending ? '<i class="fas fa-spinner fa-spin"></i> Sending through Gmail...' : sendState.status === "error" && String(sendState.windowId || "") === windowId ? esc(windowSendMessage || "Could not send email.") : ""}</div>
                    <button class="lead-page-v5-btn-secondary" type="button" data-lead-close-email="${esc(windowId)}">Cancel</button>
                    <button class="lead-page-v5-btn-primary" type="button" data-lead-send-email="${esc(windowId)}" ${(canSend && !sending) ? "" : `disabled title="${!gmail.connected ? "Connect Gmail first" : !sendRecipientCount ? "Choose a recipient or enter an email first" : "Email is sending"}" style="opacity:.55;cursor:not-allowed"`}>
                      <i class="fas ${sending ? "fa-spinner fa-spin" : "fa-paper-plane"}"></i> ${sending ? "Sending..." : "Send"}
                    </button>
                  </div>
                  <button class="lead-page-v5-email-resize" type="button" tabindex="-1" aria-hidden="true" data-lead-email-resize-handle="${esc(windowId)}"></button>
                `
            }
          </div>
        `;
      })
      .join("") + renderEmailAttachmentPreviewModal(state);
    }
    function renderEmailAttachmentPreviewModal(state) {
      const preview = state.ui?.emailPreview || {};
      if (!preview.open) return "";
      const files = Array.isArray(preview.files) ? preview.files : [];
      const activeIndex = Math.max(
        0,
        Math.min(files.length - 1, Number(preview.activeIndex || 0)),
      );
      const activeFile = files[activeIndex] || null;
      return `<div class="lead-page-v5-email-preview-overlay" data-lead-email-preview-close>
        <div class="lead-page-v5-email-preview-modal">
          <div class="lead-page-v5-email-preview-head">
            <div class="lead-page-v5-email-preview-title">${esc(preview.title || "PDF Preview")}</div>
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              ${
                files.length > 1
                  ? `<div class="lead-page-v5-email-preview-tabs">${files
                      .map(
                        (file, index) =>
                          `<button class="lead-page-v5-email-preview-tab ${index === activeIndex ? "active" : ""}" type="button" data-lead-email-preview-index="${esc(
                            String(index),
                          )}">${esc(file.label || file.filename || `Preview ${index + 1}`)}</button>`,
                      )
                      .join("")}</div>`
                  : ""
              }
              <button class="lead-page-v5-ghost" type="button" data-lead-email-preview-close><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div class="lead-page-v5-email-preview-body">
            ${
              preview.loading
                ? `<div class="lead-page-v5-email-preview-status"><i class="fas fa-spinner fa-spin" style="margin-right:8px"></i>Generating PDF preview...</div>`
                : preview.error
                  ? `<div class="lead-page-v5-email-preview-status">${esc(preview.error)}</div>`
                  : activeFile?.url
                    ? `<iframe class="lead-page-v5-email-preview-frame" src="${esc(activeFile.url)}" title="${esc(activeFile.filename || "PDF Preview")}"></iframe>`
                    : `<div class="lead-page-v5-email-preview-status">No preview available yet.</div>`
            }
          </div>
        </div>
      </div>`;
    }
    function renderLeadToast(state) {
    const toast = state.toast || {};
    if (!toast.open || !toast.message) return "";
    const tone = toast.tone === "error" ? "error" : "success";
    const icon = tone === "error" ? "fa-circle-exclamation" : "fa-circle-check";
    return `<div class="lead-page-v5-toast ${tone}"><i class="fas ${icon}"></i><span>${esc(toast.message)}</span></div>`;
  }
  function renderBody(lead, opts, state) {
    const ownerEmail =
      lead.list_assigned_to_email || lead.assigned_to_email || "";
    const leadTimeInfo = getLeadTimeInfo(lead);
    const leadCoreDraft =
      state.leadCoreDraft && typeof state.leadCoreDraft === "object"
        ? state.leadCoreDraft
        : blankLeadCoreDraft(lead);
    const websiteHref = String(leadCoreDraft.website || "").trim()
      ? (String(leadCoreDraft.website || "").trim().startsWith("http")
          ? String(leadCoreDraft.website || "").trim()
          : `https://${String(leadCoreDraft.website || "").trim()}`)
      : "";
    const stage = normalizeStageLabel(
      state.ui?.stageValue || lead.status || "Contacted",
    );
    const showFunded = !!lead.organization_snapshot;
    const orderCount = Number(
      lead.organization_snapshot?.lifetimeOrders ??
        lead.organization_snapshot?.orders?.length ??
        0,
    );
    const fundedState =
      typeof state.ui?.milestoneFunded === "boolean"
        ? state.ui.milestoneFunded
        : showFunded;
    const ordersState =
      typeof state.ui?.milestoneOrders === "boolean"
        ? state.ui.milestoneOrders
        : orderCount >= 10;
    const activeSequence = activeSequenceInfo(lead);
    const userName =
      window.Portal?.cfg?.user?.name ||
      window.LEAD_VIEWER_CFG?.user_name ||
      "Sales Rep";
    const bannerText =
      stage === "Info Sent"
        ? "This lead is at Info Sent - did they confirm receipt?"
        : `Lead is at ${stage} - keep the conversation moving.`;
    const bannerButtonLabel =
      stage === "Info Sent" ? "Mark Info Received" : "Advance Stage";
    const showBanner = true;
    return `      <div class="lead-page-v5-root">        ${opts.callbackMode ? `<div style="display:grid;gap:8px;padding:8px 24px 0"><div class="lead-page-v5-logo">FirstMate <span>CRM</span></div><div class="lead-page-v5-topbar" style="padding:0;border-bottom:none;background:transparent;position:static;justify-content:flex-start"><div class="lead-page-v5-topbar-left">${opts.backHref ? `<a class="lead-page-v5-back" href="${esc(opts.backHref)}"><i class="fas fa-arrow-left"></i> Back</a>` : typeof opts.onBack === "function" ? `<button class="lead-page-v5-back" type="button" data-lead-page-back><i class="fas fa-arrow-left"></i> Back</button>` : ""}</div></div></div>` : `<div class="lead-page-v5-topbar" style="padding:0 0 12px;border-bottom:none;background:transparent;position:static;justify-content:flex-start"><div class="lead-page-v5-topbar-left">${typeof opts.onBack === "function" ? `<button class="lead-page-v5-back" type="button" data-lead-page-back><i class="fas fa-arrow-left"></i> Back</button>` : opts.backHref ? `<a class="lead-page-v5-back" href="${esc(opts.backHref)}"><i class="fas fa-arrow-left"></i> Back</a>` : ""}</div></div>`}        ${showBanner ? `<div class="lead-page-v5-banner">          <div class="lead-page-v5-banner-text"><i class="fas fa-info-circle"></i> ${esc(bannerText)}</div>          <button class="lead-page-v5-banner-btn" type="button" data-lead-banner-action><i class="fas fa-check"></i> ${esc(bannerButtonLabel)}</button>        </div>` : ""}        <div class="lead-page-v5-header">          <div class="lead-page-v5-header-left">            <div class="lead-page-v5-title-row">              <input class="lead-page-v5-company" style="width:min(100%,560px);margin:0;padding:0;border:none;outline:none;background:transparent;color:inherit;font:inherit;font-weight:900;letter-spacing:-.03em" data-lead-core-name type="text" value="${esc(leadCoreDraft.display_name || "Lead")}">              <span class="lead-page-v5-stage-pill"><i class="fas fa-circle" style="font-size:8px"></i> ${esc(stage)}</span>            </div>            <div class="lead-page-v5-sub">${esc(lead.list_name || "-")} - ${esc(lead.list_assigned_to_name || ownerEmail || "Unassigned")} - Updated ${esc(fmtRelativeFromTs(lead.updated_at))}</div>            <div class="lead-page-v5-badges">              ${state.ui?.sequenceBadge ? `<div class="lead-page-v5-seq"><i class="fas fa-bolt"></i> ${esc(state.ui.sequenceBadge)} ${activeSequence ? `<button type="button" data-lead-sequence-action="${esc(activeSequence.sequence_key || "")}" data-lead-sequence-operation="${activeSequence.status === "stopped" ? "resume" : "stop"}">${activeSequence.status === "stopped" ? "Resume" : "Stop"}</button>` : ""}</div>` : ""}              ${fundedState ? `<span class="lead-page-v5-tag funded"><i class="fas fa-check-circle"></i> Account Funded</span>` : ""}              ${ordersState ? `<span class="lead-page-v5-tag orders"><i class="fas fa-check-circle"></i> 10 Orders</span>` : ""}                          </div>          </div>          <div class="lead-page-v5-header-right">            <button class="lead-page-v5-btn-primary" type="button" data-lead-open-email><i class="fas fa-paper-plane"></i> Send Email</button>            <button class="lead-page-v5-btn-green" type="button" data-lead-open-sms><i class="fas fa-comment"></i> Send SMS</button>            <button class="lead-page-v5-btn-secondary" type="button" data-lead-tools-open><i class="fas fa-toolbox"></i> Tools</button>${leadTimeInfo ? `<div class="lead-page-v5-local-time lead-page-v5-local-time-header"><i class="fas fa-clock"></i> Local Time: ${esc(leadTimeInfo.label)}</div>` : ""}</div>        </div>        <div class="lead-page-v5-layout">          <div class="lead-page-v5-left">            <div class="lead-page-v5-card">              <div class="lead-page-v5-card-header">                <h3><i class="fas fa-info-circle"></i> Company Info</h3>                <div class="lead-page-v5-card-header-right">${renderSaveState(state.saveStates?.leadCore, "Autosaves in place")}</div>              </div>              <div class="lead-page-v5-card-body">                <div class="lead-page-v5-stage-select">                  <label>Stage</label>                  <select data-lead-stage-select>                    ${mockupStageOptions()
      .map(
        (option) =>
          `<option value="${esc(option)}" ${option === stage ? "selected" : ""}>${esc(option)}</option>`,
      )
      .join(
        "",
)}                  </select>                </div>                <div class="lead-page-v5-company-grid" data-autosave-lead-core>                  <div>                    <div class="lead-page-v5-field-row"><div class="lead-page-v5-field-label">Phone</div><div class="lead-page-v5-field-value"><input class="lead-page-v5-inline-input" style="border:none;background:none;padding:0;font-size:13px;font-weight:600" data-lead-core-field="phone" type="text" value="${esc(leadCoreDraft.phone || "")}" placeholder="-"></div></div>                    <div class="lead-page-v5-field-row"><div class="lead-page-v5-field-label">Website</div><div class="lead-page-v5-field-value" style="display:flex;align-items:center;gap:8px"><input class="lead-page-v5-inline-input is-link" style="border:none;background:none;padding:0;font-size:13px;font-weight:600;color:var(--b)" data-lead-core-field="website" type="text" value="${esc(leadCoreDraft.website || "")}" placeholder="-">${websiteHref ? `<a href="${esc(websiteHref)}" target="_blank" rel="noopener" title="Open website" style="flex:0 0 auto;color:var(--b);font-size:12px"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}</div></div>                    <div class="lead-page-v5-field-row"><div class="lead-page-v5-field-label">Rating</div><div class="lead-page-v5-field-value">${esc(String(lead.metadata?.rating ?? "-"))} <span style="color:var(--s4);font-size:11px">(${esc(String(lead.metadata?.user_ratings_total ?? 0))} reviews)</span></div></div>                  </div>                  <div>                    <div class="lead-page-v5-field-row"><div class="lead-page-v5-field-label">Email</div><div class="lead-page-v5-field-value"><input class="lead-page-v5-inline-input" style="border:none;background:none;padding:0;font-size:13px;font-weight:600" data-lead-core-field="email" type="email" value="${esc(leadCoreDraft.email || "")}" placeholder="-"></div></div>                    <div class="lead-page-v5-field-row"><div class="lead-page-v5-field-label">Address</div><div class="lead-page-v5-field-value"><textarea class="lead-page-v5-inline-textarea" style="border:none;background:none;padding:0;font-size:13px;font-weight:600;min-height:40px" data-lead-core-field="address" rows="2" placeholder="-">${esc(leadCoreDraft.address || "")}</textarea></div></div>                  </div>                </div>                <div class="lead-page-v5-subsection">                  <div class="lead-page-v5-subsection-head"><h4>Contacts</h4></div>                  ${renderMockupContacts(lead, state)}                </div>                <div class="lead-page-v5-subsection">                  ${renderMockupAccount(lead, state)}                </div>                <div class="lead-page-v5-subsection">                  <div class="lead-page-v5-subsection-head"><h4>Referrals</h4></div>                  <div class="lead-page-v5-referral-empty">No referrals from this company yet.</div>                </div>              </div>            </div>          </div>          <div class="lead-page-v5-right">            ${renderMockupActivity(lead, state)}          </div>        </div>        ${renderMockupSmsModal(lead, state)}        ${renderMockupEmailComposer(lead, state)}        ${renderLeadToast(state)}              </div>    `;
  }
  function createController(options) {
    const opts = options || {};
    const api = opts.api;
    const bodyEl = opts.bodyEl;
    const titleEl = opts.titleEl || null;
    const serverEndpoint =
      window.Portal?.cfg?.endpoints?.server || window.Portal.internalLegacyEndpoint();
    const LEAD_AUTO_REFRESH_MS = 300000;
    const LEAD_FOCUS_REFRESH_MS = 60000;
    let currentLead = null;
    let focusoutTimer = null;
    let gmailPopupMessageHandler = null;
    let toastTimer = null;
    let emailBrandingSaveTimer = null;
    let emailPointerState = null;
    let emailEditorSelection = null;
    let leadAutoRefreshTimer = null;
    let leadAutoRefreshInFlight = false;
    let leadCoreSaveTimer = null;
    let leadLastRefreshAt = 0;
    let leadVisibilityHandler = null;
    let leadFocusHandler = null;
    let leadBackgroundSyncHandler = null;
    let sampleReportPdfRuntimePromise = null;
    let state = createInitialState();
    function findRuntimeScriptUrl(matcher, fallbackPath) {
      const scripts = Array.from(document.scripts || []);
      const existing = scripts.find((script) => {
        const src = String(script?.src || "");
        return src && matcher.test(src);
      });
      if (existing?.src) return existing.src;
      return new URL(fallbackPath, window.location.href).toString();
    }
    function appendRuntimeBust(url, key) {
      try {
        const resolved = new URL(url, window.location.href);
        resolved.searchParams.set("_fm_retry", key || String(Date.now()));
        return resolved.toString();
      } catch (_) {
        const joiner = String(url || "").includes("?") ? "&" : "?";
        return `${url}${joiner}_fm_retry=${encodeURIComponent(
          key || String(Date.now()),
        )}`;
      }
    }
    function loadRuntimeScript(url, key) {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = appendRuntimeBust(url, key);
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () =>
          reject(new Error(`Could not load runtime script: ${url}`));
        document.head.appendChild(script);
      });
    }
    async function ensureSampleReportPdfRuntimeAvailable() {
      if (
        window.FirstMatePDFStandalone &&
        typeof window.FirstMatePDFStandalone.generateProjectPdfFromSnapshot ===
          "function"
      ) {
        return window.FirstMatePDFStandalone;
      }
      if (sampleReportPdfRuntimePromise) {
        return sampleReportPdfRuntimePromise;
      }
      sampleReportPdfRuntimePromise = (async () => {
        const jsPdfUrl = findRuntimeScriptUrl(
          /jspdf(?:\.umd)?(?:\.min)?\.js/i,
          "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
        );
        const pdfRuntimeUrl = findRuntimeScriptUrl(
          /editor_scripts\/pdf\.js/i,
          "editor_scripts/pdf.js",
        );
        const standaloneUrl = findRuntimeScriptUrl(
          /editor_scripts\/pdf_standalone\.js/i,
          "editor_scripts/pdf_standalone.js",
        );

        if (!window.jspdf || !window.jspdf.jsPDF) {
          await loadRuntimeScript(jsPdfUrl, "jspdf");
        }
        if (typeof window.generatePDFFromState !== "function") {
          await loadRuntimeScript(pdfRuntimeUrl, "pdfjs");
        }
        if (
          !window.FirstMatePDFStandalone ||
          typeof window.FirstMatePDFStandalone.generateProjectPdfFromSnapshot !==
            "function"
        ) {
          await loadRuntimeScript(standaloneUrl, "pdfstandalone");
        }
        if (
          !window.FirstMatePDFStandalone ||
          typeof window.FirstMatePDFStandalone.generateProjectPdfFromSnapshot !==
            "function"
        ) {
          throw new Error(
            "The sample report PDF runtime is not available right now. Refresh the page and try again.",
          );
        }
        return window.FirstMatePDFStandalone;
      })();
      try {
        return await sampleReportPdfRuntimePromise;
      } finally {
        sampleReportPdfRuntimePromise = null;
      }
    }
    function createSaveState(status, message) {
      return { status: status || "idle", message: message || "" };
    }
    function blankContactDraft() {
      return {
        contact_id: "",
        full_name: "",
        title: "",
        title_preset: "",
        email: "",
        secondary_emails_text: "",
        phone: "",
        notes: "",
      };
    }
    function blankLeadCoreDraft(lead) {
      return {
        display_name: String(lead?.company || lead?.lead_name || "").trim(),
        email: String(lead?.email || "").trim(),
        phone: formatUsPhone(lead?.phone || ""),
        website: String(lead?.website || "").trim(),
        address: String(lead?.address || "").trim(),
      };
    }
    function blankFollowupDraft() {
      return {
        title: "",
        body: "",
        followup_date: "",
        followup_slot: "",
        meeting_date: "",
        meeting_time: "",
        duration_minutes: 30,
      };
    }
    function blankEmailCompose() {
      return {
        template: "",
        bcc: "",
        manualRecipientEmail: "",
        manualRecipientEmails: [],
        recipientContactEnabled: {},
        recipientEmailSelections: {},
        subject: "",
        body: "",
        bodyHtml: "",
        signatureHtml: "",
        attachments: [],
        branding: {
          primaryColor: "",
          secondaryColor: "",
          logoDataUrl: "",
        },
        threadId: "",
        inReplyTo: "",
        references: "",
      };
    }
    function blankUiState() {
      return {
        accountTab: "ov",
        activityFilter: "all",
        calendarMiniOpen: false,
        calendarInviteContacts: false,
        calendarAddMeet: false,
        calendarTimeBusy: false,
        calendarEventsDate: "",
        calendarEventsLoading: false,
        calendarEventsError: "",
        calendarDayEvents: [],
        calendarDayViewDate: "",
        calendarDayViewScrollTop: 0,
        emailOpen: false,
        smsOpen: false,
        smsRefreshing: false,
        smsThreadId: "",
        smsRecipientContactId: "",
        smsPhone: "",
        smsDraft: "",
        smsTemplate: "",
        billingCreditAmount: "",
        billingCreditNote: "",
        callDispositionDrafts: {},
        callNoteDrafts: {},
        contactFormOpen: false,
        historyExpanded: true,
        historyOpen: {},
        historyClosed: {},
        stageValue: "Contacted",
        sequenceBadge: "",
        milestoneFunded: false,
        milestoneOrders: false,
        emailWindows: [],
        activeEmailWindowId: "",
        emailWindowCounter: 0,
        emailCompose: blankEmailCompose(),
        leadCoreFocus: null,
        leadCoreSaveQueued: false,
        emailPreview: {
          open: false,
          loading: false,
          error: "",
          title: "",
          files: [],
          activeIndex: 0,
        },
      };
    }
    function nextEmailWindowId() {
      state.ui.emailWindowCounter = Number(state.ui.emailWindowCounter || 0) + 1;
      return `email_window_${state.ui.emailWindowCounter}`;
    }
    function defaultEmailWindowFrame(index) {
      const viewportWidth = Math.max(
        640,
        window.innerWidth || document.documentElement.clientWidth || 1280,
      );
      const viewportHeight = Math.max(
        520,
        window.innerHeight || document.documentElement.clientHeight || 900,
      );
      const width = Math.min(860, Math.max(640, Math.round(viewportWidth * 0.56)));
      const height = Math.min(780, Math.max(540, Math.round(viewportHeight * 0.68)));
      const toolsOffset = viewportWidth > 760 ? 154 : 16;
      const staggerX = Number(index || 0) * 28;
      const staggerY = Number(index || 0) * 20;
      return {
        x: Math.max(16, viewportWidth - width - toolsOffset - staggerX),
        y: Math.max(16, viewportHeight - height - 18 - staggerY),
        width,
        height,
        z: 200 + Number(index || 0),
      };
    }
    function emailWindows() {
      return Array.isArray(state.ui?.emailWindows) ? state.ui.emailWindows : [];
    }
    function activeEmailWindow() {
      const windows = emailWindows();
      const activeId = String(state.ui?.activeEmailWindowId || "");
      return (
        windows.find((item) => String(item?.id || "") === activeId) ||
        windows.slice().sort((a, b) => Number(b?.z || 0) - Number(a?.z || 0))[0] ||
        null
      );
    }
    function resolveEmailWindowId(windowId) {
      return String(
        windowId || activeEmailWindow()?.id || state.ui?.activeEmailWindowId || "",
      );
    }
    function emailComposeForWindow(windowId) {
      const id = resolveEmailWindowId(windowId);
      const target = emailWindows().find(
        (item) => String(item?.id || "") === id,
      );
      return {
        ...blankEmailCompose(),
        ...(target?.compose || state.ui?.emailCompose || {}),
      };
    }
    function syncActiveEmailCompose() {
      const activeWindow = activeEmailWindow();
      state.ui.emailOpen = emailWindows().length > 0;
      state.ui.activeEmailWindowId = activeWindow ? String(activeWindow.id || "") : "";
      state.ui.emailCompose = {
        ...blankEmailCompose(),
        ...(activeWindow?.compose || {}),
      };
    }
    function ensureEmailWindowsState() {
      if (!Array.isArray(state.ui.emailWindows)) {
        state.ui.emailWindows = [];
      }
      if (
        !state.ui.emailWindows.length &&
        (state.ui.emailOpen || hasEmailComposeContent(state.ui.emailCompose))
      ) {
        const frame = defaultEmailWindowFrame(0);
        state.ui.emailWindows.push({
          id: nextEmailWindowId(),
          minimized: false,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          z: frame.z,
          compose: {
            ...blankEmailCompose(),
            ...(state.ui.emailCompose || {}),
          },
        });
      }
      syncActiveEmailCompose();
    }
    function setActiveEmailWindow(windowId) {
      const id = String(windowId || "");
      const windows = emailWindows();
      const target = windows.find((item) => String(item?.id || "") === id);
      if (!target) {
        syncActiveEmailCompose();
        return null;
      }
      const maxZ = windows.reduce(
        (max, item) => Math.max(max, Number(item?.z || 0)),
        200,
      );
      target.z = maxZ + 1;
      state.ui.activeEmailWindowId = id;
      syncActiveEmailCompose();
      return target;
    }
    function emailWindowElement(windowId) {
      const id = String(windowId || "");
      if (!id || !bodyEl) return null;
      return bodyEl.querySelector(`[data-email-window-id="${CSS.escape(id)}"]`);
    }
    function emailWindowScopedTarget(target, selector) {
      const windowEl = target?.closest?.("[data-email-window-id]");
      return windowEl?.querySelector(selector) || null;
    }
    function clampEmailWindowValue(value, min, max) {
      return Math.min(Math.max(Number(value || 0), min), max);
    }
    function beginEmailPointer(windowId, mode, event) {
      if (!windowId || window.innerWidth <= 760) return;
      const target = setActiveEmailWindow(windowId);
      const el = emailWindowElement(windowId);
      if (!target || !el) return;
      emailPointerState = {
        mode,
        id: windowId,
        el,
        startX: Number(event.clientX || 0),
        startY: Number(event.clientY || 0),
        x: Number(target.x || 24),
        y: Number(target.y || 24),
        width: Number(target.width || el.offsetWidth || 720),
        height: Number(target.height || el.offsetHeight || 620),
      };
      document.body.style.userSelect = "none";
    }
    function handleEmailPointerMove(event) {
      if (!emailPointerState?.el) return;
      const dx = Number(event.clientX || 0) - emailPointerState.startX;
      const dy = Number(event.clientY || 0) - emailPointerState.startY;
      const viewportWidth =
        window.innerWidth || document.documentElement.clientWidth || 1280;
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight || 900;
      if (emailPointerState.mode === "move") {
        const nextX = clampEmailWindowValue(
          emailPointerState.x + dx,
          8,
          Math.max(8, viewportWidth - emailPointerState.el.offsetWidth - 8),
        );
        const nextY = clampEmailWindowValue(
          emailPointerState.y + dy,
          8,
          Math.max(8, viewportHeight - emailPointerState.el.offsetHeight - 8),
        );
        emailPointerState.el.style.left = `${nextX}px`;
        emailPointerState.el.style.top = `${nextY}px`;
        emailPointerState.el.style.right = "auto";
      } else if (emailPointerState.mode === "resize") {
        const nextWidth = clampEmailWindowValue(
          emailPointerState.width + dx,
          480,
          Math.max(480, viewportWidth - emailPointerState.x - 8),
        );
        const nextHeight = clampEmailWindowValue(
          emailPointerState.height + dy,
          420,
          Math.max(420, viewportHeight - emailPointerState.y - 8),
        );
        emailPointerState.el.style.width = `${nextWidth}px`;
        emailPointerState.el.style.height = `${nextHeight}px`;
      }
    }
    function handleEmailPointerUp() {
      if (!emailPointerState?.el) return;
      const finalRect = emailPointerState.el.getBoundingClientRect();
      updateEmailWindow(emailPointerState.id, {
        x: Math.round(finalRect.left),
        y: Math.round(finalRect.top),
        width: Math.round(finalRect.width),
        height: Math.round(finalRect.height),
      });
      emailPointerState = null;
      document.body.style.userSelect = "";
      render();
    }
    function updateEmailWindow(windowId, patch) {
      const id = String(windowId || "");
      const windows = emailWindows();
      const target = windows.find((item) => String(item?.id || "") === id);
      if (!target) return null;
      Object.assign(target, patch || {});
      syncActiveEmailCompose();
      return target;
    }
    function updateEmailWindowCompose(windowId, patch) {
      const id = String(windowId || "");
      const windows = emailWindows();
      const target = windows.find((item) => String(item?.id || "") === id);
      if (!target) return null;
      target.compose = {
        ...blankEmailCompose(),
        ...(target.compose || {}),
        ...(patch || {}),
      };
      state.ui.activeEmailWindowId = id;
      syncActiveEmailCompose();
      return target;
    }
    function hasEmailComposeContent(compose) {
      const draft = compose || {};
      return !!(
        String(draft.bcc || "").trim() ||
        String(draft.manualRecipientEmail || "").trim() ||
        normalizeManualRecipientDrafts(draft).length ||
        String(draft.subject || "").trim() ||
        String(draft.body || "").trim() ||
        String(draft.bodyHtml || "").replace(/<[^>]+>/g, "").trim()
      );
    }
    function createEmailWindow(compose, options) {
      const frame = defaultEmailWindowFrame(0);
      const opts = options || {};
      const nextWindow = {
        id: nextEmailWindowId(),
        minimized: !!opts.minimized,
        x: Number(opts.x ?? frame.x),
        y: Number(opts.y ?? frame.y),
        width: Number(opts.width ?? frame.width),
        height: Number(opts.height ?? frame.height),
        z: Number(opts.z ?? frame.z),
        compose: {
          ...blankEmailCompose(),
          ...(compose || {}),
        },
      };
      state.ui.emailWindows = [nextWindow];
      state.ui.activeEmailWindowId = nextWindow.id;
      syncActiveEmailCompose();
      return nextWindow;
    }
    function closeEmailWindow(windowId, options) {
      const id = String(windowId || "");
      if (!id) return;
      const opts = options || {};
      const windows = emailWindows();
      const target = windows.find((item) => String(item?.id || "") === id);
      if (!target) return;
      if (!opts.force && hasEmailComposeContent(target.compose)) {
        const ok = window.confirm("Discard this draft?");
        if (!ok) return;
      }
      state.ui.emailWindows = windows.filter((item) => String(item?.id || "") !== id);
      syncActiveEmailCompose();
      render();
    }
    function closeAllEmailWindows(force) {
      if (!force && emailWindows().some((item) => hasEmailComposeContent(item?.compose))) {
        const ok = window.confirm("Discard the open email drafts?");
        if (!ok) return;
      }
      state.ui.emailWindows = [];
      syncActiveEmailCompose();
    }
    function openEmailComposeWindow(compose, options) {
      ensureEmailWindowsState();
      const nextWindow = createEmailWindow(compose, options);
      state.ui.smsOpen = false;
      render();
      return nextWindow;
    }
    function createInitialState() {
      return {
        sections: {
          account: () => !currentLead?.organization_snapshot,
          contacts: false,
          notes: false,
          history: false,
          followups: false,
        },
        contactDraft: blankContactDraft(),
        contactNoteTargetId: "",
        contactNoteDrafts: {},
        contactNoteSaveStates: {},
        callAnnotationSaveStates: {},
        newNoteOpen: false,
        noteDraft: "",
        leadCoreDraft: blankLeadCoreDraft(currentLead),
        emailDraft: "",
        emailDirty: false,
        saveStates: {
          companyEmail: createSaveState(),
          leadCore: createSaveState(),
          contact: createSaveState(),
          note: createSaveState(),
          followup: createSaveState(),
          stage: createSaveState(),
          emailSend: createSaveState(),
          emailBranding: createSaveState(),
          smsSend: createSaveState(),
          sequence: createSaveState(),
          milestone: createSaveState(),
          calendar: createSaveState(),
        },
        followupDraft: blankFollowupDraft(),
        ui: blankUiState(),
        toast: { open: false, message: "", tone: "success" },
      };
    }
    function showToast(message, tone, duration) {
      const nextMessage = String(message || "").trim();
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      state.toast = {
        open: nextMessage !== "",
        message: nextMessage,
        tone: tone === "error" ? "error" : "success",
      };
      render();
      if (!nextMessage) return;
      toastTimer = setTimeout(() => {
        state.toast = { open: false, message: "", tone: "success" };
        render();
      }, Math.max(1200, Number(duration || 2600)));
    }
    function stopLeadAutoRefresh() {
      if (leadAutoRefreshTimer) {
        clearInterval(leadAutoRefreshTimer);
        leadAutoRefreshTimer = null;
      }
    }
    function markLeadRefreshComplete() {
      leadLastRefreshAt = Date.now();
    }
    function shouldAutoRefreshLead() {
      return !opts.callbackMode && !!currentLead?.id && !document.hidden;
    }
    async function refreshLeadActivity(reason, refreshOptions) {
      const options = refreshOptions || {};
      if (!currentLead?.id || leadAutoRefreshInFlight) return;
      if (!options.force && !shouldAutoRefreshLead()) return;
      const smsRefresh = !!options.smsOnly;
      if (smsRefresh) {
        state.ui.smsRefreshing = true;
        render();
      }
      leadAutoRefreshInFlight = true;
      try {
        await loadLead(currentLead.id, {
          resetTransient: false,
          silent: options.silent !== false,
          skipExternalSync: !!options.skipExternalSync,
          forceRingCentralSync: !!options.forceRingCentralSync,
        });
        if (typeof opts.onUpdated === "function") opts.onUpdated(currentLead);
        markLeadRefreshComplete();
      } finally {
        if (smsRefresh) {
          state.ui.smsRefreshing = false;
          render();
        }
        leadAutoRefreshInFlight = false;
      }
    }
    function startLeadAutoRefresh() {
      if (opts.callbackMode) return;
      stopLeadAutoRefresh();
      if (!currentLead?.id) return;
      markLeadRefreshComplete();
      leadAutoRefreshTimer = setInterval(() => {
        refreshLeadActivity("interval", {
          skipExternalSync: true,
          forceRingCentralSync: false,
        });
      }, LEAD_AUTO_REFRESH_MS);
    }
    function maybeRefreshLeadOnForeground(reason) {
      if (opts.callbackMode) return;
      if (!currentLead?.id || document.hidden) return;
      if ((Date.now() - leadLastRefreshAt) < LEAD_FOCUS_REFRESH_MS) return;
      refreshLeadActivity(reason, { force: true, skipExternalSync: true, forceRingCentralSync: false });
    }
    function bindLeadAutoRefreshEvents() {
      if (opts.callbackMode) return;
      if (!leadVisibilityHandler) {
        leadVisibilityHandler = () => {
          if (!document.hidden) maybeRefreshLeadOnForeground("visibility");
        };
        document.addEventListener("visibilitychange", leadVisibilityHandler);
      }
      if (!leadFocusHandler) {
        leadFocusHandler = () => maybeRefreshLeadOnForeground("focus");
        window.addEventListener("focus", leadFocusHandler);
      }
      if (!leadBackgroundSyncHandler) {
        leadBackgroundSyncHandler = (event) => {
          const provider = String(event?.detail?.provider || "").trim().toLowerCase();
          if (!currentLead?.id) return;
          if (provider !== "gmail" && provider !== "ringcentral") return;
          window.setTimeout(() => {
            refreshLeadActivity(`${provider}_background_sync`, { force: true });
          }, 250);
        };
        window.addEventListener(
          "firstmate-background-sync-complete",
          leadBackgroundSyncHandler,
        );
      }
    }
    function resetContactDraft(contact) {
      const title = String(contact?.title || "");
      const presets = ["Receptionist", "Owner", "Manager"];
      state.contactDraft = {
        contact_id: String(contact?.id || ""),
        full_name: String(contact?.full_name || ""),
        title,
        title_preset: presets.includes(title) ? title : title ? "Other" : "",
        email: String(contact?.email || ""),
        secondary_emails_text: Array.isArray(contact?.secondary_emails)
          ? contact.secondary_emails.join(", ")
          : "",
        phone: String(contact?.phone || ""),
        notes: String(contact?.notes || ""),
      };
    }
    function resetTransientDrafts() {
      state.contactDraft = blankContactDraft();
      state.contactNoteTargetId = "";
      state.contactNoteDrafts = {};
      state.contactNoteSaveStates = {};
      state.callAnnotationSaveStates = {};
      state.newNoteOpen = false;
      state.noteDraft = "";
      state.followupDraft = blankFollowupDraft();
      state.saveStates = {
        companyEmail: createSaveState(),
        contact: createSaveState(),
        note: createSaveState(),
        followup: createSaveState(),
        stage: createSaveState(),
        emailSend: createSaveState(),
        smsSend: createSaveState(),
        sequence: createSaveState(),
        milestone: createSaveState(),
        calendar: createSaveState(),
      };
      state.ui = blankUiState();
    }
    function setSaveState(key, status, message) {
      state.saveStates[key] = createSaveState(status, message);
    }
    function leadCoreDraftChanged(draftValue, leadValue) {
      const draft = draftValue || state.leadCoreDraft || blankLeadCoreDraft(currentLead);
      const lead = leadValue || currentLead || {};
      const baseline = blankLeadCoreDraft(lead);
      return ["display_name", "email", "phone", "website", "address"].some(
        (key) => String(draft[key] || "").trim() !== String(baseline[key] || "").trim(),
      );
    }
    function captureLeadCoreFocusFromElement() {}
    function restoreLeadCoreFocus() {}
    function activeLeadCoreInput() {
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      ) {
        if (
          active.hasAttribute("data-lead-core-name") ||
          active.hasAttribute("data-lead-core-field")
        ) {
          return active;
        }
      }
      return null;
    }
    function setContactNoteSaveState(contactId, status, message) {
      if (!contactId) return;
      state.contactNoteSaveStates[contactId] = createSaveState(status, message);
    }
    function setCallAnnotationSaveState(dialEventId, status, message) {
      if (!dialEventId) return;
      state.callAnnotationSaveStates[dialEventId] = createSaveState(status, message);
    }
    function contactBaseline() {
      if (!state.contactDraft.contact_id) return blankContactDraft();
      const existing = (currentLead?.contacts || []).find(
        (item) => String(item.id) === String(state.contactDraft.contact_id),
      );
      if (!existing) return blankContactDraft();
      const title = String(existing.title || "");
      const presets = ["Receptionist", "Owner", "Manager"];
      return {
        contact_id: String(existing.id || ""),
        full_name: String(existing.full_name || ""),
        title,
        title_preset: presets.includes(title) ? title : title ? "Other" : "",
        email: String(existing.email || ""),
        secondary_emails_text: Array.isArray(existing.secondary_emails)
          ? existing.secondary_emails.join(", ")
          : "",
        phone: String(existing.phone || ""),
        notes: String(existing.notes || ""),
      };
    }
    function contactDraftHasContent(draft) {
      return [
        draft.full_name,
        draft.title,
        draft.email,
        draft.secondary_emails_text,
        draft.phone,
        draft.notes,
      ].some((value) => String(value || "").trim() !== "");
    }
    function contactDraftChanged() {
      const draft = state.contactDraft || blankContactDraft();
      const baseline = contactBaseline();
      return ["full_name", "title", "email", "secondary_emails_text", "phone", "notes"].some(
        (key) =>
          String(draft[key] || "").trim() !==
          String(baseline[key] || "").trim(),
      );
    }
    function updateContactDirtyState() {
      if (
        !contactDraftHasContent(state.contactDraft) &&
        !state.contactDraft.contact_id
      ) {
        setSaveState("contact", "idle");
        return;
      }
      setSaveState("contact", contactDraftChanged() ? "dirty" : "idle");
    }
    function updateFollowupDirtyState() {
      const draft = state.followupDraft || blankFollowupDraft();
      const hasContent =
        String(draft.body || "").trim() !== "" ||
        String(draft.followup_date || "").trim() !== "" ||
        String(draft.followup_slot || "").trim() !== "" ||
        String(draft.meeting_date || "").trim() !== "" ||
        String(draft.meeting_time || "").trim() !== "" ||
        Number(draft.duration_minutes || 30) !== 30;
      setSaveState("followup", hasContent ? "dirty" : "idle");
    }
    function activeUserName() {
      return (
        window.Portal?.cfg?.user?.name ||
        window.LEAD_VIEWER_CFG?.user_name ||
        "Sales Rep"
      );
    }
    function activeUserEmail() {
      return (
        window.Portal?.cfg?.user?.email ||
        window.LEAD_VIEWER_CFG?.user_email ||
        ""
      );
    }
    function companyRecipient() {
      const draft = state.leadCoreDraft || {};
      return {
        id: COMPANY_RECIPIENT_ID,
        full_name: "Company",
        email: String(draft.email || currentLead?.email || "").trim(),
        phone: String(draft.phone || currentLead?.phone || "").trim(),
        secondary_emails: [],
        secondary_phones: [],
        metadata: { is_company: true },
      };
    }
    function listContacts() {
      return Array.isArray(currentLead?.contacts) ? currentLead.contacts : [];
    }
    function selectableRecipients() {
      return [companyRecipient(), ...listContacts()];
    }
    function normalizeRecipientEmail(value) {
      const email = String(value || "").trim().toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
    }
    function emailThreadMessageIds(value) {
      return Array.from(
        new Set(
          (String(value || "").match(/<[^<>\r\n]+>/g) || [])
            .map((entry) => String(entry || "").trim())
            .filter(Boolean),
        ),
      );
    }
    function emailThreadReplyHeaderId(...values) {
      for (const value of values) {
        const ids = emailThreadMessageIds(value);
        if (ids.length) return ids[ids.length - 1];
      }
      return "";
    }
    function emailThreadReferences(...values) {
      const ordered = [];
      const seen = new Set();
      values.forEach((value) => {
        emailThreadMessageIds(value).forEach((id) => {
          if (seen.has(id)) return;
          seen.add(id);
          ordered.push(id);
        });
      });
      return ordered.join(" ");
    }
    function normalizeManualRecipientDrafts(composeOrValues) {
      const rawList = Array.isArray(composeOrValues)
        ? composeOrValues
        : Array.isArray(composeOrValues?.manualRecipientEmails)
          ? composeOrValues.manualRecipientEmails
          : String(composeOrValues?.manualRecipientEmail || "").trim()
            ? [composeOrValues.manualRecipientEmail]
            : [];
      return rawList
        .map((value) => String(value || "").trim())
        .filter((value) => value !== "");
    }
    function manualRecipientInputsForWindow(windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const container = emailWindowElement(targetWindowId);
      if (!container) return [];
      return Array.from(
        container.querySelectorAll("[data-lead-email-manual-pill]"),
      );
    }
    function manualRecipientDraftsFromDom(windowId) {
      return manualRecipientInputsForWindow(windowId)
        .map((input) => String(input?.value || "").trim())
        .filter((value) => value !== "");
    }
    function focusManualRecipientPill(windowId, index) {
      const targetWindowId = resolveEmailWindowId(windowId);
      window.requestAnimationFrame(() => {
        const input = emailWindowElement(targetWindowId)?.querySelector(
          `[data-lead-email-manual-pill="${CSS.escape(String(index))}"]`,
        );
        if (!input) return;
        input.focus();
        const length = String(input.value || "").length;
        if (typeof input.setSelectionRange === "function") {
          input.setSelectionRange(length, length);
        }
      });
    }
    function setManualRecipientDrafts(windowId, drafts) {
      updateEmailWindowCompose(windowId, {
        manualRecipientEmails: normalizeManualRecipientDrafts(drafts),
        manualRecipientEmail: "",
      });
    }
    function commitManualRecipientPill(windowId, index) {
      const inputs = manualRecipientInputsForWindow(windowId);
      if (!inputs.length) return;
      const currentInput = inputs.find(
        (input) =>
          String(input.getAttribute("data-lead-email-manual-pill") || "") ===
          String(index),
      );
      if (!currentInput) return;
      const drafts = manualRecipientDraftsFromDom(windowId);
      const insertAt = Math.max(0, Math.min(Number(index) || 0, drafts.length));
      const rawValue = String(currentInput.value || "").trim();
      const pieces = rawValue
        .split(/[,\n;]+/)
        .map((value) => String(value || "").trim())
        .filter((value) => value !== "");
      const nextDrafts = drafts
        .filter((_, itemIndex) => itemIndex !== insertAt)
        .slice();
      if (pieces.length) {
        nextDrafts.splice(insertAt, 0, ...pieces);
      }
      setManualRecipientDrafts(windowId, nextDrafts);
      render();
      focusManualRecipientPill(windowId, insertAt + pieces.length);
    }
    function contactAllEmails(contact) {
      const emails = [];
      const primary = normalizeRecipientEmail(contact?.email || "");
      if (primary) emails.push(primary);
      const secondary = Array.isArray(contact?.secondary_emails)
        ? contact.secondary_emails
        : [];
      secondary.forEach((email) => {
        const normalized = normalizeRecipientEmail(email);
        if (normalized) emails.push(normalized);
      });
      return Array.from(new Set(emails));
    }
    function contactDisplayName(contact) {
      return (
        String(contact?.full_name || "").trim() ||
        String(contact?.email || "").trim() ||
        String(contact?.phone || "").trim() ||
        "Contact"
      );
    }
    function findContactForEmail(email) {
      const normalized = normalizeRecipientEmail(email);
      if (!normalized) return null;
      return (
        selectableRecipients().find((contact) =>
          contactAllEmails(contact).includes(normalized),
        ) || null
      );
    }
    function preferredContactEmail(contact) {
      return contactAllEmails(contact)[0] || "";
    }
    function emailRecipientToggleMap(compose) {
      return compose?.recipientContactEnabled &&
        typeof compose.recipientContactEnabled === "object"
        ? compose.recipientContactEnabled
        : {};
    }
    function emailRecipientSelectionMap(compose) {
      return compose?.recipientEmailSelections &&
        typeof compose.recipientEmailSelections === "object"
        ? compose.recipientEmailSelections
        : {};
    }
    function emailEligibleContacts() {
      return selectableRecipients().filter((contact) => contactAllEmails(contact).length);
    }
    function legacyEmailRecipientContact(compose, contacts) {
      const legacyId = String(compose?.recipientContactId || "").trim();
      const legacyEmail = normalizeRecipientEmail(compose?.to || "");
      const contactList = Array.isArray(contacts)
        ? [
            companyRecipient(),
            ...contacts.filter(
              (contact) => String(contact?.id || "") !== COMPANY_RECIPIENT_ID,
            ),
          ]
        : selectableRecipients();
      return (
        contactList.find(
          (contact) => String(contact?.id || "") === legacyId,
        ) ||
        (legacyEmail ? findContactForEmail(legacyEmail) : null) ||
        null
      );
    }
    function isEmailRecipientEnabled(compose, contact, contacts) {
      const emails = contactAllEmails(contact);
      if (!emails.length) return false;
      const contactId = String(contact?.id || "");
      const toggleMap = emailRecipientToggleMap(compose);
      if (Object.prototype.hasOwnProperty.call(toggleMap, contactId)) {
        return toggleMap[contactId] !== false;
      }
      const legacyContact = legacyEmailRecipientContact(compose, contacts);
      if (legacyContact) {
        return String(legacyContact?.id || "") === contactId;
      }
      return true;
    }
    function selectedEmailIndexForContact(compose, contact) {
      const emails = contactAllEmails(contact);
      if (!emails.length) return 0;
      const contactId = String(contact?.id || "");
      const selectionMap = emailRecipientSelectionMap(compose);
      const rawIndex = Number(selectionMap[contactId]);
      if (Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < emails.length) {
        return rawIndex;
      }
      const legacyEmail = normalizeRecipientEmail(compose?.to || "");
      if (legacyEmail) {
        const legacyIndex = emails.indexOf(legacyEmail);
        if (legacyIndex >= 0) return legacyIndex;
      }
      return 0;
    }
    function selectedEmailRecipients(compose, contacts) {
      const contactList = Array.isArray(contacts) ? contacts : listContacts();
      return contactList
        .filter((contact) => isEmailRecipientEnabled(compose, contact, contactList))
        .map((contact) => {
          const emails = contactAllEmails(contact);
          const selectedIndex = selectedEmailIndexForContact(compose, contact);
          return {
            contact,
            contactId: String(contact?.id || ""),
            emails,
            selectedIndex,
            selectedEmail: emails[selectedIndex] || emails[0] || "",
          };
        })
        .filter((entry) => entry.selectedEmail);
    }
    function manualEmailRecipients(compose, contacts) {
      return normalizeManualRecipientDrafts(compose)
        .map((value) => normalizeRecipientEmail(value))
        .filter(Boolean)
        .map((email) => ({
          contact: null,
          contactId: "",
          emails: [email],
          selectedIndex: 0,
          selectedEmail: email,
          createContact: true,
        }));
    }
    function composeEmailRecipients(compose, contacts) {
      const contactList = Array.isArray(contacts) ? contacts : listContacts();
      const selected = selectedEmailRecipients(compose, contactList);
      const manual = manualEmailRecipients(compose, contactList);
      const combined = [...selected, ...manual];
      const deduped = new Map();
      combined.forEach((entry) => {
        const key = String(entry?.selectedEmail || "").trim().toLowerCase();
        if (!key) return;
        const existing = deduped.get(key);
        if (!existing) {
          deduped.set(key, entry);
          return;
        }
        if (!existing.createContact && entry?.createContact) {
          deduped.set(key, entry);
        }
      });
      return Array.from(deduped.values());
    }
    function emailActivityItems() {
      return (Array.isArray(currentLead?.activity_items) ? currentLead.activity_items : [])
        .filter((item) => String(item?.activity_type || "").trim().toLowerCase() === "email");
    }
    function emailThreadParticipantEmails(item) {
      const meta = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const emails = [
        meta.from_email,
        ...(Array.isArray(meta.from_emails) ? meta.from_emails : []),
        ...(Array.isArray(meta.to_emails) ? meta.to_emails : []),
        ...(Array.isArray(meta.cc_emails) ? meta.cc_emails : []),
      ]
        .map((email) => normalizeRecipientEmail(email))
        .filter(Boolean);
      return Array.from(new Set(emails));
    }
    function emailThreadMetadataFromActivity(item) {
      const meta = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const inReplyTo = emailThreadReplyHeaderId(
        meta.message_id_header,
        meta.in_reply_to,
      );
      const references = emailThreadReferences(meta.references, inReplyTo);
      return {
        threadId: String(meta.gmail_thread_id || "").trim(),
        inReplyTo,
        references,
      };
    }
    function latestEmailThreadMetadataForRecipient(email) {
      const normalized = normalizeRecipientEmail(email);
      if (!normalized) return null;
      return emailActivityItems()
        .slice()
        .sort((a, b) => {
          const happenedDiff =
            Number(b?.happened_at || 0) - Number(a?.happened_at || 0);
          if (happenedDiff !== 0) return happenedDiff;
          return Number(b?.created_at || 0) - Number(a?.created_at || 0);
        })
        .map((item) => ({
          item,
          emails: emailThreadParticipantEmails(item),
          threading: emailThreadMetadataFromActivity(item),
        }))
        .find(
          ({ emails, threading }) =>
            emails.includes(normalized) && !!String(threading.threadId || "").trim(),
        )?.threading || null;
    }
    function resolveEmailThreading(compose, recipients) {
      const fallback = {
        threadId: String(compose?.threadId || "").trim(),
        inReplyTo: emailThreadReplyHeaderId(compose?.inReplyTo),
        references: emailThreadReferences(
          compose?.references,
          compose?.inReplyTo,
        ),
      };
      const recipientEmails = Array.from(
        new Set(
          (Array.isArray(recipients) ? recipients : [])
            .map((entry) => normalizeRecipientEmail(entry?.selectedEmail || ""))
            .filter(Boolean),
        ),
      );
      if (recipientEmails.length !== 1) return fallback;
      const inferred = latestEmailThreadMetadataForRecipient(recipientEmails[0]);
      if (inferred && String(inferred.threadId || "").trim()) {
        return inferred;
      }
      return fallback;
    }
    function toggleEmailRecipient(windowId, contactId) {
      const compose = emailComposeForWindow(windowId);
      const contact = findContactById(contactId);
      if (!contact || !contactAllEmails(contact).length) return;
      const toggleMap = {
        ...emailRecipientToggleMap(compose),
      };
      const currentEnabled = isEmailRecipientEnabled(compose, contact, listContacts());
      toggleMap[String(contactId || "")] = !currentEnabled;
      updateEmailWindowCompose(windowId, {
        recipientContactEnabled: toggleMap,
      });
    }
    function cycleEmailRecipientAddress(windowId, contactId) {
      const compose = emailComposeForWindow(windowId);
      const contact = findContactById(contactId);
      const emails = contactAllEmails(contact);
      if (!contact || emails.length < 2) return;
      const nextIndex = (selectedEmailIndexForContact(compose, contact) + 1) % emails.length;
      updateEmailWindowCompose(windowId, {
        recipientEmailSelections: {
          ...emailRecipientSelectionMap(compose),
          [String(contactId || "")]: nextIndex,
        },
      });
    }
    function findContactById(contactId) {
      return (
        selectableRecipients().find(
          (contact) => String(contact?.id || "") === String(contactId || ""),
        ) || null
      );
    }
    function getPrimaryContact() {
      const contacts = listContacts();
      return (
        contacts.find((item) =>
          String(item.email || item.phone || "").trim(),
        ) ||
        contacts[0] ||
        companyRecipient() ||
        null
      );
    }
    function getPrimarySmsContact() {
      const contacts = listContacts();
      return (
        contacts.find((item) => leadPreferredContactPhoneForUi(item)) ||
        contacts.find((item) => String(item.phone || "").trim()) ||
        (leadPreferredContactPhoneForUi(companyRecipient()) ? companyRecipient() : null) ||
        contacts[0] ||
        companyRecipient() ||
        null
      );
    }
    function syncSmsRecipientSelection(contactId, options) {
      const opts = options && typeof options === "object" ? options : {};
      const contact =
        findContactById(contactId || "") ||
        findContactById(state.ui?.smsThreadId || "") ||
        getPrimarySmsContact();
      state.ui.smsRecipientContactId = String(contact?.id || "");
      if (!opts.preservePhone) {
        state.ui.smsPhone = contact ? leadPreferredContactPhoneForUi(contact) : "";
      }
      if (!state.ui.smsThreadId && contact?.id) {
        state.ui.smsThreadId = String(contact.id || "");
      }
      return contact || null;
    }
    function emailReportTemplates() {
      return Array.isArray(currentLead?.crm?.email_assets?.report_templates)
        ? currentLead.crm.email_assets.report_templates
        : [];
    }
    function normalizeEmailBrandingInput(value) {
      const raw = value && typeof value === "object" ? value : {};
      const normalizeColor = (color) => {
        const next = String(color || "").trim();
        if (!next) return "";
        const prefixed = next.startsWith("#") ? next : `#${next}`;
        return /^#[0-9a-fA-F]{6}$/.test(prefixed) ? prefixed.toLowerCase() : "";
      };
      const logoDataUrl = String(
        raw.logoDataUrl || raw.logo_data_url || "",
      ).trim();
      return {
        primaryColor: normalizeColor(raw.primaryColor || raw.primary_color),
        secondaryColor: normalizeColor(
          raw.secondaryColor || raw.secondary_color,
        ),
        logoDataUrl: /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(logoDataUrl)
          ? logoDataUrl
          : "",
      };
    }
    function emailLogoRelativeLuminance(r, g, b) {
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    function emailLogoRgbToHex(r, g, b) {
      return `#${[r, g, b]
        .map((value) =>
          Math.max(0, Math.min(255, value | 0))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
    }
    function emailLogoColorDistance(a, b) {
      return Math.sqrt(
        ((a.r || 0) - (b.r || 0)) ** 2 +
          ((a.g || 0) - (b.g || 0)) ** 2 +
          ((a.b || 0) - (b.b || 0)) ** 2,
      );
    }
    function isUsableEmailBrandColor(r, g, b) {
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const sat = max === 0 ? 0 : (max - min) / max;
      const luminance = emailLogoRelativeLuminance(r, g, b);
      if (r > 242 && g > 242 && b > 242) return false;
      if (luminance > 0.82) return false;
      if (luminance > 0.72 && sat < 0.24) return false;
      return true;
    }
    function extractEmailLogoPalette(source) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const maxSize = 160;
            const scale = Math.min(
              1,
              maxSize / Math.max(img.width || 1, img.height || 1),
            );
            const width = Math.max(1, Math.round((img.width || 1) * scale));
            const height = Math.max(1, Math.round((img.height || 1) * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx2d) throw new Error("Canvas unavailable");
            ctx2d.drawImage(img, 0, 0, width, height);
            const imageData = ctx2d.getImageData(0, 0, width, height).data;
            const buckets = new Map();
            const bucketSize = 24;

            for (let i = 0; i < imageData.length; i += 4) {
              const alpha = imageData[i + 3];
              if (alpha < 140) continue;
              const r = imageData[i];
              const g = imageData[i + 1];
              const b = imageData[i + 2];
              if (!isUsableEmailBrandColor(r, g, b)) continue;
              const qr = Math.min(255, Math.round(r / bucketSize) * bucketSize);
              const qg = Math.min(255, Math.round(g / bucketSize) * bucketSize);
              const qb = Math.min(255, Math.round(b / bucketSize) * bucketSize);
              const key = `${qr},${qg},${qb}`;
              const existing =
                buckets.get(key) || { r: qr, g: qg, b: qb, count: 0 };
              existing.count += 1;
              buckets.set(key, existing);
            }

            const ranked = Array.from(buckets.values()).sort(
              (a, b) => b.count - a.count,
            );
            const primary = ranked[0] || null;
            let secondary = null;
            if (primary) {
              secondary =
                ranked.find(
                  (entry) => emailLogoColorDistance(entry, primary) >= 64,
                ) || null;
            }
            resolve({
              primary: primary
                ? emailLogoRgbToHex(primary.r, primary.g, primary.b)
                : null,
              secondary: secondary
                ? emailLogoRgbToHex(secondary.r, secondary.g, secondary.b)
                : null,
            });
          } catch (error) {
            reject(error);
          }
        };
        img.onerror = () => reject(new Error("Could not read logo colors"));
        img.src = source;
      });
    }
    function emailBrandingDefaults() {
      return normalizeEmailBrandingInput(currentLead?.crm?.email_assets?.branding);
    }
    function buildFallbackSignatureHtml() {
      const name = esc(activeUserName());
      const email = esc(activeUserEmail());
      return `<div><strong>${name}</strong>${email ? `<br>${email}` : ""}<br>First Mate</div>`;
    }
    function emailSignatureHtml(compose) {
      return (
        String(compose?.signatureHtml || "").trim() ||
        String(currentLead?.crm?.gmail?.signature_html || "").trim() ||
        buildFallbackSignatureHtml()
      );
    }
    function normalizeAttachmentMode(mode) {
      return ["summary", "full", "both"].includes(String(mode || "").trim())
        ? String(mode).trim()
        : "summary";
    }
    function normalizeEmailAttachmentSelections(value) {
      const templateMap = new Map(
        emailReportTemplates().map((item) => [
          String(item?.id || "").trim(),
          item,
        ]),
      );
      const items = Array.isArray(value) ? value : [];
      const next = [];
      const seen = new Set();
      items.forEach((entry) => {
        const id = String(entry?.id || "").trim();
        if (!id || seen.has(id) || !templateMap.has(id)) return;
        seen.add(id);
        const template = templateMap.get(id) || {};
        next.push({
          id,
          label:
            String(entry?.label || "").trim() ||
            String(template?.label || template?.name || id).trim(),
          mode: normalizeAttachmentMode(entry?.mode),
          file_names: Array.isArray(entry?.file_names)
            ? entry.file_names.map((item) => String(item || "").trim()).filter(Boolean)
            : [],
        });
      });
      return next;
    }
    function emailAttachmentSelectionFor(id) {
      return normalizeEmailAttachmentSelections(state.ui?.emailCompose?.attachments).find(
        (item) => String(item.id) === String(id),
      );
    }
    function buildEmailTemplate(templateName, existing) {
      const template = String(templateName || "").trim();
      const compose = existing || blankEmailCompose();
      const company =
        currentLead?.company || currentLead?.lead_name || "your team";
      const contact = getPrimaryContact();
      const repName = activeUserName();
      const repPhone =
        String(window.Portal?.cfg?.user?.phone || "").trim() ||
        String(currentLead?.crm?.ringcentral?.default_sms_number || "").trim();
      const selectedContact =
        legacyEmailRecipientContact(compose, listContacts()) ||
        contact ||
        null;
      const contactName = selectedContact?.full_name || contact?.full_name || company;
      const contactFirstName = String(contactName || "").trim().split(/\s+/)[0] || contactName;
      const selectedContactEmail =
        preferredContactEmail(selectedContact) ||
        normalizeRecipientEmail(currentLead?.email || "") ||
        "";
      const templateVars = {
        company,
        company_name: company,
        contact_name: contactName,
        contact_first_name: contactFirstName,
        rep_name: repName,
        sender_name: repName,
        sender_phone: repPhone,
        sender_email: String(window.Portal?.cfg?.user?.email || ""),
        lead_name: currentLead?.lead_name || company,
        list_name: currentLead?.list_name || "",
      };
      const selected =
        emailTemplateOptionsForLead(currentLead).find(
          (item) =>
            String(item?.id || "") === template ||
            String(item?.name || "") === template,
        ) || null;
      const selectedBody = selected
        ? applyEmailTemplateVars(selected.body, templateVars)
        : "";
      const selectedSubject = selected
        ? applyEmailTemplateVars(selected.subject, templateVars)
        : "";
      const nextBody = selectedBody || compose.body || "";
      const nextAttachments =
        selected && Array.isArray(selected.default_attachments)
          ? normalizeEmailAttachmentSelections(selected.default_attachments)
          : normalizeEmailAttachmentSelections(compose.attachments);
      const inferredThreading = selectedContactEmail
        ? latestEmailThreadMetadataForRecipient(selectedContactEmail)
        : null;
      return {
        template: selected?.id || template,
        bcc: String(compose.bcc || ""),
        manualRecipientEmail: "",
        manualRecipientEmails: normalizeManualRecipientDrafts(compose),
        recipientContactEnabled:
          compose.recipientContactEnabled &&
          typeof compose.recipientContactEnabled === "object"
            ? { ...compose.recipientContactEnabled }
            : {},
        recipientEmailSelections:
          compose.recipientEmailSelections &&
          typeof compose.recipientEmailSelections === "object"
            ? { ...compose.recipientEmailSelections }
            : selectedContact && selectedContactEmail
              ? {
              [String(selectedContact.id || "")]: contactAllEmails(
                selectedContact,
              ).indexOf(selectedContactEmail) >= 0
                ? contactAllEmails(selectedContact).indexOf(selectedContactEmail)
                : 0,
                }
              : {},
        subject: selectedSubject || compose.subject || "",
        body: nextBody,
        bodyHtml:
          selected
            ? renderLeadMultilineHtml(selectedBody)
            : String(compose.bodyHtml || "").trim() || renderLeadMultilineHtml(nextBody),
        signatureHtml: emailSignatureHtml(compose),
        attachments: nextAttachments,
        branding: {
          ...emailBrandingDefaults(),
          ...normalizeEmailBrandingInput(compose.branding),
        },
        threadId: compose.threadId || inferredThreading?.threadId || "",
        inReplyTo: compose.inReplyTo || inferredThreading?.inReplyTo || "",
        references: compose.references || inferredThreading?.references || "",
      };
    }
    function syncUiWithLead(forceReset) {
      if (!state.ui || forceReset) {
        state.ui = blankUiState();
      }
      const stageValue = normalizeStageLabel(
        currentLead?.status || "Contacted",
      );
      const milestoneState = currentLead?.crm?.milestones || {};
      const openFollowups = (
        Array.isArray(currentLead?.followups) ? currentLead.followups : []
      ).filter((item) => String(item.status || "open") === "open");
      const primarySmsContact = getPrimarySmsContact();
      state.ui.stageValue =
        forceReset || !state.ui.stageValue ? stageValue : state.ui.stageValue;
      state.ui.smsThreadId =
        forceReset || !state.ui.smsThreadId
          ? String(primarySmsContact?.id || "")
          : state.ui.smsThreadId;
      state.ui.smsRecipientContactId =
        forceReset || !state.ui.smsRecipientContactId
          ? String(primarySmsContact?.id || "")
          : state.ui.smsRecipientContactId;
      if (
        forceReset ||
        !String(state.ui.smsPhone || "").trim() ||
        !findContactById(state.ui.smsRecipientContactId)
      ) {
        state.ui.smsPhone = primarySmsContact
          ? leadPreferredContactPhoneForUi(primarySmsContact)
          : "";
      }
      state.ui.milestoneFunded = forceReset
        ? !!milestoneState.funded
        : !!state.ui.milestoneFunded;
      state.ui.milestoneOrders = forceReset
        ? !!milestoneState.orders
        : !!state.ui.milestoneOrders;
      const activeSequenceLabel =
        currentLead?.crm?.active_sequence?.sequence_label ||
        currentLead?.crm?.active_sequence?.sequence_key ||
        "";
      state.ui.sequenceBadge = forceReset
        ? activeSequenceLabel
          ? `Sequence: ${activeSequenceLabel}`
          : openFollowups[0]?.title
            ? `Next: ${openFollowups[0].title}`
            : ""
        : state.ui.sequenceBadge;
      state.followupDraft.followup_date = String(
        state.followupDraft?.followup_date || "",
      );
      state.followupDraft.followup_slot = String(
        state.followupDraft?.followup_slot || "",
      );
      state.followupDraft.meeting_date = String(
        state.followupDraft?.meeting_date || "",
      );
      state.followupDraft.meeting_time = String(
        state.followupDraft?.meeting_time || "",
      );
      if (forceReset) {
        state.ui.emailWindows = [];
        state.ui.activeEmailWindowId = "";
        state.ui.emailCompose = blankEmailCompose();
      }
      ensureEmailWindowsState();
    }
    function setMockupMode(active) {
      document.body.classList.toggle("lead-page-v5-active", !!active);
    }
    function closeInlinePanels() {
      state.ui.calendarMiniOpen = false;
      closeAllEmailWindows(true);
      state.ui.smsOpen = false;
    }
    function openGmailConnectPopup() {
      const url = `${serverEndpoint}?action=google_begin_connect`;
      window.open(
        url,
        "firstmate_google_connect",
        "width=560,height=760,resizable=yes,scrollbars=yes",
      );
    }
    async function disconnectGmail() {
      const data = await api({ action: "gmail_disconnect" }).catch(() => ({}));
      if (!data.success) {
        setSaveState("emailSend", "error", data.error || "Could not disconnect Gmail.");
        render();
        return;
      }
      await reload();
    }
    async function refreshGmailThreading() {
      if (!currentLead?.id) return;
      const data = await api({
        action: "lead_sync_gmail",
        lead_id: currentLead.id,
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState("emailSend", "error", data.error || "Could not sync Gmail.");
        render();
        return;
      }
      await reload();
    }
    function ensureGmailPopupListener() {
      if (gmailPopupMessageHandler) return;
      gmailPopupMessageHandler = (event) => {
        const data = event?.data || {};
        if (
          data.type === "firstmate-gmail-connected" ||
          data.type === "firstmate-gmail-disconnected"
        ) {
          reload();
        }
      };
      window.addEventListener("message", gmailPopupMessageHandler);
    }
    function openReplyCompose(activityId, replyAll) {
      const item = (Array.isArray(currentLead?.activity_items)
        ? currentLead.activity_items
        : []
      ).find((entry) => String(entry.id || "") === String(activityId || ""));
      if (!item) return;
      const meta = item.metadata || {};
      const fromEmail =
        String(meta.from_email || "").trim() ||
        String((Array.isArray(meta.to_emails) ? meta.to_emails[0] : "") || "").trim();
      const toEmails = Array.isArray(meta.to_emails)
        ? meta.to_emails.filter(Boolean)
        : [];
      const ownerEmail = String(window.Portal?.cfg?.user?.email || "").trim().toLowerCase();
      const replyAllRecipients = Array.from(
        new Set([fromEmail, ...toEmails].filter(Boolean)),
      ).filter((email) => String(email || "").trim().toLowerCase() !== ownerEmail);
      const replyTargets = replyAll
        ? replyAllRecipients
        : [fromEmail].filter(Boolean);
      const matchedReplyContacts = Array.from(
        new Map(
          replyTargets
            .map((email) => findContactForEmail(email))
            .filter(Boolean)
            .map((contact) => [String(contact.id || ""), contact]),
        ).values(),
      );
      const primaryReplyEmail = replyAll
        ? String(replyAllRecipients[0] || fromEmail || "")
        : fromEmail;
      const replyContact =
        matchedReplyContacts[0] ||
        findContactForEmail(primaryReplyEmail) ||
        findContactForEmail(fromEmail) ||
        null;
      const recipientContactEnabled = {};
      if (matchedReplyContacts.length) {
        emailEligibleContacts().forEach((contact) => {
          recipientContactEnabled[String(contact?.id || "")] =
            matchedReplyContacts.some(
              (matched) =>
                String(matched?.id || "") === String(contact?.id || ""),
            );
        });
      }
      const subject = String(item.subject || "").trim();
      openEmailComposeWindow({
        ...blankEmailCompose(),
        template: "",
        bcc: "",
        recipientContactEnabled,
        recipientEmailSelections:
          replyContact?.id && primaryReplyEmail
            ? {
                [String(replyContact.id || "")]: Math.max(
                  0,
                  contactAllEmails(replyContact).indexOf(
                    normalizeRecipientEmail(primaryReplyEmail),
                  ),
                ),
              }
            : {},
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject || "First Mate follow-up"}`,
        body: "",
        attachments: [],
        threadId: String(meta.gmail_thread_id || "").trim(),
        inReplyTo: emailThreadReplyHeaderId(
          meta.message_id_header,
          meta.in_reply_to,
        ),
        references: emailThreadReferences(
          meta.references,
          meta.message_id_header,
          meta.in_reply_to,
        ),
      });
    }
    function defaultEmailTemplateId() {
      return String(emailTemplateOptionsForLead(currentLead)[0]?.id || "");
    }
    function openPrimaryEmailCompose() {
      const templateId = defaultEmailTemplateId();
      const compose = buildEmailTemplate(templateId, blankEmailCompose());
      openEmailComposeWindow(compose);
    }
    function stageAdvanceValue() {
      const options = mockupStageOptions();
      const current = normalizeStageLabel(
        state.ui?.stageValue || currentLead?.status || "Contacted",
      );
      const index = options.indexOf(current);
      if (index < 0) return options[0];
      return options[Math.min(index + 1, options.length - 1)];
    }
    function isHistoryItemOpen(id) {
      if (state.ui?.historyExpanded) {
        return !state.ui?.historyClosed?.[id];
      }
      return !!state.ui?.historyOpen?.[id];
    }
    function applyHistoryButtonState() {
      const btn = bodyEl.querySelector("[data-lead-toggle-history-all]");
      if (!btn) return;
      btn.innerHTML = `<i class="fas fa-compress-alt"></i> ${
        state.ui?.historyExpanded ? "Collapse All" : "Expand All"
      }`;
    }
    function historySnapshot() {
      return {
        leadId: String(currentLead?.id || ""),
        historyExpanded: !!state.ui?.historyExpanded,
        historyOpen: { ...(state.ui?.historyOpen || {}) },
        historyClosed: { ...(state.ui?.historyClosed || {}) },
        renderedItems: bodyEl.querySelectorAll(".lead-page-v5-history-item")
          .length,
        visibleBodies: bodyEl.querySelectorAll(
          ".lead-page-v5-history-body:not([hidden])",
        ).length,
      };
    }
    function setHistoryExpanded(expanded, source) {
      state.ui.historyExpanded = !!expanded;
      state.ui.historyOpen = {};
      state.ui.historyClosed = {};
      applyHistoryDomState();
      return historySnapshot();
    }
    function toggleHistoryAll(source) {
      return setHistoryExpanded(!state.ui.historyExpanded, source || "toggle");
    }
    function toggleHistoryItem(id, source) {
      if (!id) return;
      if (state.ui.historyExpanded) {
        state.ui.historyClosed = {
          ...(state.ui.historyClosed || {}),
          [id]: !state.ui.historyClosed?.[id],
        };
      } else {
        state.ui.historyOpen = {
          ...(state.ui.historyOpen || {}),
          [id]: !state.ui.historyOpen?.[id],
        };
      }
      applyHistoryDomState();
      return historySnapshot();
    }
    function applyHistoryDomState() {
      bodyEl
        .querySelectorAll(".lead-page-v5-history-item")
        .forEach((itemEl) => {
          const toggle = itemEl.querySelector("[data-lead-toggle-activity]");
          const body = itemEl.querySelector(".lead-page-v5-history-body");
          const id = toggle?.getAttribute("data-lead-toggle-activity") || "";
          const isOpen = isHistoryItemOpen(id);
          itemEl.classList.toggle("open", isOpen);
          if (toggle) {
            toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
          }
          if (body) {
            body.hidden = !isOpen;
            body.style.display = isOpen ? "block" : "none";
          }
        });
      applyHistoryButtonState();
    }
    function bindHistoryControls() {
      const toggleAllBtn = bodyEl.querySelector("[data-lead-toggle-history-all]");
      if (toggleAllBtn) {
        toggleAllBtn.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleHistoryAll("direct_onclick");
        };
      }
      bodyEl
        .querySelectorAll("[data-lead-toggle-activity]")
        .forEach((toggleEl) => {
          toggleEl.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const id =
              toggleEl.getAttribute("data-lead-toggle-activity") || "";
            toggleHistoryItem(
              id,
              "direct_onclick",
            );
          };
        });
    }
    function bindSmsControls() {
      const sendBtn = bodyEl.querySelector("[data-lead-send-sms]");
      if (sendBtn) {
        sendBtn.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          sendSms();
        };
      }
      bodyEl
        .querySelectorAll("[data-lead-sms-thread]")
        .forEach((threadBtn) => {
          threadBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.ui.smsThreadId =
              threadBtn.getAttribute("data-lead-sms-thread") || "";
            syncSmsRecipientSelection(state.ui.smsThreadId);
            render();
          };
        });
      bodyEl
        .querySelectorAll("[data-lead-close-sms]")
        .forEach((closeBtn) => {
          closeBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.ui.smsOpen = false;
            render();
          };
        });
      if (state.ui?.smsOpen) {
        const threadEl = bodyEl.querySelector(".lead-page-v5-sms-thread");
        if (threadEl) {
          window.requestAnimationFrame(() => {
            threadEl.scrollTop = threadEl.scrollHeight;
          });
        }
      }
    }
    function bindEmailPreviewControls() {
      const overlay = bodyEl.querySelector("[data-lead-email-preview-close]");
      if (overlay) {
        overlay.onclick = (event) => {
          if (event.target !== overlay) return;
          event.preventDefault();
          closeEmailAttachmentPreview();
        };
      }
      bodyEl
        .querySelectorAll("[data-lead-email-preview-index]")
        .forEach((tabBtn) => {
          tabBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.ui.emailPreview.activeIndex =
              Number(
                tabBtn.getAttribute("data-lead-email-preview-index") || 0,
              ) || 0;
            render();
          };
        });
      bodyEl
        .querySelectorAll("[data-lead-email-report-preview]")
        .forEach((previewBtn) => {
          previewBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const targetWindowId =
              previewBtn.getAttribute("data-email-window-target") ||
              activeEmailWindow()?.id ||
              "";
            generateEmailAttachmentPreview(
              previewBtn.getAttribute("data-lead-email-report-preview") || "",
              targetWindowId,
            );
          };
        });
      bodyEl
        .querySelectorAll("button[data-lead-email-preview-close]")
        .forEach((closeBtn) => {
          closeBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeEmailAttachmentPreview();
          };
        });
    }
    function exposeHistoryDebugApi() {
      const debugApi = {
        snapshot: () => historySnapshot(),
        toggleAll: () => toggleHistoryAll("console_toggleAll"),
        collapseAll: () => setHistoryExpanded(false, "console_collapseAll"),
        expandAll: () => setHistoryExpanded(true, "console_expandAll"),
        toggleItem: (id) =>
          toggleHistoryItem(String(id || ""), "console_toggleItem"),
        clickButton: () => {
          const btn = bodyEl.querySelector("[data-lead-toggle-history-all]");
          if (btn) btn.click();
          return !!btn;
        },
      };
      window.FirstMateLeadHistoryDebug = debugApi;
      window.__leadHistoryDebug = debugApi;
    }
    function syncEmailComposeFromDom(windowId) {
      const targetWindowId =
        String(windowId || activeEmailWindow()?.id || state.ui?.activeEmailWindowId || "");
      const container = targetWindowId
        ? bodyEl.querySelector(`[data-email-window-id="${CSS.escape(targetWindowId)}"]`)
        : null;
      const manualRecipientInputs = container
        ? Array.from(container.querySelectorAll("[data-lead-email-manual-pill]"))
        : [];
      const emailBodyInput = container?.querySelector("[data-lead-email-body]");
      if (!emailBodyInput && !manualRecipientInputs.length) {
        return {
          ...blankEmailCompose(),
          ...(activeEmailWindow()?.compose || state.ui.emailCompose || {}),
        };
      }
      const composePatch = {};
      if (manualRecipientInputs.length) {
        composePatch.manualRecipientEmail = "";
        composePatch.manualRecipientEmails = manualRecipientInputs
          .map((input) => String(input?.value || "").trim())
          .filter((value) => value !== "");
      }
      if (emailBodyInput) {
        composePatch.bodyHtml = emailBodyInput.innerHTML || "";
        composePatch.body = (
          emailBodyInput.innerText ||
          emailBodyInput.textContent ||
          ""
        ).replace(/\r/g, "");
      }
      updateEmailWindowCompose(targetWindowId, composePatch);
      return {
        ...blankEmailCompose(),
        ...(activeEmailWindow()?.compose || state.ui.emailCompose || {}),
      };
    }
    function updateEmailBranding(patch, windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const compose = emailComposeForWindow(targetWindowId);
      const nextCompose = {
        ...compose,
        branding: {
          ...normalizeEmailBrandingInput(compose?.branding),
          ...normalizeEmailBrandingInput(patch),
        },
      };
      if (targetWindowId) {
        updateEmailWindowCompose(targetWindowId, nextCompose);
      } else {
        state.ui.emailCompose = nextCompose;
      }
    }
    function captureEmailEditorSelection(windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const editor =
        emailWindowElement(targetWindowId)?.querySelector("[data-lead-email-body]") ||
        bodyEl.querySelector("[data-lead-email-body]");
      const selection = window.getSelection?.();
      if (!editor || !selection || selection.rangeCount < 1) {
        emailEditorSelection = null;
        return null;
      }
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        emailEditorSelection = null;
        return null;
      }
      emailEditorSelection = {
        windowId: targetWindowId,
        range: range.cloneRange(),
      };
      return emailEditorSelection;
    }
    function restoreEmailEditorSelection(windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const selection = window.getSelection?.();
      if (!selection) return false;
      selection.removeAllRanges();
      if (
        emailEditorSelection?.range &&
        String(emailEditorSelection?.windowId || "") === targetWindowId
      ) {
        selection.addRange(emailEditorSelection.range);
        return true;
      }
      const editor =
        emailWindowElement(targetWindowId)?.querySelector("[data-lead-email-body]") ||
        bodyEl.querySelector("[data-lead-email-body]");
      if (!editor) return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.addRange(range);
      return true;
    }
    function insertInlineEmailImage(dataUrl, windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const editor =
        emailWindowElement(targetWindowId)?.querySelector("[data-lead-email-body]") ||
        bodyEl.querySelector("[data-lead-email-body]");
      if (!editor || !dataUrl) return;
      editor.focus();
      restoreEmailEditorSelection(targetWindowId);
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount < 1) {
        document.execCommand("insertImage", false, dataUrl);
        syncEmailComposeFromDom(targetWindowId);
        return;
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = "Email image";
      image.style.maxWidth = "100%";
      image.style.height = "auto";
      image.style.display = "block";
      image.style.margin = "8px 0";
      range.insertNode(image);
      range.setStartAfter(image);
      range.setEndAfter(image);
      selection.removeAllRanges();
      selection.addRange(range);
      captureEmailEditorSelection(targetWindowId);
      syncEmailComposeFromDom(targetWindowId);
    }
    async function saveEmailBranding(windowId) {
      if (!currentLead?.id) return null;
      const targetWindowId = resolveEmailWindowId(windowId);
      const branding = normalizeEmailBrandingInput(
        emailComposeForWindow(targetWindowId)?.branding,
      );
      setSaveState("emailBranding", "saving");
      render();
      const data = await api({
        action: "lead_save_email_branding",
        lead_id: currentLead.id,
        branding_json: JSON.stringify(branding),
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "emailBranding",
          "error",
          data.error || "Could not save branding.",
        );
        render();
        return null;
      }
      const savedBranding = normalizeEmailBrandingInput(data.branding);
      if (targetWindowId) {
        updateEmailWindowCompose(targetWindowId, {
          ...emailComposeForWindow(targetWindowId),
          branding: savedBranding,
        });
      } else {
        state.ui.emailCompose = {
          ...state.ui.emailCompose,
          branding: savedBranding,
        };
      }
      if (!currentLead.crm) currentLead.crm = {};
      if (!currentLead.crm.email_assets) currentLead.crm.email_assets = {};
      currentLead.crm.email_assets.branding = savedBranding;
      setSaveState("emailBranding", "saved");
      render();
      return savedBranding;
    }
    function queueEmailBrandingSave(windowId) {
      clearTimeout(emailBrandingSaveTimer);
      emailBrandingSaveTimer = setTimeout(() => {
        saveEmailBranding(windowId);
      }, 220);
    }
    function formatEmailBody(command, windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const editor =
        emailWindowElement(targetWindowId)?.querySelector("[data-lead-email-body]") ||
        bodyEl.querySelector("[data-lead-email-body]");
      if (!editor) return;
      editor.focus();
      captureEmailEditorSelection(targetWindowId);
      if (command === "insertImage") {
        const fileInput =
          emailWindowElement(targetWindowId)?.querySelector(
            "[data-lead-email-inline-image-file]",
          ) || bodyEl.querySelector("[data-lead-email-inline-image-file]");
        fileInput?.click();
        return;
      }
      if (command === "createLink") {
        const url = window.prompt("Enter the link URL");
        if (!url) return;
        restoreEmailEditorSelection(targetWindowId);
        document.execCommand("createLink", false, url);
      } else {
        restoreEmailEditorSelection(targetWindowId);
        document.execCommand(command, false, null);
      }
      captureEmailEditorSelection(targetWindowId);
      syncEmailComposeFromDom(targetWindowId);
    }
    async function loadEmailSampleBundle(folderId) {
      if (!currentLead?.id || !folderId) throw new Error("Missing sample report.");
      const data = await api({
        action: "lead_email_sample_bundle",
        lead_id: currentLead.id,
        folder: folderId,
      }).catch(() => ({}));
      if (!data.success) {
        throw new Error(data.error || "Could not load that sample report.");
      }
      if (!data.pdf_state_asset) {
        throw new Error("That sample report does not have a saved PDF snapshot.");
      }
      const separator = data.pdf_state_asset.includes("?") ? "&" : "?";
      const snapshotResp = await fetch(`${data.pdf_state_asset}${separator}t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!snapshotResp.ok) {
        throw new Error("Could not load the sample report snapshot.");
      }
      const snapshot = await snapshotResp.json();
      return {
        template: data.template || { id: folderId, label: folderId },
        snapshot,
        runtimeContext: {
          folderId: data.folder || folderId,
          manifest: data.manifest || null,
          organization: data.organization || null,
        },
      };
    }
    function attachmentFileNameBase(label) {
      const cleaned = String(label || "Sample Report")
        .trim()
        .replace(/[^a-z0-9]+/gi, " ")
        .trim();
      return cleaned || "Sample Report";
    }
    function emailBrandingOverrides(compose) {
      const branding = normalizeEmailBrandingInput(compose?.branding);
      const overrides = {};
      if (branding.primaryColor) overrides.primaryColor = branding.primaryColor;
      if (branding.secondaryColor)
        overrides.secondaryColor = branding.secondaryColor;
      if (branding.logoDataUrl) overrides.logoDataUrl = branding.logoDataUrl;
      return overrides;
    }
    function hasEmailBrandingOverrides(overrides) {
      return !!(
        overrides &&
        (overrides.primaryColor || overrides.secondaryColor || overrides.logoDataUrl)
      );
    }
    function emailFullAttachmentPdfOptions() {
      return {
        clearBrandingOverrides: true,
        disableOrganizationBranding: true,
        applyBrandingToFull: false,
      };
    }
    function emailSummaryAttachmentPdfOptions(compose, runtimeContext) {
      const brandingOverrides = emailBrandingOverrides(compose);
      const options = {
        clearBrandingOverrides: true,
        disableOrganizationBranding: true,
        applyBrandingToFull: false,
      };
      if (hasEmailBrandingOverrides(brandingOverrides)) {
        options.brandingOverrides = brandingOverrides;
      }
      return options;
    }
    async function generateEmailAttachmentFiles(compose) {
      const selections = normalizeEmailAttachmentSelections(compose.attachments);
      if (!selections.length) return { files: [], metadata: [] };
      const pdfRuntime = await ensureSampleReportPdfRuntimeAvailable();
      const files = [];
      const metadata = [];
      for (const selection of selections) {
        setSaveState(
          "emailSend",
          "saving",
          `Generating ${selection.label} attachment...`,
        );
        render();
        const bundle = await loadEmailSampleBundle(selection.id);
        const baseName = attachmentFileNameBase(selection.label);
        const outputs =
          selection.mode === "both"
            ? [
                {
                  mode: "full",
                  outputFileName: `${baseName} - Full.pdf`,
                  ...emailFullAttachmentPdfOptions(),
                },
                {
                  mode: "summary",
                  outputFileName: `${baseName} - Summary.pdf`,
                  ...emailSummaryAttachmentPdfOptions(compose, bundle.runtimeContext),
                },
              ]
            : [
                {
                  mode: selection.mode,
                  outputFileName: `${baseName} - ${
                    selection.mode === "full" ? "Full" : "Summary"
                  }.pdf`,
                  ...(selection.mode === "full"
                    ? emailFullAttachmentPdfOptions()
                    : emailSummaryAttachmentPdfOptions(compose, bundle.runtimeContext)),
                },
              ];
        const generated =
          outputs.length > 1
            ? await pdfRuntime.generateProjectPdfsFromSnapshot(
                bundle.snapshot,
                bundle.runtimeContext,
                {
                  outputs,
                  skipUpload: true,
                  skipStatusUpdate: true,
                },
              )
            : [
                await pdfRuntime.generateProjectPdfFromSnapshot(
                  bundle.snapshot,
                  bundle.runtimeContext,
                  {
                    mode: outputs[0].mode,
                    outputFileName: outputs[0].outputFileName,
                    clearBrandingOverrides: !!outputs[0].clearBrandingOverrides,
                    disableOrganizationBranding:
                      outputs[0].disableOrganizationBranding === true,
                    useProjectOrganizationBranding:
                      outputs[0].useProjectOrganizationBranding === true,
                    brandingOverrides: outputs[0].brandingOverrides,
                    applyBrandingToFull: !!outputs[0].applyBrandingToFull,
                    skipUpload: true,
                    skipStatusUpdate: true,
                  },
                ),
              ];
        const fileNames = [];
        generated.forEach((entry) => {
          const blob = entry?.result?.blob;
          const filename = entry?.result?.filename || `${baseName}.pdf`;
          if (!blob) return;
          files.push(new File([blob], filename, { type: blob.type || "application/pdf" }));
          fileNames.push(filename);
        });
        metadata.push({
          id: selection.id,
          label: selection.label,
          mode: selection.mode,
          file_names: fileNames,
        });
      }
      return { files, metadata };
    }
    async function generateEmailAttachmentPreview(selectionId, windowId) {
      const targetWindowId = resolveEmailWindowId(windowId);
      const compose = {
        ...blankEmailCompose(),
        ...(emailComposeForWindow(targetWindowId) || {}),
      };
      const selections = normalizeEmailAttachmentSelections(compose.attachments);
      const selection = selections.find((item) => String(item.id) === String(selectionId || ""));
      if (!selection) {
        showToast("Choose a PDF option before previewing.", "error", 2200);
        return;
      }
      const previousFiles = Array.isArray(state.ui?.emailPreview?.files)
        ? state.ui.emailPreview.files
        : [];
      previousFiles.forEach((item) => {
        try {
          if (item?.url) URL.revokeObjectURL(item.url);
        } catch (_) {}
      });
      state.ui.emailPreview = {
        open: true,
        loading: true,
        error: "",
        title: `${selection.label} Preview`,
        files: [],
        activeIndex: 0,
      };
      render();
      try {
        const pdfRuntime = await ensureSampleReportPdfRuntimeAvailable();
        const bundle = await loadEmailSampleBundle(selection.id);
        const baseName = attachmentFileNameBase(selection.label);
        const outputs =
          selection.mode === "both"
            ? [
                {
                  mode: "summary",
                  outputFileName: `${baseName} - Summary.pdf`,
                  label: "Branded",
                  ...emailSummaryAttachmentPdfOptions(compose, bundle.runtimeContext),
                },
                {
                  mode: "full",
                  outputFileName: `${baseName} - Full.pdf`,
                  label: "Unbranded",
                  ...emailFullAttachmentPdfOptions(),
                },
              ]
            : [
                {
                  mode: selection.mode,
                  outputFileName: `${baseName} - ${selection.mode === "full" ? "Full" : "Summary"}.pdf`,
                  label: selection.mode === "full" ? "Unbranded" : "Branded",
                  ...(selection.mode === "full"
                    ? emailFullAttachmentPdfOptions()
                    : emailSummaryAttachmentPdfOptions(compose, bundle.runtimeContext)),
                },
              ];
        const generated =
          outputs.length > 1
            ? await pdfRuntime.generateProjectPdfsFromSnapshot(
                bundle.snapshot,
                bundle.runtimeContext,
                {
                  outputs: outputs.map(
                    ({
                      mode,
                      outputFileName,
                      clearBrandingOverrides,
                      disableOrganizationBranding,
                      useProjectOrganizationBranding,
                      brandingOverrides,
                      applyBrandingToFull,
                    }) => ({
                      mode,
                      outputFileName,
                      clearBrandingOverrides,
                      disableOrganizationBranding,
                      useProjectOrganizationBranding,
                      brandingOverrides,
                      applyBrandingToFull,
                    }),
                  ),
                  skipUpload: true,
                  skipStatusUpdate: true,
                },
              )
            : [
                await pdfRuntime.generateProjectPdfFromSnapshot(
                  bundle.snapshot,
                  bundle.runtimeContext,
                  {
                    mode: outputs[0].mode,
                    outputFileName: outputs[0].outputFileName,
                    clearBrandingOverrides: !!outputs[0].clearBrandingOverrides,
                    disableOrganizationBranding:
                      outputs[0].disableOrganizationBranding === true,
                    useProjectOrganizationBranding:
                      outputs[0].useProjectOrganizationBranding === true,
                    brandingOverrides: outputs[0].brandingOverrides,
                    applyBrandingToFull: !!outputs[0].applyBrandingToFull,
                    skipUpload: true,
                    skipStatusUpdate: true,
                  },
                ),
              ];
        const files = generated
          .map((entry, index) => {
            const blob = entry?.result?.blob;
            if (!blob) return null;
            const url = URL.createObjectURL(blob);
            return {
              label: outputs[index]?.label || entry?.result?.filename || `Preview ${index + 1}`,
              filename: entry?.result?.filename || outputs[index]?.outputFileName || `Preview ${index + 1}.pdf`,
              url,
            };
          })
          .filter(Boolean);
        state.ui.emailPreview = {
          open: true,
          loading: false,
          error: files.length ? "" : "Could not generate a preview for that PDF.",
          title: `${selection.label} Preview`,
          files,
          activeIndex: 0,
        };
      } catch (error) {
        state.ui.emailPreview = {
          open: true,
          loading: false,
          error: error?.message || "Could not generate a preview for that PDF.",
          title: `${selection?.label || "Attachment"} Preview`,
          files: [],
          activeIndex: 0,
        };
      }
      render();
    }
    function closeEmailAttachmentPreview() {
      const files = Array.isArray(state.ui?.emailPreview?.files) ? state.ui.emailPreview.files : [];
      files.forEach((item) => {
        try {
          if (item?.url) URL.revokeObjectURL(item.url);
        } catch (_) {}
      });
      state.ui.emailPreview = {
        open: false,
        loading: false,
        error: "",
        title: "",
        files: [],
        activeIndex: 0,
      };
      render();
    }
    function render() {
      if (!currentLead) return;
      if (titleEl)
        titleEl.textContent =
          currentLead.company || currentLead.lead_name || "Lead";
      setMockupMode(true);
      ensureGmailPopupListener();
      bodyEl.innerHTML = renderBody(currentLead, opts, state);
      exposeHistoryDebugApi();
      bindHistoryControls();
      bindSmsControls();
      bindEmailPreviewControls();
      bodyEl
        .querySelectorAll("[data-lead-core-name],[data-lead-core-field]")
        .forEach((field) => {
          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
          field.style.borderRadius = "0";
          field.style.boxShadow = "none";
          field.style.appearance = "none";
          field.style.webkitAppearance = "none";
        });
      applyHistoryDomState();
      restoreCalendarDayViewScroll();
    }
    function restoreCalendarDayViewScroll() {
      const scroller = bodyEl.querySelector("[data-lead-calendar-day-scroll]");
      if (!(scroller instanceof HTMLElement)) return;
      const renderDate = String(scroller.getAttribute("data-calendar-date") || "").trim();
      if (renderDate && state.ui.calendarDayViewDate !== renderDate) {
        state.ui.calendarDayViewDate = renderDate;
        state.ui.calendarDayViewScrollTop = 0;
      }
      scroller.scrollTop = Math.max(0, Number(state.ui.calendarDayViewScrollTop || 0));
    }
    async function loadLead(leadId, loadOptions) {
      const options = loadOptions || {};
      const showBlockingLoading = !options.silent && !currentLead;
      if (showBlockingLoading) {
        bodyEl.innerHTML = '<div class="lead-empty">Loading lead...</div>';
      }
      const switchingLead =
        String(currentLead?.id || "") !== String(leadId || "");
      const skipExternalSync = !!opts.callbackMode || !!options.skipExternalSync;
      const forceRingCentralSync =
        !skipExternalSync && (!!options.forceRingCentralSync || switchingLead);
      const data = await api({
        action: "lead_get",
        id: leadId,
        skip_external_sync: skipExternalSync ? "1" : "",
        force_ringcentral_sync: forceRingCentralSync ? "1" : "",
      }).catch(
        () => ({}),
      );
      if (!data.success || !data.lead) {
        if (showBlockingLoading || !currentLead) {
          bodyEl.innerHTML = `<div class="lead-empty">${esc(data.error || "Could not load lead.")}</div>`;
        } else {
          showToast(data.error || "Could not refresh this lead right now.", "error");
        }
        return;
      }
      if (switchingLead || options.resetTransient) resetTransientDrafts();
      currentLead = data.lead;
      syncUiWithLead(switchingLead || options.resetTransient);
      if (!leadCoreDraftChanged(state.leadCoreDraft, currentLead) || switchingLead || options.resetTransient) {
        state.leadCoreDraft = blankLeadCoreDraft(currentLead);
      }
      state.emailDraft =
        state.saveStates.companyEmail.status === "dirty"
          ? state.emailDraft
          : currentLead.email || "";
      state.emailDirty =
        state.emailDraft.trim() !== String(currentLead.email || "").trim();
      if (
        !state.followupDraft?.followup_date &&
        !state.followupDraft?.meeting_date &&
        !state.followupDraft?.body
      )
        state.followupDraft = blankFollowupDraft();
      if (!String(state.followupDraft?.meeting_date || "").trim()) {
        clearCalendarDayEvents();
      }
      markLeadRefreshComplete();
      startLeadAutoRefresh();
      render();
    }
    async function reload() {
      await refreshLeadActivity("reload", { force: true });
    }
    function clearCalendarDayEvents() {
      state.ui.calendarEventsDate = "";
      state.ui.calendarEventsError = "";
      state.ui.calendarDayEvents = [];
      state.ui.calendarEventsLoading = false;
      state.ui.calendarDayViewDate = "";
      state.ui.calendarDayViewScrollTop = 0;
    }
    async function loadCalendarDayEvents(dateValue, loadOptions) {
      const opts = loadOptions || {};
      const date = String(dateValue || "").trim();
      if (!currentLead?.id) return;
      if (!date) {
        clearCalendarDayEvents();
        render();
        return;
      }
      if (
        !opts.force &&
        state.ui.calendarEventsDate === date &&
        !state.ui.calendarEventsError
      ) {
        render();
        return;
      }
      state.ui.calendarEventsDate = date;
      state.ui.calendarEventsError = "";
      state.ui.calendarEventsLoading = true;
      if (!opts.keepExisting) state.ui.calendarDayEvents = [];
      render();
      const data = await api({
        action: "lead_calendar_day_events",
        lead_id: currentLead.id,
        date,
        viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      }).catch(() => ({}));
      state.ui.calendarEventsLoading = false;
      if (!data.success) {
        state.ui.calendarEventsError =
          data.error || "Could not load Google Calendar events for that day.";
        state.ui.calendarDayEvents = [];
        render();
        return;
      }
      state.ui.calendarEventsDate = String(data.date || date);
      state.ui.calendarEventsError = "";
      state.ui.calendarDayEvents = Array.isArray(data.events) ? data.events : [];
      render();
    }
    async function saveContact() {
      if (!currentLead?.id || state.saveStates.contact.status === "saving")
        return;
      if (!contactDraftChanged()) {
        setSaveState("contact", "idle");
        return;
      }
      if (!contactDraftHasContent(state.contactDraft)) {
        setSaveState("contact", "idle");
        return;
      }
      setSaveState("contact", "saving");
      const payload = {
        action: "lead_save_contact",
        lead_id: currentLead.id,
        contact_id: state.contactDraft.contact_id || "",
        full_name: String(state.contactDraft.full_name || "").trim(),
        title: String(state.contactDraft.title || "").trim(),
        email: String(state.contactDraft.email || "").trim(),
        secondary_emails: String(state.contactDraft.secondary_emails_text || "").trim(),
        phone: String(state.contactDraft.phone || "").trim(),
        notes: String(state.contactDraft.notes || "").trim(),
      };
      const data = await api(payload).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "contact",
          "error",
          data.error || "Could not save contact.",
        );
        render();
        return;
      }
      resetContactDraft(null);
      setSaveState("contact", "saved");
      await reload();
    }
    async function saveContactNote(contactId) {
      if (!currentLead?.id || !contactId) return;
      if (state.contactNoteSaveStates[contactId]?.status === "saving") return;
      const noteText = String(
        state.contactNoteDrafts?.[contactId] || "",
      ).trim();
      if (!noteText) {
        setContactNoteSaveState(contactId, "idle");
        return;
      }
      setContactNoteSaveState(contactId, "saving");
      const data = await api({
        action: "lead_save_contact_note",
        lead_id: currentLead.id,
        contact_id: contactId,
        note_text: noteText,
      }).catch(() => ({}));
      if (!data.success) {
        setContactNoteSaveState(
          contactId,
          "error",
          data.error || "Could not save contact note.",
        );
        render();
        return;
      }
      if (currentLead && data.contact_notes && typeof data.contact_notes === "object") {
        currentLead.contact_notes = data.contact_notes;
      }
      state.contactNoteDrafts[contactId] = "";
      state.contactNoteTargetId = "";
      setContactNoteSaveState(contactId, "saved");
      await reload();
    }
    async function persistOpenContactNoteDraft() {
      const openContactId = String(state.contactNoteTargetId || "").trim();
      if (!openContactId) return true;
      const noteText = String(state.contactNoteDrafts?.[openContactId] || "").trim();
      const noteStatus = String(
        state.contactNoteSaveStates?.[openContactId]?.status || "",
      ).trim();
      if (!noteText && noteStatus !== "error") {
        state.contactNoteTargetId = "";
        return true;
      }
      await saveContactNote(openContactId);
      return (
        String(state.contactNoteSaveStates?.[openContactId]?.status || "").trim() !==
        "error"
      );
    }
    function callAnnotationSourceItem(dialEventId) {
      return (Array.isArray(currentLead?.dial_events) ? currentLead.dial_events : []).find(
        (item) => String(item?.id || "") === String(dialEventId || ""),
      ) || null;
    }
    async function saveCallAnnotation(dialEventId, opts) {
      if (!currentLead?.id || !dialEventId) return;
      if (state.callAnnotationSaveStates?.[dialEventId]?.status === "saving") return;
      const sourceItem = callAnnotationSourceItem(dialEventId);
      const disposition =
        opts?.disposition != null
          ? String(opts.disposition || "").trim()
          : String(state.ui?.callDispositionDrafts?.[dialEventId] ?? sourceItem?.context?.disposition ?? "").trim();
      const notes =
        opts?.notes != null
          ? String(opts.notes || "")
          : String(state.ui?.callNoteDrafts?.[dialEventId] ?? sourceItem?.context?.notes ?? "");
      setCallAnnotationSaveState(dialEventId, "saving");
      render();
      const data = await api({
        action: "crm_call_annotation_save",
        lead_id: currentLead.id,
        dial_event_id: dialEventId,
        disposition,
        notes,
      }).catch(() => ({}));
      if (!data.success) {
        setCallAnnotationSaveState(
          dialEventId,
          "error",
          data.error || "Could not save call disposition.",
        );
        render();
        return;
      }
      setCallAnnotationSaveState(dialEventId, "saved");
      await reload();
    }
    async function saveNote() {
      if (!currentLead?.id || state.saveStates.note.status === "saving") return;
      const noteText = String(state.noteDraft || "").trim();
      if (!noteText) {
        setSaveState("note", "idle");
        return;
      }
      setSaveState("note", "saving");
      const data = await api({
        action: "lead_add_note",
        lead_id: currentLead.id,
        note_text: noteText,
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState("note", "error", data.error || "Could not save note.");
        render();
        return;
      }
      state.noteDraft = "";
      state.newNoteOpen = false;
      setSaveState("note", "saved");
      await reload();
    }
    async function saveFollowup(overrides, options) {
      if (!currentLead?.id || state.saveStates.followup.status === "saving")
        return;
      const opts = options || {};
      const draft = opts.draft || state.followupDraft || blankFollowupDraft();
      const payload = {
        action: "lead_save_followup",
        lead_id: currentLead.id,
        title:
          String(draft.title || "").trim() || buildAutoFollowupTitle(draft),
        body: String(draft.body || "").trim(),
        due_at: buildScheduledAtValue(draft),
        status: "open",
        ...(overrides || {}),
      };
      if (
        !payload.followup_id &&
        !payload.title &&
        !payload.body &&
        !payload.due_at
      ) {
        setSaveState("followup", "idle");
        return;
      }
      if (payload.status !== "done" && !payload.due_at) {
        setSaveState(
          "followup",
          "error",
          "Choose a follow-up date to autosave.",
        );
        render();
        return;
      }
      setSaveState("followup", "saving");
      const data = await api(payload).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "followup",
          "error",
          data.error || "Could not save follow-up.",
        );
        render();
        return;
      }
      if (!opts.keepDraft) state.followupDraft = blankFollowupDraft();
      setSaveState("followup", "saved");
      if (!opts.skipReload) await reload();
      return data;
    }
    function queueLeadCoreAutosave() {
      clearTimeout(leadCoreSaveTimer);
      leadCoreSaveTimer = setTimeout(() => {
        saveLeadCoreFields();
      }, 700);
    }
    function followupDraftHasContent(draft) {
      const nextDraft = draft || blankFollowupDraft();
      return (
        String(nextDraft.body || "").trim() !== "" ||
        String(nextDraft.followup_date || "").trim() !== "" ||
        String(nextDraft.followup_slot || "").trim() !== "" ||
        String(nextDraft.meeting_date || "").trim() !== "" ||
        String(nextDraft.meeting_time || "").trim() !== "" ||
        Number(nextDraft.duration_minutes || 30) !== 30
      );
    }
    function pendingCallAnnotationIds() {
      return Object.keys(state.callAnnotationSaveStates || {}).filter((dialEventId) => {
        const status = String(
          state.callAnnotationSaveStates?.[dialEventId]?.status || "",
        ).trim();
        return status === "dirty" || status === "saving" || status === "error";
      });
    }
    function pendingContactNoteIds() {
      return Object.keys(state.contactNoteSaveStates || {}).filter((contactId) => {
        const status = String(
          state.contactNoteSaveStates?.[contactId]?.status || "",
        ).trim();
        return status === "dirty" || status === "saving" || status === "error";
      });
    }
    function clearPendingAutosaveTimers() {
      clearTimeout(leadCoreSaveTimer);
      leadCoreSaveTimer = null;
      clearTimeout(focusoutTimer);
      focusoutTimer = null;
    }
    async function waitForPendingAutosaves(timeoutMs) {
      const deadline = Date.now() + Math.max(250, Number(timeoutMs || 0) || 2500);
      while (Date.now() < deadline) {
        const callSavesPending = Object.values(
          state.callAnnotationSaveStates || {},
        ).some((entry) => String(entry?.status || "").trim() === "saving");
        const contactNoteSavesPending = Object.values(
          state.contactNoteSaveStates || {},
        ).some((entry) => String(entry?.status || "").trim() === "saving");
        if (
          state.saveStates.leadCore.status !== "saving" &&
          state.saveStates.contact.status !== "saving" &&
          state.saveStates.note.status !== "saving" &&
          state.saveStates.followup.status !== "saving" &&
          !callSavesPending &&
          !contactNoteSavesPending
        ) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }
    function hasBlockingAutosaveErrors() {
      const callErrors = Object.values(state.callAnnotationSaveStates || {}).some(
        (entry) => String(entry?.status || "").trim() === "error",
      );
      const contactNoteErrors = Object.values(
        state.contactNoteSaveStates || {},
      ).some((entry) => String(entry?.status || "").trim() === "error");
      return (
        state.saveStates.leadCore.status === "error" ||
        state.saveStates.contact.status === "error" ||
        state.saveStates.note.status === "error" ||
        state.saveStates.followup.status === "error" ||
        callErrors ||
        contactNoteErrors
      );
    }
    async function flushPendingChanges() {
      if (!currentLead?.id) return true;
      clearPendingAutosaveTimers();
      const tasks = [Promise.resolve(saveLeadCoreFields())];
      if (contactDraftHasContent(state.contactDraft) && contactDraftChanged()) {
        tasks.push(Promise.resolve(saveContact()));
      }
      if (String(state.noteDraft || "").trim() !== "") {
        tasks.push(Promise.resolve(saveNote()));
      }
      if (followupDraftHasContent(state.followupDraft)) {
        tasks.push(Promise.resolve(saveFollowup()));
      }
      pendingCallAnnotationIds().forEach((dialEventId) => {
        if (
          String(state.callAnnotationSaveStates?.[dialEventId]?.status || "").trim() ===
          "dirty"
        ) {
          tasks.push(Promise.resolve(saveCallAnnotation(dialEventId)));
        }
      });
      pendingContactNoteIds().forEach((contactId) => {
        if (
          String(state.contactNoteSaveStates?.[contactId]?.status || "").trim() ===
          "dirty"
        ) {
          tasks.push(Promise.resolve(saveContactNote(contactId)));
        }
      });
      await Promise.allSettled(tasks);
      await waitForPendingAutosaves(2500);
      clearPendingAutosaveTimers();
      if (state.ui.leadCoreSaveQueued || leadCoreDraftChanged()) {
        state.ui.leadCoreSaveQueued = false;
        await Promise.resolve(saveLeadCoreFields());
        await waitForPendingAutosaves(2500);
      }
      return !hasBlockingAutosaveErrors();
    }
    async function saveLeadCoreFields() {
      if (!currentLead?.id) return;
      const activeCoreInput = activeLeadCoreInput();
      const preserveTypingFocus = !!activeCoreInput;
      if (!leadCoreDraftChanged()) {
        setSaveState("leadCore", "idle");
        return;
      }
      if (state.saveStates.leadCore.status === "saving") {
        state.ui.leadCoreSaveQueued = true;
        return;
      }
      const payload = {
        display_name: String(state.leadCoreDraft?.display_name || "").trim(),
        email: String(state.leadCoreDraft?.email || "").trim(),
        phone: String(state.leadCoreDraft?.phone || "").trim(),
        website: String(state.leadCoreDraft?.website || "").trim(),
        address: String(state.leadCoreDraft?.address || "").trim(),
      };
      setSaveState("leadCore", "saving", "Autosaving lead details...");
      if (!preserveTypingFocus) {
        showToast("Saving lead details...", "success", 1400);
        render();
      }
      const data = await api({
        action: "lead_update_core_fields",
        lead_id: currentLead.id,
        ...payload,
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState("leadCore", "error", data.error || "Could not save lead details.");
        showToast(data.error || "Could not save lead details.", "error", 2600);
        render();
        return;
      }
      currentLead = {
        ...currentLead,
        ...(data.lead || {}),
        company: payload.display_name,
        lead_name: payload.display_name,
        email: payload.email,
        phone: payload.phone,
        website: payload.website,
        address: payload.address,
      };
      if (!leadCoreDraftChanged(state.leadCoreDraft, currentLead)) {
        state.leadCoreDraft = blankLeadCoreDraft(currentLead);
        setSaveState("leadCore", "saved", "Lead details saved.");
        if (!preserveTypingFocus) {
          showToast("Lead details saved.", "success", 1800);
        }
      } else {
        setSaveState("leadCore", "dirty", "Autosaving lead details...");
      }
      if (!preserveTypingFocus) {
        render();
      }
      if (state.ui.leadCoreSaveQueued || leadCoreDraftChanged()) {
        state.ui.leadCoreSaveQueued = false;
        queueLeadCoreAutosave();
      }
    }
    async function setPrimaryContact(contactId) {
      if (!currentLead?.id || !contactId) return;
      setSaveState("contact", "saving", "Updating primary contact...");
      render();
      const data = await api({
        action: "lead_set_primary_contact",
        lead_id: currentLead.id,
        contact_id: contactId,
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState("contact", "error", data.error || "Could not update the primary contact.");
        showToast(data.error || "Could not update the primary contact.", "error", 2400);
        render();
        return;
      }
      if (Array.isArray(data.contacts)) currentLead.contacts = data.contacts;
      setSaveState("contact", "saved", "Primary contact updated.");
      showToast("Primary contact updated.", "success", 1800);
      render();
    }
    async function saveCompanyEmail() {
      if (!currentLead?.id || state.saveStates.companyEmail.status === "saving")
        return;
      const email = String(state.emailDraft || "").trim();
      if (email === String(currentLead.email || "").trim()) {
        setSaveState("companyEmail", "idle");
        return;
      }
      setSaveState("companyEmail", "saving");
      const data = await api({
        action: "lead_update_company_email",
        lead_id: currentLead.id,
        email,
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "companyEmail",
          "error",
          data.error || "Could not update company email.",
        );
        render();
        return;
      }
      state.emailDraft = email;
      state.emailDirty = false;
      currentLead = {
        ...currentLead,
        email,
        updated_at: data.lead?.updated_at || currentLead.updated_at,
      };
      setSaveState("companyEmail", "saved");
      render();
      if (typeof opts.onUpdated === "function") opts.onUpdated(currentLead);
    }
    async function saveStage(nextStage) {
      if (!currentLead?.id || state.saveStates.stage.status === "saving") return;
      const normalized = normalizeStageLabel(nextStage);
      const previous = normalizeStageLabel(currentLead?.status || "Contacted");
      if (!normalized || normalized === previous) {
        state.ui.stageValue = previous;
        render();
        return;
      }
      state.ui.stageValue = normalized;
      setSaveState("stage", "saving");
      render();
      const data = await api({
        action: "lead_save_stage",
        lead_id: currentLead.id,
        stage: normalized,
      }).catch(() => ({}));
      if (!data.success) {
        state.ui.stageValue = previous;
        setSaveState("stage", "error", data.error || "Could not save stage.");
        render();
        return;
      }
      setSaveState("stage", "saved");
      await reload();
    }
    async function saveMilestone(key, value) {
      if (!currentLead?.id || state.saveStates.milestone.status === "saving")
        return;
      setSaveState("milestone", "saving");
      render();
      const data = await api({
        action: "lead_save_milestone",
        lead_id: currentLead.id,
        key,
        value: value ? "1" : "0",
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "milestone",
          "error",
          data.error || "Could not save milestone.",
        );
        render();
        return;
      }
      setSaveState("milestone", "saved");
      await reload();
    }
    async function assignOrgCredits() {
      if (!currentLead?.id || state.saveStates.accountBilling?.status === "saving") {
        return;
      }
      const amount = Math.max(
        0,
        Number.parseInt(String(state.ui.billingCreditAmount || "").trim(), 10) || 0,
      );
      if (amount < 1) {
        setSaveState("accountBilling", "error", "Enter a credit amount greater than 0.");
        showToast("Enter a credit amount greater than 0.", "error", 2200);
        render();
        return;
      }
      setSaveState("accountBilling", "saving", "Assigning credits...");
      render();
      const data = await api({
        action: "lead_assign_org_credits",
        lead_id: currentLead.id,
        amount: String(amount),
        note: String(state.ui.billingCreditNote || ""),
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "accountBilling",
          "error",
          data.error || "Could not assign credits.",
        );
        showToast(data.error || "Could not assign credits.", "error", 2600);
        render();
        return;
      }
      if (data.organization_snapshot && currentLead) {
        currentLead.organization_snapshot = data.organization_snapshot;
      }
      if (data.milestones && currentLead?.crm) {
        currentLead.crm.milestones = data.milestones;
      }
      state.ui.billingCreditAmount = "";
      state.ui.billingCreditNote = "";
      const creditAmountLabel = `$${Number(amount).toLocaleString()}`;
      setSaveState(
        "accountBilling",
        "saved",
        `Assigned ${creditAmountLabel} in credits.`,
      );
      showToast(`Assigned ${creditAmountLabel} in credits.`, "success", 2200);
      render();
    }
    async function sendEmail(windowId) {
      if (!currentLead?.id || state.saveStates.emailSend.status === "saving")
        return;
      const targetWindowId = String(windowId || activeEmailWindow()?.id || "");
      if (!targetWindowId) return;
      setActiveEmailWindow(targetWindowId);
      const compose = syncEmailComposeFromDom(targetWindowId) || blankEmailCompose();
      const recipients = composeEmailRecipients(compose, selectableRecipients());
      const threading = resolveEmailThreading(compose, recipients);
      if (!recipients.length) {
        const missingRecipientMessage =
          "Choose a recipient or enter a valid email address before sending.";
        setSaveState("emailSend", "error", missingRecipientMessage);
        state.saveStates.emailSend.windowId = targetWindowId;
        showToast(missingRecipientMessage, "error", 2200);
        render();
        return;
      }
      setSaveState("emailSend", "saving", "");
      state.saveStates.emailSend.windowId = targetWindowId;
      render();
      let generatedAttachments = { files: [], metadata: [] };
      try {
        await saveEmailBranding(targetWindowId);
        generatedAttachments = await generateEmailAttachmentFiles(compose);
      } catch (error) {
        setSaveState(
          "emailSend",
          "error",
          error?.message || "Could not build the email attachments.",
        );
        state.saveStates.emailSend.windowId = targetWindowId;
        showToast(
          error?.message || "Could not build the email attachments.",
          "error",
          3200,
        );
        render();
        return;
      }
      setSaveState("emailSend", "saving", "Sending through Gmail...");
      state.saveStates.emailSend.windowId = targetWindowId;
      render();
      const form = new FormData();
      form.append("action", "lead_send_email");
      form.append("lead_id", currentLead.id);
      form.append("bcc", String(compose.bcc || "").trim());
      form.append(
        "recipient_contacts_json",
        JSON.stringify(
          recipients.map((entry) => ({
            contact_id: String(entry.contactId || ""),
            email: String(entry.selectedEmail || ""),
            create_contact: !!entry.createContact,
          })),
        ),
      );
      form.append("subject", String(compose.subject || "").trim());
      form.append("body", String(compose.body || "").trim());
      form.append("body_html", String(compose.bodyHtml || "").trim());
      form.append("signature_html", String(emailSignatureHtml(compose) || "").trim());
      form.append("template", String(compose.template || "").trim());
      form.append("thread_id", String(threading.threadId || "").trim());
      form.append("in_reply_to", String(threading.inReplyTo || "").trim());
      form.append("references", String(threading.references || "").trim());
      form.append("branding_json", JSON.stringify(normalizeEmailBrandingInput(compose.branding)));
      form.append("attachments_json", JSON.stringify(generatedAttachments.metadata));
      generatedAttachments.files.forEach((file) => {
        form.append("email_attachment_files[]", file, file.name);
      });
      const data = await fetch(serverEndpoint, {
        method: "POST",
        body: form,
      })
        .then((response) => response.json())
        .catch(() => ({}));
      if (!data.success) {
        if (Array.isArray(data.contacts) && currentLead) {
          currentLead.contacts = data.contacts;
        }
        setSaveState(
          "emailSend",
          "error",
          data.error || "Could not send email.",
        );
        state.saveStates.emailSend.windowId = targetWindowId;
        showToast(data.error || "Could not send email through Gmail.", "error", 3200);
        render();
        return;
      }
      if (Array.isArray(data.contacts) && currentLead) {
        currentLead.contacts = data.contacts;
      }
      setSaveState("emailSend", "saved");
      state.saveStates.emailSend.windowId = targetWindowId;
      closeEmailWindow(targetWindowId, { force: true });
      showToast("Email sent successfully through Gmail.", "success", 2800);
      await reload();
    }
    async function sendSms() {
      if (!currentLead?.id || state.saveStates.smsSend.status === "saving")
        return;
      const body = String(state.ui?.smsDraft || "").trim();
      const fallbackContact =
        findContactById(state.ui?.smsRecipientContactId || "") ||
        findContactById(state.ui?.smsThreadId || "") ||
        getPrimarySmsContact();
      const recipientContactId = String(
        state.ui?.smsRecipientContactId || fallbackContact?.id || "",
      ).trim();
      const phone = String(
        state.ui?.smsPhone || leadPreferredContactPhoneForUi(fallbackContact) || "",
      ).trim();
      if (!body) {
        setSaveState("smsSend", "error", "Add a text message first.");
        showToast("Add a text message first.", "error", 2200);
        render();
        return;
      }
      if (!recipientContactId) {
        setSaveState("smsSend", "error", "Choose a recipient before sending a text.");
        showToast("Choose a recipient before sending a text.", "error", 2200);
        render();
        return;
      }
      if (!phone) {
        setSaveState("smsSend", "error", "Add a phone number before sending a text.");
        showToast("Add a phone number before sending a text.", "error", 2200);
        render();
        return;
      }
      state.ui.smsRecipientContactId = recipientContactId;
      state.ui.smsPhone = phone;
      setSaveState("smsSend", "saving");
      showToast("Sending text through RingCentral...", "success", 1800);
      render();
      const threadId = recipientContactId || state.ui.smsThreadId || "lead";
      const data = await api({
        action: "lead_send_sms",
        lead_id: currentLead.id,
        body,
        thread_id: threadId,
        recipient_contact_id: recipientContactId,
        phone,
      }).catch(() => ({}));
      if (!data.success) {
        if (Array.isArray(data.contacts) && currentLead) {
          currentLead.contacts = data.contacts;
        }
        setSaveState("smsSend", "error", data.error || "Could not send text.");
        showToast(data.error || "Could not send text through RingCentral.", "error", 3200);
        render();
        return;
      }
      if (Array.isArray(data.contacts) && currentLead) {
        currentLead.contacts = data.contacts;
      }
      state.ui.smsDraft = "";
      state.ui.smsOpen = false;
      state.ui.smsThreadId = threadId;
      setSaveState("smsSend", "saved");
      showToast("Text sent successfully through RingCentral.", "success", 2400);
      await reload();
    }
    async function saveCalendarEvent(options) {
      if (!currentLead?.id || state.saveStates.calendar.status === "saving")
        return;
      const opts = options || {};
      const draft = opts.draft || state.followupDraft || blankFollowupDraft();
      const calendar = currentLead?.crm?.calendar || {};
      const schedule = buildMeetingScheduleDetails(
        draft,
        getLeadTimeInfo(currentLead),
        getViewerTimeInfo(),
      );
      if (schedule.mode === "none") {
        setSaveState(
          "calendar",
          "error",
          "Pick both a meeting date and time first.",
        );
        render();
        return;
      }
      if (calendar.configured === false) {
        setSaveState("calendar", "error", "Google Calendar is not configured on this server yet.");
        render();
        return;
      }
      if (!calendar.connected) {
        setSaveState("calendar", "error", "Connect Google Calendar first.");
        render();
        return;
      }
      setSaveState("calendar", "saving");
      render();
      const data = await api({
        action: "lead_schedule_calendar",
        lead_id: currentLead.id,
        title:
          String(opts.title || "").trim() || buildAutoMeetingTitle(currentLead),
        body: String(opts.body ?? draft.body ?? "").trim(),
        scheduled_at: `${String(draft.meeting_date || "").trim()} ${String(draft.meeting_time || "").trim()}`.trim(),
        scheduled_mode: schedule.mode,
        all_day_date: "",
        start_ts: schedule.startTs ? String(schedule.startTs) : "",
        end_ts: schedule.endTs ? String(schedule.endTs) : "",
        duration_minutes: String(
          schedule.durationMinutes || draft.duration_minutes || 30,
        ),
        viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        invite_contacts: "0",
        add_meet: state.ui.calendarAddMeet ? "1" : "0",
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "calendar",
          "error",
          data.error || "Could not save calendar event.",
        );
        render();
        return;
      }
      if (!opts.keepDraft) state.followupDraft = blankFollowupDraft();
      if (!opts.keepDraft) clearCalendarDayEvents();
      setSaveState("calendar", "saved");
      showToast("Google Calendar event created successfully.", "success", 2800);
      if (!opts.skipReload) await reload();
      return data;
    }
    async function submitActivityNote() {
      const draft = state.followupDraft || blankFollowupDraft();
      const followupSchedule = buildFollowupScheduleDetails(
        draft,
        getLeadTimeInfo(currentLead),
        getViewerTimeInfo(),
      );
      const meetingSchedule = buildMeetingScheduleDetails(
        draft,
        getLeadTimeInfo(currentLead),
        getViewerTimeInfo(),
      );
      const noteText = String(draft.body || "").trim();
      const hasFollowup = followupSchedule.mode !== "none";
      const hasMeeting = meetingSchedule.mode !== "none";
      if (hasPartialMeetingSelection(draft)) {
        setSaveState(
          "calendar",
          "error",
          "Pick both a meeting date and time, or clear the meeting selection.",
        );
        render();
        return;
      }
      if (!hasFollowup && !hasMeeting && !noteText) {
        setSaveState("note", "error", "Add a note or schedule something first.");
        render();
        return;
      }
      if (!hasFollowup && !hasMeeting) {
        setSaveState("note", "saving");
        render();
        const data = await api({
          action: "lead_add_note",
          lead_id: currentLead.id,
          note_text: noteText,
        }).catch(() => ({}));
        if (!data.success) {
          setSaveState("note", "error", data.error || "Could not save note.");
          render();
          return;
        }
        state.followupDraft = blankFollowupDraft();
        clearCalendarDayEvents();
        setSaveState("note", "saved");
        showToast("Note saved successfully.", "success", 2200);
        await reload();
        return;
      }
      render();
      if (hasFollowup) {
        const followupData = await saveFollowup(
          {
            title: buildAutoFollowupTitle(draft),
            body: noteText,
            due_at: buildScheduledAtValue(draft),
            metadata_json: JSON.stringify({
              followup_slot: followupSchedule.mode,
              followup_headline: followupSchedule.headline,
            }),
          },
          { skipReload: true, keepDraft: true, draft },
        );
        if (!followupData?.success) return;
      }
      if (hasMeeting) {
        const meetingData = await saveCalendarEvent({
          skipReload: true,
          keepDraft: true,
          draft,
          body: noteText,
          title: buildAutoMeetingTitle(currentLead),
        });
        if (!meetingData?.success) return;
      }
      state.followupDraft = blankFollowupDraft();
      clearCalendarDayEvents();
      if (hasFollowup && hasMeeting) {
        showToast("Follow-up and Google Calendar meeting saved.", "success", 2800);
      } else if (hasFollowup) {
        showToast("Follow-up scheduled successfully.", "success", 2400);
      }
      await reload();
    }
    async function saveSequenceAction(operation, sequenceKey) {
      if (!currentLead?.id || state.saveStates.sequence.status === "saving")
        return;
      setSaveState("sequence", "saving");
      render();
      const data = await api({
        action: "lead_sequence_action",
        lead_id: currentLead.id,
        operation,
        sequence_key: sequenceKey || "",
      }).catch(() => ({}));
      if (!data.success) {
        setSaveState(
          "sequence",
          "error",
          data.error || "Could not update sequence.",
        );
        render();
        return;
      }
      setSaveState("sequence", "saved");
      await reload();
    }
    function setContactTitlePreset(title) {
      state.contactDraft.title_preset = title;
      state.contactDraft.title = title === "Other" ? "" : title;
      updateContactDirtyState();
      render();
    }
    function setFollowupDateOffset(days) {
      state.followupDraft.followup_date = isoDateForOffset(days);
      if (!String(state.followupDraft.followup_slot || "").trim()) {
        state.followupDraft.followup_slot = "all_day";
      }
      updateFollowupDirtyState();
      render();
    }
    bodyEl.addEventListener("click", async (event) => {
      if (event.target.closest("[data-lead-page-back]")) {
        if (typeof opts.onBack === "function") opts.onBack();
        return;
      }
      if (event.target.closest("[data-lead-toggle-new-note]")) {
        state.newNoteOpen = !state.newNoteOpen;
        render();
        return;
      }
      const toggle = event.target.closest("[data-toggle-section]");
      if (toggle) {
        const key = toggle.getAttribute("data-toggle-section");
        state.sections[key] = !state.sections[key];
        render();
        return;
      }
      if (event.target.closest("[data-lead-open-metadata]")) {
        const modal = bodyEl.querySelector("[data-lead-metadata-modal]");
        if (modal) modal.style.display = "flex";
        return;
      }
      if (event.target.closest("[data-lead-close-metadata]")) {
        const modal = bodyEl.querySelector("[data-lead-metadata-modal]");
        if (modal) modal.style.display = "none";
        return;
      }
      if (event.target === bodyEl.querySelector("[data-lead-metadata-modal]")) {
        event.target.style.display = "none";
        return;
      }
      if (event.target.closest("[data-lead-banner-action]")) {
        saveStage(stageAdvanceValue());
        return;
      }
      const emailWindowEl = event.target.closest("[data-email-window-id]");
      if (emailWindowEl) {
        setActiveEmailWindow(emailWindowEl.getAttribute("data-email-window-id") || "");
      }
      if (event.target.closest("[data-lead-open-email]")) {
        openPrimaryEmailCompose();
        return;
      }
      if (event.target.closest("[data-lead-gmail-connect]")) {
        openGmailConnectPopup();
        return;
      }
      if (event.target.closest("[data-lead-google-connect]")) {
        openGmailConnectPopup();
        return;
      }
      const replyBtn = event.target.closest("[data-lead-reply-email]");
      if (replyBtn) {
        openReplyCompose(replyBtn.getAttribute("data-lead-reply-email") || "", false);
        return;
      }
      const replyAllBtn = event.target.closest("[data-lead-reply-all-email]");
      if (replyAllBtn) {
        openReplyCompose(
          replyAllBtn.getAttribute("data-lead-reply-all-email") || "",
          true,
        );
        return;
      }
      const emailToggleMin = event.target.closest("[data-lead-email-toggle-minimize]");
      if (emailToggleMin) {
        const windowId = emailToggleMin.getAttribute("data-lead-email-toggle-minimize") || "";
        const targetWindow = setActiveEmailWindow(windowId);
        if (targetWindow) {
          targetWindow.minimized = !targetWindow.minimized;
          syncActiveEmailCompose();
          render();
        }
        return;
      }
      const closeEmailBtn = event.target.closest("[data-lead-close-email]");
      if (closeEmailBtn) {
        closeEmailWindow(closeEmailBtn.getAttribute("data-lead-close-email") || "");
        return;
      }
      if (event.target.closest("[data-lead-email-preview-close]")) {
        closeEmailAttachmentPreview();
        return;
      }
      const emailPreviewIndexBtn = event.target.closest("[data-lead-email-preview-index]");
      if (emailPreviewIndexBtn) {
        state.ui.emailPreview.activeIndex = Number(
          emailPreviewIndexBtn.getAttribute("data-lead-email-preview-index") || 0,
        ) || 0;
        render();
        return;
      }
      if (event.target.closest("[data-lead-open-sms]")) {
        syncSmsRecipientSelection(state.ui.smsRecipientContactId || state.ui.smsThreadId);
        state.ui.smsOpen = true;
        render();
        window.setTimeout(() => {
          refreshLeadActivity("sms_open", {
            force: true,
            silent: true,
            smsOnly: true,
            forceRingCentralSync: true,
          });
        }, 0);
        return;
      }
      if (event.target.closest("[data-lead-close-sms]")) {
        state.ui.smsOpen = false;
        render();
        return;
      }
      const smsThreadBtn = event.target.closest("[data-lead-sms-thread]");
      if (smsThreadBtn) {
        state.ui.smsThreadId =
          smsThreadBtn.getAttribute("data-lead-sms-thread") || "";
        syncSmsRecipientSelection(state.ui.smsThreadId);
        render();
        return;
      }
      if (event.target.closest("[data-lead-send-sms]")) {
        sendSms();
        return;
      }
      if (event.target.closest("[data-lead-tools-open]")) {
        state.ui.smsOpen = false;
        render();
        try {
          window.CallScripts?.open?.({ tab: "scripts" });
        } catch (_) {}
        return;
      }
      const accountTabBtn = event.target.closest("[data-lead-account-tab]");
      if (accountTabBtn) {
        state.ui.accountTab =
          accountTabBtn.getAttribute("data-lead-account-tab") || "ov";
        render();
        return;
      }
      if (event.target.closest("[data-lead-assign-org-credits]")) {
        assignOrgCredits();
        return;
      }
      const filterBtn = event.target.closest("[data-lead-activity-filter]");
      if (filterBtn) {
        state.ui.activityFilter =
          filterBtn.getAttribute("data-lead-activity-filter") || "all";
        render();
        return;
      }
      if (event.target.closest("[data-lead-toggle-history-all]")) {
        toggleHistoryAll("delegated_click");
        return;
      }
      const toggleHistory = event.target.closest("[data-lead-toggle-activity]");
      if (toggleHistory) {
        const toggleId =
          toggleHistory.getAttribute("data-lead-toggle-activity") || "";
        toggleHistoryItem(
          toggleId,
          "delegated_click",
        );
        return;
      }
      if (event.target.closest("[data-lead-submit-activity-note]")) {
        submitActivityNote();
        return;
      }
      if (event.target.closest("[data-lead-clear-activity-selection]")) {
        state.followupDraft.followup_date = "";
        state.followupDraft.followup_slot = "";
        state.followupDraft.meeting_date = "";
        state.followupDraft.meeting_time = "";
        clearCalendarDayEvents();
        updateFollowupDirtyState();
        render();
        return;
      }
      const emailTemplateBtn = event.target.closest(
        "[data-lead-email-template]",
      );
      if (emailTemplateBtn) {
        const targetWindowId =
          emailTemplateBtn.getAttribute("data-email-window-target") ||
          activeEmailWindow()?.id ||
          "";
        const activeWindow = setActiveEmailWindow(targetWindowId);
        const nextTemplateId = emailTemplateBtn.getAttribute("data-lead-email-template") || "";
        if (!activeWindow) return;
        const currentCompose = {
          ...blankEmailCompose(),
          ...(activeWindow.compose || {}),
        };
        const currentBody = String(currentCompose.body || "").trim();
        const currentSubject = String(currentCompose.subject || "").trim();
        const switchingTemplate =
          nextTemplateId &&
          String(currentCompose.template || "") &&
          String(currentCompose.template || "") !== String(nextTemplateId);
        if (switchingTemplate && (currentBody || currentSubject)) {
          const ok = window.confirm(
            `Replace your changes with the ${emailTemplateBtn.textContent?.trim() || "selected"} template?`,
          );
          if (!ok) return;
        }
        updateEmailWindowCompose(
          targetWindowId,
          buildEmailTemplate(
            nextTemplateId,
            currentCompose,
          ),
        );
        render();
        return;
      }
      const emailRecipientToggle = event.target.closest(
        "[data-lead-email-recipient-toggle]",
      );
      if (emailRecipientToggle) {
        const windowId =
          emailRecipientToggle.getAttribute("data-email-window-target") || "";
        const contactId =
          emailRecipientToggle.getAttribute("data-lead-email-recipient-toggle") || "";
        toggleEmailRecipient(windowId, contactId);
        render();
        return;
      }
      const emailCycleContact = event.target.closest(
        "[data-lead-email-cycle-contact]",
      );
      if (emailCycleContact) {
        const windowId =
          emailCycleContact.getAttribute("data-email-window-target") || "";
        const contactId =
          emailCycleContact.getAttribute("data-lead-email-cycle-contact") || "";
        cycleEmailRecipientAddress(windowId, contactId);
        render();
        return;
      }
      const emailFormatBtn = event.target.closest("[data-lead-email-format]");
      if (emailFormatBtn) {
        const targetWindowId =
          emailFormatBtn.getAttribute("data-email-window-target") ||
          activeEmailWindow()?.id ||
          "";
        if (targetWindowId) setActiveEmailWindow(targetWindowId);
        formatEmailBody(
          emailFormatBtn.getAttribute("data-lead-email-format") || "",
          targetWindowId,
        );
        return;
      }
      const emailLogoPickBtn = event.target.closest("[data-lead-email-logo-pick]");
      if (emailLogoPickBtn) {
        const targetWindowId =
          emailLogoPickBtn.getAttribute("data-email-window-target") ||
          emailLogoPickBtn.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") ||
          activeEmailWindow()?.id ||
          "";
        emailWindowElement(targetWindowId)
          ?.querySelector("[data-lead-email-logo-file]")
          ?.click();
        return;
      }
      const emailReportModeBtn = event.target.closest(
        "[data-lead-email-report-mode]",
      );
      if (emailReportModeBtn) {
        const id =
          emailReportModeBtn.getAttribute("data-lead-email-report-id") || "";
        const mode =
          emailReportModeBtn.getAttribute("data-lead-email-report-mode") || "";
        const targetWindowId =
          emailReportModeBtn.getAttribute("data-email-window-target") ||
          activeEmailWindow()?.id ||
          "";
        const attachments = normalizeEmailAttachmentSelections(
          emailComposeForWindow(targetWindowId)?.attachments,
        );
        const existing = attachments.findIndex(
          (item) => String(item.id) === String(id),
        );
        const template = emailReportTemplates().find(
          (item) => String(item.id) === String(id),
        );
        const nextAttachments = attachments.slice();
        if (existing >= 0 && nextAttachments[existing].mode === mode) {
          nextAttachments.splice(existing, 1);
        } else if (existing >= 0) {
          nextAttachments[existing] = {
            ...nextAttachments[existing],
            mode: normalizeAttachmentMode(mode),
          };
        } else if (template) {
          nextAttachments.push({
            id,
            label: String(template.label || template.id || id),
            mode: normalizeAttachmentMode(mode),
            file_names: [],
          });
        }
        updateEmailWindowCompose(targetWindowId, {
          ...emailComposeForWindow(targetWindowId),
          attachments: nextAttachments,
        });
        render();
        return;
      }
      const emailReportPreviewBtn = event.target.closest(
        "[data-lead-email-report-preview]",
      );
      if (emailReportPreviewBtn) {
        const targetWindowId =
          emailReportPreviewBtn.getAttribute("data-email-window-target") ||
          activeEmailWindow()?.id ||
          "";
        generateEmailAttachmentPreview(
          emailReportPreviewBtn.getAttribute("data-lead-email-report-preview") || "",
          targetWindowId,
        );
        return;
      }
      if (event.target.closest("[data-lead-send-email]")) {
        sendEmail(
          event.target.closest("[data-lead-send-email]")?.getAttribute("data-lead-send-email") || "",
        );
        return;
      }
      const sequenceActionBtn = event.target.closest("[data-lead-sequence-action]");
      if (sequenceActionBtn) {
        saveSequenceAction(
          sequenceActionBtn.getAttribute("data-lead-sequence-operation") ||
            "stop",
          sequenceActionBtn.getAttribute("data-lead-sequence-action") || "",
        );
        return;
      }
      const editContact = event.target.closest("[data-lead-edit-contact]");
      if (editContact) {
        const id = editContact.getAttribute("data-lead-edit-contact");
        const contact = (currentLead?.contacts || []).find(
          (item) => String(item.id) === String(id),
        );
        if (contact) {
          resetContactDraft(contact);
          state.ui.contactFormOpen = true;
          render();
        }
        return;
      }
      const primaryContactBtn = event.target.closest("[data-lead-set-primary-contact]");
      if (primaryContactBtn) {
        setPrimaryContact(
          primaryContactBtn.getAttribute("data-lead-set-primary-contact") || "",
        );
        return;
      }
      if (event.target.closest("[data-lead-toggle-contact-form]")) {
        if (
          state.ui.contactFormOpen &&
          contactDraftChanged() &&
          contactDraftHasContent(state.contactDraft)
        ) {
          state.ui.contactFormOpen = false;
          saveContact();
          return;
        }
        state.ui.contactFormOpen = !state.ui.contactFormOpen;
        if (
          !state.ui.contactFormOpen &&
          !state.contactDraft.contact_id &&
          !contactDraftHasContent(state.contactDraft)
        ) {
          resetContactDraft(null);
        }
        render();
        return;
      }
      const openContactNote = event.target.closest(
        "[data-lead-open-contact-note]",
      );
      if (openContactNote) {
        const nextContactId =
          openContactNote.getAttribute("data-lead-open-contact-note") || "";
        if (
          String(state.contactNoteTargetId || "").trim() &&
          String(state.contactNoteTargetId || "") !== String(nextContactId || "")
        ) {
          const saved = await persistOpenContactNoteDraft();
          if (!saved) return;
        }
        state.contactNoteTargetId = nextContactId;
        render();
        return;
      }
      if (event.target.closest("[data-lead-cancel-contact-note]")) {
        const saved = await persistOpenContactNoteDraft();
        if (!saved) return;
        state.contactNoteTargetId = "";
        render();
        return;
      }
      const titlePreset = event.target.closest("[data-contact-title-preset]");
      if (titlePreset) {
        setContactTitlePreset(
          titlePreset.getAttribute("data-contact-title-preset") || "",
        );
        return;
      }
      if (event.target.closest("[data-lead-clear-contact-draft]")) {
        resetContactDraft(null);
        state.ui.contactFormOpen = false;
        setSaveState("contact", "idle");
        render();
        return;
      }
      if (event.target.closest("[data-lead-clear-followup-draft]")) {
        state.followupDraft = blankFollowupDraft();
        setSaveState("followup", "idle");
        render();
        return;
      }
      const titleBtn = event.target.closest("[data-followup-title-preset]");
      const offsetBtn = event.target.closest("[data-followup-date-offset]");
      const slotBtn = event.target.closest("[data-followup-slot]");
      const meetingOffsetBtn = event.target.closest("[data-meeting-date-offset]");
      if (titleBtn) {
        const title = titleBtn.getAttribute("data-followup-title-preset") || "";
        state.followupDraft.title = title === "Other" ? "" : title;
        updateFollowupDirtyState();
      }
      if (offsetBtn) {
        setFollowupDateOffset(
          offsetBtn.getAttribute("data-followup-date-offset"),
        );
        return;
      }
      if (meetingOffsetBtn) {
        const offset = Number(
          meetingOffsetBtn.getAttribute("data-meeting-date-offset") || 0,
        );
        state.followupDraft.meeting_date = isoDateForOffset(offset);
        updateFollowupDirtyState();
        loadCalendarDayEvents(state.followupDraft.meeting_date, { force: true });
        return;
      }
      if (slotBtn) {
        const slot = slotBtn.getAttribute("data-followup-slot") || "";
        if (!String(state.followupDraft.followup_date || "").trim()) {
          state.followupDraft.followup_date = defaultFollowupDate();
        }
        state.followupDraft.followup_slot = slot || "all_day";
        updateFollowupDirtyState();
        render();
        return;
      }
      if (event.target.closest("[data-lead-calendar-add-meet-toggle]")) {
        state.ui.calendarAddMeet = !state.ui.calendarAddMeet;
        render();
        return;
      }
      if (titleBtn) {
        render();
        return;
      }
      const completeBtn = event.target.closest("[data-lead-complete-followup]");
      if (completeBtn) {
        const followupId = completeBtn.getAttribute(
          "data-lead-complete-followup",
        );
        const existing = (currentLead?.followups || []).find(
          (item) => String(item.id) === String(followupId),
        );
        return saveFollowup({
          followup_id: followupId,
          title: existing?.title || "",
          body: existing?.body || "",
          due_at: existing?.due_at
            ? hasMeaningfulTime(existing.due_at)
              ? new Date(Number(existing.due_at) * 1000)
                  .toISOString()
                  .slice(0, 16)
                  .replace("T", " ")
              : isoDateFromTs(existing.due_at)
            : "",
          status: "done",
        });
      }
    });
    function handleDraftInput(event) {
      const target = event.target;
      const leadCoreNameInput = target.closest("[data-lead-core-name]");
      if (leadCoreNameInput) {
        state.leadCoreDraft.display_name = leadCoreNameInput.value || "";
        captureLeadCoreFocusFromElement(leadCoreNameInput);
        setSaveState("leadCore", leadCoreDraftChanged() ? "dirty" : "idle");
        state.ui.leadCoreSaveQueued = false;
        queueLeadCoreAutosave();
        return;
      }
      const leadCoreField = target.closest("[data-lead-core-field]");
      if (leadCoreField) {
        const key = String(leadCoreField.getAttribute("data-lead-core-field") || "").trim();
        if (key && Object.prototype.hasOwnProperty.call(state.leadCoreDraft, key)) {
          state.leadCoreDraft[key] =
            key === "phone"
              ? applyPhoneFormattingToInput(leadCoreField)
              : leadCoreField.value || "";
          captureLeadCoreFocusFromElement(leadCoreField);
          setSaveState("leadCore", leadCoreDraftChanged() ? "dirty" : "idle");
          state.ui.leadCoreSaveQueued = false;
          queueLeadCoreAutosave();
        }
        return;
      }
      const billingCreditAmount = target.closest(
        "[data-lead-billing-credit-amount]",
      );
      if (billingCreditAmount) {
        state.ui.billingCreditAmount = billingCreditAmount.value || "";
        setSaveState(
          "accountBilling",
          String(state.ui.billingCreditAmount || "").trim() ? "dirty" : "idle",
          "Ready to assign free credits.",
        );
        return;
      }
      const billingCreditNote = target.closest("[data-lead-billing-credit-note]");
      if (billingCreditNote) {
        state.ui.billingCreditNote = billingCreditNote.value || "";
        return;
      }
      const contactField = target.closest(
        "[data-lead-contact-name],[data-lead-contact-title],[data-lead-contact-email],[data-lead-contact-phone],[data-lead-contact-notes]",
      );
      if (contactField) {
        if (contactField.hasAttribute("data-lead-contact-name"))
          state.contactDraft.full_name = contactField.value || "";
        if (contactField.hasAttribute("data-lead-contact-title"))
          state.contactDraft.title = contactField.value || "";
        if (contactField.hasAttribute("data-lead-contact-email"))
          state.contactDraft.email = contactField.value || "";
        if (contactField.hasAttribute("data-lead-contact-phone"))
          state.contactDraft.phone = contactField.value || "";
        if (contactField.hasAttribute("data-lead-contact-notes"))
          state.contactDraft.notes = contactField.value || "";
        updateContactDirtyState();
        return;
      }
      const contactNote = target.closest("[data-lead-contact-note-input]");
      if (contactNote) {
        const contactId =
          contactNote.getAttribute("data-lead-contact-note-input") || "";
        state.contactNoteDrafts[contactId] = contactNote.value || "";
        setContactNoteSaveState(
          contactId,
          String(contactNote.value || "").trim() ? "dirty" : "idle",
        );
        return;
      }
      const noteInput = target.closest("[data-lead-note-input]");
      if (noteInput) {
        state.noteDraft = noteInput.value || "";
        setSaveState(
          "note",
          String(state.noteDraft || "").trim() ? "dirty" : "idle",
        );
        return;
      }
      const followupTitle = target.closest("[data-lead-followup-title]");
      if (followupTitle) {
        state.followupDraft.title = followupTitle.value || "";
        updateFollowupDirtyState();
        return;
      }
      const followupBody = target.closest("[data-lead-followup-body]");
      if (followupBody) {
        state.followupDraft.body = followupBody.value || "";
        updateFollowupDirtyState();
        return;
      }
      const followupDate = event.target.closest("[data-lead-followup-date]");
      if (followupDate) {
        state.followupDraft.followup_date = followupDate.value || "";
        if (!state.followupDraft.followup_date) {
          state.followupDraft.followup_slot = "";
        } else if (!String(state.followupDraft.followup_slot || "").trim()) {
          state.followupDraft.followup_slot = "all_day";
        }
        updateFollowupDirtyState();
        render();
        return;
      }
      const meetingDate = event.target.closest("[data-lead-meeting-date]");
      if (meetingDate) {
        state.followupDraft.meeting_date = meetingDate.value || "";
        updateFollowupDirtyState();
        loadCalendarDayEvents(state.followupDraft.meeting_date, { force: true });
        return;
      }
      const meetingTime = event.target.closest("[data-lead-meeting-time]");
      if (meetingTime) {
        state.followupDraft.meeting_time = meetingTime.value || "";
        updateFollowupDirtyState();
        render();
        return;
      }
      const meetingDuration = target.closest("[data-lead-meeting-duration]");
      if (meetingDuration) {
        state.followupDraft.duration_minutes =
          Number(meetingDuration.value || 30) || 30;
        updateFollowupDirtyState();
        render();
        return;
      }
      const callDispositionInput = target.closest("[data-lead-call-disposition]");
      if (callDispositionInput) {
        const dialEventId =
          callDispositionInput.getAttribute("data-lead-call-disposition") || "";
        state.ui.callDispositionDrafts[dialEventId] =
          callDispositionInput.value || "";
        setCallAnnotationSaveState(
          dialEventId,
          String(callDispositionInput.value || "").trim() ? "dirty" : "idle",
        );
        saveCallAnnotation(dialEventId, {
          disposition: callDispositionInput.value || "",
        });
        return;
      }
      const callNotesInput = target.closest("[data-lead-call-notes]");
      if (callNotesInput) {
        const dialEventId =
          callNotesInput.getAttribute("data-lead-call-notes") || "";
        state.ui.callNoteDrafts[dialEventId] = callNotesInput.value || "";
        setCallAnnotationSaveState(
          dialEventId,
          String(callNotesInput.value || "").trim() ? "dirty" : "idle",
        );
        return;
      }
      const smsInput = target.closest("[data-lead-sms-input]");
      if (smsInput) {
        state.ui.smsDraft = smsInput.value || "";
        return;
      }
      const smsPhoneInput = target.closest("[data-lead-sms-phone]");
      if (smsPhoneInput) {
        state.ui.smsPhone = smsPhoneInput.value || "";
        return;
      }
      const emailManualRecipientInput = target.closest(
        "[data-lead-email-manual-pill]",
      );
      if (emailManualRecipientInput) {
        const windowId =
          emailManualRecipientInput.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "";
        setManualRecipientDrafts(windowId, manualRecipientDraftsFromDom(windowId));
        return;
      }
      const emailBccInput = target.closest("[data-lead-email-bcc]");
      if (emailBccInput) {
        const windowId =
          emailBccInput.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "";
        updateEmailWindowCompose(windowId, { bcc: emailBccInput.value || "" });
        return;
      }
      const emailSubjectInput = target.closest("[data-lead-email-subject]");
      if (emailSubjectInput) {
        const windowId =
          emailSubjectInput.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "";
        updateEmailWindowCompose(windowId, {
          subject: emailSubjectInput.value || "",
        });
        return;
      }
      const emailBodyInput = target.closest("[data-lead-email-body]");
      if (emailBodyInput) {
        const windowId =
          emailBodyInput.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "";
        updateEmailWindowCompose(windowId, {
          bodyHtml: emailBodyInput.innerHTML || "",
          body: (emailBodyInput.innerText || emailBodyInput.textContent || "").replace(/\r/g, ""),
        });
        captureEmailEditorSelection();
        return;
      }
    }
    bodyEl.addEventListener("input", handleDraftInput);
    bodyEl.addEventListener("change", handleDraftInput);
    bodyEl.addEventListener(
      "scroll",
      (event) => {
        const scroller = event.target?.closest?.("[data-lead-calendar-day-scroll]");
        if (!(scroller instanceof HTMLElement)) return;
        state.ui.calendarDayViewDate = String(
          scroller.getAttribute("data-calendar-date") || "",
        ).trim();
        state.ui.calendarDayViewScrollTop = Number(scroller.scrollTop || 0);
      },
      true,
    );
    bodyEl.addEventListener("focusin", (event) => {
      const callNotesField = event.target.closest("[data-lead-call-notes]");
      if (callNotesField) {
        callNotesField.setAttribute("rows", "3");
      }
    });
    bodyEl.addEventListener("keyup", (event) => {
      const editor = event.target.closest("[data-lead-email-body]");
      if (editor) {
        captureEmailEditorSelection(
          editor.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "",
        );
      }
    });
    bodyEl.addEventListener("keydown", (event) => {
      const manualRecipientInput = event.target.closest("[data-lead-email-manual-pill]");
      if (manualRecipientInput) {
        const key = String(event.key || "");
        const windowId =
          manualRecipientInput.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "";
        const pillIndex =
          manualRecipientInput.getAttribute("data-lead-email-manual-pill") || "0";
        if (key === "Enter" || key === "," || key === "Tab") {
          const value = String(manualRecipientInput.value || "").trim();
          if (key !== "Tab" || value) {
            event.preventDefault();
            commitManualRecipientPill(windowId, pillIndex);
            return;
          }
        }
        if (key === "Backspace" && !String(manualRecipientInput.value || "").trim()) {
          const currentIndex = Number(pillIndex || 0);
          if (currentIndex > 0) {
            event.preventDefault();
            const drafts = manualRecipientDraftsFromDom(windowId);
            drafts.splice(currentIndex - 1, 1);
            setManualRecipientDrafts(windowId, drafts);
            render();
            focusManualRecipientPill(windowId, Math.max(0, currentIndex - 1));
          }
        }
      }
    });
    bodyEl.addEventListener("mouseup", (event) => {
      const editor = event.target.closest("[data-lead-email-body]");
      if (editor) {
        captureEmailEditorSelection(
          editor.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") || "",
        );
      }
    });
    bodyEl.addEventListener("change", (event) => {
      const smsRecipientContactSelect = event.target.closest(
        "[data-lead-sms-recipient-contact]",
      );
      if (smsRecipientContactSelect) {
        const contactId = smsRecipientContactSelect.value || "";
        state.ui.smsThreadId = contactId;
        syncSmsRecipientSelection(contactId);
        render();
        return;
      }
      const smsTemplateSelect = event.target.closest("[data-lead-sms-template]");
      if (smsTemplateSelect) {
        state.ui.smsTemplate = smsTemplateSelect.value || "";
        const template = smsTemplateOptionsForLead(currentLead).find(
          (item) => String(item.value) === String(state.ui.smsTemplate || ""),
        );
        if (template && template.body) {
          state.ui.smsDraft = template.body;
        }
        render();
        return;
      }
      const smsPhoneInput = event.target.closest("[data-lead-sms-phone]");
      if (smsPhoneInput) {
        render();
        return;
      }
      const stageSelect = event.target.closest("[data-lead-stage-select]");
      if (stageSelect) {
        saveStage(stageSelect.value || "Contacted");
        return;
      }
      const emailBrandPrimary = event.target.closest(
        "[data-lead-email-brand-primary]",
      );
      if (emailBrandPrimary) {
        const targetWindowId =
          emailBrandPrimary.getAttribute("data-email-window-target") ||
          emailBrandPrimary.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") ||
          activeEmailWindow()?.id ||
          "";
        updateEmailBranding(
          { primaryColor: emailBrandPrimary.value || "" },
          targetWindowId,
        );
        queueEmailBrandingSave(targetWindowId);
        render();
        return;
      }
      const emailBrandSecondary = event.target.closest(
        "[data-lead-email-brand-secondary]",
      );
      if (emailBrandSecondary) {
        const targetWindowId =
          emailBrandSecondary.getAttribute("data-email-window-target") ||
          emailBrandSecondary.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") ||
          activeEmailWindow()?.id ||
          "";
        updateEmailBranding(
          { secondaryColor: emailBrandSecondary.value || "" },
          targetWindowId,
        );
        queueEmailBrandingSave(targetWindowId);
        render();
        return;
      }
      const emailLogoFile = event.target.closest("[data-lead-email-logo-file]");
      if (emailLogoFile?.files?.[0]) {
        const file = emailLogoFile.files[0];
        const targetWindowId =
          emailLogoFile.getAttribute("data-email-window-target") ||
          emailLogoFile.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") ||
          activeEmailWindow()?.id ||
          "";
        const reader = new FileReader();
        reader.onload = async () => {
          const logoDataUrl = String(reader.result || "");
          const brandingPatch = { logoDataUrl };
          try {
            const palette = await extractEmailLogoPalette(logoDataUrl);
            if (palette?.primary) {
              brandingPatch.primaryColor = palette.primary;
              brandingPatch.secondaryColor =
                palette.secondary ||
                normalizeEmailBrandingInput(
                  emailComposeForWindow(targetWindowId)?.branding,
                )
                  .secondaryColor ||
                "#4a4a4a";
            }
          } catch (error) {
            // Keep the upload usable even if palette extraction fails.
          }
          updateEmailBranding(brandingPatch, targetWindowId);
          queueEmailBrandingSave(targetWindowId);
          render();
          emailLogoFile.value = "";
        };
        reader.readAsDataURL(file);
        return;
      }
      const inlineEmailImageFile = event.target.closest(
        "[data-lead-email-inline-image-file]",
      );
      if (inlineEmailImageFile?.files?.[0]) {
        const file = inlineEmailImageFile.files[0];
        const targetWindowId =
          inlineEmailImageFile.getAttribute("data-email-window-target") ||
          inlineEmailImageFile.closest("[data-email-window-id]")?.getAttribute("data-email-window-id") ||
          activeEmailWindow()?.id ||
          "";
        const reader = new FileReader();
        reader.onload = () => {
          insertInlineEmailImage(String(reader.result || ""), targetWindowId);
          inlineEmailImageFile.value = "";
        };
        reader.readAsDataURL(file);
        return;
      }
    });
    bodyEl.addEventListener("mousedown", (event) => {
      const resizeHandle = event.target.closest("[data-lead-email-resize-handle]");
      if (resizeHandle) {
        const windowId =
          resizeHandle.getAttribute("data-lead-email-resize-handle") || "";
        event.preventDefault();
        event.stopPropagation();
        beginEmailPointer(windowId, "resize", event);
        return;
      }
      const dragHandle = event.target.closest("[data-email-window-drag-handle]");
      if (!dragHandle) return;
      if (
        event.target.closest(
          ".lead-page-v5-email-head-actions,button,input,select,textarea,a",
        )
      ) {
        return;
      }
      const windowId =
        dragHandle.getAttribute("data-email-window-drag-handle") || "";
      event.preventDefault();
      beginEmailPointer(windowId, "move", event);
    });
    window.addEventListener("mousemove", handleEmailPointerMove);
    window.addEventListener("mouseup", handleEmailPointerUp);
    bodyEl.addEventListener("focusout", (event) => {
      const leadCoreRegion = event.target.closest("[data-autosave-lead-core], .lead-page-v5-title-row");
      if (leadCoreRegion) {
        clearTimeout(focusoutTimer);
        focusoutTimer = setTimeout(() => {
          if (!leadCoreRegion.contains(document.activeElement)) {
            saveLeadCoreFields();
          }
        }, 0);
        return;
      }
      const queueAutosave = (selector, callback) => {
        const region = event.target.closest(selector);
        if (!region) return false;
        clearTimeout(focusoutTimer);
        focusoutTimer = setTimeout(() => {
          if (!region.contains(document.activeElement)) callback();
        }, 0);
        return true;
      };
      if (queueAutosave("[data-autosave-lead-core]", saveLeadCoreFields))
        return;
      if (queueAutosave("[data-autosave-contact]", saveContact)) return;
      if (queueAutosave("[data-autosave-note]", saveNote)) return;
      if (queueAutosave("[data-autosave-followup]", saveFollowup)) return;
      const smsPhoneField = event.target.closest("[data-lead-sms-phone]");
      if (smsPhoneField) {
        clearTimeout(focusoutTimer);
        focusoutTimer = setTimeout(() => {
          if (!smsPhoneField.isConnected) return;
          if (smsPhoneField !== document.activeElement) render();
        }, 0);
        return;
      }
      const callNotesRegion = event.target.closest("[data-autosave-call-note]");
      if (callNotesRegion) {
        const dialEventId =
          callNotesRegion.getAttribute("data-autosave-call-note") || "";
        const callNotesField = callNotesRegion.querySelector("[data-lead-call-notes]");
        clearTimeout(focusoutTimer);
        focusoutTimer = setTimeout(() => {
          if (callNotesField) callNotesField.setAttribute("rows", "1");
          if (!callNotesRegion.contains(document.activeElement)) {
            saveCallAnnotation(dialEventId);
          }
        }, 0);
        return;
      }
      const contactNoteRegion = event.target.closest(
        "[data-autosave-contact-note]",
      );
      if (contactNoteRegion) {
        const contactId =
          contactNoteRegion.getAttribute("data-autosave-contact-note") || "";
        clearTimeout(focusoutTimer);
        focusoutTimer = setTimeout(() => {
          if (!contactNoteRegion.contains(document.activeElement))
            saveContactNote(contactId);
        }, 0);
      }
    });
    bindLeadAutoRefreshEvents();
    const controllerApi = {
      loadLead,
      reload,
      flushPendingChanges,
      markDialed() {
        return Promise.resolve();
      },
      getLead() {
        return currentLead;
      },
      buildDialerUrl,
      clear() {
        stopLeadAutoRefresh();
        currentLead = null;
        closeInlinePanels();
        clearTimeout(leadCoreSaveTimer);
        leadCoreSaveTimer = null;
        clearTimeout(emailBrandingSaveTimer);
        emailBrandingSaveTimer = null;
        clearTimeout(focusoutTimer);
        focusoutTimer = null;
        emailEditorSelection = null;
        setMockupMode(false);
        bodyEl.innerHTML = "";
        if (gmailPopupMessageHandler) {
          window.removeEventListener("message", gmailPopupMessageHandler);
          gmailPopupMessageHandler = null;
        }
        if (leadVisibilityHandler) {
          document.removeEventListener("visibilitychange", leadVisibilityHandler);
          leadVisibilityHandler = null;
        }
        if (leadFocusHandler) {
          window.removeEventListener("focus", leadFocusHandler);
          leadFocusHandler = null;
        }
        if (leadBackgroundSyncHandler) {
          window.removeEventListener(
            "firstmate-background-sync-complete",
            leadBackgroundSyncHandler,
          );
          leadBackgroundSyncHandler = null;
        }
        if (window.FirstMateLeadHistoryDebug) {
          delete window.FirstMateLeadHistoryDebug;
        }
        if (window.__leadHistoryDebug) {
          delete window.__leadHistoryDebug;
        }
      },
    };
    bodyEl.__leadViewerController = controllerApi;
    return controllerApi;
  }
  ensureStyles();
  window.LeadViewer = {
    ensureStyles,
    createController,
    buildDialerUrl,
    fmtTs,
    fmtDay,
  };
})();




