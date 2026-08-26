<?php
/**
 * Read-only browser smoke test for sales/router.php.
 *
 * This page intentionally performs only GET requests. It never calls POST, PUT,
 * PATCH, or DELETE, so it can be handed to a sales-side app builder as a quick
 * confidence check without mutating production data.
 */
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
}

if (!isset($_SESSION['user_email'])) {
    header('Location: ../backend_login.php?redirect=' . urlencode($_SERVER['REQUEST_URI'] ?? 'sales/test.php'));
    exit;
}

$currentUserEmail = strtolower(trim((string)($_SESSION['user_email'] ?? '')));
$currentUserName = trim((string)($_SESSION['user_name'] ?? $currentUserEmail));
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sales Router Read-Only Test</title>
    <style>
        :root {
            --bg: #f6f7f9;
            --panel: #ffffff;
            --text: #202124;
            --muted: #65707f;
            --border: #d9dee7;
            --ok: #0b7a3b;
            --warn: #9a6500;
            --bad: #b3261e;
            --accent: #db0000;
            --code: #111827;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background: var(--bg);
            color: var(--text);
            font-family: "Segoe UI", Roboto, Arial, sans-serif;
        }
        header {
            padding: 18px 22px;
            background: var(--panel);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: center;
        }
        h1 {
            margin: 0;
            font-size: 20px;
            font-weight: 750;
            letter-spacing: 0;
        }
        .user {
            color: var(--muted);
            font-size: 13px;
            text-align: right;
        }
        main {
            max-width: 1180px;
            margin: 0 auto;
            padding: 22px;
        }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 16px;
        }
        button {
            border: 1px solid var(--accent);
            background: var(--accent);
            color: white;
            border-radius: 6px;
            padding: 10px 14px;
            font-weight: 700;
            cursor: pointer;
        }
        button:disabled {
            opacity: .55;
            cursor: not-allowed;
        }
        .summary {
            color: var(--muted);
            font-size: 14px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 12px;
        }
        .card {
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 8px;
            overflow: hidden;
        }
        .card-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            padding: 14px;
            border-bottom: 1px solid var(--border);
        }
        .name {
            font-weight: 750;
            font-size: 15px;
        }
        .url {
            margin-top: 4px;
            color: var(--muted);
            font-size: 12px;
            overflow-wrap: anywhere;
        }
        .badge {
            flex: 0 0 auto;
            min-width: 74px;
            text-align: center;
            border-radius: 999px;
            padding: 5px 8px;
            font-size: 12px;
            font-weight: 800;
            background: #eef1f5;
            color: var(--muted);
        }
        .badge.ok { background: #e8f5ee; color: var(--ok); }
        .badge.warn { background: #fff4db; color: var(--warn); }
        .badge.bad { background: #fdecea; color: var(--bad); }
        .body {
            padding: 12px 14px 14px;
        }
        .metric {
            color: var(--muted);
            font-size: 13px;
            margin-bottom: 8px;
        }
        pre {
            margin: 0;
            max-height: 260px;
            overflow: auto;
            padding: 12px;
            background: var(--code);
            color: #eef2ff;
            border-radius: 6px;
            font-size: 12px;
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        .note {
            margin: 16px 0 0;
            padding: 12px 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--panel);
            color: var(--muted);
            font-size: 13px;
        }
    </style>
</head>
<body>
<header>
    <h1>Sales Router Read-Only Test</h1>
    <div class="user">
        <div><?= htmlspecialchars($currentUserName !== '' ? $currentUserName : $currentUserEmail, ENT_QUOTES) ?></div>
        <div><?= htmlspecialchars($currentUserEmail, ENT_QUOTES) ?></div>
    </div>
</header>

<main>
    <div class="toolbar">
        <div class="summary" id="summary">Ready to run read-only endpoint checks.</div>
        <button id="runBtn" type="button">Run Tests</button>
    </div>

    <section class="grid" id="results"></section>

    <div class="note">
        This page only sends GET requests to <code>router.php</code>. It validates availability and sample reads without changing users, organizations, credits, leads, FirstMeasure data, or sales storage.
    </div>
</main>

<script>
(() => {
    const ROUTER = "router.php";
    const resultsEl = document.getElementById("results");
    const summaryEl = document.getElementById("summary");
    const runBtn = document.getElementById("runBtn");

    const state = {
        discoveredOrgId: "",
        checks: []
    };

    function endpoint(params) {
        return ROUTER + "?" + new URLSearchParams(params).toString();
    }

    function compact(value) {
        if (value == null) return value;
        if (Array.isArray(value)) return value.slice(0, 3);
        if (typeof value !== "object") return value;
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (Array.isArray(item)) out[key] = item.slice(0, 3);
            else if (item && typeof item === "object") out[key] = Object.keys(item).length > 12 ? Object.fromEntries(Object.entries(item).slice(0, 12)) : item;
            else out[key] = item;
        }
        return out;
    }

    function render() {
        resultsEl.innerHTML = "";
        let ok = 0;
        let warn = 0;
        let bad = 0;

        for (const check of state.checks) {
            if (check.status === "ok") ok++;
            else if (check.status === "warn") warn++;
            else if (check.status === "bad") bad++;

            const card = document.createElement("article");
            card.className = "card";

            const head = document.createElement("div");
            head.className = "card-head";

            const titleWrap = document.createElement("div");
            const title = document.createElement("div");
            title.className = "name";
            title.textContent = check.name;
            const url = document.createElement("div");
            url.className = "url";
            url.textContent = check.url || "";
            titleWrap.append(title, url);

            const badge = document.createElement("div");
            badge.className = "badge " + (check.status || "");
            badge.textContent = check.status ? check.status.toUpperCase() : "WAIT";
            head.append(titleWrap, badge);

            const body = document.createElement("div");
            body.className = "body";
            const metric = document.createElement("div");
            metric.className = "metric";
            metric.textContent = check.metric || check.message || "";
            const pre = document.createElement("pre");
            pre.textContent = JSON.stringify(compact(check.sample), null, 2);
            body.append(metric, pre);

            card.append(head, body);
            resultsEl.append(card);
        }

        summaryEl.textContent = `Checks: ${state.checks.length}. OK: ${ok}. Warnings: ${warn}. Failed: ${bad}.`;
    }

    function setCheck(name, patch) {
        const existing = state.checks.find(item => item.name === name);
        if (existing) Object.assign(existing, patch);
        else state.checks.push(Object.assign({ name, status: "", metric: "", sample: null }, patch));
        render();
    }

    async function getJson(name, params, validate) {
        const url = endpoint(params);
        setCheck(name, { url, status: "", metric: "Running..." });
        const started = performance.now();
        try {
            const response = await fetch(url, { method: "GET", credentials: "same-origin", headers: { "Accept": "application/json" } });
            const text = await response.text();
            let data = null;
            try {
                data = JSON.parse(text);
            } catch (err) {
                data = { raw: text.slice(0, 2000) };
            }
            const elapsed = Math.round(performance.now() - started);
            const verdict = validate ? validate(data, response) : { ok: response.ok && data && data.success !== false };
            setCheck(name, {
                status: verdict.ok ? "ok" : (verdict.warn ? "warn" : "bad"),
                metric: `${response.status} in ${elapsed} ms. ${verdict.message || ""}`.trim(),
                sample: data
            });
            return { response, data, verdict };
        } catch (error) {
            setCheck(name, {
                status: "bad",
                metric: error.message,
                sample: { error: error.message }
            });
            return { error };
        }
    }

    function countMessage(key) {
        return data => {
            const rows = data && Array.isArray(data[key]) ? data[key] : [];
            return {
                ok: !!(data && data.success && rows.length >= 0),
                message: `${rows.length} sample row(s) returned.`
            };
        };
    }

    async function runTests() {
        runBtn.disabled = true;
        state.checks = [];
        state.discoveredOrgId = "";
        render();

        await getJson("Router Meta", { resource: "meta" }, data => ({
            ok: !!(data && data.success && data.resources),
            message: data && data.version ? `Router version ${data.version}.` : ""
        }));

        await getJson("Users Read", { resource: "users", limit: "3", order_by: "email" }, countMessage("users"));

        const orgResult = await getJson("Organizations Read", { resource: "organizations", limit: "3", order_by: "name" }, data => {
            const orgs = data && Array.isArray(data.organizations) ? data.organizations : [];
            if (orgs[0] && orgs[0].id) state.discoveredOrgId = orgs[0].id;
            return {
                ok: !!(data && data.success),
                message: orgs[0] && orgs[0].id ? `Discovered org ${orgs[0].id}.` : `${orgs.length} sample org(s) returned.`
            };
        });

        await getJson("Lead Tables", { resource: "lead_tables" }, data => {
            const tableCount = data && data.tables ? Object.keys(data.tables).length : 0;
            return { ok: !!(data && data.success && tableCount > 0), message: `${tableCount} lead table(s) described.` };
        });

        await getJson("Leads Read", { resource: "leads", limit: "3", order_by: "updated_at", order_dir: "desc" }, countMessage("rows"));
        await getJson("Lead Lists Read", { resource: "lead_lists", limit: "3", order_by: "updated_at", order_dir: "desc" }, countMessage("rows"));
        await getJson("Lead Imports Read", { resource: "lead_import_runs", limit: "3", order_by: "created_at", order_dir: "desc" }, countMessage("rows"));

        if (state.discoveredOrgId) {
            await getJson("Organization Credits Read", { resource: "organization_credits", org_id: state.discoveredOrgId, limit: "3" }, data => ({
                ok: !!(data && data.success && Object.prototype.hasOwnProperty.call(data, "credits_balance")),
                message: data && data.success ? `Balance: ${data.credits_balance}.` : ""
            }));
        } else {
            setCheck("Organization Credits Read", {
                url: "",
                status: orgResult && orgResult.error ? "warn" : "warn",
                metric: "Skipped because no organization id was discovered.",
                sample: {}
            });
        }

        await getJson("Sales Storage Read", { resource: "storage", path: "" }, data => {
            const items = data && Array.isArray(data.items) ? data.items : [];
            return { ok: !!(data && data.success && data.type === "directory"), message: `${items.length} storage item(s) visible.` };
        });

        await getJson("FirstMeasure Ping", { resource: "firstmeasure", path: "ping" }, data => ({
            ok: !!(data && (data.ok || data.success || data.api === "firstmeasure")),
            message: data && data.api ? `${data.api} responded.` : ""
        }));

        runBtn.disabled = false;
    }

    runBtn.addEventListener("click", runTests);
    runTests();
})();
</script>
</body>
</html>
