import test from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {chromium} from 'playwright-core';

// FM-374: a new project window becomes a real project on its first write, whatever app writes. The project window has
// one hook for it (ensureProjectForWrite, handed to apps as host.ensureProject): it saves a draft on the server before
// the write runs. Photos taken in a blank new project used to stay local previews and were gone after a refresh.

const appSource = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = appSource.indexOf(`  async function ${name}(`) >= 0 ? appSource.indexOf(`  async function ${name}(`) : appSource.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  return appSource.slice(start, appSource.indexOf('\n  }', start) + 4);
}

function windowHarness(state = {}) {
  const calls = { drafts: 0, remote: [] };
  const context = {
    activeBaseProject: null, projectShellLoading: false, projectFormHydrating: 0, projectRecordPending: false,
    viewingExistingProject: false, pending: new Set(), ...state,
    ensureDraftBaseProject(options) {
      assert.equal(options?.allowEmpty, true, 'a write saves a project with no address too');
      calls.drafts++;
      context.activeBaseProject = { id: 'project_new' };
      context.pending.add('project_new');
      return context.activeBaseProject;
    },
    globalThis: {},
  };
  context.window = { Portal: { ProjectStore: {
    hasPendingSave: (project) => context.pending.has(project.id),
    saveRemote: async (project) => { calls.remote.push(project.id); context.pending.delete(project.id); return project; },
  } } };
  vm.createContext(context);
  vm.runInContext(functionSource('ensureProjectForWrite'), context);
  return { context, calls, ensure: () => vm.runInContext('ensureProjectForWrite()', context) };
}

test('the first write on a blank new project saves it on the server before the write runs', async () => {
  const { context, calls, ensure } = windowHarness();
  const project = await ensure();
  assert.equal(project.id, 'project_new');
  assert.equal(calls.drafts, 1);
  assert.deepEqual(calls.remote, ['project_new'], 'the draft is on the server when the write starts');
  // The next write reuses it and saves nothing again.
  assert.equal((await ensure()).id, 'project_new');
  assert.equal(calls.drafts, 1);
  assert.deepEqual(calls.remote, ['project_new']);
  assert.equal(context.activeBaseProject.id, 'project_new');
});

test('a draft whose first save is still queued is saved before the write; a saved project is left alone', async () => {
  const queued = windowHarness({ activeBaseProject: { id: 'project_contact' }, pending: new Set(['project_contact']) });
  assert.equal((await queued.ensure()).id, 'project_contact');
  assert.deepEqual(queued.calls.remote, ['project_contact']);
  assert.equal(queued.calls.drafts, 0);
  const saved = windowHarness({ activeBaseProject: { id: 'project_saved' }, viewingExistingProject: true });
  assert.equal((await saved.ensure()).id, 'project_saved');
  assert.deepEqual(saved.calls.remote, []);
});

test('a window for an existing project that has not loaded never starts a new draft (1M8-234)', async () => {
  for (const state of [{ viewingExistingProject: true }, { projectShellLoading: true }, { projectRecordPending: true }]) {
    const { calls, ensure } = windowHarness(state);
    await assert.rejects(ensure(), /still loading/);
    assert.equal(calls.drafts, 0);
  }
  // A routed shell is never saved over the project.
  const shell = windowHarness({ activeBaseProject: { id: 'project_routed', __projectShellLoading: true }, pending: new Set(['project_routed']) });
  assert.equal((await shell.ensure()).id, 'project_routed');
  assert.deepEqual(shell.calls.remote, []);
});

