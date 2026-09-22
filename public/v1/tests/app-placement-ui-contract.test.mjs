import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [core, manifest, settings, platformApi, accountSwitcher, capabilityDefs, capabilities] = await Promise.all([
  readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/platform-api/platform-api.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/account-switcher/account-switcher.js'), 'utf8'),
  readFile(path.join(publicRoot, 'v1/platform/capability_defs.ts'), 'utf8'),
  readFile(path.join(publicRoot, 'v1/platform/capabilities.ts'), 'utf8')
]);

test('org app placement drives sidebar, advanced app-menu, Settings, and hidden projections', () => {
  assert.match(platformApi, /updatePlacements\(orgId, placements/);
  assert.match(platformApi, /app_placements/);
  assert.match(core, /\['sidebar', 'more', 'settings', 'hidden'\]/);
  assert.match(core, /requested === 'more'\) return advancedAppMenuEnabled\(\) \? 'more' : 'sidebar'/);
  assert.match(core, /\.placement === 'sidebar'/);
  assert.match(core, /source:'settings-launcher'/);
  assert.match(core, /appId === 'portal\.company_settings'[^\n]+configured === 'hidden' \? 'hidden' : 'settings'/);
});

test('advanced app menu is feature-flagged and supports animated sidebar pinning', () => {
  assert.match(capabilityDefs, /key: "platform\.advanced_app_menu"[\s\S]{0,400}label: "Advanced App Menu"[\s\S]{0,400}default: false/);
  assert.match(core, /capabilities\.value\?\.\('platform\.advanced_app_menu', false\) === true/);
  assert.match(core, /fm-advanced-apps-overlay/);
  assert.doesNotMatch(core, /fm-advanced-apps-inactive/);
  assert.doesNotMatch(core, /aria-label="Inactive apps"/);
  assert.match(core, /data-advanced-app-pin/);
  assert.match(core, /data-sidebar-app-pin/);
  assert.match(core, /placements\[normalizedId\] = pinned \? 'sidebar' : 'more'/);
  assert.match(core, /@keyframes fmAdvancedAppsPanelIn/);
  assert.match(core, /@keyframes fmSidebarPinIn/);
  assert.match(core, /sidebar-advanced-apps-open/);
  assert.match(core, /fm-advanced-apps-overlay\{[^}]+background:rgba\(3,8,18,\.86\)/);
  assert.doesNotMatch(core, /fm-advanced-apps-overlay\{[^}]+backdrop-filter/);
  assert.match(core, /pinned: !!\(appId && tabId && placement === 'sidebar'\)/);
  assert.match(core, /Number\(b\.pinned\) - Number\(a\.pinned\)/);
  assert.match(core, /fm-advanced-apps-panel\{[^}]+background:transparent[^}]+box-shadow:none/);
  assert.match(core, /fm-advanced-app-pin\{[^}]+opacity:0[^}]+pointer-events:none/);
  assert.match(core, /fm-advanced-app-pin\.is-pinned\{[^}]*opacity:1[^}]+pointer-events:auto/);
  assert.match(core, /fm-advanced-app-tile\.is-unpinned:hover>\.fm-advanced-app-pin[^\{]*\{[^}]*visibility:visible[^}]+opacity:1[^}]+pointer-events:auto/);
  assert.doesNotMatch(core, /fm-advanced-app-setup-flag|data-advanced-app-setup/);
  assert.match(core, /function normalizeAppStatusPills\(/);
  assert.match(core, /statusPills: normalizeAppStatusPills\(node\.status_pills, manifestApp\?\.statusPills, runtimeApp\?\.statusPills\)/);
  assert.match(core, /fm-advanced-app-status-pills/);
  assert.match(core, /data-status-pill=/);
  assert.match(core, /fm-advanced-app-status-pills\{[^}]+top:var\(--fm-advanced-control-inset[^}]+right:var\(--fm-advanced-control-inset/);
  assert.match(core, /fm-advanced-app-pin\{[^}]+top:var\(--fm-advanced-control-inset[^}]+left:var\(--fm-advanced-control-inset/);
  assert.match(core, /const fitAppGrid = \(\) =>/);
  assert.match(core, /for \(let columns = 1; columns <= count; columns \+= 1\)/);
  assert.match(core, /const gapRatio = 0\.5/);
  assert.match(core, /const edgeRatio = 1/);
  assert.match(core, /width \/ \(columns \+ gapRatio \* Math\.max\(0, columns - 1\) \+ edgeRatio \* 2\)/);
  assert.match(core, /height \/ \(rows \+ gapRatio \* Math\.max\(0, rows - 1\) \+ edgeRatio \* 2\)/);
  assert.match(core, /const gap = Math\.max\(1, Math\.round\(tile \* gapRatio\)\)/);
  assert.match(core, /const tile = Math\.max\(1, Math\.floor\(Math\.min\(best\.tile, tileCap\)\)\)/);
  assert.match(core, /--fm-advanced-columns/);
  assert.match(core, /--fm-advanced-tile-size/);
  assert.match(core, /--fm-advanced-icon-size', `\$\{Math\.round\(tile \* 0\.54\)\}px`/);
  assert.match(core, /new ResizeObserver\(syncAdvancedAppLayout\)/);
  assert.match(core, /fm-advanced-apps-scroll\{[^}]+overflow:hidden/);
  assert.match(core, /fm-advanced-apps-grid\{[^}]+grid-template-columns:repeat\(var\(--fm-advanced-columns[^}]+align-content:center[^}]+padding:var\(--fm-advanced-tile-size/);
  assert.match(core, /fm-advanced-app-tile\{[^}]+width:var\(--fm-advanced-tile-size[^}]+height:var\(--fm-advanced-tile-size[^}]+border-radius:var\(--fm-advanced-tile-radius[^}]+background:#f2f4f7/);
  assert.match(core, /fm-advanced-app-icon-wrap\{[^}]+width:var\(--fm-advanced-icon-size[^}]+height:var\(--fm-advanced-icon-size/);
  assert.match(core, /fm-advanced-app-open strong\{[^}]+white-space:normal[^}]+overflow-wrap:anywhere[^}]+font-size:var\(--fm-advanced-label-size/);
  assert.match(core, /fm-advanced-app-pin\{[^}]+background:transparent;color:#667085[^}]+visibility:hidden[^}]+opacity:0/);
  assert.match(core, /fm-advanced-app-pin\.is-pinned\{[^}]+background:#344054;color:#fff[^}]+box-shadow:/);
  assert.match(core, /fm-advanced-app-tile\.is-unpinned:hover>\.fm-advanced-app-pin[^\{]*\{[^}]+background:transparent;color:#667085;box-shadow:none/);
  assert.match(core, /fm-advanced-app-pin:not\(\.is-pinned\):hover[^\{]*\{background:transparent;color:#475467/);
  assert.doesNotMatch(core, /fm-advanced-app-open strong\{[^}]+text-overflow:ellipsis/);
  assert.match(core, /fm-advanced-apps-close\{[^}]+top:calc\(-1 \* clamp\([^}]+right:calc\(-1 \* clamp/);
  assert.match(core, /fm-advanced-apps-panel>footer\{[^}]*position:absolute[^}]+right:calc\(-1 \* clamp[^}]+bottom:calc\(-1 \* clamp/);
  assert.match(core, /entry\.setup\?\.mode === 'required' && entry\.setup\?\.status !== 'complete'/);
  assert.match(core, /openAppCatalogModal\(entry\.key, \{ source:'advanced-app-menu', preserveAdvancedMenu:true \}\)/);
  assert.match(core, /fm-app-catalog-overlay\.is-over-advanced-apps\{[^}]+--fm-app-catalog-sidebar-edge[^}]+background:rgba\(3,8,18,\.58\)/);
  assert.match(core, /options\.preserveAdvancedMenu === true && advancedAppMenuOpen && advancedAppMenuOverlay/);
  assert.match(core, /fm-app-catalog-modal\{[^}]+z-index:1/);
  assert.doesNotMatch(core, /Open an app or choose which ones stay pinned/);
  assert.doesNotMatch(core, /entry\.placement === 'more' \? 'App menu' : 'Pinned'/);
});

test('the capability registry declares which apps the add-apps catalog may offer', () => {
  assert.match(capabilities, /discoverable\?: boolean/);
  assert.match(capabilities, /discoverable: definition\.discoverable !== false/);
  assert.match(capabilities, /catalog_stub: cleanText\(definition\.catalog_stub\)/);
  assert.match(core, /stub: node\.catalog_stub \|\| node\.description/);
  // App nodes carry a catalog icon: disabled apps have no registered runtime
  // surface to borrow one from.
  assert.match(capabilities, /icon: cleanText\(definition\.icon\)/);
  assert.match(capabilityDefs, /icon: "fa-calendar-days"/);
  assert.match(core, /cleanText\(node\.icon\) \|\| cleanText\(runtimeApp\?\.icon\)/);
  // Deprecated and system apps are never advertised.
  assert.match(capabilityDefs, /key: "platform\.proposals"[\s\S]{0,500}discoverable: false/);
  assert.match(capabilityDefs, /key: "apps\.billing"[\s\S]{0,500}discoverable: false/);
});

test('the app launcher opens the add-apps catalog only while apps remain available', () => {
  assert.match(core, /const catalogApps = appCatalogEntries\(\)\.filter\(\(entry\) => entry\.addable\)/);
  assert.match(core, /const hasMoreApps = catalogApps\.length > 0/);
  assert.match(core, /const launcherLabel = hasMoreApps \? 'More apps' : 'Apps'/);
  assert.doesNotMatch(core, /tab\.placement === 'more'/);
  assert.match(core, /const split = !!settingsTab/);
  assert.match(core, /fm-more-apps-grid/);
  assert.match(core, /data-catalog-app/);
  assert.match(core, /fm-more-apps-empty/);
  assert.match(core, /data-more-apps-manage/);
  assert.match(core, /settingsView:'manage_apps'/);
  assert.match(core, /source:'more-apps'/);
  assert.match(core, /if \(!hasMoreApps\)[\s\S]{0,500}source:'apps-launcher'/);
});

test('the app catalog joins discoverable capability app nodes with manifest presentation', () => {
  assert.match(core, /node\.kind === 'app' && node\.discoverable !== false/);
  assert.match(core, /app\?\.access\?\.capability === capabilityKey/);
  assert.match(core, /window\.Portal\.appCatalog = \{/);
  assert.match(core, /window\.Portal\.appSetup = \{/);
  // Enabling an app pulls in any off parents/requires so it lands working.
  assert.match(core, /function appCatalogEnableValues\(capabilityKey\)/);
  assert.match(manifest, /const appCapabilities = \{/);
});

test('clicking a catalog app opens the detail modal with Add to Platform', () => {
  assert.match(core, /fm-app-catalog-modal/);
  assert.match(core, /width:min\(1120px,100%\)/);
  assert.match(core, /fm-app-catalog-preview/);
  assert.match(core, /@media\(max-width:720px\)/);
  assert.match(core, /height:100dvh/);
  assert.match(core, /data-app-catalog-add/);
  assert.match(core, /Add to Platform/);
  assert.match(core, /data-app-catalog-remove/);
  assert.match(core, /Portal\?\.modals\?\.register\?\.\(overlay, \{\s*\n?\s*id: `app-catalog:\$\{entry\.key\}`/);
  assert.match(core, /launchCatalogApp\(entry/);
  assert.match(core, /appSetupHandlers\.get\(entry\.key\)/);
});

test('compact sidebar stacks launcher buttons', () => {
  assert.match(core, /sidebar-compact[^\n]+sidebarBottomLinks\.sidebar-launchers-split\{grid-template-columns:1fr;grid-template-rows:auto 1px auto/);
  assert.match(core, /sidebar-compact[^\n]+sidebarBottomLinks\.sidebar-launchers-integrated\{flex-direction:column;gap:4px;padding-bottom:15px/);
});

test('a single Settings control reuses the normal sidebar app row without launcher chrome', () => {
  assert.match(core, /item\.className = 'fm-link bottom'/);
  assert.match(core, /item\.innerHTML = `<div class="ic">/);
  assert.match(core, /#sidebarBottomLinks\.sidebar-launchers-single\{flex-direction:column;align-items:stretch\}/);
  assert.doesNotMatch(core, /createElement\('div'\)[\s\S]{0,100}sidebar-app-launchers/);
  assert.doesNotMatch(core, /sidebar-launcher-icon:hover/);
  assert.match(core, /#sidebarBottomLinks \.sidebar-launcher-icon\.active\{color:#6b7280\}/);
  assert.match(core, /#sidebarBottomLinks>\.fm-link\.active[^}]+color:#333/);
});

test('split launchers center Settings and More Apps in equal halves', () => {
  assert.match(core, /grid-template-columns:minmax\(0,1fr\) 1px minmax\(0,1fr\)/);
  assert.match(core, /container\.append\(settingsButton, divider, moreButton, popover\)/);
  assert.match(core, /sidebar-launcher-icon\{[^}]+justify-self:center[^}]+color:#6b7280/);
  assert.match(core, /sidebar-launchers-split \+ \.sidebar-footer\{margin-top:-6px;padding-top:7px\}/);
});

test('More Apps opens as an animated catalog with larger tiles and a Manage link', () => {
  assert.match(core, /More FirstMate apps/);
  assert.match(core, /@keyframes fmMoreAppsOpen/);
  assert.match(core, /@keyframes fmMoreAppsClose/);
  assert.match(core, /\.fm-more-apps-popover\.closing\{animation:fmMoreAppsClose/);
  assert.match(core, /transform-origin:75% 100%/);
  assert.match(core, /width:340px/);
  assert.match(core, /fm-more-apps-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(core, /if \(count <= 3\) return Math\.max\(1, count\);[\s\S]{0,300}if \(count === 4\) return 2;[\s\S]{0,300}if \(count <= 9\) return 3;[\s\S]{0,300}if \(count <= 16\) return 4;[\s\S]{0,300}if \(count <= 19\) return 5;[\s\S]{0,300}if \(count <= 23\) return 6;[\s\S]{0,100}return 7;/);
  assert.match(core, /maximumColumns = Math\.max\(1, Math\.floor/);
  assert.match(core, /rows = Math\.max\(1, Math\.ceil\(catalogApps\.length \/ columns\)\)/);
  assert.match(core, /--fm-more-app-columns', String\(columns\)/);
  assert.match(core, /--fm-more-apps-caret-left/);
  assert.match(core, /@media\(min-width:821px\)[\s\S]{0,700}\.fm-more-apps-popover[^}]+position:fixed[^}]+left:var\(--fm-more-apps-left,16px\)[^}]+bottom:var\(--fm-more-apps-bottom,70px\)[^}]+width:var\(--fm-more-apps-width[^}]+height:var\(--fm-more-apps-height,640px\)/);
  assert.match(core, /\.fm-more-apps-popover:not\(\[hidden\]\)\{display:flex\}/);
  assert.doesNotMatch(core, /sidebar-compact[^,{]+\.fm-more-apps-popover\{[^}]*display:flex/);
  assert.match(core, /\.fm-more-apps-popover:before[^}]+--fm-more-apps-caret-left/);
  assert.match(core, /const tileHeight = 116/);
  assert.match(core, /@media\(min-width:821px\)[\s\S]{0,1800}\.fm-more-apps-grid\{flex:1;grid-template-columns:repeat\(var\(--fm-more-app-columns,7\),minmax\(0,1fr\)\)[^}]+grid-auto-rows:minmax\(116px,1fr\)[^}]+overflow-y:auto/);
  assert.match(core, /@media\(min-width:821px\)[\s\S]{0,1800}\.fm-more-app\{min-height:116px;padding:6px 8px/);
  assert.match(core, /@media\(max-width:820px\)[^}]+width:min\(340px,calc\(100vw - 56px\)\)/);
  assert.match(core, /fm-more-app-icon\{width:52px;height:52px[^}]+font-size:22px/);
  assert.match(core, /fm-more-app-desc/);
  assert.match(core, /fm-more-app-desc\{[^}]+-webkit-line-clamp:2[^}]+overflow:hidden/);
  assert.match(core, /fm-nine-dot-icon[^}]+radial-gradient[^}]+background-size:5px 5px/);
  assert.doesNotMatch(core, /fa-grip/);
  assert.match(core, /data-more-apps-close aria-label="Close"/);
  assert.match(core, /settingsButton\.addEventListener\('click',[\s\S]{0,100}closeMoreApps\(\)/);
});

test('the optional integrated footer uses Settings, More Apps, and User icons with animated account chrome', () => {
  assert.match(capabilityDefs, /key: "platform\.separate_user_section"[\s\S]{0,500}default: false/);
  assert.match(core, /capabilities\.value\?\.\('platform\.separate_user_section', false\) === true/);
  assert.match(core, /if \(accountButton && accountFooter && container\.contains\(accountButton\)\) accountFooter\.appendChild\(accountButton\);[\s\S]{0,80}container\.innerHTML = ''/);
  assert.match(core, /if \(split && !integratedUser\) \{[\s\S]{0,120}sidebar-launcher-divider/);
  assert.match(core, /sidebar-launchers-integrated\{display:flex;flex-direction:row[^}]+border-top:/);
  assert.match(core, /launchers = \[settingsButtonRef, moreButtonRef, accountButton\]\.filter\(Boolean\)/);
  assert.match(core, /sidebar-scroll:has\(#sidebarBottomLinks\.sidebar-launchers-integrated\)\{padding-bottom:env\(safe-area-inset-bottom,0px\)/);
  assert.match(core, /sidebar-launchers-integrated\{[^}]+padding:7px 0/);
  assert.match(core, /sidebar-launcher-icon\{display:grid;place-items:center/);
  assert.match(core, /launchers\.forEach\(\(launcher, index\) => \{[\s\S]{0,260}row\.push\(divider\)[\s\S]{0,120}row\.push\(launcher\)/);
  assert.match(core, /fa-user fm-account-launcher-user/);
  assert.match(core, /sidebar-user-integrated\{display:none!important\}/);
  assert.doesNotMatch(core, /if \(bottomLinks\) bottomLinks\.innerHTML = ''/);
  assert.match(accountSwitcher, /@keyframes fmAccountSwitcherOpen/);
  assert.match(accountSwitcher, /@keyframes fmAccountSwitcherClose/);
  assert.match(accountSwitcher, /fm-account-switcher-menu\.closing\{animation:fmAccountSwitcherClose/);
  assert.match(accountSwitcher, /this\.menu\.classList\.add\('closing'\)/);
});

test('every unmounted portal tab uses the shared full-surface loading state', () => {
  assert.match(core, /function portalTabLoadingMarkup\(options = \{\}\)/);
  assert.match(core, /\.fm-tab-loading\{width:100%;height:100%;min-height:220px;display:grid;place-content:center/);
  assert.match(core, /window\.Portal\.ui = \{[\s\S]{0,160}tabLoading: \{[\s\S]{0,120}markup: portalTabLoadingMarkup/);
  assert.doesNotMatch(core, /window\.Portal\.ui\.tabLoading = \{/);
  assert.match(core, /showPortalTabLoading\(panelEl, \{ title:`Loading \$\{terminologyLabel\(t\.terminologyKey, t\.title\)\}…`/);
  assert.match(settings, /tabLoading\?\.show\?\.\(panel, \{ title:'Loading Settings…', detail:'Opening your settings\.' \}\)/);
  assert.match(settings, /const hostedMoneyLoadingMarkup = \(label = 'Money'\) =>/);
  assert.match(settings, /tabLoading\?\.markup\?\.\(\{[\s\S]{0,120}title,[\s\S]{0,240}overlay:true/);
});

test('settings-capable apps declare their settings destination', () => {
  for (const settingsTab of ['contacts', 'documents', 'scheduling', 'equipment', 'payroll', 'channels']) {
    assert.match(manifest, new RegExp(`settingsTabId: '${settingsTab}'`));
  }
  assert.match(manifest, /portal\.company_settings[\s\S]*?placement: 'settings'/);
  assert.match(settings, /const canEquipment = canCompany && appFlag\('apps', 'equipment'\);/);
});

test('Equipment settings remain in Company Settings regardless of app placement', () => {
  const equipmentGate = settings.match(/const canEquipment = ([^;]+);/)?.[1] || '';
  assert.match(equipmentGate, /canCompany/);
  assert.match(equipmentGate, /appFlag\('apps', 'equipment'\)/);
  assert.doesNotMatch(equipmentGate, /appBelongsInSettings/);
  assert.match(settings, /FirstMateEquipmentSettings\.mount\(paneEquipment/);
  assert.match(manifest, /portal\.equipment[\s\S]*?settingsTabId: 'equipment'/);
});

test('Company Settings gates optional tabs and report branding behind capabilities', () => {
  assert.match(settings, /canCustomFields = canCompany && appFlag\('platform', 'custom_fields'\)/);
  assert.match(settings, /canTerminology = canCompany && appFlag\('platform', 'terminology_settings'\)/);
  assert.match(settings, /canScopeFlags = canCompany && appFlag\('apps', 'projects'\)/);
  assert.match(settings, /canDomains = canCompany && appFlag\('apps', 'web_editor'\) && appFlag\('web_editor', 'custom_domains'\)/);
  assert.match(settings, /company-settings-grid \$\{reportsEnabled \? '' : 'without-report-preview'\}/);
  assert.match(settings, /\$\{reportsEnabled \? `<aside class="company-document-preview">/);
  const mySettingsRenderer = settings.slice(settings.indexOf('async function renderMySettings()'), settings.indexOf('function renderCrmSettings()'));
  assert.doesNotMatch(mySettingsRenderer, /paneScopeTemplates|draftDefinition|scopeScheduling/);
});

test('co-branding defaults on while the separate user section defaults off', () => {
  assert.match(capabilityDefs, /key: "platform\.cobrand_sidebar_logo"[\s\S]{0,400}default: true/);
  assert.match(capabilityDefs, /key: "platform\.separate_user_section"[\s\S]{0,400}default: false/);
});

test('Manage My Apps is a Features & Apps sub-tab rendered from the shared catalog', () => {
  assert.doesNotMatch(settings, /id="csTabManageApps"/);
  assert.match(settings, /data-cap-view="manage_apps"/);
  assert.match(settings, /capabilityUi\.view === 'manage_apps'[^\n]+renderManageApps\(body\)/);
  assert.match(settings, /function renderManageApps\(target\)/);
  assert.match(settings, /window\.Portal\?\.appCatalog\?\.list\?\.\(\)/);
  assert.match(settings, /data-manage-app=/);
  assert.match(settings, /appCatalog\?\.open\?\./);
  // Deep-linkable: the popup's Manage link routes here via settingsView.
  assert.match(settings, /'manage_apps', 'app_locations', 'presets', 'permissions'\]\.includes\(routedCapView\)/);
});

test('App Locations offers sidebar and settings only; legacy more projects onto sidebar', () => {
  assert.doesNotMatch(settings, /id="csTabAppLocations"/);
  assert.match(settings, /data-cap-view="app_locations"/);
  assert.match(settings, /capabilityUi\.view === 'app_locations'[^\n]+renderAppLocations\(body\)/);
  assert.match(settings, /function renderAppLocations\(target\)/);
  assert.match(settings, /locationButton\('sidebar', 'Left column'\)/);
  assert.match(settings, /locationButton\('settings', 'Settings'/);
  assert.doesNotMatch(settings, /locationButton\('more'/);
  assert.match(settings, /configured === 'more' \? 'sidebar' : configured/);
  assert.match(settings, /app-location-list\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(settings, /app-location-options\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(settings, /data-placement="\$\{placement\}" aria-pressed=/);
  assert.doesNotMatch(settings, /app-location-select/);
  assert.match(settings, /appFlags\?\.updatePlacements/);
  assert.match(core, /updatePlacements: async \(placements = \{\}\)/);
  assert.match(core, /fm:app-placements:updated/);
  assert.doesNotMatch(core, /updatePlacements:[\s\S]{0,400}fm:app-flags:updated/);
  assert.match(settings, /await window\.Portal\?\.appFlags\?\.updatePlacements\?\.\(next\)/);
  assert.match(settings, /control\.disabled = control\.hasAttribute\('data-unavailable'\)/);
});
