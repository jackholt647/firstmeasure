(function () {
  "use strict";
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const enc = encodeURIComponent;
  async function request(org, path, body) {
    const session = String(
      window.__APP?.platformSessionCookieName || "fm_platform_session",
    );
    const csrf = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(session + "_csrf="));
    const response = await fetch(
      `/v1/integrations/organizations/${enc(org)}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(body !== undefined
            ? {
                "X-CSRF-Token": csrf
                  ? decodeURIComponent(csrf.slice(csrf.indexOf("=") + 1))
                  : "",
              }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message || "Could not complete this request.");
    return result;
  }
  function styles() {
    if (document.getElementById("fm-connections-style")) return;
    const style = document.createElement("style");
    style.id = "fm-connections-style";
    style.textContent = `
    .ic-root{--ic-line:#e4e7ec;color:#182230;font:14px/1.5 system-ui,sans-serif;width:100%;height:100%;min-height:0;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);max-width:none;margin:0}.ic-root *{box-sizing:border-box}.ic-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.ic-root h2{font-size:24px;letter-spacing:-.6px;margin:0}.ic-root h3{font-size:17px;margin:0 0 6px}.ic-muted{color:#667085}.ic-root p{margin:5px 0 14px}.ic-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ic-root button,.ic-credentials button{font:inherit;border:1px solid #d0d5dd;border-radius:9px;padding:9px 14px;background:white;color:#344054;cursor:pointer}.ic-root button:hover,.ic-credentials button:hover{background:#f8fafc}.ic-root button:disabled,.ic-credentials button:disabled{opacity:.55;cursor:wait}.ic-root .ic-primary,.ic-credentials .ic-primary{background:var(--primary,#175cd3);border-color:transparent;color:white}.ic-root button:focus-visible,.ic-root input:focus-visible,.ic-credentials input:focus-visible{outline:3px solid #84adff;outline-offset:2px}.ic-root input,.ic-root textarea,.ic-root select,.ic-credentials input{font:inherit;width:100%;padding:10px 12px;border:1px solid #d0d5dd;border-radius:8px;background:white;color:#182230}.ic-root textarea{min-height:160px;resize:vertical}.ic-root label,.ic-credentials label{display:grid;gap:5px;margin:12px 0}.ic-search{max-width:420px;margin-bottom:20px}.ic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.ic-card{border:1px solid var(--ic-line);border-radius:14px;padding:20px;background:white;text-align:left;box-shadow:0 2px 4px #10182804}.ic-grid button.ic-card{padding:20px;text-align:left}.ic-brand{display:flex;align-items:center;gap:12px;margin-bottom:14px}.ic-logo{height:44px;width:44px;border-radius:11px;background:#eef4ff;color:#3538cd;display:grid;place-items:center;font-size:20px;font-weight:700;object-fit:contain;padding:5px}.ic-badge{display:inline-block;border-radius:20px;padding:3px 9px;font-size:12px;background:#f2f4f7;color:#475467}.ic-badge.active{background:#ecfdf3;color:#027a48}.ic-badge.failed,.ic-error{background:#fef3f2;color:#b42318}.ic-status{padding:8px 0}.ic-status:empty{display:none}.ic-error{padding:12px;border-radius:8px}.ic-empty{padding:32px 20px;text-align:center;border:1px dashed #d0d5dd;border-radius:16px;background:#fafbfc}.ic-empty .ic-logo{margin:0 auto 16px;height:60px;width:60px;font-size:26px}.ic-tabs{display:flex;gap:5px;border-bottom:1px solid var(--ic-line);margin:24px 0 20px;overflow:auto}.ic-tabs button{border:0;border-radius:0;white-space:nowrap}.ic-tabs button[aria-selected=true]{color:var(--primary,#175cd3);border-bottom:2px solid var(--primary,#175cd3);font-weight:650}.ic-row{display:flex;justify-content:space-between;gap:15px;padding:15px 0;border-bottom:1px solid var(--ic-line)}.ic-row:last-child{border:0}.ic-row input[type=checkbox]{width:18px;height:18px}.ic-main{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px}.ic-workspace{grid-template-columns:minmax(300px,1fr) minmax(360px,46%)}.ic-chat{height:100%;min-height:0;position:relative;border-left:1px solid var(--ic-line);overflow:hidden;background:white}.ic-chat:empty{display:none}.ic-root details{margin:12px 0}.ic-root summary{cursor:pointer;color:#475467}.ic-root pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:350px;overflow:auto;background:#f8fafc;padding:14px;border-radius:8px}.ic-credentials{border:1px solid #d0d5dd;border-radius:12px;padding:18px;background:#fff;color:#182230;font:14px/1.5 system-ui;max-width:520px;margin:12px 0}.ic-credentials h3{margin:0 0 6px}.ic-credentials [role=status]{margin-top:10px}.ic-credentials .ic-destination{overflow-wrap:anywhere;color:#475467}.ic-library{margin-top:18px}.ic-root .ic-small{font-size:12px}.ic-upload{max-width:350px}
    .ic-root .ic-primary:hover,.ic-root .ic-primary:active,.ic-credentials .ic-primary:hover,.ic-credentials .ic-primary:active{background:var(--primary,#175cd3);color:white;filter:brightness(.9)}
    #tab_company_settings:has(#csPaneConnections.active),.cs-wrap:has(#csPaneConnections.active),.cs-layout:has(#csPaneConnections.active),.cs-main:has(#csPaneConnections.active){height:100%;min-height:0;overflow:hidden;box-sizing:border-box}
    .cs-main>.cs-card:has(#csPaneConnections.active){height:100%;min-height:0;overflow:hidden;padding:0}
    #csPaneConnections.active{height:100%;min-height:0}
    @media(max-width:900px){.ic-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.ic-workspace>.ic-main{max-height:35dvh;padding:12px}.ic-chat{border-left:0;border-top:1px solid var(--ic-line)}.ic-header{align-items:flex-start;flex-wrap:wrap}.ic-root h2{font-size:21px}.ic-row{flex-wrap:wrap}}

  `;
    document.head.append(style);
  }
  async function mountCredential(container, org, requestId) {
    styles();
    container.classList.add("ic-credentials");
    container.textContent = "Loading secure form…";
    try {
      const { request: r } = await request(
        org,
        `/credential-requests/${enc(requestId)}`,
      );
      container.innerHTML = `<h3>Connect ${esc(r.name)}</h3><p class="ic-destination">Credentials will be used for <strong>${esc(r.destination)}</strong>.</p><p>These values are stored securely and are never sent to the assistant.</p><form autocomplete="off">${r.fields.map((f) => `<label>${esc(f.label)}<input name="${esc(f.key)}" aria-label="${esc(f.label)}" type="${f.secret ? "password" : "text"}" ${f.required ? "required" : ""} maxlength="16000" autocomplete="off" spellcheck="false"></label>`).join("")}<button class="ic-primary" type="submit">Save credentials securely</button></form><div role="status" aria-live="polite"></div>`;
      container.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          button = form.querySelector("button"),
          status = container.querySelector("[role=status]");
        button.disabled = true;
        status.textContent = "Saving…";
        const values = Object.fromEntries(new FormData(form));
        try {
          await request(org, `/credential-requests/${enc(requestId)}`, {
            values,
          });
          form.reset();
          form.remove();
          status.textContent =
            "Credentials saved securely. You can ask the assistant to test the connection.";
          window.dispatchEvent(new CustomEvent("fm:connection-updated"));
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        } finally {
          for (const key of Object.keys(values)) values[key] = "";
        }
      };
    } catch (error) {
      container.textContent = error.message;
    }
  }
  async function mount(root, { orgId } = {}) {
    styles();
    root.classList.add("ic-root");
    root.dataset.settingsAutosave = "off";
    let items = [],
      current = null,
      tab = "overview",
      assistant = null,
      disposed = false;
    const status = (message, error = false) => {
      const el = root.querySelector("[data-status]");
      if (el) {
        el.textContent = message;
        el.classList.toggle("ic-error", error);
      }
    };
    const guarded = (fn) => async () => {
      try {
        await fn();
      } catch (error) {
        status(error.message, true);
      }
    };
    const logo = (c) =>
      c.logo && /^data:image\/(png|jpeg|webp);base64,/.test(c.logo)
        ? `<img class="ic-logo" src="${esc(c.logo)}" alt="">`
        : `<span class="ic-logo" aria-hidden="true">${esc(c.name.slice(0, 1).toUpperCase())}</span>`;
    function shell(withAssistant = false) {
      assistant?.destroy();
      assistant = null;
      root.classList.toggle("ic-workspace", withAssistant);
      root.innerHTML = `<div class="ic-main"><div data-main></div><div class="ic-status" data-status role="status" aria-live="polite"></div><div data-content></div></div>${withAssistant ? '<aside class="ic-chat" data-chat aria-label="Connection assistant"></aside>' : ""}`;
    }
    async function refresh() {
      const result = await request(orgId, "/connections");
      if (disposed) return;
      items = result.connections;
      current ? await detail(current.connection.id) : home();
    }
    function home() {
      current = null;
      shell();
      root.querySelector("[data-main]").innerHTML =
        `<header class="ic-header"><div><h2>Connections</h2><p class="ic-muted">Bring your tools, data, and workflows together.</p></div><button class="ic-primary" data-new>＋ New connection</button></header><input class="ic-search" data-search aria-label="Search connections" placeholder="Search your connections…">`;
      const content = root.querySelector("[data-content]");
      const cards = (query) => {
        const filtered = items.filter((c) =>
          c.name.toLowerCase().includes(query),
        );
        content.innerHTML = filtered.length
          ? `<div class="ic-grid">${filtered.map((c) => `<button class="ic-card" data-id="${esc(c.id)}"><div class="ic-brand">${logo(c)}<h3>${esc(c.name)}</h3></div><p class="ic-muted">${esc(c.description || "Connect data and automate your workflows.")}</p><span class="ic-badge ${c.enabled ? "active" : ""}">${c.enabled ? "Active" : c.activeVersion ? "Paused" : "Setup in progress"}</span></button>`).join("")}</div>`
          : `<div class="ic-empty"><span class="ic-logo">↗</span><h3>${items.length ? "No matches" : "Your tools, connected"}</h3><p class="ic-muted">${items.length ? "Try a different name." : "Tell the assistant what you want to connect. It will guide setup, collect credentials securely, and help build your workflows."}</p><button class="ic-primary" data-new>Set up a connection</button></div>`;
        content
          .querySelectorAll("[data-id]")
          .forEach((b) => (b.onclick = guarded(() => detail(b.dataset.id))));
        content.querySelector("[data-new]")?.addEventListener(
          "click",
          guarded(() => setup("setup")),
        );
      };
      cards("");
      root.querySelector("[data-search]").oninput = (e) =>
        cards(e.target.value.toLowerCase());
      root.querySelector("[data-main] [data-new]").onclick = guarded(() =>
        setup("setup"),
      );
    }
    async function setup(key, prompt = "") {
      shell(true);
      root.querySelector("[data-main]").innerHTML =
        `<header class="ic-header"><div><button data-back>← Connections</button><h2 style="margin-top:12px">${key === "setup" ? "Connect a tool" : "Connection assistant"}</h2><p class="ic-muted">Describe the service and what you want it to do.</p></div></header>`;
      root.querySelector("[data-content]").innerHTML =
        `<div class="ic-card"><h3>Start with what you need</h3><p class="ic-muted">An existing connector, setup guidance, or a custom API—we’ll find the right starting point.</p><p>API keys and passwords belong in the secure form the assistant opens, never in a message.</p></div><div class="ic-library"><label>Find a service<input data-library-search placeholder="CompanyCam, a supplier, or another API"></label><div data-library></div></div>`;
      root.querySelector("[data-back]").onclick = guarded(refresh);
      const library = root.querySelector("[data-library]");
      let searchGeneration = 0;
      const search = async (q) => {
        const n = ++searchGeneration,
          { entries } = await request(orgId, `/library?q=${enc(q)}`);
        if (n !== searchGeneration || !library.isConnected) return;
        library.innerHTML =
          entries
            .map(
              (e) =>
                `<button class="ic-card" style="display:block;width:100%;margin:10px 0" data-service="${esc(e.name)}"><strong>${esc(e.name)}</strong><br><span class="ic-muted ic-small">${e.connector ? "Connector available" : "Setup guidance available"}</span></button>`,
            )
            .join("") ||
          '<p class="ic-muted">No saved guide yet. The assistant can investigate this API.</p>';
        library
          .querySelectorAll("[data-service]")
          .forEach(
            (b) =>
              (b.onclick = () =>
                assistant?.setDraft(`Help me connect ${b.dataset.service}.`)),
          );
      };
      root.querySelector("[data-library-search]").oninput = (e) =>
        search(e.target.value).catch((error) => status(error.message, true));
      await search("");
      if (!window.PlatformAssistant?.mountSurface) {
        status(
          "The assistant is unavailable for this account. Check assistant access in settings.",
          true,
        );
        return;
      }
      const chat = root.querySelector("[data-chat]");
      assistant = window.PlatformAssistant.mountSurface(chat, {
        orgId,
        suggestions: [
          "Help me connect CompanyCam.",
          "Connect a custom API.",
          "Explain what my connections do.",
        ],
        welcome:
          "Connect a service, bring in its data, and automate work across your tools.",
        loadContext: async () => {
          const { thread } = await request(
            orgId,
            `/connections/${enc(key)}/conversation`,
            {},
          );
          return {
            main_thread: thread,
            threads: [thread],
            agents: [],
            dashboard: [],
          };
        },
      });
      await assistant.ready;
      if (prompt) assistant.setDraft(prompt);
    }
    async function detail(key) {
      const data = await request(orgId, `/connections/${enc(key)}`);
      if (disposed) return;
      current = data;
      shell();
      const c = data.connection;
      root.querySelector("[data-main]").innerHTML =
        `<button data-back>← All connections</button><header class="ic-header" style="margin-top:20px"><div class="ic-brand">${logo(c)}<div><h2>${esc(c.name)}</h2><span class="ic-badge ${c.enabled ? "active" : ""}">${c.enabled ? "Active" : c.activeVersion ? "Paused" : "Draft"}</span></div></div><div class="ic-actions"><button data-assistant>Ask assistant</button><button data-refresh>Refresh</button></div></header><p class="ic-muted">${esc(c.description || data.definition.description)}</p><nav class="ic-tabs" role="tablist">${["overview", "data", "automations", "access", "activity", "setup"].map((t) => `<button role="tab" aria-selected="${tab === t}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</nav>`;
      root.querySelector("[data-back]").onclick = () => {
        current = null;
        refresh().catch((e) => status(e.message, true));
      };
      root.querySelector("[data-assistant]").onclick = guarded(() =>
        setup(key),
      );
      root.querySelector("[data-refresh]").onclick = guarded(() => detail(key));
      root.querySelectorAll("[data-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            tab = b.dataset.tab;
            detail(key).catch((e) => status(e.message, true));
          }),
      );
      renderTab();
    }
    function renderTab() {
      const area = root.querySelector("[data-content]"),
        {
          connection: c,
          definition: d,
          automations,
          resources,
          runs,
          summary,
        } = current;
      const ask = (prompt) => setup(c.id, prompt);
      if (tab === "overview") {
        const uses = current.uses || automations;
        const valid =
          summary &&
          uses.every((a) => summary.versions?.[a.id] === a.revision) &&
          Object.keys(summary.versions || {}).length === uses.length;
        const groups = valid
          ? summary.groups
          : uses.map((a) => ({
              description: a.description || a.title,
              ruleIds: [a.id],
            }));
        area.innerHTML = `<div class="ic-card"><h3>What this connection does</h3>${
          groups.length
            ? groups
                .map(
                  (g) =>
                    `<details><summary>${esc(g.description)}</summary>${g.ruleIds
                      .map((id) => {
                        const a = uses.find((x) => x.id === id);
                        return a
                          ? `<p>${esc(a.title)} · ${a.enabled ? "Active" : "Paused"}<br><span class="ic-muted">${esc(a.events.join(", ") || "Scheduled")}</span></p>`
                          : "";
                      })
                      .join("")}</details>`,
                )
                .join("")
            : '<p class="ic-muted">No automations yet. Your published data and actions can also be used in documents, calculations, and Stats.</p>'
        }<button data-explain>Explain or add a workflow</button></div><div class="ic-grid" style="margin-top:18px"><div class="ic-card"><h3>${d.resources.length} data sources</h3><p class="ic-muted">Available through the shared data layer.</p></div><div class="ic-card"><h3>${c.enabledOperations.length} enabled operations</h3><p class="ic-muted">Access is checked on every request.</p></div></div>`;
        area.querySelector("[data-explain]").onclick = guarded(() =>
          ask(
            "Inspect this connection, explain where it is used, and update its grouped usage descriptions.",
          ),
        );
      } else if (tab === "data") {
        area.innerHTML = `<div class="ic-card"><h3>Published data</h3>${
          d.resources
            .map((r) => {
              const s = resources.find((x) => x.id === c.id + ":" + r.id),
                health = (current.health || []).find(
                  (x) => x.id === c.id + ":" + r.id,
                );
              return `<div class="ic-row"><div><strong>${esc(r.title)}</strong><p class="ic-muted">${esc(r.description)}</p><span class="ic-small">${r.mode === "live" ? "Fetched when requested" : s ? "Last complete sync: " + esc(new Date(s.observedAt).toLocaleString()) : "Waiting for first sync"}</span>${health ? `<p class="ic-error">${esc(health.message)} The last complete result remains available.</p>` : ""}</div>${r.mode === "sync" ? `<button data-sync="${esc(r.id)}" ${!c.enabled ? "disabled" : ""}>Sync now</button>` : ""}</div>`;
            })
            .join("") ||
          '<p class="ic-muted">Ask the assistant to publish a data source.</p>'
        }</div>`;
        area.querySelectorAll("[data-sync]").forEach(
          (b) =>
            (b.onclick = guarded(async () => {
              b.disabled = true;
              status("Synchronizing…");
              try {
                const response = await request(
                  orgId,
                  `/connections/${enc(c.id)}/sync`,
                  { resource: b.dataset.sync },
                );
                await detail(c.id);
                status(
                  response.result.ran
                    ? "Sync step completed. Larger imports continue in the background."
                    : "A sync is already running or waiting to retry. Your last complete result remains available.",
                );
              } finally {
                b.disabled = false;
              }
            })),
        );
      } else if (tab === "automations") {
        area.innerHTML = `<div class="ic-actions" style="margin-bottom:16px"><button class="ic-primary" data-add>Add automation with assistant</button></div><div class="ic-card">${automations.map((a) => `<div class="ic-row"><div><strong>${esc(a.title)}</strong><p class="ic-muted">${esc(a.description)}</p><span class="ic-badge ${a.enabled ? "active" : ""}">${a.enabled ? "Active" : "Paused"}</span><details><summary>View rule</summary><p>${esc(a.events.join(", ") || "Scheduled")}</p><pre>${esc(a.source)}</pre></details></div><button data-edit="${esc(a.id)}">Edit with assistant</button></div>`).join("") || '<p class="ic-muted">Use an event, a schedule, and a few instructions to connect your workflows.</p>'}</div>`;
        area.querySelector("[data-add]").onclick = guarded(() =>
          ask(
            "Help me create an automation using this connection. Ask what should trigger it and what it should do.",
          ),
        );
        area
          .querySelectorAll("[data-edit]")
          .forEach(
            (b) =>
              (b.onclick = guarded(() =>
                ask(`Help me review and edit automation ${b.dataset.edit}.`),
              )),
          );
      } else if (tab === "activity") {
        area.innerHTML = `<div class="ic-card"><h3>Recent runs</h3>${runs.map((r) => `<div class="ic-row"><div><strong>${esc(r.title || d.operations.find((o) => o.id === r.operation)?.title || r.kind)}</strong><p class="ic-muted">${esc(new Date(r.createdAt).toLocaleString())}</p>${r.message ? `<p>${esc(r.message)}</p>` : ""}</div><span class="ic-badge ${r.state === "succeeded" ? "active" : r.state === "running" ? "" : "failed"}">${esc(r.state)}</span></div>`).join("") || '<p class="ic-muted">No requests yet. Start with a read-only test.</p>'}</div>`;
      } else if (tab === "access") {
        area.innerHTML = `<div class="ic-card"><h3>Available operations</h3><p class="ic-muted">Choose what this connection can do. Write operations can change the external service.</p>${d.operations.map((o) => `<label class="ic-row" style="display:flex"><div><strong>${esc(o.title)}</strong><p class="ic-muted">${esc(o.description)}</p><span class="ic-badge">${o.effect === "read" ? "Read data" : "Change external data"}</span></div><input type="checkbox" data-operation="${esc(o.id)}" ${c.enabledOperations.includes(o.id) ? "checked" : ""}></label>`).join("")}<button class="ic-primary" data-enable>${c.activeVersion !== c.draftVersion ? "Activate reviewed draft" : "Save access & enable"}</button><p class="ic-small ic-muted">Owner and authorized company administrators manage this connection. Individual grants can be configured with the assistant.</p><button data-grants>Manage individual access with assistant</button></div>`;
        area.querySelector("[data-enable]").onclick = guarded(async () => {
          const operations = [
            ...area.querySelectorAll("[data-operation]:checked"),
          ].map((x) => x.dataset.operation);
          await request(orgId, `/connections/${enc(c.id)}/activate`, {
            expectedRevision: c.revision,
            operations,
            grants: c.grants,
          });
          await detail(c.id);
          status("Connection enabled with the selected operations.");
        });
        area.querySelector("[data-grants]").onclick = guarded(() =>
          ask(
            "Help me configure individual read and action grants for this connection.",
          ),
        );
      } else {
        area.innerHTML = `<div class="ic-card"><h3>Connection setup</h3><p class="ic-muted">${esc(new URL(d.baseUrl).origin)} · ${esc(d.auth.kind === "none" ? "No credentials required" : d.auth.kind + " authentication")}</p><div class="ic-actions">${(d.credentialFields || []).length > 0 ? "<button data-credentials>Enter or replace credentials</button>" : ""}${d.auth.kind === "oauth2" ? "<button data-oauth>Authorize account</button>" : ""}<button data-test>Test a read operation</button>${c.enabled ? "<button data-pause>Pause connection</button>" : ""}<button data-disconnect>Disconnect & remove credentials</button></div><div data-credential-host></div><div data-sample></div><label>Display name<input data-name value="${esc(c.name)}"></label><label>Logo<input class="ic-upload" type="file" data-logo accept="image/png,image/jpeg,image/webp"></label><button data-appearance>Save appearance</button><details><summary>Advanced connector definition</summary><p class="ic-muted">Saved as a new draft. Review before activation.</p><textarea data-definition aria-label="Connector definition" spellcheck="false">${esc(JSON.stringify(d, null, 2))}</textarea><button data-draft>Save draft</button></details></div>`;
        area.querySelector("[data-credentials]")?.addEventListener(
          "click",
          guarded(async () => {
            const result = await request(
              orgId,
              `/connections/${enc(c.id)}/credentials`,
              {},
            );
            await mountCredential(
              area.querySelector("[data-credential-host]"),
              orgId,
              result.request.id,
            );
          }),
        );
        area.querySelector("[data-test]").onclick = guarded(async () => {
          const op = d.operations.find((o) => o.effect === "read");
          if (!op)
            throw Error("Ask the assistant to add a read operation first.");
          status("Testing a read operation…");
          const sample = await request(
            orgId,
            `/connections/${enc(c.id)}/preview`,
            { operation: op.id, input: {} },
          );
          area.querySelector("[data-sample]").innerHTML =
            `<details open><summary>Read-only test response</summary><pre>${esc(JSON.stringify(sample.sample, null, 2))}</pre></details>`;
          status("Read-only test succeeded.");
        });
        area.querySelector("[data-oauth]")?.addEventListener(
          "click",
          guarded(async () => {
            const popup = window.open("about:blank", "_blank");
            if (popup) popup.opener = null;
            try {
              const result = await request(
                orgId,
                `/connections/${enc(c.id)}/oauth`,
                {},
              );
              if (popup) popup.location.href = result.url;
              else
                throw new Error(
                  "Allow pop-ups for this site, then authorize again.",
                );
            } catch (error) {
              popup?.close();
              throw error;
            }
          }),
        );
        area.querySelector("[data-pause]")?.addEventListener(
          "click",
          guarded(async () => {
            await request(orgId, `/connections/${enc(c.id)}/pause`, {
              expectedRevision: c.revision,
            });
            await detail(c.id);
          }),
        );
        area.querySelector("[data-disconnect]").onclick = guarded(async () => {
          if (
            !window.confirm(
              "Disconnect this account and remove stored credentials? Imported data and run history will be retained.",
            )
          )
            return;
          await request(orgId, `/connections/${enc(c.id)}/pause`, {
            expectedRevision: c.revision,
            disconnect: true,
          });
          await detail(c.id);
        });
        area.querySelector("[data-draft]").onclick = guarded(async () => {
          await request(orgId, "/connections", {
            id: c.id,
            expectedRevision: c.revision,
            definition: JSON.parse(
              area.querySelector("[data-definition]").value,
            ),
          });
          await detail(c.id);
          status("Draft saved. Review operations in Access before activating.");
        });
        area.querySelector("[data-appearance]").onclick = guarded(async () => {
          const file = area.querySelector("[data-logo]").files[0];
          let logo;
          if (file) {
            if (file.size > 1000000) throw Error("Choose an image under 1 MB.");
            logo = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
          }
          await request(orgId, `/connections/${enc(c.id)}/appearance`, {
            name: area.querySelector("[data-name]").value,
            logo,
            expectedRevision: c.revision,
          });
          await detail(c.id);
        });
      }
    }
    await refresh();
    return {
      destroy() {
        disposed = true;
        assistant?.destroy();
      },
      refresh,
    };
  }
  window.FirstMateConnections = { mount, mountCredential, request };
})();
