/* public/libraries/dev-console/tracker-client.js
 *
 * The dev tray's link to Tracker (tracker.1m8.ai), straight from the page (docs/architecture/dev-console.md, "Quick
 * tray"). Tracker's web session is a SameSite=Lax cookie on its own origin and its API answers any origin without
 * credentials, so the portal cannot use that session: the tray signs in once per device (POST /auth/login with
 * { token: true }, Tracker's app sign-in) and sends the app token as a bearer. The token is kept in this browser's
 * localStorage on the development origin only; Sign out forgets it. Nothing passes through FirstMate's servers.
 */
export const TRACKER = 'https://tracker.1m8.ai';
export const DEFAULT_WORKSPACE = 'General platform work';
const STORE = 'fm-dev-tray-tracker';

export class TrackerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function read(storage) { try { return JSON.parse(storage?.getItem(STORE) || 'null'); } catch (_) { return null; } }
function write(storage, value) { try { value ? storage?.setItem(STORE, JSON.stringify(value)) : storage?.removeItem(STORE); } catch (_) {} }

/** { fetch, storage, base } are injectable for tests. */
export function trackerClient({ fetch: doFetch = (...a) => fetch(...a), storage = globalThis.localStorage, base = TRACKER } = {}) {
  let session = read(storage);
  async function call(method, path, { body, raw, type } = {}) {
    const headers = { Accept: 'application/json' };
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
    if (raw) headers['Content-Type'] = type || 'application/octet-stream';
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await doFetch(`${base}/api/v1${path}`, { method, headers, credentials: 'omit', cache: 'no-store', body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    } catch (_) { throw new TrackerError(0, 'Tracker could not be reached. Check the connection.'); }
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (response.status === 401 && path !== '/auth/login') { session = null; write(storage, null); }
    if (!response.ok) throw new TrackerError(response.status, String(data?.error || data?.message || `Tracker answered ${response.status}`));
    return data;
  }
  return {
    get signedIn() { return !!session?.token; },
    get user() { return session?.user || null; },
    async signIn(email, password, label = 'FirstMate dev tray') {
      const data = await call('POST', '/auth/login', { body: { email, password, token: true, label } });
      if (!data?.token) throw new TrackerError(500, 'Tracker did not return a sign-in token.');
      session = { token: data.token, user: { id: data.user?.id, name: data.user?.name || email, email: data.user?.email || email } };
      write(storage, session);
      return session.user;
    },
    async signOut() {
      try { if (session?.token) await call('POST', '/auth/logout', { body: {} }); } catch (_) {}
      session = null; write(storage, null);
    },
    /** Workspaces (projects of kind workspace), General platform work first. */
    async workspaces() {
      const list = (await call('GET', '/projects')) || [];
      return list.filter((p) => p && p.kind === 'workspace' && !p.archived_at)
        .sort((a, b) => (b.name === DEFAULT_WORKSPACE) - (a.name === DEFAULT_WORKSPACE) || String(a.name).localeCompare(String(b.name)));
    },
    /** open: not completed or canceled. done: closed ones updated in the last `days` days. */
    async issues(workspaceId, which = 'open', { days = 7, now = Date.now() } = {}) {
      const q = new URLSearchParams({ project: workspaceId });
      if (which === 'done') { q.set('status', 'closed'); q.set('updated_since', new Date(now - days * 864e5).toISOString()); }
      else q.set('status', 'open');
      return (await call('GET', `/issues?${q}`)) || [];
    },
    issue: (key) => call('GET', `/issues/${encodeURIComponent(key)}`),
    comments: (key) => call('GET', `/issues/${encodeURIComponent(key)}/comments`),
    /** Uploads one image; X-Filename is not allowed cross-origin, so Tracker names it from the type. */
    upload: (blob) => call('POST', '/uploads', { raw: blob, type: blob.type || 'image/jpeg' }),
    create: (input) => call('POST', '/issues', { body: input })
  };
}

/**
 * What Go sends. A short single line is the title; anything longer goes in the description untitled, and Tracker's
 * titler names it (as when a paragraph is pasted in Tracker). The screenshot and where it was filed from follow.
 */
export function composeIssue(text, { workspaceId, screenshotUrl = '', page = '', viewport = '', app = '' } = {}) {
  const body = String(text || '').trim();
  const short = body.length <= 120 && !/\n/.test(body);
  const context = [page && `Page: ${page}`, viewport && `Screen: ${viewport}`, app && `App: ${app}`].filter(Boolean).join(' · ');
  const parts = [short ? '' : body, screenshotUrl ? `![Screenshot](${screenshotUrl})` : '', context ? `_Filed from the dev tray. ${context}_` : ''].filter(Boolean);
  return { project: workspaceId, status: 'Ready', ...(short ? { title: body } : {}), description: parts.join('\n\n') };
}

/** Issues grouped by stage: started first, then unstarted, backlog, anything else; most recently changed first within one. */
export function groupIssues(issues) {
  const rank = { started: 0, unstarted: 1, backlog: 2 };
  const groups = new Map();
  const order = (a, b) => (rank[a.status?.category] ?? 3) - (rank[b.status?.category] ?? 3) || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  for (const issue of [...issues].sort(order)) {
    const name = issue.status?.name || 'No stage';
    if (!groups.has(name)) groups.set(name, { name, color: issue.status?.color || '', issues: [] });
    groups.get(name).issues.push(issue);
  }
  return [...groups.values()];
}
