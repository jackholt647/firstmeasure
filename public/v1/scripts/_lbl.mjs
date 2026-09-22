import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
await page.goto("http://127.0.0.1:8011/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async () => { await fetch("http://127.0.0.1:3101/v1/platform/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "web-builder-test-1@example.test", password: "WebBuilder!Test2026" }) }); });
await page.goto("http://127.0.0.1:8011/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
try { await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 30000 }); }
catch { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 }); }
await page.evaluate(() => { const c = Array.from(document.querySelectorAll("#tab_web_editor [data-site-card]")).find((x) => !/Customer Portal/.test(x.textContent)); c.querySelector("[data-site-open]").click(); });
await page.waitForSelector("#tab_web_editor [data-page-tile]", { timeout: 30000 });
await page.evaluate(() => { const t = Array.from(document.querySelectorAll("#tab_web_editor [data-page-tile]")); (t.find((x) => /Home/.test(x.textContent)) || t[0]).click(); });
await page.waitForSelector("#tab_web_editor [data-ch-rail]", { timeout: 30000 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("#tab_web_editor [data-ch-tab] span")).map((s) => ({ t: s.textContent.trim(), sw: s.scrollWidth, cw: s.clientWidth })))));
await browser.close();
