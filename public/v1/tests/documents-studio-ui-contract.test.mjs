import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const documentStudio = await readFile(path.join(publicRoot, 'libraries/apps/documents/studio.js'), 'utf8');
const appManifest = await readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8');
const documentEditor = await readFile(path.join(publicRoot, 'libraries/doc-editor/firstmate-doc-editor.js'), 'utf8');
const documentEditorCss = await readFile(path.join(publicRoot, 'libraries/doc-editor/doc-editor.css'), 'utf8');
const documentWidgets = await readFile(path.join(publicRoot, 'libraries/doc-widgets/firstmate-doc-widgets.js'), 'utf8');
const visualEditor = await readFile(path.join(publicRoot, 'libraries/visual-editor/firstmate-visual-editor.js'), 'utf8');
const documentAgent = await readFile(path.join(publicRoot, 'libraries/doc-agent/doc-agent.js'), 'utf8');
const documentProject = await readFile(path.join(publicRoot, 'libraries/apps/documents/project.js'), 'utf8');
const documentRenderer = await readFile(path.join(publicRoot, 'libraries/doc-renderer/firstmate-doc-renderer.js'), 'utf8');
const documentApi = await readFile(path.join(publicRoot, 'v1/documents/api.ts'), 'utf8');
const documentService = await readFile(path.join(publicRoot, 'v1/documents/service.ts'), 'utf8');
const documentSchemas = await readFile(path.join(publicRoot, 'v1/documents/schemas.ts'), 'utf8');
const documentStorage = await readFile(path.join(publicRoot, 'v1/documents/storage.ts'), 'utf8');
const documentStyles = await readFile(path.join(publicRoot, 'libraries/apps/documents/documents.css'), 'utf8');
const webEditor = await readFile(path.join(publicRoot, 'libraries/apps/web-editor/app.js'), 'utf8');
const webEditorCss = await readFile(path.join(publicRoot, 'libraries/apps/web-editor/web-editor.css'), 'utf8');
const websiteService = await readFile(path.join(publicRoot, 'v1/websites/service.ts'), 'utf8');
const websiteSeeds = await readFile(path.join(publicRoot, 'v1/websites/seeds.ts'), 'utf8');
const platformUi = await readFile(path.join(publicRoot, 'libraries/platform-ui/platform-ui.js'), 'utf8');
const portalShell = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
const portalTopbar = await readFile(path.join(publicRoot, 'portal/scripts/topbar.js'), 'utf8');
const require = createRequire(import.meta.url);
const FMDocModel = require(path.join(publicRoot, 'libraries/doc-model/firstmate-doc-model.js'));
const FMDocEditor = require(path.join(publicRoot, 'libraries/doc-editor/firstmate-doc-editor.js'));
const FMDocWidgets = require(path.join(publicRoot, 'libraries/doc-widgets/firstmate-doc-widgets.js'));

test('Doc Studio opens folder items in the editor mode matching their document type', () => {
  assert.match(documentStudio, /const isVisualDocument = cleanText\(state\.folderItem\?\.item_type\) === 'visual_document'/);
  assert.match(documentStudio, /mode: isVisualDocument \? 'visual' : 'doc'/);
});

