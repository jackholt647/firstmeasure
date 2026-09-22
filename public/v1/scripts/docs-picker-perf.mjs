import { chromium } from "playwright-core";

const WEB = "http://127.0.0.1:8011";
const API = "http://127.0.0.1:3101";
const suffix = `${Date.now().toString(36)}`;
const jar = new Map();
let csrf = "";
async function req(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
      ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const pair = raw.split(";")[0];
    jar.set(pair.split("=")[0], pair);
    if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
  }
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const orgId = `org_perf_${suffix}`;
const email = `perf-${suffix}@example.test`;
await req("POST", "/v1/platform/auth/register", { email, password: "correct horse battery staple", name: "Perf", company: "Perf Co", organization_id: orgId });
await req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "platform.documents": true, "platform.project_docs": true } });
console.log("seeding 80 projects…");
for (let i = 0; i < 80; i += 1) {
  await req("PUT", `/v1/platform/organizations/${orgId}/projects/project_perf_${suffix}_${i}`, {
    data: {
      id: `project_perf_${suffix}_${i}`, title: `Perf Project ${i}`, address: `${i} Perf Ave`, project_type: "residential",
      contacts: [{ id: "c", name: `Customer ${i}`, email: `c${i}@example.test`, primary: true }],
      photos: [], events: [], proposals: [],
      project_notes: "x".repeat(400)
    },
    metadata: { kind: "platform_project" }
  });
}

const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, org }) => {
  await fetch(api + "/v1/platform/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery staple", organization_id: org }) });
}, { api: API, email, org: orgId });
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 });
await page.waitForFunction(() => { try { return window.Portal.appFlags.value("platform", "documents", false) === true; } catch { return false; } }, null, { timeout: 30000 });
await page.waitForTimeout(1500);

// Long-task observer to catch main-thread seizures.
await page.evaluate(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((entries) => {
      entries.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)));
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
});

const t0 = Date.now();
await page.evaluate(() => window.dispatchEvent(new CustomEvent("fm:new-project-workflow", { detail: { workflow: "document", documentType: "proposal" } })));
await page.waitForSelector("#rOverlay [data-doc-picker] [data-doc-picker-project]", { timeout: 30000 });
const openMs = Date.now() - t0;

// Type into the search and measure responsiveness.
const t1 = Date.now();
await page.type("#rOverlay [data-doc-picker-search]", "Perf Project 7", { delay: 20 });
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll("#rOverlay [data-doc-picker-project]")];
  return rows.length && rows.every((r) => /Perf Project 7/.test(r.textContent));
}, null, { timeout: 10000 });
const searchMs = Date.now() - t1;

const rowCount = await page.$$eval("#rOverlay [data-doc-picker-project]", (els) => els.length);
const longTasks = await page.evaluate(() => window.__longTasks || []);
console.log(JSON.stringify({ openMs, searchMs, rowCount, longTasks }, null, 2));
const worst = Math.max(0, ...longTasks);
console.log(worst > 500 ? `FAIL worst long task ${worst}ms` : `PASS worst long task ${worst}ms`);
await browser.close();
process.exit(worst > 500 ? 1 : 0);
