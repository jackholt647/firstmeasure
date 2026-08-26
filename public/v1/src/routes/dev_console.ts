import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getFirstMeasureProjectIndexStatus, rebuildFirstMeasureProjectIndex } from "../../firstmeasure/project_index.js";
import { env } from "../config/env.js";

const DEV_CONSOLE_COOKIE_NAME = "fm_dev_console_session";
const DEV_CONSOLE_SESSION_TTL_SECONDS = 60 * 60 * 12;

type JsonBody = Record<string, unknown>;

export const devConsoleRoutes: FastifyPluginAsync = async (app) => {
  const username = env.devConsoleUsername.trim();
  const password = env.devConsolePassword;
  const sessionSecret = env.devConsoleSessionSecret;
  const basePath = normalizeConsolePath(env.devConsolePath);

  if (!username || !password || !sessionSecret) {
    app.log.info("Developer console routes are disabled because console credentials are not configured.");
    return;
  }

  app.get(basePath, async (request, reply) => {
    if (!isAuthenticatedConsoleRequest(request, username, sessionSecret)) {
      reply.type("text/html; charset=utf-8");
      return renderLoginPage(basePath);
    }

    const indexStatus = await getFirstMeasureProjectIndexStatus();
    reply.type("text/html; charset=utf-8");
    return renderConsolePage(basePath, indexStatus);
  });

  app.post(`${basePath}/login`, async (request, reply) => {
    const body = asRecord(request.body);
    const submittedUsername = String(body.username ?? "").trim();
    const submittedPassword = String(body.password ?? "");

    if (submittedUsername !== username || submittedPassword !== password) {
      reply.code(401);
      return { ok: false, error: "invalid_credentials" };
    }

    setConsoleSessionCookie(reply, createSessionToken(username, sessionSecret), basePath, request);
    return { ok: true };
  });

  app.post(`${basePath}/logout`, async (request, reply) => {
    clearConsoleSessionCookie(reply, basePath, request);
    return { ok: true };
  });

  app.get(`${basePath}/api/index-status`, async (request, reply) => {
    if (!isAuthenticatedConsoleRequest(request, username, sessionSecret)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }

    return {
      ok: true,
      firstmeasure: await getFirstMeasureProjectIndexStatus()
    };
  });

  app.post(`${basePath}/api/firstmeasure/reindex`, async (request, reply) => {
    if (!isAuthenticatedConsoleRequest(request, username, sessionSecret)) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }

    const result = await rebuildFirstMeasureProjectIndex();
    return { ok: true, result };
  });
};

function renderLoginPage(basePath: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Developer Console</title>
    <style>
      :root {
        --bg: #f3efe6;
        --panel: #fffaf0;
        --ink: #1b1e1f;
        --muted: #6b6f72;
        --accent: #165d4a;
        --accent-strong: #0e4738;
        --border: rgba(27, 30, 31, 0.12);
        --danger: #9b2c2c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(22, 93, 74, 0.14), transparent 34%),
          linear-gradient(135deg, #f6f1e8 0%, #efe7d8 100%);
        color: var(--ink);
        font: 16px/1.45 Georgia, "Times New Roman", serif;
      }
      .panel {
        width: min(440px, 100%);
        padding: 28px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: rgba(255, 250, 240, 0.95);
        box-shadow: 0 18px 50px rgba(27, 30, 31, 0.12);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 2rem;
        line-height: 1.05;
      }
      p {
        margin: 0 0 20px;
        color: var(--muted);
      }
      label {
        display: block;
        margin: 14px 0 6px;
        font-size: 0.95rem;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #fff;
        font: inherit;
      }
      button {
        width: 100%;
        margin-top: 18px;
        padding: 12px 16px;
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      button:hover { background: var(--accent-strong); }
      #error {
        min-height: 1.3em;
        margin-top: 14px;
        color: var(--danger);
      }
      code {
        padding: 0.1rem 0.35rem;
        border-radius: 999px;
        background: rgba(27, 30, 31, 0.06);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>Developer Console</h1>
      <p>Internal tools for maintenance and recovery. This console is intentionally not linked from the public API surface.</p>
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" />
      <button id="login">Log In</button>
      <div id="error"></div>
      <p>Console path: <code>${escapeHtml(basePath)}</code></p>
    </main>
    <script>
      const loginButton = document.getElementById("login");
      const usernameInput = document.getElementById("username");
      const passwordInput = document.getElementById("password");
      const errorNode = document.getElementById("error");

      async function submitLogin() {
        errorNode.textContent = "";
        loginButton.disabled = true;
        loginButton.textContent = "Logging In...";
        try {
          const response = await fetch(${JSON.stringify(`${basePath}/login`)}, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              username: usernameInput.value,
              password: passwordInput.value
            })
          });
          if (!response.ok) {
            errorNode.textContent = "Login failed.";
            return;
          }
          window.location.href = ${JSON.stringify(basePath)};
        } catch {
          errorNode.textContent = "Login failed.";
        } finally {
          loginButton.disabled = false;
          loginButton.textContent = "Log In";
        }
      }

      loginButton.addEventListener("click", submitLogin);
      passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitLogin();
      });
      usernameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitLogin();
      });
    </script>
  </body>
