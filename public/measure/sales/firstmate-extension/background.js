const DEFAULT_SETTINGS = {
  endpointUrl: "http://127.0.0.1:8021/measure/sales/firstmate-bridge/action.php",
  emailTrackerUrl: "http://127.0.0.1:8021/measure/sales/firstmate-email-tracker/action.php",
  leadLookupUrl: "http://127.0.0.1:8021/measure/sales/firstmate-lead-lookup/action.php",
  leadLookupCode: "firstmate-sales-extension",
  sharedSecret: "",
  defaultSubject: "$7 Roof Report",
  defaultBody: [
    "https://app.1m8.ai/portal/login.php?start=register"
  ].join("\n"),
  templates: [
    {
      id: "gatekeeper",
      name: "Gatekeeper",
      subject: "$7 Roof Report",
      body: [
        "Hi {{firstName}},",
        "",
        "Could you point me to the person who handles roof measurement reports or estimating?",
        "",
        "FirstMate roof reports are $7 each. They can create an account here:",
        "https://app.1m8.ai/portal/login.php?start=register",
        "",
        "Best,"
      ].join("\n")
    },
    {
      id: "basic",
      name: "Basic",
      subject: "$7 Roof Report",
      body: "https://app.1m8.ai/portal/login.php?start=register"
    },
    {
      id: "cold-decision-maker",
      name: "Cold DM",
      subject: "$7 Roof Report",
      body: [
        "Hi {{firstName}},",
        "",
        "I wanted to send over FirstMate's $7 roof report option.",
        "",
        "You can create an account here:",
        "https://app.1m8.ai/portal/login.php?start=register",
        "",
        "Best,"
      ].join("\n")
    },
    {
      id: "warm-decision-maker",
      name: "Warm DM",
      subject: "$7 Roof Report",
      body: [
        "Hi {{firstName}},",
        "",
        "Great speaking with you. Here's the signup link for FirstMate's $7 roof reports:",
        "https://app.1m8.ai/portal/login.php?start=register",
        "",
        "Best,"
      ].join("\n")
    }
  ],
  sampleReports: [
    {
      id: "residential-sample",
      name: "Residential Sample",
      url: "https://app.1m8.ai/measure/sales/samples/residential-sample.pdf",
      filename: "residential-sample.pdf"
    },
    {
      id: "commercial-sample",
      name: "Commercial Sample",
      url: "https://app.1m8.ai/measure/sales/samples/commercial-sample.pdf",
      filename: "commercial-sample.pdf"
    },
    {
      id: "multifamily-sample",
      name: "Multifamily Sample",
      url: "https://app.1m8.ai/measure/sales/samples/multifamily-sample.pdf",
      filename: "multifamily-sample.pdf"
    }
  ]
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const localEndpointUpdates = {};
  [
    ["endpointUrl", DEFAULT_SETTINGS.endpointUrl, "https://app.1m8.ai/measure/sales/firstmate-bridge/action.php"],
    ["emailTrackerUrl", DEFAULT_SETTINGS.emailTrackerUrl, "https://app.1m8.ai/measure/sales/firstmate-email-tracker/action.php"],
    ["leadLookupUrl", DEFAULT_SETTINGS.leadLookupUrl, "https://app.1m8.ai/measure/sales/firstmate-lead-lookup/action.php"]
  ].forEach(([key, localUrl, liveUrl]) => {
    if (!stored[key] || stored[key] === liveUrl) {
      settings[key] = localUrl;
      localEndpointUpdates[key] = localUrl;
    }
  });
  if (Object.keys(localEndpointUpdates).length) {
    chrome.storage.sync.set(localEndpointUpdates);
  }
  const hasOldEdmondsSample = Array.isArray(settings.sampleReports)
    && settings.sampleReports.some((report) => report?.id === "edmonds-sample" || String(report?.url || "").includes("8515%20236th"));
  if (!Array.isArray(settings.sampleReports) || settings.sampleReports.length === 0) {
    settings.sampleReports = DEFAULT_SETTINGS.sampleReports;
  } else if (hasOldEdmondsSample) {
    settings.sampleReports = DEFAULT_SETTINGS.sampleReports;
    chrome.storage.sync.set({ sampleReports: settings.sampleReports });
  }
  const oldTemplateIds = new Set(["follow-up", "sample-report", "quick-check-in"]);
  const hasOldTemplates = Array.isArray(settings.templates)
    && settings.templates.some((template) => oldTemplateIds.has(template?.id));
  if (!Array.isArray(settings.templates) || settings.templates.length === 0 || hasOldTemplates) {
    settings.templates = DEFAULT_SETTINGS.templates;
    chrome.storage.sync.set({ templates: settings.templates });
  }
  const templateNameOverrides = {
    "gatekeeper": "Gatekeeper",
    "cold-decision-maker": "Cold DM",
    "warm-decision-maker": "Warm DM",
    "basic": "Basic"
  };
  let updatedTemplateNames = false;
  if (Array.isArray(settings.templates)) {
    const templateOrder = new Map(DEFAULT_SETTINGS.templates.map((template, index) => [template.id, index]));
    const beforeOrder = settings.templates.map((template) => template?.id || "").join("|");
    settings.templates = settings.templates.map((template) => {
      const name = templateNameOverrides[template?.id];
      if (!name || template.name === name) return template;
      updatedTemplateNames = true;
      return { ...template, name };
    }).sort((a, b) => (templateOrder.get(a?.id) ?? 999) - (templateOrder.get(b?.id) ?? 999));
    if (beforeOrder !== settings.templates.map((template) => template?.id || "").join("|")) {
      updatedTemplateNames = true;
    }
  }
  if (updatedTemplateNames) {
    chrome.storage.sync.set({ templates: settings.templates });
  }
  return settings;
}

