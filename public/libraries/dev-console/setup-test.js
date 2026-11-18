/*
 * The dev console's Setup tests (docs/architecture/dev-console.md, "Setup"): plays one setup step in this frame, as the
 * person on the page around it. The overlay (sections/setup.js) opens this page as ?step=<id>; it borrows the portal's
 * __APP and the exact library versions the portal loaded, starts the test on the server (which resolves the step, asked
 * even when it is answered, and notes the data as it is), plays it with the real setup player (its answer and events
 * are saved for real) and ends the test when it closes. It tells the overlay with postMessage
 * ({ type: 'fm-dc-setup-test', step, state: 'playing' | 'ended' | 'failed', outcome, message }).
 */
const params = new URLSearchParams(location.search);
const stepId = String(params.get('step') || '').trim();
const note = document.getElementById('note');
const say = (text, error = false) => { note.hidden = !text; note.textContent = text || ''; note.classList.toggle('err', error); };
const tell = (state, extra = {}) => { try { parent.postMessage({ type: 'fm-dc-setup-test', step: stepId, state, ...extra }, location.origin); } catch (_) {} };

function host() { try { return parent !== window && parent.location.origin === location.origin ? parent : null; } catch (_) { return null; } }
/** The portal's copy of a library (same ?v=), else the plain file. */
function source(path) {
  const found = [...(host()?.document.scripts || [])].find((script) => script.src && new URL(script.src).pathname.endsWith(path));
  return found ? found.src : path;
}
const load = (path) => new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = source(path); script.onload = resolve; script.onerror = () => reject(new Error(`${path} did not load.`));
  document.head.append(script);
});
function csrf() {
  const name = String(window.__APP?.platformSessionCookieName || 'fm_platform_session');
  const prefix = encodeURIComponent(name + '_csrf') + '=';
  const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}
async function post(path) {
  const response = await fetch(location.origin + path, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Platform-CSRF': csrf() }, body: '{}' });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw new Error(String(data?.message || data?.error || `Request failed (${response.status})`));
  return data;
}
const base = `/v1/signup-sandbox/development/console/setup/steps/${encodeURIComponent(stepId)}`;

async function run() {
  if (!stepId) throw new Error('No setup step named.');
  const app = host()?.__APP;
  if (!app?.userOrgId) throw new Error('Open this from the dev console on a portal page.');
  window.__APP = { ...app };
  for (const path of ['/libraries/platform-api/platform-api.js', '/libraries/platform-language/platform-language.js', '/libraries/guided-experiences/guided-experiences.js', '/libraries/guided-experiences/guided-setup.js']) await load(path);
  if (!window.FirstMateGuides?.test) throw new Error('This guided library cannot play a test yet.');
  const { experience } = await post(`${base}/test`);
  say('');
  tell('playing');
  let outcome = { status: 'failed' };
  try { outcome = await window.FirstMateGuides.test(experience); }
  finally { await post(`${base}/test/end`).catch(() => null); }
  say(outcome?.status === 'completed' ? 'Answered. Close this, or roll it back from the dev console.' : 'Closed.');
  tell('ended', { outcome: { status: String(outcome?.status || 'ended') } });
}
run().catch((error) => { say(error.message, true); tell('failed', { message: error.message }); });
