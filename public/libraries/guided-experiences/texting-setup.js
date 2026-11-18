// Texts and calls, set up the same way wherever a setup offers them (FM-515): the Communications setup (comms-setup.js)
// and the appointment setup (appointments-setup.js) both call setUpTexting. It turns texts and calls on
// (comms.setup.start { channel: phone }, a published action run as the person), then runs carrier registration (10DLC),
// the same workflow as Phone Settings (settings/sms-registration.js, simulated on development), full screen over the
// page while the setup steps aside, and reads where it stands once it closes. Nothing here draws a page of its own.
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const REGISTRATION_SRC = '/libraries/apps/settings/sms-registration.js?v=20261118-fm584b';
const WIZARD_SRC = '/libraries/setup-wizard/setup-wizard.js';

export function loadScript(src, win = window){
  return new Promise((resolve, reject) => { const doc = win.document, script = doc.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('load failed')); }; doc.head.append(script); });
}
// A full-screen workflow (carrier registration, domains) opens over the whole page: the portal's window when the setup
// plays in a project window.
export async function workflowWindow(sources, ready){
  const wins = [];
  try { if (window.top !== window && window.top.location.origin === location.origin) wins.push(window.top); } catch {}
  wins.push(window);
  for (const win of wins) {
    try {
      if (!win.FirstMateSetupWizard?.open) await loadScript(WIZARD_SRC, win);
      for (const src of sources) if (!ready(win)) await loadScript(src, win);
      if (win.FirstMateSetupWizard?.open && ready(win)) return win;
    } catch {}
  }
  throw new Error('This could not load. Close the setup and try again.');
}
export const registrationWindow = () => workflowWindow([REGISTRATION_SRC], (win) => !!win.FirstMateSmsRegistration?.open);

// The switches just turned on reach the page and the portal: capabilities, app flags and the session are read again,
// and the project Comms tab and the Communications page redraw their channels (Texts, Email).
export async function syncSessions(orgId){
  const wins = new Set([window]);
  try { if (window.top.location.origin === location.origin) wins.add(window.top); } catch {}
  await Promise.all([...wins].map(async (win) => {
    await Promise.all([win.PlatformAPI?.capabilities?.load?.(orgId, { refresh: true }), win.PlatformAPI?.appFlags?.load?.(orgId, { refresh: true })].map((p) => Promise.resolve(p).catch(() => null)));
    await Promise.resolve(win.Portal?.auth?.syncPlatformSession?.()).catch(() => null);
    win.dispatchEvent(new CustomEvent('fm:comms:setup-changed'));
  }));
}

/** A Communications setup action, run as the person in their organization. Starting a channel carries an idempotency key. */
export async function commsAction(orgId, action, input = {}){
  const key = action === 'comms.setup.start' ? `comms.setup.start:${orgId}:${input.channel}:${Date.now()}` : undefined;
  const result = await window.PlatformAPI.publication.invoke(orgId, action, { scope: 'organization', organizationId: orgId }, input, key ? { idempotencyKey: key } : {});
  return object(result.value ?? result.result ?? result);
}
/** Where carrier registration stands in a comms.setup.status answer: none, draft, submitted, approved or attention. */
export const registrationOf = (status) => clean(object(object(status).phone).registration) || 'none';
export const isRegistered = (status) => ['submitted', 'approved'].includes(registrationOf(status));
/** Texts are ready to send, or on their way: on, and the business registered (or under review). */
export const textingReady = (status) => !!object(object(status).done).phone && isRegistered(status);

/**
 * Sets up texts and calls: on (when they are not yet), then carrier registration (when it is not yet submitted) over
 * the page with `sheet` (the setup) hidden and inert meanwhile, then on again, which reads where registration stands
 * (on development it connects the shared test line once submitted). `onStatus(status)` follows every answer;
 * `onRegistering(true|false)` brackets the workflow. Returns the last status; throws what failed.
 */
export async function setUpTexting({ orgId, status = {}, sheet = null, alive = () => true, onStatus, onRegistering }){
  let current = status;
  const turnOn = async () => { current = await commsAction(orgId, 'comms.setup.start', { channel: 'phone' }); await onStatus?.(current); await syncSessions(orgId); };
  if (!object(current.done).phone) await turnOn();
  if (isRegistered(current) || !alive()) return current;
  onRegistering?.(true);
  try {
    const win = await registrationWindow();
    // The workflow is its own full-screen dialog: the setup steps aside while it is open, and comes back to finish.
    if (sheet) { sheet.style.visibility = 'hidden'; sheet.inert = true; }
    try { await win.FirstMateSmsRegistration.open({ orgId }); }
    finally { if (sheet) { sheet.style.visibility = ''; sheet.inert = false; } }
  } finally { onRegistering?.(false); }
  if (alive()) await turnOn();
  return current;
}
