import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.KEY_DELIVERY_BROWSER_PORT || 4181);
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const deliveryToken = "fmd_11111111111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dummyKey = "fmk_test_browserdummy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let consumed = false;
let revealCount = 0;
let deliveryNumber = 1;

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function harnessHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>API key admin harness</title></head>
<body>
  <div id="portalPluginViews"></div>
  <script>
    window.confirm = () => true;
    window.PORTAL_CFG = {
      user: { email: "admin@example.test", name: "Admin", role: "admin", is_admin: true },
      perms: { platform_admin: true },
      endpoints: { internal: "/v1/internal" }
    };
    window.Portal = {
      plugins: [],
      registerPlugin(plugin) { this.plugins.push(plugin); },
      escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
      }
    };
  </script>
  <script src="/measure/internal/portal_scripts/api_keys.js"></script>
  <script>
    const view = document.getElementById("view-api-keys");
    if (view) view.style.display = "block";
  </script>
</body></html>`;
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://browser.test");

  if (url.pathname === "/v1/public/firstmeasure/key-delivery/reveal" && request.method === "POST") {
    const body = await readJson(request);
    revealCount += 1;
    console.log(`reveal request ${revealCount}`);
    if (body.token !== deliveryToken || consumed) {
      return sendJson(response, consumed ? 410 : 404, {
        ok: false,
        error: "key_delivery_unavailable",
        message: "This API key delivery link is invalid, expired, or already used."
      });
    }
    consumed = true;
    return sendJson(response, 200, {
      ok: true,
      success: true,
      delivery: {
        key: dummyKey,
        key_id: "browserdummy",
        key_prefix: "fmk_test_browserdummy",
        key_name: "Browser test integration",
        mode: "test",
        key_expires_at: null,
        revealed_at: new Date().toISOString()
      }
    });
  }

  if (url.pathname === "/__api-key-harness") {
    const body = Buffer.from(harnessHtml());
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
    return response.end(body);
  }

  if (url.pathname === "/v1/internal/admin/firstmeasure-api-key-organizations") {
    return sendJson(response, 200, {
      ok: true,
      success: true,
      organizations: [{
        id: "org_browser",
        name: "Browser Roofing",
        status: "active",
        is_test: true,
        active_key_count: 1,
        total_key_count: 1,
        latest_key_at: new Date().toISOString()
      }],
      total: 1,
      pagination: { page: 1, total_pages: 1, total_count: 1 }
    });
  }

  if (url.pathname === "/v1/internal/admin/firstmeasure-api-keys" && request.method === "GET") {
    return sendJson(response, 200, {
      ok: true,
      success: true,
      keys: [{
        key_id: "browserdummy",
        org_id: "org_browser",
        name: "Browser test integration",
        key_prefix: "fmk_test_browserdummy",
        last4: "aaaa",
        mode: "test",
        status: "active",
        expired: false,
        expires_at: null,
        created_at: new Date().toISOString(),
        last_used_at: null,
        delivery_available: true
      }]
    });
  }

  if (url.pathname === "/v1/internal/admin/firstmeasure-api-keys" && request.method === "POST") {
    await readJson(request);
    deliveryNumber += 1;
    return sendJson(response, 201, {
      ok: true,
      success: true,
      key: dummyKey,
      record: { key_id: "generateddummy", delivery_available: true },
      delivery: {
        delivery_id: `delivery-${deliveryNumber}`,
        key_id: "generateddummy",
        key_name: "FirstMeasure API key",
        key_prefix: "fmk_test_generateddummy",
        mode: "test",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
        url: `https://app.1m8.ai/api-key-delivery/#fmd_22222222222222222222_${String(deliveryNumber).padStart(43, "b")}`
      }
    });
  }

  if (/^\/v1\/internal\/admin\/firstmeasure-api-keys\/[^/]+\/delivery-links$/.test(url.pathname) && request.method === "POST") {
    await readJson(request);
    deliveryNumber += 1;
    return sendJson(response, 201, {
      ok: true,
      success: true,
      delivery: {
        delivery_id: `delivery-${deliveryNumber}`,
        key_id: "browserdummy",
        key_name: "Browser test integration",
        key_prefix: "fmk_test_browserdummy",
        mode: "test",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
        url: `https://app.1m8.ai/api-key-delivery/#fmd_33333333333333333333_${String(deliveryNumber).padStart(43, "c")}`
      }
    });
  }

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot + path.sep)) return sendJson(response, 403, { ok: false });
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return sendJson(response, 404, { ok: false, error: "not_found" });
  const body = await readFile(target);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".ttf": "font/ttf"
  };
  response.writeHead(200, {
    "Content-Type": types[path.extname(target)] || "application/octet-stream",
    "Content-Length": body.length
  });
  response.end(body);
}).listen(port, "0.0.0.0", () => {
  console.log(`key delivery browser server ready on port ${port}`);
  console.log(`delivery token ${deliveryToken}`);
});

