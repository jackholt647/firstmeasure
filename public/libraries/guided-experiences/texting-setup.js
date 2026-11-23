// The business phone (texts and calls, one carrier registration), set up the same way wherever a setup offers it
// (FM-515): the Communications setup (comms-setup.js) and the appointment setup (appointments-setup.js) both call
// setUpTexting. It turns texts and calls on (comms.setup.start { channel: phone }, a published action run as the person),
// then runs carrier registration (10DLC), the same workflow as Phone Settings (settings/sms-registration.js, simulated on
// development), as more steps of the setup that asked (GP-138): drawn in its step, named in its title, with Back on the
// first one returning to the page it came from. It reads where registration stands once it is left. Nothing here draws a
// page of its own.
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const REGISTRATION_SRC = '/libraries/apps/settings/sms-registration.js?v=20261123-gp150';
const WIZARD_SRC = '/libraries/setup-wizard/setup-wizard.js?v=20261120-gp138';

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
// Registration is drawn in the setup's own step, so it loads in this window (a project window's too).
async function registrationHere(){
  if (!window.FirstMateSetupWizard?.open) await loadScript(WIZARD_SRC);
  if (!window.FirstMateSmsRegistration?.open) await loadScript(REGISTRATION_SRC);
  if (!window.FirstMateSetupWizard?.open || !window.FirstMateSmsRegistration?.open) throw new Error('This could not load. Close the setup and try again.');
}

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
 * Sets up texts and calls: on (when they are not yet), then carrier registration (when it is not yet submitted) drawn in
 * `host` (the setup's step) as more of its steps, then on again, which reads where registration stands (on development
 * it connects the shared test line once submitted). `setTitle(text)` names each registration step in the setup's title;
 * `onStep()` follows each step change (the setup's phone back history, scroll to the top). `onStatus(status)` follows
 * every answer; `onRegistering(handle | false)` brackets the registration, `handle.back()` stepping back through it
 * (from its first step out of it) and `handle.depth()` saying how many steps that is. Returns
 * `{ status, left }`: `left` is 'back' when the person went Back out of registration (nothing more was read), else how it
 * ended ('submitted', 'done', 'host', ...). Throws what failed.
 */
export async function setUpTexting({ orgId, status = {}, host = null, setTitle, onStep, alive = () => true, onStatus, onRegistering }){
  let current = status;
  const turnOn = async () => { current = await commsAction(orgId, 'comms.setup.start', { channel: 'phone' }); await onStatus?.(current); await syncSessions(orgId); };
  if (!object(current.done).phone) await turnOn();
  if (isRegistered(current) || !alive() || !host) return { status: current, left: '' };
  await registrationHere();
  if (!alive()) return { status: current, left: '' };
  let workflow = null, left = '';
  const handle = { back: () => workflow?.back?.() === true, depth: () => Math.max(0, Number(workflow?.depth?.()) || 0), close: () => workflow?.close?.({ reason: 'host', force: true }) };
  host.innerHTML = '<div class="gxs-module-loading" data-texting-loading><span class="gxs-spin" aria-hidden="true"></span></div>';
  onRegistering?.(handle);
  try {
    const ended = await window.FirstMateSmsRegistration.open({ orgId, container: host, setTitle, onStep,
      onOpen: (controller) => { workflow = controller; if (!alive()) { void controller?.close?.({ reason: 'host', force: true }); return; } host.querySelector('[data-texting-loading]')?.remove(); onStep?.(); } });
    left = clean(object(ended).reason);
  } finally { workflow = null; onRegistering?.(false); }
  if (left === 'back' || !alive()) return { status: current, left };
  await turnOn();
  return { status: current, left };
}
