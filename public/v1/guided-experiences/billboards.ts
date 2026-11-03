import { env } from "../src/config/env.js";

/**
 * Website billboards shown inside an announcement (docs/architecture/guided-experiences.md, "Announcements"). The page
 * is marketing's: it is edited on the website with no code change here. The website is another origin, so the app
 * cannot reach into a plain frame of it; this serves a copy from the app's own address with one small script added,
 * which watches the named element and tells the app when it is pressed.
 *
 * That copy never runs with the app's authority: its Content-Security-Policy sandboxes it into an opaque origin even
 * when opened directly, so it has no cookies, storage or same-origin access. Only ids listed here are ever fetched.
 */

/** The element id of the action button on Ben's page ("Get Started"). This one line is all that changes if the page uses another id. */
export const EXTERIORS_POPUP_TRY_BUTTON_ID = "exteriors-popup-get-started";

type Billboard = { url: string; actionElementId: string; standIn: string };

const standIn = (title: string, buttonId: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center;font-family:Montserrat,'Segoe UI',Arial,sans-serif;color:#202124;background:linear-gradient(160deg,#fff0eb,#faf9f6)}
h1{font-size:clamp(28px,6vw,44px);margin:0;letter-spacing:-.03em}p{margin:0;max-width:44ch;color:#5b626c;line-height:1.5}button{border:0;border-radius:9px;padding:14px 26px;background:#d93025;color:#fff;font:700 15px inherit;cursor:pointer}small{color:#8b9199}</style></head>
<body><h1>${title}</h1><p>Order Full Exterior reports: walls, windows, doors, siding and more, along with the roof.</p><button type="button" id="${buttonId}">Try It Now</button><small>Stand-in page, shown on development until the real billboard is published.</small></body></html>`;

const BILLBOARDS: Record<string, Billboard> = {
  exteriors_popup: {
    url: "https://1m8.ai/billboards/exteriors_popup/",
    actionElementId: EXTERIORS_POPUP_TRY_BUTTON_ID,
    standIn: standIn("Exteriors are here", EXTERIORS_POPUP_TRY_BUTTON_ID)
  }
};

const TTL_MS = 60_000;
const MISSING_TTL_MS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;
export const BILLBOARD_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";

/** Added to the page: one delegated listener, so the page may redraw its button. A click reports; nothing else crosses. */
function bridge(id: string) {
  const name = JSON.stringify(id).replace(/</g, "\\u003c");
  return `<script>(function(){var id=${name};function send(m){m.fmBillboard=true;parent.postMessage(m,"*")}
document.addEventListener("click",function(e){var t=e.target;while(t&&t.id!==id)t=t.parentElement;if(!t)return;e.preventDefault();send({type:"action"})},true);
window.addEventListener("load",function(){send({type:"ready",button:!!document.getElementById(id)})})})();</script>`;
}

export function prepareBillboard(html: string, billboard: Pick<Billboard, "url" | "actionElementId">) {
  const added = `<base href="${billboard.url}">${bridge(billboard.actionElementId)}`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return added + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + added + html.slice(at);
}

type Cached = { at: number; ttl: number; html: string | null };
const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<string | null>>();

async function fetchPage(url: string) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5000), headers: { Accept: "text/html" } });
  if (!response.ok || !/text\/html/i.test(response.headers.get("content-type") || "")) return null;
  const html = await response.text();
  return html.length > MAX_BYTES ? null : html;
}

export function clearBillboardCache() { cache.clear(); pending.clear(); }

/** The page to serve, or null when it is not published: an announcement then waits rather than showing or being used up. */
export async function readBillboard(id: string): Promise<string | null> {
  const billboard = Object.prototype.hasOwnProperty.call(BILLBOARDS, id) ? BILLBOARDS[id]! : null;
  if (!billboard) return null;
  const held = cache.get(id);
  if (held && Date.now() - held.at < held.ttl) return held.html;
  const running = pending.get(id);
  if (running) return running;
  const reading = (async () => {
    try {
      const page = await fetchPage(billboard.url);
      const html = page ? prepareBillboard(page, billboard) : env.dataEnvironment === "development" ? prepareBillboard(billboard.standIn, billboard) : null;
      cache.set(id, { at: Date.now(), ttl: page ? TTL_MS : MISSING_TTL_MS, html });
      return html;
    } catch {
      // Unreachable is not the same as removed: keep showing the last good copy.
      cache.set(id, { at: Date.now(), ttl: MISSING_TTL_MS, html: held?.html ?? null });
      return held?.html ?? null;
    } finally {
      pending.delete(id);
    }
  })();
  pending.set(id, reading);
  return reading;
}