async function postToBridge(payload) {
  const settings = await getSettings();
  if (!settings.endpointUrl) {
    return { ok: false, error: "Missing bridge endpoint URL" };
  }

  const response = await fetch(settings.endpointUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-FirstMate-Secret": settings.sharedSecret || ""
    },
    body: JSON.stringify({
      ...payload,
      extension_version: chrome.runtime.getManifest().version
    })
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, data };
  }
  return { ok: true, data };
}

async function postToEmailTracker(payload) {
  const settings = await getSettings();
  if (!settings.emailTrackerUrl) {
    return { ok: false, error: "Missing email tracker URL" };
  }

  const response = await fetch(settings.emailTrackerUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-FirstMate-Secret": settings.sharedSecret || ""
    },
    body: JSON.stringify({
      ...payload,
      extension_version: chrome.runtime.getManifest().version
    })
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, data };
  }
  return { ok: true, data };
}

async function fetchLeadDetail(leadId) {
  const settings = await getSettings();
  if (!settings.leadLookupUrl) {
    return { ok: false, error: "Missing lead lookup URL" };
  }
  const response = await fetch(settings.leadLookupUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-FirstMate-Code": settings.leadLookupCode || ""
    },
    body: JSON.stringify({ lead_id: leadId })
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, data };
  }
  return { ok: true, data };
}

async function findGmailTabs() {
  return chrome.tabs.query({ url: "https://mail.google.com/mail/*" });
}

async function sendToGmailTabs(command) {
  const tabs = await findGmailTabs();
  const results = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, command);
      results.push({ tabId: tab.id, ok: true, response });
    } catch (error) {
      results.push({ tabId: tab.id, ok: false, error: error.message });
    }
  }
  return results;
}

async function rememberEmailSent(event) {
  const leadId = String(event?.leadId || event?.lead?.id || event?.lead?.fmLeadId || "").trim();
  if (!leadId) return;
  const stored = await chrome.storage.local.get({ firstmateEmailSentByLead: {} });
  const byLead = stored.firstmateEmailSentByLead && typeof stored.firstmateEmailSentByLead === "object"
    ? stored.firstmateEmailSentByLead
    : {};
  byLead[leadId] = {
    ...event,
    leadId,
    storedAt: new Date().toISOString()
  };
  const entries = Object.entries(byLead)
    .sort(([, a], [, b]) => String(b?.storedAt || b?.sentAt || "").localeCompare(String(a?.storedAt || a?.sentAt || "")))
    .slice(0, 100);
  await chrome.storage.local.set({ firstmateEmailSentByLead: Object.fromEntries(entries) });
}

function firstEmailRecipient(event) {
  const recipients = event?.recipients && typeof event.recipients === "object" ? event.recipients : {};
  const to = Array.isArray(recipients.to) ? recipients.to : (Array.isArray(event?.to) ? event.to : []);
  const all = Array.isArray(recipients.all) ? recipients.all : [];
  return String(to[0] || all[0] || "").trim().toLowerCase();
}

async function saveSentRecipientAsPrimaryContact(event) {
  const email = firstEmailRecipient(event);
  const lead = event?.lead && typeof event.lead === "object" ? event.lead : {};
  const contact = event?.contact && typeof event.contact === "object" ? event.contact : {};
  const leadId = String(lead.crmId || lead.id || event?.leadId || "").trim();
  const contactId = String(event?.contactId || contact.id || lead.contactId || "").trim();
  const firstName = String(contact.firstName || lead.firstName || event?.greetingFirstName || "").trim();
  if (!leadId || !email) return null;
  return postToBridge({
    action: "save_primary_contact",
    contact: {
      leadId,
      fmLeadId: lead.fmLeadId || lead.id || event?.leadId || "",
      contactId,
      firstName,
      lastName: contact.lastName || lead.lastName || "",
      email
    }
  });
}