</html>`;
}

function renderConsolePage(basePath: string, indexStatus: Awaited<ReturnType<typeof getFirstMeasureProjectIndexStatus>>) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Developer Console</title>
    <style>
      :root {
        --bg: #f0eadc;
        --panel: rgba(255, 250, 240, 0.92);
        --ink: #1b1e1f;
        --muted: #62696d;
        --accent: #165d4a;
        --accent-strong: #0f4538;
        --accent-soft: rgba(22, 93, 74, 0.08);
        --border: rgba(27, 30, 31, 0.12);
        --warn: #8b4b11;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top right, rgba(22, 93, 74, 0.18), transparent 30%),
          radial-gradient(circle at bottom left, rgba(139, 75, 17, 0.10), transparent 28%),
          linear-gradient(180deg, #f4eee2 0%, #eee4d3 100%);
        font: 16px/1.5 Georgia, "Times New Roman", serif;
      }
      .shell {
        max-width: 1080px;
        margin: 0 auto;
        padding: 28px 20px 60px;
      }
      .hero {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-start;
        padding: 22px 24px;
        border-radius: 28px;
        background: linear-gradient(135deg, rgba(255,250,240,0.96), rgba(248,240,225,0.88));
        border: 1px solid var(--border);
        box-shadow: 0 20px 60px rgba(27, 30, 31, 0.10);
      }
      .hero h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.3rem);
        line-height: 0.96;
      }
      .hero p {
        margin: 10px 0 0;
        max-width: 52rem;
        color: var(--muted);
      }
      .hero-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .button, button {
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        font: inherit;
        cursor: pointer;
      }
      .button-primary {
        background: var(--accent);
        color: #fff;
      }
      .button-primary:hover { background: var(--accent-strong); }
      .button-secondary {
        background: rgba(27, 30, 31, 0.06);
        color: var(--ink);
      }
      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        margin-top: 22px;
      }
      .card {
        padding: 22px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--panel);
        box-shadow: 0 14px 44px rgba(27, 30, 31, 0.08);
      }
      .card h2 {
        margin: 0 0 10px;
        font-size: 1.3rem;
      }
      .card p {
        margin: 0 0 14px;
        color: var(--muted);
      }
      .stats {
        display: grid;
        gap: 10px;
        margin: 16px 0;
      }
      .stat {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.68);
        border: 1px solid rgba(27, 30, 31, 0.08);
      }
      .label {
        display: block;
        font-size: 0.82rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        display: block;
        margin-top: 3px;
        font-size: 1.05rem;
        word-break: break-word;
      }
      .status-note {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--accent-soft);
        color: var(--ink);
      }
      .warning {
        background: rgba(139, 75, 17, 0.10);
        color: var(--warn);
      }
      .placeholder {
        border-style: dashed;
      }
      code {
        padding: 0.12rem 0.4rem;
        border-radius: 999px;
        background: rgba(27, 30, 31, 0.06);
        font-size: 0.92em;
      }
      @media (max-width: 720px) {
        .hero { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <h1>Developer Console</h1>
          <p>Private maintenance surface for the shared v1 host. This is where recovery and internal operations can live without dropping into the terminal.</p>
        </div>
        <div class="hero-actions">
          <button class="button button-secondary" id="refreshStatus">Refresh</button>
          <button class="button button-secondary" id="logoutButton">Log Out</button>
        </div>
      </section>

      <section class="grid">
        <article class="card">
          <h2>FirstMeasure Index</h2>
          <p>The SQLite index powers list, search, and queue reads. If it ever drifts, you can rebuild it from here without touching the shell.</p>
          <div class="stats" id="indexStats">
            ${renderIndexStats(indexStatus)}
          </div>
          <div class="hero-actions">
            <button class="button button-primary" id="rebuildIndex">Rebuild Index</button>
          </div>
          <div class="status-note" id="actionStatus">No task running.</div>
        </article>

        <article class="card placeholder">
          <h2>More Tools</h2>
          <p>This panel is intentionally set up as a home for future internal actions: cache repair, diagnostics, queue maintenance, migrations, and other one-off recovery utilities.</p>
          <div class="status-note warning">Reserved for future developer actions.</div>
        </article>
      </section>
    </main>
    <script>
      const statsNode = document.getElementById("indexStats");
      const actionStatus = document.getElementById("actionStatus");
      const rebuildButton = document.getElementById("rebuildIndex");
      const refreshButton = document.getElementById("refreshStatus");
      const logoutButton = document.getElementById("logoutButton");

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function renderStats(status) {
        const rows = [
          ["DB Path", status.dbPath],
          ["Indexed Projects", status.indexedProjects],
          ["FTS Enabled", status.ftsEnabled ? "yes" : "no"],
          ["Schema Version", status.schemaVersion],
          ["Backfill Complete", status.backfillComplete ? "yes" : "no"],
          ["Last Rebuild Started", status.lastRebuildStartedAt || "never"],
          ["Last Rebuild Finished", status.lastRebuildFinishedAt || "never"],
          ["Last Rebuild Count", status.lastRebuildCount == null ? "n/a" : status.lastRebuildCount]
        ];
        statsNode.innerHTML = rows.map(([label, value]) => \`
          <div class="stat">
            <span class="label">\${escapeHtml(label)}</span>
            <span class="value">\${escapeHtml(value)}</span>
          </div>
        \`).join("");
      }

      async function fetchStatus() {
        const response = await fetch(${JSON.stringify(`${basePath}/api/index-status`)}, {
          credentials: "same-origin"
        });
        if (response.status === 401) {
          window.location.href = ${JSON.stringify(basePath)};
          return;
        }
        const payload = await response.json();
        if (!payload.ok) {
          throw new Error(payload.error || "Unable to load index status.");
        }
        renderStats(payload.firstmeasure);
      }

      refreshButton.addEventListener("click", async () => {
        actionStatus.textContent = "Refreshing status...";
        try {
          await fetchStatus();
          actionStatus.textContent = "Status refreshed.";
        } catch (error) {
          actionStatus.textContent = error instanceof Error ? error.message : "Refresh failed.";
        }
      });

      rebuildButton.addEventListener("click", async () => {
        if (!window.confirm("Rebuild the FirstMeasure index from disk now?")) {
          return;
        }
        rebuildButton.disabled = true;
        actionStatus.textContent = "Rebuilding index. This can take a while on large datasets...";
        try {
          const response = await fetch(${JSON.stringify(`${basePath}/api/firstmeasure/reindex`)}, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({})
          });
          if (response.status === 401) {
            window.location.href = ${JSON.stringify(basePath)};
            return;
          }
          const payload = await response.json();
          if (!payload.ok) {
            throw new Error(payload.error || "Rebuild failed.");
          }
          await fetchStatus();
          actionStatus.textContent = \`Rebuild complete. Indexed \${payload.result.indexedProjects} projects.\`;
        } catch (error) {
          actionStatus.textContent = error instanceof Error ? error.message : "Rebuild failed.";
        } finally {
          rebuildButton.disabled = false;
        }
      });

      logoutButton.addEventListener("click", async () => {
        await fetch(${JSON.stringify(`${basePath}/logout`)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({})
        });
        window.location.href = ${JSON.stringify(basePath)};
      });
    </script>
  </body>
</html>`;
}

