import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
// Sources may be checked out with CRLF line endings; normalize so the
// structural regexes below can anchor on plain \n.
const readSource = async (relativePath) => (await readFile(path.join(publicRoot, relativePath), 'utf8')).replace(/\r\n/g, '\n');
const projectScheduleSource = await readSource('libraries/apps/project-schedule/panel.js');
const schedulingSource = await readSource('libraries/apps/scheduling/app.js');
const scheduleViewSource = await readSource('libraries/platform-schedule-view/platform-schedule-view.js');
const customerPortalSource = await readSource('customer_portal/customer_portal.js');
const customerPortalCss = await readSource('customer_portal/customer_portal.css');
const platformApiSource = await readSource('v1/platform/api.ts');
const platformSchedulingSource = await readSource('libraries/platform-scheduling/platform-scheduling.js');
const platformUiSource = await readSource('libraries/platform-ui/platform-ui.js');
const portalCoreSource = await readSource('portal/scripts/core.js');
const scopePresetsSource = await readSource('v1/scopes/presets/index.ts');
const companySettingsSource = await readSource('libraries/apps/settings/company.js');
const appsManifestSource = await readSource('libraries/apps/firstmate-apps-manifest.js');
const capabilityDefsSource = await readSource('v1/platform/capability_defs.ts');
const routingServiceSource = await readSource('v1/routing/service.ts');

test('scheduling styles are installed before the async tab mount can render', () => {
  const cssEnd = schedulingSource.indexOf("  `;", schedulingSource.indexOf('const css = `'));
  const eagerStyle = schedulingSource.indexOf("injectCSS('dashboard_tab', css);", cssEnd);
  const mountStart = schedulingSource.indexOf('function mount(el)');
  assert.ok(cssEnd >= 0 && eagerStyle > cssEnd && eagerStyle < mountStart, 'scheduling CSS should be injected at module initialization');
  assert.doesNotMatch(schedulingSource.slice(mountStart), /injectCSS\('dashboard_tab', css\);/);
});