test('apps and trays reach the one hook; nothing writes through a draft that needs an address', () => {
  assert.match(appSource, /ensureProject: \(\) => ensureProjectForWrite\(\)/, 'tab apps (host.ensureProject)');
  assert.match(appSource, /ensureProject:\(\) => ensureProjectForWrite\(\)/, 'project trays');
  assert.match(appSource, /ensureActiveProject: \(\) => ensureProjectForWrite\(\)/, 'page code without a host');
  assert.match(functionSource('commitProjectNote'), /await ensureProjectForWrite\(\)/, 'the note composer');
  // Typing into the project's own fields is a write; the address only once it is chosen.
  const fieldEdit = vm.runInNewContext(`(${functionSource('isProjectFieldEdit').trim().replace(/^function isProjectFieldEdit/, 'function')})`, { projectText: (...values) => values.map((value) => String(value ?? '').trim()).find(Boolean) || '' });
  const input = (selector, value, type = 'text') => ({ type, value, checked: !!value, matches: (list) => list.split(',').map((entry) => entry.trim()).includes(selector) });
  assert.equal(fieldEdit(input('#rProjectTitleInput', 'Smith roof')), true);
  assert.equal(fieldEdit(input('#rContactList [data-field]', 'Ann')), true);
  assert.equal(fieldEdit(input('[data-fm-cf-input]', '', 'checkbox')), false);
  assert.equal(fieldEdit(input('#rContactList [data-field]', '  ')), false);
  assert.equal(fieldEdit(input('#rAddress', '12 Ma')), false);
});

test('upload paths in other tabs ask for the project instead of refusing an unsaved one', async () => {
  const read = (file) => readFile(new URL(`../../libraries/apps/${file}`, import.meta.url), 'utf8');
  const docs = await read('docs/project.js');
  assert.match(docs.slice(docs.indexOf('async function addFiles(')), /^[\s\S]{0,400}callHost\('ensureProject'\)/, 'Docs upload');
  const rail = await read('materials/rail-media.js');
  assert.match(rail.slice(rail.indexOf('async function uploadPhotos(')), /^[\s\S]{0,400}ensureProjectId\(\)/, 'Materials rail photos');
  assert.match(rail.slice(rail.indexOf('async function uploadDocuments(')), /^[\s\S]{0,200}ensureProjectId\(\)/, 'Materials rail documents');
});

test('a photo taken in a blank new project uploads to the project its first write saved', async () => {
  let executablePath;
  for (const file of [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()].filter(Boolean)) { try { await access(file); executablePath = file; break; } catch {} }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://localhost/');
    await page.setContent('<div id="rPhotoGallery"></div>');
    await page.evaluate(() => {
      window.project = null;
      window.uploads = [];
      window.ensureCalls = 0;
      window.Portal = { cfg: { orgId: 'org' }, PhotoFeed: { mountProjectGallery: () => {} } };
      window.projectOrgId = () => 'org';
      window.PlatformAPI = {
        media: { list: async () => ({ media: [] }) },
        projectMedia: {
          normalizePhotos: (photos) => photos,
          uploadMedia: async (orgId, projectId, project, file) => {
            window.uploads.push({ orgId, projectId, projectAtUpload: project?.id || '' });
            return { photo: { id: `m_${window.uploads.length}`, media_id: `m_${window.uploads.length}`, content_type: file.type } };
          },
        },
      };
    });
    await page.addScriptTag({ path: path.resolve('../libraries/apps/photos/project.js') });
    await page.evaluate(() => {
      const host = {
        getProject: () => window.project,
        getPhotos: () => window.project?.photos || window.localPhotos || [],
        setPhotos: (photos) => { if (window.project) window.project.photos = photos; else window.localPhotos = photos; },
        // The project window's first-write hook: saves the draft on the server, then hands it back.
        ensureProject: async () => {
          window.ensureCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          window.project ||= { id: 'project_draft', photos: window.localPhotos || [] };
          return window.project;
        },
      };
      window.Portal.ProjectPhotosTab.mount({ panelRoot: document.querySelector('#rPhotoGallery'), host });
    });
    const added = await page.evaluate(async () => {
      const file = new File([new Uint8Array([1, 2, 3])], 'shot.jpg', { type: 'image/jpeg' });
      const photos = await window.Portal.ProjectPhotosTab.invoke('addPhotoFiles', [[file], { rethrow: true }]);
      return photos.map((photo) => photo.media_id || '');
    });
    assert.deepEqual(added, ['m_1'], 'the photo was uploaded, not kept as a local preview');
    assert.deepEqual(await page.evaluate(() => window.uploads), [{ orgId: 'org', projectId: 'project_draft', projectAtUpload: 'project_draft' }]);
    assert.equal(await page.evaluate(() => window.ensureCalls), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