function renderIndexStats(status: Awaited<ReturnType<typeof getFirstMeasureProjectIndexStatus>>) {
  const rows: Array<[string, string]> = [
    ["DB Path", status.dbPath],
    ["Indexed Projects", String(status.indexedProjects)],
    ["FTS Enabled", status.ftsEnabled ? "yes" : "no"],
    ["Schema Version", String(status.schemaVersion)],
    ["Backfill Complete", status.backfillComplete ? "yes" : "no"],
    ["Last Rebuild Started", status.lastRebuildStartedAt ?? "never"],
    ["Last Rebuild Finished", status.lastRebuildFinishedAt ?? "never"],
    ["Last Rebuild Count", status.lastRebuildCount == null ? "n/a" : String(status.lastRebuildCount)]
  ];

  return rows.map(([label, value]) => `
    <div class="stat">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value">${escapeHtml(value)}</span>
    </div>
  `).join("");
}

function isAuthenticatedConsoleRequest(request: FastifyRequest, expectedUsername: string, sessionSecret: string) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[DEV_CONSOLE_COOKIE_NAME];
  if (!token) {
    return false;
  }
  const payload = verifySessionToken(token, sessionSecret);
  return payload?.username === expectedUsername;
}

function createSessionToken(username: string, sessionSecret: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + DEV_CONSOLE_SESSION_TTL_SECONDS;
  const payload = base64UrlEncode(JSON.stringify({ username, expiresAt }));
  const signature = signValue(payload, sessionSecret);
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string, sessionSecret: string) {
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = signValue(payload, sessionSecret);

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { username?: unknown; expiresAt?: unknown };
    const expiresAt = Number(parsed.expiresAt ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    const username = String(parsed.username ?? "").trim();
    if (!username) {
      return null;
    }
    return { username, expiresAt };
  } catch {
    return null;
  }
}