test('global Gantt keeps editing and visibility controls recoverable', () => {
  assert.match(scheduleViewSource, /if \(!projectCollapsed && \(typeof options\.onProjectAddItem === 'function' \|\| typeof options\.onProjectAddGroup === 'function'\)\) rows\.push\(\{ type:'add'/);
  assert.match(scheduleViewSource, /options\.toolbarLeadingHtml \|\| ''[\s\S]*?psv-gantt-empty/);
  assert.match(schedulingSource, /class="dash-gantt-shown-menu" data-gantt-shown-menu/);
  assert.match(schedulingSource, /data-gantt-kind="\$\{id\}" aria-pressed=/);
  assert.match(schedulingSource, /ganttShownMenuOpen = true;\s*renderGanttScheduleView\(\);/);
  assert.match(schedulingSource, /eventCalendarItems\(\)\.find[\s\S]*?\|\| allEvents\.find\(\(event\) => String\(event\.id \|\| ''\) === String\(eventEditorEventId \|\| ''\)\)/);
  assert.match(schedulingSource, /const canSave = ctx\.kind === 'floating' \|\| ctx\.editorOnly === true/);
  assert.match(schedulingSource, /const next = eventCalendarItems\(\)\.find[\s\S]*?\|\| allEvents\.find\(\(event\) => String\(event\.id \|\| ''\) === String\(ctx\.event\?\.id \|\| ''\)\)/);
  assert.match(capabilityDefsSource, /key: "scheduling\.routing"[\s\S]*?label: "Routing View"/);
  assert.match(capabilityDefsSource, /key: "scheduling\.gantt"[\s\S]*?label: "Gantt Project View"/);
});

test('customer schedule visibility is explicit and defaults to internal', () => {
  assert.match(platformApiSource, /if \(event\.customer_visible !== true\) return null;/);
  assert.match(platformApiSource, /customer_visible: input\.customer_visible === true/);
  assert.match(platformApiSource, /customer_show_title: input\.customer_show_title !== false/);
  assert.match(platformApiSource, /customer_show_crew: input\.customer_show_crew === true/);
  assert.match(platformApiSource, /title: showTitle[\s\S]*?publicScheduleCategoryTitle\(category\)/);
  assert.match(platformApiSource, /crew_name: publicScheduleCrewName\(event\)/);
  assert.match(platformApiSource, /schedule_events: scheduleEvents/);
  assert.match(schedulingSource, /data-event-customer-visible/);
  assert.match(schedulingSource, /data-event-customer-show-title/);
  assert.match(schedulingSource, /data-event-customer-show-crew/);
  assert.match(schedulingSource, /data-event-customer-description/);
  assert.match(schedulingSource, /Share with customer/);
  assert.match(schedulingSource, /customer_visible: event\.customer_visible === true/);
  assert.match(projectScheduleSource, /data-schedule-event-customer-visible/);
  assert.match(projectScheduleSource, /saveScheduleEventCustomerSettings/);
});

test('event creation supports production, multi-equipment assignments, and advanced type requirements', () => {
  assert.match(projectScheduleSource, /data-new-production/);
  assert.match(projectScheduleSource, /data-new-production[^\n]+openScheduleDialog\('project_work'\)/);
  assert.match(projectScheduleSource, /id="rScheduleEquipment" multiple/);
  assert.match(projectScheduleSource, /id="rScheduleAdvanced"[\s\S]{0,180}fa-sliders/);
  assert.match(projectScheduleSource, /resource_refs:resourceRefs/);
  assert.match(projectScheduleSource, /resource_requirements:resourceRequirements/);
  assert.match(schedulingSource, /data-event-advanced[\s\S]{0,220}fa-sliders/);
  assert.match(schedulingSource, /data-event-equipment-require-type/);
  assert.match(schedulingSource, /delivery && !eventAdvancedOpen/);
  assert.match(platformSchedulingSource, /resource_refs: arrayValue\(fields\.resourceRefs \|\| fields\.resource_refs\)/);
  assert.match(platformApiSource, /function normalizeEventResourceRequirements/);
  assert.match(platformApiSource, /resource_requirements: normalizeEventResourceRequirements/);
});

test('customer portal schedule renders all shared event categories as a customer-facing timeline', () => {
  assert.match(customerPortalSource, /function portalScheduleEvents\(payload\)/);
  assert.match(customerPortalSource, /Project work/);
  assert.match(customerPortalSource, /Delivery/);
  assert.match(customerPortalSource, /Estimated completion/);
  assert.match(customerPortalSource, /Completion dates are estimates/);
  assert.doesNotMatch(customerPortalSource, />Read only</);
  assert.match(customerPortalSource, /cp-schedule-customer-detail/);
  assert.match(customerPortalSource, /Note from your project team/);
  assert.match(customerPortalSource, /function scheduleInclusiveEnd\(event = \{\}\)/);
  assert.match(customerPortalSource, /title: `\$\{baseTitle\} starts`/);
  assert.match(customerPortalSource, /title: `\$\{baseTitle\} ends`/);
  assert.match(customerPortalSource, /has_estimated_dates: event\.is_estimate === true/);
  assert.doesNotMatch(customerPortalSource, /_estimated_completion/);
  assert.match(customerPortalSource, /if \(inclusiveEnd && !sameDate\)/);
  assert.ok(customerPortalSource.indexOf('cp-schedule-timeline') < customerPortalSource.indexOf('cp-schedule-disclaimer'), 'estimated-date disclaimer should follow the timeline');
  assert.match(customerPortalCss, /\.cp-schedule-timeline/);
  assert.match(customerPortalCss, /\.cp-schedule-estimate/);
  assert.match(customerPortalCss, /\.cp-schedule-event-card\.expandable/);
  const customerDetailStyles = customerPortalCss.match(/\.cp-schedule-customer-detail\s*\{([^}]*)\}/);
  assert.ok(customerDetailStyles, 'customer schedule detail styles should be present');
  assert.doesNotMatch(customerDetailStyles[1], /border-top/, 'expanded customer details should not be separated by a divider');
});

test('project scheduling uses generated production items instead of the ad hoc work-section launcher', () => {
  assert.match(projectScheduleSource, /function productionTilesHtml\(\)\{\s*const tiles = productionResourceTilesHtml\(\);/);
  assert.doesNotMatch(projectScheduleSource, /data-new-work/);

  const leftStatus = projectScheduleSource.match(/function leftStatusHtml\(\)\{([\s\S]*?)\n  \}\n\n  function recurrenceLabel/);
  assert.ok(leftStatus, 'leftStatusHtml should be present');
  assert.doesNotMatch(leftStatus[1], /Work Section|workDraftCardHtml|workScheduleModeActive/);
});

test('an empty recurring-series response is treated as loaded', () => {
  assert.match(projectScheduleSource, /if \(scheduleRecurrenceLoaded && !refresh\) return scheduleRecurringSeries;/);
  assert.match(projectScheduleSource, /finally \{\s*scheduleRecurrenceLoaded = true;\s*scheduleRecurrenceLoading = false;/);
  assert.match(projectScheduleSource, /if \(recurrenceProjectId && !scheduleRecurrenceLoading && !scheduleRecurrenceLoaded\)/);
});

test('recurring events can end never, on a date, or after a fixed occurrence count', () => {
  assert.match(schedulingSource, /data-event-recurrence-end-mode/);
  assert.match(schedulingSource, /data-event-recurrence-count/);
  assert.match(schedulingSource, /occurrence_count: endMode === 'count' \? occurrenceCount : null/);
  assert.match(projectScheduleSource, /id="rScheduleEndMode"/);
  assert.match(projectScheduleSource, /id="rScheduleCount"/);
  assert.match(projectScheduleSource, /occurrence_count: endModeInput\.value === 'count'/);
});

test('production scheduling labels follow workforce terminology', () => {
  assert.match(projectScheduleSource, /workforce\.configuration\?\.\(scheduleOrgId\(\), scheduleBranchId\(\)\)/);
  assert.match(projectScheduleSource, /resourceHeader: workResourceLabel\(\)/);
  assert.match(schedulingSource, /resourceHeader: workResourceLabel\(\)/);
  assert.match(scheduleViewSource, /name:options\.unassignedLabel \|\| 'Unassigned'/);
  assert.match(scheduleViewSource, /waitingForCrew \? \(crewLabelRaw \|\| 'Unassigned'\)/);
});

test('global scheduling keeps work and deliveries in one calendar before and during placement', () => {
  assert.match(schedulingSource, /function eventCalendarItems\(\)\{[\s\S]*?events\.filter\(eventIsScheduled\)[\s\S]*?isMaterialEvent\(event\)[\s\S]*?decorateMaterialEvent\(event\)/);
  assert.match(schedulingSource, /viewMode === 'appointment_schedule'[\s\S]*?: \(calendarDisplayMode === 'events' \? renderEventCalendarShell\(\)/);
  assert.match(schedulingSource, /else if \(calendarDisplayMode === 'events'\) renderEventCalendarView\(\);/);
  assert.match(schedulingSource, /function selectedPlacementKind\(\)\{\s*if \(selectedMaterialEvent\(\)\) return 'materials';/);
  assert.match(schedulingSource, /const placementKind = selectedPlacementKind\(\) \|\| requestedMode;\s*if \(placementKind === 'materials'\)/);
  assert.match(schedulingSource, /if \(!selectedScheduleEvent\(\) && !selectedProductionProject\(\) && !selectedProductionEvent\(\) && !selectedMaterialEvent\(\)\)[\s\S]*?floating_event: true/);
  assert.doesNotMatch(schedulingSource, /function ensureScheduleType\(/);
  const toolbar = schedulingSource.match(/function toolbarHtml\(\)\{([\s\S]*?)function openDayModal/);
  assert.ok(toolbar, 'toolbarHtml should be present');
  assert.match(toolbar[1], /\['appointment_schedule',routingLabel\]/);
  assert.match(schedulingSource, /<div class="dash-stage-pill">Waiting<\/div>/);
});

test('calendar category toggles filter sales, production, and other items independently', () => {
  assert.match(schedulingSource, /let showSalesSchedule = true;[\s\S]*?let showProductionSchedule = true;[\s\S]*?let showOtherSchedule = true;/);
  assert.match(schedulingSource, /function calendarEventCategory\(event = \{\}\)\{[\s\S]*?isSalesEvent\(event\) \|\| isSalesFollowUpEvent\(event\)[\s\S]*?return 'production';[\s\S]*?return 'other';/);
  assert.match(schedulingSource, /return scheduleTypeActive\(calendarEventCategory\(event\)\);/);
  assert.match(schedulingSource, /floatingEvents\.filter\(\(event\) => !isVehicleBooking\(event\)\)\.filter\(eventMatchesMode\)\.filter\(eventMatchesBreakdown\)\.map\(decorateFloatingEvent\)/);
  assert.match(schedulingSource, /data-schedule-type-toggle="sales"[\s\S]*?data-schedule-type-toggle="production"[\s\S]*?data-schedule-type-toggle="other"/);
  assert.match(schedulingSource, /if \(next === 'production'\) showProductionSchedule = !showProductionSchedule;[\s\S]*?else if \(next === 'other'\) showOtherSchedule = !showOtherSchedule;[\s\S]*?else showSalesSchedule = !showSalesSchedule;/);
  const activeTypes = schedulingSource.match(/function activeScheduleTypes\(\)\{([\s\S]*?)\n  \}/);
  assert.ok(activeTypes, 'activeScheduleTypes should be present');
  assert.doesNotMatch(activeTypes[1], /if \(!types\.length\)/, 'the final active category can be turned off');
});

test('sales appointments retain their green category color in month view', () => {
  assert.match(scheduleViewSource, /\.prs-work-chip\.type-sales-appointment,\.prs-work-chip\.type-sales-follow-up\{[^}]*background:#dcfce7/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.type-sales-appointment\.timed-month,\.prs-work-chip\.type-sales-follow-up\.timed-month\{[^}]*background:#dcfce7/);
});

test('the project Schedule tab keeps deliveries on its main calendar during placement', () => {
  assert.match(projectScheduleSource, /const calendarMaterialEvents = projectMaterialEvents\(\)\s*\.filter\(isMaterialDeliveryEvent\)\s*\.filter\(materialEventIsScheduled\);/);
  assert.match(projectScheduleSource, /const calendarEvents = \[\.\.\.calendarWorkEvents, \.\.\.calendarMaterialEvents, \.\.\.projectSalesAppointmentEvents\(\)\];/);
  assert.match(projectScheduleSource, /const calendarDrafts = \[\.\.\.workDraftList\(\), \.\.\.\(materialDraft \? \[materialDraft\] : \[\]\)\];/);
  assert.match(projectScheduleSource, /allowCreate: materialScheduleModeActive\s*\? !!materialEvent && !materialEventIsScheduled\(materialEvent\)/);
  assert.match(projectScheduleSource, /const draftIsMaterial = \(draft = \{\}\) => isMaterialDeliveryEvent\(draft\)/);
  assert.match(projectScheduleSource, /onDraftChange\(next\)\{\s*if \(draftIsMaterial\(next\)\) setMaterialScheduleDraft\(next\);/);
  assert.match(projectScheduleSource, /onDraftConfirm\(next\)\{\s*if \(draftIsMaterial\(next\)\) saveMaterialScheduleDraft\(next\);/);
  assert.doesNotMatch(projectScheduleSource, /workScheduleModeActive && !scheduleModeActive && !scheduleIsSchedulingView\(\)/);
  assert.match(projectScheduleSource, /function equipmentEventHidden\(event\)\{\s*return !equipmentSchedulingEnabled\(\) && productionResourceType\(event\) === 'equipment';/);
  assert.match(projectScheduleSource, /function projectWorkEvents\(\)\{[\s\S]*?\.filter\(\(event\) => !equipmentEventHidden\(event\)\)\s*\.filter\(materialEventIsScheduled\)/);
  assert.match(projectScheduleSource, /function productionResourceTilesHtml\(\)\{[\s\S]*?\.filter\(\(event\) => !equipmentEventHidden\(event\)\)/);
  assert.doesNotMatch(projectScheduleSource, /function renderMaterialSchedulePanel\(/);

  const focus = projectScheduleSource.match(/function focusMaterialDelivery\(payload = \{\}\)\{([\s\S]*?)\n  \}\n\n  function setMaterialScheduleDraft/);
  assert.ok(focus, 'focusMaterialDelivery should be present');
  assert.doesNotMatch(focus[1], /scheduleViewMode\s*=/);
  assert.doesNotMatch(focus[1], /scheduleAnchorDate\s*=/);
});

test('project Schedule navigation is visible and crew scheduling defaults to daily', () => {
  assert.match(projectScheduleSource, /const schedulingModes = \[\['scheduling-week', 'Daily'\], \['scheduling-day', 'Hourly'\]\];/);
  assert.match(projectScheduleSource, /data-schedule-anchor-nav="-1"[\s\S]*?aria-label="Previous"/);
  assert.match(projectScheduleSource, /data-schedule-anchor-nav="1"[\s\S]*?aria-label="Next"/);
  assert.match(projectScheduleSource, /if \(next === 'scheduling'\) \{\s*scheduleViewMode = 'scheduling-week';/);
  assert.match(projectScheduleSource, /if \(next === 'sales'\)[\s\S]*?else \{\s*scheduleViewMode = 'scheduling-week';/);
  assert.match(projectScheduleSource, /navigation\?\.push\?\.\(\{ projectScheduleTarget:scheduleSchedulingTarget, projectScheduleView:scheduleViewMode \}/);
  assert.match(projectScheduleSource, /navigation\?\.replace\?\.\(\{ projectScheduleDate:scheduleLocalDate\(next\) \}/);
  assert.match(projectScheduleSource, /registerSchema\?\.\('projectScheduleDate', \{ history:'replace'/);
  assert.match(projectScheduleSource, /modeLabel: 'Production hourly view'/);
  assert.match(projectScheduleSource, /modeLabel: 'Production daily view'/);
});

test('scheduling calendars expose a routed four-day view between day and week', () => {
  assert.match(scheduleViewSource, /const mode = \['list','day','4day','week','month'\]\.includes\(options\.mode\)/);
  assert.match(scheduleViewSource, /const shortRangeDayCount = Math\.max\(2, Math\.min\(4,/);
  assert.match(scheduleViewSource, /const timedDayCount = mode === 'day' \? 1 : \(mode === '4day' \? shortRangeDayCount : 7\);/);
  assert.match(scheduleViewSource, /const navDayCount = mode === 'week' \? 7 : \(mode === '4day' \? shortRangeDayCount : 1\);/);
  assert.match(scheduleViewSource, /const timedGridMinWidth = 62 \+ days\.length \* 120;/);
  assert.match(scheduleViewSource, /id === '4day' \? '4 Day'/);
  assert.match(schedulingSource, /\['day',window\.Portal\?\.terminology\?\.get\?\.\('scheduling\.day_view', 'Day'\)/);
  assert.match(schedulingSource, /\['4day',window\.Portal\?\.terminology\?\.get\?\.\('scheduling\.four_day_view', '4 Day'\)/);
  assert.match(schedulingSource, /const dayCount = viewMode === '4day' \? 4 : 7;/);
  assert.match(schedulingSource, /viewMode === '4day' \? delta \* 4 : delta/);
  assert.match(projectScheduleSource, /const calendarModes = \[\['day', terminology\('scheduling\.day_view', 'Day'\)\], \['4day', terminology\('scheduling\.four_day_view', '4 Day'\)\]/);
  assert.match(projectScheduleSource, /shortRangeDayCount: mobileLayout \? 3 : 4/);
  assert.match(projectScheduleSource, /scheduleViewMode === '4day' \? 4 : 1/);
  assert.match(appsManifestSource, /values:\['day','4day','week','month','appointment_schedule','gantt'\]/);
});

test('project scheduling mode uses branch-configurable Routing terminology', () => {
  assert.match(platformSchedulingSource, /ui:\s*\{\s*routing_mode: 'Routing'/);
  assert.match(platformSchedulingSource, /Object\.fromEntries\(Object\.entries\(\{ \.\.\.defaultLabels, \.\.\.inputLabels \}\)/);
  assert.match(projectScheduleSource, /terminology\('scheduling\.routing_view', window\.PlatformScheduling\?\.labelFor\?\.\(scheduleCachedConfig, 'ui', 'routing_mode'\) \|\| 'Routing'\)/);
  assert.match(projectScheduleSource, /surfaceButton\('scheduling', escapeHtml\(routingLabel\)\)/);
  assert.match(schedulingSource, /\['month',window\.Portal\?\.terminology\?\.get\?\.\('scheduling\.month_view', 'Month'\)[\s\S]*?\['appointment_schedule',routingLabel\]/);
  assert.match(schedulingSource, /viewMode === 'appointment_schedule'[\s\S]*?renderAppointmentSchedule\(\)/);
  assert.match(schedulingSource, /\['day','4day','week','month','appointment_schedule','gantt'\]\.includes\(route\.scheduleView\)/);
  assert.match(companySettingsSource, /data-configuration-pane="terminology"/);
  assert.match(companySettingsSource, /data-terminology-key="\$\{escapeHtml\(row\.key\)\}"/);
  assert.match(companySettingsSource, /branchModules\.save\(orgId, branchId, 'variable_mappings'/);
});

test('global Routing panes size to their rows and switch detail independently', () => {
  assert.match(schedulingSource, /\.dash-schedule-split\{[\s\S]*?justify-content:flex-start;gap:8px/);
  assert.match(schedulingSource, /function fitRoutingScheduleHeights\(\)[\s\S]*?desiredHeights[\s\S]*?remainingHeight \/ remainingPanes[\s\S]*?pane\.style\.height/);
  assert.match(schedulingSource, /let salesRoutingScale = 'hourly';[\s\S]*?let productionRoutingScale = 'daily';/);
  assert.match(schedulingSource, /data-routing-scale-scope="\$\{scope\.toLowerCase\(\)\}"/);
  assert.match(schedulingSource, /salesRoutingScale === 'daily'[\s\S]*?renderResourceDayScheduler/);
  assert.match(schedulingSource, /productionRoutingScale === 'hourly'[\s\S]*?renderResourceTimeScheduler/);
});

test('Routing placement supports keyboard history and full hover previews', () => {
  assert.match(schedulingSource, /function recordPlacementHistory\(\)/);
  assert.match(schedulingSource, /function undoPlacement\(\)/);
  assert.match(schedulingSource, /function redoPlacement\(\)/);
  assert.match(schedulingSource, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(schedulingSource, /const redo = key === 'y' \|\| \(key === 'z' && event\.shiftKey\)/);
  assert.match(schedulingSource, /onDraftChange\(next\)\{ recordPlacementHistory\(\); applyDailyDraft\(next\); \}/);
  assert.match(schedulingSource, /onDraftChange\(next\)\{\s*recordPlacementHistory\(\);\s*applyDraft\(next\);/);
  assert.match(scheduleViewSource, /function renderResourceDayScheduler[\s\S]*?const renderHoverPlacementPreview = \(target\) =>/);
  assert.match(scheduleViewSource, /const previews = typeof options\.derivePlacementDrafts === 'function' \? options\.derivePlacementDrafts\(primary\) : \[primary\]/);
  assert.match(scheduleViewSource, /if \(!drag\) \{\s*if \(options\.allowCreate !== false\) renderHoverPlacementPreview\(pointRange\(event\)\);/);
  assert.match(scheduleViewSource, /function renderResourceTimeScheduler[\s\S]*?base && !base\.start[\s\S]*?renderPreview\(target\.start, endDate, target\.resource/);
});

test('Routing queues scroll independently and distinguish waiting work', () => {
  assert.match(schedulingSource, /\.dash-body\.schedule-mode \.dash-right\{overflow:hidden\}/);
  assert.match(schedulingSource, /\.dash-body\.schedule-mode \.dash-right>\.dash-groups>\.dash-group\{display:flex;flex:1 1 0;min-height:0;flex-direction:column\}/);
  assert.match(schedulingSource, /\.dash-group\.empty\{flex:0 0 auto\}/);
  assert.match(schedulingSource, /\.dash-group\.empty>\.dash-group-body\{display:none\}/);
  assert.ok([...schedulingSource.matchAll(/<div class="dash-group \$\{(?:rows|items)\.length \? '' : 'empty'\}">/g)].length >= 2, 'sales and production queues should both mark empty groups');
  assert.match(schedulingSource, /\.dash-group>\.dash-group-body\{flex:1;min-height:0;overflow-y:auto/);
  assert.match(schedulingSource, /\.dash-appt-tile\.unscheduled\{border-top-style:dashed/);
  assert.match(schedulingSource, /\.dash-group-body\{padding:0 14px 12px;display:grid;gap:8px;align-content:start\}/);
  assert.match(schedulingSource, /if \(scroll\.classList\?\.contains\('prs-resource-scroll'\)\) return;/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.unassigned-item\{border-style:dashed/);
  assert.match(scheduleViewSource, /renderedResourceIdForItem\(item\) \? '' : 'unassigned-item'/);
  assert.match(scheduleViewSource, /scroll\.scrollLeft = Math\.max\(0, Math\.round\(cellWidth \* pastDays\)\);/);
});

test('Routing identifies and reports projects that cannot be routed without an address', () => {
  assert.match(schedulingSource, /\.dash-appt-tile\.missing-address\{background:#fff8e8/);
  assert.match(schedulingSource, /Missing address<\/span>/);
  assert.match(schedulingSource, /const missingAddress = Number\(result\?\.skipped_missing_address_count/);
  assert.match(schedulingSource, /project\$\{missingAddress === 1 \? ' was' : 's were'\} skipped because/);
  assert.match(routingServiceSource, /function routableAddress\(event: JsonObject, project: JsonObject\)/);
  assert.match(routingServiceSource, /reason: "missing_address"/);
  assert.match(routingServiceSource, /skipped_missing_address_count: skippedMissingAddressCount/);
});

test('calendar header only shows the visible date title', () => {
  const toolbar = schedulingSource.match(/function toolbarHtml\(\)\{([\s\S]*?)\n  \}\n  function openDayModal/);
  assert.ok(toolbar, 'calendar toolbar should be present');
  assert.match(toolbar[1], /<h2 class="dash-title">\$\{escapeHtml\(visibleTitle\(\)\)\}<\/h2>/);
  assert.doesNotMatch(toolbar[1], /scheduled &middot;|waiting`/);
});

test('shared toasts allow long routing results to wrap to three lines', () => {
  assert.match(platformUiSource, /\.fm-toast \.tx\{display:flex;flex:1;/);
  assert.match(platformUiSource, /\.fm-toast \.t2\{[^}]*white-space:normal;[^}]*-webkit-line-clamp:3/);
  assert.doesNotMatch(platformUiSource, /\.fm-toast \.t2\{[^}]*text-overflow:ellipsis/);
  assert.match(portalCoreSource, /\.fm-toast \.t2\{[^}]*white-space:normal;[^}]*-webkit-line-clamp:3/);
});

test('sales Routing confirms from the placed item without a separate footer action', () => {
  const routingShell = schedulingSource.match(/function renderAppointmentSchedule\(\)\{([\s\S]*?)function renderEventCalendarShell/);
  assert.ok(routingShell, 'Routing shell should be present');
  assert.doesNotMatch(routingShell[1], /Confirm Appointment|data-dash-confirm-schedule|dash-schedule-actions/);
  assert.match(schedulingSource, /onDraftConfirm\(next\)\{ applyDailyDraft\(next\); return confirmDashboardDraft\(\); \}/);
  assert.match(schedulingSource, /onDraftConfirm\(draft\)\{[\s\S]*?appointmentScheduleDraft = draft;[\s\S]*?return confirmDashboardDraft\(\);/);
  assert.match(scheduleViewSource, /data-psv-draft-confirm role="button" tabindex="0" aria-label="Confirm and save appointment"/);
  assert.doesNotMatch(scheduleViewSource, /<button[^>]*data-psv-draft-confirm/);
  assert.match(scheduleViewSource, /bindDraftConfirm\(control, \(\) => options\.draft \|\| null, options\.onDraftConfirm\)/);
});

test('sales hourly Routing shows its date and renders persisted off-grid appointments', () => {
  assert.match(schedulingSource, /<time class="dash-routing-date" datetime="\$\{routingDateValue\(\)\}">\$\{escapeHtml\(routingDateLabel\(\)\)\}<\/time>/);
  assert.match(schedulingSource, /function salesRoutingEvents\(\)\{[\s\S]*?\[\.\.\.allEvents, \.\.\.floatingEvents\][\s\S]*?!isSalesEvent\(event\) \|\| !eventIsScheduled\(event\)[\s\S]*?byId\.set\(key, decorateSalesEvent\(event\)\)/);
  assert.match(schedulingSource, /const routingEvents = salesRoutingEvents\(\);/);
  assert.ok([...schedulingSource.matchAll(/events:routingEvents/g)].length >= 2, 'daily and hourly Sales Routing should share project and floating calendar events');
  assert.match(schedulingSource, /salesRoutingScale === 'daily'[\s\S]*?renderResourceDayScheduler[\s\S]*?renderResourceTimeScheduler\(mount, \{/);
  assert.match(schedulingSource, /renderResourceTimeScheduler\(mount, \{[\s\S]*?allowCreate:creationEnabled,[\s\S]*?allowEdit:true,[\s\S]*?onEventRangeChange\(event, range\)\{ saveEventCalendarRange\(event, range\); \}/);
  assert.match(schedulingSource, /function goToToday\(\)\{[\s\S]*?anchorDate = startOfDay\(new Date\(\)\)[\s\S]*?syncScheduleRoute\(\{ date:routeDate\(\) \}/);
  assert.match(schedulingSource, /querySelectorAll\('\[data-dash-today\]'\)\.forEach\(\(btn\) => btn\.addEventListener\('click', goToToday\)\)/);
  assert.match(scheduleViewSource, /eventsForDate\(Scheduling, projects, dateValue, null, options\.events\)/);
  assert.match(scheduleViewSource, /--psv-slot-width:58px/);
  assert.match(scheduleViewSource, /slotOffset:eventSlotPlacement\(event\)\.offset/);

  const context = { window:{}, console, URL, Date, Map, Set };
  vm.runInNewContext(scheduleViewSource, context);
  const placement = context.window.PlatformScheduleView.dailyEventSlotPlacement;
  assert.deepEqual(
    { ...placement(new Date('2026-07-27T09:15:00'), 8 * 60, 30) },
    { time:'09:00', offset:0.5 },
    'a quarter-past appointment should anchor in the preceding half-hour cell with a half-cell offset'
  );
  assert.deepEqual(
    { ...placement(new Date('2026-07-27T09:30:00'), 8 * 60, 30) },
    { time:'09:30', offset:0 },
    'an appointment on a column boundary should remain aligned to that column'
  );
});

test('sales hourly Routing persists dragged assignees and keeps cards behind the sticky resource column', () => {
  const rangeSaveStart = schedulingSource.indexOf('async function saveEventCalendarRange(event, range){');
  const rangeSaveEnd = schedulingSource.indexOf('  function salesResources', rangeSaveStart);
  const rangeSaveSource = rangeSaveStart >= 0 && rangeSaveEnd > rangeSaveStart ? schedulingSource.slice(rangeSaveStart, rangeSaveEnd) : '';
  assert.match(rangeSaveSource, /updateFloatingEvent\(\{\s*\.\.\.event,\s*\.\.\.range,/);
  assert.match(rangeSaveSource, /const assignment = assignmentPayloadForEvent\(\{ \.\.\.currentEvent, \.\.\.range \}\);/);
  assert.match(rangeSaveSource, /\.\.\.withScheduleHistory\(currentEvent, 'rescheduled'\),\s*\.\.\.assignment,/);
  assert.match(scheduleViewSource, /\.prs-resource-label\{position:sticky;left:0;z-index:10;/);
  assert.match(scheduleViewSource, /\.prs-resource-time-grid\{[^}]*repeat\(var\(--prs-slots,24\),minmax\(60px,1fr\)\)/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.type-sales-appointment[^}]*background:#dcfce7/);
  assert.match(scheduleViewSource, /const travelConnections = options\.liveTravel !== true \? \[\] : rows\.flatMap/);
  assert.match(scheduleViewSource, /if \(!clean\(resource\.id\)\) return \[\];/);
  assert.match(scheduleViewSource, /function routableAddress\(item = \{\}\)[\s\S]*?\^\(\?:no\|missing\|unknown\)/);
  assert.match(scheduleViewSource, /renderedResourceIdForItem\(item\) === String\(resource\.id \|\| ''\) && routableAddress\(item\)/);
  assert.doesNotMatch(
    scheduleViewSource,
    /item\.__draft !== true && renderedResourceIdForItem\(item\)/,
    'moved routing drafts must participate in the route so their adjacent travel segments are recalculated'
  );
  assert.match(scheduleViewSource, /const outgoingTravelByItem = new Map\(travelConnections\.filter\(\(connection\) => connection\.cached > 0\)/);
  assert.match(scheduleViewSource, /const gapMinutes = nextStartMinute - startMinute;/);
  assert.match(scheduleViewSource, /const travelLayout = travelSegmentLayout\(cached, gapMinutes, slotMinutes, endCol - startCol\);/);
  assert.match(scheduleViewSource, /const incomingTravelByItem = new Map\(travelConnections\.filter\(\(connection\) => connection\.cached > 0 && connection\.bridge\)/);
  assert.match(scheduleViewSource, /<i class="far fa-clock"><\/i>\$\{connection\.cached > 0 \? `<span>\$\{esc\(connection\.cached\)\}<\/span>` : ''\}/);
  assert.match(scheduleViewSource, /\.prs-resource-time-bar \.prs-work-chip\.travel-origin\{border-top-right-radius:0;border-bottom-right-radius:0\}/);
  assert.match(scheduleViewSource, /\.prs-resource-time-bar \.prs-work-chip\.travel-destination\{border-top-left-radius:0;border-bottom-left-radius:0\}/);
  assert.match(scheduleViewSource, /\.prs-resource-travel\{[^}]*background:#e2e8f0/);
  assert.match(scheduleViewSource, /\.prs-resource-travel\.insufficient\{[^}]*background:#fee2e2/);
  assert.match(scheduleViewSource, /\.prs-resource-travel\{[^}]*left:auto;top:auto;[^}]*margin:var\(--prs-bar-top,3px\) 0 0/);

  const context = { window:{}, console, URL, Date, Map, Set };
  vm.runInNewContext(scheduleViewSource, context);
  const layout = context.window.PlatformScheduleView.travelSegmentLayout;
  assert.deepEqual({ ...layout(36, 30, 30, 1) }, { bridge:true, insufficient:true, widthPercent:100 });
  assert.deepEqual({ ...layout(30, 30, 30, 1) }, { bridge:true, insufficient:false, widthPercent:100 });
  assert.deepEqual({ ...layout(20, 30, 30, 1) }, { bridge:false, insufficient:false, widthPercent:20 / 30 * 100 });
});

test('new appointment project links can create, clear, or undo before save', () => {
  const deleteEditorStart = schedulingSource.indexOf('async function deleteEventEditor');
  const deleteEditorEnd = schedulingSource.indexOf('  function eventEditorContext', deleteEditorStart);
  const deleteEditorSource = deleteEditorStart >= 0 && deleteEditorEnd > deleteEditorStart ? schedulingSource.slice(deleteEditorStart, deleteEditorEnd) : '';
  const popoverStart = schedulingSource.indexOf('function renderEventDraftPopover');
  const popoverEnd = schedulingSource.indexOf('  function openPlacedCalendarEvent', popoverStart);
  const popoverSource = popoverStart >= 0 && popoverEnd > popoverStart ? schedulingSource.slice(popoverStart, popoverEnd) : '';
  assert.match(schedulingSource, /data-event-project-create aria-label="Create a new project"/);
  assert.match(schedulingSource, /new CustomEvent\('fm:new-project-workflow', \{ detail:\{ workflow:'project', source:'scheduling-event' \} \}\)/);
  assert.match(popoverSource, /const canClearProject = disposableFloatingDraft && !!clean\(draft\.project_id\);/);
  assert.match(popoverSource, /const projectNameRowHtml = clearableProjectNameHtml \|\| canClearProject/);
  assert.doesNotMatch(deleteEditorSource, /projectNameRowHtml|projectNameHtml|projectLabel/);
  assert.match(schedulingSource, /data-event-project-clear aria-label="Remove selected project"/);
  assert.match(schedulingSource, /function rememberFloatingProjectAssignment\(event = \{\}\)/);
  assert.match(schedulingSource, /function restoreFloatingProjectAssignment\(\)/);
  assert.match(schedulingSource, /String\(event\.key \|\| ''\)\.toLowerCase\(\) !== 'z'[\s\S]*?restoreFloatingProjectAssignment\(\)/);
});

test('Routing resource actions describe and icon users and configured group kinds', () => {
  assert.match(scheduleViewSource, /function resourceActionPresentation\(resource = \{\}\)/);
  assert.match(scheduleViewSource, /subjectType === 'organization_user'[\s\S]*?Open user profile for \$\{name\}[\s\S]*?icon:'fa-user'/);
  assert.match(scheduleViewSource, /resource\.group_kind_icon[\s\S]*?resource\.group_kind\?\.icon/);
  assert.match(scheduleViewSource, /groupKindId === 'crew' \? 'fa-helmet-safety' : 'fa-user-group'/);
  assert.match(scheduleViewSource, /actionLabel: resourceActionPresentation\(resource\)\.label, actionIcon: resourceActionPresentation\(resource\)\.icon/);
  assert.match(schedulingSource, /let workforceGroupKinds = \[\];/);
  assert.match(schedulingSource, /group_kind_icon:clean\(resource\?\.group_kind_icon \|\| groupKind\?\.icon\)/);
  assert.match(schedulingSource, /workforceGroupKinds = Array\.isArray\(workforceConfiguration\?\.resource_group_kinds\)/);
});

test('global Routing tolerates empty selections and category-only states', () => {
  assert.match(schedulingSource, /function productionResourceType\(event = \{\}\)\{\s*event = event \|\| \{\};/);
  assert.match(schedulingSource, /function isMaterialEvent\(event\)\{\s*if \(!event\) return false;/);
  assert.match(schedulingSource, /showSalesSchedule \? \{ id:'sales', label:'Sales', mount:'dashScheduleViewSales'/);
  assert.match(schedulingSource, /showProductionSchedule \? \{ id:'production', label:'Production', mount:'dashScheduleViewProduction'/);
  assert.match(schedulingSource, /if \(!availablePanes\.length\) \{/);
  assert.match(schedulingSource, /Turn on Sales or Production to show a routing schedule/);
});

test('production Routing keeps deliveries in a compact materials row beneath crews', () => {
  const productionRouting = schedulingSource.match(/function renderProductionScheduleView\(mount\)\{([\s\S]*?)function renderGroups/);
  assert.ok(productionRouting, 'production Routing renderer should be present');
  assert.doesNotMatch(productionRouting[1], /renderMaterialScheduleView\(mount\)/);
  assert.match(productionRouting[1], /const materialsResourceId = '__materials__';/);
  assert.match(productionRouting[1], /const resources = productionVehiclesVisible && equipmentSchedulingOn\(\)[\s\S]*?: \[\.\.\.crews, materialsResource\];/);
  assert.match(productionRouting[1], /allEvents\.filter\(isMaterialEvent\)\.filter\(eventIsScheduled\)\.map\(decorateMaterialEvent\)/);
  assert.match(productionRouting[1], /resourceIdForItem = \(event\) => isVehicleBooking\(event\)[\s\S]*?isMaterialEvent\(event\) \? materialsResourceId : workCrewId/);
  assert.match(productionRouting[1], /compactResourceIds:\[materialsResourceId, \.\.\.vehicleLanes\.map/);
  assert.match(productionRouting[1], /canPlaceItemInResource[\s\S]*?isMaterialEvent\(event\)[\s\S]*?clean\(resource\?\.id\) !== materialsResourceId/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.compact-resource-item\{height:24px;min-height:24px/);
  assert.match(scheduleViewSource, /options\.canPlaceItemInResource[\s\S]*?canPlaceItemInResource\(activeDrag\.item \|\| localActiveDraft/);
});

test('production delivery children are collapsed behind a count by default in every global view', () => {
  assert.match(schedulingSource, /const expandedProductionBundles = new Set\(\);/);
  assert.match(schedulingSource, /const expanded = expandedProductionBundles\.has\(group\.key\) \|\| childSelected;/);
  assert.match(schedulingSource, /data-production-bundle-toggle=/);
  assert.match(schedulingSource, /\$\{expanded \? 'Hide' : 'Show'\} \$\{escapeHtml\(dependentLabel\)\}/);
  assert.match(schedulingSource, /group\.dependents\.length && expanded \? `<div class="dash-bundle-items">/);
});

test('Production Routing opens the selected crew settings inside a route-neutral modal', () => {
  const crewSettingsOpener = schedulingSource.match(/function openScheduleWorkResourceSettings\(resource = \{\}\)\{([\s\S]*?)\n  \}\n  function assignmentResourcesForEvent/);
  assert.ok(crewSettingsOpener, 'crew settings modal opener should be present');
  assert.match(crewSettingsOpener[1], /runtime\.mount\(host, 'portal\.company_settings'/);
  assert.match(crewSettingsOpener[1], /params:\{ embedded:true, settingsTab:'crews', settingsView, settingsEntity:resourceId \}/);
  assert.match(crewSettingsOpener[1], /id:'schedule-crew-settings'/);
  assert.doesNotMatch(crewSettingsOpener[1], /fm:open-crew-settings|navigation\.(?:push|navigate|write)|activateTab/);
  assert.match(companySettingsSource, /const embeddedSettings = context\?\.params\?\.embedded === true/);
  assert.match(companySettingsSource, /if \(embeddedSettings\) return \{ \.\.\.embeddedRoute \};/);
  assert.match(companySettingsSource, /if \(embeddedSettings\) \{\s*Object\.assign\(embeddedRoute, patch\);/);
  assert.match(companySettingsSource, /embedded-tab-only/);
  assert.match(companySettingsSource, /focusedCard\?\.classList\.add\('embedded-focus'\)/);
});

test('placed project events open details without becoming placement drafts', () => {
  assert.match(projectScheduleSource, /function openScheduleEventPopover\(event = \{\}, anchor = null\)/);
  assert.match(projectScheduleSource, /role', 'dialog'/);
  assert.match(projectScheduleSource, /if \(isMaterialDeliveryEvent\(event\)\) return \{ label:'Delivery'/);
  assert.match(projectScheduleSource, /return \{ label:'Labor', icon:'fa-hammer' \}/);
  assert.match(projectScheduleSource, /data-schedule-event-crew=/);
  assert.match(projectScheduleSource, /onEventClick\(event, meta = \{\}\)\{[\s\S]*?openScheduleEventPopover\(event, meta\.element\);/);
  assert.doesNotMatch(projectScheduleSource, /if \(isMaterialDeliveryEvent\(event\)\) \{\s*focusMaterialDelivery/);
});

test('placed scheduling items distinguish clicks from drags and open assignment controls', () => {
  assert.match(schedulingSource, /function openPlacedCalendarEvent\(event, meta = \{\}\)/);
  assert.match(schedulingSource, /meta\.action === 'assignee'[\s\S]*?openAssignmentMenu\(event, meta\.element\);[\s\S]*?return;/);
  assert.match(schedulingSource, /eventEditorEventId = String\(event\.id \|\| ''\);[\s\S]*?renderEventDraftPopover\(meta\.element \|\| editorAnchorFor\(event\.id\)\);/);
  assert.ok([...schedulingSource.matchAll(/onEventClick\(event, meta = \{\}\)\{ openPlacedCalendarEvent\(event, meta\); \}/g)].length >= 3);
  assert.match(schedulingSource, /return resource\.subject_type === 'organization_user' \|\| !normalizedScopeId \|\| !ids\.length \|\| ids\.includes\(normalizedScopeId\);/);
  assert.match(schedulingSource, /const scheduleEvent = !!clean\([\s\S]*?const identityId = scheduleEvent \? '' : resource\.id;/);
  assert.match(schedulingSource, /const resourceId = scheduleEvent && workAssignmentReferencesEvent\(resource, candidateId\) \? '' : candidateId;/);
  assert.match(schedulingSource, /const resourceName = resourceId && !\(scheduleEvent && workAssignmentReferencesEvent\(resource, candidateName\)\) \? candidateName : '';/);
  assert.match(schedulingSource, /function workAssignmentReferencesEvent\(event = \{\}, resourceId = ''\)/);
  assert.match(schedulingSource, /return workAssignmentReferencesEvent\(event, id\) \? '' : id;/);
  assert.match(projectScheduleSource, /function workAssignmentReferencesEvent\(event = \{\}, resourceId = ''\)/);
  assert.match(platformApiSource, /const selfAssigned = assignmentIds\.includes\(eventId\);[\s\S]*?work_resource_ref: null,[\s\S]*?assigned_crew_id: ""/);
  assert.match(scheduleViewSource, /const POINTER_DRAG_THRESHOLD = 8;/);
  assert.match(scheduleViewSource, /<button type="button" class="prs-assignee[\s\S]*?data-prs-assignee/);
  assert.match(scheduleViewSource, /\.prs-title-text\{display:block;width:100%;max-width:100%;min-width:0;overflow:hidden/);
  assert.match(scheduleViewSource, /pointerDistance\(event\) > POINTER_DRAG_THRESHOLD/);
});

test('regular Day Week and Month appointments stay click-first while Routing owns dragging', () => {
  const rendererStart = schedulingSource.indexOf('function renderEventCalendarView(){');
  const rendererEnd = schedulingSource.indexOf('  function toggleScheduleSelection', rendererStart);
  const eventCalendarRenderer = rendererStart >= 0 && rendererEnd > rendererStart ? schedulingSource.slice(rendererStart, rendererEnd) : '';
  assert.match(eventCalendarRenderer, /allowEdit: true,\s*allowEventDrag: false,/);
  assert.match(eventCalendarRenderer, /onEventClick\(event, meta = \{\}\)\{ openPlacedCalendarEvent\(event, meta\); \}/);
  assert.match(scheduleViewSource, /const allowEventDrag = allowEdit && options\.allowEventDrag !== false;/);
  assert.match(scheduleViewSource, /events-click-only/);
  assert.match(scheduleViewSource, /bindEdgeResizeCursor\(chip, \(\) => allowEventDrag\)/);
  assert.match(scheduleViewSource, /if \(allowEventDrag\) chip\.addEventListener\('pointerdown'/);
  assert.match(schedulingSource, /renderResourceTimeScheduler\(mount, \{[\s\S]*?allowEdit:true,/);
});

test('scheduling popovers dismiss only when the full pointer gesture is outside', () => {
  [schedulingSource, projectScheduleSource].forEach((source) => {
    assert.match(source, /function bindOutsidePointerDismiss\(surface, onDismiss, insideNodes = \[\]\)/);
    assert.match(source, /pointerStartedOutside = !isInside\(pointerTarget\(event\)\)/);
    assert.match(source, /if \(pointerStartedOutside && pointerEndedOutside\) onDismiss\(\);/);
    assert.match(source, /document\.addEventListener\('pointerdown', onPointerDown, true\);[\s\S]*?document\.addEventListener\('pointerup', onPointerUp, true\);/);
  });
});

test('weekly timed moves keep the cursor inside the dragged event', () => {
  assert.match(scheduleViewSource, /const TIMED_MOVE_CURSOR_OFFSET_MINUTES = 7\.5;/);
  assert.match(scheduleViewSource, /const eventForDragTarget =/);
  assert.match(scheduleViewSource, /activeDrag\?\.kind !== 'move' \|\| !rangeItemIsTimed\(activeDrag\?\.item\)/);
  assert.match(scheduleViewSource, /clientY:y - TIMED_MOVE_CURSOR_OFFSET_MINUTES \* pixelsPerMinute/);
  assert.match(scheduleViewSource, /const targetRange = rangeForDragTarget\(event, activeDrag\);/);
  assert.match(scheduleViewSource, /if \(chip\.classList\.contains\('dragging'\)\) \{[\s\S]*?chip\.style\.cursor = 'grabbing';/);
});

test('weekly timed overlaps pack into leftmost free columns per overlap cluster', () => {
  const context = { window:{}, console, URL, Date, Map, Set };
  vm.runInNewContext(scheduleViewSource, context);
  const layout = context.window.PlatformScheduleView.layoutTimedOverlapEntries;
  const entry = (id, start, end) => ({
    id,
    start:new Date(`2026-07-15T${start}:00`),
    end:new Date(`2026-07-15T${end}:00`),
  });
  const byId = (list, id) => list.find((item) => item.id === id);

  // A chain of staggered events must not cascade rightward forever: as soon
  // as lane 0 frees up, the next event takes it.
  const chain = layout([
    entry('first', '09:00', '10:30'),
    entry('second', '10:00', '12:00'),
    entry('third', '11:00', '13:00'),
    entry('fourth', '12:00', '14:00'),
  ]);
  assert.equal(byId(chain, 'first').columnIndex, 0);
  assert.equal(byId(chain, 'second').columnIndex, 1);
  assert.equal(byId(chain, 'third').columnIndex, 0, 'lane 0 is reused as soon as it is free');
  assert.equal(byId(chain, 'fourth').columnIndex, 1);
  chain.forEach((item) => {
    assert.equal(item.columnCount, 2, 'the cluster splits by its peak concurrency, not its size');
    assert.equal(item.insetLeft, 0);
    assert.equal(item.insetRight, 0);
  });

  // Three simultaneously overlapping events genuinely need three columns.
  const triple = layout([
    entry('multi-first', '09:00', '13:00'),
    entry('multi-second', '10:00', '14:00'),
    entry('multi-third', '11:00', '15:00'),
  ]);
  triple.forEach((item) => assert.equal(item.columnCount, 3));
  assert.equal(triple.map((item) => item.columnIndex).join(','), '0,1,2');

  // Events in disjoint clusters each get the full column width back.
  const separate = layout([
    entry('morning', '08:00', '09:00'),
    entry('afternoon', '13:00', '14:00'),
  ]);
  separate.forEach((item) => {
    assert.equal(item.columnCount, 1);
    assert.equal(item.columnIndex, 0);
  });

  const split = layout([
    entry('left', '09:00', '12:00'),
    entry('right', '09:30', '12:30'),
  ]);
  assert.equal(split[0].columnCount, 2);
  assert.equal(split[1].columnCount, 2);
  assert.equal(split.map((item) => item.columnIndex).join(','), '0,1');
  const columnGeometry = context.window.PlatformScheduleView.timedOverlapColumnGeometry;
  const leftSplitGeometry = columnGeometry(split[0], 20);
  const rightSplitGeometry = columnGeometry(split[1], 20);
  assert.equal(leftSplitGeometry.leftFraction, 0);
  assert.equal(leftSplitGeometry.leftPixels, 0);
  assert.equal(leftSplitGeometry.rightFraction, 0.5);
  assert.equal(leftSplitGeometry.rightPixels, 10, 'the left tile receives only its half of the shared gutter');
  assert.equal(rightSplitGeometry.leftFraction, 0.5);
  assert.equal(rightSplitGeometry.leftPixels, -10, 'the right tile begins where the left tile ends after the gutter is reserved');
  assert.equal(rightSplitGeometry.rightFraction, 0);
  assert.equal(rightSplitGeometry.rightPixels, 20, 'the column keeps one outer 20px gutter');

  assert.match(scheduleViewSource, /const TIMED_PLACED_RIGHT_GUTTER_PX = 20;/);
  assert.match(scheduleViewSource, /\.prs-slot \.prs-work-chip\{position:absolute;left:0;right:20px;/);
  assert.match(scheduleViewSource, /const compactMobileWeek = options\.mobileLayout === true && mode === 'week';/);
  assert.match(scheduleViewSource, /const placedLeftInset = compactMobileWeek \? 1 : 0;/);
  assert.match(scheduleViewSource, /const placedRightGutter = compactMobileWeek \? 1 : TIMED_PLACED_RIGHT_GUTTER_PX;/);
  assert.match(scheduleViewSource, /const rightGutter = layout\.preview \? 0 : placedRightGutter;/);
  assert.match(scheduleViewSource, /const geometry = timedOverlapColumnGeometry\(layout, rightGutter\);/);
  assert.match(scheduleViewSource, /chip\.style\.left = preview \? '0px' : `\$\{placedLeftInset\}px`;/);
  assert.match(scheduleViewSource, /chip\.style\.right = preview \? '0px' : `\$\{placedRightGutter\}px`;/);
  assert.match(scheduleViewSource, /geometry\.leftPixels \+ leftInset/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.timed\{padding:6px 4px;/);
  assert.match(scheduleViewSource, /const reflowTimedOverlaps = \(\) =>/);
  assert.match(scheduleViewSource, /chip\.classList\.add\('live-preview'\);[\s\S]*?reflowTimedOverlaps\(\);/);
  assert.match(scheduleViewSource, /const clearLivePreview = \(\) => \{[\s\S]*?reflowTimedOverlaps\(\);/);
});

test('range saves reflow the calendar without reloading data or overwriting newer drags', () => {
  assert.match(schedulingSource, /const eventRangeSaveVersions = new Map\(\);/);
  assert.match(schedulingSource, /const eventRangeSaveQueues = new Map\(\);/);
  assert.match(schedulingSource, /function beginEventRangeSave\(eventId = ''\)/);
  assert.match(schedulingSource, /function queueEventRangeSave\(eventId = '', save\)/);
  assert.match(schedulingSource, /function mergeSavedCalendarEvent\(saved = \{\}, fallback = \{\}, version = 0\)[\s\S]*?eventRangeSaveVersions\.get\(id\) !== version/);
  assert.match(schedulingSource, /const saved = await queueEventRangeSave\(event\.id, \(\) => Scheduling\.saveProjectEvent\(orgId\(\), project, next, schedulingConfig\)\);\s*mergeSavedCalendarEvent\(saved, next, saveVersion\)/);
  const rangeSaveStart = schedulingSource.indexOf('async function saveEventCalendarRange(event, range){');
  const rangeSaveEnd = schedulingSource.indexOf('  function salesResources', rangeSaveStart);
  const rangeSaveSource = rangeSaveStart >= 0 && rangeSaveEnd > rangeSaveStart ? schedulingSource.slice(rangeSaveStart, rangeSaveEnd) : '';
  assert.doesNotMatch(rangeSaveSource, /loadData\(/);
  assert.doesNotMatch(rangeSaveSource, /render\(/);
  // The refresh is surface-aware: routing view re-renders its panes, the
  // calendar views re-render the calendar. A failed save rolls back locally.
  assert.match(rangeSaveSource, /events = visibleEvents\(\);\s*refreshActiveScheduleSurface\(\);/);
  assert.match(rangeSaveSource, /allEvents = allEvents\.map\(\(item\) => previousById\.get\(String\(item\.id \|\| ''\)\) \|\| item\);/);
  assert.match(schedulingSource, /function refreshActiveScheduleSurface\(\)\{\s*if \(viewMode === 'appointment_schedule'\) renderScheduleLibraryViewPreserveScroll\(\);\s*else renderEventCalendarView\(\);/);
  assert.match(projectScheduleSource, /const scheduleEventSaveVersions = new Map\(\);/);
  assert.match(projectScheduleSource, /const scheduleEventSaveQueues = new Map\(\);/);
  assert.match(projectScheduleSource, /function beginScheduleEventSave\(eventId = ''\)/);
  assert.match(projectScheduleSource, /function queueScheduleEventSave\(eventId = '', save\)/);
  assert.match(projectScheduleSource, /broadcast = true, preserveLocalEvents = false, mutationVersion = 0/);
  assert.match(projectScheduleSource, /if \(broadcast && isCurrentMutation\)/);
  assert.match(projectScheduleSource, /async function saveMaterialScheduleRange\(event, range\)[\s\S]*?broadcast: false,[\s\S]*?preserveLocalEvents: true,[\s\S]*?mutationVersion/);
});

test('appointment editor has stable bounded dimensions and disclosure controls', () => {
  assert.match(schedulingSource, /\.dash-event-popover\{[^}]*width:420px;height:620px;[^}]*max-height:calc\(100vh - 16px\)[^}]*display:flex;flex-direction:column;/);
  assert.match(schedulingSource, /\.dash-event-pop-actions\{[^}]*justify-content:flex-end;[^}]*margin-top:auto;/);
  assert.match(schedulingSource, /const height = Math\.min\(620,[\s\S]*?pop\.style\.height = `\$\{height\}px`;/);
  assert.match(schedulingSource, /const schedulingViewport = rootEl\?\.querySelector\('\.dash-left'\)/);
  assert.match(schedulingSource, /left:Math\.max\(0, Number\(rawContentRect\.left \|\| 0\)\)/);
  assert.match(schedulingSource, /right:Math\.min\(window\.innerWidth, Number\(rawContentRect\.right \|\| window\.innerWidth\)\)/);
  assert.match(schedulingSource, /const top = Math\.max\(minTop, Math\.min\(maxTop, centeredTop\)\);/);
  assert.match(schedulingSource, /data-event-customer-details-toggle aria-expanded=/);
  assert.match(schedulingSource, /eventCustomerDetailsOpen = !eventCustomerDetailsOpen;/);
});

test('appointment editor deletes through the styled confirmation system without refreshing', () => {
  assert.match(schedulingSource, /const confirmDelete = window\.PlatformUI\?\.confirm;/);
  assert.match(schedulingSource, /title: 'Delete event',[\s\S]*?okLabel: 'Delete',[\s\S]*?danger: true/);
  assert.match(schedulingSource, /data-event-delete/);
  assert.match(schedulingSource, /window\.PlatformScheduling\.removeProjectEvent\(orgId\(\), ctx\.project, eventId, schedulingConfig\)/);
  assert.match(schedulingSource, /window\.PlatformAPI\.calendarEvents\.remove\(orgId\(\), eventId\)/);
  const deleteSource = schedulingSource.slice(schedulingSource.indexOf('async function deleteEventEditor'), schedulingSource.indexOf('function renderEventDraftPopover'));
  assert.doesNotMatch(deleteSource, /loadData|window\.confirm|confirm\(/);
  assert.match(platformApiSource, /app\.delete\("\/organizations\/:orgId\/projects\/:projectId\/events\/:eventId"/);
  assert.match(platformApiSource, /await clearMaterialListScheduleEvent\(orgId, deletedEvent\);/);
});

test('unsaved untyped events can be reopened and discarded without creating another event', () => {
  assert.match(schedulingSource, /const disposableFloatingDraft = ctx\.kind === 'floating'[\s\S]*?draft\.__draft === true[\s\S]*?draft\.status/);
  assert.match(schedulingSource, /if \(!disposableFloatingDraft\) \{[\s\S]*?calendarEvents\?\.remove/);
  assert.match(schedulingSource, /onDraftSelect\(draft, meta = \{\}\)[\s\S]*?eventDraftPopoverId = String\(draft\.id\)[\s\S]*?renderEventDraftPopover/);
  assert.match(scheduleViewSource, /event\.stopPropagation\(\);[\s\S]*?options\.onDraftSelect\?\.\(item, \{ element: chip \}\)/);
});

test('switching an untouched event type replaces its previous default title', () => {
  assert.match(schedulingSource, /const currentTypeDefault = eventTypeMeta\(eventTypeId\(event\)\)\.title;/);
  assert.match(schedulingSource, /if \(!title \|\| title === currentTypeDefault \|\| defaultEventTitles\(\)\.has\(title\)\) return true;/);
  // A title produced by the event type's title_template also counts as an
  // auto title, so it keeps tracking the project name.
  assert.match(schedulingSource, /return !!templated && title === templated;/);
  assert.match(schedulingSource, /'Material Delivery'/);
  assert.match(schedulingSource, /title: shouldAutoTitle\(current\) \? meta\.title : current\.title/);
  assert.match(schedulingSource, /if \(event\.title_is_custom === true\) return false;/);
});

test('appointment editor separates event, project, address, and all-day time', () => {
  assert.match(schedulingSource, /const projectNameHtml = norm\(projectLabel\) === norm\(projectAddressLabel\)[\s\S]*?<div class="dash-event-pop-project-name">\$\{escapeHtml\(projectLabel\)\}<\/div>/);
  assert.match(schedulingSource, /const clearableProjectNameHtml = projectNameHtml \|\| \(canClearProject[\s\S]*?const projectNameRowHtml = clearableProjectNameHtml \|\| canClearProject[\s\S]*?class="dash-event-pop-meta">\s*\$\{projectNameRowHtml\}\s*<div class="dash-event-pop-address">\$\{escapeHtml\(projectAddressLabel\)\}<\/div>\s*<div class="dash-event-pop-time">\$\{escapeHtml\(formatEventDraftTime\(draft\)\)\}<\/div>/);
  assert.match(schedulingSource, /\.dash-event-pop-meta\{display:grid;gap:7px;margin-top:13px;/);
  assert.match(schedulingSource, /function formatEventDraftTime\(event\)\{\s*if \(event\?\.all_day === true \|\| clean\(event\?\.schedule_granularity\)\.toLowerCase\(\) === 'date'\) return 'All day';/);
  assert.doesNotMatch(schedulingSource, /formatEventDraftTime\(draft\)\)\}\$\{assigned/);
});

test('appointment editor keeps all-day and recurrence switches with the non-overlapping time row', () => {
  assert.match(schedulingSource, /class="dash-event-time-fields"[\s\S]*?data-event-start[\s\S]*?data-event-end[\s\S]*?class="dash-event-time-options"[\s\S]*?data-event-allday[\s\S]*?data-event-recurring[\s\S]*?data-event-recurrence-fields/);
  assert.match(schedulingSource, /\.dash-event-time-fields\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*min-width:0/);
  assert.match(schedulingSource, /\.dash-event-time-field\{[^}]*min-width:0/);
  assert.match(schedulingSource, /\.dash-event-time-field input\{[^}]*min-width:0;max-width:100%/);
  assert.doesNotMatch(schedulingSource, /Make this a recurring item|Make all day/);
});

test('project labels honor the branch title mode instead of stale event snapshots', () => {
  assert.match(schedulingSource, /let branchProjectConfig = \{ title_mode:'customer_name' \};/);
  assert.match(schedulingSource, /window\.Portal\.branchModules\.get\('project_configuration'\)/);
  assert.match(schedulingSource, /const customerName = clean\(contact\.name \|\| event\.customer_name\);[\s\S]*?if \(mode === 'address'\) return address \|\| customerName \|\| savedTitle \|\| 'Project';[\s\S]*?return customerName \|\| address \|\| savedTitle \|\| 'Project';/);
  assert.match(schedulingSource, /name:clean\(contact\.name[\s\S]*?project\.customer_name[\s\S]*?project\.resident_name[\s\S]*?customer\.name[\s\S]*?resident\.name/);
  assert.match(schedulingSource, /function decorateWorkEvent\(event = \{\}\)\{[\s\S]*?project_title: projectTitle\(eventProject\(event\), event\)/);
  assert.match(schedulingSource, /function decorateSalesEvent\(event = \{\}\)\{[\s\S]*?project_title: projectTitle\(eventProject\(event\), event\)/);
  assert.doesNotMatch(schedulingSource, /project_title: event\.project_title \|\| projectTitle\(eventProject\(event\), event\)/);
});

test('project assignment search is empty until queried and renders as a dropdown', () => {
  assert.match(schedulingSource, /function projectSearchResults\(query = ''\)\{\s*const q = clean\(query\)\.toLowerCase\(\);\s*if \(!q\) return \[\];/);
  assert.match(schedulingSource, /class="dash-event-project-picker"[\s\S]*?data-event-project-results[\s\S]*?clean\(eventDraftProjectQuery\) \? '' : 'hidden'/);
  assert.match(schedulingSource, /\.dash-event-project-list\{position:absolute;/);
});

test('material deliveries do not expose workforce assignment', () => {
  assert.match(schedulingSource, /function assignmentResourcesForEvent\(event\)\{\s*if \(isMaterialEvent\(event\)\) return \[\];/);
  assert.match(schedulingSource, /if \(meta\.action === 'assignee' && meta\.element && !isMaterialEvent\(event\)\)/);
  assert.match(schedulingSource, /function decorateMaterialEvent\(event = \{\}\)[\s\S]*?assignee_label: '',[\s\S]*?work_resource_ref: null/);
  assert.match(scheduleViewSource, /const assigneeHtml = !preview && !materialDelivery && showAssignee/);
});

test('project work crew controls assign in place and stay synchronized', () => {
  assert.match(projectScheduleSource, /function productionCrewSelectHtml\(event = \{\}\)/);
  assert.match(projectScheduleSource, /data-production-resource-crew=/);
  assert.match(projectScheduleSource, /r-production-resource-crew-button[\s\S]*?aria-haspopup="listbox" aria-expanded="false"/);
  assert.match(projectScheduleSource, /target\.querySelectorAll\('\[data-production-resource-crew\]'\)[\s\S]*?openWorkAssignmentMenu\(item, button\)/);
  assert.match(projectScheduleSource, /function openWorkAssignmentMenu\(event = \{\}, anchor = null\)/);
  assert.match(projectScheduleSource, /function schedulePopoverHost\(anchor = null\)[\s\S]*?anchor\?\.closest\?\.\('\[data-fm-modal-id\], #rOverlay, \.r-overlay'\)/);
  assert.match(projectScheduleSource, /schedulePopoverHost\(anchor\)\.appendChild\(menu\)/);
  assert.match(projectScheduleSource, /schedulePopoverHost\(anchor\)\.appendChild\(popover\)/);
  assert.match(projectScheduleSource, /meta\.action === 'assignee'[\s\S]*?openWorkAssignmentMenu\(event, meta\.element\);[\s\S]*?return;/);
  assert.match(projectScheduleSource, /async function saveWorkCrewAssignment\(event = \{\}, crewId = ''\)[\s\S]*?upsertLocalProjectEvent\(next\)[\s\S]*?saveProjectEventQuiet\(next/);
  assert.match(projectScheduleSource, /const draft = workScheduleDrafts\.get\(String\(event\.id \|\| ''\)\) \|\| null;[\s\S]*?const selectedId = workCrewId\(assignmentSource\);/);
  assert.doesNotMatch(projectScheduleSource, /Waiting for \$\{workResourceLabel\(\)\}/);
  assert.match(scheduleViewSource, /const crewLabel = waitingForCrew \? \(crewLabelRaw \|\| 'Unassigned'\) : crewLabelRaw;/);
});

test('unscheduled generated work is never rendered on today by fallback', () => {
  assert.match(projectScheduleSource, /function allProjectWorkEvents\(\)\{[\s\S]*?\.filter\(materialEventIsScheduled\)/);
  assert.match(scheduleViewSource, /function eventsForDate\(Scheduling, projects, dateValue, userId = null, sourceEvents = null\)\{[\s\S]*?Scheduling\.eventIsScheduled\(event\)[\s\S]*?if \(!scheduled\) return false;/);
});

test('resource scheduling packs only visually overlapping items into extra lanes', () => {
  assert.match(scheduleViewSource, /function packResourceLanes\(entries = \[\], resourceIdForEntry = \(\) => ''\)/);
  assert.match(scheduleViewSource, /let lane = laneEnds\.findIndex\(\(end\) => end <= range\.start\);[\s\S]*?laneEnds\[lane\] = range\.end;/);
  assert.match(scheduleViewSource, /function resourceDayLaneRange\(range = \{\}\)[\s\S]*?end:endDay > start \? endDay : addDays\(start, 1\)/);
  assert.match(scheduleViewSource, /const renderedResourceIdForItem = \(item\) => clean\(findResource\(itemResourceId\(item\)\)\?\.id\);/);
  assert.match(scheduleViewSource, /packResourceLanes\(laneEntries, renderedResourceIdForItem\)/);
  assert.match(scheduleViewSource, /grid\.style\.gridTemplateRows = `38px \$\{rows\.map/);
  assert.match(scheduleViewSource, /wrapper\.style\.setProperty\('--prs-bar-top'/);
  assert.match(scheduleViewSource, /bindResourceChip\(node\.querySelector\('\.prs-work-chip'\)\);\s*reflowResourceLanes\(\);/);
});

test('global all-day appointments reuse the highest available row', () => {
  assert.match(scheduleViewSource, /const allDayLanes = \[\];[\s\S]*?let laneIndex = allDayLanes\.findIndex\(\(laneEndCol\) => laneEndCol <= startCol\);/);
  assert.match(scheduleViewSource, /allDayLanes\[laneIndex\] = endCol;[\s\S]*?margin-top:\$\{allDayTop \+ laneIndex \* allDayStep\}px[\s\S]*?const allDayRows = Math\.max\(1, allDayLanes\.length\);/);
  assert.doesNotMatch(scheduleViewSource, /\.map\(\(\{ item, range \}, stackIndex\) => \{/);
});

test('all-day work keeps its compact layout after drag or resize', () => {
  assert.match(scheduleViewSource, /\.prs-all-day-bar-top \.prs-work-chip\{height:42px;min-height:42px;/);
  assert.match(scheduleViewSource, /\.prs-all-day-grid\.week-overflow \.prs-all-day-bar-top \.prs-work-chip\{height:24px;min-height:24px;/);
  assert.match(scheduleViewSource, /const upsertDraft = \(draft\) => \{[\s\S]*?mode: allDay \? 'month' : mode,/);
  assert.match(scheduleViewSource, /const upsertCalendarItem = \(item, optionsForItem = \{\}\) => \{[\s\S]*?mode: allDay \? 'month' : mode,/);
});

test('week view caps and expands only its all-day event band', () => {
  assert.match(scheduleViewSource, /const WEEK_ALL_DAY_VISIBLE_ITEM_COUNT = 3;/);
  assert.match(scheduleViewSource, /const expandedMonthDates = new Set\([\s\S]*?const renderMonth = \(\) => \{/);
  assert.match(scheduleViewSource, /const compactWeekAllDay = mode === 'week';/);
  assert.match(scheduleViewSource, /class="prs-all-day-grid \$\{compactWeekAllDay \? 'week-overflow' : ''\}/);
  assert.match(scheduleViewSource, /const hiddenAllDayByDay = compactWeekAllDay \? days\.map/);
  assert.match(scheduleViewSource, /entry\.startCol <= gridColumn && entry\.endCol > gridColumn/);
  assert.match(scheduleViewSource, /data-prs-week-all-day-overflow/);
  assert.match(scheduleViewSource, /style="grid-column:\$\{dayOverflow\.gridColumn\}"/);
  assert.match(scheduleViewSource, /prs-week-all-day-overflow-more">\+ \$\{dayOverflow\.count\} more/);
  assert.doesNotMatch(scheduleViewSource, /week-overflow\.has-overflow:after/);
  assert.match(scheduleViewSource, /\.prs-week-all-day-overflow\{[^}]*height:14px;[^}]*margin:0 1px;[^}]*border-radius:0;[^}]*background:#fff;[^}]*font-size:8px/);
  assert.match(scheduleViewSource, /\.prs-week-all-day-overflow:before\{[^}]*left:0;right:0;top:-10px;[^}]*linear-gradient/);
  assert.match(scheduleViewSource, /btn\.addEventListener\('pointerenter', previewOverflow\)/);
  assert.match(scheduleViewSource, /const expanded = !band\.classList\.contains\('expanded'\) \|\| !btn\.classList\.contains\('is-controller'\)/);
  assert.match(scheduleViewSource, /transition:height 300ms cubic-bezier/);
  assert.doesNotMatch(scheduleViewSource, /\.prs-slot[^\n]*week-overflow/);
});

test('month view uses compact dates and three animated item lanes', () => {
  assert.match(scheduleViewSource, /\.prs-month-bar \.prs-work-chip\{height:24px;min-height:24px;/);
  assert.match(scheduleViewSource, /const MONTH_ITEM_TOP_PX = 23;/);
  assert.match(scheduleViewSource, /const MONTH_VISIBLE_ITEM_COUNT = 3;/);
  assert.match(scheduleViewSource, /\.prs-day\.today \.prs-day-num\{[^}]*min-width:18px;height:18px;/);
  assert.match(scheduleViewSource, /class="prs-month-item-viewport"/);
  assert.match(scheduleViewSource, /\.prs-month-item-viewport\{[^}]*height:calc\(100% - 22px\)/);
  assert.match(scheduleViewSource, /data-prs-month-overflow[^>]*data-prs-month-scroll=/);
  assert.match(scheduleViewSource, /overflow\.count === 1 \? 'item' : 'items'/);
  assert.match(scheduleViewSource, /btn\.addEventListener\('pointerenter'/);
  assert.match(scheduleViewSource, /week\.classList\.add\('expanded'\)/);
  assert.match(scheduleViewSource, /transition:transform var\(--prs-month-day-scroll-duration,220ms\) cubic-bezier/);
  assert.match(scheduleViewSource, /min-height \.3s cubic-bezier/);
});

test('month overflow controls scroll and expand only their own day without creating items', () => {
  assert.match(scheduleViewSource, /\.prs-month-overflow\{[^}]*justify-self:stretch;[^}]*width:calc\(100% - 8px\)/);
  assert.match(scheduleViewSource, /const dayItems = weekDays\.map\(\(\) => \[\]\);/);
  assert.match(scheduleViewSource, /class="prs-month-day-peek[^>]*data-prs-month-day-peek=/);
  assert.match(scheduleViewSource, /peek\.style\.setProperty\('--prs-month-day-scroll-y', `\$\{-scroll\}px`\);/);
  assert.doesNotMatch(scheduleViewSource, /week\.style\.setProperty\('--prs-month-scroll-y'/);
  assert.match(scheduleViewSource, /btn\.addEventListener\('pointerdown', \(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?btn\.setPointerCapture\?\.\(event\.pointerId\);[\s\S]*?\}\);/);
  assert.match(scheduleViewSource, /event\.target\.closest\('\.prs-work-chip,\[data-prs-month-overflow\]'\)/);
  assert.match(scheduleViewSource, /event\.target\.closest\('\.prs-work-chip,\.prs-toolbar,\.prs-view-switch,\[data-prs-month-overflow\]'\)/);
  assert.match(scheduleViewSource, /\.prs-work-chip:not\(\.prs-month-day-peek-chip\)/);
});

test('month hover overflow preserves lanes, continuation edges, and readable scroll timing', () => {
  assert.match(scheduleViewSource, /dayItems\[dayIndex\]\[laneIndex\] = \{/);
  assert.match(scheduleViewSource, /Array\.from\(\{ length:items\.length \}, \(_, laneIndex\) => items\[laneIndex\]\)/);
  assert.match(scheduleViewSource, /prs-month-day-peek-item is-gap/);
  assert.match(scheduleViewSource, /continues-from-previous-day[\s\S]*?continues-into-next-day/);
  assert.match(scheduleViewSource, /scrollSteps <= 4 \? 180 : Math\.min\(1800, 280 \+ \(scrollSteps - 4\) \* 180\)/);
  assert.match(scheduleViewSource, /peek\.style\.setProperty\('--prs-month-day-scroll-y', '0px'\);[\s\S]*?requestAnimationFrame\(\(\) => requestAnimationFrame/);
});

test('expanded month rows reconnect multi-day bars across the full week', () => {
  assert.match(scheduleViewSource, /\.prs-month-week\.expanded \.prs-month-item-viewport,\.prs-month-week\.collapsing \.prs-month-item-viewport\{height:calc\(100% - 22px\)\}/);
  assert.match(scheduleViewSource, /\.prs-month-week\.expanded \.prs-month-day-peek,\.prs-month-week\.collapsing \.prs-month-day-peek\{opacity:0;pointer-events:none\}/);
  assert.match(scheduleViewSource, /const expandedHeight = Math\.max\(124, trackHeight \+ 22\);/);
  assert.match(scheduleViewSource, /overflowByDay\.forEach\(\(overflow\) => \{ overflow\.expandedHeight = expandedHeight; \}\);/);
  const expansionSource = scheduleViewSource.slice(scheduleViewSource.indexOf("btn.addEventListener('click', (event) => {", scheduleViewSource.indexOf("container.querySelectorAll('[data-prs-month-overflow]')")), scheduleViewSource.indexOf('let drag = null;'));
  assert.doesNotMatch(expansionSource, /peek\?\.classList\.add\('active','is-controller'\)/);
});

test('month expansion is anchored and folds downward like a tray', () => {
  assert.match(scheduleViewSource, /transition:height \.3s cubic-bezier\(\.25,\.1,\.25,1\)/);
  assert.match(scheduleViewSource, /\.prs-month\{[^}]*overflow-anchor:none/);
  assert.match(scheduleViewSource, /\.prs-surface\{[^}]*overflow-anchor:none/);
  assert.match(scheduleViewSource, /\.prs-month-item-viewport\{[^}]*transition:height \.3s cubic-bezier\(\.25,\.1,\.25,1\)/);
  assert.match(scheduleViewSource, /const lockMonthWeekTrayRows = \(activeWeek = null\) => \{/);
  assert.match(scheduleViewSource, /const holdMonthWeekTrayAnchor = \(week, duration = 340\) => \{/);
  assert.match(scheduleViewSource, /surface\.scrollTop \+= delta/);
  assert.match(scheduleViewSource, /row\.__prsMonthTrayAnchorSurface\.scrollTop = row\.__prsMonthTrayAnchorScrollTop/);
  assert.match(scheduleViewSource, /week\.__prsMonthTrayHoverAnchor = \{[\s\S]*?top:week\.getBoundingClientRect\(\)\.top,[\s\S]*?scrollTop:surface\?\.scrollTop \|\| 0/);
  assert.match(scheduleViewSource, /const hoverAnchor = week\.__prsMonthTrayHoverAnchor;[\s\S]*?surface\.scrollTop = anchorScrollTop/);
  assert.match(scheduleViewSource, /row\.dataset\.prsMonthTrayBaseHeight = String\(Math\.max\(124, baseHeight\)\)/);
  assert.match(scheduleViewSource, /setMonthWeekTrayHeight\(row, measuredHeight\)/);
  assert.match(scheduleViewSource, /week\.classList\.add\('expanded'\)[\s\S]*?requestAnimationFrame\(\(\) => setMonthWeekTrayHeight\(week, expandedHeight\)\)/);
  assert.match(scheduleViewSource, /week\.classList\.add\('collapsing'\)[\s\S]*?requestAnimationFrame\(\(\) => setMonthWeekTrayHeight\(week, collapsedHeight\)\)/);
  assert.match(scheduleViewSource, /setTimeout\(\(\) => \{[\s\S]*?releaseMonthWeekTrayRows\(\);[\s\S]*?\}, 320\)/);
  assert.match(scheduleViewSource, /btn\.blur\(\);[\s\S]*?lockMonthWeekTrayRows\(week\);[\s\S]*?holdMonthWeekTrayAnchor\(week\);/);
});

test('month overflow copies preserve interactive assignment controls', () => {
  assert.match(scheduleViewSource, /chipClass:`prs-month-day-peek-chip[^`]*`[\s\S]*?showAssignee:true/);
  assert.match(scheduleViewSource, /\.prs-month-day-peek-item \[data-prs-assignee\]\{pointer-events:auto\}/);
  assert.match(scheduleViewSource, /querySelectorAll\('\.prs-month-day-peek-chip \[data-prs-assignee\]'\)/);
  assert.match(scheduleViewSource, /options\.onEventClick\?\.\(item, \{ element:assignee, action:'assignee' \}\)/);
});

test('assignment menus stay below scrolled month anchors without refreshing expanded rows', () => {
  assert.match(schedulingSource, /\.dash-assignee-popover\{[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain/);
  assert.match(schedulingSource, /menu\.style\.top = `\$\{Math\.max\(8, rect\.bottom \+ 8\)\}px`/);
  assert.match(schedulingSource, /menu\.style\.maxHeight = `\$\{Math\.max\(72, window\.innerHeight - rect\.bottom - 16\)\}px`/);
  assert.match(schedulingSource, /function patchRenderedAssignment\(event\)/);
  const saveAssignmentBlock = schedulingSource.match(/async function saveAssignment\(event, resourceId = ''\)\{([\s\S]*?)\n  function closeAssignmentMenu/);
  assert.ok(saveAssignmentBlock, 'saveAssignment implementation should exist');
  assert.doesNotMatch(saveAssignmentBlock[1], /\brender\(\)/);
  assert.doesNotMatch(saveAssignmentBlock[1], /loadData\(/);
  assert.match(saveAssignmentBlock[1], /patchRenderedAssignment\(next\)/);
  assert.match(saveAssignmentBlock[1], /patchRenderedAssignment\(event\)/);
  assert.match(scheduleViewSource, /expandedMonthDates = new Set\(\(Array\.isArray\(options\.expandedMonthDates\)/);
  assert.match(scheduleViewSource, /options\.onMonthExpansionChange\?\.\(\[\.\.\.container\.querySelectorAll\('\[data-prs-month-overflow\]\.is-controller'\)\]/);
  assert.match(schedulingSource, /expandedMonthDates,\s*\n\s*onMonthExpansionChange\(nextDates\)\{ expandedMonthDates = Array\.isArray\(nextDates\) \? nextDates : \[\]; \}/);
});

test('month view renders only the week rows required by the selected month', () => {
  const context = { window:{}, console, Date, Math, Set, Map };
  vm.runInNewContext(scheduleViewSource, context);
  const rowCount = context.window.PlatformScheduleView.monthWeekRowCount;
  assert.equal(rowCount(new Date('2026-07-15T12:00:00')), 5, 'July should end on the fifth visible row');
  assert.equal(rowCount(new Date('2026-08-15T12:00:00')), 6, 'a month spanning six calendar weeks keeps its sixth row');
  assert.equal(rowCount(new Date('2026-02-15T12:00:00')), 4, 'a four-week February does not render a fifth row');
  assert.match(scheduleViewSource, /const weekCount = monthWeekRowCount\(month\);/);
  assert.match(scheduleViewSource, /length: weekCount \* 7/);
});

test('crew row drops save assignments immediately', () => {
  assert.match(projectScheduleSource, /return resource\.subject_type === 'organization_user' \|\| !normalizedScopeId \|\| !ids\.length \|\| ids\.includes\(normalizedScopeId\);/);
  assert.match(projectScheduleSource, /async function commitWorkScheduleRange\(event = \{\}, range = \{\}\)/);
  assert.match(projectScheduleSource, /Scheduling\.updateProjectEventRange\(source, \{ \.\.\.range, \.\.\.assignment \}\)/);
  assert.match(projectScheduleSource, /upsertLocalProjectEvent\(next\);[\s\S]*?saveProjectEventQuiet\(next/);
  assert.match(projectScheduleSource, /onEventRangeChange\(event, range\)\{\s*commitWorkScheduleRange\(event, range\);\s*\}/);
  assert.doesNotMatch(projectScheduleSource, /That \$\{workResourceLabel\(\)\} does not declare capability for this scope/);
});

test('delivery entries use compact titles and no redundant colored bar', () => {
  assert.match(schedulingSource, /function materialDeliveryTitle\(event = \{\}\)/);
  assert.match(schedulingSource, /<span class="dash-appt-kind"> — delivery<\/span>/);
  assert.match(scheduleViewSource, /materialDelivery \? materialDeliveryTitle\(item\)/);
  assert.doesNotMatch(scheduleViewSource, /prs-material-accent/);
  assert.doesNotMatch(scheduleViewSource, /prs-all-day-material-marker b/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.material-delivery\{[^}]*border-left-width:1px/);
  assert.match(scheduleViewSource, /const assigneeHtml = !preview && !materialDelivery && showAssignee/);
  assert.match(scheduleViewSource, /<span class="prs-chip-bottom"><span class="\$\{projectTitle \? 'prs-project-title' : 'prs-time'\}">\$\{esc\(bottomLabel\)\}<\/span>\$\{lockControl\}<\/span>/);
  assert.match(scheduleViewSource, /\.prs-event-lock\{position:static;[^}]*width:14px;height:14px;[^}]*box-shadow:none/);
  assert.doesNotMatch(scheduleViewSource, /\.prs-work-chip\.has-lock-control\{padding-right:40px\}/);
  assert.match(schedulingSource, /function assignmentResourcesForEvent\(event\)\{\s*if \(isMaterialEvent\(event\)\) return \[\];/);
  assert.match(schedulingSource, /if \(!event\?\.id \|\| isMaterialEvent\(event\)\) return;/);
  assert.match(schedulingSource, /const materialNotOrdered = isMaterialEvent\(draft\) && !materialEventIsOrdered\(draft\);/);
  assert.match(schedulingSource, /materialNotOrdered \? '<span class="dash-event-status-pill">Not ordered yet<\/span>' : ''/);
  assert.match(scheduleViewSource, /\.prs-work-chip\.material-delivery\.material-unordered\{border-style:dotted;border-width:2px\}/);
});

test('calendar chips render event title, with a caller-supplied secondary line taking precedence', () => {
  assert.match(scheduleViewSource, /const projectTitle = clean\(item\.project_title \|\| item\.project_name/);
  assert.match(scheduleViewSource, /const title = esc\(clean\(item\.title \|\| item\.event_title\)/);
  // secondary_label lets templated-title events (customer name as the title)
  // show the address underneath; without it the project title remains.
  assert.match(scheduleViewSource, /const bottomLabel = showSecondary \? \(clean\(item\.secondary_label\) \|\| projectTitle \|\|/);
  assert.doesNotMatch(scheduleViewSource, /const bottomLabel = showSecondary \? \(address \|\|/);
  assert.match(schedulingSource, /function decorateMaterialEvent\(event = \{\}\)[\s\S]*?project_title: projectTitle\(project, event\)/);
});

test('customer rescheduling is feature gated and uses the canonical live-slot workflow', () => {
  assert.match(capabilityDefsSource, /key: "scheduling\.customer_rescheduling"/);
  assert.match(capabilityDefsSource, /key: "scheduling\.automated_rescheduling"/);
  assert.match(capabilityDefsSource, /key: "scheduling\.resource_availability"/);
  assert.match(schedulingSource, /data-event-self-schedule/);
  assert.match(schedulingSource, /Customer can reschedule/);
  assert.match(companySettingsSource, /Customer scheduling & capacity/);
  assert.match(companySettingsSource, /data-scope-scheduling-enabled/);
  assert.match(customerPortalSource, /function openReschedule\(eventId\)/);
  assert.match(customerPortalSource, /publicAppointmentAvailability/);
  assert.match(customerPortalSource, /publicHoldAppointment/);
  assert.match(customerPortalSource, /publicCommitAppointment/);
  assert.match(customerPortalSource, /publicCancelAppointmentRequest/);
  assert.match(customerPortalSource, /data-reschedule-cancel/);
  assert.match(customerPortalSource, /const portalCanReschedule = portalScheduling\.enabled === true && portalScheduling\.reschedule === true/);
  assert.match(customerPortalSource, /const headerAction = reschedulePending && portalCanReschedule/);
  assert.match(customerPortalSource, /settings: active\.settings && typeof active\.settings === 'object' \? active\.settings : \(payload\.settings \|\| \{\}\)/);
  assert.match(customerPortalSource, /status\.label !== 'Scheduled'/);
  assert.match(customerPortalCss, /\.cp-reschedule-modal/);
  assert.match(customerPortalSource, /cp-reschedule-calendar/);
  assert.match(customerPortalSource, /data-reschedule-date/);
  assert.match(customerPortalSource, /data-reschedule-confirm/);
  assert.match(customerPortalSource, /function selectRescheduleSlot\(button\)/);
  assert.match(customerPortalSource, /async function confirmRescheduleSlot\(\)/);
  assert.match(customerPortalSource, /aria-pressed="\$\{isSelected \? 'true' : 'false'\}"/);
  const slotSelection = customerPortalSource.match(/function selectRescheduleSlot\(button\)\{([\s\S]*?)\n  \}\n  async function confirmRescheduleSlot/);
  assert.ok(slotSelection, 'time selection should be separate from confirmation');
  assert.doesNotMatch(slotSelection[1], /publicHoldAppointment|publicCommitAppointment/);
  assert.match(customerPortalSource, /async function confirmRescheduleSlot\(\)\{[\s\S]*?publicHoldAppointment[\s\S]*?publicCommitAppointment/);
  assert.match(customerPortalSource, />Reschedule<\/span>/);
  assert.match(customerPortalCss, /\.cp-reschedule-picker\{display:grid;grid-template-columns:/);
  assert.match(customerPortalCss, /\.cp-reschedule-foot>button/);
  assert.match(customerPortalCss, /\.cp-reschedule-slots button\.selected/);
  assert.match(companySettingsSource, /data-scope-scheduling-field="reschedule_approval"/);
  assert.match(companySettingsSource, /data-scope-scheduling-field="reschedule_review_todo"/);
  assert.match(schedulingSource, /data-event-reschedule-review="approved"/);
  assert.match(schedulingSource, /reviewReschedule/);
  assert.match(platformApiSource, /customer-portals\/:portalUuid\/appointments\/:eventId\/availability/);
  assert.match(platformApiSource, /customer-portals\/:portalUuid\/appointments\/:eventId\/holds\/:holdId\/commit/);
  assert.match(platformApiSource, /customer-portals\/:portalUuid\/appointments\/:eventId\/reschedule-request\/cancel/);
  assert.match(platformApiSource, /companyCustomerSchedulingEnabled && portalCustomerSchedulingEnabled/);
  assert.match(platformApiSource, /settings: publicPortalSettings\(settings\)/);
});

test('short mobile week events keep their title space unless they show a confirmation control', () => {
  assert.match(scheduleViewSource, /\.prs-work-chip\.timed\.has-confirm\.compact-confirm\{padding-right:38px;padding-bottom:12px\}/);
  assert.doesNotMatch(scheduleViewSource, /\.prs-work-chip\.timed\.compact-confirm\{padding-right:38px;padding-bottom:12px\}/);
  assert.match(scheduleViewSource, /\.prs-wrap\.mobile-layout \.prs-slot \.prs-work-chip\[data-prs-mode="week"\]\{left:1px;right:1px;border-left-width:2px;border-radius:6px;font-size:7px/);
  assert.match(scheduleViewSource, /\.prs-work-chip\[data-prs-mode="week"\]:not\(\.has-confirm\)\{padding:3px 2px\}/);
  assert.match(scheduleViewSource, /\.prs-work-chip\[data-prs-mode="week"\] \.prs-title-text\{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;/);
});

test('waiting production events render their project title instead of the address', () => {
  assert.match(schedulingSource, /function renderProductionScheduleGroups\(\)[\s\S]*?const eventTile = \(event\) => \{[\s\S]*?<div class="dash-appt-address">\$\{escapeHtml\(projectTitle\(project, event\)\)\}\$\{missingAddress/);
  assert.match(schedulingSource, /function renderProductionScheduleGroups\(\)[\s\S]*?const materialTile = \(event\) => \{[\s\S]*?<div class="dash-appt-address">\$\{escapeHtml\(projectTitle\(project, event\)\)\}\$\{missingAddress/);
});

test('scope schedule rules derive a roofing bundle from its primary start date', () => {
  const context = { window:{ PlatformAPI:{} }, console, Date, Math, Set, Map };
  vm.runInNewContext(platformSchedulingSource, context);
  const Scheduling = context.window.PlatformScheduling;
  const template = {
    id:'roof_replacement',
    definition:{
      id:'roof_replacement',
      resources:{ lists:[
        { id:'roofing_labor', schedule:{ event_type_default_id:'project_work', rule:{ bundle:{ key:'roof_replacement', role:'primary', item_key:'roofing_labor' }, default_duration:{ unit:'day', minimum:1, expression:{ operator:'ceil', value:{ operator:'divide', left:{ ref:'project.measurements.roofSquares' }, right:20 } } }, all_day:true } } },
        { id:'dry_in', schedule:{ event_type_default_id:'material_delivery_dry_in', rule:{ bundle:{ key:'roof_replacement', role:'dependent', item_key:'dry_in' }, relative_start:{ anchor:'start', offset:{ value:-1, unit:'business_day' } }, default_duration:{ value:1, unit:'day' }, all_day:true } } },
        { id:'shingle', schedule:{ event_type_default_id:'material_delivery_shingles', rule:{ bundle:{ key:'roof_replacement', role:'dependent', item_key:'shingle' }, relative_start:{ anchor:'start', offset:{ unit:'day', expression:{ operator:'floor', value:{ operator:'divide', left:{ operator:'subtract', left:{ ref:'anchor.duration.days' }, right:1 }, right:2 } }, adjust:{ calendar:'business_day', direction:'previous' } } }, default_duration:{ value:1, unit:'day' }, all_day:true } } }
      ] }
    }
  };
  const project = { id:'project_1', scope:{ measurements:{ roofSquares:61 }, pieces:[{ id:'piece_1', measurements:{ roofSquares:61 } }] } };
  const work = { id:'work', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'project_work', kind:'project_work', title:'Roofing Labor' };
  const dryIn = { id:'dry', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'material_delivery_dry_in', kind:'material_delivery', title:'Dry-In' };
  const shingle = { id:'shingle', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'material_delivery_shingles', kind:'material_delivery', title:'Shingle' };
  const drafts = Scheduling.interpretScheduleBundle(work, [work, dryIn, shingle], new Date('2026-07-20T00:00:00'), project, [template]);
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].end.getTime() - drafts[0].start.getTime(), 4 * 86400000);
  assert.equal(drafts[1].start.getDay(), 5, 'Monday work places dry-in on the preceding Friday');
  assert.equal(drafts[2].start.getTime() - drafts[0].start.getTime(), 86400000, 'four-day work places shingles on project day two');
  const weekendDrafts = Scheduling.interpretScheduleBundle(work, [work, dryIn, shingle], new Date('2026-07-17T00:00:00'), { ...project, scope:{ measurements:{ roofSquares:41 }, pieces:[{ id:'piece_1', measurements:{ roofSquares:41 } }] } }, [template]);
  assert.equal(weekendDrafts[2].start.getDay(), 5, 'a calculated Saturday shingle date moves back to Friday');
});

test('scope-defined relationship moves preserve the dragged primary range and recalculate dependents', () => {
  const context = { window:{ PlatformAPI:{} }, console, Date, Math, Set, Map };
  vm.runInNewContext(platformSchedulingSource, context);
  const Scheduling = context.window.PlatformScheduling;
  const template = {
    id:'roof_replacement',
    definition:{ resources:{ lists:[
      { id:'roofing_labor', schedule:{ event_type_default_id:'project_work', rule:{ bundle:{ key:'roof_replacement', role:'primary', item_key:'roofing_labor' }, reschedule:{ cascade:'prompt', include_roles:['dependent'] }, default_duration:{ value:1, unit:'day' }, all_day:true } } },
      { id:'dry_in', schedule:{ event_type_default_id:'material_delivery_dry_in', rule:{ bundle:{ key:'roof_replacement', role:'dependent', item_key:'dry_in' }, relative_start:{ anchor:'start', offset:{ value:-1, unit:'business_day' } }, default_duration:{ value:1, unit:'day' }, all_day:true } } },
      { id:'shingle', schedule:{ event_type_default_id:'material_delivery_shingles', rule:{ bundle:{ key:'roof_replacement', role:'dependent', item_key:'shingle' }, relative_start:{ anchor:'start', offset:{ unit:'day', expression:{ operator:'floor', value:{ operator:'divide', left:{ operator:'subtract', left:{ ref:'anchor.duration.days' }, right:1 }, right:2 } } } }, default_duration:{ value:1, unit:'day' }, all_day:true } } }
    ] } }
  };
  const project = { id:'project_1' };
  const work = { id:'work', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'project_work', kind:'project_work', schedule_rule:{ version:1, bundle:{ key:'roof_replacement', role:'primary', item_key:'roofing_labor' }, default_duration:{ value:1, unit:'day' }, all_day:true } };
  const dry = { id:'dry', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'material_delivery_dry_in', kind:'material_delivery' };
  const shingle = { id:'shingle', project_id:'project_1', scope_piece_id:'piece_1', scope_template_id:'roof_replacement', event_type_default_id:'material_delivery_shingles', kind:'material_delivery' };
  const drafts = Scheduling.relatedScheduleRescheduleDrafts(work, [work, dry, shingle], {
    start:new Date('2026-07-20T00:00:00'),
    end:new Date('2026-07-24T00:00:00')
  }, project, [template]);
  assert.deepEqual(Array.from(drafts, (draft) => draft.id), ['dry', 'shingle']);
  assert.equal(Scheduling.scheduleBundleReschedulePolicy(work, project, [template]).cascade, 'prompt', 'current scope policy augments schedule rules copied onto older events');
  assert.equal(drafts[0].start.getDay(), 5, 'dry-in follows its previous-business-day relationship');
  assert.equal(drafts[1].start.getTime(), new Date('2026-07-21T00:00:00').getTime(), 'dependent formulas use the dragged four-day duration');
});

test('calendar drops immediately reflow and relationship prompts use the shared three-choice dialog', () => {
  assert.match(schedulingSource, /const relationshipChoice = relatedDrafts\.length \? await chooseRelationshipReschedule/);
  assert.match(schedulingSource, /if \(relationshipChoice === 'cancel'[\s\S]*?refreshActiveScheduleSurface\(\);[\s\S]*?return;/);
  assert.match(schedulingSource, /events = visibleEvents\(\);\s*refreshActiveScheduleSurface\(\);\s*try \{/);
  assert.match(schedulingSource, /\{ value:'cancel', label:'Cancel' \}[\s\S]*?\{ value:'no', label:'No' \}[\s\S]*?\{ value:'yes', label:'Yes', primary:true \}/);
  assert.match(platformUiSource, /function chooseUi\(message, choices = \[\], options = \{\}\)/);
  assert.match(portalCoreSource, /choose: \(\.\.\.args\) => window\.PlatformUI\?\.choose/);
  assert.match(scopePresetsSource, /reschedule: \{ cascade: "prompt", include_roles: \["dependent"\] \}/);
  assert.match(scopePresetsSource, /preset_revision: input\.id === "roof_replacement" \? 33 : 12/);
});

test('bundle preview lanes fill gaps and push down only conflicting calendar bars', () => {
  const context = { window:{}, console, Date, Math, Set, Map };
  vm.runInNewContext(scheduleViewSource, context);
  const pack = context.window.PlatformScheduleView.packPreviewLaneSegments;
  const packed = pack([
    { id:'primary', rowKey:'week', startCol:5, endCol:6 },
    { id:'previous-day', rowKey:'week', startCol:4, endCol:5 },
    { id:'same-day-delivery', rowKey:'week', startCol:5, endCol:6 }
  ], [
    { id:'existing-lane-one', rowKey:'week', startCol:3, endCol:7, originalLane:1 },
    { id:'existing-open-top', rowKey:'week', startCol:2, endCol:3, originalLane:1 }
  ]);
  assert.deepEqual(Array.from(packed.previews, (entry) => [entry.id, entry.lane]), [
    ['primary', 0],
    ['previous-day', 0],
    ['same-day-delivery', 1]
  ]);
  assert.equal(packed.existing.find((entry) => entry.id === 'existing-lane-one').lane, 2, 'the conflicting second-lane bar moves below both same-day previews');
  assert.equal(packed.existing.find((entry) => entry.id === 'existing-open-top').lane, 1, 'a non-conflicting second-lane bar keeps its continuity');
  const prioritize = context.window.PlatformScheduleView.prioritizePrimaryPlacementDraft;
  const primary = { id:'work', start:new Date('2026-07-16'), end:new Date('2026-07-17') };
  const delivery = { id:'delivery', start:new Date('2026-07-15'), end:new Date('2026-07-16') };
  assert.deepEqual(Array.from(prioritize(primary, [delivery]), (entry) => entry.id), ['work', 'delivery'], 'primary work is restored when derived previews omit it');
  assert.deepEqual(Array.from(prioritize(primary, [delivery, primary]), (entry) => entry.id), ['work', 'delivery'], 'primary work is always rendered first');
});

test('global scheduling renders grouped bundles with click placement and derived previews', () => {
  assert.match(schedulingSource, /function scheduleBundleGroups\(rows = \[\]\)/);
  assert.match(schedulingSource, /data-production-bundle-primary=/);
  assert.match(schedulingSource, /data-production-bundle-child=/);
  assert.match(schedulingSource, /placementMode: clickPlacement \? 'click' : 'drag'/);
  assert.match(schedulingSource, /derivePlacementDrafts\(primaryDraft\)/);
  assert.match(schedulingSource, /confirmProductionBundleDraft\(next\)/);
  assert.match(scheduleViewSource, /function renderClickPlacementPreview|const renderClickPlacementPreview/);
  assert.match(scheduleViewSource, /options\.onPlacementCancel\?\.\(\)/);
  assert.match(scheduleViewSource, /layoutClickPlacementPreviews/);
  assert.match(scheduleViewSource, /--prs-preview-color/);
  assert.match(scheduleViewSource, /content:"PREVIEW"/);
  assert.match(scheduleViewSource, /repeating-linear-gradient\(135deg/);
  assert.match(scheduleViewSource, /function prioritizePrimaryPlacementDraft/);
  assert.match(scheduleViewSource, /if \(primaryIndex < 0 && primary\?\.start && primary\?\.end\) drafts\.unshift\(primary\)/);
  assert.match(scheduleViewSource, /__previewPrimary:index === 0/);
});

test('click placement resolves the underlying calendar cell through existing events', () => {
  assert.match(scheduleViewSource, /const placementChromeTarget = \(target\) => target\?\.closest\?\.\('\.prs-toolbar/);
  assert.match(scheduleViewSource, /const renderClickPlacementPreview = \(event\) => \{[\s\S]*?if \(!clickPlacement \|\| drag \|\| placementChromeTarget\(event\.target\)\) return;[\s\S]*?const range = rangeFromPointer\(event\)/);
  assert.doesNotMatch(scheduleViewSource, /renderClickPlacementPreview = \(event\) => \{[\s\S]{0,220}?closest\?\.\('\.prs-work-chip/);
  assert.match(scheduleViewSource, /if \(clickPlacement\) \{[\s\S]*?container\.addEventListener\('click', \(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?\}, true\);/);
  assert.match(scheduleViewSource, /if \(allowEventDrag\) chip\.addEventListener\('pointerdown', \(event\) => \{\s*if \(clickPlacement\) return;/);
});

test('equipment scheduling is parent-app gated and advanced assignments can use a subset window', () => {
  assert.match(schedulingSource, /has\('apps', 'equipment'\) === true && has\('equipment', 'scheduling'\) === true/);
  assert.match(projectScheduleSource, /has\('apps', 'equipment'\) === true && has\('equipment', 'scheduling'\) === true/);
  assert.match(schedulingSource, /data-event-equipment-start/);
  assert.match(schedulingSource, /data-event-equipment-end/);
  assert.match(projectScheduleSource, /id="rScheduleEquipmentStart"/);
  assert.match(platformApiSource, /start_at: startAt/);
});

test('schedule chips flag unmet people, crew, and equipment requirements', () => {
  const context = { window:{ PlatformAPI:{} }, console, Date, Math, Set, Map };
  vm.runInNewContext(platformSchedulingSource, context);
  const Scheduling = context.window.PlatformScheduling;
  assert.equal(Scheduling.eventRequirementWarnings({ event_type_default_id:'sales_appointment' })[0].code, 'salesperson_unassigned');
  assert.equal(Scheduling.eventRequirementWarnings({ event_type_default_id:'project_work' })[0].code, 'crew_unassigned');
  const warnings = Scheduling.eventRequirementWarnings({
    event_type_default_id:'project_work',
    work_resource_ref:{ kind:'resource_group', id:'crew_1' },
    resource_requirements:[{ equipment_type_id:'dump_truck', label:'Dump truck', quantity:2 }],
    resource_refs:[{ kind:'equipment_unit', id:'truck_1' }]
  }, { equipmentUnits:[{ id:'truck_1', type_id:'dump_truck' }] });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].label, 'Dump truck: 1 of 2 assigned');
  assert.match(scheduleViewSource, /prs-requirement-warning/);
  assert.match(schedulingSource, /dash-event-requirement-alert/);
});

test('production routing exposes compact crew vehicle lanes and a draggable vehicle bank', () => {
  assert.match(schedulingSource, /data-routing-vehicles/);
  assert.match(schedulingSource, /data-vehicle-bank-unit/);
  assert.match(schedulingSource, /vehicleLanes\.map\(\(lane\) => lane\.id\)/);
  assert.match(schedulingSource, /kind:'equipment_booking'/);
  assert.match(schedulingSource, /persistFloatingEvent\(booking\)/);
});