test('Doc Studio never publishes a missing or stale folder snapshot', () => {
  assert.match(documentStudio, /function completeFolderResponse\(response\)[\s\S]*?declaredCount !== folders\.length[\s\S]*?Marketing is missing/);
  assert.match(documentStudio, /async function loadCompleteFolderList\(\)[\s\S]*?attempt < 3[\s\S]*?completeFolderResponse\(await api\(\)\.folders\.list\(orgId\(\)\)\)/);
  assert.match(documentStudio, /const loadToken = \+\+state\.listLoadToken[\s\S]*?if \(loadToken !== state\.listLoadToken \|\| state\.destroyed\) return;[\s\S]*?state\.folders = folders/);
  assert.match(documentStudio, /catch \(error\) \{[\s\S]*?scheduleListRetry\(\);[\s\S]*?finally/);
  assert.doesNotMatch(documentStudio, /folders\.list\(orgId\(\)\)\.catch\(\(\) => \(\{ folders: \[\] \}\)\)/);
});

test('Doc Studio opens document templates in Doc mode', () => {
  assert.match(documentStudio, /function mountTemplateCanvas\(\)[\s\S]*?profile: capabilityEnabled\('documents\.designer_profile'\) \? 'designer' : 'document',[\s\S]*?mode: 'doc'/);
  assert.match(documentStudio, /allowedModes: capabilityEnabled\('documents\.designer_profile'\) \? \['doc', 'visual', 'preview'\] : \['doc', 'preview'\]/);
});

test('Doc Studio persists and restores an open document through portal navigation', () => {
  assert.match(appManifest, /id: 'documents\.studio'[\s\S]*?studioSection: \{ default:'templates'[\s\S]*?studioFolder: \{ history:'push' \}[\s\S]*?studioDocument: \{ history:'push' \}/);
  assert.match(documentStudio, /writeStudioRoute\(state\.tab, \{ studioSection:'folder', studioFolder:folderId, studioDocument:itemId \}/);
  assert.match(documentStudio, /backOrClose\?\.\([\s\S]*?\['studioDocument'\][\s\S]*?studioDocument:null/);
  assert.match(documentStudio, /registerHandler\?\.\(`documents-studio:[\s\S]*?immediate: true[\s\S]*?apply: applyStudioRoute/);
  assert.match(documentStudio, /async function applyStudioRoute\(route\)[\s\S]*?route\?\.studioDocument[\s\S]*?openFolderItemEditor\([\s\S]*?fromRoute:true/);
  assert.match(documentStudio, /const existing = root\.querySelector\('\[data-studio-item-screen\]'\)[\s\S]*?syncFolderItemHeader\(item, meta\)[\s\S]*?return/);
});

test('Doc Studio injects its document identity into the optional platform topbar', () => {
  assert.match(portalShell, /id="platformTopbarAppLeft" data-platform-topbar-left/);
  assert.match(portalTopbar, /window\.Portal\.topbar = \{[\s\S]*?isVisible: isTopbarVisible[\s\S]*?mountLeft: mountTopbarLeft[\s\S]*?releaseLeft: releaseTopbarLeft/);
  assert.match(portalTopbar, /fm:platform-topbar-visibility/);
  assert.match(documentStudio, /function syncFolderItemHeaderHost\(\)[\s\S]*?topbar\.mountLeft\?\.\(folderItemTopbarOwner, header\)[\s\S]*?screen\.insertBefore\(header, main\)/);
  assert.match(documentStyles, /platform-topbar-app-left \.fmdx-editor-top/);
});

test('document titles size to their text while type and save status follow', () => {
  assert.match(documentStudio, /function sizeFolderItemTitle\(input\)[\s\S]*?measureText[\s\S]*?input\.style\.width/);
  assert.match(documentStudio, /titleInput\?\.addEventListener\('input'[\s\S]*?sizeFolderItemTitle\(event\.target\)/);
  assert.match(documentStyles, /fmdx-doc-title-input[^{]*\{[^}]*width:auto[^}]*field-sizing:content/);
});

test('blank documents start as a Letter word-processing surface', () => {
  const doc = FMDocModel.createBlankDocument({ metadata: { document_type: 'generic' } });
  assert.equal(doc.settings.paper.size, 'letter');
  assert.equal(doc.chains.body.auto_pages, true);
  assert.deepEqual(doc.chains.body.page_defaults.margins_pt, { top: 72, right: 72, bottom: 72, left: 72 });
  assert.deepEqual(doc.pages[0].children.map((node) => node.props.page_region), ['header', 'body', 'footer']);
  const body = doc.pages[0].children[1];
  assert.equal(body.props.chain.id, 'body');
  assert.equal(body.children[0].type, 'text');
  assert.equal(body.children[0].props.blocks[0].runs[0].text, '');
  assert.match(documentService, /FMDocModel\.createBlankDocument \|\| FMDocModel\.createDocument/);
  assert.match(documentStudio, /window\.FMDocModel\.createBlankDocument \|\| window\.FMDocModel\.createDocument/);
});

test('Doc bodies stay atomic in Visual and are restored before Doc mode opens', () => {
  assert.match(documentEditor, /function isDocumentBodyFrame\(node\)[\s\S]*?node\.props\.page_region[\s\S]*?node\.props\.chain/);
  assert.match(documentEditor, /function promoteSelection\(nodeId\)[\s\S]*?isDocumentBodyFrame\(info\.node\)[\s\S]*?return info\.node\.id/);
  assert.match(documentEditor, /function setSelection\(ids, options\)[\s\S]*?state\.mode === "visual"[\s\S]*?isDocumentBodyFrame\(ancestor\.node\)[\s\S]*?selectionId = ancestorId/);
  assert.match(documentEditor, /if \(isDocumentBodyFrame\(hit\.node\)\) \{[\s\S]*?setSelection\(\[hit\.id\]\);[\s\S]*?return;/);
  assert.match(documentEditor, /function ensureDocumentBodyFrame\(\)[\s\S]*?pages\.some[\s\S]*?createDocRegionFrame[\s\S]*?id: "body"[\s\S]*?type: "node\.insert"/);
  assert.match(documentEditor, /state\.mode = mode;\s*if \(mode === "doc"\) ensureDocumentBodyFrame\(\);/);
  assert.match(documentEditor, /setDocument: function \(doc, setOptions\)[\s\S]*?rebuildNodeIndex\(\);\s*if \(state\.mode === "doc"\) ensureDocumentBodyFrame\(\);/);
  assert.match(documentEditor, /buildChrome\(\);\s*rebuildNodeIndex\(\);\s*applyProfile\(requestedProfile\);\s*if \(state\.mode === "doc"\) ensureDocumentBodyFrame\(\);/);
});

test('website section items use a canonical responsive horizontal placement contract', () => {
  const doc = FMDocModel.createDocument({ kind: 'view' });
  const section = FMDocModel.createNode('frame', {
    frame: { x: 0, y: 0, w: 800, h: 420, layout: 'absolute' },
    children: [
      FMDocModel.createNode('image', { frame: { x: 260, y: 40, w: 280, h: 160, layout: 'absolute' } }),
      FMDocModel.createNode('frame', {
        frame: { x: 100, y: 230, w: 300, h: 120, layout: 'flow' },
        children: [FMDocModel.createNode('text', { frame: { x: 0, y: 0, w: 300, h: 40, layout: 'absolute' } })]
      })
    ]
  });
  doc.root.children.push(section);
  FMDocModel.normalizeViewHorizontalPositions(doc, { parent_width_pt: 800 });
  const image = section.children[0];
  assert.deepEqual(image.frame.position.x, { unit: 'percent', anchor: 'center', value: 0 });
  assert.deepEqual(image.frame.responsive, { mode: 'auto', width: 'fixed', height: 'fixed' }, 'existing website items migrate to auto resize');
  assert.deepEqual(section.children[1].frame.position.x, { unit: 'percent', anchor: 'center', value: -18.75 }, 'a positioned flow container itself remains responsive');
  assert.deepEqual(section.children[1].frame.responsive, { mode: 'auto', width: 'fixed', height: 'fixed' });
  assert.equal(section.children[1].children[0].frame.position, undefined, 'children participating in that container flow do not receive absolute placement');
  assert.equal(FMDocModel.horizontalPositionToLeft(image.frame.position.x, 1600, 560), 520);
  const fixedRight = FMDocModel.horizontalPositionFromLeft(520, 560, 1600, { unit: 'px', anchor: 'right' });
  assert.deepEqual(fixedRight, { unit: 'px', anchor: 'right', value: -520 });
  const rows = FMDocModel.responsiveAutoRows(section.children);
  assert.deepEqual(rows.map((row) => ({ top: row.top, bottom: row.bottom, gap: row.gap_above })), [
    { top: 40, bottom: 200, gap: 40 },
    { top: 230, bottom: 350, gap: 30 }
  ]);
  const sharedRow = FMDocModel.responsiveAutoRows([
    { id: 'left', frame: { y: 20, h: 100, responsive: { mode: 'auto' } } },
    { id: 'right', frame: { y: 40, h: 130, responsive: { mode: 'auto' } } },
    { id: 'below', frame: { y: 190, h: 30, responsive: { mode: 'auto' } } }
  ]);
  assert.equal(sharedRow.length, 2, 'vertically overlapping siblings share one responsive row');
  assert.deepEqual(sharedRow[0].items.map((item) => item.id), ['left', 'right']);
  assert.equal(sharedRow[1].gap_above, 20, 'the next row keeps one gap after the shared row maximum bottom');

  image.frame.position.x = { unit: 'vw', anchor: 'middle', value: 'bad' };
  const invalid = FMDocModel.validateDocument(doc);
  assert.ok(invalid.errors.some((error) => error.path.endsWith('.frame.position.x.unit')));
  assert.ok(invalid.errors.some((error) => error.path.endsWith('.frame.position.x.anchor')));
  assert.ok(invalid.errors.some((error) => error.path.endsWith('.frame.position.x.value')));

  assert.match(documentRenderer, /function responsiveHorizontalCss\(position\)[\s\S]*?data-position-x-unit[\s\S]*?data-position-x-anchor/);
  assert.match(documentRenderer, /autoResize[\s\S]*?data-responsive-resize[\s\S]*?responsiveWidthPercent \+ "%"[\s\S]*?responsiveHeightPercent \+ "cqw"/);
  assert.match(documentRenderer, /responsiveAutoRows\(node\.children \|\| \[\]\)[\s\S]*?data-responsive-auto/);
  assert.match(documentEditor, /function elementContextPositionRow\(nodeOrNodes\)[\s\S]*?data-position-anchor[\s\S]*?data-position-unit/);
  assert.match(documentEditor, /data-responsive-mode[\s\S]*?Auto resize[\s\S]*?data-responsive-width[\s\S]*?data-responsive-height/);
  assert.match(documentEditor, /function setResponsiveHorizontalPlacement\(nodes, nextBasis\)[\s\S]*?horizontalPositionFromLeft/);
  assert.match(documentEditor, /function responsiveContextNodes\(nodeOrNodes\)[\s\S]*?state\.nodeIndex\.get\(node\.id\)/, 'an open context menu resolves fresh nodes after every render');
  assert.match(documentEditor, /function refreshResponsivePositionRow\(row, nodeOrNodes, nextBasis\)[\s\S]*?aria-pressed[\s\S]*?data-position-unit/, 'the persistent menu refreshes its pressed anchor and unit state');
  assert.match(documentEditor, /setResponsiveHorizontalPlacement\(nodes, \{ anchor: entry\[0\] \}\)[\s\S]*?refreshResponsivePositionRow\(row, nodes, \{ anchor: entry\[0\] \}\)/, 'anchor clicks visibly update the open menu');
  assert.match(documentEditor, /\[\["px", "Fixed pixels"\], \["percent", "Percentage"\]\]/, 'manual placement uses its own explicit row');
  assert.match(documentEditor, /function onEngineApplied\(entry, origin\)[\s\S]*?normalizeViewHorizontalPositions/);
  assert.match(websiteService, /validateDocument\(definition\)[\s\S]*?normalizeViewHorizontalPositions\(FMDocModel\.deepClone\(definition\)\)[\s\S]*?validateDocument\(normalizedDefinition\)/);
  assert.match(websiteService, /resolveBindings\(normalizedDefinition, scope\)[\s\S]*?normalizeViewHorizontalPositions\(resolvedDefinition\)/);
  assert.match(websiteSeeds, /normalizeViewHorizontalPositions\(doc/);
});

test('grouping responsive items preserves their live positions as group-local coordinates', () => {
  const doc = FMDocModel.createDocument({ kind: 'view' });
  const section = FMDocModel.createNode('frame', {
    frame: { x: 0, y: 0, w: 800, h: 400, layout: 'absolute' },
    children: [
      FMDocModel.createNode('shape', {
        frame: { x: 100, y: 40, w: 100, h: 80, layout: 'absolute', position: { x: { unit: 'percent', anchor: 'center', value: -31.25 } } }
      }),
      FMDocModel.createNode('shape', {
        frame: { x: 300, y: 60, w: 100, h: 80, layout: 'absolute', position: { x: { unit: 'percent', anchor: 'center', value: -6.25 } } }
      })
    ]
  });
  doc.root.children.push(section);
  const [left, right] = section.children;
  const engine = FMDocEditor._createCommandEngine({
    M: FMDocModel,
    getDoc: () => doc,
    getFlags: () => FMDocEditor.PROFILE_FLAGS.designer,
    getProfile: () => 'designer'
  });
  const result = engine.apply({
    type: 'node.group',
    node_ids: [left.id, right.id],
    parent_width_pt: 600,
    member_frames: {
      [left.id]: { ...left.frame, x: 62.5 },
      [right.id]: { ...right.frame, x: 212.5 }
    }
  });
  assert.equal(result.ok, true);
  const group = section.children[0];
  assert.equal(group.frame.x, 62.5);
  assert.equal(FMDocModel.horizontalPositionToLeft(group.frame.position.x, 600, group.frame.w), 62.5);
  assert.equal(FMDocModel.horizontalPositionToLeft(group.children[0].frame.position.x, group.frame.w, 100), 0);
  assert.equal(FMDocModel.horizontalPositionToLeft(group.children[1].frame.position.x, group.frame.w, 100), 150);
  assert.equal(engine.undo(), true);
  assert.equal(FMDocModel.horizontalPositionToLeft(section.children[0].frame.position.x, 600, 100), 62.5);
  assert.equal(FMDocModel.horizontalPositionToLeft(section.children[1].frame.position.x, 600, 100), 212.5);
  assert.equal(engine.redo(), true);
  assert.equal(FMDocModel.horizontalPositionToLeft(section.children[0].frame.position.x, 600, section.children[0].frame.w), 62.5);
  assert.equal(FMDocModel.horizontalPositionToLeft(section.children[0].children[0].frame.position.x, section.children[0].frame.w, 100), 0);
  assert.match(documentEditor, /function groupSelection\(\)[\s\S]*?member_frames:[\s\S]*?parent_width_pt/);
  assert.match(documentEditor, /function gestureFrame\(node\)[\s\S]*?Object\.assign\(frame, measured\)[\s\S]*?__fmde_rendered_responsive = true/, 'auto-resize drags start with one complete rendered frame');
  assert.match(documentEditor, /function authoredFrameFromResponsiveGesture\([\s\S]*?delete frame\.__fmde_rendered_responsive[\s\S]*?authoredParentWidthPt \/ renderedParentWidthPt[\s\S]*?frame\[key\] = roundPt\(frame\[key\] \* factor\)/, 'pointer-up converts rendered geometry back to stable authored coordinates');
  assert.match(documentEditor, /memberFrames\[entry\.id\] = responsiveFramePosition\(entry\.id, gestureFrame\(entry\.info\.node\)\)/, 'group creation cannot persist rendered responsive coordinates');
});

test('resizing a group commits proportional frames for every nested member', () => {
  const nested = FMDocModel.createNode('shape', {
    frame: { x: 10, y: 5, w: 30, h: 20, layout: 'absolute', position: { x: { unit: 'percent', anchor: 'center', value: -20 } } }
  });
  const left = FMDocModel.createNode('frame', {
    frame: { x: 0, y: 10, w: 100, h: 80, layout: 'absolute', position: { x: { unit: 'percent', anchor: 'center', value: -30 } } },
    children: [nested]
  });
  const right = FMDocModel.createNode('shape', {
    frame: { x: 150, y: 20, w: 100, h: 60, layout: 'absolute', position: { x: { unit: 'percent', anchor: 'center', value: 30 } } }
  });
  const group = FMDocModel.createNode('frame', {
    frame: { x: 50, y: 40, w: 250, h: 100, layout: 'absolute' },
    props: { fmde_group: true },
    children: [left, right]
  });
  const scaled = FMDocEditor._scaleGroupedFrameTree(
    FMDocModel, group, { ...group.frame, w: 500, h: 150 }, 2, 1.5, {}, true
  );
  const byId = new Map(scaled.map((entry) => [entry.id, entry.frame]));
  assert.deepEqual(
    { x: byId.get(left.id).x, y: byId.get(left.id).y, w: byId.get(left.id).w, h: byId.get(left.id).h },
    { x: 0, y: 15, w: 200, h: 120 }
  );
  assert.deepEqual(
    { x: byId.get(right.id).x, y: byId.get(right.id).y, w: byId.get(right.id).w, h: byId.get(right.id).h },
    { x: 300, y: 30, w: 200, h: 90 }
  );
  assert.deepEqual(
    { x: byId.get(nested.id).x, y: byId.get(nested.id).y, w: byId.get(nested.id).w, h: byId.get(nested.id).h },
    { x: 20, y: 7.5, w: 60, h: 30 }
  );
  assert.equal(FMDocModel.horizontalPositionToLeft(byId.get(right.id).position.x, 500, 200), 300);
  assert.equal(FMDocModel.horizontalPositionToLeft(byId.get(nested.id).position.x, 200, 60), 20);
  assert.match(documentEditor, /function resizeSingle[\s\S]*?scaleGroupedFrameTree[\s\S]*?runCommands\(commands, "resize group"\)/);
  assert.match(documentEditor, /function rawOverlayBox\(nodeId\)[\s\S]*?function overlayBox\(nodeId\)[\s\S]*?isGroupNode\(info\.node\)[\s\S]*?for \(const child of info\.node\.children \|\| \[\]\)[\s\S]*?M\.frameBounds/, 'group selection expands to the live descendant union');
});

test('website sections support independent undoable mobile variants and deterministic Magic Mobile stacking', () => {
  const doc = FMDocModel.createDocument({ kind: 'view' });
  const section = FMDocModel.createNode('frame', {
    name: 'Gallery',
    frame: { x: 0, y: 0, w: 720, h: 300, layout: 'absolute' },
    children: [
      FMDocModel.createNode('image', { frame: { x: 40, y: 40, w: 180, h: 100, layout: 'absolute' } }),
      FMDocModel.createNode('image', { frame: { x: 270, y: 40, w: 180, h: 100, layout: 'absolute' } }),
      FMDocModel.createNode('image', { frame: { x: 500, y: 40, w: 180, h: 100, layout: 'absolute' } }),
      FMDocModel.createNode('text', { frame: { x: 90, y: 0, w: 640, h: 30, layout: 'absolute', responsive: { mode: 'manual', width: 'percent', height: 'proportional' }, position: { x: { unit: 'percent', anchor: 'center', value: 0 } } }, style: { font: { size_pt: 9 } }, props: { blocks: [{ id: 'b', type: 'heading', level: 2, runs: [{ text: 'Recent work' }] }] } })
    ]
  });
  doc.root.children.push(section);
  FMDocModel.normalizeViewHorizontalPositions(doc, { parent_width_pt: 720 });
  const plain = FMDocModel.createMobileViewSection(section, { magic: false });
  assert.notEqual(plain.id, section.id);
  assert.equal(plain.props.variant_of, section.id);
  assert.equal(plain.children[0].props.variant_source_id, section.children[0].id);
  assert.deepEqual(plain.children.map((node) => node.frame.x), section.children.map((node) => node.frame.x), 'a fresh variant begins as the desktop layout');

  const magic = FMDocModel.createMobileViewSection(section, { magic: true });
  const media = magic.children.slice(0, 3);
  const heading = magic.children[3];
  assert.ok(media[0].frame.y < media[1].frame.y && media[1].frame.y < media[2].frame.y, 'a horizontal media row becomes a vertical stack');
  assert.ok(media.every((node) => Math.abs(node.frame.x - (720 - node.frame.w) / 2) < 0.01), 'stacked media is centered with equal side padding');
  assert.ok(magic.children.every((node) => Math.abs(node.props.magic_mobile_rails.left_percent - (40 / 720 * 100)) < 0.01
    && Math.abs(node.props.magic_mobile_rails.right_percent - (40 / 720 * 100)) < 0.01), 'the desktop row envelope becomes shared percentage rails');
  assert.equal(heading.frame.x, media[0].frame.x, 'heading and stacked media share the desktop row left rail');
  assert.equal(heading.frame.w, media[0].frame.w, 'heading and stacked media share the desktop row right rail');
  assert.notEqual(heading.frame.x, section.children[3].frame.x, 'Magic samples the title\'s painted mount rather than its stale frame.x snapshot');
  assert.ok(heading.style.font.size_pt >= 20, 'small desktop headings are raised to a mobile-readable size');
  assert.ok(media[0].frame.y - (heading.frame.y + heading.frame.h) >= 720 * 0.065 * 1.19, 'heading-to-media spacing keeps a generous semantic gutter');
  assert.ok(media[1].frame.y - (media[0].frame.y + media[0].frame.h) >= 720 * 0.065, 'large stacked media keeps a phone-sized gutter');
  assert.ok(magic.frame.h > media[2].frame.y + media[2].frame.h, 'the mobile section and its selection border grow around the generated stack');

  const offsetSection = FMDocModel.deepClone(section);
  offsetSection.children[0].frame.x = 25;
  offsetSection.children[2].frame.x = 485;
  const centeredMagic = FMDocModel.createMobileViewSection(offsetSection, { magic: true });
  const centeredRails = centeredMagic.children[0].props.magic_mobile_rails;
  assert.ok(Math.abs(centeredRails.left_percent - centeredRails.right_percent) < 0.01,
    'Magic centers the preserved row width instead of carrying an asymmetric desktop x offset into mobile');
  assert.ok(Math.abs(centeredMagic.children[0].frame.x - (720 - centeredMagic.children[0].frame.w) / 2) < 0.01,
    'the generated mobile frame and its painted rails use the same centered geometry');

  section.props.mobile_variant_enabled = true;
  doc.root.children.push(magic);
  assert.equal(FMDocModel.activeViewSections(doc, 'desktop')[0].id, section.id);
  assert.equal(FMDocModel.activeViewSections(doc, 'mobile')[0].id, magic.id);
  magic.props.mobile_enabled = false;
  assert.equal(FMDocModel.activeViewSections(doc, 'mobile')[0].id, section.id, 'disabled variants fall back to the desktop section');

  // Regeneration is deliberately a single engine transaction: an existing
  // hand-edited phone variant, the desktop enable bit, and the fresh generated
  // variant all round-trip through one Ctrl-Z entry.
  const priorMobileId = magic.id;
  const regenerated = FMDocModel.createMobileViewSection(section, { magic: true });
  const engine = FMDocEditor._createCommandEngine({
    M: FMDocModel,
    getDoc: () => doc,
    getFlags: () => FMDocEditor.PROFILE_FLAGS.designer,
    getProfile: () => 'designer'
  });
  assert.equal(engine.apply([
    { type: 'node.set', node_id: section.id, prop: 'props.mobile_variant_enabled', value: true },
    { type: 'node.remove', node_id: priorMobileId },
    { type: 'node.insert', node: regenerated, parent_id: null, index: 1 }
  ], { label: 'Magic Mobile' }).ok, true);
  assert.equal(FMDocModel.mobileViewSection(doc, section).id, regenerated.id);
  assert.equal(engine.undo(), true);
  assert.equal(FMDocModel.mobileViewSection(doc, section).id, priorMobileId, 'one undo restores the prior phone layout');

  const desktopCopy = FMDocModel.reassignIds(FMDocModel.deepClone(section));
  const mobileCopy = FMDocModel.reassignIds(FMDocModel.deepClone(magic));
  mobileCopy.props.variant_of = desktopCopy.id;
  FMDocModel.linkMobileVariantSources(desktopCopy, mobileCopy);
  assert.equal(mobileCopy.children[0].props.variant_source_id, desktopCopy.children[0].id, 'duplicated variants link to the duplicated desktop tree');

  assert.match(documentRenderer, /data-view-variant[\s\S]*?data-mobile-variant-enabled[\s\S]*?data-mobile-enabled/);
  assert.match(documentRenderer, /const magicRails = node && node\.props && node\.props\.magic_mobile_rails[\s\S]*?const railWidth = Math\.max\(0, 100 - railLeft - railRight\)[\s\S]*?const centeredRail = Math\.max\(0, \(100 - railWidth\) \/ 2\)[\s\S]*?elm\.style\.left = centeredRail \+ "%"[\s\S]*?elm\.style\.width = railWidth \+ "%"/, 'painted mobile gutters preserve the desktop row width and center existing or newly generated rails');
  assert.match(documentEditor, /applyBatch: function \(commands, label\)[\s\S]*?engine\.apply\(list/);
  assert.match(visualEditor, /data-ch-sec-mobile-toggle[\s\S]*?Use a different mobile version[\s\S]*?data-ch-sec-mobile-magic[\s\S]*?Magic Mobile/);
  assert.match(visualEditor, /function regenerateMagicMobile\(section\)[\s\S]*?createMobileViewSection\(desktop, \{ magic: true[\s\S]*?applyBatch\(commands, 'Magic Mobile'\)/, 'Magic Mobile regeneration is one undo entry');
  assert.match(visualEditor, /function documentSectionsAdapter\(\)[\s\S]*?!M\(\)\.isMobileViewSection\?\.\(node\)/, 'mobile variants never appear as duplicate section-strip entries');
  assert.match(visualEditor, /function updateSectionChrome\(\)[\s\S]*?nodeWithinSection\(selection\[0\], section\.id\)[\s\S]*?state\.sectionChromeId = cleanText\(activeSection\.id\)[\s\S]*?renderSectionChrome\(\)/, 'section chrome remains visible for a selected descendant');
  assert.match(visualEditor, /const clampChromeTop = \(desired, height\)[\s\S]*?clampChromeTop\(top \+ 6, actions\.offsetHeight[\s\S]*?clampChromeTop\(top \+ 6, mobileActions\.offsetHeight[\s\S]*?clampChromeTop\(desiredTop, horizontalHeight\)/, 'both side rails and the section pill stay inside the visible frame');
});

test('Doc mode supplies editable-only page scaffolds and a bottom add-page control', () => {
  assert.match(documentEditor, /function createDocRegionFrame\(doc, page, pageIndex, region, placeholder\)[\s\S]*?fmde_doc_placeholder/);
  assert.match(documentEditor, /function buildDocDisplayScaffold\(doc\)[\s\S]*?\["header", "body", "footer"\][\s\S]*?createDocRegionFrame/);
  assert.match(documentEditor, /state\.mode === "doc" \? buildDocDisplayScaffold\(state\.doc\) : state\.doc/);
  assert.match(documentRenderer, /props\.fmde_doc_placeholder[\s\S]*?data-fmde-doc-placeholder/);
  assert.match(documentEditor, /function materializePlaceholder\(pageId, region\)[\s\S]*?"node\.insert"[\s\S]*?doc-placeholder/);
  assert.match(documentEditor, /function renderDocAddPageControl\(\)[\s\S]*?fmde-doc-add-page[\s\S]*?appendPageBreak/);
  assert.match(documentEditor, /function appendPageBreak\(\)[\s\S]*?M\.createNode\("page_break"[\s\S]*?Body continuation/);
  assert.match(documentEditorCss, /fmde-doc-add-page/);
});

test('Doc mode exposes familiar word-processing controls and hides layout tools under More', () => {
  assert.match(documentEditor, /iconBtn\("print"[\s\S]*?iconBtn\("spellcheck"[\s\S]*?iconBtn\("paint"[\s\S]*?addZoomGroup\(\)[\s\S]*?Normal text[\s\S]*?fmde-fontselect[\s\S]*?fmde-fontsize/);
  assert.match(documentEditor, /Text color[\s\S]*?Highlight color[\s\S]*?Insert link[\s\S]*?Add comment[\s\S]*?Paragraph alignment[\s\S]*?Line and paragraph spacing/);
  assert.match(documentEditor, /Checklist[\s\S]*?Bulleted list[\s\S]*?Numbered list[\s\S]*?Decrease indent[\s\S]*?Increase indent[\s\S]*?Clear formatting/);
  assert.match(documentEditor, /More document options[\s\S]*?Margins…[\s\S]*?Page numbers/);
});

test('Doc toolbar uses plain size controls and responsive non-scrolling groups', () => {
  assert.match(documentEditor, /iconBtn\("minus", "Decrease font size"[\s\S]*?iconBtn\("plusplain", "Increase font size"/);
  assert.match(documentEditor, /overflow:hidden[\s\S]*?@container[\s\S]*?fmde-doc-list/);
  assert.match(documentEditor, /const hidden = function \(toolbarGroup\)[\s\S]*?classList\.contains\("fmde-overflowed"\)[\s\S]*?getComputedStyle\(toolbarGroup\)\.display === "none"/);
  assert.match(documentEditor, /if \(hidden\(utilityGroup\)\) section[\s\S]*?if \(hidden\(fmtGroup\)\) section[\s\S]*?if \(hidden\(listGroup\)\) section/);
});

test('Visual toolbar mirrors Doc utilities and exposes only relevant element styling', () => {
  assert.match(documentEditor, /Visual keeps the same leading mode\/history\/zoom vocabulary as Doc[\s\S]*?addHistoryGroup\(\)[\s\S]*?addZoomGroup\(\)[\s\S]*?buildVisualTextToolbar\(group\)/);
  assert.match(documentEditor, /function visualTextContext\(\)[\s\S]*?selected\.type === "shape"[\s\S]*?selected\.type === "text"[\s\S]*?selected\.type === "frame"/);
  assert.match(documentEditor, /fmde-visual-font-tools[\s\S]*?dom\.visualFontTools\.hidden = !context/);
  assert.match(documentEditor, /makeBackgroundColorButton\("visual"\)[\s\S]*?title: "Border color"[\s\S]*?"Line width"[\s\S]*?title: "Corners"[\s\S]*?const fontTools/);
  assert.match(documentEditor, /fmde-border-color-dot\{[\s\S]*?border:4px solid var\(--tool-color,#202124\)[\s\S]*?background:#fff/);
  assert.match(documentEditor, /stroke: '<path[^']*stroke-width="\.8"[^']*stroke-width="1\.7"[^']*stroke-width="2\.8"/);
  assert.match(documentRenderer, /Shapes paint their stroke on their actual SVG geometry[\s\S]*?node\.type !== "shape" && style\.stroke/);
  assert.match(documentEditor, /dom\.visualBorderColorBtn\.hidden = !\(stroke\.width > 0\)/);
  assert.match(documentEditor, /fmde-doc-background[\s\S]*?makeBackgroundColorButton\("doc"\)/);
  assert.match(documentEditor, /Section border color[\s\S]*?Section line width[\s\S]*?Section corners/);
  assert.match(documentEditor, /function updateDocSectionStyleControls\(\)[\s\S]*?dom\.docBorderColorBtn\.hidden[\s\S]*?dom\.docStrokeBtn[\s\S]*?dom\.docCornersBtn/);
  assert.match(documentRenderer, /const strokeInset = Math\.min\(w \/ 2, hgt \/ 2, strokeWidth \/ 2\)[\s\S]*?rect\.setAttribute\("x", String\(strokeInset\)\)[\s\S]*?rect\.setAttribute\("width", String\(innerW\)\)/);
  assert.match(documentEditor, /function liveSetFrame[\s\S]*?FMDocRenderer\.syncShapeSvg\(svg, info\.node,[\s\S]*?frame\.w[\s\S]*?frame\.h/);
});

test('web page actions use compact eight-pixel gutters', () => {
  assert.match(documentEditor, /\.fmde-tb-host-actions\{gap:8px!important/);
  assert.doesNotMatch(documentEditor, /\.fmde-tb-host-actions\{gap:20px!important/);
});

test('shared animated tooltips adopt native editor titles and point back to their controls', () => {
  assert.match(platformUi, /function adoptNativeTooltip\(target\)[\s\S]*?data-fm-native-title[\s\S]*?removeAttribute\('title'\)/);
  assert.match(platformUi, /MutationObserver[\s\S]*?attributeFilter:\['title'\]/);
  assert.match(platformUi, /fm-tooltip::after[\s\S]*?fm-tooltip\[data-side="below"\]::after[\s\S]*?fm-tooltip\[data-side="above"\]::after/);
  assert.match(platformUi, /font-family:Montserrat[\s\S]*?transition:opacity \.16s ease,transform \.18s/);
  assert.match(platformUi, /showTooltip\(target, \{ delay: 280 \}\)[\s\S]*?showTooltip\(target, \{ delay: 120 \}\)/);
  assert.match(platformUi, /function showTooltip\(target, options = \{\}\)\{[\s\S]*?tooltipSuppressedTarget === target/);
  assert.match(platformUi, /document\.addEventListener\('pointerdown',[\s\S]*?tooltipSuppressedTarget = tooltipTargetFrom\(event\.target\)[\s\S]*?hideTooltip\(\)/);
  assert.match(platformUi, /document\.addEventListener\('keydown',[\s\S]*?'ArrowDown'[\s\S]*?target\.matches\?\.\('select,button/);
});

test('typing formats persist without a highlighted range and colors use a dense shared palette', () => {
  assert.match(documentEditor, /typingFormat: \{ family: "", size_pt: null, color: "#202124", background: "transparent", bold: null, italic: null, underline: null \}/);
  assert.match(documentEditor, /function rememberTypingFormat[\s\S]*?Formatting set for new text/);
  assert.match(documentEditor, /node\.getAttribute\("face"\)[\s\S]*?style\.family/);
  assert.match(documentEditor, /const DOC_COLOR_GRID = \[[\s\S]*?function showColorPalette/);
  assert.match(documentEditor, /fmde-tool-color-line[\s\S]*?Custom/);
});

test('color palettes surface brand and frequently used colors and font sizing has angle-bracket shortcuts', () => {
  assert.match(documentEditor, /function brandPaletteColors\(\)[\s\S]*?brandingColors\.palette[\s\S]*?theme\.tokens[\s\S]*?editorBrandingPalette\(\)\.primary/);
  assert.match(documentEditor, /function recordColorUse\(value\)[\s\S]*?fmde_color_usage_v1[\s\S]*?function frequentPaletteColors/);
  assert.match(documentEditor, /Brand & frequently used[\s\S]*?fmde-color-frequent-row/);
  assert.match(documentEditor, /function fontSizeShortcutDirection\(ev\)[\s\S]*?ev\.key === ">"[\s\S]*?ev\.key === "<"/);
  assert.match(documentEditor, /fontSizeDirection && state\.mode === "visual"[\s\S]*?setVisualTextValue\("size_pt"[\s\S]*?if \(fontSizeDirection\)[\s\S]*?docProjection\.format\("fontSize"/);
  assert.match(documentEditor, /"Increase font size","Ctrl\/⌘ >"[\s\S]*?"Decrease font size","Ctrl\/⌘ <"/);
});

test('browser font face names are canonicalized to document catalog families', () => {
  assert.match(documentEditor, /function canonicalFontFamily\(value\)[\s\S]*?replace\(\/regular\$\/, ""\)[\s\S]*?catalogFonts\(\)\.find/);
  assert.match(documentEditor, /f\.family = canonicalFontFamily\(css\.fontFamily\)/);
  assert.match(documentEditor, /style\.family = canonicalFontFamily\(node\.getAttribute\("face"\)\)/);
  assert.match(documentEditor, /run\.font\.family = canonicalFontFamily\(style\.family\)/);
});

test('Arial remains selectable when hosts supply a narrower font catalog', () => {
  assert.match(documentApi, /DOCUMENT_FONTS = \[[^\]]*"Arial"/);
  assert.match(documentStudio, /DEFAULT_FONTS = \[[^\]]*'Arial'/);
  assert.match(documentEditor, /function catalogFonts\(\)[\s\S]*?supplied\.concat\(DEFAULT_FONTS\)[\s\S]*?seen\.has\(key\)/);
  assert.match(documentEditor, /const DEFAULT_FONTS = \[[^\]]*"Arial"/);
});

test('theme styles remain available in the theme editor and page setup', () => {
  assert.match(documentStudio, /<h3><i class="fas fa-paragraph"><\/i> Paragraph styles<\/h3>/);
  assert.match(documentStudio, /data-theme-style-family/);
  assert.match(documentStudio, /data-theme-style-size/);
  assert.match(documentStudio, /data-theme-style-weight/);
  assert.match(documentStudio, /data-theme-style-color/);
  assert.match(documentStudio, /style_ref: 'h1'[\s\S]*?style_ref: 'h2'[\s\S]*?style_ref: 'body'/);
  assert.match(documentEditor, /if \(!themeId\) return opts\.theme \|\| null/);
  assert.match(documentEditor, /preferredStyleOrder[\s\S]*?catalogThemes\.filter[\s\S]*?localeCompare/);
});

test('documents can explicitly opt out of the inherited default theme', () => {
  assert.match(documentEditor, /metadata\.theme_disabled/);
  assert.match(documentEditor, /prop: "metadata\.theme_disabled", value: !selectedThemeId/);
  assert.match(documentEditor, /prop: "metadata\.theme_disabled", value: !v/);
});

test('visual editor palette docks below the combined editor control row', () => {
  assert.match(visualEditor, /function dockChromePaletteBelowEditorHeaders\(\)[\s\S]*?stage\.querySelector\('\.fmde-body'\)[\s\S]*?editorBody\.insertBefore\(rail, editorCanvas\)[\s\S]*?editorBody\.insertBefore\(panel, editorCanvas\)/);
  assert.match(visualEditor, /editorHandle = global\.FMDocEditor\.mount\(stage, editorOpts\)[\s\S]*?dockChromePaletteBelowEditorHeaders\(\)/);
});

test('collapsing the right tray hides host panels in visual and doc modes', () => {
  assert.match(documentEditor, /\.fmde-has-panels:not\(\.fmde-insp-collapsed\) \.fmde-inspector\{display:flex;flex-direction:column;padding:0\}/);
  assert.match(documentEditor, /\.fmde-mode-doc\.fmde-has-panels:not\(\.fmde-insp-collapsed\) \.fmde-inspector\{display:flex\}/);
  assert.match(documentEditor, /\.fmde-insp-collapsed \.fmde-inspector\{display:none\}/);
});

test('visual page controls stay in the center canvas column and render real thumbnails', () => {
  assert.match(visualEditor, /fmwe-ch-canvas-column[\s\S]*?flex-direction: column/);
  assert.match(visualEditor, /canvasColumn\.appendChild\(editorCanvas\)[\s\S]*?appendChild\(under\)[\s\S]*?appendChild\(bottom\)/);
  assert.match(visualEditor, /function documentPagesAdapter[\s\S]*?definition\.pages = \[clone\(objectValue\(page\)\)\][\s\S]*?definition/);
  assert.match(visualEditor, /\.fmwe-ch-pagecard \.thumb \{[\s\S]*?height: 68px;[\s\S]*?max-height: 68px;[\s\S]*?aspect-ratio: var\(--fmwe-page-ratio, 16 \/ 9\)/);
  assert.match(visualEditor, /function pageThumbnailMetrics\(page\)[\s\S]*?paperDimensions\(definition\)[\s\S]*?ratio:/);
  assert.match(visualEditor, /style="--fmwe-page-ratio:\$\{esc\(pageThumbnailMetrics\(p\)\.ratio\)\}"/);
  assert.match(visualEditor, /paperDimensions\(definition\)[\s\S]*?fitW[\s\S]*?fitH[\s\S]*?theme: themeForDefinition\(definition\)/);
  assert.match(visualEditor, /handle\.setDocument = \(nextDoc, setOptions\)[\s\S]*?editorHandle\.setDocument\(nextDoc, setOptions\)/);
});

test('visual page thumbnails expose a functional page actions pop-up', () => {
  assert.match(visualEditor, /class="fmwe-ch-page-more" data-ch-page-more=/);
  assert.match(visualEditor, /function openPageMenu\(page, anchor\)[\s\S]*?data-ch-page-title[\s\S]*?data-ch-page-action/);
  for (const action of ['copy', 'paste', 'add', 'duplicate', 'delete']) {
    assert.match(visualEditor, new RegExp(`pageMenuRow\\('${action}'`));
  }
  assert.match(visualEditor, /rename\(id, title\)[\s\S]*?type: 'page\.set'[\s\S]*?prop: 'name'/);
  assert.match(visualEditor, /duplicate\(id\)[\s\S]*?this\.paste\(id, copied\)/);
  assert.match(visualEditor, /remove\(id\)[\s\S]*?type: 'page\.remove'/);
  assert.match(visualEditor, /pageMenuKeyHandler[\s\S]*?data-ch-page-action=/);
  assert.match(visualEditor, /\.fmwe-page-menu \{[\s\S]*?position: fixed;[\s\S]*?z-index: 2147483425/);
  assert.match(visualEditor, /\.fmwe-page-menu \{[\s\S]*?width: min\(286px[\s\S]*?padding: 10px[\s\S]*?font-family: Montserrat/);
  assert.match(visualEditor, /\.fmwe-page-menu-row \{[\s\S]*?min-height: 34px;[\s\S]*?font-size: 13px/);
  assert.match(visualEditor, /const left = Math\.max\(12, Math\.min\(global\.innerWidth - menuRect\.width - 12, rect\.left\)\)/);
  assert.match(visualEditor, /if \(pageMenuEl && pageMenuPageId === pageId\) \{ closePageMenu\(\); return; \}/);
  assert.match(visualEditor, /pageMenuOutsideHandler = \(event\) => \{ if \(!menu\.contains\(event\.target\) && !anchor\.contains\(event\.target\)\) closePageMenu\(\); \}/);
  assert.match(visualEditor, /action === 'delete'[\s\S]*?closePageMenu\(\);[\s\S]*?await confirmFn/);
  assert.match(visualEditor, /removeStyling\(id\)[\s\S]*?type: 'page\.set'[\s\S]*?prop: 'master_ref', value: 'none'/);
  assert.match(visualEditor, /pageMenuRow\('remove-styling', 'fa-eraser', 'Remove styling'/);
  assert.match(visualEditor, /action === 'remove-styling'[\s\S]*?closePageMenu\(\);[\s\S]*?pagesApi\.removeStyling\(pageId\)/);
  assert.match(documentRenderer, /function pageMasterForPage\(theme, page\)[\s\S]*?ref === "none"[\s\S]*?theme\.page_masters[\s\S]*?pageMasterForRole/);
  assert.match(documentEditor, /\{ value: "none", label: "No styling" \}/);
});

test('visual element thumbnails use fixed-height four-column units and buttons match their inserted presentation', () => {
  assert.match(visualEditor, /\.fmwe-ch-elgrid \{[\s\S]*?grid-auto-flow: column;[\s\S]*?grid-auto-columns: calc\(\(100% - 18px\) \/ 4\);[\s\S]*?grid-template-rows: 56px/);
  assert.match(visualEditor, /\.fmwe-ch-el \{[\s\S]*?height: 56px;[\s\S]*?overflow: visible;[\s\S]*?padding: 0/);
  assert.match(visualEditor, /\.fmwe-ch-el\[data-ch-el-span="2"\] \{ grid-column: span 2; \}/);
  assert.match(visualEditor, /horizontalShelfHtml\('fmwe-ch-elgrid cards',[\s\S]*?'data-ch-el-recent'\)/);
  assert.match(visualEditor, /function wireHorizontalShelves\(scope\)[\s\S]*?can-left[\s\S]*?can-right[\s\S]*?scrollBy/);
  assert.match(visualEditor, /scroller\.addEventListener\('wheel'[\s\S]*?event\.deltaY[\s\S]*?event\.preventDefault\(\)[\s\S]*?behavior: 'auto'[\s\S]*?passive: false/);
  assert.match(visualEditor, /\.fmwe-ch-el-scroll\.can-left::before[\s\S]*?\.fmwe-ch-el-scroll\.can-right::after/);
  assert.match(visualEditor, /\.fmwe-ch-el-scroll \{[^}]*padding-block: 3px/);
  assert.match(visualEditor, /\.fmwe-ch-el > svg,[\s\S]*?transform: scale\(\.96\)[\s\S]*?\.fmwe-ch-el:hover > svg,[\s\S]*?transform: scale\(1\.03\)/);
  assert.match(visualEditor, /\.fmwe-ch-el \.ic \{[^}]*width: 100%;[^}]*height: 100%;[^}]*font-size: 38px/);
  assert.match(visualEditor, /data-ch-el-span="\$\{Math\.max\(1, Math\.min\(4, numberValue\(item\.span\) \|\| 1\)\)\}"/);
  assert.match(visualEditor, /function buttonPresentation\(options = \{\}\)[\s\S]*?fontFamily: options\.fontFamily \|\| BODY_FONT_VAR[\s\S]*?fontWeight: Number\(options\.fontWeight\) \|\| 500/);
  assert.match(visualEditor, /function tplButton\([\s\S]*?buttonPresentation\(options\)[\s\S]*?family: presentation\.fontFamily[\s\S]*?weight: presentation\.fontWeight[\s\S]*?layout: 'flow'[\s\S]*?radius: presentation\.cornerRadius[\s\S]*?align: 'center', justify: 'center'/);
  assert.match(visualEditor, /function elBtnSample\([\s\S]*?buttonPresentation\(\{ variant \}\)[\s\S]*?--fmwe-button-radius[\s\S]*?--fmwe-button-font[\s\S]*?--fmwe-button-weight[\s\S]*?--fmwe-button-aspect/);
  assert.match(visualEditor, /\.fmwe-ch-btnsample \{[\s\S]*?aspect-ratio: var\(--fmwe-button-aspect[\s\S]*?padding: 0 12px/);
  assert.match(visualEditor, /function syncChromeThemeVars\(definition\)[\s\S]*?resolveThemeTokens\(themeForDefinition\(definition\)[\s\S]*?rootEl\.style\.setProperty/);
  assert.match(visualEditor, /handle\.setDocument = \(nextDoc, setOptions\)[\s\S]*?syncChromeThemeVars\(nextDoc\)/);
  assert.match(visualEditor, /el_btn_dark[\s\S]*?variant: 'dark'/);
  assert.match(visualEditor, /el_btn_primary[\s\S]*?span: 2[\s\S]*?el_btn_outline[\s\S]*?span: 2/);
  assert.doesNotMatch(visualEditor, /el_image[^\n]*span: 2/);
  assert.doesNotMatch(visualEditor, /el_sec_short[^\n]*span: 2/);
  assert.match(visualEditor, /widgetItems\.some[\s\S]*?id: 'el_table', name: 'Basic table'[\s\S]*?createNode\('table'/);
  assert.doesNotMatch(visualEditor, /id: 'tables', name: 'Tables'/);
});

test('Markup dock stays inside the preview canvas and markup persists to document pages', () => {
  assert.match(visualEditor, /function renderMarkupDock\(\)[\s\S]*?const canvas = chromeCanvasEl\(\)[\s\S]*?canvas\.offsetLeft \+ 10[\s\S]*?editorBody\.appendChild\(dock\)/);
  assert.match(visualEditor, /function startMarkupSession\(tool\)[\s\S]*?pageInsertionTarget\(\)[\s\S]*?pageId = pageTarget\?\.page\?\.id/);
  assert.match(visualEditor, /function persistMarkup\(\)[\s\S]*?editor\.getDocument\(\)\.kind !== 'view'[\s\S]*?command\.page_id = session\.pageId/);
});

test('visual palette insertion targets authored document pages without requiring sections', () => {
  assert.match(visualEditor, /function authoredPageTargets\(\)[\s\S]*?\.fmdoc-page\[data-page-id\][\s\S]*?__cont/);
  assert.match(visualEditor, /function insertNodeAtCenter\(node, options = \{\}\)[\s\S]*?currentDoc\.kind !== 'view'[\s\S]*?pageInsertionTarget[\s\S]*?type: 'node\.insert', node, page_id: targetPage\.page\.id/);
  assert.match(visualEditor, /node\.anchor = 'page'[\s\S]*?layout: 'absolute'/);
});

test('document-format palettes hide section controls that cannot be inserted', () => {
  assert.match(visualEditor, /entries: arrayValue\(objectValue\(group\)\.entries\)\.filter\(\(entry\) => contentKind !== 'document' \|\| cleanText\(objectValue\(entry\)\.kind\) !== 'section'\)/);
  assert.match(visualEditor, /if \(!templateGroups\(\)\.length\) tabIds = tabIds\.filter\(\(id\) => id !== 'templates'\)/);
  assert.match(visualEditor, /const addSectionEnabled = \(\(\) => \{[\s\S]*?if \(contentKind === 'document'\) return false/);
  assert.match(visualEditor, /\.filter\(\(category\) => contentKind !== 'document' \|\| category\.id !== 'sections'\)/);
});

test('website media drops treat nested layout frames as section background space', () => {
  assert.match(visualEditor, /function fillTargetAtPoint\(clientX, clientY\)[\s\S]*?return contentKind !== 'web' \|\| entry\.getAttribute\('data-node-type'\) !== 'frame'[\s\S]*?sectionAtClientPoint\(clientX, clientY\)/);
  assert.match(visualEditor, /function handleMediaDrop\(drop, mediaRef\)[\s\S]*?drop\.fillTarget[\s\S]*?applyImageFill\(drop\.fillTarget\.nodeId, mediaRef\)/);
});

test('website media can be dropped onto the full-canvas root background', () => {
  assert.match(visualEditor, /function fillTargetAtPoint\(clientX, clientY\)[\s\S]*?const rootBackgroundTarget = \(\) =>[\s\S]*?background: true, rect/);
  assert.match(visualEditor, /const rootSelected = selection\.length === 1[\s\S]*?rootBackgroundTarget\(\)[\s\S]*?sectionAtClientPoint/);
  assert.match(visualEditor, /cleanText\(d\.kind\) === 'view'\) return rootBackgroundTarget\(\)/);
  assert.match(visualEditor, /function highlightFillTarget\(target\)[\s\S]*?target\.section \|\| target\.background/);
  assert.match(visualEditor, /function handleMediaDrop\(drop, mediaRef\)[\s\S]*?applyImageFill\(drop\.fillTarget\.nodeId, mediaRef\)/);
  assert.match(visualEditor, /function retainedImageOverlay\(node\)\{[\s\S]*?objectValue\(objectValue\(objectValue\(node\)\.style\)\.fill\)/);
});

test('website sections share responsive percentage and maximum-width sizing', () => {
  assert.deepEqual(FMDocModel.normalizeSectionWidth({ width_percent: 76.24, max_enabled: true, max_width_px: 1004.6 }), {
    width_percent: 76.2, max_enabled: true, max_width_px: 1005
  });
  assert.deepEqual(FMDocModel.normalizeSectionWidth({ width_percent: 500, max_width_px: 2 }), {
    width_percent: 100, max_enabled: true, max_width_px: 160
  });
  assert.deepEqual(FMDocModel.normalizeSectionWidth({ max_enabled: false }), {
    width_percent: 100, max_enabled: false, max_width_px: 1000
  });
  assert.match(documentRenderer, /function applyViewSectionWidth\(sectionEl, sectionNode\)[\s\S]*?normalizeSectionWidth[\s\S]*?style\.width = sizing\.width_percent \+ "%"[\s\S]*?style\.maxWidth = sizing\.max_enabled[\s\S]*?style\.alignSelf = "center"/);
  assert.match(documentRenderer, /function syncViewSectionWidths\(state, surfaceWidthPx\)[\s\S]*?requestedWidth = availableLayoutWidth \* sizing\.width_percent \/ 100[\s\S]*?maximumWidth = sizing\.max_enabled \? Math\.min\(availableLayoutWidth, sizing\.max_width_px \/ scale\)[\s\S]*?sectionWidth = Math\.min\(availableLayoutWidth, requestedWidth, maximumWidth\)[\s\S]*?setViewSurfaceWidth\(nextWidth\)/);
  assert.match(documentRenderer, /responsiveWidthPercent[\s\S]*?min\(" \+ pt\(f\.w\) \+ ", " \+ responsiveWidthPercent \+ "%\)"[\s\S]*?responsiveWidthPercent >= 99\.999/);
  assert.match(documentRenderer, /function individualTranslatePx\(element\)[\s\S]*?unit === "%"[\s\S]*?element\.offsetWidth[\s\S]*?measureNode\(nodeId\)[\s\S]*?individualTranslatePx\(cursor\)[\s\S]*?cursor\.offsetLeft \|\| 0\) \+ translated\.x/);
  assert.match(documentRenderer, /@container \(max-width: 600px\)[\s\S]*?data-flow-direction="row"[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(documentRenderer, /responsiveTopPercent[\s\S]*?responsiveHeightPercent[\s\S]*?cqw/);
  assert.match(documentEditor, /Fluid website pages can be rebuilt at desktop width[\s\S]*?entry\.pageEl\.offsetWidth \/ PX_PER_PT[\s\S]*?entry\.w_pt = liveWidthPt/);
  assert.match(visualEditor, /data-ch-sec-pill[\s\S]*?data-ch-sec-width title="Section width"[\s\S]*?> Width<\/button>[\s\S]*?function renderSectionWidthPopover\(section, pop\)[\s\S]*?props\.section_width/);
  assert.match(visualEditor, /function onSectionWidthOutsideClick\(event\)[\s\S]*?target\.closest\('\[data-ch-sec-width\], \[data-ch-sec-width-pop\]'\)[\s\S]*?state\.sectionWidthOpen = false[\s\S]*?doc\.addEventListener\('click', onSectionWidthOutsideClick, true\)[\s\S]*?doc\.removeEventListener\('click', onSectionWidthOutsideClick, true\)/);
  assert.match(visualEditor, /<label for="fmwe-sec-max-[\s\S]*?>Maximum width<\/label>[\s\S]*?data-ch-sec-max-row>[\s\S]*?data-ch-sec-max-range aria-label="Maximum width"/);
  assert.doesNotMatch(visualEditor, /data-ch-sec-max-row>Maximum\s*</);
  assert.match(visualEditor, /Copy, lock and delete follow the selected section's left edge[\s\S]*?const actionWidth = actions\.offsetWidth \|\| 34[\s\S]*?const outside = deviceFrameRect[\s\S]*?: left - actionWidth - 8/);
  assert.match(documentEditor, /isStructuralSection\(item\.id\) \? \["n", "s", "e", "w"\][\s\S]*?function startStructuralSectionWidthResize\(entry, downEv, dir, nodeId\)[\s\S]*?availableScreenWidth = currentViewSurfaceWidth\(\)[\s\S]*?max_width_px: width[\s\S]*?sectionEl\.style\.width = width \/ screenScale \+ "px"[\s\S]*?props\.section_width/);
  const directSectionResize = documentEditor.match(/function startStructuralSectionWidthResize\(entry, downEv, dir, nodeId\)([\s\S]*?)\n    function ungroupSelection/)?.[1] || '';
  assert.match(directSectionResize, /max_enabled: true,[\s\S]*?max_width_px: width/, 'manual section resizing always enables and adjusts the fixed cap');
  assert.doesNotMatch(directSectionResize, /width_percent:\s*width \/ availableScreenWidth/, 'manual section resizing never rewrites the target percentage');
  assert.match(directSectionResize, /data-ch-sec-max-toggle[\s\S]*?aria-checked", "true"/, 'the open width panel turns on its maximum-width switch during the drag');
  assert.match(directSectionResize, /data-ch-sec-max-row[\s\S]*?classList\.remove\("disabled"\)/, 'the open width panel enables its maximum-width slider during the drag');
  assert.match(visualEditor, /type="range" min="160" max="3840"[\s\S]*?data-ch-sec-max-range/, 'the maximum-width slider covers the model minimum used by direct resizing');
  assert.match(documentEditor, /function setZoom\(value\) \{[\s\S]*?arguments\.length === 0[\s\S]*?return state\.zoom[\s\S]*?state\.fitMode = null/);
  assert.match(documentEditor, /function currentViewSurfaceWidth\(\)[\s\S]*?state\.mode === "preview" \? 0 : 96[\s\S]*?dom\.canvas\.clientWidth - authoringGutter/);
  assert.match(documentEditor, /setViewSurfaceWidth\(currentViewSurfaceWidth\(\)\)/);
  assert.match(documentEditor, /function onRenderSettled\(\)[\s\S]*?isViewDoc\(\)[\s\S]*?setViewSurfaceWidth\(currentViewSurfaceWidth\(\)\)/);
  assert.match(visualEditor, /const visibleCanvas = chromeCanvasEl\(\);[\s\S]*?resizeObs\.observe\(visibleCanvas\)/);
  assert.match(documentRenderer, /\.fmdoc-view \{[\s\S]*?overflow-x: clip;[\s\S]*?overflow-y: visible;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(documentRenderer, /const layoutWidth = width \/ scale;[\s\S]*?state\.pageEls\[0\]\.style\.width = layoutWidth \+ "px"[\s\S]*?state\.root\.style\.width = width \+ "px"/);
  assert.match(webEditor, /const mobileViewport = state\.device === 'mobile'[\s\S]*?previewMode = state\.editorHandle\?\.getMode\?\.\(\) === 'preview'[\s\S]*?fullBleedViewport = mobileViewport \|\| previewMode[\s\S]*?shell\.style\.width = fullBleedViewport \? '100%' : 'calc\(100% - 96px\)'[\s\S]*?handle\.setViewSurfaceWidth\?\.\(pageWidth\)/);
  assert.match(webEditor, /siteChromeResizeObserver[\s\S]*?new ResizeObserver[\s\S]*?scheduleSiteChromePreview\(\)/);
  assert.match(webEditorCss, /\.fmwe-site-chrome-preview \{[\s\S]*?background: transparent;/);
  assert.match(visualEditor, /let resizeObservedSectionEl = null[\s\S]*?sectionEl !== resizeObservedSectionEl[\s\S]*?resizeObs\.observe\(resizeObservedSectionEl\)/);
  assert.match(visualEditor, /selected section changes width continuously[\s\S]*?positionSectionChrome\(\)/);
});

test('mobile website preview uses full device frames, presets, rotation, zoom, and custom resizing', () => {
  assert.match(visualEditor, /const DEVICE_PRESETS = \[[\s\S]*?iphone-se[\s\S]*?iphone-15[\s\S]*?pixel-8[\s\S]*?galaxy-s24/);
  assert.match(visualEditor, /body_width_mm[\s\S]*?body_height_mm/);
  assert.match(visualEditor, /function devicePhysicalScale\(preview\)[\s\S]*?widthMm \* 96 \/ 25\.4[\s\S]*?heightMm \* 96 \/ 25\.4/);
  assert.match(visualEditor, /const padY =[\s\S]*?availableHeight = Math\.max\(280, deviceLayout\.clientHeight - padY - 2\)[\s\S]*?physicalFrameHeight[\s\S]*?availableHeight \/ physicalFrameHeight/);
  assert.match(visualEditor, /readout\.textContent = preview\.width[\s\S]*?Math\.round\(zoom \* 100\) \+ '%'/);
  assert.match(visualEditor, /function ensureDevicePreview\(\)[\s\S]*?data-device-rotate[\s\S]*?data-device-preset[\s\S]*?Custom size[\s\S]*?data-device-zoom-out[\s\S]*?data-device-zoom-in/);
  assert.match(visualEditor, /\.fmwe-device-tools \{[\s\S]*?position: absolute;[\s\S]*?top: 14px;[\s\S]*?left: 14px;/);
  assert.match(visualEditor, /\.fmwe-device-frame \{[\s\S]*?margin-block: auto;/);
  assert.match(visualEditor, /\.fmve-device-mobile \.fmde-editor-zoom \{ display:none!important; \}/);
  assert.match(visualEditor, /\.fmve-device-mobile \.fmwe-device-screen > \.fmde-canvas \{ overflow-x:hidden;scrollbar-width:none/);
  assert.match(visualEditor, /\.fmve-device-mobile \.fmde-handle-n,[\s\S]*?width:calc\(13\*var\(--fmde-px,1px\)\);height:calc\(5\*var\(--fmde-px,1px\)\)/);
  assert.match(documentEditor, /function setZoomLock\(value\)[\s\S]*?state\.zoomLock[\s\S]*?setZoom\(state\.zoomLock\)/);
  assert.match(visualEditor, /preview\.desktopZoom = desktopZoom[\s\S]*?editorHandle\.setZoomLock\?\.\(1\)/);
  assert.match(visualEditor, /editorHandle\.setZoomLock\?\.\(null\)[\s\S]*?editorHandle\.zoom\?\.\(preview\.desktopZoom\)/);
  assert.match(visualEditor, /function syncChromeZoomDisplay\(value, deviceMode\)[\s\S]*?deviceMode \? '25' : '10'[\s\S]*?deviceMode \? '140' : '200'/);
  assert.match(visualEditor, /zoomSlider\?\.addEventListener\('input'[^]*?if \(deviceLayout\)[^]*?preview\.zoom[^]*?renderDevicePreview\(false\)/);
  assert.match(visualEditor, /data-device-calibrate[\s\S]*?data-device-calibration-range[\s\S]*?fmwe-device-physical-calibration/);
  assert.match(visualEditor, /const deviceFrameRect = deviceLayout\?\.querySelector\('\[data-device-frame\]'\)[\s\S]*?deviceFrameRect\.left - cRect\.left - actionWidth - 12/);
  assert.match(visualEditor, /function beginCustomDeviceResize\(event, axes\)[\s\S]*?preview\.custom[\s\S]*?preview\.width[\s\S]*?preview\.height[\s\S]*?renderDevicePreview\(true\)/);
  assert.match(visualEditor, /data-device-rotate[^]*?preview\.width = preview\.height[^]*?preview\.height = width/);
  assert.match(visualEditor, /\.fmwe-device-frame\.custom \.fmwe-device-resize \{ display:block; \}/);
  assert.match(visualEditor, /handle\.setDevicePreview = setDevicePreview[\s\S]*?handle\.getDevicePreview/);
  assert.match(documentEditor, /setViewSurfaceWidth\(currentViewSurfaceWidth\(\)\)/);
  assert.match(webEditor, /const mobileViewport = state\.device === 'mobile'[\s\S]*?fullBleedViewport = mobileViewport \|\| previewMode[\s\S]*?fullBleedViewport \? 0 : 96[\s\S]*?fullBleedViewport \? '100%'/);
});

test('website section appearance uses the shared toolbar and context menu only', () => {
  assert.doesNotMatch(visualEditor, /data-ch-sec-edit|renderSectionEditPopover|data-ch-sec-fill/);
  assert.match(documentEditor, /function showElementContextMenu\(nodeId, clientX, clientY[\s\S]*?const structural = styleNodes\.some[\s\S]*?before: elementContextHeader\(styleNodes\)/);
  assert.match(documentEditor, /function elementContextStyleRow\(nodeOrNodes\)[\s\S]*?backgroundPaletteOptions\(nodes[\s\S]*?setStrokeColor\(nodes, color\)[\s\S]*?showStrokeMenu\(width, nodes\)[\s\S]*?showCornersMenu\(corners, nodes\)/);
});

test('document outline is contained below editor headers and has a floating toggle', () => {
  assert.match(documentEditor, /dom\.outlineToggle = el\("button"[\s\S]*?fmde-outline-toggle[\s\S]*?Show document outline/);
  assert.match(documentEditor, /dom\.body\.appendChild\(dom\.outlineToggle\)/);
  assert.match(documentEditor, /dom\.body\.appendChild\(dom\.outlinePanel\)/);
  assert.doesNotMatch(documentEditor, /dom\.root\.appendChild\(dom\.outlinePanel\)/);
  assert.match(documentEditor, /fmde-mode-doc \.fmde-outline-toggle\{display:grid\}/);
  assert.match(documentEditor, /fmde-mode-doc \.fmde-outline-toggle\.active\{display:none\}/);
  assert.match(documentEditor, /data-outline-close title="Close outline"[\s\S]*?iconSvg\("x"\)/);
  assert.match(documentEditor, /dom\.outlineToggle\.setAttribute\("aria-expanded"/);
});

test('Enter exits an empty list item as a normal paragraph', () => {
  assert.match(documentEditor, /block\.type === "list_item" && blockRunsLength\(block\) === 0[\s\S]*?block\.type = "paragraph"[\s\S]*?delete block\.list_style/);
});

test('caret-only paragraph commands and document Tab indentation are supported', () => {
  assert.match(documentEditor, /function caretTarget\(\)[\s\S]*?P\.lastCaret/);
  assert.match(documentEditor, /if \(!sel \|\| !sel\.rangeCount \|\| sel\.isCollapsed\) return caretRef/);
  assert.match(documentEditor, /ev\.key === "Tab"[\s\S]*?mutateCoveredBlocks\(delta > 0 \? "indent" : "outdent"/);
  assert.match(documentEditor, /fmde-caret-passive[\s\S]*?restoreLastCaret\(true\)/);
});

test('auto-generated pages repeat source header and footer regions', () => {
  assert.match(documentRenderer, /data-page-region="header"[\s\S]*?data-page-region="footer"/);
  assert.match(documentRenderer, /repeated\.setAttribute\("data-chrome", "true"\)/);
});

test('live document typing paginates at the connected body-frame boundary', () => {
  assert.match(documentEditor, /function chainFrameOverflows\(part\)[\s\S]*?frame\.scrollHeight > frame\.clientHeight \+ 1/);
  assert.match(documentEditor, /if \(chainFrameOverflows\(part\)\) commitNow\("frame-overflow"\)/);
  assert.match(documentRenderer, /Never let body text paint through a footer[\s\S]*?props\.overflow === "hidden"[\s\S]*?elm\.style\.overflow = "hidden"/);
});

test('explicit page breaks split at the caret and Backspace removes the boundary', () => {
  assert.match(documentEditor, /meta && ev\.key === "Enter"[\s\S]*?docProjection\.insertPageBreak\(\)/);
  assert.match(documentEditor, /function insertPageBreak\(caretOverride\)[\s\S]*?"text\.edit"[\s\S]*?"node\.insert"[\s\S]*?"node\.insert"/);
  assert.match(documentEditor, /function removePageBreakBefore\(caret\)[\s\S]*?"text\.edit"[\s\S]*?"node\.remove"[\s\S]*?"node\.remove"/);
  assert.match(documentEditor, /if \(!found\.previous\)[\s\S]*?node\.remove[\s\S]*?found\.boundary\.node\.id/);
  assert.match(documentEditor, /label: "Page break"[\s\S]*?docProjection\.insertPageBreak\(caretAtOpen\)/);
  assert.match(documentEditor, /Explicit page boundaries are communicated by the page itself[\s\S]*?fmdoc-page_break::before[\s\S]*?display:none!important/);
});

test('Backspace removes a completely blank authored page when no page break remains', () => {
  assert.match(documentEditor, /function handleBackspaceAtStart\(caret\)[\s\S]*?removePageBreakBefore\(caret\)[\s\S]*?removeBlankAuthoredPageAtCaret\(caret\)/);
  assert.match(documentEditor, /function pageIsStructurallyBlank\(page\)[\s\S]*?node\.type === "text"[\s\S]*?content\.trim\(\)[\s\S]*?blank = false/);
  assert.match(documentEditor, /function removeBlankAuthoredPageAtCaret\(caret\)[\s\S]*?pageIndex <= 0[\s\S]*?pageIsStructurallyBlank[\s\S]*?type: "page\.remove"/);
});

test('blank paragraph geometry is shared by editing and preview rendering', () => {
  assert.match(documentRenderer, /\.fmdoc-block \{ margin: 0; min-height: 1em; \}/);
});

test('document comments render as anchored attributed threads with replies and resolution', () => {
  assert.match(documentEditor, /function renderCommentThreads\(\)[\s\S]*?fmde-comment-anchor[\s\S]*?data-comment-id/);
  assert.match(documentEditor, /author: collaborationActor\(\)[\s\S]*?status: "open"[\s\S]*?replies: \[\]/);
  assert.match(documentEditor, /comment:reply[\s\S]*?comment:resolve/);
  assert.match(documentEditor, /state\.mode !== "doc"\) return/);
  assert.match(documentStudio, /collaboration: \{ actor: editorActor\(\) \}/);
});

test('selected-text suggestions require an explicit accept or reject review', () => {
  assert.match(documentEditor, /Suggest an edit[\s\S]*?status: "pending"[\s\S]*?suggestion:add/);
  assert.match(documentEditor, /data-reject-suggestion[\s\S]*?data-accept-suggestion/);
  assert.match(documentEditor, /function applySuggestion\(suggestion, suggestions\)[\s\S]*?suggestion:accept/);
  assert.match(documentEditor, /This suggestion conflicts with newer edits/);
});

test('Add Media uses the shared media tray for existing images and videos', () => {
  assert.match(documentStudio, /function pickDocumentMedia[\s\S]*?PlatformAPI\.media\.list[\s\S]*?openProjectMediaPicker/);
  assert.match(documentStudio, /title: 'Add Media'[\s\S]*?imageOnly: false[\s\S]*?accept: 'image\/\*,video\/\*'/);
  assert.match(documentEditor, /label: "Add media"[\s\S]*?mediaKind: "media"[\s\S]*?doc\.video@1/);
  assert.match(appManifest, /id: 'documents\.studio'[\s\S]*?photos\/feed\.js[\s\S]*?documents\/studio\.js/);
});

test('Doc mode exposes familiar searchable File through Help menus', () => {
  assert.match(documentEditor, /label: "File"[\s\S]*?label: "Edit"[\s\S]*?label: "View"[\s\S]*?label: "Insert"[\s\S]*?label: "Format"[\s\S]*?label: "Tools"[\s\S]*?label: "Help"/);
  assert.match(documentEditor, /function showMenuSearch[\s\S]*?Search menus[\s\S]*?flattenMenuCommands/);
  assert.match(documentEditor, /Version history[\s\S]*?Page setup[\s\S]*?Print/);
  assert.match(documentEditor, /Find and replace[\s\S]*?Show print layout[\s\S]*?Show ruler[\s\S]*?Show non-printing characters/);
  assert.match(documentEditor, /Review suggested edits[\s\S]*?Translate document with Agent[\s\S]*?Keyboard shortcuts/);
});

test('Studio document File actions operate on the current folder item', () => {
  assert.match(documentStudio, /function folderItemDocumentActions\(\)[\s\S]*?copy:[\s\S]*?share:[\s\S]*?email:[\s\S]*?download:[\s\S]*?rename:[\s\S]*?move:[\s\S]*?versions:[\s\S]*?trash:/);
  assert.match(documentStudio, /documentActions: folderItemDocumentActions\(\)/);
  assert.match(documentSchemas, /patchFolderItemSchema[\s\S]*?folder_id: optionalIdSchema/);
  assert.match(documentStorage, /folder_id: Object\.prototype\.hasOwnProperty\.call\(patch, "folder_id"\)/);
});

test('document Agent commands open the local copilot and forward requested tasks', () => {
  assert.doesNotMatch(documentStudio, /Use the Agent button in the app header/);
  assert.match(documentStudio, /agent: \(\{ task \} = \{\}\) => \{[\s\S]*?openSidePanel\?\.\('agent'\)[\s\S]*?folderItemAgent\.send\?\.\(prompt\)/);
  assert.match(documentStudio, /agentEnabled: capabilityEnabled\('documents\.agent'\)[\s\S]*?sidePanels: capabilityEnabled\('documents\.agent'\)[\s\S]*?mountFolderItemAgent/);
  assert.match(documentStudio, /initialMessage: kickoff[\s\S]*?type\) !== 'document\.set_definition'[\s\S]*?setDocument/);
  assert.match(documentAgent, /queuedMessages: \[\][\s\S]*?if \(kickoff\) state\.queuedMessages\.push\(kickoff\)[\s\S]*?send: sendMessage/);
  assert.match(documentProject, /agent: \(\{ task \} = \{\}\) => \{[\s\S]*?setTrayTab\('agent'\)[\s\S]*?docAgent\?\.send\?\.\(task\)/);
});

test('document menus use live state and true cascading submenus', () => {
  assert.match(documentEditor, /let openMenus = \[\][\s\S]*?closeMenusFrom\(depth\)/);
  assert.match(documentEditor, /pointerenter[\s\S]*?if \(children && children\.length\) openChildren\(\)/);
  assert.doesNotMatch(documentEditor, /setTimeout\(openChildren/);
  assert.match(documentEditor, /options\.submenu \? " fmde-submenu"/);
  assert.match(documentEditor, /border:1px solid var\(--fmde-border,#d7dce3\)/);
  assert.match(documentEditor, /animation:fmde-menu-enter 110ms[\s\S]*?@keyframes fmde-submenu-enter/);
  assert.match(documentEditor, /checked: function \(\) \{ return state\.printLayout; \}/);
  assert.match(documentEditor, /fmde-print-layout-off/);
});

test('visual modes lead the main toolbar and widgets expose object layout controls', () => {
  assert.doesNotMatch(documentEditor, /fmde-modebar/);
  assert.match(documentEditor, /const modeGroup = group\("fmde-tb-mode"\)[\s\S]*?modeGroup\.appendChild\(seg\)[\s\S]*?addHistoryGroup\(\)/);
  assert.match(documentEditor, /function widgetLayoutMode[\s\S]*?"flow", "inline", "front", "behind"/);
  assert.match(documentEditor, /Top and Bottom[\s\S]*?In Line with Text[\s\S]*?In Front of Text[\s\S]*?Behind Text/);
  assert.match(documentEditor, /function widgetLayoutIcon[\s\S]*?data-widget-layout/);
  assert.match(documentEditor, /function renderDocWidgetObjects[\s\S]*?fmde-doc-object-controls[\s\S]*?startDocWidgetResize[\s\S]*?startDocWidgetDrag/);
  assert.match(documentEditor, /fmde-doc-object-chrome[\s\S]*?dom\.stage\.appendChild\(chrome\)[\s\S]*?positionDocWidgetChrome\(chrome, widgetEl\)/);
  assert.match(documentEditor, /\.fmde-doc-object-chrome\{position:absolute;z-index:9000;border:2px solid var\(--fmde-accent\);pointer-events:none\}/);
  assert.match(documentEditor, /widgetEl\.addEventListener\("pointerdown"[\s\S]*?startDocWidgetDrag\(nodeId, widgetEl, event\)/);
  assert.doesNotMatch(documentEditor, /class: "fmde-object-drag"/);
  assert.match(documentEditor, /node\.type === "widget" && node\.props && node\.props\.object_layout === "flow"[\s\S]*?cmd\.parent_id = flowFrame\.id/);
  assert.match(documentEditor, /if \(node\.type === "widget"\) boxEl\.appendChild\(widgetLayoutButtons\(node\)\)/);
});

test('website Preview keeps a persistent fullscreen control and hides editor chrome while expanded', () => {
  assert.match(visualEditor, /fmwe-preview-fullscreen-toggle[\s\S]*?fmve-kind-web\.fmve-preview-mode[\s\S]*?display: grid/);
  assert.match(visualEditor, /data-ch-preview-expand aria-label="Enter fullscreen preview"[\s\S]*?fa-expand/);
  assert.match(visualEditor, /toggleFullscreen = \(previewOnly\)[\s\S]*?previewOnly \? rootEl : visualFullscreenTarget\(\)/);
  assert.match(visualEditor, /function syncFullscreenChrome\(\)[\s\S]*?doc\.fullscreenElement === rootEl[\s\S]*?fmve-preview-fullscreen[\s\S]*?fa-compress/);
  assert.match(visualEditor, /fmve-preview-fullscreen \.fmde-toolbar[\s\S]*?display: none !important/);
  assert.match(visualEditor, /fmve-kind-web\.fmve-preview-mode \.fmde-stage[\s\S]*?min-width: 0;[\s\S]*?padding: 0;[\s\S]*?align-items: stretch/);
  assert.match(visualEditor, /doc\.addEventListener\('fullscreenchange', syncFullscreenChrome\)[\s\S]*?doc\.removeEventListener\('fullscreenchange', syncFullscreenChrome\)/);
  assert.match(visualEditor, /function exitFullscreenOnEscape\(event\)[\s\S]*?event\.key !== 'Escape'[\s\S]*?doc\.exitFullscreen/);
  assert.match(visualEditor, /doc\.addEventListener\('keydown', exitFullscreenOnEscape, true\)[\s\S]*?doc\.removeEventListener\('keydown', exitFullscreenOnEscape, true\)/);
});

test('paged Visual mode hit-tests nested content but promotes the Doc body to one object', () => {
  assert.match(documentEditor, /function hitTestPagedNodeDom[\s\S]*?closest\('\[data-node-id\]'\)[\s\S]*?info\.pageId !== pageId/);
  assert.match(documentEditor, /hitTestPagedNodeDom\(ev, entry\.pageId\) \|\| hitTest\(entry\.pageId, pt\)/);
  assert.match(documentEditor, /function promoteSelection\(nodeId\)[\s\S]*?isDocumentBodyFrame\(info\.node\)[\s\S]*?return info\.node\.id/);
  assert.match(documentEditor, /if \(isDocumentBodyFrame\(hit\.node\)\) \{[\s\S]*?setSelection\(\[hit\.id\]\);[\s\S]*?return;/);
});

test('Visual-placed page objects remain draggable and resizable in Doc mode', () => {
  assert.match(documentEditor, /function isDocModeObject\(node\)[\s\S]*?node\.type === "widget" \|\| node\.anchor === "page"/);
  assert.match(documentEditor, /querySelectorAll\('\[data-node-id\]\[data-node-type\]'\)[\s\S]*?isDocModeObject\(info\.node\)/);
  assert.match(documentEditor, /\.fmdoc-node\.fmde-doc-object\{cursor:move\}/);
  assert.match(documentEditor, /info\.node\.type === "widget"\) chrome\.appendChild\(widgetLayoutButtons/);
  assert.match(documentEditor, /_fmdeDocBaseTransform[\s\S]*?translate\(/);
  assert.match(documentEditor, /imgInfo[\s\S]*?anchor === "page"[\s\S]*?selectDocImage/);
});

test('shapes accept editable contrasting text and rotation snaps to 45 degree angles', () => {
  assert.match(documentEditor, /function defaultShapeTextColor\(node\)[\s\S]*?contrastRatio\(parsed, black\)[\s\S]*?contrastRatio\(parsed, white\)/);
  assert.match(documentEditor, /function startShapeTextEdit\(nodeId, initialText\)[\s\S]*?contenteditable: "true"[\s\S]*?Text color/);
  assert.match(documentEditor, /selected\.node\.type === "shape"[\s\S]*?startShapeTextEdit\(selected\.node\.id/);
  assert.match(documentEditor, /hit\.node\.type === "shape"[\s\S]*?startShapeTextEdit\(hit\.id\)/);
  assert.match(documentEditor, /querySelector\("\.fmdoc-shape-label"\)[\s\S]*?liveLabel\.style\.visibility = "hidden"[\s\S]*?editable\.addEventListener\("input"[\s\S]*?liveLabel\.textContent = editable\.textContent/);
  assert.match(documentEditor, /editSession\.liveLabel[\s\S]*?style\.visibility = editSession\.originalLabelVisibility/);
  assert.match(documentEditor, /node\.type === "shape" && can\("text_style"\)[\s\S]*?props\.text_style\.color[\s\S]*?props\.text_align/);
  assert.match(documentRenderer, /fmdoc-shape-label[\s\S]*?props\.text_style[\s\S]*?props\.text_align[\s\S]*?props\.text_valign/);
  assert.match(documentEditor, /ROTATE_SNAP_TOLERANCE_DEG = 4[\s\S]*?Math\.round\(rotation \/ 45\) \* 45[\s\S]*?Math\.abs\(rotation - snap45\)/);
});

test('agent-created pages are reconciled to themed safe areas and canonical flow geometry', () => {
  assert.match(documentEditor, /function reconcileAgentDocument\(doc, agentSource\)[\s\S]*?pageMasterForRole\(theme[\s\S]*?master\.content_inset/);
  assert.match(documentEditor, /const regionFrame = function \(region, safe\)[\s\S]*?safe\.top[\s\S]*?paper\.h_pt - safe\.top - safe\.bottom/);
  assert.match(documentEditor, /parent\.frame\.layout === "flow"[\s\S]*?\{ x: 0, y: 0, layout: "flow" \}[\s\S]*?node\.frame\.h = "auto"/);
  assert.match(documentEditor, /reconcileAgentDocument\(doc, !!\(setOptions && setOptions\.source === "agent"\)\)/);
  assert.match(documentEditor, /generatedRegion[\s\S]*?docPageRegionChainId\(pageId, region\)[\s\S]*?isNew \|\| generatedRegion/);
  assert.match(documentEditor, /state\.doc = reconcileAgentDocument\(state\.doc, false\)/);
  assert.match(documentStudio, /setDocument\?\.\(clone\(docModel\), \{ source: 'agent' \}\)/);
  assert.match(documentProject, /setDocument\?\.\(clone\(docModel\), \{ source: 'agent' \}\)/);
});

test('switching away from Doc clears document-only widget selection chrome', () => {
  assert.match(documentEditor, /function setMode\(next\)[\s\S]*?clearDocWidgetChrome\(\)[\s\S]*?state\.selection = \[\]/);
  assert.match(documentEditor, /function clearDocWidgetChrome[\s\S]*?fmde-doc-object-chrome[\s\S]*?classList\.remove\("fmde-doc-object", "fmde-doc-object-dragging"\)/);
});

test('every editor rerender and host remount preserves the scrolled canvas', () => {
  assert.match(documentEditor, /function preserveCanvasScrollForRender\(\)[\s\S]*?pendingCanvasScrollRestore = \{ left: dom\.canvas\.scrollLeft, top: dom\.canvas\.scrollTop \}/);
  assert.match(documentEditor, /function renderCanvas\(\)[\s\S]*?preserveCanvasScrollForRender\(\)/);
  assert.doesNotMatch(documentEditor, /\^\(widget-\(\?:move\|resize/);
  assert.match(documentEditor, /function restorePendingCanvasScroll\(finalRestore\)[\s\S]*?dom\.canvas\.scrollTop = saved\.top/);
  assert.match(documentEditor, /state\.renderHandle\.update\(renderOpts\);[\s\S]*?restorePendingCanvasScroll\(false\)/);
  assert.match(documentEditor, /function onRenderSettled\(\)[\s\S]*?restorePendingCanvasScroll\(true\)/);
  assert.match(documentEditor, /setDocument: function \(doc, setOptions\) \{\s*preserveCanvasScrollForRender\(\)/);
  assert.match(documentEditor, /function allowExplicitCanvasScroll\(\)[\s\S]*?pendingCanvasScrollRestore = null/);
  assert.match(documentEditor, /prepareExplicitScroll: allowExplicitCanvasScroll/);
  assert.match(visualEditor, /function scrollNodeIntoView\(nodeId\)\{\s*editorHandle\?\.prepareExplicitScroll\?\.\(\)/);
  assert.match(webEditor, /function rememberEditorViewport\(\)[\s\S]*?canvas\.scrollTop[\s\S]*?function restoreEditorViewport\(\)/);
  assert.match(documentProject, /function rememberDocumentViewport\(\)[\s\S]*?canvas\.scrollTop[\s\S]*?function restoreDocumentViewport\(\)/);
});

test('website root fills paint the full editor canvas without rebuilding site chrome on body edits', () => {
  assert.match(documentEditor, /function syncViewCanvasBackground\(\)[\s\S]*?state\.doc\.root\.style\.fill[\s\S]*?canvasStyle\.background/);
  assert.match(documentEditor, /function renderCanvas\(\)[\s\S]*?syncViewCanvasBackground\(\)/);
  assert.doesNotMatch(webEditor, /scheduleAutosave\(\);\s*scheduleSiteChromePreview\(\);/);
});

test('website header and footer previews sit flush with the canvas edges', () => {
  assert.match(webEditorCss, /\.fmwe-site-header-preview\s*\{\s*margin-top:\s*0;\s*\}/);
  assert.match(webEditorCss, /\.fmwe-site-footer-preview\s*\{\s*margin-bottom:\s*0;\s*\}/);
  assert.doesNotMatch(webEditorCss, /\.fmwe-site-(?:header|footer)-preview\s*\{[^}]*margin-(?:top|bottom):\s*36px/);
});

test('website chrome files do not render or offer nested header and footer previews', () => {
  assert.match(webEditor, /function isSiteChromePage\(page = state\.page\)[\s\S]*?role === 'header' \|\| role === 'footer'/);
  assert.match(webEditor, /function siteChromePreviewSnapshot\(\)[\s\S]*?isPortalSite\(\) \|\| isSiteChromePage\(\)[\s\S]*?return \{\}/);
  assert.match(webEditor, /function renderSiteChromePreview\(\)[\s\S]*?isPortalSite\(\) \|\| isSiteChromePage\(\) \|\| !window\.FMDocRenderer/);
  assert.match(webEditor, /\.\.\.\(\(isPortalSite\(\) \|\| isSiteChromePage\(\)\) \? \{\} : \{[\s\S]*?getSiteChromePreview[\s\S]*?siteChromePreview/);
});

test('selecting a website header or footer preview reveals its edit-in-new-tab control', () => {
  assert.match(webEditor, /function siteChromeEditorUrl\(pageId\)[\s\S]*?navigation\.urlFor\(\{[\s\S]*?tab: 'web_editor'[\s\S]*?site: state\.siteId[\s\S]*?page: cleanText\(pageId\)/);
  assert.match(webEditor, /fmwe-site-chrome-shell[\s\S]*?tabindex', '0'[\s\S]*?target = '_blank'[\s\S]*?rel = 'noopener'[\s\S]*?Edit \$\{role\}/);
  assert.match(webEditor, /if \(role === 'header'\) canvas\.insertBefore\(shell, stage\);[\s\S]*?stage\.insertAdjacentElement\('afterend', shell\)/);
  assert.match(webEditorCss, /\.fmwe-site-header-shell \.fmwe-site-chrome-edit\s*\{[\s\S]*?top:\s*100%/);
  assert.match(webEditorCss, /\.fmwe-site-footer-shell \.fmwe-site-chrome-edit\s*\{[\s\S]*?bottom:\s*100%/);
  assert.match(webEditorCss, /\.fmwe-site-chrome-shell:focus-within \.fmwe-site-chrome-edit\s*\{[\s\S]*?opacity:\s*1[\s\S]*?pointer-events:\s*auto/);
});

test('website footer preview follows section height during live resizing', () => {
  assert.match(documentRenderer, /syncLayoutFootprint\(\)[\s\S]*?doc\.kind !== "view"[\s\S]*?state\.scaleWrap\.offsetHeight \* scale/);
  assert.match(documentEditor, /function liveSetFrame\(nodeId, frame, origin, forceAbsolute\)[\s\S]*?flowChild && isStructuralSection\(nodeId\)[\s\S]*?state\.renderHandle\.syncLayoutFootprint\(\)/);
});

test('website root selection outlines the full visible background surface', () => {
  assert.match(documentEditor, /function positionViewRootSelection\(\)[\s\S]*?const inset = 4[\s\S]*?canvas\.clientWidth - inset \* 2[\s\S]*?canvas\.clientHeight - inset \* 2/);
  assert.match(documentEditor, /function drawViewRootSelection\(\)[\s\S]*?state\.selection\[0\] !== state\.doc\.root\.id[\s\S]*?fmde-view-root-selbox[\s\S]*?dom\.canvas\.appendChild\(box\)/);
  assert.match(documentEditor, /dom\.canvas\.addEventListener\("scroll", function \(\) \{ positionViewRootSelection\(\); \}/);
});

test('header and footer option controls remain anchored in document scroll coordinates', () => {
  assert.match(documentEditor, /function showHeaderOptionsChip\(regionEl\)[\s\S]*?const stageRect = dom\.stage\.getBoundingClientRect\(\)[\s\S]*?rect\.bottom - stageRect\.top/);
  assert.match(documentEditor, /dom\.stage\.appendChild\(dom\.headerChip\)/);
  assert.doesNotMatch(documentEditor, /function showHeaderOptionsChip\(regionEl\)[\s\S]*?dom\.root\.appendChild\(dom\.headerChip\)/);
});

test('headers and footers synchronize by base, first-page, and even-page variants', () => {
  const doc = FMDocModel.createBlankDocument();
  const second = FMDocModel.deepClone(doc.pages[0]);
  second.id = FMDocModel.generateId('pg');
  second.name = 'Page 2';
  second.children = FMDocModel.reassignIds(second.children);
  doc.pages.push(second);
  const region = (page, name) => page.children.find((node) => node.props?.page_region === name);
  const header1 = region(doc.pages[0], 'header');
  const header2 = region(doc.pages[1], 'header');
  header1.children[0].props.blocks[0].runs[0].text = 'Original';
  header2.children[0].props.blocks[0].runs[0].text = 'Old peer';
  const engine = FMDocEditor._createCommandEngine({
    M: FMDocModel,
    getDoc: () => doc,
    getFlags: () => FMDocEditor.PROFILE_FLAGS.designer,
    getProfile: () => 'designer'
  });
  const blocks = FMDocModel.deepClone(header1.children[0].props.blocks);
  blocks[0].runs[0].text = 'Shared header';
  assert.equal(engine.apply({ type: 'text.edit', node_id: header1.children[0].id, blocks }).ok, true);
  assert.equal(header2.children[0].props.blocks[0].runs[0].text, 'Shared header');
  assert.equal(engine.undo(), true);
  assert.equal(header2.children[0].props.blocks[0].runs[0].text, 'Old peer');

  const footer1 = region(doc.pages[0], 'footer');
  const footer2 = region(doc.pages[1], 'footer');
  const footerBlocks = FMDocModel.deepClone(footer1.children[0].props.blocks);
  footerBlocks[0].runs[0].text = 'Shared footer';
  assert.equal(engine.apply({ type: 'text.edit', node_id: footer1.children[0].id, blocks: footerBlocks }).ok, true);
  assert.equal(footer2.children[0].props.blocks[0].runs[0].text, 'Shared footer');

  const firstVariant = FMDocModel.reassignIds(header1);
  firstVariant.props.page_region = 'header_first';
  doc.pages[0].children.push(firstVariant);
  const firstBlocks = FMDocModel.deepClone(firstVariant.children[0].props.blocks);
  firstBlocks[0].runs[0].text = 'First page only';
  assert.equal(engine.apply({ type: 'text.edit', node_id: firstVariant.children[0].id, blocks: firstBlocks }).ok, true);
  assert.equal(header1.children[0].props.blocks[0].runs[0].text, 'Original', 'first-page content stays separate from the base header');
  doc.settings.header_options = { different_first: true };
  const third = FMDocModel.createPage('body');
  assert.equal(engine.apply({ type: 'page.insert', page: third }).ok, true);
  assert.ok(region(doc.pages[2], 'header_first'), 'new pages carry active header variants');

  assert.match(documentEditor, /function commandsWithHeaderFooterSync[\s\S]*?header_footer\.sync/);
  assert.match(documentEditor, /function syncedRegionChildren[\s\S]*?preserveIdentity/);
  assert.match(documentEditor, /function ensureHeaderVariantFrames\(suffix\)[\s\S]*?for \(const page of state\.doc\.pages/);
  assert.match(documentEditor, /sourcePageRegionFrame\(doc, region, page\.id\)[\s\S]*?createDocRegionFrame\(display/);
});

test('document widgets use axis-aware resize handles and free-position snapping guides', () => {
  assert.match(documentEditor, /function widgetResizeAxes[\s\S]*?resizeAxes[\s\S]*?horizontal[\s\S]*?x: true, y: false/);
  assert.match(documentEditor, /node\.props\.widget_ref \|\| node\.props\.widget/);
  assert.match(documentEditor, /\["nw", "n", "ne", "e", "se", "s", "sw", "w"\]/);
  assert.match(documentEditor, /fmde-resize-locked[\s\S]*?data-resize-direction[\s\S]*?startDocWidgetResize\(nodeId, widgetEl, direction, event\)/);
  assert.match(documentEditor, /function docWidgetSnapLines[\s\S]*?\.fmdoc-page[\s\S]*?\[data-page-region\][\s\S]*?\[data-block-id\]/);
  assert.match(documentEditor, /snapAdjust\([\s\S]*?SNAP_TOLERANCE_PX[\s\S]*?showDocWidgetGuides/);
  assert.match(documentEditor, /if \(snapLines && !event\.altKey\)/);
  assert.match(documentEditor, /fmde-doc-guide-v[\s\S]*?fmde-doc-guide-h/);
});

test('drag snapping mirrors horizontal gaps only across vertically overlapping elements', () => {
  const movingRight = { x: 304, y: 10, w: 50, h: 50 };
  const middle = { id: 'middle', x: 200, y: 0, w: 50, h: 80 };
  const leftComparison = { id: 'left', x: 100, y: 20, w: 50, h: 30 };
  const rightSnap = FMDocEditor._equalSpacingSnap(movingRight, [middle, leftComparison], 6);
  assert.equal(rightSnap.dx, -4);
  assert.equal(rightSnap.gap, 50);
  assert.equal(rightSnap.startX, 250);
  assert.equal(rightSnap.endX, 300);
  assert.equal(rightSnap.referenceStartX, 150);
  assert.equal(rightSnap.referenceEndX, 200);

  const movingLeft = { x: 96, y: 10, w: 50, h: 50 };
  const rightComparison = { id: 'right', x: 300, y: 20, w: 50, h: 30 };
  const leftSnap = FMDocEditor._equalSpacingSnap(movingLeft, [middle, rightComparison], 6);
  assert.equal(leftSnap.dx, 4);
  assert.equal(leftSnap.startX, 150);
  assert.equal(leftSnap.endX, 200);
  assert.equal(leftSnap.referenceStartX, 250);
  assert.equal(leftSnap.referenceEndX, 300);

  const verticallySeparate = { ...leftComparison, y: 100 };
  assert.equal(FMDocEditor._equalSpacingSnap(movingRight, [middle, verticallySeparate], 6), null);
  assert.match(documentEditor, /function collectSnapLines[\s\S]*?boxes\.push[\s\S]*?function applyEqualSpacingSnap[\s\S]*?equalSpacingSnap[\s\S]*?snap\.equalGap/);
  assert.match(documentEditor, /startSnapRect = movers\.reduce[\s\S]*?applyEqualSpacingSnap\(snapAdjust\(snapBounds/);
  assert.match(documentEditor, /snapBaseBounds = movers\.reduce[\s\S]*?applyEqualSpacingSnap\(snapAdjust\(b/);
  assert.match(documentEditorCss, /\.fmde-guide-gap[\s\S]*?\.fmde-doc-guide-gap/);
  assert.match(documentEditor, /fmde-guide-gap-reference[\s\S]*?referenceStartX[\s\S]*?referenceEndX/);
  assert.match(documentEditor, /fmde-doc-guide-gap-reference[\s\S]*?referenceStartX[\s\S]*?referenceEndX/);
});

test('multi-selection resize snaps the rendered bounding box in page space', () => {
  assert.match(documentEditor, /function resizeMulti[\s\S]*?const measured = overlayBox\(t\.id\)[\s\S]*?const lines = collectSnapLines\(entry\.pageId, state\.selection\)/);
  assert.match(documentEditor, /function resizeMulti[\s\S]*?nearestLine\(lines\.v, edge, tolerance\)[\s\S]*?nearestLine\(lines\.h, edge, tolerance\)/);
  assert.match(documentEditor, /const pageX = o\.x \+ parentOrigin\.x[\s\S]*?originX \+ \(pageX - originX\) \* fw - parentOrigin\.x/);
  assert.match(documentEditor, /function resizeMulti[\s\S]*?showGuides\(entry, guide\)[\s\S]*?clearGuides\(\)/);
});

test('payment widgets keep content-driven height and preview a realistic zero amount', () => {
  assert.match(documentWidgets, /id: "doc\.pay_now"[\s\S]*?resizeAxes: "horizontal"[\s\S]*?heightMode: "content"/);
  assert.match(documentWidgets, /resolvedAmount === null && ctx\.preview === true \? 0 : resolvedAmount/);
  assert.match(documentWidgets, /fmdoc-pay-now-amount[\s\S]*?money\(amount, data\.currency\)/);
  assert.match(documentRenderer, /def\.heightMode === "content"[\s\S]*?elm\.style\.height = "auto"[\s\S]*?data-fmdoc-content-height/);
  const horizontalOnly = FMDocWidgets.list().filter((def) => def.resizeAxes === 'horizontal');
  assert.deepEqual(horizontalOnly.map((def) => def.id), ['doc.pay_now']);
  assert.ok(horizontalOnly.every((def) => def.heightMode === 'content'));
});

test('Delete removes selected document widgets and images without stealing text-field deletion', () => {
  assert.match(documentEditor, /Give a body-selected widget keyboard ownership[\s\S]*?widgetEl\.focus\(\{ preventScroll: true \}\)/);
  assert.match(documentEditor, /state\.docKeyboardObjectId = interactive \? null : nodeId/);
  assert.match(documentEditor, /state\.mode === "doc"[\s\S]*?ev\.key === "Delete" \|\| ev\.key === "Backspace"[\s\S]*?!isFormTarget\(ev\.target\)/);
  assert.match(documentEditor, /if \(state\.imageFocus\)[\s\S]*?image:delete-key[\s\S]*?state\.docKeyboardObjectId && state\.selection\.indexOf\(state\.docKeyboardObjectId\)[\s\S]*?deleteSelection\(\)/);
  assert.match(documentEditor, /function selectDocImage[\s\S]*?setSelection\(\[\], \{ keepInspector: true \}\)[\s\S]*?imgEl\.focus/);
});

test('document text caret and typing clear stale object selection', () => {
  assert.match(documentEditor, /dom\.stage\.addEventListener\("pointerdown"[\s\S]*?const objectHit = [\s\S]*?clearDocObjectSelectionForText\(\);[\s\S]*?\}, true\)/);
  assert.match(documentEditor, /function clearDocObjectSelectionForText[\s\S]*?state\.docKeyboardObjectId = null[\s\S]*?setSelection\(\[\], \{ keepInspector: true \}\)/);
  assert.match(documentEditor, /function onBeforeInput\(ev\)[\s\S]*?const part = editableFrom\(ev\.target\)[\s\S]*?clearDocObjectSelectionForText\(\)/);
});

test('west and north widget resize handles move the dragged edge and preserve it after rendering', () => {
  assert.match(documentEditor, /const freelyPositioned = layout === "front" \|\| layout === "behind"/);
  assert.match(documentEditor, /flowOffsetX = num\(widgetConfig\._fm_flow_resize_offset_x, 0\)/);
  assert.match(documentEditor, /if \(useW\) widgetEl\.style\.left = last\.x \+ "pt"/);
  assert.match(documentEditor, /if \(useN\) widgetEl\.style\.top = last\.y \+ "pt"/);
  assert.match(documentEditor, /props\.config\._fm_flow_resize_offset_x", value: roundPt\(last\.x\)/);
  assert.match(documentRenderer, /flow projection may normalize frame coordinates[\s\S]*?_fm_flow_resize_offset_x[\s\S]*?elm\.style\.left = pt\(offsetX\)/);
});

test('document widget resize edges snap and remain visible outside flow text frames', () => {
  assert.match(documentEditor, /function nearestDocWidgetSnap[\s\S]*?SNAP_TOLERANCE_PX/);
  assert.match(documentEditor, /const snapLines = docWidgetSnapLines\(widgetEl\)[\s\S]*?const xEdge = useW[\s\S]*?nearestDocWidgetSnap\(xEdge, snapLines\.v\)/);
  assert.match(documentEditor, /const yEdge = useN[\s\S]*?nearestDocWidgetSnap\(yEdge, snapLines\.h\)/);
  assert.match(documentEditor, /if \(snapLines && !event\.altKey\)[\s\S]*?showDocWidgetGuides\(snapLines, snap\)/);
  assert.match(documentEditorCss, /\.fmde-mode-doc \[data-chain\],[\s\S]*?overflow: visible !important/);
});

test('page setup supports sizes, orientation, presets, and four independent margins', () => {
  assert.match(documentEditor, /Letter \(8\.5 × 11 in\)[\s\S]*?Legal \(8\.5 × 14 in\)[\s\S]*?A4/);
  assert.match(documentEditor, /data-margin-top[\s\S]*?data-margin-bottom[\s\S]*?data-margin-left[\s\S]*?data-margin-right/);
  assert.match(documentEditor, /data-margin-preset="normal"[\s\S]*?data-margin-preset="narrow"[\s\S]*?data-margin-preset="wide"/);
});

test('download and page-number commands expose format choices', () => {
  assert.match(documentEditor, /PDF document \(\.pdf\)[\s\S]*?Microsoft Word \(\.doc\)[\s\S]*?Plain text \(\.txt\)[\s\S]*?FirstMate source \(\.json\)/);
  assert.match(documentEditor, /function showPageNumbers\(\)[\s\S]*?data-pn-position[\s\S]*?data-pn-align[\s\S]*?data-pn-format[\s\S]*?data-pn-start/);
});

test('Insert routes signatures through the shared icon-backed Widgets section', () => {
  assert.match(documentEditor, /label: "Media…"[\s\S]*?label: "Widget"[\s\S]*?label: "Table"[\s\S]*?label: "Audio…"/);
  assert.doesNotMatch(documentEditor, /label: "eSignature field"/);
  assert.match(documentEditor, /function widgetMenuItems\(\)[\s\S]*?def\.id !== "doc\.video"[\s\S]*?icon: def\.icon \|\| "fa-puzzle-piece"/);
  assert.match(documentEditor, /const section = sectionEl\("Widgets"\)[\s\S]*?iconSvg\(def\.icon \|\| "fa-puzzle-piece"\)/);
  assert.match(documentEditor, /function catalogWidgets\(\)[\s\S]*?root\.FMDocWidgets[\s\S]*?defaults: def\.defaults \|\| registered\.defaults/);
  assert.match(documentEditor, /mediaKind: "audio"[\s\S]*?doc\.audio@1/);
});

test('signature widgets cannot collect signatures inside an editable document', () => {
  assert.match(documentEditor, /const widgetContext = \{[\s\S]*?preview: true,[\s\S]*?authoring: true/);
  assert.match(documentRenderer, /preview: rctx\.preview === true,[\s\S]*?authoring: rctx\.authoring === true/);
  assert.match(documentRenderer, /preview: widgetContext\.preview === true,[\s\S]*?authoring: widgetContext\.authoring === true/);
  assert.match(documentWidgets, /renderInteractive\(el, ctx\)[\s\S]*?ctx\.authoring === true[\s\S]*?Customer signs after sending[\s\S]*?aria-disabled[\s\S]*?return \{\}[\s\S]*?Click to sign/);
  assert.match(documentRenderer, /fmdoc-signature--inactive \.fmdoc-signature-cta[\s\S]*?var\(--fmdoc-muted\)/);
});

test('Visual editor centers page thumbnails and lists document widgets with catalog icons', () => {
  assert.match(visualEditor, /\.fmwe-ch-pstrip \{[\s\S]*?justify-content: safe center/);
  assert.match(visualEditor, /const catalogDocumentWidgets = arrayValue\(objectValue\(opts\.catalog\)\.widgets\)[\s\S]*?global\.FMDocWidgets\?\.list[\s\S]*?startsWith\('doc\.'\)/);
  assert.match(visualEditor, /icon: firstText\(documentWidgetIcons\[widgetId\], registered\.icon, def\.icon, 'fa-puzzle-piece'\)/);
  assert.match(visualEditor, /contentKind === 'document' \? documentWidgets/);
  assert.match(visualEditor, /id: 'widgets', label: 'Widgets', icon: 'fa-puzzle-piece'/);
  assert.match(visualEditor, /contentKind !== 'document'[\s\S]*?id !== 'widgets'/);
  assert.match(visualEditor, /state\.chromeTab === 'widgets'\) renderWidgetsPanel\(body\)/);
  assert.match(visualEditor, /function renderWidgetsPanel\(body\)[\s\S]*?data-ch-widget-search[\s\S]*?data-ch-widget-item/);
  assert.match(visualEditor, /function renderElementsPanel\(body\)[\s\S]*?const cats = elementCategories\(\)/);
  assert.doesNotMatch(visualEditor, /id: 'qr', label: 'QR codes'/);
  assert.match(visualEditor, /id: 'el_qr_widget', name: 'QR code'[\s\S]*?doc\.qr/);
});

test('widget palette uses uniform labeled square tiles and distinct canonical icons', () => {
  assert.match(visualEditor, /\.fmwe-ch-widgetgrid \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)[\s\S]*?\.fmwe-ch-widgetgrid \.fmwe-ch-el \{[\s\S]*?aspect-ratio: 1 \/ 1/);
  assert.match(visualEditor, /function renderWidgetsPanel\(body\)[\s\S]*?fmwe-ch-widget-icon[\s\S]*?fmwe-ch-widget-name/);
  assert.doesNotMatch(visualEditor, /data-ch-widget-item="\$\{esc\(item\.id\)\}" data-ch-el-span=/);
  assert.match(visualEditor, /const documentWidgetIcons = \{[\s\S]*?'doc\.line_items': 'fa-receipt'[\s\S]*?'doc\.signature': 'fa-file-signature'[\s\S]*?'doc\.form_field': 'fa-pen-to-square'[\s\S]*?'doc\.choice_group': 'fa-square-check'/);
});

test('single photos and videos stay in Media while composite photo widgets stay in Widgets', () => {
  assert.doesNotMatch(documentApi, /\{ id: "doc\.(?:photo|video)",/);
  assert.match(documentApi, /id: "doc\.photo_grid"[\s\S]*?id: "doc\.photo_carousel"/);
  assert.match(visualEditor, /id !== 'doc\.photo' && id !== 'doc\.video'/);
  assert.match(documentEditor, /def\.id !== "doc\.photo" && def\.id !== "doc\.video"/);
  assert.doesNotMatch(visualEditor, /id: 'el_photo_widget'/);
  assert.doesNotMatch(visualEditor, /id: 'el_photo_grid'/);
  assert.match(visualEditor, /id: 'media'[\s\S]*?id: 'el_image'[\s\S]*?id: 'el_video'/);
  assert.ok(FMDocWidgets.get('doc.photo', 1), 'legacy photo widgets must remain renderable');
  assert.ok(FMDocWidgets.get('doc.video', 1), 'legacy video widgets must remain renderable');
  const carousel = FMDocWidgets.get('doc.photo_carousel', 1);
  assert.equal(carousel?.title, 'Photo carousel');
  assert.match(documentWidgets, /id: "doc\.photo_carousel"[\s\S]*?renderInteractive\(el, ctx\)/);
  assert.match(documentRenderer, /\.fmdoc-photo-carousel[\s\S]*?\.fmdoc-photo-carousel-dots/);
});

test('keyboard shortcut help is grouped, searchable, and uses keycaps', () => {
  assert.match(documentEditor, /General[\s\S]*?Editing[\s\S]*?Text formatting[\s\S]*?Paragraphs[\s\S]*?Insert & navigate/);
  assert.match(documentEditor, /fmde-shortcut-search[\s\S]*?<kbd>/);
});

test('Page Setup is a wide responsive page-style workspace with readable actions', () => {
  assert.match(documentEditor, /fmde-page-setup-dialog\{width:min\(920px/);
  assert.match(documentEditor, /fmde-page-margin-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(documentEditor, /button\.primary\{background:var\(--fmde-accent,#2563eb\)!important;color:var\(--fmde-on-accent,#fff\)!important/);
  assert.match(documentEditor, /thm_triangles[\s\S]*?thm_margin[\s\S]*?thm_clean/);
  assert.match(documentEditor, /<h3>Page style<\/h3>/);
  assert.match(documentEditor, /Triangles[\s\S]*?Left border[\s\S]*?Simple/);
  assert.match(documentEditor, /type: "theme\.apply"[\s\S]*?theme_ref/);
  assert.match(documentEditor, /data-theme-id[\s\S]*?page-style/);
});

test('selecting a page style applies its content inset to Page Setup', () => {
  assert.match(documentEditor, /function \(theme, fallback\)[\s\S]*?definition\.page_masters[\s\S]*?master\.content_inset/);
  assert.match(documentEditor, /thm_triangles[\s\S]*?margins_pt: \{ top: 104, right: 64, bottom: 104, left: 64 \}/);
  assert.match(documentEditor, /thm_margin[\s\S]*?margins_pt: \{ top: 48, right: 48, bottom: 48, left: 104 \}/);
  assert.match(documentEditor, /thm_clean[\s\S]*?margins_pt: \{ top: 80, right: 48, bottom: 48, left: 48 \}/);
  assert.match(documentEditor, /const applyStyleSetupToDialog = function \(setup\)[\s\S]*?data-margin-[\s\S]*?style\.setup/);
});

test('Page Setup presents page color as a compact swatch and show toggle', () => {
  assert.match(documentEditor, /fmde-page-color-row[\s\S]*?fmde-page-color-swatch[\s\S]*?data-page-color-show> Show page color/);
  assert.match(documentEditor, /fmde-dialog \.fmde-page-color-swatch\{width:38px!important;min-width:38px;height:38px/);
  assert.match(documentEditor, /const syncPageColor = function \(\)[\s\S]*?pageColorInput\.disabled = !shown/);
  assert.match(documentEditor, /data-page-color-show[^\n]*?checked \? dialog\.querySelector\("\[data-page-color\]"\)\.value : null/);
});

test('Page Setup margin inputs display at most two decimal places', () => {
  assert.match(documentEditor, /const formatMarginInches = function \(points\)[\s\S]*?Math\.round[\s\S]*?\* 100\) \/ 100/);
  assert.match(documentEditor, /step="0\.01" data-margin-top[\s\S]*?step="0\.01" data-margin-right/);
  assert.match(documentEditor, /data-margin-" \+ side \+ "\]"\)\.value = formatMarginInches\(margins\[side\]\)/);
  assert.match(documentEditor, /data-margin-" \+ side \+ "\]"\)\.value = formatMarginInches\(inset\[side\]\)/);
});

test('Media opens the picker directly and Symbols use a large grid', () => {
  assert.match(documentEditor, /kind === "media" \|\| kind === "audio"\) \{ const pickerItem = items\[0\]; if \(pickerItem && pickerItem\.onClick\) pickerItem\.onClick\(\); return; \}/);
  assert.match(documentEditor, /submenuClass: "fmde-symbol-menu"/);
  assert.match(documentEditor, /fmde-symbol-menu\{display:grid;grid-template-columns:repeat\(5,42px\)/);
});

test('shortcut reference uses responsive multi-column layouts', () => {
  assert.match(documentEditor, /fmde-shortcut-list\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(documentEditor, /min-width:1180px[\s\S]*?fmde-shortcut-list\{grid-template-columns:repeat\(3/);
});

test('editor actions inherit organization branding with accessible contrast', () => {
  assert.match(documentEditor, /function editorBrandingPalette\(\)[\s\S]*?colors\.primary[\s\S]*?branding\.primary/);
  assert.match(documentEditor, /function contrastRatio\(a, b\)[\s\S]*?lighter \+ 0\.05/);
  assert.match(documentEditor, /setProperty\("--fmde-accent", palette\.primary\)[\s\S]*?setProperty\("--fmde-on-accent", palette\.foreground\)/);
  assert.match(documentEditor, /applyEditorBranding\(el\("div", \{ class: "fmde-dialog-backdrop"/);
  assert.match(documentEditor, /applyEditorBranding\(el\("div", \{ class: "fmde-menu/);
});