function signValue(value: string, sessionSecret: string) {
  return createHmac("sha256", sessionSecret)
    .update(value)
    .digest("base64url");
}

function setConsoleSessionCookie(reply: FastifyReply, token: string, basePath: string, request: FastifyRequest) {
  reply.header("Set-Cookie", buildCookieHeader({
    name: DEV_CONSOLE_COOKIE_NAME,
    value: token,
    path: basePath,
    maxAge: DEV_CONSOLE_SESSION_TTL_SECONDS,
    secure: isSecureRequest(request)
  }));
}

function clearConsoleSessionCookie(reply: FastifyReply, basePath: string, request: FastifyRequest) {
  reply.header("Set-Cookie", buildCookieHeader({
    name: DEV_CONSOLE_COOKIE_NAME,
    value: "",
    path: basePath,
    maxAge: 0,
    secure: isSecureRequest(request)
  }));
}

function buildCookieHeader(input: { name: string; value: string; path: string; maxAge: number; secure: boolean }) {
  const parts = [
    `${input.name}=${input.value}`,
    `Path=${input.path}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${input.maxAge}`
  ];
  if (input.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function parseCookies(headerValue: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!headerValue) {
    return cookies;
  }

  for (const part of headerValue.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = valueParts.join("=");
  }

  return cookies;
}

function normalizeConsolePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/v1/_dev/console";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") && withLeadingSlash !== "/"
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function isSecureRequest(request: FastifyRequest) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").toLowerCase();
  return request.protocol === "https" || forwardedProto === "https";
}

function asRecord(value: unknown): JsonBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonBody
    : {};
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}