function recordBridgeEvent(payload) {
  postToBridge(payload).catch((error) => ({ ok: false, error: error.message }));
}

function recordEmailTrackerEvent(payload) {
  postToEmailTracker(payload).catch((error) => ({ ok: false, error: error.message }));
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name || "sample-report.pdf";
  } catch (error) {
    return "sample-report.pdf";
  }
}

async function fetchReportAsDataUrl(report) {
  if (!report?.url) {
    return { ok: false, error: "Missing report URL" };
  }

  const response = await fetch(report.url, { credentials: "include" });
  if (!response.ok) {
    return { ok: false, error: `Report fetch failed with ${response.status}` };
  }

  const blob = await response.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read report"));
    reader.readAsDataURL(blob);
  });

  return {
    ok: true,
    file: {
      name: report.filename || filenameFromUrl(report.url),
      type: blob.type || "application/pdf",
      dataUrl
    }
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "Invalid message" });
      return;
    }

    if (message.type === "FIRSTMATE_GET_SETTINGS") {
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }

    if (message.type === "FIRSTMATE_FETCH_REPORT") {
      sendResponse(await fetchReportAsDataUrl(message.report || {}));
      return;
    }

    if (message.type === "FIRSTMATE_FETCH_LEAD") {
      sendResponse(await fetchLeadDetail(message.leadId || message.lead_id || ""));
      return;
    }

    if (message.type === "FIRSTMATE_SAVE_PRIMARY_CONTACT") {
      const bridge = await postToBridge({
        action: "save_primary_contact",
        contact: message.payload || {}
      });
      sendResponse({
        ok: Boolean(bridge.ok && (bridge.data?.success || bridge.data?.ok)),
        contact: bridge.data?.contact || null,
        data: bridge.data || null,
        error: bridge.error || bridge.data?.error || ""
      });
      return;
    }

    if (message.type === "FIRSTMATE_ACTIVE_LEAD_CHANGED") {
      const command = {
        type: "FIRSTMATE_SET_ACTIVE_LEAD",
        requestId: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
        payload: message.payload || {}
      };
      const gmail = await sendToGmailTabs(command);
      sendResponse({ ok: true, gmail, command });
      return;
    }

    if (message.type === "FIRSTMATE_GET_GMAIL_STATUS") {
      const leadId = String(message.leadId || "").trim();
      const gmailTabs = await findGmailTabs();
      const stored = await chrome.storage.local.get({ firstmateEmailSentByLead: {} });
      const byLead = stored.firstmateEmailSentByLead && typeof stored.firstmateEmailSentByLead === "object"
        ? stored.firstmateEmailSentByLead
        : {};
      sendResponse({
        ok: true,
        gmailOpen: gmailTabs.length > 0,
        lastEmailSent: leadId ? (byLead[leadId] || null) : null
      });
      return;
    }

    if (message.type === "FIRSTMATE_SEND_EMAIL_REQUEST") {
      const settings = await getSettings();
      const selectedTemplate = message.payload?.template
        || settings.templates.find((template) => template.id === message.payload?.templateId)
        || null;
      const command = {
        type: "FIRSTMATE_COMPOSE_EMAIL",
        requestId: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
        payload: {
          to: message.payload?.to || "",
          subject: selectedTemplate?.subject || message.payload?.subject || settings.defaultSubject,
          body: selectedTemplate?.body || message.payload?.body || settings.defaultBody,
          templateId: selectedTemplate?.id || message.payload?.templateId || "",
          sourceUrl: sender.tab?.url || "",
          lead: message.payload?.lead || {}
        }
      };

      const gmail = await sendToGmailTabs(command);
      recordBridgeEvent({
        action: "send_email_requested",
        command
      });

      sendResponse({ ok: true, bridge: { ok: true, queued: true }, gmail, command });
      return;
    }

    if (message.type === "FIRSTMATE_GMAIL_EVENT") {
      recordBridgeEvent({
        action: "gmail_event",
        event: message.event || {},
        sourceUrl: sender.tab?.url || ""
      });
      sendResponse({ ok: true, bridge: { ok: true, queued: true } });
      return;
    }

    if (message.type === "FIRSTMATE_EMAIL_SENT") {
      const event = message.event || {};
      await rememberEmailSent(event);
      await saveSentRecipientAsPrimaryContact(event).catch(() => null);
      recordEmailTrackerEvent({
        action: "email_sent",
        event,
        sourceUrl: sender.tab?.url || ""
      });
      recordBridgeEvent({
        action: "email_sent",
        event,
        sourceUrl: sender.tab?.url || ""
      });
      sendResponse({ ok: true, tracker: { ok: true, queued: true } });
      return;
    }

    sendResponse({ ok: false, error: `Unhandled message type: ${message.type}` });
  })();
  return true;
});
