import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const app = await readFile(path.join(publicRoot, 'libraries/apps/equipment/app.js'), 'utf8');

test('unit adder creates and selects reusable types and facilities inline', () => {
  assert.match(app, /<option value="__new__">\+ Add new type…<\/option>/);
  assert.match(app, /openCatalogEditor\('type', 'drawer'\)/);
  assert.match(app, /data-eq-catalog-kind/);
  assert.match(app, /\['vehicle','fa-truck-pickup','Vehicle'\][\s\S]*\['trailer','fa-trailer','Trailer'\][\s\S]*\['tool','fa-screwdriver-wrench','Tool'\][\s\S]*\['other','fa-box','Other'\]/);
  assert.match(app, /<option value="__new__">\+ Add new facility…<\/option>/);
  assert.match(app, /openCatalogEditor\('yard', 'drawer'\)/);
  assert.match(app, /data-eq-catalog-address/);
  assert.match(app, /EquipmentAPI\.createYard/);
  assert.match(app, /function yardsManagerHtml\(\)/);
  assert.doesNotMatch(app, /async function createInline(?:Type|Yard)/);
});

test('new units assume available and defer optional identifiers', () => {
  assert.match(app, /mode:'create', unit:\{ status:'available', ownership:'owned' \}/);
  assert.match(app, /drawer\.mode !== 'create' \? field\('Status'/);
  assert.ok(app.indexOf("field('Asset # (optional)'") > app.indexOf('Purchase details'));
  assert.match(app, /field\('Name', 'name', unit\.name, \{ required:true \}\)/);
  assert.match(app, /showUnitFormError\(container, 'Complete the required field below\.'/);
  assert.match(app, /showUnitFieldError\(container, 'name', 'Unit name is required\.'/);
  assert.match(app, /error\.classList\.add\('show'\)/);
  assert.match(app, /data-eq-unit-form-error/);
  assert.match(app, /\.eq-empty \.eq-btn\.primary i\{font-size:inherit;color:#fff\}/);
});

test('vehicle classification exclusively controls vehicle fields', () => {
  assert.match(app, /const vehicleType = \['vehicle','trailer'\]\.includes\(clean\(selectedType\?\.kind\)\)/);
  assert.match(app, /vehicleType \? `<div class="eq-dynamic-panel"><div class="eq-section-label">Vehicle details<\/div>/);
  for (const label of ['License plate', 'Year', 'Make', 'Model', 'VIN']) assert.match(app, new RegExp(`field\\('${label}'`));
  assert.match(app, /field\('Serial number'[\s\S]*field\('Asset # \(optional\)'/);
});

test('unit photos use a draggable canvas crop and shared media upload', () => {
  assert.match(app, /data-eq-photo-pick/);
  assert.match(app, /data-eq-crop-canvas/);
  assert.match(app, /pointermove/);
  assert.match(app, /canvas\.toBlob/);
  assert.match(app, /PlatformAPI\.media\.upload/);
  assert.match(app, /role:'primary'/);
  assert.match(app, /Click to upload/);
  assert.match(app, /dblclick[\s\S]*recropUnitPhoto/);
  assert.match(app, /data-eq-photo-crop title="Crop photo"/);
  assert.match(app, /title="\$\{photoUrl \? 'Click to replace' : 'Click to upload'\}"/);
  assert.doesNotMatch(app, /Double-click to crop/);
  assert.match(app, /drawer\.mode === 'create' \? 'fa-truck'/);
  assert.match(app, /class="eq-card-media"[\s\S]*background-image:url/);
  assert.match(app, /\.eq-card\{[^}]*grid-template-columns:minmax\(118px,38%\)/);
  assert.match(app, /primaryPhoto\(unit\) \? mediaReferenceUrl\(primaryPhoto\(unit\), 'original'\) : ''/);
  assert.match(app, /style="border-left:4px solid \$\{esc\(unitColor\)\}"/);
  assert.match(app, /const photoUrl = photo \? mediaReferenceUrl\(photo, 'original'\) : ''/);
});

test('opened units share the editable form with quiet hover-revealed controls', () => {
  assert.match(app, /eq-form \$\{drawer\.mode === 'view' \? 'eq-inline-view-form' : ''\}/);
  assert.match(app, /\.eq-inline-view-form \.eq-field input:not\(\.eq-color-input\)[^}]*border-color:transparent;background:transparent/);
  assert.match(app, /\.eq-inline-view-form \.eq-field:hover input:not\(\.eq-color-input\)[^}]*border-color:#d0d5dd;background:#fff/);
  assert.match(app, /Save changes/);
  assert.doesNotMatch(app, /data-eq-drawer-edit/);
});

test('fleet cards expose an inline status selector without opening the unit', () => {
  assert.match(app, /data-eq-card-status="\$\{esc\(obj\(unit\)\.id\)\}"/);
  assert.match(app, /async function updateCardStatus/);
  assert.match(app, /EquipmentAPI\.saveUnit\(organizationId, clean\(unit\.id\)/);
  assert.match(app, /event\.target\.closest\('\[data-eq-card-status\]'\)/);
  assert.match(app, /\.eq-card-status-wrap\{position:absolute;top:8px;right:8px;width:70px;height:21px/);
  assert.match(app, /font:800 8\.5px\/1 inherit!important/);
});

test('facility editor resolves Google addresses and stores access instructions', () => {
  assert.match(app, /google\.maps\.places\.Autocomplete/);
  assert.match(app, /fields:\['formatted_address', 'geometry', 'address_components'\]/);
  assert.match(app, /Choose an address from the Google suggestions/);
  assert.match(app, /data-eq-catalog-access/);
  assert.match(app, /access_instructions:accessInstructions/);
  assert.match(app, /Facility access instructions/);
  assert.match(app, /class="eq-readonly-value" role="note"/);
  assert.match(app, /obj\(selectedYard\?\.address\)\.access_instructions/);
  assert.match(app, /Home facility/);
  assert.match(app, /> Facilities<\/button>/);
  assert.doesNotMatch(app, /Select an address from Google/);
});

test('catalog modals validate inline and managers expose safe archives', () => {
  assert.match(app, /showCatalogFieldError\(nameInput, 'Name is required\.'/);
  assert.match(app, /data-eq-types-archive-view/);
  assert.match(app, /data-eq-yards-archive-view/);
  assert.match(app, /data-eq-type-restore/);
  assert.match(app, /data-eq-yard-restore/);
  assert.match(app, /openArchiveConfirm\('type'/);
  assert.match(app, /openArchiveConfirm\('yard'/);
  assert.doesNotMatch(app, /confirm\(`Archive the/);
  assert.match(app, /eq-preserve-drawer/);
  assert.match(app, /data-eq-catalog-save-error/);
  assert.match(app, /\.eq-drawer-title\.single-line\{align-self:stretch;display:flex;align-items:center\}/);
  assert.match(app, /eq-drawer-title single-line[\s\S]*Archived equipment types/);
  assert.match(app, /eq-drawer-title single-line[\s\S]*Archived facilities/);
  assert.match(app, /server already accepted the save/);
  assert.match(app, /closeCatalogEditor\(\);[\s\S]*render\(\);/);
  for (const subtitle of [
    'Your fleet, in one place',
    'Reusable home facilities for units and fleet operations',
    'The reusable classifications available to every unit',
    'Types group interchangeable units and define whether vehicle fields apply.',
    'Add a facility once, then choose it as a unit’s home facility.',
    'Restore a type to make it selectable again',
    'Restore a facility to make it selectable again',
    'Archived equipment types will appear here.',
    'Archived facilities will appear here.',
    'Add the things your crews take to jobs'
  ]) assert.doesNotMatch(app, new RegExp(subtitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ownership drives its own optional date and cost fields', () => {
  assert.match(app, /ownership === 'owned'[\s\S]*Purchase details[\s\S]*Purchased on \(optional\)[\s\S]*Estimated value/);
  assert.match(app, /ownership === 'leased'[\s\S]*Lease term \(months\)[\s\S]*Monthly lease cost/);
  assert.match(app, /ownership === 'rented'[\s\S]*Rental details[\s\S]*Pickup date \(optional\)[\s\S]*Rental return date \(optional\)[\s\S]*Rental cost/);
  assert.doesNotMatch(app, /field\('Hourly \(\$\)'/);
  assert.match(app, /DRIVER_REQUIREMENTS[\s\S]*cdl_a[\s\S]*cdl_b[\s\S]*cdl_c/);
});

test('color is a single full-swatch control and conditional fields animate', () => {
  assert.match(app, /class="eq-color-input" type="color" data-eq-input="color"/);
  assert.doesNotMatch(app, /placeholder="Color name or hex"/);
  assert.match(app, /@keyframes eq-fields-in/);
  assert.doesNotMatch(app, /Choose a clear side or three-quarter view/);
});

test('rental pickup condition supports repeatable notes, pictures, and videos', () => {
  assert.match(app, /pickup_condition/);
  assert.match(app, /data-eq-pickup-note-add/);
  assert.match(app, /data-eq-pickup-note-remove/);
  assert.match(app, /data-eq-pickup-media-add/);
  assert.match(app, /picker\.accept = 'image\/\*,video\/\*'/);
  assert.match(app, /picker\.multiple = true/);
  assert.match(app, /slot:'rental_pickup_condition'/);
});
