(function () {
  "use strict";

  const API_PATH = "/v1/public/firstmeasure";
  const PRODUCTION_BASE = "https://app.1m8.ai" + API_PATH;
  const TERMINAL_STATUSES = new Set(["completed", "complete", "rejected", "failed", "cancelled", "canceled"]);
  const POLL_DELAYS = [0, 1000, 2000, 4000, 8000, 8000, 7000];

  const defaultOrder = () => ({
    external_id: "docs-sandbox-" + Date.now(),
    address: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
    project_type: "residential",
    report_mode: "full",
    report_expedite_option: "standard_3_6",
    lat: 37.422,
    lng: -122.0841,
    customer: {
      name: "Sandbox Customer",
      email: "sandbox@example.com"
    },
    metadata: {
      source: "documentation_explorer"
    },
    process_async: true
  });

  const presets = {
    root: { method: "GET", path: "/" },
    pricing: { method: "GET", path: "/pricing?project_type=residential&structure_count=1" },
    balance: { method: "GET", path: "/balance" },
    listReports: { method: "GET", path: "/reports?limit=10" },
    createReport: { method: "POST", path: "/reports", body: defaultOrder },
    getReport: { method: "GET", path: "/reports/:reportId" },
    downloadMainPdf: { method: "GET", path: "/reports/:reportId/pdf?slot=main", binary: true },
    downloadSummaryPdf: { method: "GET", path: "/reports/:reportId/pdf?slot=summary", binary: true },
    generatePdf: {
      method: "POST",
      path: "/reports/:reportId/pdf",
      body: () => ({ source: "saved", persist_files: true, update_status: false })
    },
    measurementsJson: { method: "GET", path: "/reports/:reportId/measurements?format=json" },
    measurementsRoofplan: { method: "GET", path: "/reports/:reportId/measurements?format=roofplan", binary: true },
    listFiles: { method: "GET", path: "/reports/:reportId/files" },
    downloadFile: { method: "GET", path: "/reports/:reportId/files/:fileName", binary: true },
    requestEcho: {
      method: "POST",
      path: "/webhooks/test",
      body: () => ({ event: "documentation_echo", sent_at: new Date().toISOString() })
    }
  };

  const docsIndex = [
    ["Overview", "API Library", "index.html", "FirstMeasure public API reports integration"],
    ["API Catalog", "Catalog", "apis/index.html", "Public API FirstMeasure"],
    ["Libraries", "SDK Catalog", "libraries/index.html", "HTTP curl JavaScript clients"],
    ["FirstMeasure API Reference", "FirstMeasure", "apis/firstmeasure/index.html", "reports PDFs measurements files billing"],
    ["Quickstart", "FirstMeasure", "apis/firstmeasure/index.html#quickstart", "curl JavaScript create report idempotency"],
    ["Sandbox mode", "FirstMeasure", "apis/firstmeasure/index.html#sandbox", "test key sandbox completed synthetic artifacts zero dollars"],
    ["Authentication", "FirstMeasure", "apis/firstmeasure/index.html#authentication", "Bearer test live key server side"],
    ["Billing and pricing", "FirstMeasure", "apis/firstmeasure/index.html#billing", "credits residential commercial expedite"],
    ["Create report schema", "FirstMeasure", "apis/firstmeasure/index.html#requests", "address project type report mode pins coordinates"],
    ["Idempotency", "FirstMeasure", "apis/firstmeasure/index.html#idempotency", "Idempotency-Key retry duplicate order"],
    ["Statuses", "FirstMeasure", "apis/firstmeasure/index.html#responses", "status completed rejected needs structure pins"],
    ["Errors", "FirstMeasure", "apis/firstmeasure/index.html#errors", "validation unauthorized insufficient credits"],
    ["Endpoints", "FirstMeasure", "apis/firstmeasure/index.html#endpoints", "pricing balance reports status pdf measurements files"],
    ["Sandbox API Explorer", "FirstMeasure", "apis/firstmeasure/index.html#tester", "interactive test key request"]
  ].map(([title, label, href, text]) => ({ title, label, href, text }));

  const state = {
    idempotencyKey: makeUuid(),
    reportId: "",
    fileName: "model-data.xml",
    bodyAtKeyCreation: "",
    pollToken: 0,
    timeline: []
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function makeUuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16);
      const value = character === "x" ? random : (random & 3) | 8;
      return value.toString(16);
    });
  }

  function apiUrl(path) {
    return new URL(API_PATH + path, location.origin);
  }

  function docsRootUrl() {
    const href = location.href.split("#")[0];
    const marker = "/documentation/";
    const index = href.toLowerCase().indexOf(marker);
    return index >= 0 ? href.slice(0, index + marker.length) : new URL(".", location.href).href;
  }

  function docsUrl(path) {
    return new URL(path, docsRootUrl()).href;
  }

  function setActiveNav() {
    const page = document.body.dataset.page || "";
    document.querySelectorAll("[data-nav]").forEach((link) => {
      link.classList.toggle("active", link.dataset.nav === page);
    });
  }

  function setupSearch() {
    const input = byId("docsSearch");
    const results = byId("searchResults");
    if (!input || !results) return;

    function close() {
      results.hidden = true;
      results.innerHTML = "";
    }

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      if (!query) return close();
      const matches = docsIndex
        .filter((entry) => (entry.title + " " + entry.label + " " + entry.text).toLowerCase().includes(query))
        .slice(0, 8);
      results.innerHTML = "";
      if (!matches.length) {
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = "No matching documentation";
        results.appendChild(empty);
      } else {
        matches.forEach((entry) => {
          const link = document.createElement("a");
          link.className = "search-result";
          link.href = docsUrl(entry.href);
          const title = document.createElement("strong");
          title.textContent = entry.title;
          const label = document.createElement("span");
          label.textContent = entry.label;
          link.append(title, label);
          results.appendChild(link);
        });
      }
      results.hidden = false;
    });

    document.addEventListener("click", (event) => {
      if (!results.contains(event.target) && event.target !== input) close();
    });
  }

  function setupMobileNav() {
    const sidebar = document.querySelector(".sidebar");
    const button = byId("mobileNavToggle");
    if (!sidebar || !button) return;
    button.addEventListener("click", () => {
      const open = sidebar.classList.toggle("mobile-open");
      button.setAttribute("aria-expanded", String(open));
    });
  }

  function validTestKey() {
    const key = (byId("apiKey")?.value || "").trim();
    if (!key) {
      showStatus("Enter a test API key to send a sandbox request.", "error");
      return "";
    }
    if (!key.startsWith("fmk_test_")) {
      showStatus("This explorer accepts test keys only. Live keys are refused before any network request is sent.", "error");
      return "";
    }
    return key;
  }

  function selectedPreset() {
    return presets[byId("endpointPreset")?.value] || presets.createReport;
  }

  function resolvedPath(template) {
    const reportId = (byId("reportIdField")?.value || state.reportId).trim();
    const fileName = (byId("fileNameField")?.value || state.fileName).trim();
    if (template.includes(":reportId") && !reportId) {
      throw new Error("Create a sandbox report or enter a report ID first.");
    }
    if (template.includes(":fileName") && !fileName) {
      throw new Error("Enter a file name first.");
    }
    return template
      .replace(":reportId", encodeURIComponent(reportId))
      .replace(":fileName", encodeURIComponent(fileName));
  }

  function parseBody() {
    const text = byId("requestBody")?.value.trim() || "";
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Request body is not valid JSON: " + error.message);
    }
  }

  function setBody(value) {
    const body = byId("requestBody");
    if (!body) return;
    body.value = value === undefined ? "" : JSON.stringify(value, null, 2);
    state.bodyAtKeyCreation = body.value;
  }

  function setIdempotencyKey(value) {
    state.idempotencyKey = value || makeUuid();
    const field = byId("idempotencyKeyField");
    if (field) field.value = state.idempotencyKey;
  }

  function setPreset() {
    const config = selectedPreset();
    const bodyField = byId("requestBody");
    const bodyContainer = byId("requestBodyField");
    const idempotencyContainer = byId("idempotencyField");
    const send = byId("sendRequest");
    const retry = byId("retryRequest");
    const method = byId("requestMethod");
    const path = byId("requestPath");

    if (method) method.textContent = config.method;
    if (path) path.textContent = API_PATH + config.path;
    if (bodyContainer) bodyContainer.hidden = config.method !== "POST";
    if (idempotencyContainer) idempotencyContainer.hidden = config !== presets.createReport;
    if (retry) retry.hidden = config !== presets.createReport;
    if (send) send.textContent = config === presets.createReport ? "Create sandbox report — $0" : (config.binary ? "Download artifact" : "Send request");

    if (config.body) setBody(config.body());
    else if (bodyField) {
      bodyField.value = "";
      state.bodyAtKeyCreation = "";
    }

    refreshRequestPath();
  }

  function refreshRequestPath() {
    const config = selectedPreset();
    const path = byId("requestPath");
    if (!path) return;
    try {
      path.textContent = API_PATH + resolvedPath(config.path);
    } catch (_) {
      path.textContent = API_PATH + config.path;
    }
  }

  function showStatus(message, kind) {
    const box = byId("explorerStatus");
    if (!box) return;
    box.textContent = message;
    box.className = "status-box" + (kind ? " " + kind : "");
  }

  function setProgress(step) {
    const steps = ["create", "status", "artifacts"];
    steps.forEach((name, index) => {
      const element = byId("progress-" + name);
      if (!element) return;
      element.classList.toggle("complete", index < step);
      element.classList.toggle("active", index === step);
    });
  }

  function showJson(value) {
    const output = byId("responseOutput");
    if (output) output.textContent = JSON.stringify(value, null, 2);
  }

  function addTimeline(method, path, status, duration, replay) {
    state.timeline.unshift({ method, path, status, duration, replay: Boolean(replay) });
    state.timeline = state.timeline.slice(0, 12);
    const list = byId("timelineEntries");
    if (!list) return;
    list.innerHTML = "";
    state.timeline.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "timeline-entry";
      const statusNode = document.createElement("span");
      statusNode.className = entry.status >= 200 && entry.status < 300 ? "ok" : "fail";
      statusNode.textContent = entry.method + " " + entry.status;
      const pathNode = document.createElement("span");
      pathNode.className = "path";
      pathNode.textContent = entry.path + (entry.replay ? " · replay" : "");
      const durationNode = document.createElement("span");
      durationNode.className = "duration";
      durationNode.textContent = entry.duration + "ms";
      row.append(statusNode, pathNode, durationNode);
      list.appendChild(row);
    });
  }

  function inferFileName(response, path) {
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    if (match) return match[1];
    const tail = path.split("?")[0].split("/").filter(Boolean).pop() || "download";
    return tail === "pdf" ? "firstmeasure-report.pdf" : tail;
  }

  async function downloadResponse(response, path) {
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = inferFileName(response, path);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return { downloaded: link.download, content_type: blob.type || "application/octet-stream", bytes: blob.size };
  }

  async function apiRequest(config, options) {
    const key = validTestKey();
    if (!key) throw new Error("A test API key is required.");
    const path = resolvedPath(config.path);
    const body = options?.body;
    const headers = {
      Authorization: "Bearer " + key,
      Accept: config.binary ? "*/*" : "application/json"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (config === presets.createReport) headers["Idempotency-Key"] = state.idempotencyKey;

    const started = performance.now();
    const response = await fetch(apiUrl(path), {
      method: config.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    const duration = Math.round(performance.now() - started);

    let payload;
    if (config.binary && response.ok) {
      payload = await downloadResponse(response, path);
    } else {
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (_) {
        payload = { raw: text };
      }
    }
    addTimeline(config.method, path, response.status, duration, payload?.idempotent_replay);
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.message || payload?.error || "Request failed with HTTP " + response.status);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function captureReport(payload) {
    const reportId = payload?.report?.report_id || payload?.report?.id || payload?.report_id || "";
    if (!reportId) return "";
    state.reportId = reportId;
    const field = byId("reportIdField");
    if (field) field.value = reportId;
    return reportId;
  }

  function reportStatus(payload) {
    return String(payload?.report?.status || payload?.project?.status || "").toLowerCase();
  }

  function artifactActionsEnabled(enabled) {
    document.querySelectorAll("[data-artifact-preset]").forEach((button) => {
      button.disabled = !enabled;
    });
  }

  async function pollReport(token) {
    const deadline = Date.now() + 30000;
    for (const delay of POLL_DELAYS) {
      if (token !== state.pollToken) return;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (Date.now() > deadline || token !== state.pollToken) break;

      showStatus("Checking sandbox report status…");
      const payload = await apiRequest(presets.getReport);
      showJson(payload);
      captureReport(payload);
      const status = reportStatus(payload);
      setProgress(1);

      if (TERMINAL_STATUSES.has(status)) {
        if (status === "completed" || status === "complete") {
          setProgress(2);
          artifactActionsEnabled(true);
          showStatus("Sandbox report completed. Synthetic artifacts are ready to inspect.", "success");
        } else {
          artifactActionsEnabled(false);
          showStatus("Sandbox report reached terminal status: " + status + ".", "error");
        }
        return;
      }
      showStatus("Sandbox report status: " + (status || "pending") + ". Polling for up to 30 seconds…");
    }
    showStatus("Polling stopped after 30 seconds. You can request report status again.", "error");
  }

  async function sendSelected(options) {
    const config = selectedPreset();
    const send = byId("sendRequest");
    const retry = byId("retryRequest");
    if (send) send.disabled = true;
    if (retry) retry.disabled = true;

    try {
      if (!validTestKey()) return;
      let body;
      if (config.method === "POST") body = parseBody();
      showStatus(config.binary ? "Preparing artifact download…" : "Sending sandbox request…");
      const payload = await apiRequest(config, { body });
      showJson(payload);
      captureReport(payload);

      if (config === presets.createReport) {
        setProgress(0);
        const replay = Boolean(payload?.idempotent_replay);
        showStatus(replay ? "Idempotent replay returned the existing sandbox report." : "Sandbox report created for $0. Checking status…", "success");
        state.pollToken += 1;
        await pollReport(state.pollToken);
      } else if (config.binary) {
        showStatus("Artifact downloaded without printing binary data into the page.", "success");
      } else {
        const status = reportStatus(payload);
        if (TERMINAL_STATUSES.has(status) && (status === "completed" || status === "complete")) {
          setProgress(2);
          artifactActionsEnabled(true);
        }
        showStatus("Request completed successfully.", "success");
      }
    } catch (error) {
      if (error.payload) showJson(error.payload);
      else showJson({ ok: false, error: error.message });
      showStatus(error.message, "error");
    } finally {
      if (send) send.disabled = false;
      if (retry) retry.disabled = false;
    }
  }

  function newSandboxRequest() {
    state.pollToken += 1;
    state.reportId = "";
    const reportId = byId("reportIdField");
    if (reportId) reportId.value = "";
    setIdempotencyKey(makeUuid());
    const select = byId("endpointPreset");
    if (select) select.value = "createReport";
    setBody(defaultOrder());
    setPreset();
    setProgress(0);
    artifactActionsEnabled(false);
    showJson({ ready: true, message: "Enter a test key, review the body, then create a sandbox report." });
    showStatus("Ready. No request will be sent until you click the create button.");
  }

  function setupExplorer() {
    const select = byId("endpointPreset");
    if (!select) return;

    const apiKey = byId("apiKey");
    const body = byId("requestBody");
    const reportId = byId("reportIdField");
    const fileName = byId("fileNameField");

    byId("productionBase").textContent = PRODUCTION_BASE;
    setIdempotencyKey(state.idempotencyKey);
    setBody(defaultOrder());
    setPreset();
    artifactActionsEnabled(false);

    select.addEventListener("change", () => {
      if (select.value === "createReport") setIdempotencyKey(makeUuid());
      setPreset();
    });
    byId("sendRequest").addEventListener("click", () => sendSelected({ retry: false }));
    byId("retryRequest").addEventListener("click", () => sendSelected({ retry: true }));
    byId("newSandboxRequest").addEventListener("click", newSandboxRequest);
    byId("toggleKey").addEventListener("click", () => {
      const hidden = apiKey.type === "password";
      apiKey.type = hidden ? "text" : "password";
      byId("toggleKey").textContent = hidden ? "Hide" : "Show";
    });

    body.addEventListener("input", () => {
      if (body.value !== state.bodyAtKeyCreation) {
        setIdempotencyKey(makeUuid());
        state.bodyAtKeyCreation = body.value;
      }
    });
    reportId.addEventListener("input", () => {
      state.reportId = reportId.value.trim();
      refreshRequestPath();
    });
    fileName.addEventListener("input", () => {
      state.fileName = fileName.value.trim();
      refreshRequestPath();
    });

    document.querySelectorAll("[data-artifact-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        select.value = button.dataset.artifactPreset;
        setPreset();
        sendSelected({ retry: false });
      });
    });

    window.addEventListener("pagehide", () => {
      apiKey.value = "";
      state.pollToken += 1;
    });
  }

  setActiveNav();
  setupSearch();
  setupMobileNav();
  setupExplorer();
})();
